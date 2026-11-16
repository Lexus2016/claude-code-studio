import assert from 'node:assert';
import { test } from 'node:test';
import { loadFn } from './_load.mjs';

// GitHub #131, proposal 8: the answer buttons on the "Claude is waiting" banner, run as
// the real functions from index.html against a fake card. What matters here is what
// the click PUTS ON THE WIRE — the option number and the server's key, nothing typed
// by hand — and that one question gets one answer.
const renderOpts = loadFn('renderInputNeededOptions');
const onResult = loadFn('onEnginePromptAnswerResult');
const onConsumed = loadFn('onEnginePromptConsumed');
globalThis._needInputCardFor = loadFn('_needInputCardFor');

function el(tag = 'div') {
  return {
    tag, children: [], className: '', textContent: '', disabled: false, type: '', onclick: null, removed: false,
    classList: { set: new Set(), add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } },
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll(sel) { return sel === 'button' ? this.children : []; },
    remove() { this.removed = true; },
  };
}
function setup() {
  const sent = [], toasts = [], opened = [];
  const box = el();
  const card = { dataset: { promptKey: 'K' }, querySelector: (s) => (s === '.ni-opts' && !box.removed ? box : null) };
  Object.assign(globalThis, {
    document: { createElement: el, querySelector: (s) => (s === '.needinput-card:not(.interrupted-card)' ? card : null) },
    ws: { readyState: 1, send: (s) => sent.push(JSON.parse(s)) },
    t: (k) => k,
    toast: (m, err) => toasts.push([m, !!err]),
    openEnginePane: (sid) => opened.push(sid),
  });
  return { box, card, sent, toasts, opened };
}
const FRAME = { type: 'input_needed', sessionId: 's1', promptKey: 'K', options: [{ n: 1, label: 'Red' }, { n: 2, label: 'Blue' }] };

test('one button per option, labelled with its number', () => {
  const { box, card } = setup();
  renderOpts(card, FRAME, 's1');
  assert.deepStrictEqual(box.children.map(b => b.textContent), ['1. Red', '2. Blue']);
});

test('a click sends the option number and the prompt key — nothing else', () => {
  const { box, card, sent } = setup();
  renderOpts(card, FRAME, 's1');
  box.children[1].onclick();
  assert.deepStrictEqual(sent, [{ type: 'engine_prompt_answer', sessionId: 's1', tabId: 's1', promptKey: 'K', choice: 2 }]);
  assert.strictEqual(typeof sent[0].choice, 'number', 'the server accepts only a JSON number');
});

test('the first click disables every button: one answer per question', () => {
  const { box, card } = setup();
  renderOpts(card, FRAME, 's1');
  box.children[0].onclick();
  assert.deepStrictEqual(box.children.map(b => b.disabled), [true, true]);
});

test('no key or no options — no buttons, the banner keeps "Open pane" alone', () => {
  for (const d of [{ ...FRAME, promptKey: undefined }, { ...FRAME, options: [] }, { ...FRAME, options: undefined }]) {
    const { box, card } = setup();
    renderOpts(card, d, 's1');
    assert.strictEqual(box.children.length, 0);
  }
});

test('an option number outside 1..9 is never rendered', () => {
  const { box, card } = setup();
  renderOpts(card, { ...FRAME, options: [{ n: 1, label: 'a' }, { n: 12, label: 'b' }, { n: '3', label: 'c' }] }, 's1');
  assert.deepStrictEqual(box.children.map(b => b.textContent), ['1. a', '3. c']);
});

test('offline: nothing is sent and the buttons stay usable', () => {
  const { box, card, sent, toasts } = setup();
  globalThis.ws.readyState = 3;
  renderOpts(card, FRAME, 's1');
  box.children[0].onclick();
  assert.deepStrictEqual([sent.length, box.children[0].disabled, toasts[0][1]], [0, false, true]);
});

test('a stale answer removes the buttons and says so', () => {
  const { box, card, toasts, opened } = setup();
  renderOpts(card, FRAME, 's1');
  onResult({ sessionId: 's1', ok: false, error: 'stale', promptKey: 'K' });
  assert.deepStrictEqual([box.removed, toasts, opened], [true, [['term.needinput.stale', true]], []]);
});

test('an option that did not move the widget on sends the user to the pane', () => {
  const { box, card, opened } = setup();
  renderOpts(card, FRAME, 's1');
  onResult({ sessionId: 's1', ok: true, advanced: false, promptKey: 'K' });
  assert.deepStrictEqual([box.removed, opened], [true, ['s1']]);
});

test('an answer that moved the widget on leaves the card to the engine\'s next frame', () => {
  const { box, card, toasts, opened } = setup();
  renderOpts(card, FRAME, 's1');
  onResult({ sessionId: 's1', ok: true, advanced: true, promptKey: 'K' });
  assert.deepStrictEqual([box.removed, toasts, opened], [false, [], []]);
});

// Review findings (codex): a late reply about question 1 arriving after the engine
// announced question 2 must not strip question 2's buttons.
test('a reply about another question leaves this banner alone', () => {
  const { box, card, toasts, opened } = setup();
  renderOpts(card, FRAME, 's1');
  onResult({ sessionId: 's1', ok: false, error: 'stale', promptKey: 'OLD' });
  onResult({ sessionId: 's1', ok: true, advanced: false, promptKey: 'OLD' });
  assert.deepStrictEqual([box.removed, toasts, opened], [false, [], []]);
});

// Review findings (agy): once ANY window answered, no window may answer again — not on
// screen, and not after a tab switch, which redraws from the tab's stored frame.
test('consumed: buttons go from the screen and from the tab\'s stored frame', () => {
  const { box, card } = setup();
  renderOpts(card, FRAME, 's1');
  const ts = { _inputNeeded: { ...FRAME } };
  onConsumed({ sessionId: 's1', promptKey: 'K' }, ts, true);
  assert.deepStrictEqual([box.removed, ts._inputNeeded.options, ts._inputNeeded.promptKey, ts._inputNeeded.type], [true, undefined, undefined, 'input_needed']);
});

test('consumed for a hidden tab touches only that tab\'s state, never the visible card', () => {
  const { box, card } = setup();
  renderOpts(card, FRAME, 's1');
  const ts = { _inputNeeded: { ...FRAME } };
  onConsumed({ sessionId: 's2', promptKey: 'K' }, ts, false);
  assert.deepStrictEqual([box.removed, ts._inputNeeded.options], [false, undefined]);
});

test('consumed for an older question keeps the newer one\'s buttons', () => {
  const { box, card } = setup();
  renderOpts(card, FRAME, 's1');
  const ts = { _inputNeeded: { ...FRAME } };
  onConsumed({ sessionId: 's1', promptKey: 'OLD' }, ts, true);
  assert.deepStrictEqual([box.removed, ts._inputNeeded.promptKey], [false, 'K']);
});
