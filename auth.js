const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const AUTH_FILE = path.join(__dirname, 'data', 'auth.json');
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions-auth.json');
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); }
  catch { return null; }
}

function saveAuth(data) {
  const dir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')); }
  catch { return {}; }
}

function saveSessions(data) {
  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data));
}

function isSetupDone() { return loadAuth() !== null; }

/** Validate password strength. Throws on failure. */
function validatePassword(password) {
  if (!password || typeof password !== 'string') throw new Error('Password is required');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  // bcrypt silently truncates at 72 bytes — enforce explicit max to prevent confusion
  if (password.length > 128) throw new Error('Password must be at most 128 characters');
}

/** Sanitize display name: trim, max 64 chars, strip control characters. */
function sanitizeDisplayName(name) {
  if (!name || typeof name !== 'string') return 'Admin';
  // eslint-disable-next-line no-control-regex
  return name.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, 64) || 'Admin';
}

async function setupUser(password, displayName) {
  if (isSetupDone()) throw new Error('Already configured');
  validatePassword(password);
  const safeName = sanitizeDisplayName(displayName);
  const hash = await bcrypt.hash(password, 12);
  saveAuth({
    passwordHash: hash,
    displayName: safeName,
    sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  });
  return createToken();
}

async function login(password) {
  const auth = loadAuth();
  if (!auth) throw new Error('Not configured');
  if (!(await bcrypt.compare(password, auth.passwordHash))) throw new Error('Invalid password');
  return createToken();
}

function createToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  const now = Date.now();
  for (const [t, d] of Object.entries(sessions)) { if (now - d.created > TOKEN_TTL) delete sessions[t]; }
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
  s.lastUsed = Date.now();
  saveSessions(sessions);
  return true;
}

function revokeToken(token) { const s = loadSessions(); delete s[token]; saveSessions(s); }
function revokeAll() { saveSessions({}); }

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
