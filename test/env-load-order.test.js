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

const envLoadLine = lines.findIndex(l => l.includes("const envPath = path.join(process.env.APP_DIR"));
// First require() of a local module — those are the ones that capture env at load time.
const firstLocalRequire = lines.findIndex(l => /^const .*= require\('\.\//.test(l.trim()));

console.log('server.js — .env must be parsed before any local require():');
check('.env loader found', envLoadLine >= 0, true);
check('local require found', firstLocalRequire >= 0, true);
check('.env loader runs first', envLoadLine < firstLocalRequire, true);

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
