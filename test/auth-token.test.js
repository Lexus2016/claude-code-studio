// auth.js is the whole wall: every /api route and both WebSocket endpoints sit
// behind validateToken(), and nothing tested the token lifecycle directly —
// setup-gate.test.js covers who may CLAIM the account, not what happens to a
// token afterwards.
//
// Runs against a THROWAWAY APP_DIR. auth.js resolves AUTH_FILE / SESSIONS_FILE
// from process.env.APP_DIR at require time, so it is set before the require and
// the developer's real data/auth.json is never touched.
//
// Run: node test/auth-token.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-authtok-'));
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
process.env.APP_DIR = APP_DIR;
delete process.env.CCS_DESKTOP; // it makes validateWsToken() return true unconditionally

const AUTH_JS = path.join(__dirname, '..', 'auth.js');
const auth = require(AUTH_JS);
const SESSIONS_FILE = path.join(APP_DIR, 'data', 'sessions-auth.json');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// Generated per run so no credential-shaped literal ever lands in the repo.
const PW = crypto.randomBytes(18).toString('hex');
const PW2 = crypto.randomBytes(18).toString('hex');

(async () => {
  console.log('\n— setup hands out a working token —');
  check('nothing is configured yet', auth.isSetupDone(), false);
  const t1 = await auth.setupUser(PW, '  Owner  ');
  check('setup returns a 32-byte hex token', /^[0-9a-f]{64}$/.test(t1), true);
  check('the account now exists', auth.isSetupDone(), true);
  check('the display name is trimmed and stripped of controls', auth.loadAuth().displayName, 'Owner');
  check('the password itself is not stored', JSON.stringify(auth.loadAuth()).includes(PW), false);
  check('the token validates', auth.validateToken(t1), true);
  check('a token that was never issued does not', auth.validateToken(crypto.randomBytes(32).toString('hex')), false);
  check('neither does an empty one', auth.validateToken(''), false);
  check('nor undefined', auth.validateToken(undefined), false);

  console.log('\n— the sessions file is not world-readable —');
  check('data/sessions-auth.json is 0600', (fs.statSync(SESSIONS_FILE).mode & 0o777).toString(8), '600');
  check('data/auth.json is 0600', (fs.statSync(path.join(APP_DIR, 'data', 'auth.json')).mode & 0o777).toString(8), '600');

  console.log('\n— setup cannot be replayed —');
  let replayed = null;
  try { await auth.setupUser(PW2, 'Attacker'); replayed = 'accepted'; }
  catch (e) { replayed = e.message; }
  check('a second setup is refused', replayed, 'Already configured');
  check('and the original token still works', auth.validateToken(t1), true);

  console.log('\n— login —');
  let bad = null;
  try { await auth.login(PW + 'x'); } catch (e) { bad = e.message; }
  // The message must not distinguish "no account" from "wrong password" — that
  // difference is a user-enumeration oracle.
  check('a wrong password is refused generically', bad, 'Invalid credentials');
  const t2 = await auth.login(PW);
  check('the right password issues a second token', /^[0-9a-f]{64}$/.test(t2), true);
  check('both tokens are live at once', [auth.validateToken(t1), auth.validateToken(t2)], [true, true]);
  check('and they are different', t1 === t2, false);

  console.log('\n— revocation —');
  auth.revokeToken(t2);
  check('a revoked token stops validating', auth.validateToken(t2), false);
  check('positive control: the other token is untouched', auth.validateToken(t1), true);
  const t3 = await auth.login(PW);
  auth.revokeAll();
  check('revokeAll kills every token', [auth.validateToken(t1), auth.validateToken(t3)], [false, false]);

  console.log('\n— changing the password logs every device out —');
  const t4 = await auth.login(PW);
  check('a fresh token works before the change', auth.validateToken(t4), true);
  const t5 = await auth.changePassword(PW, PW2);
  check('the old session was revoked by the change', auth.validateToken(t4), false);
  check('and the caller got a replacement', auth.validateToken(t5), true);
  let stale = null;
  try { await auth.login(PW); } catch (e) { stale = e.message; }
  check('the old password no longer logs in', stale, 'Invalid credentials');
  check('the new one does', /^[0-9a-f]{64}$/.test(await auth.login(PW2)), true);
  let wrongOld = null;
  try { await auth.changePassword(PW, 'whatever-long-enough'); } catch (e) { wrongOld = e.message; }
  check('changePassword refuses a wrong current password', wrongOld, 'Invalid current password');
  let weak = null;
  try { await auth.changePassword(PW2, 'short'); } catch (e) { weak = e.message; }
  check('and refuses a new password under 8 chars', weak, 'Password must be at least 8 characters');
  check('the live token survived both refusals', auth.validateToken(t5), true);

  console.log('\n— the concurrent-session cap —');
  auth.revokeAll();
  const many = [];
  for (let i = 0; i < 22; i++) many.push(await auth.login(PW2));
  const stored = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  check('the stored session count is capped at 20', Object.keys(stored).length, 20);
  check('the most recent token survived the eviction', auth.validateToken(many[21]), true);
  check('the least recently used one was evicted', auth.validateToken(many[0]), false);

  console.log('\n— expiry is read from what is on disk —');
  // A 30-day TTL cannot be waited out, and the in-process sessions cache cannot be
  // invalidated from here (loadSessions() never re-reads disk once populated) — so
  // this one runs in a CHILD process against a hand-written sessions file. That
  // also proves the on-disk shape is exactly what validateToken() consumes.
  const aged = crypto.randomBytes(32).toString('hex');
  const fresh = crypto.randomBytes(32).toString('hex');
  const DAY = 24 * 60 * 60 * 1000;
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify({
    [aged]: { created: Date.now() - 31 * DAY, lastUsed: Date.now() },
    [fresh]: { created: Date.now() - 29 * DAY, lastUsed: Date.now() },
  }));
  const script = [
    `process.env.APP_DIR = ${JSON.stringify(APP_DIR)};`,
    `delete process.env.CCS_DESKTOP;`,
    `const a = require(${JSON.stringify(AUTH_JS)});`,
    `console.log(JSON.stringify([a.validateToken(${JSON.stringify(aged)}), a.validateToken(${JSON.stringify(fresh)})]));`,
  ].join('\n');
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
  check('a token older than the 30-day TTL is rejected', out[0], false);
  check('positive control: one just inside the TTL is accepted', out[1], true);
  const after = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  check('the expired token was pruned from disk', Object.prototype.hasOwnProperty.call(after, aged), false);
  check('and the valid one was left alone', Object.prototype.hasOwnProperty.call(after, fresh), true);

  console.log('\n— the desktop bypass is scoped to the WS helper —');
  // validateWsToken() short-circuits under CCS_DESKTOP=1. That is deliberate, but it
  // must not leak into validateToken(), which is what guards the HTTP API.
  process.env.CCS_DESKTOP = '1';
  check('validateWsToken accepts anything in desktop mode', auth.validateWsToken('nonsense'), true);
  check('validateToken does NOT', auth.validateToken('nonsense'), false);
  delete process.env.CCS_DESKTOP;
  check('and the bypass is gone once the flag is', auth.validateWsToken('nonsense'), false);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
