// An `interrupt` that lands on an idle session must not rewrite that session's config.
//
// The SPA sends `interrupt` while it still believes the tab is generating; the server may
// already have finished, so the "idle interrupt" window is hit in ordinary use, not only
// under load. The frame carries only text/tabId/attachments — no model, mode, skills, MCP
// or workdir. It used to be handed straight to processChat, whose destructure defaults then
// won (skills=[] mcpServers=[] mode='auto' model='sonnet' workdir=null → the global WORKDIR)
// and whose `updateConfig` wrote those defaults BACK onto the session row. One message sent
// in that window ran in the wrong directory without the chat's skills and PERMANENTLY
// destroyed the session's saved configuration.
//
// The check has to be end-to-end, because every individual piece looked correct: the fix is
// the handler rebuilding the turn from the session row. So this file runs the REAL interrupt
// handler (lifted from server.js, executed in a vm), feeds whatever it produces through the
// REAL processChat destructure, and then executes the REAL `updateConfig` SQL against a
// throwaway DB carrying the REAL sessions schema. The assertion is simply: the row that
// comes out equals the row that went in.
//
// Run: node test/interrupt-idle-config.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const openDatabase = require('../db-adapter');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function uniqueAnchor(anchor, what) {
  const a = SRC.indexOf(anchor);
  assert.ok(a !== -1, `${what}: anchor not found — ${anchor}`);
  assert.strictEqual(SRC.indexOf(anchor, a + 1), -1, `${what}: anchor is not unique — ${anchor}`);
  return a;
}
function block(anchor, what) {
  const start = uniqueAnchor(anchor, what);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`${what}: unbalanced block`);
}
function pick(re, what) {
  const m = SRC.match(re);
  assert.ok(m, `${what}: not found in server.js`);
  return m[0];
}

// ─── the real schema ────────────────────────────────────────────────────────
const SESSIONS_DDL = (() => {
  const start = uniqueAnchor('CREATE TABLE IF NOT EXISTS sessions (', 'sessions DDL');
  const end = SRC.indexOf('\n  );', start);
  assert.ok(end !== -1, 'sessions DDL never closes');
  return SRC.slice(start, end + 4);
})();
const ALTERS = [...SRC.matchAll(/db\.exec\(`(ALTER TABLE sessions ADD COLUMN [^`]+)`\)/g)].map(m => m[1]);
assert.ok(ALTERS.length > 5, `expected the sessions ALTER migrations, found ${ALTERS.length}`);

const dbPath = path.join(os.tmpdir(), `ccs-interrupt-test-${process.pid}-${Date.now()}.db`);
const db = openDatabase(dbPath);
db.exec(SESSIONS_DDL);
for (const sql of ALTERS) { try { db.exec(sql); } catch {} }
db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, type TEXT, content TEXT, tool_name TEXT, agent_id TEXT, created_at TEXT, attachments TEXT)`);

const liftSql = name => {
  const m = SRC.match(new RegExp(`\\b${name}: db\\.prepare\\(\`([^\`]+)\`\\)`));
  assert.ok(m, `stmts.${name} not found`);
  return m[1];
};
const stmts = {
  updateConfig: db.prepare(liftSql('updateConfig')),
  getSession:   db.prepare(liftSql('getSession')),
  addMsg:       db.prepare(`INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,created_at,attachments) VALUES (?,?,?,?,?,?,?,?)`),
  hasRunningTask: { get: () => null },
};
// sqlVal is what turns undefined into NULL on the way into SQLite — lifted, not re-implemented,
// because the exact undefined→null coercion is half of what made the wipe silent.
const SQLVAL_SRC = block('function sqlVal(v) {', 'sqlVal');

// A fully configured session — the kind a user actually loses.
const CONFIGURED = {
  id: 'S1', model: 'opus', mode: 'plan', agent_mode: 'multi',
  workdir: '/srv/some/project', active_skills: '["research","writing"]',
  active_mcp: '["context7","tavily"]', run_engine: 'subscription',
};
function seed(row = CONFIGURED) {
  db.prepare(`DELETE FROM sessions`).run();
  db.prepare(`INSERT INTO sessions (id,title,model,mode,agent_mode,workdir,active_skills,active_mcp,run_engine)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(row.id, 'a chat', row.model, row.mode, row.agent_mode, row.workdir, row.active_skills, row.active_mcp, row.run_engine);
}
const snapshot = id => {
  const r = stmts.getSession.get(id);
  return { model: r.model, mode: r.mode, agent_mode: r.agent_mode, workdir: r.workdir,
           active_skills: r.active_skills, active_mcp: r.active_mcp, run_engine: r.run_engine };
};

// ─── the real interrupt handler ─────────────────────────────────────────────
const INTERRUPT = block("if (msg.type === 'interrupt') {", 'interrupt handler');

function runInterrupt(msg, { busy = false } = {}) {
  const dispatched = [];
  const sent = [];
  const sandbox = {
    msg, stmts, JSON, Array, Number, Object, Date, String, console,
    ws: { _tabBusy: busy ? { S1: true } : {}, send: s => sent.push(JSON.parse(s)) },
    activeTasks: new Map(), activeChatSessions: new Set(),
    pendingInterrupts: new Map(), _interruptIdCounter: 0,
    serializeMessageAttachments: a => a,
    saveInterruptAttachments: () => [],
    log: { info() {}, warn() {}, error() {} },
    processChat: m => { dispatched.push(m); return Promise.resolve(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`(function(){ ${INTERRUPT} })();`, sandbox);
  return { dispatched, sent, pending: sandbox.pendingInterrupts.get('S1') };
}

// ─── the real destructure + the real write-back ─────────────────────────────
// This is the second half of the bug: whatever the handler dispatches gets destructured
// with defaults and written straight back onto the row.
const DESTRUCTURE = pick(/const \{ text:userMessage, attachments=\[\][\s\S]*?\} = msg;/, 'processChat destructure');
const WRITEBACK = pick(/try \{ stmts\.updateConfig\.run\(JSON\.stringify\(mIds\)[\s\S]*?catch \(e\) \{[\s\S]*?throw e; \}/, 'updateConfig call');
const ENGINE_WRITE = pick(/db\.prepare\(`UPDATE sessions SET run_engine=\? WHERE id=\?`\)\.run\(engine === 'subscription' \? 'subscription' : 'api', localSessionId\);/, 'run_engine write');

// Feed one dispatched message through processChat's own config-persisting path.
function persistConfigFor(dispatchedMsg) {
  // The lifted destructure resolves its fallbacks through the #58 chain, so the
  // sandbox has to supply the same two names processChat has in scope. Built from
  // the real module rather than stubbed: if a dial's built-in ever changes, this
  // test keeps measuring the write-back against what the server would really use.
  const chatDefaults = require('../chat-defaults');
  const _cd = chatDefaults.resolveChatDefaults(null, null).effective;
  const sandbox = {
    msg: dispatchedMsg, stmts, db, JSON, Buffer, Object, Array, Number,
    localSessionId: 'S1', log: { error() {} }, chatDefaults, _cd,
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    ${SQLVAL_SRC}
    ${DESTRUCTURE}
    const effectiveSkills = sIds;   // autoSkill off: processChat uses sIds verbatim
    ${WRITEBACK}
    ${ENGINE_WRITE}
  `, sandbox);
}

// ─── 1. the regression itself ───────────────────────────────────────────────
console.log('an idle interrupt must leave the session row exactly as it found it:');
{
  seed();
  const before = snapshot('S1');
  const { dispatched } = runInterrupt({ type: 'interrupt', tabId: 'S1', text: 'also check the tests' });
  check('the idle interrupt is dispatched as one normal chat turn', dispatched.length, 1);
  check('...carrying the user text', dispatched[0].text, 'also check the tests');
  check('...as a chat, not an interrupt', dispatched[0].type, 'chat');

  persistConfigFor(dispatched[0]);
  const after = snapshot('S1');
  const drop = ({ run_engine, ...rest }) => rest;   // run_engine: see the note below
  // The whole bug in one line. Old behaviour produced
  //   { model:'sonnet', mode:'auto', agent_mode:'single', workdir:null,
  //     active_skills:'[]', active_mcp:'[]' }
  check('the session row is byte-identical after the turn persists its config', drop(after), drop(before));
  // ...and the same assertions field by field, so a failure names what was lost.
  check('model survived', after.model, 'opus');
  check('mode survived', after.mode, 'plan');
  check('agent_mode survived', after.agent_mode, 'multi');
  check('workdir survived — the turn did NOT silently move to the global WORKDIR', after.workdir, '/srv/some/project');
  check('skills survived', after.active_skills, '["research","writing"]');
  check('MCP servers survived', after.active_mcp, '["context7","tavily"]');

  // run_engine is the ONE field the rebuild deliberately does NOT replay, and the assertion
  // is here so that stays a decision rather than an oversight. The SPA sends `engine: 'api'`
  // on every chat (Subscription is a per-turn toggle), so feeding a stored 'subscription'
  // back in would route this turn through the tmux engine behind the user's back. The
  // documented cost: an idle interrupt on a subscription session leaves the row on 'api'.
  check('engine is deliberately omitted from the rebuilt turn', 'engine' in dispatched[0], false);
  check('...which resets run_engine to api — the accepted trade-off, not a leftover wipe',
    after.run_engine, 'api');
  check('...and the omission is documented where the next reader will look',
    /Engine deliberately omitted/.test(INTERRUPT), true);
}

// ─── 2. the same pipeline, proven sensitive ─────────────────────────────────
// Without this the test above could pass for the wrong reason (e.g. updateConfig silently
// failing). Feed the RAW interrupt frame — what the old code dispatched — through the same
// pipeline and watch the row get destroyed.
console.log('\ncontrol — the raw interrupt frame still destroys the row (so section 1 is real):');
{
  seed();
  persistConfigFor({ type: 'chat', text: 'also check the tests', tabId: 'S1', sessionId: 'S1' });
  const after = snapshot('S1');
  check('the old dispatch wipes the model back to the default', after.model, 'sonnet');
  check('...the mode', after.mode, 'auto');
  check('...the agent mode', after.agent_mode, 'single');
  check('...the workdir', after.workdir, null);
  check('...the skills', after.active_skills, '[]');
  check('...the MCP servers', after.active_mcp, '[]');
  check('...and the engine', after.run_engine, 'api');
}

// ─── 3. the fallbacks around the rebuild ────────────────────────────────────
console.log('\nthe rebuild falls through correctly:');
{
  // A session row that never stored a value must behave exactly as it did before the fix —
  // undefined, so processChat's own defaults apply. Passing null instead would write NULLs.
  seed({ id: 'S1', model: null, mode: null, agent_mode: null, workdir: null,
         active_skills: null, active_mcp: null, run_engine: null });
  const { dispatched } = runInterrupt({ type: 'interrupt', tabId: 'S1', text: 'hi' });
  const d = dispatched[0];
  check('an unset model is passed as undefined, not null', d.model, undefined);
  check('an unset mode is passed as undefined, not null', d.mode, undefined);
  check('an unset workdir is passed as undefined, not null', d.workdir, undefined);
  check('unset skills become an empty array, not undefined', d.skills, []);
  check('unset MCP servers become an empty array, not undefined', d.mcpServers, []);
  // Corrupt JSON in the row must not throw the whole handler away.
  seed({ ...CONFIGURED, active_skills: '{not json', active_mcp: '[' });
  const bad = runInterrupt({ type: 'interrupt', tabId: 'S1', text: 'hi' }).dispatched[0];
  // (length, not deepStrictEqual: the fallback `[]` is created inside the vm realm, so a
  // deepStrictEqual against a host [] would fail on the prototype rather than the contents)
  check('unparseable skills degrade to [] instead of throwing',
    Array.isArray(bad.skills) && bad.skills.length, 0);
  check('unparseable MCP degrades to [] instead of throwing',
    Array.isArray(bad.mcpServers) && bad.mcpServers.length, 0);
  // An explicit value on the frame still wins over the row — the frame is the newer intent.
  seed();
  const ex = runInterrupt({ type: 'interrupt', tabId: 'S1', text: 'hi', model: 'haiku', workdir: '/tmp/elsewhere' }).dispatched[0];
  check('an explicit model on the frame wins over the row', ex.model, 'haiku');
  check('an explicit workdir on the frame wins over the row', ex.workdir, '/tmp/elsewhere');
  // A deleted session must not crash the handler on `_isess?.model` — the `?.` chain is
  // load-bearing, getSession returns undefined here.
  db.prepare(`DELETE FROM sessions`).run();
  const orphan = runInterrupt({ type: 'interrupt', tabId: 'S1', text: 'hi' });
  check('a deleted session still dispatches instead of throwing', orphan.dispatched.length, 1);
  check('...with every config field undefined', [orphan.dispatched[0].model, orphan.dispatched[0].mode,
    orphan.dispatched[0].agentMode, orphan.dispatched[0].workdir],
    [undefined, undefined, undefined, undefined]);
  seed();
  check('the rebuild reads the session row at all', /const _isess = stmts\.getSession\.get\(tabId\);/.test(INTERRUPT), true);
  check('...and the dispatch is fed from it, not from msg',
    /mode:\s*_isess\?\.mode\s*\|\|\s*undefined/.test(INTERRUPT) &&
    /agentMode:\s*_isess\?\.agent_mode\s*\|\|\s*undefined/.test(INTERRUPT), true);
}

// ─── 4. the idle branch must stay idle-only ─────────────────────────────────
// If this guard weakened, a clarification aimed at a running turn would be dispatched as a
// second `claude --resume` on the same session — the write race the rest of server.js avoids.
console.log('\nthe idle branch is entered only when the session really is idle:');
{
  seed();
  const busy = runInterrupt({ type: 'interrupt', tabId: 'S1', text: 'wait, use TypeScript' }, { busy: true });
  check('a busy tab dispatches no chat turn', busy.dispatched.length, 0);
  check('...it queues the interrupt instead', busy.pending?.length, 1);
  check('...with the user text', busy.pending?.[0].content, 'wait, use TypeScript');
  check('...and confirms to the client', busy.sent.some(f => f.type === 'interrupt_queued'), true);
  check('the busy path left the config alone too — including the engine', snapshot('S1'), {
    model: 'opus', mode: 'plan', agent_mode: 'multi', workdir: '/srv/some/project',
    active_skills: '["research","writing"]', active_mcp: '["context7","tavily"]', run_engine: 'subscription' });
  // hasRunningTask is load-bearing: a Kanban worker is NOT in activeTasks, so without it a
  // clarification sent to a running task becomes a fresh turn on the same session.
  check('a running Kanban task also blocks the idle branch (hasRunningTask, not just activeTasks)',
    /!activeTasks\.has\(tabId\) && !activeChatSessions\.has\(tabId\) && !_taskRunning/.test(INTERRUPT), true);
  check('an empty interrupt is dropped before anything else',
    runInterrupt({ type: 'interrupt', tabId: 'S1', text: '   ' }).dispatched.length, 0);
}

// ─── 5. the client really does send a bare frame ────────────────────────────
// The server-side rebuild only matters because the frame is bare. If the SPA ever starts
// sending full config, this check tells the next reader why the rebuild exists.
console.log('\nthe SPA interrupt frame is still config-free:');
{
  const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const frames = [...CLIENT.matchAll(/JSON\.stringify\(\{\s*type:\s*'interrupt'[\s\S]{0,400}?\}\)/g)].map(m => m[0]);
  check('the SPA sends at least one interrupt frame', frames.length > 0, true);
  for (const [i, f] of frames.entries()) {
    check(`interrupt frame #${i + 1} carries no model/mode/skills/mcp/workdir`,
      /\b(model|mode|skills|mcpServers|workdir)\s*:/.test(f), false);
  }
}

try { db.close(); } catch {}
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
