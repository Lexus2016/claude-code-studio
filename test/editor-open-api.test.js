// POST /api/editor/open against a REAL server — issue #63.
//
// editor-links.test.js pins the URI strings and reads the wiring out of the source.
// Neither statement proves the endpoint answers, that the workdir it authorises is
// the one it builds a link for, or that a remote project's host and port survive the
// trip from data/projects.json into the URI. This boots server.js in a throwaway
// APP_DIR and drives it the way the SPA does.
//
// PATH is deliberately pointed at an EMPTY directory. Two reasons, and the second is
// not optional: it makes `opened:'client'` deterministic instead of depending on
// whether the machine running the tests has VS Code, and it guarantees the suite
// never actually launches an editor window on a developer's desktop.
//
// Run: node test/editor-open-api.test.js   (TEST_PORT=<n> to move off the default port)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const E = require('../editor-links');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = Number(process.env.TEST_PORT || 4537);
const BASE = `http://127.0.0.1:${PORT}`;

const APP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-edapi-app-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-edapi-home-'));
const NO_PATH  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-edapi-nopath-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR, NO_PATH]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

const WORKSPACE = path.join(APP_DIR, 'workspace');
const LOCAL_PROJ = path.join(APP_DIR, 'workspace', 'local proj');   // a space, so the encoder is exercised end to end
fs.mkdirSync(path.join(LOCAL_PROJ, 'src'), { recursive: true });
fs.writeFileSync(path.join(LOCAL_PROJ, 'src', 'index.js'), '//\n');
const REMOTE_WD = '/srv/deploy/app';

let srvLog = '';
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR: WORKSPACE, HOME: HOME_DIR,
    PATH: NO_PATH,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
child.on('exit', () => { exited = true; });
child.stdout.on('data', d => { srvLog += d; });
child.stderr.on('data', d => { srvLog += d; });

let cleanedUp = false;
function cleanup() { if (cleanedUp) return; cleanedUp = true; if (!exited) { try { child.kill('SIGTERM'); } catch {} } }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

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
const open = body => api('POST', '/api/editor/open', body);

(async () => {
  let up = false;
  for (let i = 0; i < 80 && !exited; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (exited) die(`server exited before it became ready — port ${PORT} collision or startup crash`);
  if (!up) die(`server on port ${PORT} did not start`);
  if (!(srvLog.includes('server started') && new RegExp(`"port":\\s*"?${PORT}"?`).test(srvLog))) {
    die(`something answers /api/health on ${PORT} but our server never logged "server started"`);
  }

  const localProj = await api('POST', '/api/projects', { name: 'local', workdir: LOCAL_PROJ, gitInit: false });
  if (localProj.status !== 200) die(`could not create the local project: ${localProj.text}`);
  const host = await api('POST', '/api/remote-hosts', { label: 'box', host: 'deploy@10.0.0.5', port: 2222 });
  if (host.status !== 200 || !host.json?.id) die(`could not create the remote host: ${host.text}`);
  const remoteProj = await api('POST', '/api/projects', { name: 'remote', workdir: REMOTE_WD, isRemote: true, remoteHostId: host.json.id });
  if (remoteProj.status !== 200) die(`could not create the remote project: ${remoteProj.text}`);

  console.log('\n— a local workspace —');
  const l = await open({ workdir: LOCAL_PROJ });
  check('it answers 200', l.status, 200);
  // With no editor binary reachable there is nothing left to detect, so the browser
  // is handed the link. This is the Docker / headless / Windows path.
  check('and hands the browser the deep link', l.json.opened, 'client');
  // fs.realpathSync, not the literal: on macOS $TMPDIR lives under /private, and the
  // server resolves the project root before building the link. Comparing against the
  // unresolved path would pass on Linux and fail here.
  check('the link names the real workspace path',
    l.json.url, 'vscode://file' + E.encodePath(fs.realpathSync(LOCAL_PROJ).replace(/\\/g, '/')));
  check('the space in the path really did get encoded', l.json.url.includes('%20'), true);
  check('it is a folder', l.json.kind, 'folder');
  check('and the label is the configured editor', l.json.editor, 'VS Code');

  console.log('\n— a file inside it —');
  const f = await open({ workdir: LOCAL_PROJ, path: 'src/index.js', isFile: true });
  check('opening a file is a file', f.json.kind, 'file');
  check('and the link points at it', f.json.url.endsWith('/src/index.js'), true);

  console.log('\n— a remote SSH workspace —');
  const r = await open({ workdir: REMOTE_WD });
  check('a remote project resolves too', r.status, 200);
  // The host and the non-standard port made it out of data/projects.json and into the
  // authority. Dropping the port would not be the cautious choice — the connection
  // would then be attempted against 22 and fail.
  check('through Remote-SSH, at the recorded host and port',
    r.json.url, 'vscode://vscode-remote/ssh-remote+deploy@10.0.0.5:2222/srv/deploy/app');
  // The POSIX path was NOT run through path.resolve(): on a Windows host that turns
  // '/srv/deploy/app' into 'C:\srv\deploy\app' — the #53 failure family, here baked
  // into a link handed to the user's editor.
  check('the remote path is untouched by local platform rules',
    r.json.url.includes('/srv/deploy/app'), true);

  console.log('\n— what it refuses —');
  const stranger = await open({ workdir: path.join(os.tmpdir(), 'not-a-project') });
  check('a workdir that is not a registered project is refused', stranger.status, 403);
  const climb = await open({ workdir: LOCAL_PROJ, path: '../../../etc' });
  check('a rel path cannot climb out of the project', climb.status, 400);
  check('and says so with a code', climb.json.code, 'DENIED');
  const nul = await open({ workdir: LOCAL_PROJ, path: 'a\u0000b' });
  check('a NUL in the path is refused', nul.status, 400);
  const notString = await open({ workdir: LOCAL_PROJ, path: { a: 1 } });
  check('a non-string path is a 400, not a 500', notString.status, 400);

  console.log('\n— no project at all —');
  // The file browser answers for the default WORKDIR when the client sends no
  // workdir, and this endpoint reuses its resolver, so it has to do the same — the
  // viewer button works before any project is activated.
  const dflt = await open({});
  check('an omitted workdir falls back to the default workspace', dflt.status, 200);
  check('naming that workspace', dflt.json.url, 'vscode://file' + E.encodePath(fs.realpathSync(WORKSPACE).replace(/\\/g, '/')));

  console.log('\n— the configured editor reaches the URI —');
  // The scheme is the ONLY thing a fork changes; `vscode-remote` means the same in
  // all of them. Written through the settings endpoint rather than by editing the
  // file, so the config cache invalidation is part of what is being tested.
  const put = await api('PUT', '/api/config/setting', { key: 'editor', value: 'cursor' });
  check('the setting is writable from the settings form', put.status, 200);
  const c = await open({ workdir: LOCAL_PROJ });
  check('a local link switches scheme', c.json.url.startsWith('cursor://file/'), true);
  check('and so does a remote one, keeping vscode-remote as the authority',
    (await open({ workdir: REMOTE_WD })).json.url,
    'cursor://vscode-remote/ssh-remote+deploy@10.0.0.5:2222/srv/deploy/app');
  check('the label follows, so the button does not still say VS Code',
    (await api('GET', '/api/version')).json.editor, { id: 'cursor', label: 'Cursor' });

  cleanup();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => die(e && e.stack || String(e)));
