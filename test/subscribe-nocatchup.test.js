// Integration test for `subscribe_session` with noCatchUp:true. Starts a real server
// against a THROWAWAY data directory, so it never touches the developer's chats.db.
//
// Regression guard for #38: both recovery actions of subscribe_session —
//   clearTimeout(activeTask.cleanupTimer)  and  activeTask.proxy.attach(ws)
// used to sit INSIDE the `if (!noCatchUp)` branch. public/index.html's
// subscribeAllTabs() re-subscribes every BACKGROUND tab with noCatchUp:true (it does
// not want the buffer replayed), so after a reconnect such a tab:
//   1. kept the cleanupTimer armed by ws.on('close') — TASK_DISCONNECT_TIMEOUT_MS later
//      the server aborted a turn the user's spinner still showed as live, and
//   2. never got its proxy re-attached, so nothing streamed to the new socket.
// `noCatchUp` is about replaying the buffer, not about whether this socket is a live
// watcher — hence the two statements now run for both branches.
//
// The three assertions that fail if they are moved back:
//   - "turn is STILL in activeTasks … (cleanupTimer was cleared)"
//   - "noCatchUp socket receives text emitted AFTER it re-subscribed (proxy attached)"
//   - "noCatchUp socket receives tool frames emitted AFTER it re-subscribed"
// The suppression itself is asserted too ("no catchUp:true replay"), with a positive
// control: the same reconnect WITHOUT noCatchUp must still get the catchUp frame,
// otherwise that assertion would pass for the trivial reason that nothing is ever sent.
//
// TASK_DISCONNECT_TIMEOUT_MS is set to 2s (default: 30 min) so the abort is observable
// in seconds instead of half an hour.
//
// Run: node test/subscribe-nocatchup.test.js   (TEST_PORT=<n> to move off the default port)
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

// Overridable: a hardcoded port makes the test assert against whatever else happens to
// be listening. The preflight below refuses to run at all when the port is taken.
const PORT = Number(process.env.TEST_PORT || 3993);
const BASE = `http://127.0.0.1:${PORT}`;
const DISCONNECT_MS = 2000;   // the whole point: seconds, not the 30-minute default
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-nocatchup-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-nocatchup-home-'));
// Every early process.exit() below (port already in use, server never came up,
// no auth cookie) jumps past the rmSync at the bottom of the file and leaves a
// directory behind in /tmp on each run. An exit hook covers all of them.
process.on('exit', () => { for (const _d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(_d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// A fake `claude` that streams stream-json in two halves: EARLY before the client
// disconnects, then a tool + text long after it reconnected. findClaudeBin() probes
// $HOME/.local/bin/claude first and has no env override, so HOME is what we redirect.
// `--model haiku` (classifier / title generation) exits immediately so it can never be
// mistaken for the turn under test.
const binDir = path.join(HOME_DIR, '.local', 'bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh
case " $* " in *" haiku "*) exit 0 ;; esac
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"ccs-nocatchup-fake"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"EARLY-TEXT"}]}}'
sleep 8
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo late"}}]}}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"LATE-TEXT"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","session_id":"ccs-nocatchup-fake"}'
exit 0
`);
fs.chmodSync(path.join(binDir, 'claude'), 0o755);

// ─── Server lifecycle ────────────────────────────────────────────────────────
// Only ever signals the pid recorded at spawn time — never a pid looked up by name.
let srv = null, srvExited = false, srvLog = '';

function startServer() {
  // CCS_DESKTOP=1 bypasses auth and binds 127.0.0.1 only; APP_DIR redirects data/ to the temp dir.
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR: APP_DIR, HOME: HOME_DIR,
      TASK_DISCONNECT_TIMEOUT_MS: String(DISCONNECT_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.on('exit', () => { srvExited = true; });
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
}

function killServer() { if (srv && !srvExited) { try { srv.kill('SIGTERM'); } catch {} } }
function removeTempDirs() {
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch {}
}

let cleanedUp = false;
function cleanup() { if (cleanedUp) return; cleanedUp = true; killServer(); removeTempDirs(); }

// 'exit' covers the normal and the thrown-assertion paths. It does NOT fire on a signal,
// which is how `kill <testpid>`, a cancelled CI job or a `timeout` wrapper would leave an
// orphaned server holding the port — poisoning every later run.
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(1); });
}

// Normal exit path: give the server a moment to finish db.pragma('optimize') + db.close()
// before the data directory is pulled out from under it.
async function cleanupGracefully() {
  if (cleanedUp) return;
  killServer();
  for (let i = 0; i < 60 && !srvExited; i++) await sleep(50);
  cleanup();
}

function die(msg) {
  console.error(msg);
  if (srvLog) console.error(srvLog.slice(-2000));
  cleanup();
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function runningSessions() {
  const r = await api('GET', '/api/tasks/running-sessions');
  return Array.isArray(r.json) ? r.json : [];
}
// /api/activity derives `live` from activeTasks — the exact map the disconnect timer
// deletes from. running-sessions unions activeChatSessions on top, which survives the
// abort for a while, so it cannot tell the timer firing from the turn simply running.
async function activityLive() {
  const r = await api('GET', '/api/activity');
  return (r.json && Array.isArray(r.json.live)) ? r.json.live.map(x => x.session_id) : [];
}
async function newSession(title) {
  const created = await api('POST', '/api/sessions', { title, workdir: APP_DIR });
  return created.json && created.json.id;
}
// Every frame a socket ever saw, so assertions can be written about what arrived
// AFTER a given moment (frames are timestamped on arrival).
function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws._frames = [];
  ws.on('message', raw => {
    try { const d = JSON.parse(raw); d._at = Date.now(); ws._frames.push(d); } catch {}
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
}
const framesSince = (ws, t, type) => ws._frames.filter(d => d._at >= t && (!type || d.type === type));
async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  return false;
}

// Preflight: resolves with null when the port is free, or with the error code otherwise.
function probePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', err => resolve(err.code || String(err)));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen(port, '127.0.0.1');
  });
}

// Drives one reconnect: run a turn on a fresh socket, wait for the first half of the
// stream, drop the socket, then re-subscribe from a NEW socket. Returns that socket and
// the moment it subscribed.
async function reconnectMidTurn(sid, subscribeMsg) {
  const owner = await openWs().catch(e => die(e.message));
  owner.send(JSON.stringify({ type: 'chat', text: 'hi', tabId: sid, sessionId: sid, model: 'sonnet', mode: 'auto' }));
  const started = await waitFor(async () =>
    owner._frames.some(d => d.type === 'text' && String(d.text).includes('EARLY-TEXT')), 25000);
  if (!started) die('fake claude never streamed the first half of the turn');
  // The turn must be registered in activeTasks, or ws.on('close') has nothing to arm the
  // cleanup timer on and the whole scenario is vacuous.
  if (!await waitFor(async () => (await runningSessions()).includes(sid), 10000)) die('turn never became live');

  const closed = new Promise(r => owner.on('close', r));
  owner.close();
  await closed;
  await sleep(200); // let the server's ws.on('close') arm the cleanup timer

  const reconnect = await openWs().catch(e => die(e.message));
  const at = Date.now();
  reconnect.send(JSON.stringify(subscribeMsg));
  return { reconnect, at };
}

(async () => {
  // ── Preflight ──────────────────────────────────────────────────────────────
  // Without this the test's own server dies with EADDRINUSE (server.listen has no
  // 'error' handler) and every assertion below runs against the foreign instance —
  // creating sessions, and possibly billed turns, in a database this test did not
  // create. /api/health is public, so the readiness loop alone cannot tell them apart.
  const busy = await probePort(PORT);
  if (busy) {
    console.error(`\nFAIL subscribe-nocatchup: port ${PORT} is already in use (${busy}).`);
    console.error(`  This test starts its OWN server on that port and asserts against it.`);
    console.error(`  Refusing to run: a foreign instance would make every assertion meaningless`);
    console.error(`  and would be handed sessions in a database this test did not create.`);
    console.error(`  Free port ${PORT}, or re-run with: TEST_PORT=<free port> node test/subscribe-nocatchup.test.js`);
    removeTempDirs();
    process.exit(1);
  }

  startServer();

  let up = false;
  for (let i = 0; i < 80; i++) {
    if (srvExited) break;
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (srvExited) die(`server exited before it became ready — port ${PORT} collision or startup crash`);
  if (!up) die('server did not start');

  // Identity check: the instance answering on BASE must be the child we spawned. The
  // banner is written from the listen() callback, so its absence means someone else
  // owns the port.
  const portBanner = new RegExp(`"port":\\s*"?${PORT}"?`);
  const ours = await waitFor(async () => srvLog.includes('server started') && portBanner.test(srvLog), 5000);
  if (!ours) die(`something on port ${PORT} answers /api/health but our server never logged "server started" — refusing to assert against a foreign instance`);
  if (!fs.existsSync(path.join(APP_DIR, 'data', 'chats.db'))) die('our server never created its own chats.db in the temp APP_DIR');

  // ── #38: background tab reconnects with noCatchUp:true mid-turn ────────────
  console.log('#38 background tab (noCatchUp:true) reconnecting mid-turn:');
  const sid = await newSession('nocatchup-bg');
  check('session created', typeof sid, 'string');
  if (!sid) die('session was not created');

  const { reconnect: bg, at: bgAt } = await reconnectMidTurn(sid,
    { type: 'subscribe_session', sessionId: sid, noCatchUp: true });

  // 1. cleanupTimer cleared. The timer was armed at disconnect for DISCONNECT_MS; if the
  //    subscribe did not clear it, it fires and does abort() + activeTasks.delete(), so
  //    the session drops out of /api/activity's live set. Sample well past the deadline.
  await sleep(DISCONNECT_MS + 1500);
  check(`turn is STILL in activeTasks ${DISCONNECT_MS + 1500}ms after the disconnect timer would have fired (cleanupTimer was cleared)`,
    (await activityLive()).includes(sid), true);

  // 2. proxy re-attached: the second half of the stream, produced only after the
  //    re-subscribe, has to reach the new socket.
  const gotLate = await waitFor(async () =>
    framesSince(bg, bgAt, 'text').some(d => String(d.text).includes('LATE-TEXT')), 20000);
  check('noCatchUp socket receives text emitted AFTER it re-subscribed (proxy attached)', gotLate, true);
  check('noCatchUp socket receives tool frames emitted AFTER it re-subscribed',
    framesSince(bg, bgAt, 'tool').some(d => d.tool === 'Bash'), true);
  check('noCatchUp socket receives the turn-ending done',
    await waitFor(async () => framesSince(bg, bgAt, 'done').length > 0, 15000), true);

  // 3. …but the buffer replay stays suppressed — that is all noCatchUp ever meant.
  check('noCatchUp socket got NO catchUp:true replay of chatBuffers',
    bg._frames.filter(d => d.catchUp === true).length, 0);
  // A background tab is not the tab the user is looking at: the "resumed" toast and the
  // interrupted-retry offer both belong to the foreground path.
  check('noCatchUp socket got no task_resumed / task_interrupted frames',
    bg._frames.filter(d => d.type === 'task_resumed' || d.type === 'task_interrupted').length, 0);
  check('the turn ended on its own, not by the disconnect abort',
    /task disconnect timeout, aborting/.test(srvLog), false);
  // Positive control for the line above. An absence assertion is worthless if the
  // string it looks for can never appear — a renamed or reworded log message would
  // make it pass forever. Pin the needle to the source that emits it.
  check('positive control: that log line is what server.js actually emits on the abort path',
    /log\.info\('task disconnect timeout, aborting'/.test(
      fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8')), true);
  // …and that the log the regex is tested against is a real, non-empty capture, not
  // an empty string that would make every /…/.test() below answer false.
  check('positive control: the captured server log is non-empty', srvLog.length > 0, true);
  try { bg.close(); } catch {}

  // ── Positive control: the same reconnect WITHOUT noCatchUp DOES replay ─────
  // Without this, "got NO catchUp:true replay" would also pass if the server had simply
  // stopped sending catch-up frames to anyone.
  console.log('\ncontrol — foreground reconnect (no noCatchUp) still replays the buffer:');
  const sidF = await newSession('nocatchup-fg');
  check('session created', typeof sidF, 'string');
  if (!sidF) die('session was not created');

  const { reconnect: fg, at: fgAt } = await reconnectMidTurn(sidF,
    { type: 'subscribe_session', sessionId: sidF });

  const gotCatchUp = await waitFor(async () =>
    framesSince(fg, fgAt, 'text').some(d => d.catchUp === true && String(d.text).includes('EARLY-TEXT')), 10000);
  check('foreground reconnect DOES get the catchUp:true replay', gotCatchUp, true);
  check('foreground reconnect gets task_resumed',
    fg._frames.some(d => d.type === 'task_resumed'), true);
  check('foreground reconnect also receives post-reconnect text (proxy attached)',
    await waitFor(async () =>
      framesSince(fg, fgAt, 'text').some(d => !d.catchUp && String(d.text).includes('LATE-TEXT')), 20000), true);

  fg.send(JSON.stringify({ type: 'stop', tabId: sidF }));
  check('session leaves running-sessions once the turn ends',
    await waitFor(async () => !(await runningSessions()).includes(sidF), 15000), true);
  try { fg.close(); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  await cleanupGracefully();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
