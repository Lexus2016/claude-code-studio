// Integration test for GET /api/tasks/running-sessions. Starts a real server against a
// THROWAWAY data directory, so it never touches the developer's chats.db.
//
// Regression guard: a plain web chat never writes a `tasks` row, so a DB-only query
// returned [] while a chat was mid-turn. subscribeAllTabs() feeds this endpoint into
// tab.generating, so background tabs silently lost their busy dot after a reload.
// The endpoint must union the DB with the in-memory live set (liveSessionIds(), i.e.
// activeChatSessions + activeTasks) — the same union isChatRunning reads.
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
  const created = await api('POST', '/api/sessions', { title: 'runsess', workdir: APP_DIR });
  const sid = created.json && created.json.id;
  check('session created', typeof sid, 'string');
  if (!sid) { console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

  const idle = await api('GET', '/api/tasks/running-sessions');
  check('idle session is not reported as running', (idle.json || []).includes(sid), false);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  }).catch(e => { console.error(e.message); cleanup(); process.exit(1); });
  ws.send(JSON.stringify({ type: 'chat', text: 'hi', tabId: sid, sessionId: sid, model: 'sonnet', mode: 'auto' }));

  // Wait for the turn to actually be in flight before asserting, rather than assuming a
  // fixed delay is enough on a loaded machine.
  let live = false;
  for (let i = 0; i < 40; i++) {
    const act = await api('GET', '/api/activity');
    if (((act.json && act.json.live) || []).some(x => x.session_id === sid)) { live = true; break; }
    await sleep(250);
  }
  check('chat turn is in flight (per /api/activity)', live, true);

  const running = await api('GET', '/api/tasks/running-sessions');
  check('in-flight plain chat IS reported by running-sessions', (running.json || []).includes(sid), true);
  // The DB is a fresh temp file with exactly one session and no task rows, so the
  // endpoint's whole output is knowable. Asserting the exact set also covers dedup —
  // unlike the old `length === new Set(...).size`, which a Set-building handler could
  // never fail. Every reported id must additionally resolve to a real session: the
  // client joins this list against its tabs, and a non-session string joins to nothing.
  check('running-sessions reports exactly the in-flight session', (running.json || []).slice().sort(), [sid]);
  const resolved = await Promise.all((running.json || []).map(id => api('GET', `/api/sessions/${id}`)));
  check('every reported id resolves to a real session', resolved.map(r => r.status), [200]);

  try { ws.close(); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  await cleanupGracefully();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
