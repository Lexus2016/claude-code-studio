// claudeCliStatus() (claude-cli.js) and its 'claudeCli' field on GET /api/version.
//
// Nothing else in the suite touches either — this pins the shape of the preflight
// result, that it caches instead of re-spawning on every call, and that the field
// actually reaches the wire on a real server.
//
// findClaudeBin() checks fixed absolute paths (e.g. /opt/homebrew/bin/claude) before
// falling back to PATH, so pointing PATH at an empty directory does NOT make
// `available` deterministically false on a machine with claude installed at one of
// those fixed locations — this only pins the invariants that hold either way.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('— claudeCliStatus() in-process —');
{
  const { claudeCliStatus } = require('../claude-cli');

  const first = claudeCliStatus();
  check('shape is {available, authenticated}', Object.keys(first).sort(), ['authenticated', 'available']);
  check('available is a boolean', typeof first.available, 'boolean');
  check('authenticated is a boolean', typeof first.authenticated, 'boolean');
  check('authenticated is never true while available is false',
    !first.available && first.authenticated, false);

  const second = claudeCliStatus();
  check('a second call returns the cached object, not a recomputation', second === first, true);
}

console.log('\n— GET /api/version on a real server —');
{
  const PORT = Number(process.env.TEST_PORT || 4539);
  const BASE = `http://127.0.0.1:${PORT}`;
  const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-clistatus-app-'));
  const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-clistatus-home-'));
  process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
  fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), APP_DIR, WORKDIR: path.join(APP_DIR, 'workspace'), HOME: HOME_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false, srvLog = '';
  child.on('exit', () => { exited = true; });
  child.stdout.on('data', d => { srvLog += d; });
  child.stderr.on('data', d => { srvLog += d; });
  let cleanedUp = false;
  function cleanup() { if (cleanedUp) return; cleanedUp = true; if (!exited) { try { child.kill('SIGTERM'); } catch {} } }
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
  function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

  (async () => {
    let up = false;
    for (let i = 0; i < 80 && !exited; i++) {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
      await sleep(250);
    }
    if (exited) die(`server exited before it became ready — port ${PORT} collision or startup crash`);
    if (!up) die(`server on port ${PORT} did not start`);

    const res = await fetch(BASE + '/api/version');
    const json = await res.json();
    check('the response carries a claudeCli field', typeof json.claudeCli, 'object');
    check('with an available boolean', typeof json.claudeCli.available, 'boolean');
    check('with an authenticated boolean', typeof json.claudeCli.authenticated, 'boolean');
    check('authenticated is never true while available is false',
      !json.claudeCli.available && json.claudeCli.authenticated, false);
    check('the pre-existing tmuxAvailable field is untouched by this change', typeof json.tmuxAvailable, 'boolean');

    cleanup();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch(e => die(e && e.stack || String(e)));
}
