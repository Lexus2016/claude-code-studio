// Integration tests for session liveness reporting. Starts a real server against a
// THROWAWAY data directory, so it never touches the developer's chats.db.
//
// Covers two regressions:
//
//   #28 — `done` for a plain web chat was unicast through the per-socket WsProxy and
//         never fanned out to sessionWatchers. A second socket watching the same
//         session (a second window, or a background tab subscribed with
//         noCatchUp:true, which deliberately skips proxy.attach) therefore never
//         learned the turn ended and kept its busy dot spinning for the page lifetime.
//
//   #30 — `GET /api/sessions/:id`.isChatRunning read activeTasks only, while
//         `GET /api/tasks/running-sessions` unions activeChatSessions too. The gap
//         between activeChatSessions.add() and activeTasks.set() holds
//         `await classifyTask()` (~10-15s with autoSkill), so for that whole window
//         the two endpoints disagreed and loadSess reset a live tab to "done".
//
// Auth is exercised for real (setup → token) rather than bypassed.
//
// Run: node test/session-liveness.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Overridable, and refused rather than silently run against whatever already holds the
// port: server.listen()'s failure kills the child, and the readiness loop would then talk
// to a foreign server — creating sessions, and billed turns, in someone else's database.
const PORT = Number(process.env.TEST_PORT || 3994);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'liveness-test-pw';
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-liveness-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-liveness-home-'));
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// A fake `claude`. findClaudeBin() probes $HOME/.local/bin/claude first and has no env
// override, so HOME is what we redirect.
//   `--model haiku` → the autoSkill classifier call. Sleeping here holds the session in
//                     the activeChatSessions-only window on purpose (that IS the #30 bug
//                     window); it emits nothing, so classifyTask falls back to no skills.
//   anything else   → the real turn. Exits straight away: onDone fires on process close
//                     regardless of what was written, which is all these tests need.
const binDir = path.join(HOME_DIR, '.local', 'bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'claude'),
  '#!/bin/sh\ncase " $* " in *" haiku "*) sleep 8 ;; *) sleep 1 ;; esac\nexit 0\n');
fs.chmodSync(path.join(binDir, 'claude'), 0o755);

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), APP_DIR, WORKDIR: APP_DIR, HOME: HOME_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvExited = null;
srv.on('exit', (code, sig) => { srvExited = sig || code; });
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });

function cleanup() {
  try { srv.kill('SIGTERM'); } catch {}
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch {}
}
let cleanedUp = false;
function cleanupOnce() { if (cleanedUp) return; cleanedUp = true; cleanup(); }
process.on('exit', cleanupOnce);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanupOnce(); process.exit(1); });
}

let TOKEN = null;
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(TOKEN ? { 'x-auth-token': TOKEN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { 'x-auth-token': TOKEN } });
  ws._frames = [];
  ws.on('message', raw => { try { ws._frames.push(JSON.parse(raw)); } catch {} });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
}
const doneFrames = (ws, sid) => ws._frames.filter(f => f.type === 'done' && f.tabId === sid);

function bail(msg) { console.error(msg); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); }

(async () => {
  let up = false;
  for (let i = 0; i < 80; i++) {
    // Our own child dying is fatal — without this the loop keeps polling and can settle on
    // a foreign server that happens to hold the port, running every assertion against it.
    if (srvExited !== null) {
      bail(`server exited before it was ready (${srvExited}). If port ${PORT} is taken, `
        + `re-run with: TEST_PORT=<free port> node test/session-liveness.test.js`);
    }
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (!up) bail('server did not start');
  // …and the server that answered must be the one we spawned, not a squatter that
  // happened to be healthy on this port.
  if (!srvLog.includes('"port":' + PORT) && !srvLog.includes(`:${PORT}`)) {
    bail(`the server answering on ${PORT} is not the child we spawned`);
  }

  const setup = await fetch(BASE + '/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, displayName: 'Test' }),
  });
  const setCookie = setup.headers.get('set-cookie') || '';
  TOKEN = (setCookie.match(/(?:^|[;,\s])token=([^;,\s]+)/) || [])[1] || null;
  check('auth setup issued a token', typeof TOKEN, 'string');
  if (!TOKEN) bail('no token from /api/auth/setup');

  // ── #28: `done` reaches a second socket watching the same session ──────────
  console.log('\n#28 done fan-out to session watchers:');
  const c28 = await api('POST', '/api/sessions', { title: 'liveness-28', workdir: APP_DIR });
  const sid28 = c28.json && c28.json.id;
  check('session created', typeof sid28, 'string');
  if (!sid28) bail('no session id');

  const owner = await openWs().catch(e => bail(e.message));
  const watcher = await openWs().catch(e => bail(e.message));
  // Owner subscribes the way the active tab does; watcher the way a background tab
  // does (noCatchUp:true — the case that used to be starved of `done`).
  owner.send(JSON.stringify({ type: 'subscribe_session', sessionId: sid28 }));
  watcher.send(JSON.stringify({ type: 'subscribe_session', sessionId: sid28, noCatchUp: true }));
  await sleep(300);

  owner.send(JSON.stringify({ type: 'chat', text: 'hi', tabId: sid28, sessionId: sid28, model: 'sonnet', mode: 'auto' }));

  for (let i = 0; i < 60; i++) {
    if (doneFrames(owner, sid28).length && doneFrames(watcher, sid28).length) break;
    await sleep(250);
  }
  check('originating socket got exactly one done', doneFrames(owner, sid28).length, 1);
  check('noCatchUp watcher got exactly one done', doneFrames(watcher, sid28).length, 1);

  let cleared = false;
  for (let i = 0; i < 40; i++) {
    const r = await api('GET', '/api/tasks/running-sessions');
    if (!(r.json || []).includes(sid28)) { cleared = true; break; }
    await sleep(250);
  }
  check('session left running-sessions after the turn', cleared, true);

  // Nothing arrives late either — a second `done` would double-fire the client's
  // notification + history reload.
  await sleep(1000);
  check('no duplicate done on the originating socket', doneFrames(owner, sid28).length, 1);
  check('no duplicate done on the watcher socket', doneFrames(watcher, sid28).length, 1);
  try { owner.close(); } catch {}
  try { watcher.close(); } catch {}

  // ── #30: isChatRunning agrees with running-sessions at every sample ────────
  console.log('\n#30 isChatRunning vs running-sessions during classification:');
  const c30 = await api('POST', '/api/sessions', { title: 'liveness-30', workdir: APP_DIR });
  const sid30 = c30.json && c30.json.id;
  check('session created', typeof sid30, 'string');
  if (!sid30) bail('no session id');

  const runner = await openWs().catch(e => bail(e.message));
  // autoSkill + a session with no claude_session_id ⇒ shouldClassify === true, so the
  // turn parks in `await classifyTask()` while only activeChatSessions knows about it.
  runner.send(JSON.stringify({
    type: 'chat', text: 'build a login screen', tabId: sid30, sessionId: sid30,
    model: 'sonnet', mode: 'auto', autoSkill: true,
  }));

  const disagreements = [];
  let sampledLive = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const [running, sess] = await Promise.all([
      api('GET', '/api/tasks/running-sessions'),
      api('GET', `/api/sessions/${sid30}`),
    ]);
    const inRunning = (running.json || []).includes(sid30);
    const isChatRunning = !!(sess.json && sess.json.isChatRunning);
    if (inRunning) sampledLive++;
    if (inRunning !== isChatRunning) disagreements.push({ t: (i + 1) * 300, inRunning, isChatRunning });
  }
  check('the turn was observed live at least once', sampledLive > 0, true);
  if (disagreements.length) console.error('   disagreements: ' + JSON.stringify(disagreements));
  check('running-sessions and isChatRunning never disagree', disagreements.length, 0);
  try { runner.close(); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-3000)); cleanup(); process.exit(1); });
