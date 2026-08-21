// Integration test — needs a real tmux. Skips cleanly when tmux is unavailable.
// Run standalone: node test/terminal-pane-guard.integration.test.js
//
// Two bugs, one root cause: terminal-bridge treated `-t <session>` as "the terminal", but
// tmux resolves it to the ACTIVE PANE of the current window, and Claude Code's agent-teams
// splits whatever window it runs in (one pane per teammate).
//
//   1. doResize CLAMPED absurd geometry UP to 20x5 floors instead of rejecting it. A browser
//      measuring a hidden xterm proposes ~9x5 — getComputedStyle on a display:none element
//      returns the literal "100%" and parseInt("100%") === 100 — and that arrived here as a
//      real 20x5 window: the pane collapsed. Worse on a SPLIT window: resize-window moves
//      the whole window and tmux redistributes panes by its own rules going down AND coming
//      back up, so one shrink-and-grow cycle is permanent damage (measured: a 50/50 split
//      returned as 33/77 and no later resize undid it).
//   2. sessionInfo().paneDead read the ACTIVE pane, so a finished teammate pane made
//      resolveState() answer 'respawn' while the user's own `claude` was still running.
//      ensureSession then relaunched `claude --resume <same id>` on top of it, the agent
//      refused, the caller's self-heal read that fast exit as "nothing to resume" — and
//      killed the whole session. Two live working sessions were lost to exactly this.
//
// Both are only decidable against a real tmux, so this file drives the real bridge on the
// real `-L ccstudio` socket. It creates ONLY its own uniquely-named session, splits only
// that session, and kills it in a finally. Nothing here can reach a session it did not make.
//
// Synchronisation rule (inherited from terminal-bridge.integration.test.js): never sleep a
// fixed amount to "let tmux catch up" — poll the real state with a generous ceiling, so a
// busy machine costs extra polls rather than a failed assertion.
const assert = require('assert');
const { spawnSync } = require('child_process');
const bridge = require('../terminal-bridge');

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
// A resize that is correctly IGNORED produces no state change to poll for, so "nothing
// happened" needs a settling window. Every use below is preceded by a waitFor that proved
// the starting state, and is paired with a positive control proving a legal resize DOES
// land — so this can never turn a broken resize into a green test.
const settle = () => sleep(400);

// $TMUX must be stripped: when the runner itself lives inside a studio pane, a bare tmux
// inherits THAT socket and every command below would target the wrong server.
const ENV = { ...process.env }; delete ENV.TMUX;
const tmuxRaw = (...args) => spawnSync('tmux', ['-L', bridge.TMUX_SOCKET, ...args], { encoding: 'utf8', env: ENV });
const winSize = name => tmuxRaw('display-message', '-p', '-t', name, '#{window_width}x#{window_height}').stdout.trim();
const layout  = name => tmuxRaw('display-message', '-p', '-t', name, '#{window_layout}').stdout.trim();
const paneIds = name => tmuxRaw('list-panes', '-t', name, '-F', '#{pane_id}').stdout.split('\n').map(s => s.trim()).filter(Boolean);
const panePairs = name => tmuxRaw('list-panes', '-t', name, '-F', '#{pane_id} #{pane_dead}')
  .stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split(' '));
const deadFlags = name => tmuxRaw('list-panes', '-t', name, '-F', '#{pane_dead}').stdout.split('\n').map(s => s.trim()).filter(Boolean);
const screenHas = (name, s) => String(bridge.captureScreen(name) || '').includes(s);

(async () => {
  // ─── source-level, runs even without tmux ─────────────────────────────────
  // The thresholds themselves: a test that only drove tmux would go quiet the day someone
  // "restores" the floors, because 9x5 would then be clamped to something tmux accepts.
  const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'terminal-bridge.js'), 'utf8');
  console.log('the guards exist in source:');
  check('doResize REJECTS below 40x10 rather than clamping up',
    /if \(!Number\.isFinite\(cc\) \|\| !Number\.isFinite\(rr\) \|\| cc < 40 \|\| rr < 10\) return;/.test(SRC), true);
  check('the old 20x5 floors are gone', /Math\.max\(\s*20\s*,/.test(SRC) || /Math\.max\(\s*5\s*,/.test(SRC), false);
  check('a split window is refused before any resize-window runs',
    SRC.includes('if (paneCount(name) > 1) return;') &&
    SRC.indexOf('if (paneCount(name) > 1) return;') < SRC.indexOf("tmux(['resize-window'"), true);
  check('paneDead is computed from EVERY pane', /_paneStates\.every\(s => s === '1'\)/.test(SRC), true);
  check('...with a non-empty guard, so an unreadable list-panes is not "all dead"',
    /_paneStates\.length > 0 && _paneStates\.every/.test(SRC), true);

  if (!bridge.tmuxAvailable()) {
    console.log('SKIP tmux-dependent checks — tmux not available on this host');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  // paneCount fails SAFE: an unreadable session must read as "more than one", or the
  // layout-destroying resize comes straight back on any tmux hiccup.
  check('paneCount on a session that does not exist answers 2, not 1',
    bridge.paneCount(`ccsterm-noexist-${process.pid}`), 2);

  // Uniquely named, so a parallel run (or a real user session) can never collide.
  const name = `ccsterm-pguard-${process.pid}`;
  let h = null;
  try {
    bridge.killSession(name);
    check('cold start', bridge.ensureSession({ name, workdir: '/tmp',
      launchCommand: `sh -c 'while true; do echo tick; sleep 1; done'` }), 'cold');
    await waitFor(() => bridge.sessionInfo(name).exists && !bridge.sessionInfo(name).paneDead && screenHas(name, 'tick'));

    // ─── 1. absurd geometry is ignored, not clamped ─────────────────────────
    console.log('\nresize — implausible geometry is rejected, not floored:');
    h = bridge.attach({ name, cols: 100, rows: 30, onData: () => {}, onExit: () => {} });
    await waitFor(() => winSize(name) === '100x30');
    check('the attach sized the window', winSize(name), '100x30');

    // THE regression, verbatim: a hidden xterm proposes ~9x5. Old code made that a real
    // 20x5 window and the user came back to a collapsed terminal with reflowed scrollback.
    h.resize(9, 5);
    await settle();
    check('a hidden-xterm 9x5 proposal changes nothing', winSize(name), '100x30');
    // parseInt("100%") === 100 — the cols look plausible, the rows do not. Rejecting on
    // EITHER axis is what stops the half-garbage case.
    h.resize(100, 5);
    await settle();
    check('100x5 (the parseInt("100%") shape) changes nothing', winSize(name), '100x30');
    h.resize(20, 5);
    await settle();
    check('exactly the old 20x5 floor changes nothing', winSize(name), '100x30');
    h.resize('abc', 'def');
    await settle();
    check('non-numeric geometry changes nothing', winSize(name), '100x30');
    h.resize(39, 10);
    await settle();
    check('39x10 — one column under the limit — changes nothing', winSize(name), '100x30');
    h.resize(40, 9);
    await settle();
    check('40x9 — one row under the limit — changes nothing', winSize(name), '100x30');

    // Positive control. Without it every check above would still pass if resize were
    // broken outright, and this suite would be certifying a dead code path.
    h.resize(40, 10);
    await waitFor(() => winSize(name) === '40x10');
    check('40x10 — the smallest allowed geometry — IS applied', winSize(name), '40x10');
    h.resize(120, 40);
    await waitFor(() => winSize(name) === '120x40');
    check('an ordinary resize is applied', winSize(name), '120x40');

    // ─── 2. a split window is never resized ─────────────────────────────────
    console.log('\nresize — a window someone else split is left alone:');
    // Our OWN session, split by us. No -d: the new pane becomes ACTIVE, which is also what
    // section 3 needs (the old paneDead read the active pane).
    tmuxRaw('split-window', '-t', name, 'sh -c \'while true; do sleep 1; done\'');
    await waitFor(() => bridge.paneCount(name) === 2);
    check('the session now holds two panes', bridge.paneCount(name), 2);
    const sizeBefore = winSize(name), layoutBefore = layout(name);

    h.resize(200, 60);
    await settle();
    check('growing a split window is refused', winSize(name), sizeBefore);
    check('...and the pane layout is untouched', layout(name), layoutBefore);
    h.resize(60, 20);
    await settle();
    // The destructive direction: shrinking redistributes panes and coming back up does not
    // restore them. 50/50 came back 33/77 in the field.
    check('shrinking a split window is refused', winSize(name), sizeBefore);
    check('...and the pane layout is still untouched', layout(name), layoutBefore);

    // The real user path: opening a browser tab on a split session. attach() calls doResize
    // itself, so the guard has to hold there too, not only on later resize frames.
    const h2 = bridge.attach({ name, cols: 250, rows: 70, onData: () => {}, onExit: () => {} });
    await settle();
    check('attaching a new viewer to a split session does not resize it', winSize(name), sizeBefore);
    check('...nor reflow its layout', layout(name), layoutBefore);
    h2.close();

    // ─── 3. paneDead means EVERY pane is dead ───────────────────────────────
    console.log('\npaneDead — the agent is gone only when every pane is dead:');
    const panes = paneIds(name);
    check('two pane ids', panes.length, 2);
    // Kill the ACTIVE (second) pane's process by respawning it with a command that exits at
    // once. remain-on-exit is on for the window, so the pane stays as a DEAD pane — exactly
    // what a finished agent-teams teammate leaves behind.
    tmuxRaw('respawn-pane', '-k', '-t', panes[1], 'true');
    await waitFor(() => deadFlags(name).filter(f => f === '1').length === 1);
    check('one pane is dead', deadFlags(name).filter(f => f === '1').length, 1);
    check('...and it is the ACTIVE one (what `-t <session>` used to resolve to)',
      tmuxRaw('display-message', '-p', '-t', name, '#{pane_dead}').stdout.trim(), '1');
    // THE regression. Old code answered true here, resolveState() said 'respawn', and
    // ensureSession relaunched `claude --resume` on top of a session that was still working.
    check('sessionInfo says the session is NOT dead while a pane still lives',
      bridge.sessionInfo(name).paneDead, false);
    check('...and still reports the session as existing', bridge.sessionInfo(name).exists, true);

    // Now kill the surviving pane too: every pane dead is the one case that means "gone".
    tmuxRaw('respawn-pane', '-k', '-t', panes[0], 'true');
    await waitFor(() => bridge.sessionInfo(name).paneDead === true);
    check('with every pane dead, paneDead is true', bridge.sessionInfo(name).paneDead, true);
    check('the session itself survives, so the scrollback is still there',
      bridge.sessionInfo(name).exists, true);

    // A respawn revives it — the state machine still works end to end after the fix.
    check('respawn is what a fully dead session reports',
      bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'echo REVIVED; sleep 30'` }), 'respawn');
    await waitFor(() => !bridge.sessionInfo(name).paneDead && screenHas(name, 'REVIVED'));
    check('the revived session is alive again', bridge.sessionInfo(name).paneDead, false);
    // Worth recording, because it surprised me: `respawn` revives the ACTIVE pane only. The
    // dead teammate pane stays in the window, so the session is still split and still
    // resize-locked after a revive. That is the safe direction (it errs towards not touching
    // a layout someone else owns), but it means "revived" does not imply "resizable".
    check('a revived session is still split — respawn does not reap the other dead pane',
      bridge.paneCount(name), 2);
    check('...and it is therefore still refused a resize', (() => {
      const before = winSize(name); h.resize(150, 45); return before;
    })(), winSize(name));

    // Collapse back to one pane the way a user closing a teammate pane would, and the guard
    // lifts again — proving it is a condition on the live layout, not a permanent switch-off.
    for (const [id, dead] of panePairs(name)) if (dead === '1') tmuxRaw('kill-pane', '-t', id);
    await waitFor(() => bridge.paneCount(name) === 1 && !bridge.sessionInfo(name).paneDead);
    check('back to a single live pane', bridge.paneCount(name), 1);
    h.resize(90, 25);
    await waitFor(() => winSize(name) === '90x25');
    check('resize works again once the window is back to one pane', winSize(name), '90x25');
  } finally {
    try { if (h) h.close(); } catch {}
    // Only ever our own uniquely-named session.
    try { bridge.killSession(name); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
