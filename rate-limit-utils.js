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

// ─── Account usage-quota limits (case 1 above) ───────────────────────────────
//
// The CLI can end a turn with subtype:'success' while the visible output is nothing
// but a quota banner, e.g.
//   "You've hit your session limit · resets 11pm (Europe/Paris)"
// The task worker used to read that as a completed task and moved the Kanban card to
// Done (issue #27). These helpers give it a single, testable way to tell the two apart.
//
// The signatures below are deliberately DISJOINT from TRANSIENT_OVERLOAD_RE: the phrase
// "not your usage limit" belongs to the transient throttle and must never be read as a
// quota rejection, so the transient phrases are stripped from the text before matching.

const TRANSIENT_OVERLOAD_RE_G = /temporarily limiting requests|not your usage limit|overloaded_error/gi;

const USAGE_LIMIT_RE = new RegExp([
  // Claude CLI banner — "You've hit your session limit", "You've reached your usage limit",
  // "You have reached your weekly limit". Up to 3 words between "your" and "limit" keeps
  // this anchored to the banner and off ordinary prose.
  "you\\s*['’]?\\s*ve\\s+(?:hit|reached|used\\s+up)\\s+your\\s+(?:[\\w%-]+\\s+){0,3}limit",
  "you\\s+have\\s+(?:hit|reached|used\\s+up)\\s+your\\s+(?:[\\w%-]+\\s+){0,3}limit",
  // "Claude usage limit reached", "5-hour limit reached", "weekly limit reached"
  "(?:usage|session|weekly|monthly|daily|hour|opus|sonnet|token|message)\\s+limit\\s+reached",
  // Provider 429 / quota bodies
  "rate\\s+limit\\s+exceeded",
  "quota\\s+exceeded",
  "exceeded\\s+your\\s+(?:current\\s+)?quota",
  "insufficient_quota",
  "usage_limit_reached",
  "out\\s+of\\s+(?:credits|quota)",
  "credit\\s+balance\\s+is\\s+too\\s+low",
].join('|'), 'i');

// "· resets 11pm (Europe/Paris)", "resets at 5pm", "resets 09:00 (UTC)".
// A bare "resets 11" is rejected: without minutes or am/pm it is not a wall clock.
const RESET_TIME_RE = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]{1,40})\))?/i;

/** Strip the transient-throttle phrases so they can never satisfy USAGE_LIMIT_RE. */
function withoutTransientPhrases(text) {
  return String(text).replace(TRANSIENT_OVERLOAD_RE_G, ' ');
}

/**
 * True when `text` carries an ACCOUNT usage-quota rejection (session / weekly / provider
 * quota), as opposed to the transient server throttle owned by isTransientOverload().
 * @param {string} text
 * @returns {boolean}
 */
function isUsageLimit(text = '') {
  if (!text || typeof text !== 'string') return false;
  return USAGE_LIMIT_RE.test(withoutTransientPhrases(text));
}

/** Offset of `timeZone` from UTC at `atMs`, in ms; null when the zone is unknown. */
function tzOffsetMs(timeZone, atMs) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    for (const part of dtf.formatToParts(new Date(atMs))) p[part.type] = part.value;
    let h = Number(p.hour);
    if (h === 24) h = 0; // some ICU builds render midnight as 24
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, Number(p.minute), Number(p.second));
    return asUtc - atMs;
  } catch { return null; }
}

/**
 * Next occurrence of the wall clock hour:minute in `timeZone` (local time when the zone is
 * absent or unknown), as unix seconds. The zone offset is sampled at `now`, so a reset that
 * sits on the other side of a DST switch can be off by an hour — acceptable, because the
 * worker only uses it to decide when to re-queue, and the scheduler re-checks every 15s.
 */
function nextWallClock(hour, minute, timeZone, now) {
  const tzOff = timeZone ? tzOffsetMs(timeZone, now) : null;
  const off = tzOff == null ? -new Date(now).getTimezoneOffset() * 60000 : tzOff;
  const shifted = new Date(now + off); // read with getUTC* to see the target zone's wall clock
  let target = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, minute, 0) - off;
  if (target <= now) target += 86400000;
  return Math.floor(target / 1000);
}

/**
 * Parse "· resets 11pm (Europe/Paris)" out of a limit banner.
 * @param {string} text
 * @param {number} [now] - reference instant (ms), injectable for tests
 * @returns {{raw:string, hour:number, minute:number, timeZone:string|null, epochSeconds:number}|null}
 */
function parseResetTime(text = '', now = Date.now()) {
  if (!text || typeof text !== 'string') return null;
  const m = RESET_TIME_RE.exec(text);
  if (!m) return null;
  if (!m[2] && !m[3]) return null; // neither minutes nor am/pm — not a wall clock
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;
  const timeZone = m[4] ? m[4].trim() : null;
  if (!Number.isFinite(hour) || minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return { raw: m[0], hour, minute, timeZone, epochSeconds: nextWallClock(hour, minute, timeZone, now) };
}

/** The single line that carries the limit banner, clipped for storage in failure_reason. */
function usageLimitSnippet(text) {
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (USAGE_LIMIT_RE.test(withoutTransientPhrases(line))) return line.trim().substring(0, 160);
  }
  return String(text).trim().substring(0, 160);
}

/**
 * Inspect the texts of a finished turn for an account usage-limit stop.
 * @param {object} o
 * @param {string[]} [o.texts] - candidate texts (turn tail, result payload, error text)
 * @param {number} [o.now] - reference instant (ms), injectable for tests
 * @returns {{reason:'usage_limit', message:string, resetAt:number|null, timeZone:string|null}|null}
 */
function detectUsageLimit({ texts = [], now = Date.now() } = {}) {
  for (const raw of texts) {
    if (!isUsageLimit(raw)) continue;
    const snippet = usageLimitSnippet(raw);
    // Prefer the reset time on the banner line; fall back to the 200 chars that follow it.
    const idx = withoutTransientPhrases(raw).search(USAGE_LIMIT_RE);
    const window = idx >= 0 ? String(raw).substring(idx, idx + 200) : '';
    const reset = parseResetTime(snippet, now) || parseResetTime(window, now);
    return {
      reason: 'usage_limit',
      message: snippet,
      resetAt: reset ? reset.epochSeconds : null,
      timeZone: reset ? reset.timeZone : null,
    };
  }
  return null;
}

/**
 * Terminal Kanban status for a finished task turn — the single source of truth behind the
 * #27 fix. A usage-limit stop returns 'paused' even when the CLI reported subtype 'success',
 * because the banner IS the whole output of that "successful" turn.
 *
 * 'paused' is written to the DB as status='todo' + scheduled_at=<reset>, which is what makes
 * the existing scheduler re-run the task by itself once the quota is back.
 *
 * @param {object} o
 * @param {string[]} [o.texts]
 * @param {string} [o.subtype] - result subtype
 * @param {boolean} [o.isError] - the turn raised an error
 * @param {boolean} [o.wasStopped] - the user stopped the task
 * @param {number} [o.now]
 * @returns {'cancelled'|'paused'|'done'|'failed'}
 */
function taskStatusForStop({ texts = [], subtype, isError = false, wasStopped = false, now = Date.now() } = {}) {
  if (wasStopped) return 'cancelled';
  if (detectUsageLimit({ texts, now })) return 'paused';
  return (subtype === 'success' && !isError) ? 'done' : 'failed';
}

module.exports = {
  isTransientOverload, shouldRetryOverload, TRANSIENT_OVERLOAD_RE,
  isUsageLimit, parseResetTime, detectUsageLimit, taskStatusForStop, usageLimitSnippet,
  USAGE_LIMIT_RE, RESET_TIME_RE,
};
