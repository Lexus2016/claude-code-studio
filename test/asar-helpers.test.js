// A spawned helper must live OUTSIDE app.asar — desktop regression, v7.10.0.
//
// The failure this file exists to stop leaves no error anywhere a user or a developer
// looks. In the packaged app `__dirname` is `…/Resources/app.asar/`. server.js runs
// under Electron (`utilityProcess.fork`), whose patched `fs` reads that archive
// transparently — so every path server.js builds LOOKS valid. But the MCP helpers and
// the interrupt hook are handed to NODE_CMD, a plain system `node`, which has no asar
// support at all:
//
//   $ node "/Applications/Claude Code Studio.app/Contents/Resources/app.asar/mcp-bots.js"
//   Error: Cannot find module '…/app.asar/mcp-bots.js'   (MODULE_NOT_FOUND)
//
// The `claude` CLI reports an MCP server that failed to start as nothing at all — the
// tool is simply absent from the model's tool list. Shipped result: `message_bot`,
// `check_user_messages`, `ask_user`, `notify_user` and `set_ui_state` were silently
// missing from every desktop turn, while the system prompt kept telling the model to
// use them.
//
// Two layers, both pinned here, because fixing only the first moves the error one
// level deeper: the unpacked mcp-bots.js still died on `Cannot find module './bots.js'`.
//
// Run: node test/asar-helpers.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.error(`  FAIL ${label} — ${e.message}`); }
}

// ── 1. helperPath() itself ───────────────────────────────────────────────────
// Extracted as source rather than required: server.js boots a whole HTTP server on
// require. Same technique as test/ask-user-question.test.js.
const m = SRV.match(/const ASAR_SEG = [\s\S]*?\nfunction helperPath\([\s\S]*?\n}/);
assert.ok(m, 'helperPath() not found in server.js — did it get renamed?');
const helperPath = new Function('path', '__dirname', `${m[0]}\nreturn helperPath;`);

const posix = helperPath(path.posix, '/Applications/App.app/Contents/Resources/app.asar');
const win = helperPath(path.win32, 'C:\\Users\\a\\AppData\\Local\\App\\resources\\app.asar');
const web = helperPath(path.posix, '/srv/claude-code-studio');

check('desktop: mcp helper is redirected to app.asar.unpacked', () => {
  assert.strictEqual(
    posix('mcp-bots.js'),
    '/Applications/App.app/Contents/Resources/app.asar.unpacked/mcp-bots.js');
});
check('desktop: a nested hook path is redirected too', () => {
  assert.strictEqual(
    posix('hooks', 'check-interrupt.js'),
    '/Applications/App.app/Contents/Resources/app.asar.unpacked/hooks/check-interrupt.js');
});
check('windows: the separator is not hardcoded to /', () => {
  assert.strictEqual(
    win('mcp-notify.js'),
    'C:\\Users\\a\\AppData\\Local\\App\\resources\\app.asar.unpacked\\mcp-notify.js');
});
check('web/docker: untouched — no app.asar in the path', () => {
  assert.strictEqual(web('mcp-notify.js'), '/srv/claude-code-studio/mcp-notify.js');
});
check('a directory merely NAMED app.asar-something is not rewritten', () => {
  // `.replace` on a bare substring would corrupt this one.
  assert.strictEqual(
    helperPath(path.posix, '/home/u/app.asarcheck')('mcp-notify.js'),
    '/home/u/app.asarcheck/mcp-notify.js');
});

// ── 2. no spawn site bypasses it ─────────────────────────────────────────────
// One re-introduced `path.join(__dirname, 'mcp-….js')` is one tool missing on desktop,
// and nothing in the app says so.
check('server.js builds no spawned-helper path with a raw path.join(__dirname…)', () => {
  const raw = SRV.match(/path\.join\(__dirname, *'(?:mcp-[a-z-]+\.js|hooks')/g) || [];
  assert.deepStrictEqual(raw, [], `raw path.join spawn sites left: ${raw.join(', ')}`);
});
check('every mcp-*.js in the repo has a helperPath() spawn site', () => {
  const shipped = fs.readdirSync(ROOT).filter(f => /^mcp-[a-z-]+\.js$/.test(f));
  const missing = shipped.filter(f => !SRV.includes(`helperPath('${f}')`));
  // mcp-task-manager.js and the four _ccs_* helpers are all spawned from server.js.
  assert.deepStrictEqual(missing, [], `never spawned via helperPath: ${missing.join(', ')}`);
});

// ── 3. asarUnpack covers the transitive requires ─────────────────────────────
const YML = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
const unpack = (YML.match(/asarUnpack:\n((?:\s*(?:#.*|-.*)\n)+)/) || [, ''])[1]
  .split('\n').map(l => l.trim()).filter(l => l.startsWith('- '))
  .map(l => l.slice(2).replace(/^"|"$/g, ''));

check('asarUnpack lists the helper entry points and the hooks', () => {
  assert.ok(unpack.includes('mcp-*.js'), 'mcp-*.js missing from asarUnpack');
  assert.ok(unpack.includes('hooks/**'), 'hooks/** missing from asarUnpack');
});
check('every local require() of a spawned helper is unpacked as well', () => {
  const entries = [
    ...fs.readdirSync(ROOT).filter(f => /^mcp-[a-z-]+\.js$/.test(f)),
    ...fs.readdirSync(path.join(ROOT, 'hooks')).filter(f => f.endsWith('.js')).map(f => `hooks/${f}`),
  ];
  const covered = (rel) => unpack.some(g =>
    g === rel ||
    (g === 'mcp-*.js' && /^mcp-[a-z-]+\.js$/.test(rel)) ||
    (g === 'hooks/**' && rel.startsWith('hooks/')));
  const missing = [];
  for (const rel of entries) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const r of src.match(/require\('\.\/[^']+'\)/g) || []) {
      const dep = r.slice(11, -2);                       // require('./x.js') → x.js
      const target = path.posix.join(path.posix.dirname(rel), dep);
      if (!covered(target)) missing.push(`${rel} → ${target}`);
    }
  }
  assert.deepStrictEqual(missing, [], `required but left inside app.asar: ${missing.join(', ')}`);
});

console.log(`\nasar-helpers: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
