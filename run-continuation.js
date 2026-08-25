// Two decisions the single-agent run loops make AFTER a run comes back, both pure
// so they can be pinned without booting a server or an SSH host.
//
// 1. Background tasks. A turn that ends on `subtype:'success'` is not always a turn
//    that finished the work. A run which launched a background shell and then wrote
//    "I'll wait for it and continue" ends as a clean `end_turn`, so the auto-continue
//    ladder never sees it (that ladder fires only on NON-success). Nothing else
//    resumes a headless `claude -p`: the process is gone and the background shell
//    went with it. The chat printed "✅ Done" over an unfinished task.
//
//    Detection is STRUCTURAL, never textual. User-facing text is written in the UI
//    language (buildSystemPrompt pins that explicitly), so a regex over English
//    phrases like "I'll check back" is dead on a French or Ukrainian install. A
//    `Bash` call carrying `run_in_background` is the same JSON in every language.
//
//    LAUNCHES ARE COUNTED AGAINST HARVESTS, never treated as a one-way latch. The
//    system prompt tells the agent to collect a background result inside the same
//    turn; a latch would then charge an extra run to every agent that OBEYED, which
//    is worse than the bug it fixes. Measured on CLI 2.1.231, a background launch
//    answers with "Output is being written to: <cwd-hash>/tasks/<id>.output" and the
//    agent harvests by READING that file — `BashOutput` is not called at all — so
//    the harvest side has to recognise that read, not just the tool name.
//
// 2. `describeTurnBudgetAnomaly` — `error_max_turns` from a run that stopped far
//    below the budget we asked for means the limit did not come from this chat.
//    Measured against CLI 2.1.231: a run capped at N reports num_turns === N + 1,
//    so a genuine exhaustion lands AT the cap, never at a fraction of it. Telling
//    such a user to "raise Max turns" (issue #67) sends them to a dial that is
//    already high enough — the cap is being imposed somewhere else.
//
// KNOWN LIMIT: a process backgrounded with shell syntax (`cmd &`, `nohup`, `tmux
// new -d`) inside a FOREGROUND Bash call is not detected, and deliberately so —
// telling `a && b`, `2>&1` and a trailing `&` apart needs a shell parser, and the
// false positives would land on ordinary commands. That case is covered by the
// system-prompt half (BACKGROUND_TASK_INSTRUCTION), which is stated in terms of
// "anything that keeps running after the call returns" rather than one tool field.
'use strict';

/** One nudge per turn. A false positive costs exactly one short run. */
const MAX_BACKGROUND_NUDGES = 1;

/** Where CLI 2.1.231 writes a background shell's output, and therefore what a
 *  harvesting `Read` looks like: `<project-hash>/<session-uuid>/tasks/<id>.output`. */
const BG_OUTPUT_PATH_RE = /\/tasks\/[A-Za-z0-9_-]+\.output$/;

/** What the nudge run is asked to do. Names both ways to collect, because the CLI
 *  routes a background shell's output to a FILE — an agent told only "use BashOutput"
 *  tends to re-run the original command instead. */
const BACKGROUND_WAIT_PROMPT =
  'You ended your turn while a background task you started was still running. ' +
  'Nothing resumes a turn here, so it had to be picked up now. ' +
  'Retrieve that task\'s output — read the .output file the launch reported, or call BashOutput — ' +
  'wait for it to finish if it has not, and complete the remaining work. ' +
  'If it is already finished and nothing is left, say so in one line.';

/** The tool input arrives as the JSON string claude-cli.js / claude-ssh.js produced
 *  with `JSON.stringify(b.input)` — complete, not the truncated copy used for display.
 *  Parsing is therefore the primary path, and it is what keeps a FOREGROUND command
 *  that merely mentions the field (`grep '"run_in_background": true' *.js`, which is
 *  a real command to run in this very repo) from registering as a launch. */
function parseToolInput(toolInput) {
  if (toolInput && typeof toolInput === 'object') return toolInput;
  if (typeof toolInput !== 'string') return null;
  try { return JSON.parse(toolInput); } catch { return null; }
}

/** True when the tool call starts a background shell. */
function isBackgroundLaunch(toolName, toolInput) {
  if (toolName !== 'Bash') return false;
  const v = parseToolInput(toolInput);
  // A parsed object is authoritative: the flag is a TOP-LEVEL field, so a command
  // string that happens to contain those bytes cannot reach this branch.
  if (v && typeof v === 'object') return v.run_in_background === true;
  // Only when the input did not parse at all. A missed launch strands the task,
  // which is the failure this module exists to stop.
  return typeof toolInput === 'string' && /"run_in_background"\s*:\s*true/.test(toolInput);
}

/** True when the tool call collects a background shell's result. */
function isBackgroundHarvest(toolName, toolInput) {
  // Either ends the agent's relationship with that shell: one reads it, one kills it.
  if (toolName === 'BashOutput' || toolName === 'KillShell') return true;
  if (toolName !== 'Read') return false;
  const v = parseToolInput(toolInput);
  const p = v && typeof v === 'object' ? v.file_path : null;
  return typeof p === 'string' && BG_OUTPUT_PATH_RE.test(p);
}

/** Should the loop spend one more run harvesting a background task?
 *  @param {object} o
 *  @param {string} [o.subtype]   result subtype of the run that just ended
 *  @param {number} [o.launches]  background shells started in THAT run
 *  @param {number} [o.harvests]  background results collected in THAT run
 *  @param {number} [o.nudges]    how many nudges this turn already spent
 *  @param {boolean} [o.aborted]  user pressed Stop
 *  @param {number} [o.maxNudges]
 */
function shouldNudgeBackgroundWait({ subtype, launches = 0, harvests = 0, nudges = 0, aborted = false, maxNudges = MAX_BACKGROUND_NUDGES } = {}) {
  if (aborted) return false;
  // Only a clean finish. Every other subtype already has its own ladder rung, and
  // stacking this on top would spend the auto-continue budget twice for one stop.
  if (subtype !== 'success') return false;
  // An agent that collected everything it started is not owed a rescue run — it did
  // exactly what BACKGROUND_TASK_INSTRUCTION asked of it.
  if (launches <= harvests) return false;
  return nudges < maxNudges;
}

/** A sentence for the user when the rescue run ALSO walked away from a background
 *  task, or null when nothing is stranded. The nudge is bounded, so this is what
 *  keeps the bound from turning back into the original silent-"Done" bug: the turn
 *  says what was left running instead of claiming completion. */
function describeStrandedBackgroundTask({ launches = 0, harvests = 0, nudges = 0 } = {}) {
  if (nudges < MAX_BACKGROUND_NUDGES) return null;
  if (launches <= harvests) return null;
  const n = launches - harvests;
  return `${n} background task${n === 1 ? ' is' : 's are'} still running and ${n === 1 ? 'its' : 'their'} output was never collected. ` +
    'A turn does not resume here, so nothing will pick it up — send another message to have the agent read it, ' +
    'or check it yourself in the working directory.';
}

/** A sentence for the user when `error_max_turns` did not come from our budget,
 *  or null when the stop is consistent with the cap we asked for.
 *  @param {object} o
 *  @param {string} [o.subtype]
 *  @param {number} [o.numTurns]           num_turns the CLI reported
 *  @param {number} [o.requestedMaxTurns]  what we passed as --max-turns
 */
function describeTurnBudgetAnomaly({ subtype, numTurns, requestedMaxTurns } = {}) {
  if (subtype !== 'error_max_turns') return null;
  if (!Number.isFinite(numTurns) || !Number.isFinite(requestedMaxTurns)) return null;
  if (numTurns <= 0 || requestedMaxTurns <= 0) return null;
  // Half the budget is the threshold, not "anything below the cap": a run can stop
  // one or two turns short for ordinary reasons, and a warning that fires on those
  // would be noise on every long chat.
  if (numTurns * 2 >= requestedMaxTurns) return null;
  return `the run stopped after ${numTurns} turn${numTurns === 1 ? '' : 's'} although it was given ${requestedMaxTurns} — ` +
    'the turn limit is NOT coming from this chat\'s "Max turns", so raising it will not help. ' +
    'Check the Claude CLI version and any settings.json / hooks on the machine the agent runs on.';
}

module.exports = {
  MAX_BACKGROUND_NUDGES,
  BACKGROUND_WAIT_PROMPT,
  BG_OUTPUT_PATH_RE,
  isBackgroundLaunch,
  isBackgroundHarvest,
  shouldNudgeBackgroundWait,
  describeStrandedBackgroundTask,
  describeTurnBudgetAnomaly,
};
