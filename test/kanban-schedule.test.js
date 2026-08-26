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

// ── Run settings stay editable after the task has a session (#79) ──────────
// These dials are read off the TASK row on every run — `effectiveTaskMaxTurns =
// task.max_turns`, `mode: task.mode`, `task.effort`, `task.run_engine` in
// startTask — but the block holding them was shown only while a session was being
// created. The moment a task first ran, the settings that actually drive each run
// became uneditable.
console.log('\nKanban task run settings remain editable:');
{
  const fs2 = require('fs'), path2 = require('path');
  const KB = fs2.readFileSync(path2.join(__dirname, '..', 'public', 'kanban.html'), 'utf8');
  const i2 = KB.indexOf('function buildForm(tk={}){');
  const form = KB.slice(i2, KB.indexOf('\nfunction ', i2 + 10));

  check('the settings block is visible when editing, not only for a new session',
    /const visClass=\(!tk\.session_id\|\|!isNew\)\?' visible':''/.test(form), true);

  // The session picker must stop hiding it while editing, or the toggle undoes
  // the line above the moment the user touches the dropdown.
  const oc = KB.slice(KB.indexOf('function onFSessionChange()'));
  const ocBody = oc.slice(0, oc.indexOf('\n}') + 2);
  check('the session picker does not hide it while editing',
    /modalMode!=='edit'/.test(ocBody), true);

  // model is the one dial the session wins on (`session?.model || task.model`),
  // so the form has to say that rather than imply the change takes effect now.
  check('the form carries a note about when the settings take effect',
    /modal\.task_cfg_note/.test(form), true);
}

// ── Which dial reaches which engine — read from the code, not guessed ──────
// Three attempts at wording this note were each factually wrong, because the two
// engines take DIFFERENT subsets and no single sentence covered both. The note now
// says only what is always true; this pins the underlying matrix so the next person
// reads it instead of guessing, and notices if a run path starts or stops
// forwarding one of these.
console.log('\nwhich task dials each run path actually receives:');
{
  const fs2 = require('fs'), path2 = require('path');
  const SRV = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
  const i2 = SRV.indexOf('async function startTask(task)');
  const seg = SRV.slice(i2, i2 + 20000);
  const callArgs = (needle) => {
    const k = seg.indexOf(needle);
    if (k === -1) return '';
    let d = 0, j = k + needle.length;
    for (; j < seg.length; j++) {
      const c = seg[j];
      if (c === '(') d++;
      else if (c === ')') { if (d === 0) break; d--; }
    }
    return seg.slice(k, j);
  };
  const api = callArgs('cli.send(');
  const sub = callArgs('runInteractiveSingle(');
  const has = (call, key) => new RegExp('[\\s{,]' + key + '\\s*:').test(call);

  // The API path is where turns and effort live.
  check('API run receives maxTurns', has(api, 'maxTurns'), true);
  check('API run receives effort', has(api, 'effort'), true);
  check('API run does NOT receive mode', has(api, 'mode'), false);
  // The subscription path is the mirror image.
  check('subscription run receives mode', has(sub, 'mode'), true);
  check('subscription run does NOT receive maxTurns', has(sub, 'maxTurns'), false);
  check('subscription run does NOT receive effort', has(sub, 'effort'), false);
  // agent_mode reaches neither: it is read only when the session is first created.
  check('neither run path receives agentMode', has(api, 'agentMode') || has(sub, 'agentMode'), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
