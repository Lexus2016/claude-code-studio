'use strict';
// Issue #152 — the live pane keeps its history and its place across a page refresh.
//
// Three layers, each checked where it can actually regress:
//   1. terminal-bridge's argv: `captureScreen(name, N)` must add `-S -N` BEFORE `-t`,
//      and `captureScreen(name)` must stay byte-identical to the old visible-only
//      capture (the compositor's repaint and the suites' screenHas helper use it).
//   2. server.js: the `hist` query parameter is client input, so it is clamped, and
//      BOTH attach paths (the engine viewer and an ordinary terminal) pass it on.
//   3. the client: a NEW xterm asks for the history in its first paint, a reconnect
//      asks for none, and the saved scroll position is restored from the first
//      frame's write callback — the only point where it can be applied.
//
// The save/restore pair is RUN against a fake xterm, not regex-matched: the value that
// matters is "lines above the bottom", and an absolute viewportY would pass a presence
// check while landing in the wrong place after a replayed buffer of a different length.
//
// Run: node test/terminal-history.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

console.log('\n— 1. capture argv: the history flag —');

const bridge = require('../terminal-bridge');

check('a visible-only capture is unchanged',
  bridge.captureArgs('ccs-demo', 0),
  ['capture-pane', '-p', '-e', '-t', 'ccs-demo']);
check('history adds -S -N before -t',
  bridge.captureArgs('ccs-demo', 2000),
  ['capture-pane', '-p', '-e', '-S', '-2000', '-t', 'ccs-demo']);
check('a zero/negative count degrades to no history',
  bridge.captureArgs('ccs-demo', -5),
  ['capture-pane', '-p', '-e', '-t', 'ccs-demo']);
// xterm's own scrollback is 10000 and tmux's default history-limit is 2000, so this
// bound covers a default pane without letting one attach ship an unbounded payload.
check('the bootstrap bound is 2000 lines', bridge.BOOTSTRAP_HISTORY_LINES, 2000);

console.log('\n— 2. server: clamped, and passed to both viewers —');

const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('hist is read from the connect URL, clamped',
  /termHistory = Math\.max\(0, Math\.min\(10000, parseInt\(q\.get\('hist'\), 10\) \|\| 0\)\);/ .test(SRV), true);
check('the engine viewer passes it to attach',
  /engHandle = termBridge\.attach\(\{[\s\S]{0,220}?historyLines: termHistory/.test(SRV), true);
check('an ordinary terminal passes it too',
  /handle = termBridge\.attach\(\{[\s\S]{0,220}?historyLines: termHistory/.test(SRV), true);

console.log('\n— 3. the client asks once, then restores —');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const connAt = SRC.indexOf('function _connectTerminalWs(sessionId)');
check('_connectTerminalWs found', connAt > 0, true);
const conn = SRC.slice(connAt, SRC.indexOf('\nfunction ', connAt + 10));
check('a fresh xterm asks for the history', /const wantHist = entry\.booted \? 0 : 2000;/.test(conn), true);
check('...carried in the connect URL', /wantHist \? `&hist=\$\{wantHist\}` : ''/.test(conn), true);
check('every connect restarts the paint count', /entry\._paintFrames = 0;/.test(conn), true);
check('the FIRST parsed frame restores the saved position',
  /entry\._paintFrames === 1 \? \(\) => \{ try \{ _restoreTermView\(sessionId\); \} catch \{\} \}/.test(conn), true);
// Flipped on a PARSED frame, not on open: a connect that dies before painting must ask
// for the history again on its retry, or the retry replays nothing.
check('booted flips on the first painted frame, not on open',
  /entry\._paintFrames = \(entry\._paintFrames \|\| 0\) \+ 1;[\s\S]{0,400}?entry\.booted = true;/.test(conn), true);
check('the scroll listeners are registered on the pane',
  /term\.onScroll\(\(\) => _saveTermViewSoon\(sessionId\)\)[\s\S]{0,120}?addEventListener\('scroll', \(\) => _saveTermViewSoon\(sessionId\)/.test(SRC), true);

console.log('\n— 4. save/restore, run against a fake xterm —');

{
  const start = SRC.indexOf('const TERM_VIEW_KEY_PREFIX');
  const restoreAt = SRC.indexOf('function _restoreTermView(sessionId)');
  check('the view-state block exists', start > 0 && restoreAt > start, true);
  const end = SRC.indexOf('\n}\n', restoreAt) + 2;
  const BLOCK = SRC.slice(start, end);

  const make = (terms, storage) => new Function(
    '_terms', 'localStorage', 'setTimeout',
    `${BLOCK}; return { _saveTermView, _restoreTermView, _readTermView };`
  )(terms, storage, () => 0);

  const memory = () => {
    const data = new Map();
    return {
      getItem: k => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => data.set(k, String(v)),
      _data: data,
    };
  };

  const storage = memory();
  let scrolledTo = -1;
  const host = { scrollLeft: 240 };
  const term = {
    buffer: { active: { baseY: 100, viewportY: 88 } },
    scrollToLine: n => { scrolledTo = n; },
  };
  const api = make(new Map([['s1', { term, host }]]), storage);

  api._saveTermView('s1');
  const saved = JSON.parse(storage.getItem('ccs:termView:s1'));
  check('saves lines ABOVE the bottom, not an absolute line', saved.fromBottom, 12);
  check("saves the pane's horizontal offset", saved.left, 240);

  // A page reload: a NEW xterm whose buffer is a different length. The same distance
  // from the bottom must land in the same place; a stored viewportY would not.
  scrolledTo = -1;
  const term2 = {
    buffer: { active: { baseY: 500, viewportY: 500 } },
    scrollToLine: n => { scrolledTo = n; },
  };
  const host2 = { scrollLeft: 0 };
  make(new Map([['s1', { term: term2, host: host2 }]]), storage)._restoreTermView('s1');
  check('restore targets baseY - fromBottom on the NEW buffer', scrolledTo, 488);
  check('and re-applies the horizontal offset', host2.scrollLeft, 240);

  // A reader who was at the bottom must not be scrolled back: fromBottom 0 is "leave it".
  const storage2 = memory();
  storage2.setItem('ccs:termView:s2', JSON.stringify({ fromBottom: 0, left: 0 }));
  scrolledTo = -1;
  make(new Map([['s2', { term: term2, host: host2 }]]), storage2)._restoreTermView('s2');
  check('a reader at the bottom is not moved', scrolledTo, -1);

  // Storage can be unavailable (private mode, quota). It must degrade, not throw.
  const throwing = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  let threw = false;
  try { make(new Map([['s3', { term, host }]]), throwing)._saveTermView('s3'); }
  catch { threw = true; }
  check('a refused storage write does not throw', threw, false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
