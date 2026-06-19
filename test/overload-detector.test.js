// One-off verification for rate-limit-utils (no test framework wired in this project).
// Run: node test/overload-detector.test.js
const assert = require('assert');
const { isTransientOverload, shouldRetryOverload } = require('../rate-limit-utils');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    pass++; console.log(`  ok   ${label}`);
  } catch {
    fail++; console.error(`  FAIL ${label} — expected ${expected}, got ${actual}`);
  }
}

const REPORTED = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';

console.log('isTransientOverload — POSITIVES:');
check('reported error string', isTransientOverload(REPORTED), true);
check('temporarily limiting phrase', isTransientOverload('Server is temporarily limiting requests, retry.'), true);
check('not-your-usage-limit phrase', isTransientOverload('transient (not your usage limit).'), true);
check('overloaded_error api type', isTransientOverload('{"error":{"type":"overloaded_error"}}'), true);

console.log('isTransientOverload — NEGATIVES (false-positive guards):');
check('agent prose mentioning rate limiting + 429', isTransientOverload("I'll add rate limiting returning 429."), false);
check('server was overloaded prose', isTransientOverload('The server was overloaded yesterday.'), false);
check('real usage-quota prose', isTransientOverload("You've reached your usage limit. Resets at 5pm."), false);
check('too many requests prose', isTransientOverload('too many requests in the log to count.'), false);
check('empty', isTransientOverload(''), false);
check('null', isTransientOverload(null), false);
check('non-string', isTransientOverload(12345), false);

console.log('shouldRetryOverload — DECISION MATRIX:');
// The bug case: throttle reported with an error subtype -> retry
check('overload + error_during_execution -> retry',
  shouldRetryOverload({ texts: [REPORTED], subtype: 'error_during_execution', isError: true }), true);
// Clean success that merely contains the phrase (user asking about the error) -> DO NOT retry
check('overload phrase + clean success -> NO retry',
  shouldRetryOverload({ texts: [`Sure! "${REPORTED}" means the API is throttling you.`], subtype: 'success', isError: false }), false);
// Success but flagged is_error -> retry
check('overload + success+is_error -> retry',
  shouldRetryOverload({ texts: [REPORTED], subtype: 'success', isError: true }), true);
// Structured usage-quota rejection in play -> DO NOT retry here (own reset-based wait)
check('overload + quota rejected -> NO retry (quota path)',
  shouldRetryOverload({ texts: [REPORTED], subtype: 'error_during_execution', isError: true, rateLimitRejected: true }), false);
// No overload signature at all -> no retry
check('no signature + error -> NO retry',
  shouldRetryOverload({ texts: ['ordinary partial answer'], subtype: 'error_during_execution', isError: true }), false);
// Signature only in the error-text channel -> retry
check('signature in errorText channel -> retry',
  shouldRetryOverload({ texts: ['', '', REPORTED], subtype: 'error_during_execution', isError: true }), true);
// resultData null-ish (subtype/isError undefined) + signature -> not a clean success -> retry
check('undefined subtype + signature -> retry',
  shouldRetryOverload({ texts: [REPORTED] }), true);
// Empty/omitted args -> false (defensive)
check('no args -> false', shouldRetryOverload(), false);
check('empty texts -> false', shouldRetryOverload({ texts: [], subtype: 'error_during_execution', isError: true }), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
