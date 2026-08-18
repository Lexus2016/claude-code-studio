// Integration test — needs a real tmux. Skips cleanly when tmux is unavailable.
// Not part of `npm test`: it depends on tmux and takes ~8 s.
// Run: node test/terminal-bridge.integration.test.js
const assert = require('assert');
const bridge = require('../terminal-bridge');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  if (!bridge.tmuxAvailable()) {
    console.log('SKIP tmux-dependent checks — tmux not available on this host');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const name = 'ccsterm-itest';
  bridge.killSession(name);

  check('cold start reports cold', bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'while true; do echo tick; sleep 1; done'` }), 'cold');
  await sleep(1500);
  let info = bridge.sessionInfo(name);
  check('session exists after cold start', info.exists, true);
  check('nobody attached yet', info.attached, 0);
  check('pane alive', info.paneDead, false);
  check('listed under the terminal prefix', bridge.listTerminalSessions().includes(name), true);

  // Attaching must deliver the program's output as bytes.
  let got = Buffer.alloc(0);
  const h = bridge.attach({ name, cols: 80, rows: 24, onData: d => { got = Buffer.concat([got, d]); }, onExit: () => {} });
  await sleep(2000);
  check('attach streams output', got.toString('utf8').includes('tick'), true);
  check('attach registers a client', bridge.sessionInfo(name).attached, 1);

  // Input must reach the program, including control bytes.
  h.write('# marker-in\r');
  await sleep(1200);
  check('input reaches the pane', bridge.captureScreen(name).toString('utf8').includes('marker-in'), true);

  // Resize must actually change the window, without SIGWINCH.
  h.resize(100, 30);
  await sleep(600);
  check('resize applies', require('child_process').spawnSync('tmux', ['display-message', '-p', '-t', name, '#{window_width}x#{window_height}'], { encoding: 'utf8' }).stdout.trim(), '100x30');

  // Closing the browser tab must not kill the agent.
  h.close();
  await sleep(1000);
  info = bridge.sessionInfo(name);
  check('closing the client leaves the session alive', info.exists, true);
  check('client count drops to zero', info.attached, 0);

  // The busy signal the reaper relies on.
  const a = bridge.paneHash(name); await sleep(3000); const b = bridge.paneHash(name);
  check('producing output changes the pane hash', a !== b, true);

  // Scrollback capture is what makes reaping non-destructive for the user.
  const sbFile = '/tmp/ccsterm-itest-scrollback.txt';
  check('scrollback is captured', bridge.saveScrollback(name, sbFile), true);
  check('captured scrollback has content', require('fs').readFileSync(sbFile, 'utf8').includes('tick'), true);
  try { require('fs').unlinkSync(sbFile); } catch {}

  bridge.killSession(name);
  check('killSession removes it', bridge.sessionInfo(name).exists, false);

  // A session whose command exits must leave a DEAD pane, not vanish — that is the
  // 'respawn' restore path, and it is what preserves the scrollback of a crashed agent.
  bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'echo bye; sleep 1'` });
  await sleep(2500);
  info = bridge.sessionInfo(name);
  check('exited agent leaves the session alive', info.exists, true);
  check('exited agent leaves a dead pane', info.paneDead, true);
  check('respawn revives it', bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'echo REVIVED; sleep 5'` }), 'respawn');
  await sleep(1000);
  check('revived pane is alive again', bridge.sessionInfo(name).paneDead, false);

  bridge.killSession(name);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
