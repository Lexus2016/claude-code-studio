'use strict';
// Issue #131, second slice — the pane's xterm addons and the find bar.
//
// The vendored bundles are RUN, not grepped: each UMD file is evaluated in a vm and must
// expose its constructor (that is what a <script> tag gets). The addon block and
// _createTerminal are cut out of public/index.html and run against a fake xterm, so what
// must hold:
//   - the plan loads unicode11 / web-links / search and survives a missing vendor file;
//   - loading unicode11 also ACTIVATES it — loading alone does nothing;
//   - a URL leaves through window.open, and only http(s) can leave at all;
//   - Ctrl+Shift+F (Cmd+F on macOS) opens the find bar from inside the pane, and plain
//     Ctrl+F is left to the TUI;
//   - the bar searches incrementally while typing, steps on Enter / Shift+Enter, closes on
//     Esc, clears its decorations and hands focus back to the pane;
//   - a result count only reaches the bar when it belongs to the pane on screen.
//
// Run: node test/terminal-addons.test.js
const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  \u2713 ${name}`); }
  catch (e) { failed++; console.log(`  \u2717 ${name}\n    ${e.message}`); }
}

console.log('Terminal addons & find (#131)');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ── the vendored files ───────────────────────────────────────────────────────────
function loadVendor(file) {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'vendor', file), 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox; sandbox.self = sandbox; sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

check('vendor/unicode11 exposes Unicode11Addon from a plain <script>', () => {
  const ns = loadVendor('xterm-addon-unicode11.js');
  assert.strictEqual(typeof ns.Unicode11Addon.Unicode11Addon, 'function', 'window.Unicode11Addon is the module namespace, as xterm-addon-fit already is');
});

check('vendor/web-links exposes WebLinksAddon from a plain <script>', () => {
  const ns = loadVendor('xterm-addon-web-links.js');
  assert.strictEqual(typeof ns.WebLinksAddon.WebLinksAddon, 'function');
});

check('vendor/search exposes SearchAddon from a plain <script>', () => {
  const ns = loadVendor('xterm-addon-search.js');
  assert.strictEqual(typeof ns.SearchAddon.SearchAddon, 'function');
});

// ── the slices of index.html under test ──────────────────────────────────────────
const pureStart = html.indexOf('// \u2500\u2500 Terminal clipboard (#131)');
const pureEnd = html.indexOf('function _showTermMenu(');
assert.ok(pureStart > 0 && pureEnd > pureStart, 'terminal clipboard block not found');
const PURE = html.slice(pureStart, pureEnd);

const addonsStart = html.indexOf('// \u2500\u2500 Terminal addons and find (#131)');
const addonsEnd = html.indexOf('// Build (once) the live terminal');
assert.ok(addonsStart > 0 && addonsEnd > addonsStart, 'terminal addons block not found');
const ADDONS = html.slice(addonsStart, addonsEnd);

function liftFunction(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} must exist in public/index.html`);
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, `${name} must have a top-level closing brace`);
  return src.slice(at, end + 2);
}
const CREATE = liftFunction(html, '_createTerminal');

function fakeEl(tag) {
  const classes = new Set();
  const el = {
    tag, className: '', dataset: {}, style: {}, children: [], textContent: '', value: '',
    focused: false, selected: false,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c), toString: () => [...classes].join(' '),
    },
    appendChild(c) { el.children.push(c); return c; },
    remove() {}, setAttribute() {}, focus() { el.focused = true; },
    select() { el.selected = true; },
    addEventListener() {},
  };
  return el;
}

function load(opts = {}) {
  const els = {
    termHost: fakeEl('div'),
    termFind: fakeEl('div'),
    termFindInput: fakeEl('input'),
    termFindCount: fakeEl('span'),
  };
  const calls = { ws: null, revived: [], resized: 0, opened: [] };
  const terms = new Map();
  const frames = [];

  class FakeTerminal {
    constructor(options) { this.options = options; this.addons = []; this.keyHandler = null; this.cols = 80; this.rows = 24; this.unicode = { versions: ['6'], activeVersion: '6' }; FakeTerminal.last = this; }
    loadAddon(a) { this.addons.push(a); }
    open() {}
    attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
    onData() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
    selectAll() { this.selectedAll = true; }
    focus() { this.focused = true; }
    scrollToBottom() {}
  }
  class FakeUnicode11 { constructor() { FakeUnicode11.last = this; } }
  class FakeWebLinks {
    constructor(handler) { this.handler = handler; FakeWebLinks.last = this; }
  }
  class FakeSearch {
    constructor() { this.calls = []; this.cleared = 0; this.resultsHandler = null; FakeSearch.last = this; }
    onDidChangeResults(fn) { this.resultsHandler = fn; }
    findNext(term, o) { this.calls.push(['next', term, o]); return true; }
    findPrevious(term, o) { this.calls.push(['prev', term, o]); return true; }
    clearDecorations() { this.cleared++; }
  }

  const ctx = {
    navigator: { platform: opts.platform || 'Linux x86_64', clipboard: { readText: async () => '' } },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { documentElement: {}, createElement: (tag) => fakeEl(tag) },
    window: { innerWidth: 1200, innerHeight: 800, open: (...a) => calls.opened.push(a) },
    getComputedStyle: () => ({ getPropertyValue: () => '15px' }),
    requestAnimationFrame: (fn) => { frames.push(fn); },
    $i: (id) => els[id] || null,
    isEnginePaneId: () => false,
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: class { fit() {} } },
    copyText: async () => {},
    applyTermCtrl: (d) => d,
    _reviveTerminal: () => true,
    _connectTerminalWs: (sid) => { calls.ws = sid; },
    _pasteFromClipboard: () => {},
    _showTermMenu: () => {},
    _terms: terms,
    toast: () => {},
    sendTermResize: () => { calls.resized++; },
    _termSessionId: null,
    t: (k) => ({ 'term.find.count': '{i} of {n}', 'term.find.none': 'No matches' }[k] || k),
  };
  if (!opts.noAddons) {
    ctx.Unicode11Addon = { Unicode11Addon: FakeUnicode11 };
    ctx.WebLinksAddon = { WebLinksAddon: FakeWebLinks };
    ctx.SearchAddon = { SearchAddon: FakeSearch };
  }
  vm.createContext(ctx);
  vm.runInContext(
    PURE + '\n' + ADDONS + '\n' + CREATE +
    '\nthis.api = { termAddonPlan, termLinkHandler, termFindChord, termFindLabel, termFindOpen,' +
    ' termFindSearch, termFindStep, termFindKeydown, termFindClose, _createTerminal, TERM_FIND_DECORATIONS };',
    ctx,
  );
  return { api: ctx.api, ctx, els, calls, terms, frames, FakeTerminal, FakeUnicode11, FakeWebLinks, FakeSearch };
}

const ev = (o) => Object.assign({ type: 'keydown', key: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault() { this.defaulted = true; } }, o);

// ── 1. which addons load ─────────────────────────────────────────────────────────
check('plan loads unicode11, web-links and search when all three bundles are present', () => {
  const { api } = load();
  const plan = api.termAddonPlan({
    Unicode11Addon: { Unicode11Addon: class {} },
    WebLinksAddon: { WebLinksAddon: class {} },
    SearchAddon: { SearchAddon: class {} },
  });
  assert.deepStrictEqual([...plan.map(p => p.id)], ['unicode11', 'webLinks', 'search']);
});

check('a missing or broken bundle drops only itself', () => {
  const { api } = load();
  const onlyLinks = api.termAddonPlan({ WebLinksAddon: { WebLinksAddon: class {} } });
  assert.deepStrictEqual([...onlyLinks.map(p => p.id)], ['webLinks']);
  assert.deepStrictEqual([...api.termAddonPlan({ SearchAddon: { SearchAddon: 'nope' } })], []);
  assert.deepStrictEqual([...api.termAddonPlan({})], []);
  assert.deepStrictEqual([...api.termAddonPlan(null)], [], 'no globals must not throw');
});

// ── 2. link handling ────────────────────────────────────────────────────────────
check('a URL opens through window.open and only http(s) can leave', () => {
  const opened = [];
  const handler = load().api.termLinkHandler({ open: (...a) => opened.push(a) });
  handler({}, 'https://example.com/x');
  handler({}, 'http://example.com/y');
  handler({}, 'javascript:alert(1)');
  handler({}, 'file:///etc/passwd');
  handler({}, 'data:text/html,<script>');
  handler({}, '');
  handler({}, null);
  assert.deepStrictEqual(opened, [
    ['https://example.com/x', '_blank', 'noopener'],
    ['http://example.com/y', '_blank', 'noopener'],
  ]);
});

check('the link handler falls back to the page window and never throws', () => {
  const { api, calls } = load();
  const handler = api.termLinkHandler();
  handler({}, 'https://example.com/z');
  assert.deepStrictEqual(calls.opened, [['https://example.com/z', '_blank', 'noopener']]);
  api.termLinkHandler({})({}, 'https://example.com/z');  // a window without open()
});

// ── 3. the find chord ───────────────────────────────────────────────────────────
check('Ctrl+Shift+F opens find on Linux/Windows, plain Ctrl+F stays with the TUI', () => {
  const { api } = load();
  assert.strictEqual(api.termFindChord(ev({ key: 'f', ctrlKey: true, shiftKey: true }), { mac: false }), 'open');
  assert.strictEqual(api.termFindChord(ev({ key: 'F', ctrlKey: true, shiftKey: true }), { mac: false }), 'open');
  assert.strictEqual(api.termFindChord(ev({ key: 'f', ctrlKey: true }), { mac: false }), null, 'readline forward-char');
  assert.strictEqual(api.termFindChord(ev({ key: 'f', ctrlKey: true, shiftKey: true, altKey: true }), { mac: false }), null);
  assert.strictEqual(api.termFindChord(ev({ key: 'f', ctrlKey: true, shiftKey: true, metaKey: true }), { mac: false }), null);
  assert.strictEqual(api.termFindChord(ev({ key: 'g', ctrlKey: true, shiftKey: true }), { mac: false }), null);
});

check('macOS uses Cmd+F and ignores the Ctrl+Shift form', () => {
  const { api } = load();
  assert.strictEqual(api.termFindChord(ev({ key: 'f', metaKey: true }), { mac: true }), 'open');
  assert.strictEqual(api.termFindChord(ev({ key: 'f', ctrlKey: true, shiftKey: true }), { mac: true }), null);
  assert.strictEqual(api.termFindChord(ev({ key: 'f', metaKey: true, altKey: true }), { mac: true }), null);
  assert.strictEqual(api.termFindChord(ev({ key: 'f', metaKey: true, ctrlKey: true }), { mac: true }), null);
});

// ── 4. the count label ──────────────────────────────────────────────────────────
check('the count says which match it is, and admits the 1000 highlight cap', () => {
  const { api } = load();
  assert.strictEqual(api.termFindLabel({ resultIndex: 0, resultCount: 1 }), '1 of 1');
  assert.strictEqual(api.termFindLabel({ resultIndex: 4, resultCount: 40 }), '5 of 40');
  assert.strictEqual(api.termFindLabel({ resultIndex: 999, resultCount: 1000 }), '1000 of 1000+');
  assert.strictEqual(api.termFindLabel({ resultIndex: -1, resultCount: 0 }), 'No matches');
  assert.strictEqual(api.termFindLabel(null), 'No matches');
});

// ── 5. wiring in _createTerminal ─────────────────────────────────────────────────
check('_createTerminal loads all three addons and activates unicode11', () => {
  const { api, FakeTerminal, FakeUnicode11, FakeWebLinks, FakeSearch } = load();
  const entry = api._createTerminal('ccsterm-1');
  assert.strictEqual(FakeTerminal.last.addons.length, 4, 'fit plus the three bundles');
  assert.ok(FakeTerminal.last.addons.includes(FakeUnicode11.last));
  assert.ok(FakeUnicode11.last, 'unicode11 was not constructed');
  assert.ok(FakeWebLinks.last, 'web-links was not constructed');
  assert.ok(FakeSearch.last, 'search was not constructed');
  assert.strictEqual(FakeTerminal.last.unicode.activeVersion, '11', 'loading unicode11 without activating it does nothing');
  assert.strictEqual(typeof FakeWebLinks.last.handler, 'function', 'web-links must get our own handler');
  assert.strictEqual(entry.search, FakeSearch.last, 'the entry must keep the search addon for the find bar');
  assert.strictEqual(typeof FakeSearch.last.resultsHandler, 'function', 'results must reach the bar');
});

check('a missing vendor file still builds a working pane', () => {
  const { api, FakeTerminal } = load({ noAddons: true });
  const entry = api._createTerminal('ccsterm-1');
  assert.ok(FakeTerminal.last, 'the terminal must still be created');
  assert.strictEqual(entry.search, null);
  assert.strictEqual(FakeTerminal.last.addons.length, 1, 'only the fit addon is left');
  assert.strictEqual(FakeTerminal.last.keyHandler(ev({ key: 'f', ctrlKey: true, shiftKey: true })), true,
    'with no search addon the chord must stay with the TUI');
});

check('the find chord is swallowed by the pane, copy chords still work', () => {
  const { api, ctx, FakeTerminal } = load();
  ctx._termSessionId = 'ccsterm-1';
  api._createTerminal('ccsterm-1');
  const h = FakeTerminal.last.keyHandler;
  assert.strictEqual(h(ev({ key: 'f', ctrlKey: true, shiftKey: true })), false, 'find must be swallowed');
  assert.strictEqual(h(ev({ key: 'c', ctrlKey: true, shiftKey: true })), false);
  assert.strictEqual(h(ev({ key: 'c', ctrlKey: true })), true, 'Ctrl+C must still be SIGINT');
});

check('a result count reaches the bar only for the pane on screen', () => {
  const { api, ctx, els, FakeSearch } = load();
  ctx._termSessionId = 'ccsterm-1';
  api._createTerminal('ccsterm-1');
  const onResults = FakeSearch.last.resultsHandler;
  onResults({ resultIndex: 1, resultCount: 4 });
  assert.strictEqual(els.termFindCount.textContent, '2 of 4');
  ctx._termSessionId = 'ccsterm-2';
  onResults({ resultIndex: 3, resultCount: 9 });
  assert.strictEqual(els.termFindCount.textContent, '2 of 4', 'a hidden pane must not write into the bar');
});

// ── 6. the bar itself ───────────────────────────────────────────────────────────
function withEntry(extra = {}) {
  const ctx = load(extra);
  ctx.ctx._termSessionId = 'ccsterm-1';
  const entry = ctx.api._createTerminal('ccsterm-1');
  return Object.assign({ entry }, ctx);
}

check('open shows the bar and focuses the field; without the addon it refuses', () => {
  const { api, els, frames } = withEntry();
  assert.strictEqual(api.termFindOpen(), true);
  assert.ok(els.termFind.classList.contains('open'));
  assert.ok(els.termFindInput.focused, 'the field must take the keyboard');
  frames.forEach(fn => fn());
  assert.ok(true);

  const bare = withEntry({ noAddons: true });
  assert.strictEqual(bare.api.termFindOpen(), false, 'no search addon means no bar');
  assert.ok(!bare.els.termFind.classList.contains('open'));
});

check('typing searches incrementally; an empty query clears the decorations', () => {
  const { api, els, FakeSearch } = withEntry();
  els.termFindInput.value = 'needle';
  api.termFindSearch();
  const [kind, term, opts] = FakeSearch.last.calls.pop();
  assert.strictEqual(kind, 'next');
  assert.strictEqual(term, 'needle');
  assert.strictEqual(opts.incremental, true);
  assert.strictEqual(opts.decorations.matchBackground, '#4a3f00', 'matches must be visible');

  els.termFindInput.value = '';
  api.termFindSearch();
  assert.strictEqual(FakeSearch.last.cleared, 1);
  assert.strictEqual(els.termFindCount.textContent, '');
});

check('Enter steps forward, Shift+Enter back, and neither is incremental', () => {
  const { api, els, FakeSearch } = withEntry();
  els.termFindInput.value = 'needle';
  api.termFindStep(1);
  assert.deepStrictEqual(FakeSearch.last.calls.pop().slice(0, 2), ['next', 'needle']);
  assert.strictEqual(FakeSearch.last.calls.length, 0);

  api.termFindStep(-1);
  assert.deepStrictEqual(FakeSearch.last.calls.pop().slice(0, 2), ['prev', 'needle']);

  assert.strictEqual(FakeSearch.last.calls.length, 0);
  els.termFindInput.value = '';   // empty query: no call, no crash
  api.termFindStep(1);
  assert.strictEqual(FakeSearch.last.calls.length, 0);
});

check('Escape closes the bar and gives the keyboard back to the pane', () => {
  const { api, els, entry, FakeSearch } = withEntry();
  api.termFindOpen();
  els.termFindInput.value = 'needle';
  const e = ev({ key: 'Escape' });
  api.termFindKeydown(e);
  assert.ok(e.defaulted, 'Esc must be consumed by the bar');
  assert.ok(!els.termFind.classList.contains('open'));
  assert.strictEqual(els.termFindInput.value, '');
  assert.strictEqual(FakeSearch.last.cleared, 1, 'highlights must not outlive the search');
  assert.ok(entry.term.focused, 'the pane must get focus back');
});

check('the bar can be closed for a session that is no longer on screen', () => {
  const { api, ctx, els, FakeSearch } = withEntry();
  api.termFindOpen();
  ctx._termSessionId = null;           // hideTerminalView() clears it first
  api.termFindClose('ccsterm-1');
  assert.ok(!els.termFind.classList.contains('open'));
  assert.strictEqual(FakeSearch.last.cleared, 1);
});

// ── 7. the page actually ships this ─────────────────────────────────────────────
check('index.html loads the vendored bundles after xterm and fit', () => {
  const order = ['/vendor/xterm.js', '/vendor/xterm-addon-fit.js', '/vendor/xterm-addon-unicode11.js',
    '/vendor/xterm-addon-web-links.js', '/vendor/xterm-addon-search.js']
    .map(f => html.indexOf(`<script src="${f}"></script>`));
  order.forEach((at, i) => assert.ok(at > 0, `missing script tag ${i}`));
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'the bundles must load after xterm.js');
});

check('the find bar is in the markup with translated placeholder and buttons', () => {
  assert.ok(html.includes('<div class="term-find" id="termFind"'), 'find bar markup missing');
  for (const k of ['term.find.ph', 'term.find.prev', 'term.find.next', 'term.find.close']) {
    assert.ok(html.includes(`data-i18n-${k === 'term.find.ph' ? 'ph' : 'title'}="${k}"`), `missing ${k}`);
  }
  assert.ok(/\.term-find\.open \{ display: flex; \}/.test(html), 'the bar must stay hidden until opened');
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
