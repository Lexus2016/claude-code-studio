// Authentication-failure classification (issue #86).
//
// This is the THIRD class of "the turn stopped and it was not the agent's fault",
// alongside the two in rate-limit-utils.js, and it is the one the retry machinery
// handles worst:
//
//   1. Transient overload (429/529) — passes on its own. Pause ~15-30s, retry.
//   2. Account usage quota          — passes on its own. Re-queue at `resetsAt`.
//   3. Auth failure (THIS module)   — NEVER passes on its own. A human must
//                                     re-authenticate the `claude` CLI.
//
// The distinction matters because every agent loop ends a non-success turn by
// AUTO-CONTINUING. A run whose credentials have expired fails instantly, gets
// auto-continued, fails instantly again, and burns the whole MAX_AUTO_CONTINUES
// budget in seconds before reporting a generic failure that names nothing. That
// is what the user in #86 saw: work stops, the cause is not stated, and the only
// hint is a raw CLI line buried in the transcript.
//
// WHAT THIS MODULE DOES NOT DO — and cannot. It does not refresh anything. The
// OAuth tokens belong to the `claude` CLI (its own credentials store); the refresh
// exchange needs a refresh token and client credentials this server has never held
// and must not hold. So "the session should refresh automatically" is the CLI's job,
// and when it reports that the refresh FAILED, the only correct move here is to stop
// immediately and say exactly what the human has to do. Detecting it precisely and
// refusing to retry IS the fix.
//
// ── False positives are the real design risk ──────────────────────────────────
// These strings are English CLI/API text, and an agent discussing this very issue
// will reproduce them verbatim — this repository's own issue #86, this file, and its
// test all contain the phrase "OAuth session expired". So detection is anchored to
// CLI/API-internal wording that does not occur in ordinary prose, and — exactly like
// shouldRetryOverload() — a CLEAN SUCCESS is never classified as an auth failure.
// A turn that ended well cannot have been blocked by authentication, whatever its
// text says.

// Anchors are deliberately DISJOINT from rate-limit-utils.js: a quota rejection is
// not an auth failure and must keep its reset-based re-queue.
//
// Intentionally NOT matched: a bare "/login" or "unauthorized". This project serves
// its own `/login` route and answers `{error:'unauthorized'}` from its own auth
// middleware, so either one would fire on a run that merely reads server.js.
const AUTH_ERROR_RE = new RegExp([
  // The #86 report, verbatim: "OAuth session expired and could not be refreshed"
  "oauth\\s+session\\s+expired",
  "could\\s+not\\s+be\\s+refreshed",
  "oauth\\s+token\\s+(?:has\\s+)?expired",
  "refresh\\s+token\\s+(?:is\\s+)?(?:missing|expired|invalid|revoked)",
  "failed\\s+to\\s+refresh\\s+(?:the\\s+)?(?:oauth\\s+)?(?:access\\s+)?token",
  // Claude CLI / Anthropic API auth rejections
  "invalid\\s+api\\s+key",
  "authentication_error",
  "authentication\\s+failed",
  "invalid\\s+bearer\\s+token",
  "please\\s+run\\s+`?/?claude\\s+login`?",
  "please\\s+run\\s+`?/login`?",
  "run\\s+`?claude\\s+login`?\\s+to\\s+(?:re-?)?authenticate",
  "not\\s+logged\\s+in\\s+to\\s+claude",
  "credentials\\s+(?:are\\s+)?(?:invalid|expired)",
].join('|'), 'i');

/**
 * True when `text` carries the signature of an authentication failure.
 * @param {string} text - assistant text, result payload, or error text
 * @returns {boolean}
 */
function isAuthError(text = '') {
  if (!text || typeof text !== 'string') return false;
  return AUTH_ERROR_RE.test(text);
}

// Root-cause buckets, most specific first — the "display the root cause" ask in #86.
// Each carries the ACTION that resolves it, because "authentication failed" without
// a next step is the complaint the issue was filed about.
const AUTH_KINDS = [
  {
    kind: 'oauth_refresh_failed',
    re: /oauth\s+session\s+expired|could\s+not\s+be\s+refreshed|failed\s+to\s+refresh\s+(?:the\s+)?(?:oauth\s+)?(?:access\s+)?token|refresh\s+token\s+(?:is\s+)?(?:missing|expired|invalid|revoked)|oauth\s+token\s+(?:has\s+)?expired/i,
    label: 'OAuth session expired and the CLI could not refresh it',
    hint: 'Re-authenticate the Claude CLI: run `claude login` (in a studio terminal, or on the remote host for an SSH project).',
  },
  {
    kind: 'invalid_api_key',
    re: /invalid\s+api\s+key|invalid\s+bearer\s+token/i,
    label: 'The API key was rejected',
    hint: 'Check ANTHROPIC_API_KEY, or run `claude login` to use a subscription instead.',
  },
  {
    kind: 'not_logged_in',
    re: /not\s+logged\s+in\s+to\s+claude|please\s+run\s+`?\/?claude\s+login`?|please\s+run\s+`?\/login`?|run\s+`?claude\s+login`?\s+to\s+(?:re-?)?authenticate/i,
    label: 'The Claude CLI is not logged in',
    hint: 'Run `claude login` (in a studio terminal, or on the remote host for an SSH project).',
  },
];

/** The single line carrying the auth failure, clipped for storage in failure_reason. */
function authErrorSnippet(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (AUTH_ERROR_RE.test(line)) return line.trim().substring(0, 160);
  }
  return String(text).trim().substring(0, 160);
}

/**
 * Classify an auth failure found in `text`.
 * @param {string} text
 * @returns {{kind:string, label:string, hint:string, message:string}|null}
 */
function classifyAuthError(text = '') {
  if (!isAuthError(text)) return null;
  const snippet = authErrorSnippet(text);
  for (const k of AUTH_KINDS) {
    if (k.re.test(text)) return { kind: k.kind, label: k.label, hint: k.hint, message: snippet };
  }
  return {
    kind: 'auth_error',
    label: 'Authentication failed',
    hint: 'Re-authenticate the Claude CLI: run `claude login` (in a studio terminal, or on the remote host for an SSH project).',
    message: snippet,
  };
}

/**
 * Inspect a finished turn for an authentication stop.
 *
 * Returns null for a clean success even when the text matches — see the false-positive
 * note in the header. `isError`/`subtype` come from the CLI result payload, so this
 * mirrors shouldRetryOverload()'s guard exactly.
 *
 * @param {object} o
 * @param {string[]} [o.texts] - candidate texts (turn tail, result payload, stderr)
 * @param {string} [o.subtype] - result subtype (e.g. 'success', 'error_during_execution')
 * @param {boolean} [o.isError] - the result.is_error flag
 * @returns {{reason:'auth_error', kind:string, label:string, hint:string, message:string}|null}
 */
function detectAuthError({ texts = [], subtype, isError } = {}) {
  if (subtype === 'success' && !isError) return null;
  for (const raw of texts) {
    const c = classifyAuthError(raw);
    if (c) return { reason: 'auth_error', ...c };
  }
  return null;
}

/**
 * The chat notice for an auth stop. Written as a real status line (leading `---`
 * fence) because statusLineKind() in public/index.html requires it — without the
 * fence the SPA stamps its own "✅ Done" badge over the warning (the run-continuation.js
 * lesson).
 * @param {{label:string, hint:string, message:string}} info
 * @returns {string}
 */
function authErrorNotice(info) {
  return `\n\n---\n🔐 **${info.label}.** ${info.hint}\n\nThis is not retried: re-authentication needs a human, so retrying would only repeat the same failure.\n\n> ${info.message}\n\n`;
}

module.exports = {
  isAuthError, classifyAuthError, detectAuthError, authErrorNotice, authErrorSnippet,
  AUTH_ERROR_RE,
};
