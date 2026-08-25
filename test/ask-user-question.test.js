// Regression guard for AskUserQuestion — the CLI's OWN question tool.
//
// History: 9b9d8b9 correctly removed a fake answerable card (the answer had nowhere to
// go: `claude -p` runs with stdin closed) but then dropped the tool event entirely, so
// the user saw a silent gap in chat where a question should be. GitHub issue #20.
// The tool must stay VISIBLE — an "Ask" activity row — even though it is unanswerable.
//
// The first half EXECUTES the real handler out of server.js rather than pattern-matching
// its source. A source regex only ever catches a literal copy-paste of the old branch;
// executing it also catches a whitelist rewrite, a renamed comparison, or a deleted
// ws.send — every shape that would silently bring the bug back.
//
// Run: node test/ask-user-question.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ClaudeCLI = require('../claude-cli');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.error(`  FAIL ${label} — ${e.message}`); }
}

// ─── Extract runCliSingle's onTool handler as a callable ────────────────────
// server.js has six `.onTool(` sites; the CLI one is identified by the thinking
// diagnostic immediately above it. If the shape ever changes this throws loudly —
// a guard that cannot find its target must fail, not quietly pass.
function loadOnTool() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const anchor = src.indexOf('[THINKING-DIAG-CLI]');
  assert.notStrictEqual(anchor, -1, 'anchor [THINKING-DIAG-CLI] gone — update this test');
  const at = src.indexOf('.onTool(', anchor);
  assert.notStrictEqual(at, -1, 'no .onTool( after the anchor');
  const open = at + '.onTool'.length;
  const close = src.indexOf('\n      })', open);
  assert.notStrictEqual(close, -1, 'end of the onTool handler not found');
  const arrow = src.slice(open + 1, close + '\n      }'.length);
  assert.ok(/^\(\s*name\s*,\s*inp\s*\)\s*=>/.test(arrow), `unexpected handler signature: ${arrow.slice(0, 40)}`);
  // `runContinuation`, `bgLaunches` and `bgHarvests` are the handler's closure
  // references (the background-task counters). They are passed as parameters rather
  // than stubbed away so this test keeps exercising the real module.
  return new Function('ws', 'stmts', 'sessionId', 'tabId', 'runContinuation', 'bgLaunches', 'bgHarvests', `return (${arrow});`);
}

function run(toolName, input) {
  const sent = [], rows = [];
  const ws = { send: s => sent.push(JSON.parse(s)) };
  const stmts = { addMsg: { run: (...a) => rows.push(a) } };
  loadOnTool()(ws, stmts, 42, null, require('../run-continuation'), 0, 0)(toolName, input);
  return { sent, rows };
}

const QUESTION = JSON.stringify({
  questions: [{
    question: 'Which caching strategy should I use?',
    header: 'Cache',
    multiSelect: false,
    options: [{ label: 'Redis', description: 'survives restarts' }, { label: 'in-memory', description: 'zero deps' }],
  }],
});

console.log('runCliSingle onTool handler:');

check('AskUserQuestion reaches the client as a tool frame', () => {
  const { sent } = run('AskUserQuestion', QUESTION);
  const frame = sent.find(f => f.type === 'tool' && f.tool === 'AskUserQuestion');
  assert.ok(frame, `nothing sent — the question would be a silent gap. sent: ${JSON.stringify(sent)}`);
});

check('the question text survives the wire truncation', () => {
  const { sent } = run('AskUserQuestion', QUESTION);
  const frame = sent.find(f => f.tool === 'AskUserQuestion');
  assert.ok(frame.input.includes('Which caching strategy should I use?'), `input was: ${frame.input}`);
});

check('it is persisted exactly once', () => {
  const { rows } = run('AskUserQuestion', QUESTION);
  const stored = rows.filter(r => r[4] === 'AskUserQuestion');
  assert.strictEqual(stored.length, 1, `expected 1 DB row, got ${stored.length}`);
});

check('an unknown future tool is forwarded too (no whitelist)', () => {
  // A whitelist rewrite would drop AskUserQuestion again without ever naming it.
  const { sent } = run('SomeToolInventedNextYear', '{"x":1}');
  assert.ok(sent.some(f => f.type === 'tool'), 'handler silently swallowed an unlisted tool');
});

check('internal MCP tools are still suppressed', () => {
  for (const name of ['ask_user', 'notify_user', 'set_ui_state', 'check_user_messages']) {
    const { sent, rows } = run(name, '{}');
    assert.strictEqual(sent.length, 0, `${name} leaked to the client`);
    assert.strictEqual(rows.length, 1, `${name} was not persisted`);
  }
});

// ─── The CLI parser really does surface the tool ────────────────────────────
// Without this, the check above guards a path nothing ever walks. A stub binary stands
// in for `claude` so the test is free and deterministic across CLI versions.
console.log('claude-cli must surface AskUserQuestion to onTool:');
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-askq-'));
const binPath = path.join(binDir, 'claude');
fs.writeFileSync(binPath, `#!/usr/bin/env node
const out = [
  { type:'system', subtype:'init', session_id:'11111111-2222-3333-4444-555555555555' },
  { type:'assistant', message:{ content:[
      { type:'tool_use', id:'tu_1', name:'AskUserQuestion', input:${QUESTION} }
  ]}},
  { type:'result', subtype:'success', result:'done', duration_ms:10, num_turns:1 },
];
for (const o of out) process.stdout.write(JSON.stringify(o) + '\\n');
`);
fs.chmodSync(binPath, 0o755);

const seen = [];
let finished = false;
let guard = null;

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(guard);

  check('onTool fires with the AskUserQuestion name', () => {
    assert.ok(seen.some(t => t.name === 'AskUserQuestion'), `tools seen: ${JSON.stringify(seen)}`);
  });
  check('the payload is compact JSON that fits the 600-char cap', () => {
    const hit = seen.find(t => t.name === 'AskUserQuestion');
    assert.ok(hit, 'AskUserQuestion never arrived');
    assert.ok(hit.input.length <= 600, `payload is ${hit.input.length} chars — it would be cut mid-JSON`);
    assert.deepStrictEqual(JSON.parse(hit.input.substring(0, 600)).questions.length, 1);
  });

  try { fs.rmSync(binDir, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

guard = setTimeout(() => { console.error('  FAIL onTool probe timed out'); fail++; finish(); }, 15000);

new ClaudeCLI({ claudeBin: binPath, cwd: binDir })
  .send({ prompt: 'probe' })
  .onTool((name, input) => seen.push({ name, input: String(input) }))
  .onDone(finish)
  .onError(e => { console.error(`  FAIL onTool probe errored — ${e}`); fail++; finish(); });
