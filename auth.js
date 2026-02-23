const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const APP_DIR = process.env.APP_DIR || __dirname;
const AUTH_FILE = path.join(APP_DIR, 'data', 'auth.json');
const SESSIONS_FILE = path.join(APP_DIR, 'data', 'sessions-auth.json');
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_SESSIONS = 20; // cap concurrent sessions per installation
// lastUsed is updated in-memory on every request but only flushed to disk at
// this interval — avoids a writeFileSync on every single authenticated request
// (including frequent /api/auth/status polls).
const LAST_USED_FLUSH_INTERVAL = 5 * 60 * 1000; // 5 minutes

function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); }
  catch { return null; }
}

function saveAuth(data) {
  const dir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

// In-memory sessions cache — single source of truth for the current process.
// Eliminates stale-read windows: concurrent callers (e.g. two simultaneous
// logins whose bcrypt.compare() awaits interleave) always work against the
// latest in-process state, not a potentially stale on-disk snapshot.
let _sessionsCache = null;

function loadSessions() {
  if (_sessionsCache !== null) return _sessionsCache;
  try { _sessionsCache = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')); }
  catch { _sessionsCache = {}; }
  return _sessionsCache;
}

function saveSessions(data) {
  _sessionsCache = data; // update cache before disk write so next read is always current
  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(_sessionsCache));
}

function isSetupDone() { return loadAuth() !== null; }

// AUTH-4: guards against two concurrent setup requests both passing the isSetupDone() check
// before either finishes bcrypt.hash(). Set synchronously so Node's single-threaded event
// loop prevents the second request from proceeding past the check.
let _setupInProgress = false;

/** Validate password strength. Throws on failure. */
function validatePassword(password) {
  if (!password || typeof password !== 'string') throw new Error('Password is required');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  // bcrypt silently truncates at 72 bytes — enforce by byte count, not char count,
  // to prevent silent truncation of multi-byte (UTF-8) passwords.
  if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('Password must not exceed 72 bytes when UTF-8 encoded');
}

/** Sanitize display name: trim, max 64 chars, strip control characters. */
function sanitizeDisplayName(name) {
  if (!name || typeof name !== 'string') return 'Admin';
  // Strip ASCII controls, C1 controls, zero-width chars, bidi overrides, BOM
  // eslint-disable-next-line no-control-regex
  return name.trim().replace(/[\x00-\x1F\x7F\u0080-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g, '').slice(0, 64) || 'Admin';
}

async function setupUser(password, displayName) {
  if (isSetupDone() || _setupInProgress) throw new Error('Already configured');
  _setupInProgress = true;
  try {
    validatePassword(password);
    const safeName = sanitizeDisplayName(displayName);
    const hash = await bcrypt.hash(password, 12);
    // Re-check after the async await — another concurrent request may have finished first
    if (isSetupDone()) throw new Error('Already configured');
    saveAuth({
      passwordHash: hash,
      displayName: safeName,
      sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    });
    return createToken();
  } finally {
    _setupInProgress = false;
  }
}

async function login(password) {
  const auth = loadAuth();
  // Generic message: do not distinguish 'not configured' from 'wrong password'
  // to prevent user-enumeration via error message differences.
  if (!auth || !(await bcrypt.compare(password, auth.passwordHash))) throw new Error('Invalid credentials');
  return createToken();
}

function createToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  const now = Date.now();
  // Prune expired tokens
  for (const [t, d] of Object.entries(sessions)) { if (now - d.created > TOKEN_TTL) delete sessions[t]; }
  // Enforce session cap: evict least-recently-used sessions over the limit
  const entries = Object.entries(sessions);
  if (entries.length >= MAX_SESSIONS) {
    entries.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    for (const [t] of entries.slice(0, entries.length - MAX_SESSIONS + 1)) delete sessions[t];
  }
  sessions[token] = { created: now, lastUsed: now };
  saveSessions(sessions);
  return token;
}

function validateToken(token) {
  if (!token) return false;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s) return false;
  if (Date.now() - s.created > TOKEN_TTL) { delete sessions[token]; saveSessions(sessions); return false; }
  const now = Date.now();
  // Always update lastUsed in the in-memory cache (loadSessions returns _sessionsCache,
  // so s is a direct reference — mutation is visible immediately to all callers).
  // Only flush to disk when the previous disk write was more than LAST_USED_FLUSH_INTERVAL
  // ago: eliminates writeFileSync on every authenticated request / status poll.
  s.lastUsed = now;
  if (now - (s._lastFlushed || 0) > LAST_USED_FLUSH_INTERVAL) {
    s._lastFlushed = now;
    saveSessions(sessions);
  }
  return true;
}

function revokeToken(token) {
  try { const s = loadSessions(); delete s[token]; saveSessions(s); }
  catch (e) { console.error('[auth] revokeToken write failed:', e.message); }
}
function revokeAll() {
  try { saveSessions({}); }
  catch (e) { console.error('[auth] revokeAll write failed:', e.message); }
}

async function changePassword(oldPassword, newPassword) {
  const auth = loadAuth();
  if (!auth) throw new Error('Not configured');
  if (!(await bcrypt.compare(oldPassword, auth.passwordHash))) throw new Error('Invalid current password');
  validatePassword(newPassword);
  auth.passwordHash = await bcrypt.hash(newPassword, 12);
  saveAuth(auth);
  revokeAll();
  return createToken();
}

const PUBLIC_PATHS = [
  '/api/auth/setup', '/api/auth/login', '/api/auth/status', '/api/health',
  '/login', '/setup',
];

function authMiddleware(req, res, next) {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (!isSetupDone()) {
    if (req.accepts('html')) return res.redirect('/setup');
    return res.status(401).json({ error: 'setup_required' });
  }
  const token = req.cookies?.token || req.headers['x-auth-token'] ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (validateToken(token)) { req.authToken = token; return next(); }
  if (req.accepts('html') && !req.path.startsWith('/api/')) return res.redirect('/login');
  return res.status(401).json({ error: 'unauthorized' });
}

function validateWsToken(token) { return validateToken(token); }

module.exports = { isSetupDone, setupUser, login, validateToken, revokeToken, revokeAll, changePassword, authMiddleware, validateWsToken, loadAuth };
