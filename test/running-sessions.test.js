// Integration test for GET /api/tasks/running-sessions. Starts a real server against a
// THROWAWAY data directory, so it never touches the developer's chats.db.
//
// Regression guard: a plain web chat never writes a `tasks` row, so a DB-only query
// returned [] while a chat was mid-turn. subscribeAllTabs() feeds this endpoint into
// tab.generating, so background tabs silently lost their busy dot after a reload.
// The endpoint must union the DB with the in-memory live set (liveSessionIds(), i.e.
// activeChatSessions + activeTasks) — the same union isChatRunning reads.
//
// Each of the three union terms is asserted through a state that ONLY that term can
// produce, so removing any one of them fails at least one assertion:
//   DB                 — a `tasks` row in_progress with no in-memory run (kanban/scheduler)
//   activeChatSessions — the classification window, before activeTasks.set() (server.js:8239 vs 8516)
//   activeTasks        — a legacy (no tabId) chat; server.js:8239 only fills
//                        activeChatSessions when a tabId is present
//
// Run: node test/running-sessions.test.js   (TEST_PORT=<n> to move off the default port)
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
const PORT = Number(process.env.TEST_PORT || 3995);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-runsess-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-runsess-home-'));
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// A fake `claude` that just sleeps keeps the turn in flight deterministically and for
// free. findClaudeBin() probes $HOME/.local/bin/claude first and has no env override,
// so HOME is what we redirect. `exec` so the spawned pid IS the sleep — otherwise the
// kill lands on /bin/sh and leaves an orphaned sleep behind.
const binDir = path.join(HOME_DIR, '.local', 'bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexec sleep 60\n');
fs.chmodSync(path.join(binDir, 'claude'), 0o755);

// ─── Server lifecycle ────────────────────────────────────────────────────────
// Only ever signals the pid recorded at spawn time — never a pid looked up by name.
let srv = null, srvExited = false, srvLog = '';

function startServer() {
  // CCS_DESKTOP=1 bypasses auth and binds 127.0.0.1 only; APP_DIR redirects data/ to the temp dir.
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR: APP_DIR, HOME: HOME_DIR },
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
// which is how `kill <testpid>`, a cancelled CI job or a `timeout` wrapper used to leave
// an orphaned server holding the port — poisoning every later run.
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
async function activityLive() {
  const r = await api('GET', '/api/activity');
  return (r.json && Array.isArray(r.json.live)) ? r.json.live : [];
}
async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  return false;
}
async function newSession(title) {
  const created = await api('POST', '/api/sessions', { title, workdir: APP_DIR });
  return created.json && created.json.id;
}
function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
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

(async () => {
  // ── Preflight ──────────────────────────────────────────────────────────────
  // Without this the test's own server dies with EADDRINUSE (server.listen has no
  // 'error' handler) and every assertion below runs against the foreign instance —
  // creating sessions, and possibly billed turns, in a database this test did not
  // create. /api/health is public, so the readiness loop alone cannot tell them apart.
  const busy = await probePort(PORT);
  if (busy) {
    console.error(`\nFAIL running-sessions: port ${PORT} is already in use (${busy}).`);
    console.error(`  This test starts its OWN server on that port and asserts against it.`);
    console.error(`  Refusing to run: a foreign instance would make every assertion meaningless`);
    console.error(`  and would be handed sessions in a database this test did not create.`);
    console.error(`  Free port ${PORT}, or re-run with: TEST_PORT=<free port> node test/running-sessions.test.js`);
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

  console.log('running-sessions:');
  const sid = await newSession('runsess');
  check('session created', typeof sid, 'string');
  if (!sid) die('session was not created');

  check('idle session is not reported as running', (await runningSessions()).includes(sid), false);

  // ── Term 1: the DB query ───────────────────────────────────────────────────
  // A kanban/scheduler run is an in_progress `tasks` row with no in-memory entry.
  // Dropping the DB term breaks spinner restore for exactly this case.
  const dbSid = await newSession('runsess-db');
  const task = await api('POST', '/api/tasks', { title: 'runsess-db-task', status: 'in_progress', session_id: dbSid, workdir: APP_DIR });
  const taskId = task.json && task.json.id;
  check('task created in_progress', typeof taskId, 'string');
  check('DB in_progress task session IS reported (DB term)', (await runningSessions()).includes(dbSid), true);
  await api('DELETE', `/api/tasks/${taskId}`);
  check('session drops out once the task row is gone (DB term releases)',
    await waitFor(async () => !(await runningSessions()).includes(dbSid), 5000), true);

  // ── Term 2: activeChatSessions ─────────────────────────────────────────────
  // autoSkill classification runs BEFORE activeTasks.set(), so during it the session is
  // held by activeChatSessions alone — and /api/activity, which derives `live` from
  // activeTasks, still reports nothing. This is the exact window the term exists for.
  const classSid = await newSession('runsess-classify');
  const wsClass = await openWs().catch(e => die(e.message));
  wsClass.send(JSON.stringify({ type: 'chat', text: 'hi', tabId: classSid, sessionId: classSid, model: 'sonnet', mode: 'auto', autoSkill: true }));
  const reportedEarly = await waitFor(async () => (await runningSessions()).includes(classSid), 15000);
  check('classifying chat IS reported before /api/activity goes live (activeChatSessions term)', reportedEarly, true);
  check('…and /api/activity does not report it yet (so the gate is genuinely pre-activeTasks)',
    (await activityLive()).some(x => x.session_id === classSid), false);

  // ── Term 3: activeTasks ────────────────────────────────────────────────────
  // A legacy (no tabId) chat never enters activeChatSessions — server.js:8239 gates that
  // add on tabId — and writes no `tasks` row, so activeTasks is the only term left.
  const legacySid = await newSession('runsess-legacy');
  const wsLegacy = await openWs().catch(e => die(e.message));
  wsLegacy.send(JSON.stringify({ type: 'chat', text: 'hi', sessionId: legacySid, model: 'sonnet', mode: 'auto' }));
  const legacyLive = await waitFor(async () => (await activityLive()).some(x => x.session_id === legacySid), 20000);
  check('legacy chat turn is in flight (per /api/activity)', legacyLive, true);
  check('legacy (no-tab) chat IS reported (activeTasks term)', (await runningSessions()).includes(legacySid), true);

  // ── Ordinary tabbed chat, the case the endpoint was added for ──────────────
  const ws = await openWs().catch(e => die(e.message));
  ws.send(JSON.stringify({ type: 'chat', text: 'hi', tabId: sid, sessionId: sid, model: 'sonnet', mode: 'auto' }));

  // Wait for the turn to actually be in flight before asserting, rather than assuming a
  // fixed delay is enough on a loaded machine.
  const live = await waitFor(async () => (await activityLive()).some(x => x.session_id === sid), 20000);
  check('chat turn is in flight (per /api/activity)', live, true);
  check('in-flight plain chat IS reported by running-sessions', (await runningSessions()).includes(sid), true);

  const running = await api('GET', '/api/tasks/running-sessions');
  // classSid and legacySid are still mid-turn here and dbSid was released above, so the
  // whole expected set is knowable. Asserting it exactly also covers dedup and the
  // absence of stray ids — unlike the old `length === new Set(...).size`, which a
  // Set-building handler could never fail.
  check('running-sessions reports exactly the sessions that are live right now',
    (running.json || []).slice().sort(), [sid, classSid, legacySid].sort());
  const resolved = await Promise.all((running.json || []).map(id => api('GET', `/api/sessions/${id}`)));
  check('every reported id resolves to a real session', resolved.every(r => r.status === 200), true);

  // Real invariant in place of `arr.length === new Set(arr).size`, which the handler's own
  // Set made unfalsifiable: running-sessions must cover everything /api/activity calls
  // live. Terminal panes are excluded — they are a liveness source /api/activity has and
  // running-sessions deliberately does not.
  const runningNow = await runningSessions();
  const liveIds = [...new Set((await activityLive()).filter(x => x.kind !== 'terminal' && x.session_id).map(x => x.session_id))];
  check('running-sessions covers every session /api/activity reports live',
    liveIds.filter(id => !runningNow.includes(id)), []);
  check('running-sessions returns plain session ids', runningNow.every(id => typeof id === 'string' && id.length > 0), true);

  // ── Transition to NOT live ─────────────────────────────────────────────────
  // A term that never releases is as broken as one that never fires: the client turns a
  // background tab's busy dot ON from this endpoint and would spin forever.
  ws.send(JSON.stringify({ type: 'stop', tabId: sid }));
  check('tabbed session DISAPPEARS after the turn ends',
    await waitFor(async () => !(await runningSessions()).includes(sid), 15000), true);

  wsLegacy.send(JSON.stringify({ type: 'stop' }));
  check('legacy session DISAPPEARS after the turn ends (activeTasks releases)',
    await waitFor(async () => !(await runningSessions()).includes(legacySid), 15000), true);

  try { wsClass.send(JSON.stringify({ type: 'stop', tabId: classSid })); } catch {}
  for (const sock of [ws, wsLegacy, wsClass]) { try { sock.close(); } catch {} }

  console.log(`\n${pass} passed, ${fail} failed`);
  await cleanupGracefully();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
