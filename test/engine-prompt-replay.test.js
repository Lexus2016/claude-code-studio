// GitHub #130 end to end: a page RELOADED while a subscription turn waits on a TUI
// prompt must be told about the prompt again.
//
// Boots a real server against a throwaway APP_DIR/HOME whose `claude` is a fake that
// draws the real trust screen (test/fixtures/claude-tui/firstrun-trust.txt) and then
// swallows input — so the subscription engine announces `input_needed` (phase
// startup) and waits CLAUDE_STARTUP_PROMPT_WAIT_MS on it. Three subscribers arrive
// while it waits and one after the turn ended:
//   - a foreground subscribe (what a reloaded page sends)  → gets the prompt replayed;
//   - a noCatchUp subscribe (a background tab)             → does NOT;
//   - a foreground subscribe after the turn ended          → does NOT (no stale prompt).
// The positive case is what fails without the fix; the two negatives keep it from
// passing because something replays everything.
//
// Self-skips without tmux. Names only the tmux session it created and kills only that
// one — the studio's socket is shared with any live studio on this machine.
//
// Run: node test/engine-prompt-replay.test.js   (TEST_PORT=<n> to move off the default port)
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { TMUX_SOCKET } = require('../terminal-bridge');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (spawnSync('tmux', ['-V']).status !== 0) {
  console.log('SKIP engine-prompt-replay: tmux not available');
  process.exit(0);
}

const PORT = Number(process.env.TEST_PORT || 3986);
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT_MS = 12000;   // how long the engine waits on the screen before giving up
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-replay-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-replay-home-'));
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

const screen = path.join(HOME_DIR, 'screen.txt');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'claude-tui', 'firstrun-trust.txt'), screen);
const binDir = path.join(HOME_DIR, '.local', 'bin');
fs.mkdirSync(binDir, { recursive: true });
// `-p` runs (title generation, classifiers) exit at once; the interactive pane draws
// the screen and then swallows whatever is typed, like a TUI waiting for an answer.
fs.writeFileSync(path.join(binDir, 'claude'),
  `#!/bin/sh\ncase " $* " in *" -p "*|*" --print "*) exit 0 ;; esac\ncat '${screen}'\nstty raw -echo 2>/dev/null\nexec cat > /dev/null\n`, { mode: 0o755 });

let srv = null, srvExited = false, srvLog = '';
let sid = null;
const sockets = [];
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return; cleanedUp = true;
  for (const s of sockets) { try { s.terminate(); } catch {} }
  if (sid) { try { spawnSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', 'ccs-' + String(sid).replace(/[^a-zA-Z0-9_-]/g, '_')]); } catch {} }
  if (srv && !srvExited) { try { srv.kill('SIGTERM'); } catch {} }
  for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws._frames = [];
  sockets.push(ws);
  ws.on('message', raw => { try { ws._frames.push(JSON.parse(raw)); } catch {} });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
}
async function waitFor(pred, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await pred()) return true; await sleep(100); }
  return false;
}
const prompts = ws => ws._frames.filter(f => f.type === 'input_needed');

(async () => {
  const busy = await new Promise(r => { const p = net.createServer(); p.once('error', e => r(e.code)); p.once('listening', () => p.close(() => r(null))); p.listen(PORT, '127.0.0.1'); });
  if (busy) die(`port ${PORT} is in use (${busy}); re-run with TEST_PORT=<free port>`);

  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR: APP_DIR, HOME: HOME_DIR,
      CLAUDE_STARTUP_PROMPT_WAIT_MS: String(WAIT_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.on('exit', () => { srvExited = true; });
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  if (!await waitFor(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; } }, 20000)) die('server never came up');

  const created = await (await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'replay', workdir: APP_DIR }) })).json();
  sid = created && created.id;
  if (!sid) die('no session created: ' + JSON.stringify(created));

  const owner = await openWs();
  owner.send(JSON.stringify({ type: 'chat', text: 'hi', tabId: sid, sessionId: sid, model: 'sonnet', mode: 'auto', engine: 'subscription' }));
  if (!await waitFor(() => prompts(owner).length > 0, WAIT_MS)) die('the engine never announced the prompt; frames: ' + JSON.stringify(owner._frames.map(f => f.type)));
  check('the turn announced its prompt to the socket that started it', prompts(owner)[0].phase, 'startup');

  console.log('\n── while the turn waits on the prompt');
  const reloaded = await openWs();
  reloaded.send(JSON.stringify({ type: 'subscribe_session', sessionId: sid }));
  await waitFor(() => prompts(reloaded).length > 0, 3000);
  const got = prompts(reloaded)[0] || null;
  check('a reloaded page is told about the open prompt', !!got, true);
  check('...addressed to the chat’s tab, carrying the prompt text',
    got && [got.tabId, got.sessionId, /trust/i.test(got.prompt || '')], [sid, sid, true]);

  const background = await openWs();
  background.send(JSON.stringify({ type: 'subscribe_session', sessionId: sid, noCatchUp: true }));
  await sleep(1500);
  check('a background (noCatchUp) subscriber is not re-notified', prompts(background).length, 0);

  console.log('\n── after the turn ended');
  // The foreground subscribe took the turn's stream over (proxy.attach — the user
  // switched to this tab), so the end of the turn arrives on `reloaded`, not `owner`.
  if (!await waitFor(() => reloaded._frames.some(f => f.type === 'done'), WAIT_MS + 15000)) die('the turn never ended; frames: ' + JSON.stringify(reloaded._frames.map(f => f.type)));
  check('the engine withdrew the prompt when the turn ended', reloaded._frames.some(f => f.type === 'input_resolved'), true);
  const late = await openWs();
  late.send(JSON.stringify({ type: 'subscribe_session', sessionId: sid }));
  await sleep(1500);
  check('a page opened after the turn ended is not shown a stale prompt', prompts(late).length, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => die(String(e && e.stack || e)));
