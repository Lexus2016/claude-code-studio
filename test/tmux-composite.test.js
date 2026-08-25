// tmux-composite.test.js — the split-window compositor.
//
// Two halves. The first is pure and always runs: frame geometry, the row diff, the
// pane the viewer treats as primary. The second needs a real tmux and skips cleanly
// without one; it exists because the two defects this module was written for are both
// invisible to a unit test — a viewer re-pinning itself onto a teammate after a
// reconnect, and pane CONTENT closing a control-mode command reply early.
//
// Run standalone: node test/tmux-composite.test.js
const assert = require('assert');
const comp = require('../tmux-composite');
const bridge = require('../terminal-bridge');
const { spawnSync } = require('node:child_process');

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
const T = (...a) => spawnSync('tmux', ['-L', bridge.TMUX_SOCKET, ...a], { encoding: 'utf8' });

// The layout measured on a live agent-teams session: window 155x39, the user's own
// claude squeezed to 46x38 on the left, teammates stacked down the right.
const LIVE = [
  '%0|0|1|46|38|1|0|0|MacBook-Pro-admin-3.local',
  '%58|47|1|108|9|0|1|0|correctness',
  '%60|47|11|108|9|0|2|0|otherpaths',
  '%61|47|21|108|9|0|3|0|consistency',
  '%59|47|31|108|8|0|4|0|tests',
];
const WIN = { cols: 155, rows: 39 };

(async () => {
  console.log('parsePaneList:');
  const panes = comp.parsePaneList(LIVE);
  check('every pane parses', panes.length, 5);
  check('geometry is numeric', [panes[1].left, panes[1].top, panes[1].cols, panes[1].rows], [47, 1, 108, 9]);
  check('the teammate name is the pane title', panes[1].title, 'correctness');
  // A title is user data — agent-teams names a teammate whatever the plan called it.
  check('a title containing the field separator survives',
    comp.parsePaneList(['%9|0|0|80|24|1|0|0|a|b|c'])[0].title, 'a|b|c');
  check('a short row is dropped, not parsed into NaN geometry',
    comp.parsePaneList(['%9|0|0']).length, 0);
  check('a row whose id is not a pane id is dropped',
    comp.parsePaneList(['nope|0|0|80|24|1|0|0|x']).length, 0);
  check('a zero-width pane is dropped', comp.parsePaneList(['%9|0|0|0|24|1|0|0|x']).length, 0);

  console.log('\nprimaryPane — the reconnect bug:');
  // tmux makes the NEWEST pane active, so a viewer that re-derived its pane from
  // "whichever is active" landed on the last teammate agent-teams spawned and the
  // user's own agent vanished from a terminal that had been showing it.
  const activeIsLast = comp.parsePaneList([
    '%0|0|1|46|38|0|0|0|main', '%58|47|1|108|38|1|1|0|correctness',
  ]);
  check('it is pane_index 0', comp.primaryPane(activeIsLast).id, '%0');
  check('...even though tmux calls the teammate active',
    activeIsLast.find(p => p.active).id, '%58');
  check('an empty layout has no primary', comp.primaryPane([]), null);

  console.log('\nbuildFrame — window coordinates:');
  const captures = new Map([
    ['%0', ['MAIN']], ['%58', ['C1']], ['%60', ['O1']], ['%61', ['K1']], ['%59', ['T1']],
  ]);
  const first = comp.buildFrame({ panes, win: WIN, captures, prev: new Map(), full: true });
  check('a full frame clears the screen first', first.data.startsWith('\x1b[H\x1b[2J'), true);
  // A pane's row 0 is NOT the window's row 0 — re-addressing it is the whole job.
  check('the left pane lands at its own origin', first.data.includes('\x1b[2;1HMAIN'), true);
  check('a right-hand pane lands at column 48', first.data.includes('\x1b[2;48HC1'), true);
  check('the third pane lands at row 12', first.data.includes('\x1b[12;48HO1'), true);
  check('every pane made it into the frame',
    ['MAIN', 'C1', 'O1', 'K1', 'T1'].every(s => first.data.includes(s)), true);
  check('pane borders are drawn — control mode carries none',
    first.data.includes('│') && first.data.includes('─'), true);
  check('teammate names come from the titles',
    ['correctness', 'otherpaths', 'consistency', 'tests'].every(s => first.data.includes(s)), true);

  console.log('\nbuildFrame — the row diff:');
  const same = comp.buildFrame({ panes, win: WIN, captures, prev: first.prev });
  check('an unchanged frame emits nothing but the cursor', same.data, '');
  const moved = new Map(captures); moved.set('%60', ['O2']);
  const one = comp.buildFrame({ panes, win: WIN, captures: moved, prev: first.prev });
  check('only the changed row is redrawn', one.data.includes('O2'), true);
  check('...and the untouched panes are not', one.data.includes('C1'), false);
  check('a pane absent from this frame keeps its remembered rows',
    comp.buildFrame({ panes, win: WIN, captures: new Map(), prev: first.prev }).prev.get('%58'),
    first.prev.get('%58'));
  // `capture-pane -N` does NOT pad to the pane width (measured on tmux 3.7c: a
  // 2-character row in a 60-column pane comes back padded to 15), and \x1b[K would
  // erase every pane to the right, so each row is blanked with its own width first.
  check('a redrawn row is blanked to the pane width first',
    one.data.includes('\x1b[12;48H\x1b[0m' + ' '.repeat(108)), true);

  console.log('\nbuildFrame — the cursor:');
  const cur = comp.buildFrame({ panes, win: WIN, captures, prev: new Map(), full: true,
    cursor: { pane: '%58', x: 3, y: 4, visible: true } });
  // A pane reports its cursor relative to itself; left as-is, a teammate's cursor at
  // 0,0 drags the caret out of the pane the user is typing into.
  check('it is placed in window coordinates', cur.data.endsWith('\x1b[6;51H\x1b[?25h'), true);
  const hidden = comp.buildFrame({ panes, win: WIN, captures, prev: new Map(), full: true,
    cursor: { pane: '%58', x: 0, y: 0, visible: false } });
  check('a hidden cursor stays hidden', hidden.data.endsWith('\x1b[?25l'), true);

  console.log('\nborders — junctions:');
  const two = comp.parsePaneList(['%1|0|1|39|19|1|0|0|main', '%2|40|1|60|9|0|1|0|top', '%3|40|11|60|9|0|2|0|bot']);
  const b = comp.borders(two, { cols: 100, rows: 20 });
  // Without these the seam has a one-cell hole wherever a horizontal border meets the
  // vertical one, which reads as a broken frame rather than as a split.
  check('a vertical run starting below the seam gets ┬', b.includes('\x1b[1;40H\x1b[38;5;240m┬'), true);
  check('a vertical run continuing through it gets ├', b.includes('\x1b[11;40H\x1b[38;5;240m├'), true);

  if (!bridge.tmuxAvailable()) {
    console.log('\n(tmux not available — skipping the live half)');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  console.log('\nlive tmux — a reconnect into an already-split window:');
  {
    const name = 'ccsterm-comp' + Math.random().toString(36).slice(2, 8);
    bridge.ensureSession({ name, workdir: '/tmp',
      launchCommand: `sh -c 'while :; do echo MAIN-AGENT; sleep 0.3; done'` });
    T('split-window', '-h', '-t', name, `sh -c 'while :; do echo TEAMMATE; sleep 0.3; done'`);
    await waitFor(() => bridge.paneCount(name) > 1);
    check('tmux made the teammate the active pane', bridge.paneActiveId(name) !== bridge.paneLayout(name)[0].id, true);

    // This is the reconnect: a fresh attach onto a window that was split before the
    // viewer existed. Every socket drop takes this path — a server restart, an idle
    // proxy timeout, a laptop waking up.
    let seen = '';
    const geo = [];
    const h = bridge.attach({ name, cols: 120, rows: 40,
      onData: b => { seen += b.toString('utf8'); }, onGeometry: g => geo.push(g), onExit: () => {} });
    const got = await waitFor(() => seen.includes('MAIN-AGENT') && seen.includes('TEAMMATE'));
    check('the user\'s own agent is on screen', seen.includes('MAIN-AGENT'), true);
    check('...and so is the teammate', seen.includes('TEAMMATE'), true);
    // The window keeps the size it already had — a split window is never resized from
    // the browser — so what the viewer must be told is that size, not the half-width of
    // whichever pane it happens to be pinned to. The browser resizes its xterm to this.
    const winNow = bridge.paneSize(name);
    check('the geometry announced is the window', geo.length > 0 && geo[0].cols, winNow.cols);
    check('...which is wider than the pane it used to report',
      geo.length > 0 && geo[0].cols > bridge.paneLayout(name)[0].cols, true);
    check('...and it says the frame is composited', geo.length > 0 && geo[0].composited, true);
    void got;
    h.close();
    bridge.killSession(name);
  }

  console.log('\nlive tmux — pane content cannot truncate a command reply:');
  {
    // `%end 1 2 3` in a pane is not hypothetical: this repository's own test output
    // prints control-mode notification lines. A parser that closed the reply on any
    // line starting with %end would drop the rest of the capture and blank the pane.
    const name = 'ccsterm-inj' + Math.random().toString(36).slice(2, 8);
    bridge.ensureSession({ name, workdir: '/tmp',
      launchCommand: `sh -c 'printf "%%end 1 2 3\\nAFTER-THE-FAKE-END\\n"; while :; do sleep 1; done'` });
    T('split-window', '-h', '-t', name, `sh -c 'while :; do sleep 1; done'`);
    await waitFor(() => bridge.paneCount(name) > 1);
    let seen = '';
    const h = bridge.attach({ name, cols: 120, rows: 40,
      onData: b => { seen += b.toString('utf8'); }, onGeometry: () => {}, onExit: () => {} });
    await waitFor(() => seen.includes('AFTER-THE-FAKE-END'));
    check('the line after the fake %end still reaches the viewer',
      seen.includes('AFTER-THE-FAKE-END'), true);
    h.close();
    bridge.killSession(name);
  }

  console.log('\nlive tmux — writing to a control client that is already gone:');
  {
    // The compositor writes a command to the control client on every frame, and a
    // repaint is one awaited command per pane — so a session that dies mid-frame leaves
    // the loop writing into a pipe that has gone. Two things must hold: the write must
    // not throw, and — the part that actually bit — it must SETTLE, because a command
    // that is never answered leaves the repaint sitting on a promise that never
    // resolves and the viewer silently stops updating for good.
    //
    // (The stream-level 'error' handler in attach() is the other half of this and is
    // deliberately not asserted here: EPIPE on a just-killed child is a race no test
    // can pin honestly. It was observed crashing a probe run, which is why it is there.)
    const name = 'ccsterm-gone' + Math.random().toString(36).slice(2, 8);
    bridge.ensureSession({ name, workdir: '/tmp',
      launchCommand: `sh -c 'while :; do echo NOISE; sleep 0.05; done'` });
    T('split-window', '-h', '-t', name, `sh -c 'while :; do echo MORE; sleep 0.05; done'`);
    await waitFor(() => bridge.paneCount(name) > 1);
    let seen = '', exits = 0;
    const h = bridge.attach({ name, cols: 120, rows: 40,
      onData: b => { seen += b.toString('utf8'); }, onGeometry: () => {}, onExit: () => { exits++; } });
    await waitFor(() => seen.includes('NOISE') && seen.includes('MORE'));
    bridge.killSession(name);
    await waitFor(() => exits > 0);
    let threw = null;
    try { h.write('x'); } catch (e) { threw = e; }
    check('a write after the client is gone does not throw', threw, null);
    check('...and the viewer is still reported as exited exactly once', exits, 1);
    h.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
