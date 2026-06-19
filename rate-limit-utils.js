// Rate-limit / overload classification helpers.
//
// There are TWO distinct "rate limit" situations from the Claude API/CLI:
//
//   1. Account usage-quota limit — you ran out of your plan's allowance. The CLI
//      emits a structured `rate_limit_event` with a `resetsAt` timestamp. This can
//      be hours away and is handled by the reset-based wait in server.js.
//
//   2. Transient server-side throttle (HTTP 429/529 "overloaded") — the server is
//      briefly limiting requests, NOT your usage. The CLI surfaces this as ordinary
//      assistant text or inside the final `result` payload (NOT via stderr), e.g.:
//        "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
//      The correct response is a short pause (~15–30s) and a retry.
//
// This module detects case (2) with a TIGHT signature so it never false-triggers on
// agent output that merely *mentions* rate limiting (e.g. "I'll add a 429 handler").
// The anchor phrases below are API/CLI-internal strings that do not occur in normal prose.

const TRANSIENT_OVERLOAD_RE = /temporarily limiting requests|not your usage limit|overloaded_error/i;

/**
 * True when `text` carries the signature of a transient server-side overload/throttle
 * (HTTP 429/529), as opposed to an account usage-quota limit.
 * @param {string} text - assistant text, result payload, or error text to inspect
 * @returns {boolean}
 */
function isTransientOverload(text = '') {
  if (!text || typeof text !== 'string') return false;
  return TRANSIENT_OVERLOAD_RE.test(text);
}

/**
 * Decide whether a finished agent turn should be retried because of a transient server
 * overload. This is the single source of truth for the overload-retry decision used by
 * every agent loop (chat / SSH / task worker), so the guards stay consistent and testable.
 *
 * Returns true ONLY when:
 *   - an overload signature appears in any candidate text, AND
 *   - the turn is NOT a clean success (subtype 'success' with no is_error flag) — this
 *     stops us from retrying a genuinely successful turn whose output merely contains the
 *     phrase, e.g. the user asking "what does 'Server is temporarily limiting requests' mean?", AND
 *   - it is NOT a structured usage-quota rejection (that has its own longer reset-based wait).
 *
 * @param {object} o
 * @param {string[]} [o.texts] - candidate texts (assistant output, result payload, error text)
 * @param {string} [o.subtype] - result subtype (e.g. 'success', 'error_during_execution')
 * @param {boolean} [o.isError] - the result.is_error flag
 * @param {boolean} [o.rateLimitRejected] - true when a structured usage-quota rejection is in play
 * @returns {boolean}
 */
function shouldRetryOverload({ texts = [], subtype, isError, rateLimitRejected = false } = {}) {
  const overloaded = texts.some(t => isTransientOverload(t));
  const cleanSuccess = subtype === 'success' && !isError;
  return overloaded && !cleanSuccess && !rateLimitRejected;
}

module.exports = { isTransientOverload, shouldRetryOverload, TRANSIENT_OVERLOAD_RE };
