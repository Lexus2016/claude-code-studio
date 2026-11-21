// api-token.js is the credential an EXTERNAL client holds (issue #150): months of
// life, revocable without touching the owner's login, scoped because "create a
// task" is code execution in the container.
//
// What this file pins, in the order the risks matter:
//
//   - the plaintext is returned once and never lands on disk — a leaked data
//     directory must not hand anyone a working token;
//   - a token that was never issued cannot pass, and a revoked one stops working
//     immediately (revocation must not need a restart);
//   - the scope is validated on the way in, never coerced: an unknown scope must
//     not silently become 'read' or 'full';
//   - a hand-edited or truncated file fails CLOSED (no tokens) instead of throwing
//     on every request or trusting a malformed row;
//   - last_used_at is recorded, because a list of tokens with no usage is a list
//     nobody dares revoke.
//
// Runs against a THROWAWAY APP_DIR. api-token.js resolves its file from
// process.env.APP_DIR at require time, so the developer's real data/ is untouched.
//
// Run: node test/api-token.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-apitok-'));
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
process.env.APP_DIR = APP_DIR;

const apiToken = require('../api-token.js');
const TOKENS_FILE = path.join(APP_DIR, 'data', 'api-tokens.json');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

(async () => {
  console.log('\n— a token is minted once and only its hash is kept —');
  check('nothing exists yet', apiToken.listTokens(), []);
  const { token, record } = apiToken.createToken({ name: '  mcphub \u0007box ', scope: 'read' });
  check('the token carries the greppable prefix', token.startsWith('ccs_'), true);
  check('and 24 random bytes of entropy', /^ccs_[0-9a-f]{48}$/.test(token), true);
  check('the record names the scope', record.scope, 'read');
  check('the display name is trimmed and stripped of controls', record.name, 'mcphub box');
  check('the record never carries the token back', Object.prototype.hasOwnProperty.call(record, 'token'), false);
  check('the record never carries the hash', Object.prototype.hasOwnProperty.call(record, 'hash'), false);
  check('the token validates', apiToken.verifyToken(token), { id: record.id, name: 'mcphub box', scope: 'read' });
  check('a token that was never issued does not', apiToken.verifyToken('ccs_' + crypto.randomBytes(24).toString('hex')), null);
  check('an empty one does not', apiToken.verifyToken(''), null);
  check('nor undefined', apiToken.verifyToken(undefined), null);
  check('nor a bare hex string without the prefix', apiToken.verifyToken(token.slice(4)), null);

  console.log('\n— the file holds hashes, is 0600, and records use —');
  const onDisk = fs.readFileSync(TOKENS_FILE, 'utf8');
  check('the plaintext is not on disk', onDisk.includes(token), false);
  check('the file is 0600', (fs.statSync(TOKENS_FILE).mode & 0o777).toString(8), '600');
  const stored = JSON.parse(onDisk);
  check('one record is stored', stored.length, 1);
  check('its hash is sha256 of the token',
    stored[0].hash, crypto.createHash('sha256').update(token).digest('hex'));
  check('last_used_at was recorded on the verifying call', typeof stored[0].last_used_at, 'string');
  check('listTokens reports the usage too', typeof apiToken.listTokens()[0].last_used_at, 'string');
  check('listTokens carries no hash', Object.prototype.hasOwnProperty.call(apiToken.listTokens()[0], 'hash'), false);

  console.log('\n— scope is validated, never coerced —');
  let badScope = null;
  try { apiToken.createToken({ name: 'x', scope: 'admin' }); badScope = 'accepted'; }
  catch (e) { badScope = e.message; }
  check('an unknown scope is refused', /scope must be one of/.test(badScope), true);
  let noScope = null;
  try { apiToken.createToken({ name: 'x' }); noScope = 'accepted'; }
  catch (e) { noScope = e.message; }
  check('a missing scope is refused rather than defaulted', /scope must be one of/.test(noScope), true);
  check('the refusal did not create anything', apiToken.listTokens().length, 1);
  const full = apiToken.createToken({ name: 'runner', scope: 'full' });
  check('a full token records its scope', apiToken.verifyToken(full.token).scope, 'full');
  check('an empty name falls back to a label', apiToken.createToken({ name: '   ', scope: 'read' }).record.name, 'external client');

  console.log('\n— revocation is immediate —');
  check('revoking an unknown id reports false', apiToken.revokeToken('nope'), false);
  check('the token still works before the revoke', !!apiToken.verifyToken(token), true);
  check('revoking the real id succeeds', apiToken.revokeToken(record.id), true);
  check('and the token stops working at once', apiToken.verifyToken(token), null);
  check('while the other token is untouched', !!(apiToken.verifyToken(full.token)), true);

  console.log('\n— a broken file fails closed —');
  fs.writeFileSync(TOKENS_FILE, '{not json');
  check('garbage yields no tokens', apiToken.listTokens(), []);
  check('and verifies nothing', apiToken.verifyToken(full.token), null);
  fs.writeFileSync(TOKENS_FILE, JSON.stringify([{ id: 'x', scope: 'full', hash: 'nothex' }]));
  check('a malformed row is dropped', apiToken.listTokens(), []);
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({ tokens: [] }));
  check('a wrong shape yields no tokens', apiToken.listTokens(), []);

  console.log('\n— the cap holds —');
  fs.rmSync(TOKENS_FILE, { force: true });
  for (let i = 0; i < 20; i++) apiToken.createToken({ name: `t${i}`, scope: 'read' });
  check('twenty tokens fit', apiToken.listTokens().length, 20);
  let capped = null;
  try { apiToken.createToken({ name: 'one-too-many', scope: 'read' }); capped = 'accepted'; }
  catch (e) { capped = e.message; }
  check('the twenty-first is refused', /token limit reached/.test(capped), true);

  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
  console.log(`\napi-token: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
