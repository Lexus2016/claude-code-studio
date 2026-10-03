'use strict';
/**
 * Catalog handling for an external agent's `models` / `efforts` lists.
 *
 * The Delegate dialog reads these arrays off the agent record, and
 * POST /api/delegate validates a chosen value against them — so the arrays are a
 * security boundary (the allow-list that stops `{model}` from smuggling a flag),
 * not just display data. One module, so the store, the endpoint and the browser
 * cannot drift into three slightly different answers.
 *
 * Extracted from server.js so it is unit-testable without booting anything — see
 * test/agent-catalog.test.js.
 */

const MAX_ENTRIES = 50;
const MAX_LEN = 64;

/**
 * Sanitise a catalog value that arrived from an HTTP body (PUT/POST). Lenient:
 * non-strings are dropped, entries are trimmed, de-duplicated, length-capped, an
 * entry that looks like an option (leading '-') is dropped, and
 * the list is bounded, so one hand-edited config cannot become an unbounded select.
 * A non-array is the CALLER's problem — the endpoint refuses it (400) rather than
 * coercing, because `"opus"` silently becoming `["opus"]` hides a bad edit.
 * @param {unknown} values
 * @returns {string[]}
 */
function sanitizeAgentCatalog(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values) {
    const s = typeof v === 'string' ? v.trim() : '';
    // A leading '-' is refused: a catalog entry becomes its own argv word through a
    // bare `{model}` / `{effort}`, so "-c" or "--dangerously-skip-permissions" would
    // arrive as a FLAG — the very thing the allow-list in /api/delegate exists to stop.
    if (s && s.length <= MAX_LEN && !s.startsWith('-') && !out.includes(s)) out.push(s);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/**
 * Parse the comma-separated text an `<input>` carries. The browser mirror of
 * sanitizeAgentCatalog — same trim / de-dup / cap — so the local `_externalAgents`
 * copy the SPA keeps never disagrees with what the server stored. An empty box
 * yields [], which the caller treats as a deliberate clear.
 * @param {string} value
 * @returns {string[]}
 */
function parseAgentCatalogInput(value) {
  return sanitizeAgentCatalog(String(value == null ? '' : value).split(','));
}

module.exports = { sanitizeAgentCatalog, parseAgentCatalogInput, MAX_ENTRIES, MAX_LEN };
