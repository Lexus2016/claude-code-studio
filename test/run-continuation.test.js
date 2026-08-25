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
  // THE REGRESSION AN UNANCHORED REGEX WOULD CAUSE. This is a real command to run
  // in this very repo, and under a substring match it registered as a launch and
  // charged the turn a rescue run it did not need.
  check('a FOREGROUND command that merely mentions the flag is not a launch',
    RC.isBackgroundLaunch('Bash', JSON.stringify({ command: 'grep -rn \'"run_in_background": true\' *.js' })), false);
  check('nor is reading a file that contains it',
    RC.isBackgroundLaunch('Bash', JSON.stringify({ command: 'cat run-continuation.js' })), false);
  // The parse path is primary, but a truncated object must not lose the signal:
  // a missed launch strands the task, which is the failure this module exists for.
  check('an UNPARSEABLE (truncated) input still matches',
    RC.isBackgroundLaunch('Bash', '{"command": "a very long command that got cut", "run_in_background": true, "descrip'), true);
  // Another tool carrying the words must not count — only Bash launches shells.
  check('only Bash launches a shell', RC.isBackgroundLaunch('Write', '{"content":"run_in_background: true"}'), false);
  check('missing input is safe', RC.isBackgroundLaunch('Bash', undefined), false);
}

console.log('\nand the harvest side recognises how the CLI actually returns output:');
{
  // Measured on 2.1.231: the launch answers "Output is being written to:
  // <project-hash>/<session-uuid>/tasks/<id>.output" and the agent READS that file.
  // BashOutput is not called at all, so keying the harvest on the tool name alone
  // makes every obedient agent look like it stranded its task.
  const outPath = '/private/tmp/claude-501/-Users-x-proj/8f9da46f-7b6d-44fb-8ec2-ee2089d94089/tasks/b74ztexqy.output';
  check('reading the .output file is a harvest',
    RC.isBackgroundHarvest('Read', JSON.stringify({ file_path: outPath })), true);
  check('BashOutput is a harvest', RC.isBackgroundHarvest('BashOutput', '{"bash_id":"b74ztexqy"}'), true);
  check('so is killing the shell', RC.isBackgroundHarvest('KillShell', '{"shell_id":"b74ztexqy"}'), true);
  check('an ordinary Read is not', RC.isBackgroundHarvest('Read', JSON.stringify({ file_path: '/repo/server.js' })), false);
  // Narrow on purpose: a source file that merely lives under some tasks/ directory
  // must not be mistaken for a shell log.
  check('a tasks/ file with another extension is not',
    RC.isBackgroundHarvest('Read', JSON.stringify({ file_path: '/repo/tasks/runner.js' })), false);
  check('missing input is safe', RC.isBackgroundHarvest('Read', undefined), false);
}

console.log('\nthe nudge fires exactly on the gap the ladder leaves open:');
{
  const base = { subtype: 'success', launches: 1, harvests: 0, nudges: 0 };
  check('clean finish + stranded background job', RC.shouldNudgeBackgroundWait(base), true);
  // THE FALSE POSITIVE A ONE-WAY LATCH CAUSED. The system prompt tells the agent to
  // collect the result inside the turn; charging an extra run to the agent that
  // OBEYED is worse than the bug being fixed.
  check('an agent that collected what it started is NOT nudged',
    RC.shouldNudgeBackgroundWait({ ...base, launches: 1, harvests: 1 }), false);
  check('two launched, two collected — still no nudge',
    RC.shouldNudgeBackgroundWait({ ...base, launches: 2, harvests: 2 }), false);
  check('two launched, one collected — nudged',
    RC.shouldNudgeBackgroundWait({ ...base, launches: 2, harvests: 1 }), true);
  // Every non-success subtype already has its own rung. Stacking this on top would
  // spend the auto-continue budget twice for one stop.
  check('error_max_turns is the ladder\'s job, not this one',
    RC.shouldNudgeBackgroundWait({ ...base, subtype: 'error_max_turns' }), false);
  check('error_during_execution likewise',
    RC.shouldNudgeBackgroundWait({ ...base, subtype: 'error_during_execution' }), false);
  check('no background job, no nudge',
    RC.shouldNudgeBackgroundWait({ ...base, launches: 0 }), false);
  // Stop means stop. A nudge here would restart work the user just cancelled.
  check('Stop wins over everything', RC.shouldNudgeBackgroundWait({ ...base, aborted: true }), false);
  check('the cap is one nudge per turn',
    RC.shouldNudgeBackgroundWait({ ...base, nudges: RC.MAX_BACKGROUND_NUDGES }), false);
  check('MAX_BACKGROUND_NUDGES is 1 — a false positive costs one short run',
    RC.MAX_BACKGROUND_NUDGES, 1);
  check('an empty call decides nothing', RC.shouldNudgeBackgroundWait(), false);
  check('no argument at all is safe', RC.shouldNudgeBackgroundWait(undefined), false);
}

console.log('\nand when the rescue run ALSO walks away, the turn says so:');
{
  // Without this the bounded nudge just restores the original bug one run later:
  // a clean "✅ Done" printed over a task still running.
  const after = { launches: 1, harvests: 0, nudges: RC.MAX_BACKGROUND_NUDGES };
  checkMatch('names how many were left', RC.describeStrandedBackgroundTask(after), /1 background task is still running/);
  checkMatch('says nothing will pick it up', RC.describeStrandedBackgroundTask(after), /nothing will pick it up/i);
  checkMatch('plural reads correctly',
    RC.describeStrandedBackgroundTask({ launches: 3, harvests: 1, nudges: 1 }), /2 background tasks are still running/);
  // Before the nudge is spent this must stay silent — the harvest run is about to
  // happen, and warning first would be wrong twice out of three times.
  check('silent while a nudge is still available',
    RC.describeStrandedBackgroundTask({ launches: 1, harvests: 0, nudges: 0 }), null);
  check('silent when everything was collected',
    RC.describeStrandedBackgroundTask({ launches: 2, harvests: 2, nudges: 1 }), null);
  check('an empty call decides nothing', RC.describeStrandedBackgroundTask(), null);
}

console.log('\nthe harvest prompt names the tool, because the CLI writes to a log file:');
{
  checkMatch('mentions BashOutput', RC.BACKGROUND_WAIT_PROMPT, /BashOutput/);
  // The CLI writes to a FILE and the agent reads it back; an agent told only
  // "use BashOutput" tends to re-run the original command instead.
  checkMatch('names the .output file', RC.BACKGROUND_WAIT_PROMPT, /\.output/);
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
