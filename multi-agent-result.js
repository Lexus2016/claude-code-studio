// Pure decision helpers for multi-agent sub-agent runs.
//
// Extracted from runMultiAgent so the branching is unit-testable: server.js exports
// nothing and starts a listening server on require, so its internals cannot be imported.
//
// The Claude CLI reports why a run stopped in the final `result` frame's `subtype`
// ("success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | …).
// A stream that merely ended is NOT proof of success — a subprocess killed mid-run emits
// no result frame at all, so a missing frame must count as unfinished, not as success.

const MAX_TURNS_SUBTYPE = 'error_max_turns';

// Success requires an explicit success subtype. Mirrors runCliSingle / taskWorker.
function isAgentSuccess(result, errored) {
  if (errored) return false;
  return result?.subtype === 'success';
}

// Only a turn-budget exhaustion is worth resuming; a crash or a budget error is not.
function shouldAutoContinue(result, errored, continuesUsed, maxContinues) {
  if (errored) return false;
  if (result?.subtype !== MAX_TURNS_SUBTYPE) return false;
  return continuesUsed < maxContinues;
}

// Human-readable reason shown to the user and appended to the agent's stored output.
function agentStopReason(result, errored, turnCap, continuesUsed = 0) {
  if (errored) return 'failed — see the error above';
  if (result?.subtype === MAX_TURNS_SUBTYPE) {
    return continuesUsed > 0
      ? `still hit the ${turnCap}-turn limit after ${continuesUsed} auto-continues`
      : `hit the ${turnCap}-turn limit`;
  }
  if (result?.subtype) return `stopped early (${result.subtype})`;
  return 'was stopped before it reported completion';
}

module.exports = { isAgentSuccess, shouldAutoContinue, agentStopReason, MAX_TURNS_SUBTYPE };
