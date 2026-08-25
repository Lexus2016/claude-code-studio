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
// FOUR shapes of the background rule were wrong before this one, and each wrong
// shape has a test below named after it. They are the reason the module keeps an
// INCREMENTAL turn-level debt with deduplicated harvests rather than anything
// simpler — every simplification on that list shipped green and was still broken.
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
  // WRONG SHAPE #1 — an unanchored substring match. This is a real command to run in
  // this very repo, and it registered as a launch, charging the turn a rescue run.
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

console.log('\nthe harvest side recognises how the CLI actually returns output:');
{
  // Measured on 2.1.231: the launch answers "Output is being written to:
  // <project-hash>/<session-uuid>/tasks/<id>.output" and the agent READS that file.
  // BashOutput is not called at all, so keying the harvest on that tool name alone
  // makes every obedient agent look like it stranded its task.
  const outPath = '/private/tmp/claude-501/-Users-x-proj/8f9da46f-7b6d-44fb-8ec2-ee2089d94089/tasks/b74ztexqy.output';
  check('reading the .output file yields the shell id',
    RC.backgroundHarvestId('Read', JSON.stringify({ file_path: outPath })), 'b74ztexqy');
  // `View` is the name in this project's allowedTools lists; an agent that used it
  // would otherwise look like it collected nothing and be charged a rescue run.
  check('View is accepted alongside Read',
    RC.backgroundHarvestId('View', JSON.stringify({ file_path: outPath })), 'b74ztexqy');
  check('BashOutput yields its bash_id', RC.backgroundHarvestId('BashOutput', '{"bash_id":"b74ztexqy"}'), 'b74ztexqy');
  check('KillShell yields its shell_id', RC.backgroundHarvestId('KillShell', '{"shell_id":"zz1"}'), 'zz1');
  // An unidentifiable harvest does NOT pay down the debt. `bash_id` is required, so
  // this only happens on a malformed payload; crediting it would let two such calls
  // cancel a second launch that really was abandoned. One extra rescue run is the
  // cheaper mistake.
  check('an id-less BashOutput is not credited', RC.backgroundHarvestId('BashOutput', '{}'), null);
  check('an ordinary Read is not a harvest',
    RC.backgroundHarvestId('Read', JSON.stringify({ file_path: '/repo/server.js' })), null);
  // Narrow on purpose: a source file that merely lives under some tasks/ directory
  // must not be mistaken for a shell log.
  check('a tasks/ file with another extension is not',
    RC.backgroundHarvestId('Read', JSON.stringify({ file_path: '/repo/tasks/runner.js' })), null);
  check('a Bash call is never a harvest', RC.backgroundHarvestId('Bash', '{"command":"ls"}'), null);
  check('missing input is safe', RC.backgroundHarvestId('Read', undefined), null);
}

console.log('\nthe debt is incremental, and a surplus harvest is dropped, not banked:');
{
  const OLD_LOG = JSON.stringify({ file_path: '/x/8f9da46f/tasks/old1.output' });
  const NEW_LOG = JSON.stringify({ file_path: '/x/8f9da46f/tasks/new1.output' });
  const LAUNCH = JSON.stringify({ command: 'sleep 60', run_in_background: true });

  check('a fresh state owes nothing', RC.backgroundOutstanding(RC.newBackgroundState()), 0);

  {
    const st = RC.newBackgroundState();
    RC.applyBackgroundTool(st, 'Bash', LAUNCH);
    check('one launch, nothing collected', RC.backgroundOutstanding(st), 1);
    RC.applyBackgroundTool(st, 'Read', NEW_LOG);
    check('collected — nothing owed', RC.backgroundOutstanding(st), 0);
  }
  {
    // WRONG SHAPE #4 — a BATCH total. Reading a leftover log from an EARLIER turn is
    // often the first thing a resumed session does. Banked as a credit, it paid for
    // the launch that came after it: no rescue, no warning, "Done" over a running job.
    const st = RC.newBackgroundState();
    RC.applyBackgroundTool(st, 'Read', OLD_LOG);
    check('a harvest with no debt behind it is dropped', RC.backgroundOutstanding(st), 0);
    RC.applyBackgroundTool(st, 'Bash', LAUNCH);
    check('and CANNOT pay for a launch that comes later', RC.backgroundOutstanding(st), 1);
  }
  {
    // WRONG SHAPE #3 — raw call counts. Polling one job twice must pay once.
    const st = RC.newBackgroundState();
    RC.applyBackgroundTool(st, 'Bash', LAUNCH);
    RC.applyBackgroundTool(st, 'Bash', LAUNCH);
    check('two launches owe two', RC.backgroundOutstanding(st), 2);
    RC.applyBackgroundTool(st, 'BashOutput', '{"bash_id":"a1"}');
    RC.applyBackgroundTool(st, 'BashOutput', '{"bash_id":"a1"}');
    check('polling the same shell twice pays once', RC.backgroundOutstanding(st), 1);
    RC.applyBackgroundTool(st, 'BashOutput', '{"bash_id":"a2"}');
    check('a second shell pays the rest', RC.backgroundOutstanding(st), 0);
  }
  {
    const st = RC.newBackgroundState();
    RC.applyBackgroundTool(st, 'Bash', LAUNCH);
    RC.applyBackgroundTool(st, 'BashOutput', '{}');
    check('an unidentifiable harvest does not pay the debt', RC.backgroundOutstanding(st), 1);
  }
  {
    const st = RC.newBackgroundState();
    RC.applyBackgroundTool(st, 'Bash', JSON.stringify({ command: 'ls' }));
    RC.applyBackgroundTool(st, 'Read', JSON.stringify({ file_path: '/repo/server.js' }));
    RC.applyBackgroundTool(st, 'Write', JSON.stringify({ content: 'x' }));
    check('ordinary tools move nothing', RC.backgroundOutstanding(st), 0);
  }
  check('a missing state is zero, not a throw', RC.backgroundOutstanding(undefined), 0);
  check('applying to a missing state does not throw',
    RC.applyBackgroundTool(null, 'Bash', '{"run_in_background":true}'), null);
}

console.log('\nthe nudge fires exactly on the gap the ladder leaves open:');
{
  const base = { subtype: 'success', outstanding: 1, nudges: 0 };
  check('clean finish + stranded background job', RC.shouldNudgeBackgroundWait(base), true);
  // WRONG SHAPE #2 — a one-way latch. The system prompt tells the agent to collect
  // the result inside the turn; charging an extra run to the agent that OBEYED is
  // worse than the bug being fixed.
  check('an agent that collected what it started is NOT nudged',
    RC.shouldNudgeBackgroundWait({ ...base, outstanding: 0 }), false);
  // Every non-success subtype already has its own rung. Stacking this on top would
  // spend the auto-continue budget twice for one stop.
  check('error_max_turns is the ladder\'s job, not this one',
    RC.shouldNudgeBackgroundWait({ ...base, subtype: 'error_max_turns' }), false);
  check('error_during_execution likewise',
    RC.shouldNudgeBackgroundWait({ ...base, subtype: 'error_during_execution' }), false);
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
  // WRONG SHAPE #2b — a PER-RUN count. The rescue run's most likely shape is a
  // text-only answer that touches no tool at all, so it contributes no counts of its
  // own. Read per-run, the debt reset to zero here and the turn reported success:
  // the original "Done over unfinished work", one run later. Read at TURN level, the
  // debt from the first run is still owed and this fires.
  const afterTextOnlyRescue = { outstanding: 1, nudges: RC.MAX_BACKGROUND_NUDGES };
  checkMatch('a text-only rescue run leaves the debt standing',
    RC.describeStrandedBackgroundTask(afterTextOnlyRescue), /1 background task is still running/);
  checkMatch('says nothing will pick it up',
    RC.describeStrandedBackgroundTask(afterTextOnlyRescue), /nothing will pick it up/i);
  checkMatch('plural reads correctly',
    RC.describeStrandedBackgroundTask({ outstanding: 2, nudges: 1 }), /2 background tasks are still running/);
  // Before the nudge is spent this must stay silent — the harvest run is about to
  // happen, and warning first would pre-empt the rescue that usually works.
  check('silent while a nudge is still available',
    RC.describeStrandedBackgroundTask({ outstanding: 1, nudges: 0 }), null);
  check('silent when the rescue run collected it',
    RC.describeStrandedBackgroundTask({ outstanding: 0, nudges: 1 }), null);
  check('an empty call decides nothing', RC.describeStrandedBackgroundTask(), null);
}

console.log('\nthe harvest prompt names both ways to collect:');
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

// ── The instruction has to reach every runner, and each takes a different channel ──
// Rounds 5-7 of review found three no-ops in a row here: appending to a system prompt
// that `--resume` drops, to one that is `undefined` for a task with no bot, and to one
// a bot only sees on its first turn. Every one of them shipped green, because nothing
// pinned WHICH string carries the rule. This reads server.js as source text — the same
// technique test/render/script-scope.test.mjs uses — because the property being pinned
// is textual: which expression the constant is concatenated onto.
console.log('\nthe background rule reaches every runner:');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const K = 'BACKGROUND_TASK_INSTRUCTION';

  const near = (anchor, span = 400) => {
    const i = src.indexOf(anchor);
    return i === -1 ? null : src.slice(i, i + span);
  };
  const carries = (label, anchor) => {
    const win = near(anchor);
    if (win === null) { fail++; console.error(`  FAIL ${label} — anchor gone: ${anchor}`); return; }
    check(label, win.includes(K), true);
  };

  // chat + telegram: the only two that go through buildSystemPrompt.
  carries('buildSystemPrompt appends it', 'prompt += TOOL_CALL_INSTRUCTION;');
  // Kanban/scheduled, every engine: the task prompt is the one channel that reaches a
  // task with no bot, a task that resumes a session, AND the subscription engine
  // (which passes systemPrompt:'' and types the prompt into its tmux pane).
  carries('the task prompt carries it', "const prompt = parts.join('\\n\\n')");
  // multi-agent workers resume the orchestrator's session id, so --system-prompt is
  // dropped for them; the rule has to ride the user turn.
  carries('the multi-agent worker prompt carries it', 'const agentPrompt = agent.task');
  // a bot with a live session likewise never sees an updated system prompt.
  carries('the bots standing block carries it', 'const standing = botSession');

  // And it must NOT sit where it would be silently dropped: taskBotSp is undefined for
  // a bot-less task and dropped on resume. Its presence there reads as coverage.
  {
    const win = near('const taskBotSp = taskBot');
    check('taskBotSp does NOT carry it (undefined for a bot-less task, dropped on resume)',
      win !== null && !win.includes(K), true);
  }
  // Concatenated onto a prompt, so it must open with its own separator or it welds
  // itself onto the last word of whatever precedes it.
  {
    const m = /const BACKGROUND_TASK_INSTRUCTION = `([\s\S]*?)`;/.exec(src);
    check('it is declared', !!m, true);
    if (m) check('and opens with a blank-line separator', m[1].startsWith('\\n\\n'), true);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
