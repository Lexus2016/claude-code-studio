// The remote file browser as the browser actually reaches it — issue #57.
//
// test/remote-files.test.js pins the three guard layers in isolation. This one boots a
// real server and drives GET /api/files exactly as the SPA does, against a FAKE remote
// whose filesystem this test owns. No sshd is started and ~/.ssh is never touched:
// claude-ssh.js resolves its transport through CCS_REMOTE_EXEC_HOOK, and the hook here
// runs the REAL command string the endpoint built, through a real /bin/sh. So the POSIX
// script, the nonce framing, the containment guards and the endpoint wiring are all
// under test — a stub would have proved only the last of those.
//
// What fails loudly if a guard is removed:
//   - "a ../ escape is refused (403)"
//   - "a symlinked directory out of the project is refused (403)"
//   - "download stays refused for a remote project"
//   - "the SSH password never appears in any response or in the server log"
//
// Run: node test/remote-files-api.test.js   (TEST_PORT=<n> to move off the default port)
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

const PORT = Number(process.env.TEST_PORT || 4531);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET_PW = 'pw-remotefiles-never-leak';

const APP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-rfapi-app-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-rfapi-home-'));
const REM_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-rfapi-rem-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR, REM_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// The "remote" project, and a directory beside it that must stay unreachable.
const PROJ    = path.join(REM_DIR, 'project');
const OUTSIDE = path.join(REM_DIR, 'outside');
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'TOP SECRET\n');
fs.writeFileSync(path.join(PROJ, 'readme.md'), '# hello\n');
fs.writeFileSync(path.join(PROJ, 'src', 'index.js'), 'export default 1;\n');
fs.writeFileSync(path.join(PROJ, 'src', 'a b.ts'), 'const y = 2;\n');
fs.writeFileSync(path.join(PROJ, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
fs.symlinkSync(OUTSIDE, path.join(PROJ, 'escape-dir'));

const HOOK = path.join(APP_DIR, 'fake-remote-exec.js');
fs.writeFileSync(HOOK, `
const { execFile } = require('child_process');
exports.runRemoteCommand = function ({ host, command }) {
  return new Promise((resolve, reject) => {
    if (/unreachable/.test(host)) { const e = new Error('Cannot reach ' + host); e.ccsCode = 'unreachable'; return reject(e); }
    execFile('/bin/sh', ['-c', command], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout, stderr }));
  });
};
`);

let srvLog = '';
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR: path.join(APP_DIR, 'workspace'), HOME: HOME_DIR,
    CCS_REMOTE_EXEC_HOOK: HOOK,
    // Small enough that the project root listing is capped — the truncation flag has to
    // survive all the way to the browser, or a partial tree reads as the whole one.
    CCS_REMOTE_FILES_MAX_ENTRIES: '3',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
child.on('exit', () => { exited = true; });
child.stdout.on('data', d => { srvLog += d; });
child.stderr.on('data', d => { srvLog += d; });

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  if (!exited) { try { child.kill('SIGTERM'); } catch {} }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) {
  console.error(msg);
  if (srvLog) console.error(srvLog.slice(-2000));
  cleanup();
  process.exit(1);
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const filesQS = (p, wd) => `/api/files?path=${encodeURIComponent(p)}&workdir=${encodeURIComponent(wd)}`;

(async () => {
  let up = false;
  for (let i = 0; i < 80 && !exited; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (exited) die(`server exited before it became ready — port ${PORT} collision or startup crash`);
  if (!up) die(`server on port ${PORT} did not start`);
  // Refuse to assert against something else that happens to answer on this port.
  if (!(srvLog.includes('server started') && new RegExp(`"port":\\s*"?${PORT}"?`).test(srvLog))) {
    die(`something answers /api/health on ${PORT} but our server never logged "server started"`);
  }

  const host = await api('POST', '/api/remote-hosts', { label: 'fake', host: 'fake.invalid', port: 22, username: 'u', password: SECRET_PW });
  if (host.status !== 200 || !host.json || !host.json.id) die(`could not create the remote host: ${host.text}`);
  const gone = await api('POST', '/api/remote-hosts', { label: 'gone', host: 'gone.invalid', port: 22, username: 'u', password: SECRET_PW });

  const proj = await api('POST', '/api/projects', { name: 'remote-proj', workdir: PROJ, isRemote: true, remoteHostId: host.json.id });
  if (proj.status !== 200) die(`could not create the remote project: ${proj.text}`);
  const orphan = await api('POST', '/api/projects', { name: 'orphan-proj', workdir: path.join(REM_DIR, 'orphan'), isRemote: true, remoteHostId: gone.json.id });

  const bodies = [];
  const get = async (p, wd = PROJ) => { const r = await api('GET', filesQS(p, wd)); bodies.push(r.text); return r; };

  console.log('\n— listing —');
  const root = await get('');
  check('the project root lists instead of refusing', root.json && root.json.type, 'dir');
  check('the answer is flagged remote so the UI drops download/raw', root.json.remote, true);
  check('the cap is reported, not applied silently', root.json.truncated, true);
  check('the cap is honoured exactly', root.json.items.length, 3);

  const sub = await get('src');
  check('a subdirectory lists', sub.json.items.map(i => i.name).sort(), ['a b.ts', 'index.js']);
  // path.posix.join, never path.join: on a Windows host the latter yields 'src\\index.js'
  // and the next request resolves it as ONE filename that does not exist.
  check('a listed path is POSIX, whatever this server runs on',
    sub.json.items.find(i => i.name === 'index.js').path, 'src/index.js');
  check('a listed file carries its size',
    sub.json.items.find(i => i.name === 'index.js').size, 'export default 1;\n'.length);
  check('a dot-file-free listing matches the local browser', sub.json.items.every(i => !i.name.startsWith('.')), true);

  console.log('\n— reading —');
  const idx = await get('src/index.js');
  check('a file round-trips through the path the listing gave', idx.json.type, 'file');
  check('the content arrives intact', idx.json.content, 'export default 1;\n');
  check('the read is flagged remote too', idx.json.remote, true);
  const spaced = await get('src/a b.ts');
  check('a filename with a space reads', spaced.json.content, 'const y = 2;\n');
  const bin = await get('bin.dat');
  check('a binary file is labelled, not dumped', bin.json.content, '[Binary]');
  const missing = await get('nope.txt');
  check('a missing file is 404, not 500', missing.status, 404);

  console.log('\n— the guards —');
  const esc = await get('../outside/secret.txt');
  check('a ../ escape is refused (403)', esc.status, 403);
  const abs = await get('/etc/passwd');
  check('an absolute path is refused (403)', abs.status, 403);
  // Satisfies every check this process can make — the string starts with the project
  // root. Only `pwd -P` on the remote knows where it lands.
  const symdir = await get('escape-dir');
  check('a symlinked directory out of the project is refused (403)', symdir.status, 403);
  const through = await get('escape-dir/secret.txt');
  check('reading THROUGH the symlink is refused (403)', through.status, 403);
  check('no refusal leaked the file it was protecting', bodies.some(b => b.includes('TOP SECRET')), false);

  const unregistered = await api('GET', filesQS('', path.join(REM_DIR, 'not-a-project')));
  check('an unregistered workdir is refused', unregistered.status, 403);
  if (orphan.status === 200) {
    await api('DELETE', `/api/remote-hosts/${gone.json.id}`);
    const orphaned = await api('GET', filesQS('', path.join(REM_DIR, 'orphan')));
    bodies.push(orphaned.text);
    check('a project whose host was deleted says so rather than failing to connect', orphaned.status, 400);
  }

  console.log('\n— what stays refused —');
  // Issue #57 ships READ-ONLY. Both of these are what the UI now hides its buttons for;
  // if either started answering, the SPA would be hiding a working feature.
  const dl = await api('GET', `/api/files/download?path=readme.md&workdir=${encodeURIComponent(PROJ)}`);
  bodies.push(dl.text);
  check('download stays refused for a remote project', dl.status, 400);
  const raw = await api('GET', `/api/files/raw?path=readme.md&workdir=${encodeURIComponent(PROJ)}`);
  bodies.push(raw.text);
  check('raw access stays refused for a remote project', raw.status, 400);

  console.log('\n— the credential —');
  check('the SSH password never appears in any response', bodies.some(b => b.includes(SECRET_PW)), false);
  check('the SSH password never reaches the server log', srvLog.includes(SECRET_PW), false);

  cleanup();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => die(String(e && e.stack || e)));
