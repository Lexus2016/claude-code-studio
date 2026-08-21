// CCS_ENV_PATH / CCS_CONFIG_PATH exist for Docker: /app is an image layer, so a
// .env or config.json written by the config UI is gone the next time the container
// is recreated. docker-compose.yml now points both at the data volume.
//
// That relocation is the risk this file guards. An install that predates the change
// has both files at the OLD location, and starting the app on the new one would
// read nothing — every MCP server, skill and terminal setting apparently wiped, with
// the real file sitting untouched one directory away. server.js copies the legacy
// file across once, before the .env loader runs.
//
// Boots a REAL server against throwaway directories, because that is the only way
// to prove the migration happens early enough for the loader to see it: a .env value
// that only exists in the legacy file has to reach process.env of the child.
//
// Run: node test/config-migrate.test.js   (TEST_PORT=<n> to move off the default)
'use strict';
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const PORT = Number(process.env.TEST_PORT || 3980);
const BASE = `http://127.0.0.1:${PORT}`;
const DIRS = [];
const mkdir = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `ccs-migrate-${tag}-`)); DIRS.push(d); return d; };
// Every early process.exit() below jumps past the cleanup at the bottom.
process.on('exit', () => { for (const d of DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// The parent shell of a Claude Code session exports CCS_DESKTOP=1 and APP_DIR.
// Inheriting either turns the auth wall off and repoints data/ at the real user
// directory, so the child env is scrubbed rather than merely overridden.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.CCS_DESKTOP;
  // The .env loader honours an already-set variable over the file (`!(k in
  // process.env)`), and the parent shell of a Claude Code session exports PORT.
  // Inheriting it would make the ordering probe below unfalsifiable: the server
  // would land on the right port whether or not the migration ran.
  delete env.PORT; delete env.LOG_LEVEL;
  for (const k of ['CCS_ENV_PATH', 'CCS_CONFIG_PATH', 'CCS_INTERRUPT_URL', 'CCS_INTERRUPT_SESSION', 'CCS_INTERRUPT_SECRET']) delete env[k];
  return { ...env, ...extra };
}

// Every assertion below reads a file the migration is supposed to have created.
// readFileSync on a missing one throws, and an uncaught throw ends the run early —
// which would report a broken migration as FEWER failures, not more.
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

function canConnect(host, port, timeout = 300) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

(async () => {
  if (await canConnect('127.0.0.1', PORT, 200)) {
    console.error(`port ${PORT} is already in use — set TEST_PORT`);
    process.exit(1);
  }

  const APP_DIR = mkdir('app');       // the legacy location: config.json + .env sit here
  const VOL     = mkdir('vol');       // the "data volume" both variables now point at
  fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

  const LEGACY_CONF = path.join(APP_DIR, 'config.json');
  const LEGACY_ENV  = path.join(APP_DIR, '.env');
  const TARGET_CONF = path.join(VOL, 'config.json');
  const TARGET_ENV  = path.join(VOL, '.env');

  // A config the user would notice losing: a named MCP server and a skill.
  const CONF = {
    mcpServers: { 'legacy-server': { command: 'echo', args: ['hi'], enabled: false } },
    skills: { 'legacy-skill': { file: 'legacy.md', enabled: false } },
    lang: 'fr',
  };
  fs.writeFileSync(LEGACY_CONF, JSON.stringify(CONF, null, 2));
  fs.writeFileSync(LEGACY_ENV, '# legacy env\nCCS_LEGACY_ONLY=yes\nLOG_LEVEL=error\n');

  console.log('\n— before boot —');
  check('the legacy files exist', [fs.existsSync(LEGACY_CONF), fs.existsSync(LEGACY_ENV)], [true, true]);
  check('the targets do not', [fs.existsSync(TARGET_CONF), fs.existsSync(TARGET_ENV)], [false, false]);

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: childEnv({
      PORT: String(PORT), APP_DIR, WORKDIR: APP_DIR, HOST: '127.0.0.1', LOG_LEVEL: 'error',
      CCS_CONFIG_PATH: TARGET_CONF, CCS_ENV_PATH: TARGET_ENV,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const stop = () => { try { srv.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);

  let up = false;
  for (let i = 0; i < 120; i++) {
    if (await canConnect('127.0.0.1', PORT, 300)) { up = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) { console.error('server never came up:\n' + log); process.exit(1); }

  console.log('\n— the legacy files are carried across —');
  check('config.json now exists at the new path', fs.existsSync(TARGET_CONF), true);
  // Not byte equality: loadConfig() backfills its defaults and rewrites the file
  // moments after boot, so a whole-file compare is a race. What must survive the
  // copy is the user's own content — the settings they would notice losing.
  const carried = readJson(TARGET_CONF);
  check('the legacy MCP server came across', carried.mcpServers['legacy-server'],
    { command: 'echo', args: ['hi'], enabled: false });
  check('and the legacy skill', carried.skills['legacy-skill'], { file: 'legacy.md', enabled: false });
  check('and the legacy language', carried.lang, 'fr');
  check('.env now exists at the new path', fs.existsSync(TARGET_ENV), true);
  check('and is byte-identical too', read(TARGET_ENV), read(LEGACY_ENV));
  // copyFile, not rename: a rollback to the previous version must still find its
  // config, and the legacy path may be a read-only mount.
  check('the legacy config is left in place, not moved', fs.existsSync(LEGACY_CONF), true);
  check('and so is the legacy .env', fs.existsSync(LEGACY_ENV), true);
  check('the copy is announced in the log', /\[migrate\].*config\.json/.test(log), true);
  // .env holds secrets. A copy that widened the mode would be a regression on its own.
  // Guarded: if the copy did not happen at all, statSync throws and the remaining
  // assertions never run — a crash reads as "fewer failures" instead of more.
  check('the copied .env is 0600',
    fs.existsSync(TARGET_ENV) ? (fs.statSync(TARGET_ENV).mode & 0o777).toString(8) : 'no file', '600');

  console.log('\n— the copy happens before the .env loader reads it —');
  // The ordering claim, proved by behaviour rather than by inspection: a SECOND
  // legacy install whose .env sets PORT and nothing else. PORT is not passed to the
  // child, so the only way the server can end up on that port is copy-then-load.
  const r = await fetch(`${BASE}/api/health`).catch(() => null);
  check('the first server is serving', r?.status, 200);

  const APP2 = mkdir('app2');
  const VOL2 = mkdir('vol2');
  fs.mkdirSync(path.join(APP2, 'data'), { recursive: true });
  const PORT_FROM_ENV = PORT + 2;
  fs.writeFileSync(path.join(APP2, '.env'), `PORT=${PORT_FROM_ENV}\nLOG_LEVEL=error\n`);
  const srvE = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // No PORT, no LOG_LEVEL. Both exist only inside the legacy .env.
    env: childEnv({ APP_DIR: APP2, WORKDIR: APP2, HOST: '127.0.0.1', CCS_ENV_PATH: path.join(VOL2, '.env') }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopE = () => { try { srvE.kill('SIGTERM'); } catch {} };
  process.on('exit', stopE);
  let upE = false;
  for (let i2 = 0; i2 < 120; i2++) {
    if (await canConnect('127.0.0.1', PORT_FROM_ENV, 300)) { upE = true; break; }
    await new Promise(r2 => setTimeout(r2, 250));
  }
  check('a PORT that lives only in the legacy .env is in effect', upE, true);
  check('and the file was carried to the new path to get there',
    fs.existsSync(path.join(VOL2, '.env')), true);
  stopE();
  await new Promise(r2 => setTimeout(r2, 300));

  console.log('\n— it is a one-time copy, not a sync —');
  // A user who edits the new file must not have it overwritten on every restart.
  fs.writeFileSync(TARGET_CONF, JSON.stringify({ mcpServers: {}, skills: {}, lang: 'he' }, null, 2));
  stop();
  await new Promise(r => setTimeout(r, 500));
  const srv2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: childEnv({
      PORT: String(PORT), APP_DIR, WORKDIR: APP_DIR, HOST: '127.0.0.1', LOG_LEVEL: 'error',
      CCS_CONFIG_PATH: TARGET_CONF, CCS_ENV_PATH: TARGET_ENV,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop2 = () => { try { srv2.kill('SIGTERM'); } catch {} };
  process.on('exit', stop2);
  let up2 = false;
  for (let i = 0; i < 120; i++) {
    if (await canConnect('127.0.0.1', PORT, 300)) { up2 = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  check('the server restarts on the migrated config', up2, true);
  // loadConfig() backfills default slash commands and external agents on every boot,
  // so the file is not byte-stable — assert on the user's OWN keys instead. The
  // legacy values must not come back, or the copy is a sync and every restart
  // reverts whatever the user changed.
  const after2 = readJson(TARGET_CONF);
  check('the edited language survived the second boot', after2.lang, 'he');
  check('the legacy MCP server did not come back', Object.keys(after2.mcpServers || {}), []);
  check('nor the legacy skill', Object.keys(after2.skills || {}), []);
  stop2();

  console.log('\n— nothing happens where the variables are unset —');
  // The default (npm start, Electron, npx) must be untouched: no variable, no copy.
  const PLAIN = mkdir('plain');
  fs.mkdirSync(path.join(PLAIN, 'data'), { recursive: true });
  fs.writeFileSync(path.join(PLAIN, 'config.json'), '{"mcpServers":{},"skills":{}}');
  const before = fs.readFileSync(path.join(PLAIN, 'config.json'), 'utf8');
  const srv3 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: childEnv({ PORT: String(PORT + 1), APP_DIR: PLAIN, WORKDIR: PLAIN, HOST: '127.0.0.1', LOG_LEVEL: 'error' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop3 = () => { try { srv3.kill('SIGTERM'); } catch {} };
  process.on('exit', stop3);
  let up3 = false;
  for (let i = 0; i < 120; i++) {
    if (await canConnect('127.0.0.1', PORT + 1, 300)) { up3 = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  check('a plain install boots', up3, true);
  // The server legitimately creates skills/ and data/ at boot. What must NOT appear
  // is a .env it never had, and its config.json must not have been replaced by a
  // copy of anything — only backfilled with the defaults loadConfig() always adds.
  check('no .env was conjured out of nowhere', fs.existsSync(path.join(PLAIN, '.env')), false);
  const plainConf = readJson(path.join(PLAIN, 'config.json'));
  check('its config still has no MCP servers', Object.keys(plainConf.mcpServers || {}), []);
  check('and no skills', Object.keys(plainConf.skills || {}), []);
  check('positive control: the fixture really did start empty',
    JSON.parse(before).mcpServers, {});
  stop3();

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  for (const d of DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
})();
