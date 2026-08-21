// Issue #27 — an account usage limit must not finish a task as "Done".
//
// The CLI ends a quota-stopped turn with subtype:'success' and a banner as its whole
// output ("You've hit your session limit · resets 11pm (Europe/Paris)"), so the task
// worker's old `subtype === 'success' && !hasError` check moved the Kanban card to Done
// while the work was unfinished. rate-limit-utils.js now owns that decision.
//
// The other half of the contract: these detectors must stay DISJOINT from the transient
// server-overload detector (isTransientOverload) — "Server is temporarily limiting
// requests (not your usage limit)" is a 20s backoff, not a quota rejection, and the
// phrase "not your usage limit" literally contains "usage limit".
//
// Run: node test/usage-limit.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  isUsageLimit, isTransientOverload, parseResetTime, detectUsageLimit, taskStatusForStop,
} = require('../rate-limit-utils');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const SESSION_LIMIT = "You've hit your session limit · resets 11pm (Europe/Paris)";
const TRANSIENT = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';

// ── 1. Detection positives ──────────────────────────────────────────────────
console.log('isUsageLimit — the messages named in the issue:');
check('session limit banner (verbatim from the issue)', isUsageLimit(SESSION_LIMIT), true);
check("You've hit your session limit", isUsageLimit("You've hit your session limit"), true);
check("You've reached your usage limit", isUsageLimit("You've reached your usage limit"), true);
check('Rate limit exceeded', isUsageLimit('Rate limit exceeded'), true);
check('case-insensitive', isUsageLimit("YOU'VE HIT YOUR SESSION LIMIT"), true);
check('curly apostrophe', isUsageLimit('You’ve reached your usage limit'), true);
check('you have reached your weekly limit', isUsageLimit('You have reached your weekly limit'), true);
check('Claude usage limit reached', isUsageLimit('Claude usage limit reached|1755808800'), true);
check('5-hour limit reached', isUsageLimit('Your 5-hour limit reached, try later'), true);
check('provider quota exceeded', isUsageLimit('429 You exceeded your current quota, please check your plan'), true);
check('provider insufficient_quota', isUsageLimit('{"error":{"code":"insufficient_quota"}}'), true);
check('provider quota exceeded (bare)', isUsageLimit('Quota exceeded for quota metric'), true);
check('credit balance too low', isUsageLimit('Your credit balance is too low to access the API'), true);
check('embedded mid-text', isUsageLimit("Wrote the file.\n\nYou've hit your session limit · resets 11pm (Europe/Paris)\n"), true);

// ── 2. Detection negatives — the transient overload stays with its own detector ──
console.log('\nisUsageLimit — must NOT claim the transient-overload strings:');
check('reported transient error string', isUsageLimit(TRANSIENT), false);
check('temporarily limiting requests', isUsageLimit('Server is temporarily limiting requests, retry.'), false);
check('not-your-usage-limit phrase', isUsageLimit('transient (not your usage limit).'), false);
check('overloaded_error api type', isUsageLimit('{"error":{"type":"overloaded_error"}}'), false);
check('the transient detector still owns that string', isTransientOverload(TRANSIENT), true);
check('the quota detector and the overload detector never both fire',
  [SESSION_LIMIT, TRANSIENT].map(x => `${isUsageLimit(x)}/${isTransientOverload(x)}`),
  ['true/false', 'false/true']);

console.log('\nisUsageLimit — false-positive guards:');
check('agent prose about implementing rate limiting', isUsageLimit("I'll add rate limiting returning 429."), false);
check('agent prose about a quota field', isUsageLimit('The quota column is nullable.'), false);
check('prose that merely says limit', isUsageLimit('There is no limit on the number of retries.'), false);
check('empty', isUsageLimit(''), false);
check('null', isUsageLimit(null), false);
check('non-string', isUsageLimit(12345), false);

// ── 3. Reset-time parsing ───────────────────────────────────────────────────
// Fixed reference instant so the assertions do not drift with the wall clock:
// 2026-08-21T12:00:00Z = 14:00 in Europe/Paris (CEST, UTC+2).
console.log('\nparseResetTime — "· resets 11pm (Europe/Paris)":');
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const r = parseResetTime(SESSION_LIMIT, NOW);
check('parses the banner', !!r, true);
check('hour normalised to 24h', r && r.hour, 23);
check('minute defaults to 0', r && r.minute, 0);
check('timezone captured', r && r.timeZone, 'Europe/Paris');
check('23:00 Paris today = 21:00Z today', r && r.epochSeconds, Date.UTC(2026, 7, 21, 21, 0, 0) / 1000);
const rPast = parseResetTime('resets 11am (Europe/Paris)', NOW);
check('a reset already past today rolls to tomorrow',
  rPast && rPast.epochSeconds, Date.UTC(2026, 7, 22, 9, 0, 0) / 1000);
const rUtc = parseResetTime('resets at 09:00 (UTC)', NOW);
check('explicit minutes + UTC zone', rUtc && rUtc.epochSeconds, Date.UTC(2026, 7, 22, 9, 0, 0) / 1000);
check('unknown zone still yields a future instant',
  parseResetTime('resets 11pm (Mars/Olympus)', NOW).epochSeconds > NOW / 1000, true);
check('no reset clause → null', parseResetTime("You've hit your session limit", NOW), null);
check('vague "resets soon" → null', parseResetTime('resets soon', NOW), null);
check('bare "resets 11" is not a wall clock → null', parseResetTime('resets 11', NOW), null);
check('impossible hour → null', parseResetTime('resets 25:00 (UTC)', NOW), null);

console.log('\ndetectUsageLimit — reason recorded for the paused task:');
const det = detectUsageLimit({ texts: ['...work...\n' + SESSION_LIMIT], now: NOW });
check('reason', det && det.reason, 'usage_limit');
check('message is the banner line', det && det.message, SESSION_LIMIT);
check('resetAt', det && det.resetAt, Date.UTC(2026, 7, 21, 21, 0, 0) / 1000);
check('timeZone', det && det.timeZone, 'Europe/Paris');
check('no reset time in the banner → resetAt null (caller falls back)',
  detectUsageLimit({ texts: ['Rate limit exceeded'], now: NOW }).resetAt, null);
check('clean run → null', detectUsageLimit({ texts: ['All tests pass.'], now: NOW }), null);
check('transient overload → null (handled by the retry path)',
  detectUsageLimit({ texts: [TRANSIENT], now: NOW }), null);

// ── 4. The task-status decision — the actual bug ────────────────────────────
console.log('\ntaskStatusForStop — a usage-limit stop must never be "done":');
check('THE BUG: quota banner + subtype success → paused, not done',
  taskStatusForStop({ texts: [SESSION_LIMIT], subtype: 'success', isError: false, now: NOW }), 'paused');
check('quota banner + error subtype → paused',
  taskStatusForStop({ texts: [SESSION_LIMIT], subtype: 'error_during_execution', isError: true, now: NOW }), 'paused');
check('quota banner only in the result payload → paused',
  taskStatusForStop({ texts: ['', 'Rate limit exceeded'], subtype: 'success', isError: false, now: NOW }), 'paused');
check('genuine success → done',
  taskStatusForStop({ texts: ['Task finished, tests green.'], subtype: 'success', isError: false, now: NOW }), 'done');
check('success flagged with an error → failed',
  taskStatusForStop({ texts: ['partial'], subtype: 'success', isError: true, now: NOW }), 'failed');
check('max-turns stop → failed',
  taskStatusForStop({ texts: ['partial'], subtype: 'error_max_turns', isError: false, now: NOW }), 'failed');
check('transient overload + success → done (its own retry path already ran)',
  taskStatusForStop({ texts: [TRANSIENT], subtype: 'success', isError: false, now: NOW }), 'done');
check('user stop wins over everything',
  taskStatusForStop({ texts: [SESSION_LIMIT], subtype: 'success', wasStopped: true, now: NOW }), 'cancelled');
check('no args → failed (defensive, never done)', taskStatusForStop(), 'failed');

// ── 5. Wiring — the worker must actually use the decision ───────────────────
// A unit-green detector wired to nothing would still ship the bug, and the worker's
// completion path is not reachable from a plain-node test without a live CLI run.
console.log('\nserver.js wiring:');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('imports the decision helpers', /require\('\.\/rate-limit-utils'\)/.test(src)
    && src.includes('detectUsageLimit') && src.includes('taskStatusForStop'), true);
  check('the worker derives isSuccess from taskStatusForStop',
    /const _stopStatus = taskStatusForStop\(/.test(src) && src.includes("const isSuccess = _stopStatus === 'done';"), true);
  check('no bare subtype-success completion check remains in the worker',
    src.includes("const isSuccess = lastTaskResult?.subtype === 'success' && !hasError;"), false);
  check('a usage-limit stop re-queues (status=todo + scheduled_at) instead of done',
    /UPDATE tasks SET status='todo', scheduled_at=\?, failure_reason=\?, usage_limit_pauses=/.test(src), true);
  check('failure_reason carries the parseable usage_limit prefix',
    src.includes('`usage_limit:${resumeAt}'), true);
  check('the pause column is added by a guarded ALTER TABLE',
    /try \{ db\.exec\(`ALTER TABLE tasks ADD COLUMN usage_limit_pauses INTEGER DEFAULT 0`\); \} catch \{\}/.test(src), true);
  check('auto-resume rides the existing scheduler (todo rows gated on scheduled_at)',
    src.includes("SELECT * FROM tasks WHERE status='todo' AND (scheduled_at IS NULL OR scheduled_at <= unixepoch())"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
