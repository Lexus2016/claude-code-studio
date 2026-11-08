'use strict';
// Issue #131 — terminal selection and clipboard in the live pane.
//
// The helpers are RUN, not regex-matched: the pure block and _createTerminal itself are
// cut out of public/index.html and evaluated in a vm with a fake xterm, a fake element
// and a fake clipboard. What must hold:
//   - Ctrl+Shift+C copies and Ctrl+Shift+V pastes; plain Ctrl+C stays SIGINT (returns
//     true so xterm forwards it), and Ctrl+Shift+V never reaches the TUI as ^V;
//   - macOS uses Cmd+C / Cmd+V and ignores the Ctrl+Shift form;
//   - copy-on-select is OFF by default, persists when turned on, and a right-button
//     mouseup never copies;
//   - the context menu lists Copy / Paste / Select all / Copy on select, with Copy
//     disabled while there is no selection;
//   - the xterm options keep macOptionClickForcesSelection and drop word-select on
//     right-click.
//
// Run: node test/terminal-clipboard.test.js
const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.log(`  \u2717 ${name}\n    ${e.message}`); }
}

console.log('Terminal selection & clipboard (#131)');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// The pure block: chord map, menu model, xterm options, copy-on-select flag.
const pureStart = html.indexOf('// \u2500\u2500 Terminal clipboard (#131)');
const pureEnd = html.indexOf('function _showTermMenu(');
assert.ok(pureStart > 0 && pureEnd > pureStart, 'terminal clipboard block not found in public/index.html');
const PURE = html.slice(pureStart, pureEnd);
assert.ok(!/document\.|addEventListener/.test(PURE), 'the pure block must not touch the DOM');

// _createTerminal, from its own header to its top-level closing brace.
function liftFunction(src, name) {
  let at = src.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} must exist in public/index.html`);
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, `${name} must have a top-level closing brace`);
  return src.slice(at, end + 2);
}
const CREATE = liftFunction(html, '_createTerminal');

function fakeEl(tag) {
  const listeners = {};
  const el = {
    tag, className: '', dataset: {}, style: {}, children: [], removed: false,
    appendChild(c) { el.children.push(c); return c; },
    remove() { el.removed = true; },
    setAttribute() {}, focus() {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev) {
      const fns = listeners[type] || [];
      let last;
      for (const fn of fns) last = fn(ev);
      return last;
    },
    listenerCount(type) { return (listeners[type] || []).length; },
  };
  return el;
}

function load(opts = {}) {
  const store = new Map(Object.entries(opts.storage || {}));
  const clipboard = { copied: [], written: null, readText: opts.readText };
  const calls = { paste: 0, menu: [], revived: [] };
  const terms = new Map();
  const termHost = fakeEl('div');

  const localStorage = {
    getItem(k) { if (opts.storageThrows) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (opts.storageThrows) throw new Error('denied'); store.set(k, String(v)); },
  };

  class FakeTerminal {
    constructor(options) { this.options = options; this._sel = ''; this.keyHandler = null; this.dataHandler = null; FakeTerminal.last = this; }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
    onData(fn) { this.dataHandler = fn; }
    hasSelection() { return !!this._sel; }
    getSelection() { return this._sel; }
    selectAll() { this._sel = 'ALL'; }
    focus() { this.focused = true; }
  }

  const ctx = {
    navigator: { platform: opts.platform || 'Linux x86_64', clipboard: opts.noClipboardApi ? undefined : { readText: opts.readText } },
    localStorage,
    document: {
      documentElement: {},
      createElement: (tag) => fakeEl(tag),
    },
    window: { innerWidth: 1200, innerHeight: 800 },
    getComputedStyle: () => ({ getPropertyValue: () => '15px' }),
    $i: (id) => (id === 'termHost' ? termHost : null),
    isEnginePaneId: () => false,
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: class { fit() {} } },
    copyText: (text) => { clipboard.copied.push(text); return Promise.resolve(); },
    applyTermCtrl: (d) => d,
    _reviveTerminal: (sid, frame) => { calls.revived.push([sid, frame]); return true; },
    _connectTerminalWs: (sid) => { calls.ws = sid; },
    _pasteFromClipboard: () => { calls.paste++; },
    _showTermMenu: (sid, x, y) => { calls.menu.push([sid, x, y]); },
    _terms: terms,
    toast: () => {},
    t: (k) => k,
  };
  vm.createContext(ctx);
  vm.runInContext(
    PURE + '\n' + CREATE +
    '\nthis.api = { termChordAction, termOptions, termMenuItems, termCopyOnSelect, setTermCopyOnSelect, isMacPlatform, _createTerminal };',
    ctx,
  );
  return { api: ctx.api, ctx, store, clipboard, calls, terms, termHost, FakeTerminal };
}

const ev = (o) => Object.assign({ type: 'keydown', key: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, o);

// ── 1. chord map ────────────────────────────────────────────────────────────
check('Ctrl+Shift+C copies and Ctrl+Shift+V pastes on Linux/Windows', () => {
  const { api } = load();
  assert.strictEqual(api.termChordAction(ev({ key: 'c', ctrlKey: true, shiftKey: true }), { mac: false }), 'copy');
  assert.strictEqual(api.termChordAction(ev({ key: 'v', ctrlKey: true, shiftKey: true }), { mac: false }), 'paste');
});

check('plain Ctrl+C is left alone, so SIGINT still reaches the agent', () => {
  const { api } = load();
  assert.strictEqual(api.termChordAction(ev({ key: 'c', ctrlKey: true }), { mac: false }), null);
  assert.strictEqual(api.termChordAction(ev({ key: 'v', ctrlKey: true }), { mac: false }), null);
  assert.strictEqual(api.termChordAction(ev({ key: 'c', ctrlKey: true, shiftKey: true, altKey: true }), { mac: false }), null);
  assert.strictEqual(api.termChordAction(ev({ key: 'c', ctrlKey: true, shiftKey: true, metaKey: true }), { mac: false }), null);
  assert.strictEqual(api.termChordAction(ev({ key: 'x', ctrlKey: true, shiftKey: true }), { mac: false }), null);
  assert.strictEqual(api.termChordAction(ev({ key: '', ctrlKey: true, shiftKey: true }), { mac: false }), null);
});

check('macOS uses Cmd+C / Cmd+V and ignores the Ctrl+Shift form', () => {
  const { api } = load();
  assert.strictEqual(api.termChordAction(ev({ key: 'c', metaKey: true }), { mac: true }), 'copy');
  assert.strictEqual(api.termChordAction(ev({ key: 'v', metaKey: true }), { mac: true }), 'paste');
  assert.strictEqual(api.termChordAction(ev({ key: 'C', metaKey: true }), { mac: true }), 'copy', 'shift/caps do not matter');
  assert.strictEqual(api.termChordAction(ev({ key: 'c', ctrlKey: true, shiftKey: true }), { mac: true }), null);
  assert.strictEqual(api.termChordAction(ev({ key: 'c', metaKey: true, ctrlKey: true }), { mac: true }), null);
  assert.strictEqual(api.termChordAction(ev({ key: 'c' }), { mac: true }), null);
});

// ── 2. xterm options ────────────────────────────────────────────────────────
check('xterm options: Alt-drag selects on macOS, right-click is not word-select', () => {
  const { api } = load();
  const o = api.termOptions(14);
  assert.strictEqual(o.macOptionClickForcesSelection, true);
  assert.strictEqual(o.rightClickSelectsWord, false);
  assert.strictEqual(o.allowProposedApi, true, 'unicode11 needs it');
  assert.strictEqual(o.fontSize, 14);
  assert.strictEqual(o.scrollback, 10000);
});

// ── 3. copy-on-select setting ───────────────────────────────────────────────
check('copy-on-select is off by default and remembers being turned on', () => {
  const a = load();
  assert.strictEqual(a.api.termCopyOnSelect(), false, 'no stored value must mean off');
  a.api.setTermCopyOnSelect(true);
  assert.strictEqual(a.api.termCopyOnSelect(), true);
  assert.strictEqual(a.store.get('ccs:termCopyOnSelect'), '1');
  a.api.setTermCopyOnSelect(false);
  assert.strictEqual(a.api.termCopyOnSelect(), false, 'turning it back off must stick');
  const b = load({ storage: { 'ccs:termCopyOnSelect': '1' } });
  assert.strictEqual(b.api.termCopyOnSelect(), true);
});

check('a browser that refuses storage keeps copy-on-select off instead of throwing', () => {
  const { api } = load({ storageThrows: true });
  assert.strictEqual(api.termCopyOnSelect(), false);
  api.setTermCopyOnSelect(true); // must not throw
  assert.strictEqual(api.termCopyOnSelect(), false);
});

// ── 4. menu model ──────────────────────────────────────────────────────────
check('menu model: Copy is disabled without a selection, copy-on-select mirrors the setting', () => {
  const { api } = load();
  const none = api.termMenuItems({ hasSelection: false, copyOnSelect: false });
  assert.deepStrictEqual([...none.map(i => i.id)], ['copy', 'paste', 'selectAll', 'copyOnSelect']);
  assert.deepStrictEqual([...none.map(i => i.labelKey)],
    ['term.menu.copy', 'term.menu.paste', 'term.menu.selectAll', 'term.menu.copyOnSelect']);
  assert.strictEqual(none[0].enabled, false, 'Copy must be disabled with nothing selected');
  assert.strictEqual(none[1].enabled, true);
  assert.strictEqual(none[2].enabled, true);
  assert.strictEqual(none[3].checked, false);

  const some = api.termMenuItems({ hasSelection: true, copyOnSelect: true });
  assert.strictEqual(some[0].enabled, true);
  assert.strictEqual(some[3].checked, true);
});

// ── 5. wiring through _createTerminal ──────────────────────────────────────
check('_createTerminal builds xterm from termOptions()', () => {
  const { api, FakeTerminal } = load();
  api._createTerminal('ccsterm-1');
  assert.ok(FakeTerminal.last, 'no terminal was constructed');
  assert.strictEqual(FakeTerminal.last.options.macOptionClickForcesSelection, true);
  assert.strictEqual(FakeTerminal.last.options.rightClickSelectsWord, false);
  assert.ok(FakeTerminal.last.keyHandler, 'attachCustomKeyEventHandler was not called');
});

check('keydown wiring: copy returns false, paste returns false, Ctrl+C returns true', () => {
  const { api, FakeTerminal, clipboard, calls } = load();
  api._createTerminal('ccsterm-1');
  const h = FakeTerminal.last.keyHandler;

  FakeTerminal.last._sel = 'the selected text';
  assert.strictEqual(h(ev({ key: 'c', ctrlKey: true, shiftKey: true })), false, 'the chord must be swallowed');
  assert.deepStrictEqual(clipboard.copied, ['the selected text']);

  assert.strictEqual(h(ev({ key: 'v', ctrlKey: true, shiftKey: true })), false);
  assert.strictEqual(calls.paste, 1, '_pasteFromClipboard was not called');

  assert.strictEqual(h(ev({ key: 'c', ctrlKey: true })), true, 'Ctrl+C must reach the TUI as SIGINT');
  assert.strictEqual(h(ev({ key: 'a' })), true);

  assert.strictEqual(h({ type: 'keyup', key: 'c', ctrlKey: true, shiftKey: true }), true, 'keyup is not our business');
});

check('copy with no selection copies nothing but still swallows the chord', () => {
  const { api, FakeTerminal, clipboard } = load();
  api._createTerminal('ccsterm-1');
  FakeTerminal.last._sel = '';
  assert.strictEqual(FakeTerminal.last.keyHandler(ev({ key: 'c', ctrlKey: true, shiftKey: true })), false);
  assert.deepStrictEqual(clipboard.copied, []);
});

check('mouseup: no copy while copy-on-select is off, a copy once it is on', () => {
  const { api, clipboard, store } = load();
  const entry = api._createTerminal('ccsterm-1');
  entry.term._sel = 'dragged text';
  entry.host.fire('mouseup', { button: 0 });
  assert.deepStrictEqual(clipboard.copied, [], 'copy-on-select is supposed to be off by default');
  api.setTermCopyOnSelect(true);
  assert.strictEqual(store.get('ccs:termCopyOnSelect'), '1');
  entry.host.fire('mouseup', { button: 0 });
  assert.deepStrictEqual(clipboard.copied, ['dragged text']);
});

check('mouseup: a right-button release never copies, even with copy-on-select on', () => {
  const { api, clipboard } = load();
  const entry = api._createTerminal('ccsterm-1');
  api.setTermCopyOnSelect(true);
  entry.term._sel = 'still selected';
  entry.host.fire('mouseup', { button: 2 });
  assert.deepStrictEqual(clipboard.copied, [], 'the selection belongs to the context menu');
});

check('contextmenu opens the pane menu at the pointer and cancels the native one', () => {
  const { api, calls } = load();
  const entry = api._createTerminal('ccsterm-1');
  let prevented = 0, stopped = 0;
  const handled = entry.host.fire('contextmenu', {
    clientX: 40, clientY: 60,
    preventDefault: () => { prevented++; }, stopPropagation: () => { stopped++; },
  });
  assert.strictEqual(prevented, 1, 'the native menu must not open');
  assert.strictEqual(stopped, 1);
  assert.deepStrictEqual(calls.menu, [['ccsterm-1', 40, 60]]);
  assert.strictEqual(handled, undefined);
});

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
