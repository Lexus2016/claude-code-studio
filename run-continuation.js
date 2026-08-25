// Two decisions the single-agent run loops make AFTER a run comes back, both pure
// so they can be pinned without booting a server or an SSH host.
//
// 1. `shouldNudgeBackgroundWait` — a turn that ends on `subtype:'success'` is not
//    always a turn that finished the work. A run which launched a background shell
//    and then wrote "I'll wait for it and continue" ends as a clean `end_turn`, so
//    the auto-continue ladder never sees it (that ladder fires only on NON-success).
//    Nothing else resumes a headless `claude -p`: the process is gone and the
//    background shell went with it. The chat printed "✅ Done" over an unfinished
//    task and the user was left waiting for a continuation that could not arrive.
//
//    The detector is STRUCTURAL, never textual. User-facing text is written in the
//    UI language (buildSystemPrompt pins that explicitly), so a regex over English
//    phrases like "I'll check back" is dead on a French or Ukrainian install. A
//    `Bash` call carrying `run_in_background` is the same JSON in every language.
//
//    Scope is deliberately one run and one nudge: only a launch in the LAST run
//    counts (an early launch that the agent went on to harvest is not a wait), and
//    MAX_BACKGROUND_NUDGES caps the cost of a false positive at one short run.
//
// 2. `describeTurnBudgetAnomaly` — `error_max_turns` from a run that stopped far
//    below the budget we asked for means the limit did not come from this chat.
//    Measured against CLI 2.1.231: a run capped at N reports num_turns === N + 1,
//    so a genuine exhaustion lands AT the cap, never at a fraction of it. Telling
//    such a user to "raise Max turns" (issue #67) sends them to a dial that is
//    already high enough — the cap is being imposed somewhere else.
'use strict';

/** One nudge per turn. A false positive costs exactly one short run. */
const MAX_BACKGROUND_NUDGES = 1;

/** What the nudge run is asked to do. Names the tool, because the CLI routes a
 *  background shell's output to a file that the agent reads back rather than to
 *  the transcript, and an unprompted agent tends to re-run the command instead. */
const BACKGROUND_WAIT_PROMPT =
  'You ended your turn while a background task you started was still running. ' +
  'Nothing resumes a turn here, so it had to be picked up now. ' +
  'Retrieve that task\'s output (BashOutput, or read the log it writes to), wait for it to finish if it has not, ' +
  'and complete the remaining work. If it is already finished and nothing is left, say so in one line.';

/** True when the tool call is a background shell launch.
 *  `input` arrives as the raw JSON string the CLI streamed (the run loops truncate
 *  it for display, so match on a substring rather than parsing — a truncated object
 *  is not valid JSON, and JSON.parse would throw away the signal entirely). */
function isBackgroundLaunch(toolName, toolInput) {
  if (toolName !== 'Bash') return false;
  const s = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || '');
  return /"run_in_background"\s*:\s*true/.test(s);
}

/** Should the loop spend one more run harvesting a background task?
 *  @param {object} o
 *  @param {string} [o.subtype]            result subtype of the run that just ended
 *  @param {boolean} [o.backgroundLaunched] a background shell started in THAT run
 *  @param {number} [o.nudges]             how many nudges this turn already spent
 *  @param {boolean} [o.aborted]           user pressed Stop
 *  @param {number} [o.maxNudges]
 */
function shouldNudgeBackgroundWait({ subtype, backgroundLaunched, nudges = 0, aborted = false, maxNudges = MAX_BACKGROUND_NUDGES } = {}) {
  if (aborted) return false;
  // Only a clean finish. Every other subtype already has its own ladder rung, and
  // stacking this on top would spend the auto-continue budget twice for one stop.
  if (subtype !== 'success') return false;
  if (!backgroundLaunched) return false;
  return nudges < maxNudges;
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
  isBackgroundLaunch,
  shouldNudgeBackgroundWait,
  describeTurnBudgetAnomaly,
};
