// GitHub #20 — "Terminal Access For Prompt Interactions".
//
// The complaint: a Claude CLI turn stops on an interactive prompt (a permission
// question, a plan approval, AskUserQuestion) and the web UI has no way to answer,
// so the session hangs. The answer this suite guards has three parts:
//
//   1. DETECT   claude-interactive.paneAwaitingInput() — is the TUI pane showing a
//               blocking select widget? (pure, unit-tested below)
//   2. SURFACE  the engine emits `input_needed` / `input_resolved` on the chat socket
//               (the pane-shape half of that decision is what part 1 covers)
//   3. ANSWER   /ws/terminal?view=engine attaches a read/WRITE viewer to the very
//               tmux pane the subscription engine is blocked in, so the prompt can be
//               answered from the browser without a second `claude --resume`.
//
// Synchronisation rule, inherited from terminal-bridge.integration.test.js: NEVER
// sleep a fixed amount to "let tmux catch up". Every wait polls the real state it
// depends on (waitFor), so a busy machine costs extra polls, not a failed assertion.
// The two quietFor() calls are the documented exception — they assert that something
// did NOT happen, and there is no state to poll for an absence.
//
// Starts its OWN server against a THROWAWAY data directory. CCS_DESKTOP is
// deliberately NOT set: this suite asserts the auth wall in front of the terminal
// surface, and CCS_DESKTOP bypasses it.
//
// Run: node test/engine-pane.test.js      (TEST_PORT=<n> to move off the default port)
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const bridge = require('../terminal-bridge');
const interactive = require('../claude-interactive');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = false;
    try { v = await predicate(); } catch { v = false; }
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await sleep(intervalMs);
  }
}
// Only for "this did NOT happen" assertions: the command whose effect we are denying
// has already been delivered and acknowledged, so this is the window in which its
// effect would land if the server had honoured it.
const quietFor = ms => sleep(ms);

// ── tmux helpers ─────────────────────────────────────────────────────────────
// EVERY tmux call carries -L <socket> explicitly. Never a bare `tmux`, never
// kill-server: this suite runs on the same private socket as the developer's live
// studio terminals, and only ever names sessions it created itself.
const rawTmux = (...args) => spawnSync('tmux', ['-L', bridge.TMUX_SOCKET, ...args], { encoding: 'utf8' });
const winSize = name => rawTmux('display-message', '-p', '-t', name, '#{window_width}x#{window_height}').stdout.trim();
const paneText = name => String(rawTmux('capture-pane', '-p', '-t', name).stdout || '');

// Stand-in for a subscription-engine session. Created exactly the way
// claude-interactive.js creates one — a raw `new-session -x 220 -y 50`, WITHOUT the
// `window-size manual` / `remain-on-exit` options ensureSession() applies to terminal
// sessions. That difference is the whole point: an engine pane arrives at the viewer
// on tmux's default `window-size latest` policy, so an attaching client can reflow a
// live Claude TUI unless the server pins it first.
function makeEnginePane(name) {
  rawTmux('kill-session', '-t', name);
  const r = rawTmux('new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', '/tmp',
    `sh -c 'echo PANE-UP; cat'`);
  return r.status === 0;
}

const CREATED = new Set();
function dropEnginePane(name) { rawTmux('kill-session', '-t', name); CREATED.delete(name); }

// ── server lifecycle ─────────────────────────────────────────────────────────
const PORT = Number(process.env.TEST_PORT || 3996);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-enginepane-'));
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
// Terminal sessions ship OFF (a browser terminal is remote code execution by design).
// The live pane rides the same switch, so the test has to turn it on the way a user
// would — and the "off" state is what makes the capability gate meaningful.
fs.writeFileSync(path.join(APP_DIR, 'config.json'),
  JSON.stringify({ terminal: { enabled: true, idleTimeoutMin: 30, maxLive: 3 } }));

let srv = null, srvExited = false, srvLog = '';
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.CCS_DESKTOP;   // it would switch the auth wall off — the thing under test
  delete env.APP_DIR;
  for (const k of ['CCS_INTERRUPT_URL', 'CCS_INTERRUPT_SESSION', 'CCS_INTERRUPT_SECRET']) delete env[k];
  return { ...env, ...extra };
}
function killServer() { if (srv && !srvExited) { try { srv.kill('SIGTERM'); } catch {} } }
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  killServer();
  // Only names this process created — never a lookup by prefix, never kill-server.
  for (const n of [...CREATED]) { try { rawTmux('kill-session', '-t', n); } catch {} }
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

function probePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', err => resolve(err.code || String(err)));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen(port, '127.0.0.1');
  });
}

let TOKEN = '';
async function api(method, url, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (TOKEN) headers['x-auth-token'] = TOKEN;
  const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json, raw: r };
}

// Every frame a terminal socket saw, split by kind: JSON control frames and raw
// terminal bytes arrive on the same socket.
function openTermWs(query, { withToken = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?${query}`,
    withToken ? { headers: { 'x-auth-token': TOKEN } } : {});
  ws._ctrl = [];
  ws._bytes = Buffer.alloc(0);
  ws._failed = null;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) { ws._bytes = Buffer.concat([ws._bytes, raw]); return; }
    try { ws._ctrl.push(JSON.parse(raw.toString('utf8'))); } catch {}
  });
  return new Promise(resolve => {
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req, res) => { ws._failed = res.statusCode; resolve(ws); });
    ws.on('error', e => { if (!ws._failed) ws._failed = e.message; resolve(ws); });
    setTimeout(() => resolve(ws), 10000);
  });
}
const ctrlOf = (ws, type) => ws._ctrl.find(m => m.type === type);

(async () => {
  // ═══ 1. Detection — pure, runs everywhere, no tmux needed ══════════════════
  console.log('paneAwaitingInput — is the TUI blocked on a prompt?');
  const permissionWidget = [
    '⏺ I will update the file now.',
    '',
    '╭──────────────────────────────────────────────╮',
    '│ Do you want to make this edit to server.js?   │',
    '│                                              │',
    '│ ❯ 1. Yes                                     │',
    '│   2. Yes, and don\'t ask again this session   │',
    '│   3. No, and tell Claude what to do instead   │',
    '╰──────────────────────────────────────────────╯',
  ].join('\n');
  check('a permission widget is a pending prompt', interactive.paneAwaitingInput(permissionWidget), true);
  check('an ASCII caret build is a pending prompt',
    interactive.paneAwaitingInput('> 1. Yes\n  2. No'), true);
  check('parenthesised options are a pending prompt',
    interactive.paneAwaitingInput('❯ 1) Proceed\n  2) Cancel'), true);
  // The caret is the whole distinction between a widget and prose. An agent that
  // answers "here are three options: 1. … 2. … 3. …" must not park the turn.
  check('a numbered list in prose is NOT a prompt',
    interactive.paneAwaitingInput('Options:\n1. rewrite it\n2. delete it\n3. leave it'), false);
  check('one option alone is NOT a prompt', interactive.paneAwaitingInput('❯ 1. Yes'), false);
  // Only the tail is examined: an ANSWERED widget scrolls up and must stop counting,
  // or every turn after the first prompt would be held open to the grace ceiling.
  check('a widget scrolled out of the tail is NOT a prompt',
    interactive.paneAwaitingInput(permissionWidget + '\n' + Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')),
    false);
  check('an empty pane is NOT a prompt', interactive.paneAwaitingInput(''), false);
  check('a null pane is NOT a prompt', interactive.paneAwaitingInput(null), false);

  console.log('promptExcerpt — what the banner shows:');
  check('excerpt keeps only the tail',
    interactive.promptExcerpt('a\nb\nc\nd', 2), 'c\nd');
  check('excerpt drops blank lines and trailing spaces',
    interactive.promptExcerpt('x   \n\n\ny', 5), 'x\ny');

  if (!bridge.tmuxAvailable()) {
    console.log('\nSKIP tmux-dependent checks — tmux not available on this host');
    console.log(`\n${pass} passed, ${fail} failed`);
    cleanup();
    process.exit(fail ? 1 : 0);
  }

  // ═══ 2. Bridge — attaching to a pane this module did not create ════════════
  console.log('\nterminal-bridge against an engine-owned pane:');
  const bench = 'ccs-enginebench';
  if (!makeEnginePane(bench)) die('could not create the bench tmux session');
  CREATED.add(bench);
  await waitFor(() => paneText(bench).includes('PANE-UP'));

  check('paneSize reports the engine geometry', bridge.paneSize(bench), { cols: 220, rows: 50 });

  // The viewer must not reflow a live TUI. resizeOnAttach:false is what carries that
  // here — drop it and the 220x50 pane snaps to the browser's 80x24 mid-turn (proven
  // by mutation). setWindowSizeManual() is the belt to that pair of braces: it also
  // stops a HUMAN running `tmux -L ccstudio attach -t ccs-<id>` from a shell (a real
  // tty DOES claim the window under the default `latest` policy) — that case needs a
  // pty to reproduce and is deliberately not simulated here, so treat the call as
  // uncovered defence-in-depth, not as something this assertion pins down.
  bridge.setWindowSizeManual(bench);
  const viewer = bridge.attach({ name: bench, cols: 80, rows: 24, resizeOnAttach: false, onData: () => {}, onExit: () => {} });
  await waitFor(() => bridge.sessionInfo(bench).attached === 1);
  await quietFor(600);
  check('a viewer attach leaves the engine geometry untouched', winSize(bench), '220x50');
  viewer.close();
  await waitFor(() => bridge.sessionInfo(bench).attached === 0);

  // Positive control: without the two guards the same attach DOES resize, so the
  // assertion above is not passing for the trivial reason that nothing ever resizes.
  rawTmux('set-option', '-t', bench, 'window-size', 'latest');
  const driver = bridge.attach({ name: bench, cols: 90, rows: 30, onData: () => {}, onExit: () => {} });
  await waitFor(() => winSize(bench) === '90x30');
  check('control: an ordinary attach still resizes the window', winSize(bench), '90x30');
  driver.close();
  await waitFor(() => bridge.sessionInfo(bench).attached === 0);

  // Socket unification. claude-interactive.js and terminal-bridge.js MUST be on the
  // same tmux server or the viewer can never see the engine's pane — and the failure
  // is silent: has-session answers "no" while the TUI is alive on the other socket.
  {
    const def = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    check('an engine session is NOT on the default tmux socket',
      String(def.stdout || '').split('\n').map(s => s.trim()).includes(bench), false);
    check('but the bridge sees it on the ccstudio socket', bridge.hasSession(bench), true);
  }
  // killInteractiveTmux() builds `ccs-<id>`; 'enginebench' is the id half of the
  // bench name. If that call lost its -L it would fire at the default socket and the
  // session would still be here.
  interactive.killInteractiveTmux('enginebench');
  check('killInteractiveTmux reaches the engine session on the ccstudio socket',
    await waitFor(() => !bridge.hasSession(bench), { timeoutMs: 8000 }), true);
  CREATED.delete(bench);

  // ═══ 3. Server — the browser-facing surface ════════════════════════════════
  console.log('\n/ws/terminal?view=engine:');
  const busy = await probePort(PORT);
  if (busy) die(`port ${PORT} is already in use (${busy}) — a foreign instance would make every assertion meaningless. Re-run with TEST_PORT=<free port>.`);

  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: childEnv({ PORT: String(PORT), APP_DIR, WORKDIR: APP_DIR, HOST: '127.0.0.1', LOG_LEVEL: 'error' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.on('exit', () => { srvExited = true; });
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });

  const up = await waitFor(async () => {
    if (srvExited) return false;
    try { const r = await fetch(BASE + '/api/auth/status'); const j = await r.json(); return j && j.setupDone === false; } catch { return false; }
  }, { timeoutMs: 30000, intervalMs: 250 });
  if (!up) die('our freshly-seeded server never came up');
  if (!fs.existsSync(path.join(APP_DIR, 'data', 'chats.db'))) die('the server never created its own chats.db in the temp APP_DIR');

  // Claim the account from loopback and keep the token. Everything below is
  // authenticated with it; the very first assertion proves the alternative is refused.
  {
    const r = await fetch(BASE + '/api/auth/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'engine-pane-test-pw', displayName: 'T' }),
    });
    TOKEN = ((r.headers.get('set-cookie') || '').match(/token=([^;]+)/) || [])[1] || '';
    if (!TOKEN) die('could not obtain an auth token from /api/auth/setup');
  }

  const created = await api('POST', '/api/sessions', { title: 'engine-pane', workdir: APP_DIR });
  const sid = created.json && created.json.id;
  check('chat session created', typeof sid, 'string');
  if (!sid) die('session was not created');
  const engName = interactive.tmuxName(sid);

  // A browser-reachable terminal is a privilege-escalation surface. The upgrade
  // handler validates the token BEFORE routing, so this path cannot grow an auth
  // story of its own — and this is the assertion that keeps it that way.
  {
    const anon = await openTermWs(`session=${encodeURIComponent(sid)}&view=engine&cols=80&rows=24`, { withToken: false });
    check('an unauthenticated engine-view socket is refused', anon._failed, 401);
    check('and it received no control frames', anon._ctrl.length, 0);
    try { anon.close(); } catch {}
  }

  // No pane yet: the branch must NOT create one. Creating a tmux session here would
  // spawn a second `claude` against this conversation — the one thing the design forbids.
  {
    const ws = await openTermWs(`session=${encodeURIComponent(sid)}&view=engine&cols=80&rows=24`);
    check('the socket opened', ws._failed, null);
    await waitFor(() => ws._ctrl.length > 0);
    check('a chat with no live pane is told so, not errored at', (ws._ctrl[0] || {}).type, 'no_pane');
    check('and no tmux session was conjured up for it', bridge.hasSession(engName), false);
    try { ws.close(); } catch {}
  }

  // Now the real thing: a live engine pane, viewed and DRIVEN from the browser.
  if (!makeEnginePane(engName)) die('could not create the engine pane for the session');
  CREATED.add(engName);
  await waitFor(() => paneText(engName).includes('PANE-UP'));

  const ws = await openTermWs(`session=${encodeURIComponent(sid)}&view=engine&cols=80&rows=24`);
  check('the engine-view socket opened', ws._failed, null);
  await waitFor(() => !!ctrlOf(ws, 'ready'));
  const ready = ctrlOf(ws, 'ready') || {};
  check('the server answers ready for the engine view', [ready.type, ready.view, ready.state], ['ready', 'engine', 'attach']);
  // The browser sizes itself TO the pane, never the pane to the browser — so `ready`
  // has to carry the pane's geometry and not the cols/rows the client asked with.
  check('ready reports the pane geometry, not the browser window', [ready.cols, ready.rows], [220, 50]);

  check('pane output streams to the browser',
    await waitFor(() => ws._bytes.toString('utf8').includes('PANE-UP')), true);

  // ── The heart of #20: an answer typed in the browser reaches the pane. ──────
  ws.send(JSON.stringify({ type: 'input', data: 'ANSWER-FROM-BROWSER\r' }));
  check('input typed in the browser reaches the engine pane',
    await waitFor(() => paneText(engName).includes('ANSWER-FROM-BROWSER')), true);

  // The pane belongs to the engine. A viewer must not be able to reflow a running
  // turn, nor destroy the conversation's TUI.
  ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'kill' }));
  await quietFor(800);
  check('a resize from the engine view is ignored', winSize(engName), '220x50');
  check('a kill from the engine view is ignored', bridge.hasSession(engName), true);

  // Closing the viewer detaches the control client only.
  try { ws.close(); } catch {}
  check('closing the viewer leaves the engine session alive',
    await waitFor(() => bridge.sessionInfo(engName).attached === 0 && bridge.hasSession(engName)), true);

  // The ordinary (driving) path must still refuse a chat session — that guard is what
  // stops two `claude --resume` processes writing one transcript, and view=engine
  // relaxes it only for an attach that spawns nothing.
  {
    const plain = await openTermWs(`session=${encodeURIComponent(sid)}&cols=80&rows=24`);
    await waitFor(() => plain._ctrl.length > 0);
    check('the ordinary terminal path still refuses a chat session',
      (plain._ctrl[0] || {}), { type: 'error', error: 'not a terminal session' });
    try { plain.close(); } catch {}
  }

  dropEnginePane(engName);
  console.log(`\n${pass} passed, ${fail} failed`);
  killServer();
  await waitFor(() => srvExited, { timeoutMs: 5000 });
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
