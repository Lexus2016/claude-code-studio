// Issue #86 — an expired OAuth session must stop the run, not burn the auto-continue budget.
//
// The report: "Failed to authenticate: OAuth session expired and could not be refreshed",
// work stops, nothing says why. The deeper defect is what the loops did with it: an auth
// failure is not subtype:'success', so all three agent loops AUTO-CONTINUED it. Each retry
// fails instantly with the identical error, the budget empties in seconds, and the card ends
// as a generic 'agent_incomplete' that names nothing. Chain tasks then retried twice more.
//
// This suite pins three things:
//   1. The classifier fires on the CLI/API wording and NOT on ordinary prose.
//   2. It stays DISJOINT from rate-limit-utils.js — a quota banner keeps its re-queue.
//   3. The detector sits BEFORE the auto-continue in every loop, and auth is excluded from
//      the chain retry. Those are ordering facts; a reorder silently restores the bug.
//
// Run: node test/auth-errors.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  isAuthError, classifyAuthError, detectAuthError, authErrorNotice,
} = require('../auth-errors');
const { isUsageLimit, isTransientOverload } = require('../rate-limit-utils');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// The exact line from the issue.
const REPORTED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const QUOTA = "You've hit your session limit · resets 11pm (Europe/Paris)";
const TRANSIENT = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';

// ── 1. Detection positives ──────────────────────────────────────────────────
console.log('isAuthError — the messages named in the issue:');
check('the reported line, verbatim', isAuthError(REPORTED), true);
check('OAuth session expired', isAuthError('OAuth session expired'), true);
check('could not be refreshed', isAuthError('The token could not be refreshed'), true);
check('OAuth token has expired', isAuthError('OAuth token has expired'), true);
check('refresh token is missing', isAuthError('refresh token is missing'), true);
check('refresh token expired', isAuthError('The refresh token expired 3 days ago'), true);
check('refresh token revoked', isAuthError('refresh token revoked by provider'), true);
check('failed to refresh access token', isAuthError('Failed to refresh the OAuth access token'), true);
check('Invalid API key', isAuthError('API Error: Invalid API key · Please run /login'), true);
check('authentication_error', isAuthError('{"type":"authentication_error","message":"..."}'), true);
check('authentication failed', isAuthError('Authentication failed'), true);
check('please run claude login', isAuthError('Please run `claude login`'), true);
check('not logged in to claude', isAuthError('You are not logged in to Claude'), true);
check('credentials are expired', isAuthError('credentials are expired'), true);
check('case-insensitive', isAuthError('OAUTH SESSION EXPIRED'), true);

// ── 2. False positives — the reason detection is anchored, not keyword-based ──
console.log('\nisAuthError — must NOT fire on ordinary text:');
check('empty', isAuthError(''), false);
check('non-string', isAuthError(null), false);
check('the studio\'s own /login route in server.js', isAuthError("app.get('/login', (_,res) => res.sendFile(...))"), false);
check('the studio\'s own unauthorized reply', isAuthError("return res.status(401).json({ error: 'unauthorized' })"), false);
check('a bare 401 mention', isAuthError('the endpoint answers 401'), false);
check('agent planning auth work', isAuthError('I will add OAuth support to the login page'), false);
check('the word token alone', isAuthError('the auth token is 32 bytes of hex'), false);

// ── 3. Disjoint from rate-limit-utils — each stop keeps its own handling ─────
// A quota stop re-queues at resetsAt; an overload backs off and retries. Reading either
// as an auth failure would strand work that would have resumed by itself.
console.log('\nDisjoint from the rate-limit classifiers:');
check('quota banner is not an auth error', isAuthError(QUOTA), false);
check('transient overload is not an auth error', isAuthError(TRANSIENT), false);
check('auth error is not a usage limit', isUsageLimit(REPORTED), false);
check('auth error is not a transient overload', isTransientOverload(REPORTED), false);

// ── 4. The clean-success guard ──────────────────────────────────────────────
// This repository's own issue #86, auth-errors.js and this very file contain the phrase,
// so an agent asked to read them reproduces it in a turn that SUCCEEDED. Ending that turn
// on "your credentials expired" would be a lie caused by the fix.
console.log('\nA clean success is never an auth stop:');
check('success + no error flag → null', detectAuthError({ texts: [REPORTED], subtype: 'success', isError: false }), null);
check('success but is_error → detected', detectAuthError({ texts: [REPORTED], subtype: 'success', isError: true })?.kind, 'oauth_refresh_failed');
check('error subtype → detected', detectAuthError({ texts: [REPORTED], subtype: 'error_during_execution', isError: true })?.kind, 'oauth_refresh_failed');
check('no texts → null', detectAuthError({ texts: [] }), null);
check('scans every candidate text', detectAuthError({ texts: ['', 'all fine', REPORTED], isError: true })?.reason, 'auth_error');

// ── 5. Root cause + action (the "display the root cause" ask) ────────────────
console.log('\nclassifyAuthError — root cause buckets:');
check('refresh failure is its own kind', classifyAuthError(REPORTED).kind, 'oauth_refresh_failed');
check('rejected key is its own kind', classifyAuthError('Invalid API key').kind, 'invalid_api_key');
check('never logged in is its own kind', classifyAuthError('You are not logged in to Claude').kind, 'not_logged_in');
check('unrecognised wording still classifies', classifyAuthError('Authentication failed').kind, 'auth_error');
check('every kind carries an action', ['oauth_refresh_failed', 'invalid_api_key', 'not_logged_in', 'auth_error']
  .map(k => [REPORTED, 'Invalid API key', 'not logged in to Claude', 'Authentication failed'])
  .flat().every(t => (classifyAuthError(t)?.hint || '').length > 20), true);
check('the snippet is the offending line only', classifyAuthError(`ok\nfine\n${REPORTED}\nmore`).message, REPORTED);
check('snippet is clipped', classifyAuthError('OAuth session expired ' + 'x'.repeat(400)).message.length <= 160, true);

// ── 6. The notice must be a real status line ────────────────────────────────
// statusLineKind() in public/index.html requires the `---` fence; without it the SPA
// stamps its own "✅ Done" badge over the warning (the run-continuation.js lesson).
console.log('\nauthErrorNotice:');
{
  const n = authErrorNotice(classifyAuthError(REPORTED));
  check('carries the --- status-line fence', n.includes('\n---\n'), true);
  check('states the action', n.includes('claude login'), true);
  check('says it is not retried', /not retried/i.test(n), true);
  check('quotes the original line', n.includes(REPORTED), true);
}

// ── 7. Structural pins on server.js ─────────────────────────────────────────
// Behaviour that lives in a 10k-line file and cannot be unit-tested without booting it.
// Needles are real statements, never comment prose (the chat-defaults lesson: a needle
// matched the comment explaining the rule and passed while the code was wrong).
console.log('\nserver.js integration:');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('imports the detector', /require\('\.\/auth-errors'\)/.test(src), true);
  check('imports both helpers used', src.includes('detectAuthError') && src.includes('authErrorNotice'), true);

  // Three call sites: CLI chat, SSH chat, taskWorker.
  const callSites = src.match(/detectAuthError\(\{/g) || [];
  check('detector is called in all three loops', callSites.length, 3);

  // ORDER — the actual fix. The detector must precede the auto-continue, or the run
  // spends its whole budget re-failing before anyone is told why.
  const iTaskDetect = src.indexOf('taskAuthStop = detectAuthError({');
  const iTaskSuccessBreak = src.indexOf("if (lastTaskResult?.subtype === 'success') break;");
  const iTaskContinue = src.indexOf('taskContinueCount++;');
  check('taskWorker: detector is present', iTaskDetect > 0, true);
  check('taskWorker: detector runs BEFORE the success break', iTaskDetect < iTaskSuccessBreak, true);
  check('taskWorker: detector runs BEFORE the auto-continue', iTaskDetect < iTaskContinue, true);

  const iChatDetect = src.indexOf('const authStop = detectAuthError({');
  const iChatSuccess = src.indexOf("if (resultData?.subtype === 'success') {");
  check('chat loop: detector is present', iChatDetect > 0, true);
  check('chat loop: detector runs BEFORE the success break', iChatDetect < iChatSuccess, true);

  // The SSH loop is the second pair; both must hold.
  const iChatDetect2 = src.indexOf('const authStop = detectAuthError({', iChatDetect + 1);
  const iChatSuccess2 = src.indexOf("if (resultData?.subtype === 'success') {", iChatSuccess + 1);
  check('ssh loop: detector is present', iChatDetect2 > 0, true);
  check('ssh loop: detector runs BEFORE the success break', iChatDetect2 < iChatSuccess2, true);

  // An auth stop must not be retried by the chain machinery.
  check('chain auto-retry excludes an auth stop',
    src.includes('task.chain_id && !usageLimitExhausted && !taskAuthStop &&'), true);
  // The card names the cause, with a parseable prefix like the usage_limit one.
  check('failure_reason carries the auth_error prefix',
    src.includes('`auth_error:${taskAuthStop.kind}'), true);
  check('the auth stop is logged with its kind',
    /log\.error\('auth-failure', \{ sessionId, kind:/.test(src), true);
}

// ── 8. The Kanban card must say why (public/kanban.html) ────────────────────
// Without a badge an auth stop is indistinguishable from an ordinary failure, which is
// the "nothing tells me why" half of the report. kbAuthStop is lifted out and run, the
// way kanban-run-badges.test.js does, so the parser is tested rather than eyeballed.
console.log('\nkanban.html auth badge:');
{
  const kb = fs.readFileSync(path.join(__dirname, '..', 'public', 'kanban.html'), 'utf8');
  const m = /function kbAuthStop\(tk\)\{[\s\S]*?\n\}/.exec(kb);
  check('kbAuthStop exists', !!m, true);
  const kbAuthStop = new Function(`${m[0]}; return kbAuthStop;`)();

  check('parses kind and message', kbAuthStop({ failure_reason: 'auth_error:oauth_refresh_failed ' + REPORTED }),
    { kind: 'oauth_refresh_failed', message: REPORTED });
  check('kind only', kbAuthStop({ failure_reason: 'auth_error:not_logged_in' }), { kind: 'not_logged_in', message: '' });
  check('bare prefix', kbAuthStop({ failure_reason: 'auth_error' }), { kind: 'auth_error', message: '' });
  check('a usage-limit reason is not an auth stop', kbAuthStop({ failure_reason: 'usage_limit:123 banner' }), null);
  check('an ordinary failure is not an auth stop', kbAuthStop({ failure_reason: 'agent_incomplete' }), null);
  check('no reason', kbAuthStop({ failure_reason: null }), null);
  check('no task', kbAuthStop(null), null);
  check('message is clipped', kbAuthStop({ failure_reason: 'auth_error:k ' + 'x'.repeat(400) }).message.length, 160);

  // The badge has to be rendered, not just computed.
  check('the badge is in the card footer', /\$\{projBadge\}\$\{pausedBadge\}\$\{authBadge\}/.test(kb), true);
  check('every language has the badge strings',
    (kb.match(/'card\.auth'/g) || []).length, (kb.match(/'card\.paused'/g) || []).length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
