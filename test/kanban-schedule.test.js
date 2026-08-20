// Kanban scheduling rules — the form must not produce a task the scheduler
// silently ignores, and must not lose a recurrence it cannot display.
//
// Three defects this guards against, all found in public/kanban.html:
//   1. a task with a date but status='backlog' never fires — getTodoTasks
//      (server.js) selects status='todo' only
//   2. a recurrence with no anchor date fires immediately, then reschedules
//      off `now` instead of the intended slot
//   3. the legacy tokens the server still accepts (hourly|daily|weekly|monthly,
//      server.js RECUR_ALIASES) parsed as "once", so the next save wiped them
//
// Run: node test/kanban-schedule.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'kanban.html'), 'utf8');
let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// Lift the pure functions out of the single-file SPA. Slicing by name keeps the
// test honest: rename or delete one and this fails loudly instead of silently
// testing a stale copy.
function lift(names) {
  const parts = names.map(n => {
    const decl = n.startsWith('const ') ? n : `function ${n}(`;
    const start = SRC.indexOf(decl);
    assert.ok(start !== -1, `${n} not found in public/kanban.html`);
    // Balance braces from the declaration to the end of the body.
    if (n.startsWith('const ')) return SRC.slice(start, SRC.indexOf('\n', start));
    let i = SRC.indexOf('{', start), depth = 0;
    for (let j = i; j < SRC.length; j++) {
      if (SRC[j] === '{') depth++;
      else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
    }
    throw new Error(`unbalanced body for ${n}`);
  });
  const sandbox = { $i: id => sandbox.__dom[id] || null, __dom: {} };
  vm.createContext(sandbox);
  vm.runInContext(parts.join('\n') + '\nthis.__api={parseRecurForForm,buildRecurToken,kbEffectiveStatus,kbEffectiveRecurrence,RECUR_ALIASES};', sandbox);
  return sandbox;
}

const box = lift(['const RECUR_ALIASES=', 'parseRecurForForm', 'buildRecurToken', 'kbEffectiveStatus', 'kbEffectiveRecurrence']);
const { parseRecurForForm, buildRecurToken, kbEffectiveStatus, kbEffectiveRecurrence, RECUR_ALIASES } = box.__api;

// ── 1. status coercion ──────────────────────────────────────────────────────
console.log('kbEffectiveStatus (scheduled task must reach the scheduler):');
check('dated + backlog -> todo',            kbEffectiveStatus('backlog', 1750000000), 'todo');
check('dated + undefined -> todo',          kbEffectiveStatus(undefined, 1750000000), 'todo');
check('dated + todo stays todo',            kbEffectiveStatus('todo', 1750000000), 'todo');
check('dated + in_progress is not hijacked', kbEffectiveStatus('in_progress', 1750000000), 'in_progress');
check('dated + done is not hijacked',       kbEffectiveStatus('done', 1750000000), 'done');
check('undated + backlog stays backlog',    kbEffectiveStatus('backlog', null), 'backlog');
check('undated + nothing -> backlog',       kbEffectiveStatus(undefined, null), 'backlog');
check('epoch 0 is not treated as a date',   kbEffectiveStatus('backlog', 0), 'backlog');

// ── 2. recurrence needs an anchor ───────────────────────────────────────────
console.log('kbEffectiveRecurrence (no anchor date -> no repeat):');
check('token survives with a date',   kbEffectiveRecurrence('every:2:day', 1750000000), 'every:2:day');
check('token dropped without a date', kbEffectiveRecurrence('every:2:day', null), null);
check('no token, with a date',        kbEffectiveRecurrence(null, 1750000000), null);
check('no token, no date',            kbEffectiveRecurrence(null, null), null);

// ── 3. legacy tokens survive an edit round-trip ─────────────────────────────
console.log('parseRecurForForm / buildRecurToken round-trip:');
function roundTrip(token) {
  const r = parseRecurForForm(token);
  box.__dom = { fRecurUnit: { value: r.unit }, fRecurN: { value: String(r.n) } };
  return buildRecurToken();
}
for (const [legacy, canonical] of Object.entries(RECUR_ALIASES)) {
  check(`legacy '${legacy}' parses`, parseRecurForForm(legacy).unit !== '', true);
  check(`legacy '${legacy}' -> ${canonical}`, roundTrip(legacy), canonical);
}
for (const tok of ['every:1:hour', 'every:3:day', 'every:2:week', 'every:1:month', 'times:4:month']) {
  check(`canonical '${tok}' round-trips`, roundTrip(tok), tok);
}
check('unknown token is not invented into a repeat', roundTrip('nonsense:9'), null);
check('empty recurrence stays empty', roundTrip(''), null);
check('null recurrence stays empty', roundTrip(null), null);

// A dated non-recurring task must not pick up a repeat, and a legacy-token task
// must come back out of the form with the same meaning it went in with.
console.log('combined save path:');
{
  const parsed = parseRecurForForm('daily');
  box.__dom = { fRecurUnit: { value: parsed.unit }, fRecurN: { value: String(parsed.n) } };
  check("editing a 'daily' task keeps it daily", kbEffectiveRecurrence(buildRecurToken(), 1750000000), 'every:1:day');
  check("clearing the date on a 'daily' task clears the repeat", kbEffectiveRecurrence(buildRecurToken(), null), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
