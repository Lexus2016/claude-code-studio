'use strict';
// Issue #117 — on-screen Esc / Tab / Ctrl / arrow keys under the terminal pane, for
// phone keyboards (Gboard) that have none of them.
//
// The block is RUN, not regex-matched: it is cut out of public/index.html between its
// own header comment and the wiring IIFE, and evaluated in a vm context with the
// three globals it touches stubbed. What must hold:
//   - the bytes: ESC, TAB, CSI arrows, SS3 arrows under DECCKM, CSI 1;5 for Ctrl+arrow;
//   - Ctrl is ONE-SHOT and applies to the next key from either source (row or keyboard);
//   - term.onData runs the typed key through applyTermCtrl BEFORE it is sent;
//   - a tap never takes focus (pointerdown default prevented), or Gboard closes per key.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Terminal on-screen keys (#117)');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const start = html.indexOf('// ─── On-screen terminal keys (#117)');
const end = html.indexOf('(function _wireTermKeys()');
assert.ok(start > 0 && end > start, 'terminal keys block not found in index.html');
const block = html.slice(start, end);

function load(opts = {}) {
  const sent = [];
  const pressed = { value: 'false' };
  const ctx = {
    _termSessionId: 'ccsterm-1',
    _terms: new Map([['ccsterm-1', { term: { modes: { applicationCursorKeysMode: !!opts.appCursor } } }]]),
    _reviveTerminal: (sid, frame) => { sent.push([sid, frame]); return true; },
    document: { querySelector: () => ({ setAttribute: (_k, v) => { pressed.value = v; } }) },
  };
  vm.createContext(ctx);
  // `const` / `let` at the top of a script do not become context properties, so the
  // functions are re-exported explicitly.
  vm.runInContext(block + '\nthis.api = { termCtrlChord, termKeySequence, applyTermCtrl, termKeyPress, armed: () => _termCtrlArmed };', ctx);
  return { api: ctx.api, sent, pressed };
}

check('Esc and Tab send ESC and HT', () => {
  const { api } = load();
  assert.strictEqual(api.termKeySequence('esc'), '\x1b');
  assert.strictEqual(api.termKeySequence('tab'), '\t');
});

check('arrows send CSI in normal mode, SS3 under application cursor mode (DECCKM)', () => {
  const { api } = load();
  assert.deepStrictEqual(['up', 'down', 'right', 'left'].map(k => api.termKeySequence(k)),
    ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
  assert.deepStrictEqual(['up', 'down', 'right', 'left'].map(k => api.termKeySequence(k, { appCursor: true })),
    ['\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD']);
});

check('Ctrl+arrow sends the xterm modifier form CSI 1;5 X', () => {
  const { api } = load();
  assert.strictEqual(api.termKeySequence('left', { ctrl: true }), '\x1b[1;5D');
  assert.strictEqual(api.termKeySequence('up', { ctrl: true, appCursor: true }), '\x1b[1;5A');
});

check('Ctrl chords: letters case-insensitive, the @..._ range, space, ?; others none', () => {
  const { api } = load();
  assert.strictEqual(api.termCtrlChord('c'), '\x03');
  assert.strictEqual(api.termCtrlChord('C'), '\x03');   // Gboard auto-capitalises
  assert.strictEqual(api.termCtrlChord('d'), '\x04');
  assert.strictEqual(api.termCtrlChord('['), '\x1b');
  assert.strictEqual(api.termCtrlChord(' '), '\x00');
  assert.strictEqual(api.termCtrlChord('?'), '\x7f');
  assert.strictEqual(api.termCtrlChord('1'), null);
  assert.strictEqual(api.termCtrlChord('ab'), null);
  assert.strictEqual(api.termCtrlChord('\ud83d'), null);   // first half of an emoji
});

check('Ctrl is one-shot on typed input and releases even when the key has no chord', () => {
  const { api, pressed } = load();
  assert.strictEqual(api.applyTermCtrl('c'), 'c', 'unarmed Ctrl must pass input through');
  api.termKeyPress('ctrl');
  assert.strictEqual(api.armed(), true);
  assert.strictEqual(pressed.value, 'true', 'the button does not show it is armed');
  assert.strictEqual(api.applyTermCtrl('c'), '\x03');
  assert.strictEqual(api.armed(), false);
  assert.strictEqual(api.applyTermCtrl('c'), 'c', 'Ctrl stayed armed for a second key');
  api.termKeyPress('ctrl');
  assert.strictEqual(api.applyTermCtrl('1x'), '1x');
  assert.strictEqual(api.armed(), false, 'a key without a chord must still release Ctrl');
});

check('tapping a key sends one input frame to the visible pane through _reviveTerminal', () => {
  const { api, sent } = load({ appCursor: true });
  api.termKeyPress('up');
  api.termKeyPress('ctrl'); api.termKeyPress('ctrl');   // arm, then disarm by tapping again
  api.termKeyPress('ctrl'); api.termKeyPress('right');
  api.termKeyPress('tab');
  assert.deepStrictEqual(sent.map(([sid, f]) => [sid, f.type, f.data]), [
    ['ccsterm-1', 'input', '\x1bOA'],
    ['ccsterm-1', 'input', '\x1b[1;5C'],
    ['ccsterm-1', 'input', '\t'],
  ]);
  assert.strictEqual(api.armed(), false);
});

check('term.onData applies an armed Ctrl before anything is sent', () => {
  const i = html.indexOf('term.onData(d => {');
  assert.ok(i > 0, 'term.onData handler not found');
  const apply = html.indexOf('d = applyTermCtrl(d);', i);
  const send = html.indexOf("entry.ws.send(JSON.stringify({ type: 'input', data: d }))", i);
  assert.ok(apply > i && send > apply, 'applyTermCtrl must run before the first send in onData');
});

check('a tap never takes focus from the pane (Gboard would close on every key)', () => {
  const wire = html.slice(end, html.indexOf('\n})();', end));
  assert.ok(/addEventListener\('pointerdown', e => \{ const b = keyOf\(e\); if \(!b\) return; e\.preventDefault\(\);/.test(wire),
    'pointerdown must preventDefault before acting');
  assert.ok(wire.includes("addEventListener('touchstart'") && wire.includes('{ passive: false }'),
    'touchstart must be cancellable (passive:false) to keep focus on touch devices');
});

check('the row is shown only on a coarse (touch) pointer', () => {
  assert.ok(/\.term-keys \{ display: none;/.test(html), 'row must be hidden by default');
  assert.ok(html.includes('@media (pointer: coarse) { .term-keys { display: flex; }'), 'row must appear on touch devices');
});

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall terminal key checks passed');
