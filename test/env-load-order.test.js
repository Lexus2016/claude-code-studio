// Regression guard for the .env load-order bug (no test framework wired in this project).
// Run: node test/env-load-order.test.js
//
// claude-cli.js, claude-ssh.js and claude-interactive.js read CLAUDE_IDLE_TIMEOUT_MS /
// CLAUDE_HARD_CAP_MS into module-scope consts at require() time. server.js used to
// require them BEFORE parsing .env, so every timeout set in .env was silently ignored
// and the hardcoded 10-minute idle default applied instead. These are static checks —
// server.js starts a listening server on require, so it cannot be imported here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    pass++; console.log(`  ok   ${label}`);
  } catch {
    fail++; console.error(`  FAIL ${label} — expected ${expected}, got ${actual}`);
  }
}

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
const lines = server.split(/\r?\n/);

// Anchored on the binding, not on its full right-hand side: the previous matcher
// spelled out `path.join(process.env.APP_DIR` and stopped matching the moment the
// CCS_ENV_PATH override was added in front of it — at which point findIndex returned
// -1 and the ordering assertion below passed VACUOUSLY (-1 is less than anything).
const envLoadLine = lines.findIndex(l => /^const envPath = /.test(l.trim()));
// First require() of a local module — those are the ones that capture env at load time.
const firstLocalRequire = lines.findIndex(l => /^const .*= require\('\.\//.test(l.trim()));

console.log('server.js — .env must be parsed before any local require():');
check('.env loader found', envLoadLine >= 0, true);
check('local require found', firstLocalRequire >= 0, true);
// Both indexes are asserted found above, so this can no longer pass on a -1.
check('.env loader runs first', envLoadLine >= 0 && firstLocalRequire >= 0 && envLoadLine < firstLocalRequire, true);
// Positive control: the comparison is real, not a constant. Reversing the operands
// on the same two indexes must give the opposite answer.
check('positive control: the ordering check is not vacuous', firstLocalRequire < envLoadLine, false);
// The loader must still resolve APP_DIR itself — CCS_ENV_PATH is an override, not a
// replacement, and a build that dropped the default would break every non-Docker install.
check('the loader still falls back to APP_DIR',
  /process\.env\.CCS_ENV_PATH \|\| path\.join\(process\.env\.APP_DIR \|\| __dirname, '\.env'\)/.test(server), true);

// The loader depends on `path` and `fs` — both must already be bound above it.
const pathReq = lines.findIndex(l => l.trim() === "const path = require('path');");
const fsReq = lines.findIndex(l => l.trim() === "const fs = require('fs');");
check("`path` required before loader", pathReq >= 0 && pathReq < envLoadLine, true);
check("`fs` required before loader", fsReq >= 0 && fsReq < envLoadLine, true);

console.log('\nengines read the timeout env vars at module scope (why order matters):');
for (const f of ['claude-cli.js', 'claude-ssh.js', 'claude-interactive.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf-8');
  check(`${f} reads CLAUDE_IDLE_TIMEOUT_MS`, src.includes('process.env.CLAUDE_IDLE_TIMEOUT_MS'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
