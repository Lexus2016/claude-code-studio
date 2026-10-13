'use strict';

// Sidebar behaviour that only shows up in use.
//
// Deleting a chat: the server refuses (409 UNMERGED_WORK) a chat whose worktree holds
// work the delete would destroy. Both delete doors ignored the answer — they closed the
// tab and reloaded the list, the chat came straight back, and nothing said why. These
// run the REAL delSess / delSelectedHist / _sessDeleteRequest from index.html in a vm.
//
// Run: node test/sidebar-ux.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function lift(name) {
  let at = SRC.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} must exist`);
  if (SRC.slice(at - 6, at) === 'async ') at -= 6;
  const end = SRC.indexOf('\n}', at);
  assert.notEqual(end, -1, `${name} must have a top-level closing brace`);
  return SRC.slice(at, end + 2);
}

function harness({ responses, confirms }) {
  const calls = { fetch: [], closed: [], toasts: [], confirms: [], loadHist: 0 };
  const bulkBtn = { disabled: false, textContent: '' };
  const ctx = {
    t: k => k,
    toast: (msg, err) => calls.toasts.push({ msg, err: !!err }),
    confirm: msg => { calls.confirms.push(msg); return confirms.shift(); },
    fetch: async (url, opts = {}) => {
      calls.fetch.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined });
      const r = responses.shift();
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body || {} };
    },
    openTabs: [{ id: 's1' }, { id: 's2' }],
    closeTab: id => calls.closed.push(id),
    currentSessionId: null,
    loadHist: () => { calls.loadHist++; },
    updateHistBulkBar: () => {},
    histSelected: new Set(),
    $i: id => (id === 'histBulkDel' ? bulkBtn : id === 'histList' ? { querySelector: () => null } : null),
    CSS: { escape: s => s },
    BroadcastChannel: class { postMessage() {} close() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(['_sessDeleteRequest', '_histTitles', 'delSess', 'delSelectedHist'].map(lift).join('\n'), ctx);
  return { ctx, calls };
}

const UNMERGED = { status: 409, body: { code: 'UNMERGED_WORK', error: 'unmerged', blocked: ['s1'] } };

test('single delete: a refused delete keeps the tab and asks before forcing', async () => {
  // confirm #1 = "Delete session?", confirm #2 = the unmerged-work warning → Cancel.
  const { ctx, calls } = harness({ responses: [{ status: 404 }, UNMERGED], confirms: [true, false] });
  await ctx.delSess('s1');
  assert.deepEqual(calls.fetch.map(f => f.url), ['/api/sessions/s1/tasks-count', '/api/sessions/s1']);
  assert.equal(calls.confirms[1], 'sess.delete.unmerged', 'the second confirm names the loss');
  assert.deepEqual(calls.closed, [], 'a refused delete must not close the tab');
  assert.equal(calls.loadHist, 0);
});

test('single delete: confirming the warning resends with force and only then closes the tab', async () => {
  const { ctx, calls } = harness({ responses: [{ status: 404 }, UNMERGED, { status: 200 }], confirms: [true, true] });
  await ctx.delSess('s1');
  assert.equal(calls.fetch[2].url, '/api/sessions/s1?force=1');
  assert.deepEqual(calls.closed, ['s1']);
  assert.equal(calls.loadHist, 1);
});

test('single delete: any other failure is reported, not swallowed', async () => {
  const { ctx, calls } = harness({ responses: [{ status: 404 }, { status: 500, body: { error: 'boom' } }], confirms: [true] });
  await ctx.delSess('s1');
  assert.deepEqual(calls.toasts, [{ msg: 'boom', err: true }]);
  assert.deepEqual(calls.closed, []);
});

test('bulk delete: a refusal names the chats; Cancel deletes nothing and closes nothing', async () => {
  const { ctx, calls } = harness({ responses: [UNMERGED], confirms: [true, false] });
  ctx.histSelected.add('s1'); ctx.histSelected.add('s2');
  await ctx.delSelectedHist();
  assert.equal(calls.confirms[1], 'hist.del.unmerged'.replace('{list}', '• s1'));
  assert.equal(calls.fetch.length, 1);
  assert.deepEqual(calls.closed, []);
  assert.equal(ctx.histSelected.size, 2, 'the selection survives so the user can deselect the blocked chats');
});

test('bulk delete: confirming resends the same ids with force:true', async () => {
  const { ctx, calls } = harness({ responses: [UNMERGED, { status: 200 }], confirms: [true, true] });
  ctx.histSelected.add('s1'); ctx.histSelected.add('s2');
  await ctx.delSelectedHist();
  assert.deepEqual(calls.fetch[1].body, { ids: ['s1', 's2'], force: true });
  assert.deepEqual(calls.closed, ['s1', 's2']);
  assert.equal(ctx.histSelected.size, 0);
});

// Row actions that appear on hover sat in the row at opacity 0 — invisible, but holding
// their width, so a bot's name or a command truncated after a few letters next to an
// empty strip. Measured at a 280px sidebar: a bot name got 103px of a 205px row, a
// command 82px; after this, 203px of 225px.
const CSS = SRC.slice(SRC.indexOf('<style>'), SRC.indexOf('</style>'));

test('hover-only row actions take no width on a mouse until hovered or keyboard-focused', () => {
  const m = CSS.match(/@media \(hover: hover\) and \(pointer: fine\) \{\s*([^{]+)\{([^}]*)\}/);
  assert.ok(m, 'the collapse lives behind a fine-pointer media query — touch keeps in-flow targets');
  const [, selector, decl] = m;
  for (const cls of ['.cfg', '.rm', '.ren']) assert.ok(selector.includes(cls), `.ci ${cls} must collapse`);
  for (const cls of ['.del', '.fork-sess']) assert.ok(selector.includes(cls), `.hist-item ${cls} must collapse`);
  assert.match(selector, /\.ci:not\(:hover\):not\(:has\(:focus-visible\)\)/, 'a keyboard-focused control unfolds its row');
  assert.match(decl, /position: absolute/);
  assert.match(decl, /clip-path: inset\(50%\)/);
  assert.doesNotMatch(decl, /display:\s*none/, 'display:none would take the bot row\'s only controls out of the Tab order');
  assert.match(CSS, /\.ci, \.hist-item \{ position: relative; \}/, 'the clipped box needs the row as its containing block');
});

test('drag handles never push the title when they appear', () => {
  assert.match(CSS, /\.ci \.proj-drag-handle, \.hist-item \.drag-handle \{ position: absolute;/);
});

test('touch shows the controls it can tap, instead of invisible targets', () => {
  const touch = CSS.slice(CSS.indexOf('@media (hover: none) {'));
  assert.match(touch, /\.ci :is\(\.cfg, \.ren\) \{ opacity: \.6; \}/);
  assert.match(touch, /\.hist-item :is\(\.del, \.fork-sess:not\(\.fork-na\)\) \{ opacity: \.5; \}/);
});
