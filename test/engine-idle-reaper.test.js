// GitHub #141 — "Opt-in reaper for idle subscription-engine tmux sessions".
//
// A subscription chat keeps its `ccs-<id>` tmux pane (and every MCP server that pane
// spawned) alive after the turn ends, so a host accumulates ~1.2 GB per chat opened
// since the last restart. The answer is an opt-in reaper: CCS_ENGINE_IDLE_KILL_MS
// unset means today's behaviour, and when set a pane with no turn and no attached
// viewer for that long is killed; the next message respawns it with `--resume`.
//
// The decision table below is driven through the injected seams, so it runs with or
// without tmux. The last block drives a REAL tmux pane and self-skips when tmux is
// absent (same rule as the other tmux suites: name only sessions this file created,
// never `kill-server`, never a prefix lookup on the shared socket).
//
// Run: node test/engine-idle-reaper.test.js
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const interactive = require('../claude-interactive');
const { TMUX_SOCKET } = require('../terminal-bridge');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} \u2014 expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = false;
    try { v = predicate(); } catch { v = false; }
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await sleep(intervalMs);
  }
}

const IDLE = 60000;
const NOW = 1000000000000;

// One fake pane per test. `id` defaults to the name minus the ccs- prefix, exactly
// what engineSessionId() falls back to for a pane spawned before CCS_SESSION existed.
function makeWorld(sessions) {
  const byName = new Map(sessions.map(s => [s.name, s]));
  const killed = [];
  const touched = [];
  const idOf = (name) => (byName.get(name).id || name.replace(/^ccs-/, ''));
  const reap = (over = {}) => interactive.reapIdleEngineSessions({
    idleMs: IDLE,
    now: NOW,
    list: () => sessions.map(s => s.name),
    sessionIdOf: idOf,
    isLive: (id) => sessions.some(s => idOf(s.name) === id && !!s.live),
    clientsOf: (name) => byName.get(name).clients || 0,
    paneOf: (name) => byName.get(name).pane || '',
    lastTurnOf: (name) => byName.get(name).last,
    kill: (id) => killed.push(id),
    touch: (name) => touched.push(name),
    ...over,
  });
  return { reap, killed, touched };
}

console.log('opt-in switch:');
{
  const w = makeWorld([{ name: 'ccs-a', last: NOW - IDLE * 10 }]);
  check('unset (0) reaps nothing', w.reap({ idleMs: 0 }), []);
  check('unset (0) kills nothing', w.killed, []);
  check('unset (0) does not even touch', w.touched, []);
  check('a negative window also disables', w.reap({ idleMs: -5 }), []);
  check('startEngineIdleReaper is null when disabled', interactive.startEngineIdleReaper({ idleMs: 0 }), null);
}

console.log('\nthe decision table:');
{
  const w = makeWorld([{ name: 'ccs-old', last: NOW - IDLE - 1 }]);
  check('past the window is killed', w.reap(), ['old']);
  check('and the kill is by local session id', w.killed, ['old']);
}
{
  const w = makeWorld([{ name: 'ccs-edge', last: NOW - IDLE }]);
  check('exactly at the window is killed', w.reap(), ['edge']);
}
{
  const w = makeWorld([{ name: 'ccs-fresh', last: NOW - IDLE + 1 }]);
  check('inside the window survives', w.reap(), []);
}
{
  const w = makeWorld([{ name: 'ccs-live', last: NOW - IDLE * 20, live: true }]);
  check('a running turn survives however old the clock', w.reap(), []);
  check('a running turn refreshes the clock', w.touched, ['ccs-live']);
}
{
  const w = makeWorld([{ name: 'ccs-watched', last: NOW - IDLE * 20, clients: 1 }]);
  check('an attached viewer survives', w.reap(), []);
  check('an attached viewer refreshes the clock', w.touched, ['ccs-watched']);
}
{
  const w = makeWorld([{ name: 'ccs-prompt', last: NOW - IDLE * 20, pane: '> 1. Yes\n  2. No' }]);
  check('a pending prompt survives (#20)', w.reap(), []);
  check('a pending prompt refreshes the clock', w.touched, ['ccs-prompt']);
}
{
  const w = makeWorld([{ name: 'ccs-busy', last: NOW - IDLE * 20, pane: '(8s \u00b7 esc to interrupt)' }]);
  check('a spinner still animating survives', w.reap(), []);
}
{
  const w = makeWorld([{ name: 'ccs-mystery', last: null }]);
  check('a pane of unknown age is not killed', w.reap(), []);
  check('its clock is started instead', w.touched, ['ccs-mystery']);
}
{
  const w = makeWorld([{ name: 'ccs-skew', last: NOW + 30000 }]);
  check('a clock from the future is not trusted', w.reap(), []);
}
{
  const w = makeWorld([
    { name: 'ccs-a', last: NOW - IDLE * 3 },
    { name: 'ccs-b', last: NOW - 1000 },
    { name: 'terminal-7', last: 0 },
  ]);
  check('mixed set: only the idle engine pane is reaped', w.reap(), ['a']);
  check('a non-engine session on the socket is never killed', w.killed.includes('terminal-7'), false);
}
{
  const w = makeWorld([{ name: 'ccs-x', last: NOW - IDLE * 2, id: 'real\u2014id\u2014with\u2014unicode' }]);
  check('kills by CCS_SESSION, not by the sanitized name', w.reap(), ['real\u2014id\u2014with\u2014unicode']);
}

console.log('\nthe timer:');
{
  const timer = interactive.startEngineIdleReaper({
    idleMs: 5000, tickMs: 50, isLive: () => false,
    list: () => [], log: { info: () => {}, error: () => {} },
  });
  check('a timer exists once enabled', !!timer && typeof timer.ref === 'function', true);
  try { clearInterval(timer); } catch {}
  const off = interactive.startEngineIdleReaper({ idleMs: 0, tickMs: 10, list: () => [], log: { info() {}, error() {} } });
  check('no timer when disabled', off, null);
}

(async () => {
  console.log('\nreal tmux (skipped when tmux is not installed):');
  if (!interactive.tmuxAvailable()) {
    console.log('  skip tmux is not installed here');
  } else {
    const rawTmux = (...args) => spawnSync('tmux', ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8' });
    const mine = [];
    const makePane = (name, lastTurn) => {
      rawTmux('new-session', '-d', '-s', name, '-x', '120', '-y', '30', '-c', '/tmp', `sh -c 'echo IDLE-PANE; cat'`);
      rawTmux('set-environment', '-t', name, 'CCS_SESSION', name.replace(/^ccs-/, ''));
      if (lastTurn !== null) rawTmux('set-environment', '-t', name, 'CCS_LAST_TURN', String(lastTurn));
      mine.push(name);
    };
    const has = (name) => rawTmux('has-session', '-t', name).status === 0;
    let client = null;
    try {
      const stale = `ccs-reaper-stale-${process.pid}`;
      const fresh = `ccs-reaper-fresh-${process.pid}`;
      makePane(stale, Date.now() - IDLE * 5);
      makePane(fresh, Date.now());
      check('both test panes are up', [has(stale), has(fresh)], [true, true]);

      // Only this file's panes: the real list would include a developer's live chats.
      const killed = interactive.reapIdleEngineSessions({ idleMs: IDLE, list: () => [stale, fresh] });
      check('reaper kills the stale pane', killed, [stale.replace(/^ccs-/, '')]);
      check('stale pane is gone', has(stale), false);
      check('fresh pane is untouched', has(fresh), true);

      // The viewer rule against a real tmux client: engineSessionClients() reads the
      // client's `#{client_session}`, and this proves the format and the comparison
      // actually line up — a typo here would silently reap a watched pane.
      client = spawn('tmux', ['-L', TMUX_SOCKET, '-C', 'attach-session', '-t', fresh], { stdio: ['pipe', 'pipe', 'pipe'] });
      client.stdin.on('error', () => {});
      const attached = await waitFor(() => interactive.engineSessionClients(fresh) > 0);
      check('the control client counts as an attached viewer', attached, true);
      rawTmux('set-environment', '-t', fresh, 'CCS_LAST_TURN', String(Date.now() - IDLE * 5));
      const kept = interactive.reapIdleEngineSessions({ idleMs: IDLE, list: () => [fresh] });
      check('an attached viewer keeps the pane alive', kept, []);
      check('pane still up', has(fresh), true);
    } catch (e) {
      check('tmux block ran without throwing', String((e && e.message) || e), '');
    } finally {
      if (client) { try { client.kill(); } catch {} }
      for (const n of mine) { try { rawTmux('kill-session', '-t', n); } catch {} }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
