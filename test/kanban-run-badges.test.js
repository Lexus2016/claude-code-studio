// A Kanban card must name the dials the NEXT RUN will actually use (#84).
//
// The board used to render one badge, `tk.sess_model`, and it was wrong twice over:
//   1. blank on a task that has never run — a board of unstarted cards said nothing
//      about the model/effort/engine the user had already picked in the modal
//   2. silent about a bot's model, which OVERRIDES the session's inside the runner
//
// So the point of this suite is NOT that a badge renders — it is that the badge agrees
// with server.js/startTask. Those two live in different files and drifted once already;
// the structural pins at the bottom fail loudly if the runner's chain is edited without
// the card following it.
//
// Run: node test/kanban-run-badges.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'kanban.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// Lift the pure helpers out of the single-file board, the same way
// test/kanban-schedule.test.js does. Slicing by name keeps this honest: rename or
// delete one and the suite fails instead of silently testing a stale copy.
function lift(names) {
  const parts = names.map(n => {
    const decl = n.startsWith('const ') ? n : `function ${n}(`;
    const start = SRC.indexOf(decl);
    assert.ok(start !== -1, `${n} not found in public/kanban.html`);
    if (n.startsWith('const ')) return SRC.slice(start, SRC.indexOf('\n', start));
    let i = SRC.indexOf('{', start), depth = 0;
    for (let j = i; j < SRC.length; j++) {
      if (SRC[j] === '{') depth++;
      else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
    }
    throw new Error(`unbalanced body for ${n}`);
  });
  // `t` is a free identifier in the real page too. Returning the KEY rather than a
  // translation is deliberate: it lets every assertion below name the i18n key the
  // badge asked for, so a key that does not exist in the dictionaries shows up here
  // as a wrong string rather than as a card rendering `effort.med` to a user.
  const sandbox = { t: k => k };
  vm.createContext(sandbox);
  vm.runInContext(parts.join('\n') + '\nthis.__api={kbRunBadges,KB_EFFORT_KEY};', sandbox);
  return sandbox.__api;
}

const { kbRunBadges, KB_EFFORT_KEY } = lift(['const KB_EFFORT_KEY=', 'kbRunBadges']);
// Array.from, not .map: the helper builds its array inside the vm realm, so its
// prototype is a different object and deepStrictEqual rejects it while printing two
// identical-looking values. Copying into a host array is what makes a failure here
// mean "wrong badges" rather than "wrong realm".
const texts  = tk => Array.from(kbRunBadges(tk), b => b.text);
const titles = tk => Array.from(kbRunBadges(tk), b => b.title);

// ── 1. The model chain, in the runner's order ───────────────────────────────
console.log('model badge follows taskBot -> session -> task -> sonnet:');
check('task model only', texts({ model: 'opus' }), ['opus']);
check('a session overrides the task row', texts({ model: 'opus', sess_model: 'haiku' }), ['haiku']);
check('a bot overrides the session', texts({ model: 'opus', sess_model: 'haiku', bot_model: 'fable' }), ['fable']);
check('a bot overrides a task with no session', texts({ model: 'opus', bot_model: 'fable' }), ['fable']);
// The runner ends on a literal 'sonnet'; a card that rendered nothing here would be
// claiming the run has no model, which is never true.
check('nothing stored still names the default', texts({}), ['sonnet']);
// A soft-deleted bot is filtered out by the SQL, so `bot_model` arrives null and the
// chain must fall through rather than blank the badge.
check('a null bot_model falls through', texts({ bot_model: null, sess_model: 'haiku' }), ['haiku']);

// ── 2. Effort renders only when it is not the default ───────────────────────
console.log('\neffort badge:');
check('unset effort adds no badge', texts({ model: 'sonnet' }), ['sonnet']);
check('empty-string effort adds no badge', texts({ model: 'sonnet', effort: '' }), ['sonnet']);
check('whitespace-only effort adds no badge', texts({ model: 'sonnet', effort: '  ' }), ['sonnet']);
check('null effort adds no badge', texts({ model: 'sonnet', effort: null }), ['sonnet']);
// The stored value is `medium`; the i18n key is `effort.med`. Mapping through
// KB_EFFORT_KEY is the whole reason that map exists — `t('effort.medium')` resolves
// in no language and would render the raw key on the card.
check('medium maps onto the effort.med key', texts({ model: 'sonnet', effort: 'medium' }), ['sonnet', 'effort.med']);
for (const e of ['low', 'high', 'xhigh', 'max']) {
  check(`${e} maps onto effort.${e}`, texts({ model: 'sonnet', effort: e }), ['sonnet', `effort.${e}`]);
}
check('an unknown effort is shown verbatim, not dropped', texts({ model: 'sonnet', effort: 'turbo' }), ['sonnet', 'turbo']);
check('the map covers exactly the five values the modal offers',
  Object.keys(KB_EFFORT_KEY).sort(), ['high', 'low', 'max', 'medium', 'xhigh']);

// ── 3. Engine renders only for `subscription` ───────────────────────────────
console.log('\nengine badge:');
check('the api engine is the default and adds no badge', texts({ model: 'sonnet', run_engine: 'api' }), ['sonnet']);
check('an unset engine adds no badge', texts({ model: 'sonnet', run_engine: null }), ['sonnet']);
check('subscription is announced', texts({ model: 'sonnet', run_engine: 'subscription' }), ['sonnet', 'engine.sub']);
check('all three together, in order',
  texts({ model: 'opus', effort: 'high', run_engine: 'subscription' }),
  ['opus', 'effort.high', 'engine.sub']);

// ── 4. Every badge carries a title, and it is a real i18n key ───────────────
console.log('\ntitles:');
check('titles name the toolbar labels',
  titles({ model: 'opus', effort: 'high', run_engine: 'subscription' }),
  ['tb.model', 'tb.effort', 'tb.engine']);
// Those keys have to exist in all five dictionaries or the tooltip renders the key.
// i18n-completeness.test.js owns parity between languages; this only pins that the
// keys the badge asks for are ones the board actually defines.
for (const k of ['tb.model', 'tb.effort', 'tb.engine', 'engine.sub',
                 'effort.low', 'effort.med', 'effort.high', 'effort.xhigh', 'effort.max']) {
  check(`kanban.html defines '${k}'`, SRC.includes(`'${k}':`), true);
}

// ── 5. Structural pins against the code the badge is mirroring ──────────────
console.log('\nthe card and the runner agree:');
// The exact expression in startTask. If someone reorders it — or drops the bot — the
// card silently starts lying, which is the defect this whole file exists to close.
check('startTask still resolves model as bot -> session -> task -> sonnet',
  /model:\s*taskBot\?\.model\s*\|\|\s*session\?\.model\s*\|\|\s*task\.model\s*\|\|\s*'sonnet'/.test(SERVER), true);
check('startTask still reads effort off the TASK row', /effort:\s*task\.effort\s*\|\|\s*null/.test(SERVER), true);
check('startTask still treats any non-subscription run_engine as api',
  /task\.run_engine === 'subscription'\)\s*\?\s*'subscription'\s*:\s*'api'/.test(SERVER), true);

// getTasks has to actually ship bot_model, or the first branch of the chain is dead
// weight and every bot-assigned card quietly falls back to the session's model.
const getTasksSql = SERVER.slice(SERVER.indexOf('getTasks: db.prepare('), SERVER.indexOf('getTask: db.prepare('));
check('getTasks selects b.model as bot_model', /b\.model as bot_model/.test(getTasksSql), true);
check('getTasks joins bots on the task\'s bot_id', /LEFT JOIN bots b ON t\.bot_id = b\.id/.test(getTasksSql), true);
// Same filter stmts.getBot applies. Without it a card advertises the model of a bot
// the runner will refuse to load.
check('the bots join excludes soft-deleted bots', /LEFT JOIN bots b ON t\.bot_id = b\.id AND b\.deleted_at IS NULL/.test(getTasksSql), true);

// And the card must render the helper rather than a hand-rolled copy of it.
const makeCardBody = SRC.slice(SRC.indexOf('function makeCard('), SRC.indexOf('function makeCard(') + 2600);
check('makeCard builds its badges from kbRunBadges', /const cfgBadges=kbRunBadges\(tk\)/.test(makeCardBody), true);
check('makeCard puts them in the footer', /\$\{cfgBadges\}/.test(makeCardBody), true);
// The old single-badge form must be gone from the TASK card. It survives on the CHAIN
// card (renderChainCard), which is out of scope here — so scope the search.
check('the sess_model-only badge is gone from the task card',
  /tk\.sess_model\?`<span class="badge badge-muted">/.test(makeCardBody), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
