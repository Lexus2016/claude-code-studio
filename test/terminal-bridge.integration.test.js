// Integration test — needs a real tmux. Skips cleanly when tmux is unavailable.
// Run standalone: node test/terminal-bridge.integration.test.js
//
// Synchronisation rule for this file: NEVER sleep a fixed amount to "let tmux
// catch up". Every wait below polls the real tmux/bridge state it depends on
// (waitFor) with a generous ceiling, so a busy machine costs extra polls rather
// than a failed assertion. GitHub #39 / FIXES.md FIX-05: with fixed sleeps this
// file was green on an idle box and lost 5-8 assertions whenever subagents were
// running — a green CI that lies.
const assert = require('assert');
const bridge = require('../terminal-bridge');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll until the predicate is truthy, or the ceiling expires. The ceiling is a
// failure budget, not a delay: a satisfied condition returns immediately. On
// timeout it returns falsy and the caller's check() reports the real state, so a
// genuine regression still fails loudly instead of being papered over.
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

// For "exactly once" assertions only: the event we count has already been proven
// to have happened AND its second possible source is already gone, so this just
// gives a duplicate that is queued behind them a window to land in. Every call
// site pairs it with a waitFor that establishes those two facts first.
async function quietFor(ms, intervalMs = 50) {
  const until = Date.now() + ms;
  while (Date.now() < until) await sleep(intervalMs);
}

const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const winSize = name => require('child_process')
  .spawnSync('tmux', ['-L', bridge.TMUX_SOCKET, 'display-message', '-p', '-t', name, '#{window_width}x#{window_height}'], { encoding: 'utf8' })
  .stdout.trim();
const screenHas = (name, s) => String(bridge.captureScreen(name) || '').includes(s);

(async () => {
  // decodeOutputPayload is pure — check it even when tmux is missing.
  console.log('control-mode payload decoding:');
  check('plain text passes through', bridge.decodeOutputPayload('tick').toString('utf8'), 'tick');
  check('octal escapes become bytes', [...bridge.decodeOutputPayload('a\\015\\012')], [0x61, 0x0d, 0x0a]);
  check('escaped backslash is one byte', [...bridge.decodeOutputPayload('a\\\\b')], [0x61, 0x5c, 0x62]);
  check('ANSI escape survives', [...bridge.decodeOutputPayload('\\033[2J')], [0x1b, 0x5b, 0x32, 0x4a]);
  check('multi-byte UTF-8 round-trips',
    bridge.decodeOutputPayload([...Buffer.from('привіт', 'utf8')].map(b => '\\' + b.toString(8).padStart(3, '0')).join('')).toString('utf8'),
    'привіт');
  check('NUL byte decodes', [...bridge.decodeOutputPayload('\\000')], [0]);

  console.log('session-name safety:');
  for (const bad of ['ccsterm-a\nkill-server', 'ccsterm a', 'ccsterm-a;ls', '', null]) {
    let threw = false;
    try { bridge.attach({ name: bad, cols: 80, rows: 24, onData: () => {}, onExit: () => {} }); } catch { threw = true; }
    check(`attach rejects ${JSON.stringify(bad)}`, threw, true);
  }
  {
    let threw = false;
    try { bridge.ensureSession({ name: 'ccsterm-a\nkill-server', workdir: '/tmp', launchCommand: 'true' }); } catch { threw = true; }
    check('ensureSession rejects a newline in the name', threw, true);
  }

  if (!bridge.tmuxAvailable()) {
    console.log('SKIP tmux-dependent checks — tmux not available on this host');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const name = 'ccsterm-itest';
  bridge.killSession(name);

  check('cold start reports cold', bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'while true; do echo tick; sleep 1; done'` }), 'cold');

  // Socket isolation. Studio terminals must live on their own tmux server, so that a
  // `tmux kill-server` typed in any shell (or run by an agent before a test suite —
  // the failure this check exists for) cannot destroy a user's live session mid-work.
  // Asserted by absence from the DEFAULT socket; actually running kill-server here
  // would destroy the developer's own tmux sessions.
  {
    const def = require('child_process').spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    const onDefaultSocket = String(def.stdout || '').split('\n').map(s => s.trim()).includes(name);
    check('session is NOT on the default tmux socket', onDefaultSocket, false);
    check('but the bridge sees it on its own socket', bridge.sessionInfo(name).exists, true);
  }

  // A tmux failure must surface, not be reported as a successful cold start —
  // otherwise the caller attaches to a session that was never created, or to one
  // running in the wrong directory.
  {
    let threw = false;
    try { bridge.ensureSession({ name: 'ccsterm-nodir', workdir: '/no/such/dir/anywhere', launchCommand: 'true' }); } catch { threw = true; }
    check('missing workdir throws (tmux would silently use $HOME)', threw, true);
    bridge.killSession('ccsterm-nodir');
  }
  {
    let threw = false;
    try { bridge.ensureSession({ name: 'ccsterm-nobin', workdir: '/tmp', launchCommand: '/nonexistent/binary' }); } catch { threw = true; }
    check('agent that dies instantly throws (tmux still exits 0)', threw, true);
    bridge.killSession('ccsterm-nobin');
  }

  // Wait for what the four checks below actually need: a live session whose pane is
  // running and has already printed. `tick` in the pane is the earliest proof the
  // launch command is really executing, not merely spawned.
  await waitFor(() => {
    const i = bridge.sessionInfo(name);
    return i.exists && !i.paneDead && screenHas(name, 'tick');
  });
  let info = bridge.sessionInfo(name);
  check('session exists after cold start', info.exists, true);
  check('nobody attached yet', info.attached, 0);
  check('pane alive', info.paneDead, false);
  check('listed under the terminal prefix', bridge.listTerminalSessions().includes(name), true);

  // Attaching must deliver the program's output as bytes.
  let got = Buffer.alloc(0);
  const h = bridge.attach({ name, cols: 80, rows: 24, onData: d => { got = Buffer.concat([got, d]); }, onExit: () => {} });
  await waitFor(() => got.toString('utf8').includes('tick') && bridge.sessionInfo(name).attached === 1);
  check('attach streams output', got.toString('utf8').includes('tick'), true);
  check('attach registers a client', bridge.sessionInfo(name).attached, 1);

  // Input must reach the program, including control bytes.
  h.write('# marker-in\r');
  await waitFor(() => screenHas(name, 'marker-in'));
  check('input reaches the pane', bridge.captureScreen(name).toString('utf8').includes('marker-in'), true);

  // Multi-byte UTF-8 keystrokes/paste must reach the pane intact. send-keys -H only
  // accepts single-byte ASCII per key (per `man tmux`), so hex-encoding every byte of
  // a Cyrillic character and sending it as -H mangles it regardless of locale.
  h.write('# привіт-юнікод\r');
  await waitFor(() => screenHas(name, 'привіт-юнікод'));
  check('UTF-8 input reaches the pane intact', bridge.captureScreen(name).toString('utf8').includes('привіт-юнікод'), true);

  // Resize must actually change the window, without SIGWINCH.
  h.resize(100, 30);
  await waitFor(() => winSize(name) === '100x30');
  check('resize applies', winSize(name), '100x30');

  // Closing the browser tab must not kill the agent.
  h.close();
  await waitFor(() => !pidAlive(h.pid) && bridge.sessionInfo(name).attached === 0);
  info = bridge.sessionInfo(name);
  check('closing the client leaves the session alive', info.exists, true);
  check('client count drops to zero', info.attached, 0);

  // The busy signal the reaper relies on.
  const a = bridge.paneHash(name);
  let b = a;
  await waitFor(() => { b = bridge.paneHash(name); return b !== a; });
  check('producing output changes the pane hash', a !== b, true);

  // Scrollback capture is what makes reaping non-destructive for the user.
  const sbFile = '/tmp/ccsterm-itest-scrollback.txt';
  check('scrollback is captured', bridge.saveScrollback(name, sbFile), true);
  check('captured scrollback has content', require('fs').readFileSync(sbFile, 'utf8').includes('tick'), true);
  try { require('fs').unlinkSync(sbFile); } catch {}

  bridge.killSession(name);
  check('killSession removes it', bridge.sessionInfo(name).exists, false);

  // Killing a session while a client is attached reports twice — once as a tmux
  // notification and once as the client process exiting. onExit must be idempotent:
  // the WebSocket handler closes a socket in it.
  bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'while true; do echo x; sleep 1; done'` });
  await waitFor(() => {
    const i = bridge.sessionInfo(name);
    return i.exists && !i.paneDead && screenHas(name, 'x');
  });
  let exitCalls = 0;
  const h2 = bridge.attach({ name, cols: 80, rows: 24, onData: () => {}, onExit: () => { exitCalls++; } });
  // The client must be registered with tmux before the kill, or only one of the two
  // exit reports is produced and the idempotence guard is never exercised.
  await waitFor(() => bridge.sessionInfo(name).attached === 1);
  bridge.killSession(name);
  // Both report paths must have had their chance: the %exit notification (counted)
  // and the control-client process exiting (its pid is gone). Only then is a count
  // of 1 evidence of idempotence rather than of one path still being in flight.
  await waitFor(() => exitCalls >= 1);
  await waitFor(() => !pidAlive(h2.pid));
  await quietFor(500);
  check('onExit fires exactly once on kill-while-attached', exitCalls, 1);
  h2.close();

  // The agent process exiting under remain-on-exit sends NO tmux notification —
  // the pane just becomes dead. Without the pane_dead subscription the browser
  // would sit on a frozen frame forever, which is the exact case remain-on-exit
  // was introduced for.
  bridge.killSession(name);
  bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'echo alive; sleep 2'` });
  await waitFor(() => {
    const i = bridge.sessionInfo(name);
    return i.exists && !i.paneDead && screenHas(name, 'alive');
  });
  let deadExit = 0;
  const h3 = bridge.attach({ name, cols: 80, rows: 24, onData: () => {}, onExit: () => { deadExit++; } });
  await waitFor(() => deadExit >= 1 && bridge.sessionInfo(name).paneDead);
  // The control client is still alive here (the session was not killed), so the
  // only other way to reach onExit is a second subscription report — give it a
  // window before asserting "exactly once".
  await quietFor(500);
  check('agent death under remain-on-exit reaches onExit', deadExit, 1);
  check('the session itself is still alive (scrollback kept)', bridge.sessionInfo(name).exists, true);
  check('and its pane is marked dead', bridge.sessionInfo(name).paneDead, true);
  h3.close();

  // A session whose command exits must leave a DEAD pane, not vanish — that is the
  // 'respawn' restore path, and it is what preserves the scrollback of a crashed agent.
  bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'echo bye; sleep 1'` });
  // Two stages on purpose: the pane was ALREADY dead a moment ago, so polling
  // straight for paneDead could match the state the respawn was meant to clear.
  await waitFor(() => !bridge.sessionInfo(name).paneDead);
  await waitFor(() => bridge.sessionInfo(name).paneDead);
  info = bridge.sessionInfo(name);
  check('exited agent leaves the session alive', info.exists, true);
  check('exited agent leaves a dead pane', info.paneDead, true);
  check('respawn revives it', bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'echo REVIVED; sleep 5'` }), 'respawn');
  await waitFor(() => !bridge.sessionInfo(name).paneDead && screenHas(name, 'REVIVED'));
  check('revived pane is alive again', bridge.sessionInfo(name).paneDead, false);

  bridge.killSession(name);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
