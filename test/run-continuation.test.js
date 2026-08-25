// Post-run decisions of the single-agent loops — the pure half.
//
// Two failures this pins, both reported against v7.9.0:
//
//   - a turn that launched a background job and then ended cleanly printed
//     "✅ Done" over work that had not happened. `subtype:'success'` is the ONLY
//     rung the auto-continue ladder does not cover, and nothing else resumes a
//     headless `claude -p` — the process exits and the background shell with it.
//
//   - `error_max_turns` from a run that stopped at 3 of 50 turns told the user to
//     "raise Max turns", which is wrong advice: the cap being hit is not that one.
//     Measured on CLI 2.1.231, a run capped at N reports num_turns === N + 1, so a
//     genuine exhaustion lands AT the cap, never at a fraction of it.
//
// Run: node test/run-continuation.test.js
'use strict';
const assert = require('assert');
const RC = require('../run-continuation');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function checkMatch(label, actual, re) {
  const ok = typeof actual === 'string' && re.test(actual);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.error(`  FAIL ${label} — ${JSON.stringify(actual)} does not match ${re}`); }
}

console.log('a background launch is recognised structurally, not from prose:');
{
  // This is the exact shape the CLI streams (verified against 2.1.231).
  const raw = '{"command": "sleep 2; echo OK", "description": "run it", "run_in_background": true}';
  check('Bash + run_in_background:true', RC.isBackgroundLaunch('Bash', raw), true);
  check('object input works too', RC.isBackgroundLaunch('Bash', { command: 'x', run_in_background: true }), true);
  check('a foreground Bash is not one', RC.isBackgroundLaunch('Bash', '{"command":"ls","run_in_background":false}'), false);
  check('a plain Bash is not one', RC.isBackgroundLaunch('Bash', '{"command":"ls"}'), false);
  // The loops truncate tool input for display; a truncated object is not valid JSON,
  // so this must never be implemented with JSON.parse.
  check('a TRUNCATED input still matches',
    RC.isBackgroundLaunch('Bash', '{"command": "a very long command that got cut", "run_in_background": true, "descrip'), true);
  // Another tool carrying the words must not count — only Bash launches shells.
  check('only Bash launches a shell', RC.isBackgroundLaunch('Write', '{"content":"run_in_background: true"}'), false);
  check('missing input is safe', RC.isBackgroundLaunch('Bash', undefined), false);
}

console.log('\nthe nudge fires exactly on the gap the ladder leaves open:');
{
  const base = { subtype: 'success', backgroundLaunched: true, nudges: 0 };
  check('clean finish + stranded background job', RC.shouldNudgeBackgroundWait(base), true);
  // Every non-success subtype already has its own rung. Stacking this on top would
  // spend the auto-continue budget twice for one stop.
  check('error_max_turns is the ladder\'s job, not this one',
    RC.shouldNudgeBackgroundWait({ ...base, subtype: 'error_max_turns' }), false);
  check('error_during_execution likewise',
    RC.shouldNudgeBackgroundWait({ ...base, subtype: 'error_during_execution' }), false);
  check('no background job, no nudge',
    RC.shouldNudgeBackgroundWait({ ...base, backgroundLaunched: false }), false);
  // Stop means stop. A nudge here would restart work the user just cancelled.
  check('Stop wins over everything', RC.shouldNudgeBackgroundWait({ ...base, aborted: true }), false);
  check('the cap is one nudge per turn',
    RC.shouldNudgeBackgroundWait({ ...base, nudges: RC.MAX_BACKGROUND_NUDGES }), false);
  check('MAX_BACKGROUND_NUDGES is 1 — a false positive costs one short run',
    RC.MAX_BACKGROUND_NUDGES, 1);
  check('an empty call decides nothing', RC.shouldNudgeBackgroundWait(), false);
  check('no argument at all is safe', RC.shouldNudgeBackgroundWait(undefined), false);
}

console.log('\nthe harvest prompt names the tool, because the CLI writes to a log file:');
{
  checkMatch('mentions BashOutput', RC.BACKGROUND_WAIT_PROMPT, /BashOutput/);
  // Without this the agent tends to re-run the original command instead of reading it.
  checkMatch('mentions reading the log', RC.BACKGROUND_WAIT_PROMPT, /log/i);
  checkMatch('says the turn does not resume', RC.BACKGROUND_WAIT_PROMPT, /nothing resumes a turn/i);
}

console.log('\nan error_max_turns far below the budget is named as a foreign cap:');
{
  // The reported case: 3 turns against a 50-turn dial.
  const a = RC.describeTurnBudgetAnomaly({ subtype: 'error_max_turns', numTurns: 3, requestedMaxTurns: 50 });
  checkMatch('states both numbers', a, /3 turns.*50/);
  checkMatch('says raising the dial will not help', a, /will not help/i);
  checkMatch('points at the machine the agent runs on', a, /settings\.json|hooks|CLI version/i);

  // A genuine exhaustion reports num_turns === cap + 1. Warning there would be noise.
  check('at the cap is not an anomaly',
    RC.describeTurnBudgetAnomaly({ subtype: 'error_max_turns', numTurns: 51, requestedMaxTurns: 50 }), null);
  check('one turn short is not an anomaly',
    RC.describeTurnBudgetAnomaly({ subtype: 'error_max_turns', numTurns: 49, requestedMaxTurns: 50 }), null);
  // Half the budget is the threshold — stated as a boundary so a later tweak is visible.
  check('exactly half is still not an anomaly',
    RC.describeTurnBudgetAnomaly({ subtype: 'error_max_turns', numTurns: 25, requestedMaxTurns: 50 }), null);
  checkMatch('just under half is',
    RC.describeTurnBudgetAnomaly({ subtype: 'error_max_turns', numTurns: 24, requestedMaxTurns: 50 }), /24 turns/);
  // A one-turn budget is the degenerate case: num_turns 1 or 2 is normal there.
  check('a tiny budget never trips it',
    RC.describeTurnBudgetAnomaly({ subtype: 'error_max_turns', numTurns: 1, requestedMaxTurns: 1 }), null);
  check('singular turn reads correctly',
    /1 turn /.test(RC.describeTurnBudgetAnomaly({ subtype: 'error_max_turns', numTurns: 1, requestedMaxTurns: 30 }) || ''), true);

  check('other subtypes are not this function\'s business',
    RC.describeTurnBudgetAnomaly({ subtype: 'error_during_execution', numTurns: 3, requestedMaxTurns: 50 }), null);
  check('a missing num_turns decides nothing',
    RC.describeTurnBudgetAnomaly({ subtype: 'error_max_turns', requestedMaxTurns: 50 }), null);
  check('a missing budget decides nothing',
    RC.describeTurnBudgetAnomaly({ subtype: 'error_max_turns', numTurns: 3 }), null);
  check('an empty call decides nothing', RC.describeTurnBudgetAnomaly(), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
