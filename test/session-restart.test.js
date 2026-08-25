// "Restart Session" as a RECOVERY action — issue #67.
//
// The handler used to open with:
//     if (task && !task.abortController?.signal?.aborted)
//       → { type:'error', error:'Task is still running' }
// which made the button useless in the one situation it exists for. A remote turn whose
// SSH link dies leaves an activeTasks entry that nothing reaps — the 15s orphan sweeper
// skips any session that has one (`if (activeTasks.has(sid)) continue`) — so the chat
// refuses new messages AND refuses to be restarted, with no way out but a server
// restart. That is the reported "Restart Session does not recover the conversation".
//
// It now aborts the live turn, waits for the turn's own finally to release the session,
// reaps the entry if it never does, and drops the cross-connection lock with it.
//
// This drives the LOCAL cli engine — the handler is engine-agnostic, and a fake `claude`
// that just sleeps reproduces "a turn that will not end on its own" without needing a
// remote host. Boots a real server against a THROWAWAY data directory.
//
// Run: node test/session-restart.test.js   (TEST_PORT=<n> to move off the default port)
'use strict';
const assert = require('assert');
const fs = require('fs');
const net = require('net');
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

// 3992: unused elsewhere in test/. Sharing a port with another server-booting suite
// works only because npm test runs them serially — one that has not released the port
// yet fails this file's preflight instead of its own.
const PORT = Number(process.env.TEST_PORT || 3992);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-restart-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-restart-home-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// A fake `claude` that announces a session id, emits one line, then sleeps far longer
// than this test runs — i.e. a turn that will not end on its own. `--model haiku`
// (title generation) exits at once so it is never the turn under test.
const binDir = path.join(HOME_DIR, '.local', 'bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh
case " $* " in *" haiku "*) exit 0 ;; esac
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ccs-restart-fake"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"WEDGED"}]}}'
sleep 600
`);
fs.chmodSync(path.join(binDir, 'claude'), 0o755);

let srv = null, srvExited = false, srvLog = '';
function startServer() {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR: APP_DIR, HOME: HOME_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.on('exit', () => { srvExited = true; });
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
}
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (srv && !srvExited) { try { srv.kill('SIGTERM'); } catch {} }
  for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
// /api/activity derives `live` from activeTasks itself — the exact map that stayed
// populated forever and locked the chat.
async function activityLive() {
  const r = await api('GET', '/api/activity');
  return (r.json && Array.isArray(r.json.live)) ? r.json.live.map(x => x.session_id) : [];
}
function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws._frames = [];
  ws.on('message', raw => { try { ws._frames.push(JSON.parse(raw)); } catch {} });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
}
async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await sleep(150); }
  return false;
}
function probePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', err => resolve(err.code || String(err)));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen(port, '127.0.0.1');
  });
}

(async () => {
  // Without this the test's own server dies with EADDRINUSE and every assertion runs
  // against a foreign instance — creating sessions in a database this test did not make.
  const busy = await probePort(PORT);
  if (busy) die(`Port ${PORT} is already in use (${busy}). Re-run with TEST_PORT=<free port>.`);

  startServer();
  if (!await waitFor(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; } }, 20000)) {
    die('server never came up');
  }

  const created = await api('POST', '/api/sessions', { title: 'restart-test', workdir: APP_DIR });
  const sid = created.json && created.json.id;
  if (!sid) die('could not create a session');

  const ws = await openWs().catch(e => die(e.message));
  ws.send(JSON.stringify({ type: 'chat', text: 'hi', tabId: sid, sessionId: sid, model: 'sonnet', mode: 'auto' }));

  if (!await waitFor(async () => ws._frames.some(d => d.type === 'text' && String(d.text).includes('WEDGED')), 25000)) {
    die('the fake claude never streamed — the scenario would be vacuous');
  }
  if (!await waitFor(async () => (await activityLive()).includes(sid), 10000)) die('turn never became live');

  console.log('\n— a live turn is the reason to restart, not a reason to refuse —');
  check('the session is live in activeTasks before the restart', (await activityLive()).includes(sid), true);

  const before = ws._frames.length;
  ws.send(JSON.stringify({ type: 'restart_session', sessionId: sid }));

  const answered = await waitFor(async () =>
    ws._frames.slice(before).some(d => d.type === 'session_restart_done'), 20000);
  const newFrames = ws._frames.slice(before);
  check('the server answered session_restart_done', answered, true);
  check('it did NOT refuse with "Task is still running"',
    newFrames.some(d => d.type === 'error' && /Task is still running/.test(d.error || '')), false);

  console.log('\n— and the session is actually released —');
  const released = await waitFor(async () => !(await activityLive()).includes(sid), 20000);
  check('the session left activeTasks, so the chat accepts messages again', released, true);

  const sess = await api('GET', `/api/sessions/${sid}`);
  check('claude_session_id was cleared, so the next turn starts fresh',
    sess.json && (sess.json.claude_session_id || null), null);

  // The whole point of clearing it: shouldReplaySessionHistory in processChat is
  // `!!existSess && !localClaudeId`, so the next message replays this chat's history
  // into the fresh session rather than starting from nothing.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('a session with no claude id replays its history on the next turn',
    /shouldReplaySessionHistory\s*=\s*!!existSess\s*&&\s*!localClaudeId/.test(src), true);

  console.log('\n— a session that never had a turn still restarts —');
  {
    const idle = await api('POST', '/api/sessions', { title: 'idle-restart', workdir: APP_DIR });
    const isid = idle.json && idle.json.id;
    const n = ws._frames.length;
    ws.send(JSON.stringify({ type: 'restart_session', sessionId: isid }));
    const ok = await waitFor(async () => ws._frames.slice(n).some(d => d.type === 'session_restart_done'), 10000);
    check('session_restart_done on an idle session', ok, true);
  }

  console.log('\n— an unknown session is still refused —');
  {
    const n = ws._frames.length;
    ws.send(JSON.stringify({ type: 'restart_session', sessionId: 'no-such-session-id' }));
    const refused = await waitFor(async () =>
      ws._frames.slice(n).some(d => d.type === 'error' && /Session not found/.test(d.error || '')), 10000);
    check('unknown session id answers "Session not found"', refused, true);
  }

  try { ws.close(); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  if (srv && !srvExited) { try { srv.kill('SIGTERM'); } catch {} }
  for (let i = 0; i < 60 && !srvExited; i++) await sleep(50);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL', e && e.message); cleanup(); process.exit(1); });
