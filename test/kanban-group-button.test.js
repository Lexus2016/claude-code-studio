'use strict';
// Issue #115 — the Kanban "＋ Group" button "does nothing".
//
// Two defects, both pinned here:
//   1. buildChainForm() carried a bot picker copied from buildForm(tk) that read
//      `tk.bot_id` — a variable that does not exist there. The ReferenceError fired
//      before the modal body was assigned, so both "new group" and "edit group"
//      silently never opened. The test RUNS the real function (not a regex over it),
//      so any other stray free variable in that template fails here too.
//   2. In the all-projects view the button was `disabled`, and `.hb:disabled` carries
//      `pointer-events:none` — the click AND the tooltip were swallowed. It must stay
//      clickable so openAddChainModal() can toast the reason.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Kanban group button (#115)');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'kanban.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);

function fnSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() not found`);
  const next = html.indexOf('\nfunction ', start + 10);
  const nextAsync = html.indexOf('\nasync function ', start + 10);
  const end = Math.min(...[next, nextAsync].filter(i => i > 0));
  return html.slice(start, end);
}

check('every inline <script> in kanban.html parses', () => {
  assert.ok(scripts.length > 0, 'no inline scripts found');
  // A backtick inside a comment in a template literal ends the literal and kills the
  // whole block, which takes every function on the page down with it.
  scripts.forEach((src, i) => { new vm.Script(src, { filename: `kanban.html#script${i}` }); });
});

function runChainForm(mode, chain) {
  const ctx = {
    t: k => k, escH: s => String(s ?? ''), kbSettings: {}, kbBots: [{ id: 'b1', label: 'B', avatar: '🤖' }],
    engineSegHtml: () => '', modalMode: mode,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource('buildChainForm') + '\nthis.__out = buildChainForm(__chain);', Object.assign(ctx, { __chain: chain }));
  return ctx.__out;
}

check('buildChainForm renders for a NEW group without throwing', () => {
  const out = runChainForm('add_chain', {});
  assert.ok(out.includes('id="fChainTitle"'), 'title input missing from the form');
});

check('buildChainForm renders for an EXISTING group without throwing', () => {
  const out = runChainForm('edit_chain', {
    title: 'G', tasks: [{ id: 't1', title: 'a', status: 'todo' }, { id: 't2', title: 'b', status: 'done' }],
  });
  assert.ok(out.includes('value="G"'), 'existing title not rendered');
});

check('the group form has no bot picker (a group has no bot; saveChain never read one)', () => {
  assert.ok(!fnSource('buildChainForm').includes('id="fBot"'), 'bot picker is back in buildChainForm');
});

check('onProjChange never sets addGroupBtn.disabled (it would swallow the click)', () => {
  const src = fnSource('onProjChange');
  assert.ok(!/addGroupBtn\.disabled\s*=/.test(src), 'addGroupBtn.disabled is assigned again');
  assert.ok(src.includes("classList.toggle('is-off'"), 'the dimmed-but-clickable class is not applied');
});

check('openAddChainModal still explains the no-project case', () => {
  assert.ok(fnSource('openAddChainModal').includes("if(!curWorkdir){toast(t('toast.no_project'),true);return;}"));
});

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall kanban group button checks passed');
