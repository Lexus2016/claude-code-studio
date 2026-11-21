'use strict';
// ─── External API tokens (issue #150) ─────────────────────────────────────────
// The web UI authenticates with a 30-day session token held in a cookie. An
// external client (mcp-ccs.js on a laptop, MCPHub in another container) needs
// something different: a credential that
//
//   - lives for months without a browser in the loop,
//   - can be revoked without logging the owner out (revokeToken() would also
//     kill their own session),
//   - is not the per-process TASK_MANAGER_SECRET, which is random on every
//     restart and therefore unusable outside this process,
//   - carries a SCOPE, because "create a task" is code execution in the
//     container and a monitoring client should not have that.
//
// So this module is the whole token store: `data/api-tokens.json`, 0600, and
// only a SHA-256 of each token on disk. The plaintext is returned once, by
// createToken(), and never written or logged anywhere. A token is a high-entropy
// random value, not a password, so a plain hash is the right primitive here —
// bcrypt would only buy a work factor against guessing a 192-bit value.
//
// Tokens are opt-in by existing: an install with no tokens cannot call the
// external API at all, and nothing else in the app reads this file.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;
const TOKENS_FILE = path.join(APP_DIR, 'data', 'api-tokens.json');

// `ccs_` makes a leaked token greppable in logs and secret scanners, which is
// the one place an opaque 48-hex string would be invisible.
const TOKEN_PREFIX = 'ccs_';
const SCOPES = ['read', 'full'];
// Same ceiling as auth.js's session cap: past this, a list of tokens stops being
// something a person can read, and nothing legitimate needs it.
const MAX_TOKENS = 20;
// lastUsedAt is in-memory and flushed at most this often — an external client
// polls, and a writeFileSync per request would rewrite the file in a loop.
const LAST_USED_FLUSH_INTERVAL = 5 * 60 * 1000;

function hashHex(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function isHashString(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

function isRecord(r) {
  return r !== null && typeof r === 'object' && !Array.isArray(r) &&
    typeof r.id === 'string' && r.id.length > 0 &&
    isHashString(r.hash) &&
    SCOPES.includes(r.scope) &&
    typeof r.created_at === 'string';
}

// No cache: unlike the sessions file (read on every HTTP request) this one is
// read only by the external surface and the token management endpoints, and a
// stale read here would mean a revoked token that still works.
function loadTokens() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); }
  catch { return []; }
  if (!Array.isArray(parsed)) return [];
  // Accept only records this module writes; a hand-edited file must fail closed,
  // not turn every request into a throw.
  return parsed.filter(isRecord);
}

function saveTokens(list) {
  const dir = path.dirname(TOKENS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = TOKENS_FILE + '.tmp';
  // 0600: token hashes are not the token, but they are still credential material
  // on a shared host — the same reason auth.json is written this way.
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, TOKENS_FILE);
}

function sanitizeName(name) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(name == null ? '' : name)
    .replace(/[\x00-\x1F\x7F\u0080-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g, '')
    .trim()
    .slice(0, 60);
  return cleaned;
}

function publicRecord(r) {
  return { id: r.id, name: r.name, scope: r.scope, created_at: r.created_at, last_used_at: r.last_used_at || null };
}

/** Metadata only — never the hash, never the token. */
function listTokens() {
  return loadTokens().map(publicRecord);
}

/**
 * Mint a token. Returns { token, record } — `token` is the only time the
 * plaintext exists; the caller (HTTP response or scripts/api-token.js) is
 * responsible for showing it once.
 */
function createToken({ name, scope } = {}) {
  const cleanName = sanitizeName(name) || 'external client';
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of: ${SCOPES.join(', ')}`);
  const tokens = loadTokens();
  if (tokens.length >= MAX_TOKENS) throw new Error(`token limit reached (${MAX_TOKENS}); revoke one first`);

  // 24 random bytes = 192 bits. The prefix is stripped before hashing so the
  // stored value is over the secret alone.
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
  const record = {
    id: crypto.randomBytes(8).toString('hex'),
    name: cleanName,
    scope,
    hash: hashHex(token),
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
  tokens.push(record);
  saveTokens(tokens);
  return { token, record: publicRecord(record) };
}

function revokeToken(id) {
  if (!id) return false;
  const tokens = loadTokens();
  const kept = tokens.filter(t => t.id !== id);
  if (kept.length === tokens.length) return false;
  saveTokens(kept);
  return true;
}

/**
 * Verify a presented bearer token. Returns { id, name, scope } or null.
 * Constant-time on the hash: comparing hex strings with === would leak the
 * matching prefix of a token an attacker is guessing.
 */
function verifyToken(plain) {
  if (typeof plain !== 'string' || !plain.startsWith(TOKEN_PREFIX)) return null;
  const presented = crypto.createHash('sha256').update(plain, 'utf8').digest();
  const tokens = loadTokens();
  let match = null;
  for (const t of tokens) {
    const stored = Buffer.from(t.hash, 'hex');
    if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) match = t;
  }
  if (!match) return null;

  const now = Date.now();
  const last = Date.parse(match.last_used_at || '') || 0;
  if (now - last > LAST_USED_FLUSH_INTERVAL) {
    match.last_used_at = new Date(now).toISOString();
    try { saveTokens(tokens); } catch { /* a read path must not fail on a stats write */ }
  }
  return { id: match.id, name: match.name, scope: match.scope };
}

module.exports = {
  TOKENS_FILE, TOKEN_PREFIX, SCOPES,
  listTokens, createToken, revokeToken, verifyToken,
};
