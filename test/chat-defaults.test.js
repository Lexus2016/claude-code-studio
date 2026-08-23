// Global chat defaults + per-project overrides — issue #58, the pure half.
//
// What the resolver has to get right, and what breaks if it does not:
//   - the chain is project > global > BUILTIN, and BUILTIN must still be exactly
//     what the SPA hardcoded before this existed. Change one and every install
//     that never opened the settings form silently changes behaviour.
//   - a project stores ONLY the keys it pins. A full five-key snapshot would
//     freeze each project at whatever the global happened to be that day, which
//     is the opposite of what the issue asked for.
//   - a bad value in a hand-edited config.json drops that one key, never the
//     other four; a bad value in a WRITE is named, so the endpoint can refuse.
//
// Run: node test/chat-defaults.test.js
'use strict';
const assert = require('assert');
const CD = require('../chat-defaults');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

console.log('the built-ins are the behaviour that already shipped:');
{
  // These five are read off public/index.html as it was before #58: newTab()
  // assigned 'auto'/'single' literally, MODEL_MAP's default is sonnet, the effort
  // dial defaults to Auto (no flag), and #maxTurns ships value="50".
  check('mode', CD.BUILTIN.mode, 'auto');
  check('agent', CD.BUILTIN.agent, 'single');
  check('model', CD.BUILTIN.model, 'sonnet');
  check('effort', CD.BUILTIN.effort, 'auto');
  check('turns', CD.BUILTIN.turns, 50);
  check('and nothing else is a dial', CD.KEYS, ['mode', 'agent', 'model', 'effort', 'turns']);
  // A choice list that drifts from the toolbar renders as "no button selected".
  check('the model choices are exactly the CLI aliases', CD.CHOICES.model, ['haiku', 'sonnet', 'opus', 'fable']);
  check('the agent choices are exactly the four agent_mode values',
    CD.CHOICES.agent, ['single', 'multi', 'dispatch', 'conversation']);
  check('effort spells its no-flag state as a real word, not ""',
    CD.CHOICES.effort.includes('auto') && !CD.CHOICES.effort.includes(''), true);
}

console.log('\ncoercion:');
{
  check('a listed choice is taken', CD.coerce('model', 'opus'), { ok: true, value: 'opus' });
  check('an unlisted one is refused', CD.coerce('model', 'gpt-4'), { ok: false, error: 'invalid_choice' });
  check('a key outside the five is refused', CD.coerce('engine', 'api'), { ok: false, error: 'unknown_key' });
  check('turns takes a number', CD.coerce('turns', 12), { ok: true, value: 12 });
  check('turns takes the string a form sends', CD.coerce('turns', ' 12 '), { ok: true, value: 12 });
  check('turns refuses nonsense', CD.coerce('turns', 'lots'), { ok: false, error: 'expected_number' });
  // The bounds are #maxTurns' own min/max. Without them the form could store a
  // value its own input refuses to display.
  check('turns refuses 0', CD.coerce('turns', 0), { ok: false, error: 'out_of_range' });
  check('turns refuses 201', CD.coerce('turns', 201), { ok: false, error: 'out_of_range' });
  check('turns accepts the boundaries', [CD.coerce('turns', 1).value, CD.coerce('turns', 200).value], [1, 200]);
  check('a float is truncated, not stored as a float', CD.coerce('turns', 7.9), { ok: true, value: 7 });
}

console.log('\nsanitize keeps the good and names the bad:');
{
  const r = CD.sanitize({ mode: 'task', model: 'nope', turns: 10, engine: 'api' });
  check('the valid pairs survive', r.value, { mode: 'task', turns: 10 });
  check('the invalid ones are named, not dropped in silence', r.invalid.sort(), ['engine', 'model']);
  // A hand-edited config.json is the reason this half is lenient.
  check('one bad key does not blank the other four',
    CD.sanitize({ mode: 'task', agent: 'multi', model: 'nope' }).value, { mode: 'task', agent: 'multi' });
  check('an unset key is neither kept nor an error',
    CD.sanitize({ mode: null, agent: undefined, model: '' }), { value: {}, invalid: [] });
  for (const junk of [null, undefined, 'string', 42, ['mode']]) {
    check(`${JSON.stringify(junk)} yields an empty object, not a throw`,
      CD.sanitize(junk), { value: {}, invalid: [] });
  }
}

console.log('\nthe two-link chain:');
{
  const nothing = CD.resolveChatDefaults(null, null);
  check('with no config at all the built-ins are what a chat opens on',
    nothing.effective, { mode: 'auto', agent: 'single', model: 'sonnet', effort: 'auto', turns: 50 });
  check('and nothing reads as overridden', nothing.overridden, []);

  const globalOnly = CD.resolveChatDefaults({ model: 'opus', turns: 5 }, null);
  check('a global default reaches a project that pinned nothing',
    globalOnly.effective, { mode: 'auto', agent: 'single', model: 'opus', effort: 'auto', turns: 5 });
  check('a global default is not an override', globalOnly.overridden, []);

  const both = CD.resolveChatDefaults({ mode: 'task', model: 'opus', turns: 5 }, { model: 'sonnet', turns: 10 });
  // This is the exact table from the issue body.
  check('the project wins where it pinned, the global everywhere else',
    both.effective, { mode: 'task', agent: 'single', model: 'sonnet', effort: 'auto', turns: 10 });
  check('and exactly the pinned keys are reported as overridden', both.overridden, ['model', 'turns']);
  check('the global row is still reported for the UI to show alongside',
    both.global, { mode: 'task', agent: 'single', model: 'opus', effort: 'auto', turns: 5 });

  // The sparseness IS the feature: change the global and an unpinned project follows.
  const before = CD.resolveChatDefaults({ model: 'opus' }, { turns: 10 });
  const after  = CD.resolveChatDefaults({ model: 'haiku' }, { turns: 10 });
  check('an unpinned dial follows the global when it changes',
    [before.effective.model, after.effective.model], ['opus', 'haiku']);
  check('a pinned one does not', [before.effective.turns, after.effective.turns], [10, 10]);

  check('garbage in the global config falls back per key, never wholesale',
    CD.resolveChatDefaults({ model: 'gpt-4', mode: 'task' }, null).effective.model, 'sonnet');
  check('and the sibling key it sat next to still applies',
    CD.resolveChatDefaults({ model: 'gpt-4', mode: 'task' }, null).effective.mode, 'task');
  check('garbage in a project override is ignored the same way',
    CD.resolveChatDefaults({ model: 'opus' }, { model: 'gpt-4' }).effective.model, 'opus');
  check('and it does not count as an override either',
    CD.resolveChatDefaults({ model: 'opus' }, { model: 'gpt-4' }).overridden, []);

  // The resolver must not hand the caller a reference into BUILTIN.
  const a = CD.resolveChatDefaults(null, null);
  a.effective.model = 'MUTATED';
  check('the result is a fresh object, not a view onto BUILTIN', CD.BUILTIN.model, 'sonnet');
  check('and a second call is unaffected', CD.resolveChatDefaults(null, null).effective.model, 'sonnet');
}

console.log('\nthe effort sentinel:');
{
  // The catalog and config.json say 'auto'; the SPA's <select> and the CLI flag
  // both say ''. One translation, in one place.
  check("'auto' means no flag", CD.effortToFlag('auto'), '');
  check('an unset value means no flag either', CD.effortToFlag(undefined), '');
  check('a real level passes through', CD.effortToFlag('xhigh'), 'xhigh');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
