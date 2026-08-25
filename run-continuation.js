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
//    THE DEBT IS INCREMENTAL AND TURN-LEVEL. Four earlier shapes were wrong, each
//    in a way the next had to fix:
//      - a one-way `bgLaunched` latch charged an extra run to every agent that
//        OBEYED the system prompt (launch, collect, finish) — worse than the bug;
//      - PER-RUN counters made the rescue run start from zero, so an agent that
//        walked away a second time WITHOUT touching a tool reported nothing owed,
//        looked clean, and the turn said "Done" one run later;
//      - raw CALL counts let two polls of one job cancel a second, genuinely
//        abandoned launch;
//      - a BATCH total, `max(0, launches - harvests)`, BANKED a harvest that had no
//        launch behind it. Reading a leftover `tasks/<id>.output` from an earlier
//        turn — often the first thing a resumed session does — then launching a
//        shell and walking away came out at zero owed. No rescue, no warning, Done.
//    So a harvest decrements only a debt that already exists, and only once per
//    shell id. A surplus harvest is DROPPED, never banked.
//
//    Measured on CLI 2.1.231, a background launch answers "Output is being written
//    to: <cwd-hash>/<uuid>/tasks/<id>.output" and the agent harvests by READING that
//    file — `BashOutput` is not called at all — so the harvest side recognises that
//    read and takes the id out of the path.
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
 *  harvesting read looks like: `<project-hash>/<session-uuid>/tasks/<id>.output`.
 *  The capture group is the shell id, which is what deduplicates repeated polls. */
const BG_OUTPUT_PATH_RE = /\/tasks\/([A-Za-z0-9_-]+)\.output$/;

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

/** The shell id this tool call collects, or null when it is not a harvest — or is
 *  one whose id cannot be read.
 *
 *  An unidentifiable harvest returns null ON PURPOSE, i.e. it does not pay down the
 *  debt. `bash_id` is a required parameter of `BashOutput`, so this only happens on a
 *  malformed or unparsed payload; crediting it would let two such calls cancel a
 *  second launch that really was abandoned. The cost of not crediting it is one
 *  short rescue run, which is the cheaper mistake.
 *
 *  `View` is accepted alongside `Read`: it is the name in this project's allowedTools
 *  lists, and an agent that used it would otherwise look like it collected nothing. */
function backgroundHarvestId(toolName, toolInput) {
  const v = parseToolInput(toolInput);
  const o = v && typeof v === 'object' ? v : null;
  if (toolName === 'BashOutput' || toolName === 'KillShell') {
    const id = o && (o.bash_id || o.shell_id);
    return typeof id === 'string' && id ? id : null;
  }
  if (toolName !== 'Read' && toolName !== 'View') return null;
  const p = o ? (o.file_path || o.path) : null;
  if (typeof p !== 'string') return null;
  const m = BG_OUTPUT_PATH_RE.exec(p);
  return m ? m[1] : null;
}

/** The turn's background bookkeeping. `debt` is what has been launched and not
 *  collected; `seen` are the shell ids already credited, so repeated polling of one
 *  job pays the debt down once rather than once per call. */
function newBackgroundState() {
  return { debt: 0, seen: new Set() };
}

/** Fold one tool call into the turn's state. The whole rule lives here rather than
 *  in the two run loops: an open-coded copy is how a `''`/null distinction or an
 *  unbanked-surplus rule silently drifts between the local and the remote path.
 *  Returns the state, mutated. */
function applyBackgroundTool(state, toolName, toolInput) {
  if (!state) return state;
  if (isBackgroundLaunch(toolName, toolInput)) { state.debt++; return state; }
  const id = backgroundHarvestId(toolName, toolInput);
  if (id === null) return state;
  if (state.seen.has(id)) return state;
  state.seen.add(id);
  // Decrement only an EXISTING debt. A harvest with nothing behind it — a read of an
  // earlier turn's log — is dropped, so it cannot pay for a launch that comes later.
  if (state.debt > 0) state.debt--;
  return state;
}

/** How many background tasks this turn started and never collected. */
function backgroundOutstanding(state) {
  return state && Number.isFinite(state.debt) ? Math.max(0, state.debt) : 0;
}

/** Should the loop spend one more run harvesting a background task?
 *  @param {object} o
 *  @param {string} [o.subtype]      result subtype of the run that just ended
 *  @param {number} [o.outstanding]  turn-level launches minus harvests
 *  @param {number} [o.nudges]       how many nudges this turn already spent
 *  @param {boolean} [o.aborted]     user pressed Stop
 *  @param {number} [o.maxNudges]
 */
function shouldNudgeBackgroundWait({ subtype, outstanding = 0, nudges = 0, aborted = false, maxNudges = MAX_BACKGROUND_NUDGES } = {}) {
  if (aborted) return false;
  // Only a clean finish. Every other subtype already has its own ladder rung, and
  // stacking this on top would spend the auto-continue budget twice for one stop.
  if (subtype !== 'success') return false;
  // An agent that collected everything it started is not owed a rescue run — it did
  // exactly what BACKGROUND_TASK_INSTRUCTION asked of it.
  if (outstanding <= 0) return false;
  return nudges < maxNudges;
}

/** A sentence for the user when the turn ends with background work still owed, or
 *  null when nothing is outstanding. Reads the SAME turn-level debt the nudge reads,
 *  which is the whole point: a rescue run that answered in text and collected nothing
 *  leaves the debt exactly where it was, so this fires. A per-run count reset to zero
 *  there and let the turn claim success — the original bug, one run later. */
function describeStrandedBackgroundTask({ outstanding = 0, nudges = 0 } = {}) {
  if (nudges < MAX_BACKGROUND_NUDGES) return null;
  if (outstanding <= 0) return null;
  return `${outstanding} background task${outstanding === 1 ? ' is' : 's are'} still running and ${outstanding === 1 ? 'its' : 'their'} output was never collected. ` +
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
  backgroundHarvestId,
  newBackgroundState,
  applyBackgroundTool,
  backgroundOutstanding,
  shouldNudgeBackgroundWait,
  describeStrandedBackgroundTask,
  describeTurnBudgetAnomaly,
};
