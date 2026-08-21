const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const { execSync, spawnSync, spawn: spawnProc } = require('child_process');
const crypto = require('crypto');

// ─── Load .env file (no external dependency needed) ───────────────────────
// MUST stay above every local require() below: claude-cli.js, claude-ssh.js and
// claude-interactive.js capture CLAUDE_IDLE_TIMEOUT_MS / CLAUDE_HARD_CAP_MS into
// module-scope consts at require time. Loading .env after them silently pinned the
// hardcoded 10-min idle default no matter what .env said. Do not move this down.
{
  const envPath = path.join(process.env.APP_DIR || __dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (k && !(k in process.env)) process.env[k] = v;
    }
    console.log('✅ .env loaded');
  }
}

const multer = require('multer');
const openDatabase = require('./db-adapter');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const auth = require('./auth');
const ClaudeCLI = require('./claude-cli');
const { isTransientOverload, shouldRetryOverload } = require('./rate-limit-utils');
const { buildTerminalCommand: buildDelegateCommand, winTerminalArgs } = require('./delegate-terminal');
const { isAgentSuccess, shouldAutoContinue, agentStopReason } = require('./multi-agent-result');
const {
  resolveAgentCommands, supportsTerminal, mergeAgentDefaults, parseNewIdOutput,
  tmuxNameFor, buildLaunchCommand, isReapCandidate, shouldReap, pickOverflow, TMUX_PREFIX,
} = require('./terminal-session');
const termBridge = require('./terminal-bridge');
const botsLogic = require('./bots');
// A message that is nothing but a mention ("@@analyst") strips to an empty string —
// that used to become the literal `-p ''` prompt, starting the bot's CLI with no
// instruction at all. One line stands in for "you were addressed with nothing else
// to go on".
const BARE_MENTION_PROMPT = "You were addressed directly with no other text — greet them and ask what they need, or continue naturally if there is relevant prior context in this conversation.";
const { runInteractiveSingle, killInteractiveTmux, tmuxAvailable, catchUpFromTranscript, transcriptSize } = require('./claude-interactive');
const ClaudeSSH = require('./claude-ssh');
const { testSshConnection } = require('./claude-ssh');
const TelegramBot = require('./telegram-bot');
const TunnelManager = require('./tunnel-manager');

// ─── Structured Logger ────────────────────────────────────────────────────────
// Reads LOG_LEVEL + NODE_ENV from process.env (already populated from .env above).
// Production: emits newline-delimited JSON for log aggregators (Loki, Datadog, etc.)
// Development: human-readable output with icons.
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const _logLevel  = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LOG_LEVELS.info;
const _isProd    = process.env.NODE_ENV === 'production';
const log = (() => {
  function write(level, msg, meta = {}) {
    if (LOG_LEVELS[level] > _logLevel) return;
    const time = new Date().toISOString();
    if (_isProd) {
      process.stdout.write(JSON.stringify({ level, time, msg, ...meta }) + '\n');
    } else {
      const icons = { error: '❌', warn: '⚠️ ', info: 'ℹ️ ', debug: '🔍' };
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      process.stdout.write(`${icons[level] || ''} [${time}] ${msg}${metaStr}\n`);
    }
  }
  return {
    error: (msg, meta = {}) => write('error', msg, meta),
    warn:  (msg, meta = {}) => write('warn',  msg, meta),
    info:  (msg, meta = {}) => write('info',  msg, meta),
    debug: (msg, meta = {}) => write('debug', msg, meta),
  };
})();


const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
// Terminal sessions get their own endpoint: a different protocol (raw PTY bytes),
// a different lifecycle, and a hard capability/security gate the chat socket has no
// reason to carry.
const wssTerm = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3000;
// When launched via npx/global install, cli.js sets APP_DIR to cwd so user
// data persists in the user's directory, not inside the npm cache.
const APP_DIR = process.env.APP_DIR || __dirname;
const WORKDIR = process.env.WORKDIR || path.join(APP_DIR, 'workspace');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');

// Dual-mode child interpreter: web=node; desktop(Electron)=Electron-as-Node via CCS_NODE_CMD (set by electron/main.js). A packaged app has no standalone node.
const NODE_CMD = process.env.CCS_NODE_CMD || 'node';

// ─── Security config ──────────────────────────────────────────────────────────
// Trust X-Forwarded-For when behind nginx/Caddy (needed for rate limiting)
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// Brute-force protection on auth mutation endpoints (login / setup)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});
// Set secure flag on cookies only when served over HTTPS (behind a proxy)
const SECURE_COOKIES = process.env.TRUST_PROXY === 'true';
// Directories that authenticated users may browse/create projects in
const ALLOWED_BROWSE_ROOTS = [
  path.resolve(os.homedir()),
  path.resolve(WORKDIR),
  path.resolve(APP_DIR),
  path.resolve(__dirname),
];

// Guard for every endpoint that accepts a filesystem path from the client. It lives
// next to the list it enforces because that list sat here unused: declaring the roots
// without a single caller made the control look present while nothing checked it.
function isPathAllowed(target) {
  if (!target || typeof target !== 'string') return false;
  let resolved;
  try { resolved = path.resolve(target); } catch { return false; }
  // Registered LOCAL project workdirs count as allowed even when they sit outside the
  // default roots — the user already chose them, and refusing them would break every
  // project that predates this check. Remote workdirs are paths on another machine.
  let roots = ALLOWED_BROWSE_ROOTS;
  try {
    roots = roots.concat(loadProjects().filter(p => !p.isRemote && p.workdir).map(p => p.workdir));
  } catch { /* projects.json unreadable — fall back to the static roots */ }
  const t = _realish(resolved);
  return roots.some(root => {
    let r;
    try { r = _realish(path.resolve(root)); } catch { return false; }
    const rel = path.relative(r, t);
    // '' = the root itself; anything climbing out of it starts with '..'.
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  });
}

// Resolve symlinks before comparing. Lexical containment alone is not enough: a
// symlink sitting inside an allowed root (say ~/link -> /etc) is lexically inside
// it while every read and write lands on the target. Paths that do not exist yet
// are normal here — /api/project/init creates them — so resolve the deepest
// existing ancestor and re-attach the rest, which is where a symlink could hide.
// realpath also canonicalises case on case-insensitive volumes, so no separate
// case-folding heuristic is needed (and none that would misfire on a
// case-sensitive APFS or ZFS volume).
function _realish(target) {
  let cur = path.resolve(target);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(target);   // reached the volume root
    tail.push(path.basename(cur));
    cur = parent;
  }
}

const SKILLS_DIR = path.join(APP_DIR, 'skills');
const DB_PATH = path.join(APP_DIR, 'data', 'chats.db');
const PROJECTS_FILE = path.join(APP_DIR, 'data', 'projects.json');
const REMOTE_HOSTS_FILE = path.join(APP_DIR, 'data', 'remote-hosts.json');
const HOSTS_KEY_FILE    = path.join(APP_DIR, 'data', 'hosts.key');
const UPLOADS_DIR   = path.join(APP_DIR, 'data', 'uploads');

// Category map for bundled skills — used when skill is auto-discovered (not in config)
const BUNDLED_SKILL_META = {
  'auto-mode':         { label:'🎯 Auto-Skill Mode',           category:'system'      },
  'backend':           { label:'⚙️ Backend Engineer',           category:'engineering' },
  'api-designer':      { label:'🔌 API Designer',              category:'engineering' },
  'frontend':          { label:'🎨 Frontend Engineer',          category:'engineering' },
  'fullstack':         { label:'🔗 Fullstack Engineer',         category:'engineering' },
  'devops':            { label:'🐳 DevOps Engineer',            category:'engineering' },
  'docker':            { label:'🐋 Docker & Containers',       category:'engineering' },
  'sysadmin':          { label:'🖥️ Linux Sysadmin',           category:'engineering' },
  'kubernetes':        { label:'☸️ Kubernetes',                category:'engineering' },
  'postgres-wizard':   { label:'🗄️ PostgreSQL Wizard',          category:'engineering' },
  'data-engineer':     { label:'📊 Data Engineer',              category:'engineering' },
  'llm-architect':     { label:'🧠 LLM Architect',              category:'ai'          },
  'prompt-engineer':   { label:'✍️ Prompt Engineer',            category:'ai'          },
  'rag-engineer':      { label:'🔍 RAG Engineer',               category:'ai'          },
  'code-quality':      { label:'💎 Code Quality',               category:'quality'     },
  'debugging-master':  { label:'🐛 Debugging Master',           category:'quality'     },
  'code-review':       { label:'👁️ Code Reviewer',              category:'quality'     },
  'system-designer':   { label:'🏗️ System Designer',            category:'quality'     },
  'qa-verification':   { label:'✅ QA Verification',            category:'quality'     },
  'security':          { label:'🔒 Security Expert',            category:'security'    },
  'auth-specialist':   { label:'🛡️ Auth Specialist',            category:'security'    },
  'ui-design':         { label:'🎭 UI Designer',                category:'design'      },
  'ux-design':         { label:'🧩 UX Designer',                category:'design'      },
  'product-management':{ label:'📋 Product Manager',            category:'product'     },
  'docs-engineer':     { label:'📚 Docs Engineer',              category:'product'     },
  'technical-writer':  { label:'✒️ Technical Writer',           category:'product'     },
  'investment-banking':{ label:'💼 Investment Banking Analyst', category:'finance'     },
  'researcher':        { label:'🔬 Deep Researcher',            category:'research'    },
  'interview':         { label:'🎤 Interview First',            category:'workflow'    },
  'plan-execute':      { label:'📐 Plan & Execute',             category:'workflow'    },
};

// ─── Server-side i18n for user-facing defaults ──────────────────────────────
const SERVER_I18N = {
  uk: { newSession: 'Нова сесія', newTask: 'Нове завдання' },
  en: { newSession: 'New session', newTask: 'New task' },
  ru: { newSession: 'Новая сессия', newTask: 'Новая задача' },
  fr: { newSession: 'Nouvelle session', newTask: 'Nouvelle tâche' },
  he: { newSession: 'סשן חדש', newTask: 'משימה חדשה' },
};
// All possible default session titles across languages (used to detect "untitled" sessions)
const DEFAULT_SESSION_TITLES = new Set(Object.values(SERVER_I18N).map(v => v.newSession));
const DEFAULT_TASK_TITLES    = new Set(Object.values(SERVER_I18N).map(v => v.newTask));

/** Get user's preferred language from config (cached via loadMergedConfig). */
function getUserLang() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).lang || 'en'; } catch { return 'en'; }
}
function i18nSession() { return SERVER_I18N[getUserLang()]?.newSession || SERVER_I18N.en.newSession; }
function i18nTask()    { return SERVER_I18N[getUserLang()]?.newTask    || SERVER_I18N.en.newTask; }

// ─── Global Claude Code directory (priority: global → local) ─────────────────
const GLOBAL_CLAUDE_DIR  = path.join(os.homedir(), '.claude');
const GLOBAL_SKILLS_DIR  = path.join(GLOBAL_CLAUDE_DIR, 'skills');
const GLOBAL_PLUGINS_DIR = path.join(GLOBAL_CLAUDE_DIR, 'plugins');
const GLOBAL_PLUGIN_CACHE_DIR = path.join(GLOBAL_PLUGINS_DIR, 'cache');
const GLOBAL_PLUGIN_MARKETPLACES_DIR = path.join(GLOBAL_PLUGINS_DIR, 'marketplaces');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CLAUDE_DIR, 'config.json');

const claudeCli = new ClaudeCLI({ cwd: WORKDIR });

// Expand leading ~ to os.homedir() — works on macOS, Linux and Windows
function expandTilde(v) {
  if (typeof v !== 'string') return v;
  if (v === '~') return os.homedir();
  if (v.startsWith('~/') || v.startsWith('~\\')) return path.join(os.homedir(), v.slice(2));
  return v;
}
// Recursively expand ~ in all string values of an object (used for MCP env maps)
function expandTildeInObj(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = expandTilde(v);
  return out;
}

// Kill a process by PID. On Windows uses `taskkill /T /F` to kill the entire
// process tree (cmd.exe → node.exe chains). On Unix sends SIGTERM.
function killByPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${n} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(n, 'SIGTERM');
    }
  } catch {} // Process may already be dead (ESRCH)
}

[WORKDIR, SKILLS_DIR, path.dirname(DB_PATH), UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── One-time permission hardening for secret-bearing files ──────────────────
// Writers now create these 0600 (atomicWriteJSON here, atomicWrite in auth.js,
// hosts.key via writeFileSync { mode }). That is not retroactive: a file created by
// an earlier version keeps its 0644 forever, and a world-readable sessions-auth.json
// hands any local reader a live bearer token — an authentication bypass, not a
// hygiene nit. So fix what is already on disk, once, at boot.
//
// Deliberately runs BEFORE openDatabase(DB_PATH): SQLite copies the main database
// file's mode onto -wal / -shm when it creates them, so tightening chats.db first
// makes every future sidecar 0600 too, without touching the directory mode.
// (Verified: sidecars deleted, chats.db chmod 0600, reopened → wal=600 shm=600.)
function hardenSecretFilePermissions() {
  const dataDir = path.dirname(DB_PATH);
  const targets = [
    CONFIG_PATH,                                // MCP server definitions: Authorization: Bearer <api key>
    path.join(dataDir, 'auth.json'),            // bcrypt hash of the login password
    path.join(dataDir, 'sessions-auth.json'),   // live 32-byte session tokens
    path.join(dataDir, 'hosts.key'),            // AES-256 key that encrypts stored SSH passwords
    path.join(dataDir, 'remote-hosts.json'),    // SSH hosts + encrypted passwords
    path.join(dataDir, 'projects.json'),        // project workdirs + encrypted per-project SSH passwords
    DB_PATH,                                    // full chat history
    DB_PATH + '-wal',                           // same content, left behind by an unclean shutdown
    DB_PATH + '-shm',
  ];
  // A brand-new install has no chats.db yet, so there is nothing to chmod here — and
  // openDatabase() would create it 0644 (umask 022), which -wal/-shm would then inherit
  // and keep until the *next* boot. Pre-create it as an empty 0600 file instead: SQLite
  // initialises a zero-length file as an empty database, so this sets nothing but the mode.
  try {
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '', { mode: 0o600 });
  } catch (e) { log.warn('could not pre-create the database file', { err: e.code || e.message }); }

  const fixed = [];
  for (const file of targets) {
    try {
      const before = fs.statSync(file).mode & 0o777;
      if (!(before & 0o077)) continue;                    // owner-only already — idempotent no-op
      fs.chmodSync(file, 0o600);
      if (fs.statSync(file).mode & 0o077) continue;       // chmod is a no-op here (Windows, CIFS/Docker mount) — nothing to report
      fixed.push(`${path.basename(file)} ${before.toString(8)}→600`);
    } catch (e) {
      // ENOENT is the normal case: the file has not been created yet.
      if (e.code !== 'ENOENT') log.warn('permission hardening skipped', { file: path.basename(file), err: e.code || e.message });
    }
  }
  if (fixed.length) log.info('tightened file permissions to 0600', { files: fixed });
}
hardenSecretFilePermissions();

// ============================================
// MODELS
// ============================================
// CLI uses its own MODEL_MAP with short aliases (haiku/sonnet/opus)

// ============================================
// CLAUDE MAX LIMITS
// ============================================
const CLAUDE_MAX_LIMITS = {
  daily:  45,   // ~45 messages per day on Claude Max
  weekly: 225,  // ~225 messages per week on Claude Max
};

// ============================================
// DATABASE MAINTENANCE SETTINGS
// ============================================
const SESSION_TTL_DAYS      = parseInt(process.env.SESSION_TTL_DAYS || '30', 10);      // delete sessions older than N days
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24', 10); // run cleanup every N hours

// ============================================
// DATABASE MAINTENANCE FUNCTIONS
// ============================================

/**
 * Delete sessions older than SESSION_TTL_DAYS.
 * Messages are auto-deleted via ON DELETE CASCADE.
 */
function cleanOldSessions() {
  try {
    // Archive dashboard stats before deletion (ON DELETE CASCADE removes messages)
    const toDelete = db.prepare(`SELECT id FROM sessions WHERE updated_at < datetime('now', '-' || ? || ' days')`).all(SESSION_TTL_DAYS);
    if (toDelete.length > 0) {
      archiveSessionStats(toDelete.map(r => r.id));
      // Best-effort: kill interactive tmux sessions tied to expiring studio sessions
      for (const r of toDelete) { try { killInteractiveTmux(r.id); } catch {} }
    }
    const result = db.prepare(`DELETE FROM sessions WHERE updated_at < datetime('now', '-' || ? || ' days')`).run(SESSION_TTL_DAYS);
    if (result.changes > 0) {
      log.info(`[cleanup] Deleted ${result.changes} sessions older than ${SESSION_TTL_DAYS} days`);
    }
    return result.changes;
  } catch (err) {
    log.error('[cleanup] Failed to clean old sessions:', err.message);
    return 0;
  }
}

/**
 * Run WAL checkpoint to merge WAL file into main database.
 * Prevents unbounded WAL growth and keeps DB file compact.
 */
function checkpointDatabase() {
  try {
    // TRUNCATE mode: blocks writers briefly but fully resets WAL file
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    if (result[0]?.checkpointed > 0) {
      log.info(`[cleanup] WAL checkpoint: moved ${result[0].checkpointed} pages to main DB`);
    }
    return result;
  } catch (err) {
    log.error('[cleanup] WAL checkpoint failed:', err.message);
    return null;
  }
}

/**
 * Full cleanup routine: old sessions + checkpoint.
 */
function runDatabaseMaintenance() {
  const deleted = cleanOldSessions();
  if (deleted > 0) {
    // Only checkpoint if we actually deleted something
    checkpointDatabase();
  }
}

// ============================================
// SESSION ID SANITIZATION
// ============================================
// Extracts a clean UUID string from potentially corrupted claude_session_id values.
// Bug: runMultiAgent fallback could store { cid, completed } objects or nested JSON
// like {"cid":"{\"cid\":\"uuid\",\"completed\":true}","completed":false}
// This helper recursively unwraps to find the actual UUID.
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function sanitizeSessionId(val) {
  if (!val) return null;
  // Already a clean UUID
  if (typeof val === 'string' && UUID_RE.test(val)) return val;
  // Object with .cid field (from runCliSingle return value)
  if (typeof val === 'object' && val !== null && val.cid) return sanitizeSessionId(val.cid);
  // JSON string — try to parse and extract
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === 'object' && parsed.cid) return sanitizeSessionId(parsed.cid);
    } catch {}
    // Maybe a UUID is embedded somewhere in the string
    const m = val.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (m) return m[1];
  }
  return null;
}

// ============================================
// DATABASE
// ============================================
const db = openDatabase(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New session',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    claude_session_id TEXT,
    active_mcp TEXT DEFAULT '[]',
    active_skills TEXT DEFAULT '[]',
    mode TEXT DEFAULT 'auto',
    agent_mode TEXT DEFAULT 'single',
    model TEXT DEFAULT 'sonnet',
    workdir TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    content TEXT NOT NULL,
    tool_name TEXT,
    agent_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New task',
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    sort_order REAL DEFAULT 0,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
  );
`);
// Safe migration for existing databases
try { db.exec(`ALTER TABLE sessions ADD COLUMN workdir TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id)`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN last_user_msg TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN workdir TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN notes TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN model TEXT DEFAULT 'sonnet'`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN mode TEXT DEFAULT 'auto'`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN agent_mode TEXT DEFAULT 'single'`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN max_turns INTEGER DEFAULT 30`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN retry_count INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN worker_pid INTEGER`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN attachments TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN engine TEXT`); } catch {}
// run_engine: api/subscription choice for the web UI — DISTINCT from `engine` (owned by telegram-bot.js, value 'cli')
try { db.exec(`ALTER TABLE sessions ADD COLUMN run_engine TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN partial_text TEXT`); } catch {}
// Task Dispatch: chain dependencies + auto-recovery columns
try { db.exec(`ALTER TABLE tasks ADD COLUMN depends_on TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN chain_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN source_session_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN failure_reason TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN task_retry_count INTEGER DEFAULT 0`); } catch {}
// Scheduled tasks: time-based triggers + recurring runs
try { db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_at INTEGER`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN recurrence TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_end_at INTEGER`); } catch {}
// Task Manager MCP: autonomous task creation by Claude during task execution
try { db.exec(`ALTER TABLE tasks ADD COLUMN task_output TEXT`); } catch {}        // Structured result from report_result
try { db.exec(`ALTER TABLE tasks ADD COLUMN context TEXT`); } catch {}            // Curated context passed by parent task
try { db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`); } catch {}     // Task that created this task via MCP
try { db.exec(`ALTER TABLE tasks ADD COLUMN effort TEXT`); } catch {}             // claude --effort dial: low|medium|high|xhigh|max (NULL = CLI default)
try { db.exec(`ALTER TABLE tasks ADD COLUMN run_engine TEXT`); } catch {}         // api/subscription billing choice — mirrors sessions.run_engine
try { db.exec(`ALTER TABLE sessions ADD COLUMN remote_host TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN remote_workdir TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN sort_order REAL`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN fork_from_cid TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN notes TEXT DEFAULT ''`); } catch {}
// transcript_offset: catch-up cursor (byte offset into <cid>.jsonl). NULL = not yet
// baselined; advanced to transcript EOF after every web turn + by /catch-up.
try { db.exec(`ALTER TABLE sessions ADD COLUMN transcript_offset INTEGER`); } catch {}
// Terminal sessions: kind is fixed at creation and never switched — a session is
// either driven by the chat engine or by a human in a terminal, never both. That
// removes the two-drivers contention (engine send-keys vs human typing) by
// construction instead of policing it at runtime.
try { db.exec(`ALTER TABLE sessions ADD COLUMN kind TEXT DEFAULT 'chat'`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN terminal_agent TEXT`); } catch {}   // external-agent id, e.g. 'claude'
try { db.exec(`ALTER TABLE sessions ADD COLUMN agent_conv_id TEXT`); } catch {}    // the agent's own conversation id, for exact resume
// Whether this terminal session has ever been launched. A minted-but-unused
// conversation id is NOT resumable: starting with `--resume <uuid>` before the
// first run makes the agent fail on a conversation that does not exist yet.
try { db.exec(`ALTER TABLE sessions ADD COLUMN terminal_started INTEGER DEFAULT 0`); } catch {}
// Performance indexes — safe to re-run (IF NOT EXISTS)
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_status   ON tasks(status)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_session  ON tasks(session_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_created   ON messages(created_at)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_chain    ON tasks(chain_id)`); } catch {}
// messages.reply_to_id is a self-referencing FK; without this index every
// cascaded message delete triggers a full-table FK scan (O(N²) session cleanup)
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_reply_to  ON messages(reply_to_id)`); } catch {}
// Stats archive: preserve dashboard data when sessions are deleted
db.exec(`
  CREATE TABLE IF NOT EXISTS stats_archived (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_sessions INTEGER DEFAULT 0,
    total_messages INTEGER DEFAULT 0,
    total_tool_calls INTEGER DEFAULT 0,
    assistant_messages INTEGER DEFAULT 0,
    total_chars INTEGER DEFAULT 0,
    agent_messages INTEGER DEFAULT 0,
    max_messages_in_session INTEGER DEFAULT 0
  );
  INSERT OR IGNORE INTO stats_archived (id) VALUES (1);
  CREATE TABLE IF NOT EXISTS stats_archived_detail (
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    tool_count INTEGER DEFAULT 0,
    PRIMARY KEY (category, key)
  );
`);
// Telegram bot: telegram_devices table is created by TelegramBot constructor (single source of truth)
// Telegram Phase 2: session persistence + message source tracking
try { db.exec(`ALTER TABLE telegram_devices ADD COLUMN last_session_id TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE telegram_devices ADD COLUMN last_workdir TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'web'`); } catch(e) {}
// Task chains (groups): lightweight metadata for manually-created sequential task groups
db.exec(`
  CREATE TABLE IF NOT EXISTS task_chains (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Task Group',
    workdir TEXT,
    model TEXT DEFAULT 'sonnet',
    mode TEXT DEFAULT 'auto',
    agent_mode TEXT DEFAULT 'single',
    max_turns INTEGER DEFAULT 30,
    session_id TEXT,
    scheduled_at INTEGER,
    recurrence TEXT,
    recurrence_end_at INTEGER,
    source_session_id TEXT,
    sort_order REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chain_session ON task_chains(session_id);
  CREATE INDEX IF NOT EXISTS idx_chain_workdir ON task_chains(workdir);

  -- Bots: named participants a user can @mention inside a normal chat. Their id IS
  -- the handle. Kept in SQLite rather than config.json because system prompts run to
  -- kilobytes, the roster grows, and it joins against messages.agent_id — config.json
  -- is rewritten wholesale on every settings change.
  CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    engine TEXT NOT NULL DEFAULT 'claude',
    model TEXT,
    system_prompt TEXT NOT NULL DEFAULT '',
    active_skills TEXT NOT NULL DEFAULT '[]',
    active_mcp TEXT NOT NULL DEFAULT '[]',
    avatar TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Soft delete. A freed handle that is later reused would make a new bot appear
    -- as the author of the old one's messages, since messages.agent_id stores the
    -- handle. The row stays; the handle is reserved forever.
    deleted_at TEXT
  );

  -- One CLI session per (chat, bot). Required, not an optimisation: claude-cli.js
  -- passes --system-prompt only when there is NO session to resume, so a bot sharing
  -- the chat's session would silently run with no system prompt at all — its identity
  -- would not exist. A private session also gives the bot memory of its own thread.
  -- Which bots are available in which project. Identity stays global — the handle is
  -- the identity and messages.agent_id stores it — but AVAILABILITY is per project, so
  -- a crypto-research project does not offer a philosophy bot in its @ palette.
  -- Queued chat messages. The in-memory queue dies with the process, so a message
  -- waiting behind a running turn used to vanish on restart with no trace anywhere.
  -- The row is written when the message is queued and deleted the moment it is
  -- dequeued — BEFORE the run starts. A crash mid-run therefore loses that one
  -- message rather than replaying it, which is the safer direction: re-running a
  -- chat turn spends money and can edit files a second time.
  CREATE TABLE IF NOT EXISTS queued_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_queued_session ON queued_messages(session_id);

  CREATE TABLE IF NOT EXISTS project_bots (
    project_id TEXT NOT NULL,
    bot_id     TEXT NOT NULL,
    added_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, bot_id)
  );

  CREATE TABLE IF NOT EXISTS bot_sessions (
    chat_session_id   TEXT NOT NULL,
    bot_id            TEXT NOT NULL,
    claude_session_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_session_id, bot_id)
  );
`);
try { db.exec(`ALTER TABLE task_chains ADD COLUMN effort TEXT`); } catch {}      // claude --effort dial; chain-level default for new tasks
// bots.deleted_at was added after the table shipped, so CREATE TABLE IF NOT EXISTS is a
// no-op on an existing install and every /api/bots query would fail with
// "no such column: deleted_at". Same pattern as every other schema change here.
try { db.exec(`ALTER TABLE bots ADD COLUMN deleted_at TEXT`); } catch {}
// A role like "programmer" is wanted in every project, and per-project linking is
// pure friction for it. is_global=1 makes a bot appear in EVERY project's roster
// without a project_bots row; is_global=0 keeps the opt-in membership model for
// bots that only make sense somewhere specific. Default 0 — existing bots keep the
// availability they already have.
try { db.exec(`ALTER TABLE bots ADD COLUMN is_global INTEGER NOT NULL DEFAULT 0`); } catch {}
// A task can be assigned to a bot: it then runs with that bot's system prompt and
// model, and its output is attributed to the bot. Combined with the scheduling
// columns already here (scheduled_at / recurrence) this is what makes a recurring
// job belong to a named specialist rather than to nobody.
try { db.exec(`ALTER TABLE tasks ADD COLUMN bot_id TEXT`); } catch {}

// Sanitize a value for better-sqlite3 bind parameters.
// better-sqlite3 EXPANDS arrays: each element counts as a separate bind value.
// An empty array [] contributes 0 binds, causing "Too few parameter values".
// This guard ensures only primitive types reach .run()/.get()/.all().
function sqlVal(v) {
  if (v === undefined) return null;
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Buffer.isBuffer(v)) return v;
  // Array or object — stringify it (and log a warning for debugging)
  log.warn('sqlVal: coerced non-primitive to string', { type: typeof v, isArray: Array.isArray(v), preview: JSON.stringify(v)?.substring(0, 100) });
  return JSON.stringify(v);
}

// Wrap a prepared statement so .run()/.get()/.all() auto-sanitize all args via sqlVal().
// This catches the "Too few parameter values" RangeError at the source — no matter
// which code path triggers it — by ensuring arrays/objects never reach better-sqlite3.
function wrapStmt(stmt, label) {
  const origRun = stmt.run.bind(stmt);
  const origGet = stmt.get.bind(stmt);
  const origAll = stmt.all.bind(stmt);
  stmt.run = function(...args) {
    const safe = args.map(sqlVal);
    try { return origRun(...safe); }
    catch (e) {
      log.error(`stmt.run FAILED [${label}]`, { args: safe.map(a => a === null ? 'NULL' : typeof a === 'string' ? a.substring(0,60) : a), err: e.message, stack: e.stack });
      throw e;
    }
  };
  stmt.get = function(...args) {
    const safe = args.map(sqlVal);
    try { return origGet(...safe); }
    catch (e) {
      log.error(`stmt.get FAILED [${label}]`, { args: safe.map(a => a === null ? 'NULL' : typeof a === 'string' ? a.substring(0,60) : a), err: e.message });
      throw e;
    }
  };
  stmt.all = function(...args) {
    // named-param objects ({w: ...}) — pass through, don't map
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0])) {
      return origAll(args[0]);
    }
    const safe = args.map(sqlVal);
    try { return origAll(...safe); }
    catch (e) {
      log.error(`stmt.all FAILED [${label}]`, { args: safe.map(a => a === null ? 'NULL' : typeof a === 'string' ? a.substring(0,60) : a), err: e.message });
      throw e;
    }
  };
  return stmt;
}

const stmts = {
  createSession: db.prepare(`INSERT INTO sessions (id,title,active_mcp,active_skills,mode,agent_mode,model,workdir) VALUES (?,?,?,?,?,?,?,?)`),
  // Terminal sessions get their own INSERT: createSession is called from eight
  // places and must not grow parameters. kind is literal here — a terminal session
  // can never be created as anything else.
  markTerminalStarted: db.prepare(`UPDATE sessions SET terminal_started=1 WHERE id=?`),
  addQueuedMsg: db.prepare(`INSERT INTO queued_messages (session_id,payload) VALUES (?,?)`),
  delQueuedMsg: db.prepare(`DELETE FROM queued_messages WHERE id=?`),
  delQueuedBySession: db.prepare(`DELETE FROM queued_messages WHERE session_id=?`),
  allQueuedMsgs: db.prepare(`SELECT * FROM queued_messages ORDER BY id`),
  listBots: db.prepare(`SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY label COLLATE NOCASE`),
  getBot: db.prepare(`SELECT * FROM bots WHERE id=? AND deleted_at IS NULL`),
  // Includes soft-deleted rows: used to reserve handles and to attribute old messages.
  getBotAny: db.prepare(`SELECT * FROM bots WHERE id=?`),
  // Every handle ever used, including soft-deleted ones — a handle is reserved forever.
  allBotHandles: db.prepare(`SELECT id FROM bots`),
  // LEFT JOIN, not JOIN: a global bot has no project_bots row and must still appear.
  listProjectBots: db.prepare(`SELECT b.* FROM bots b
    LEFT JOIN project_bots pb ON pb.bot_id=b.id AND pb.project_id=?
    WHERE b.deleted_at IS NULL AND (b.is_global=1 OR pb.bot_id IS NOT NULL)
    ORDER BY b.label COLLATE NOCASE`),
  addBotToProject: db.prepare(`INSERT INTO project_bots (project_id,bot_id) VALUES (?,?)
    ON CONFLICT(project_id,bot_id) DO NOTHING`),
  removeBotFromProject: db.prepare(`DELETE FROM project_bots WHERE project_id=? AND bot_id=?`),
  // Every membership at once. Projects live in a JSON file, not in SQLite, so the
  // project NAME cannot be joined in — the caller pairs these rows with loadProjects().
  allProjectBots: db.prepare(`SELECT project_id, bot_id FROM project_bots`),
  projectsOfBot: db.prepare(`SELECT project_id FROM project_bots WHERE bot_id=?`),
  softDeleteBot: db.prepare(`UPDATE bots SET deleted_at=datetime('now') WHERE id=?`),
  getBotSession: db.prepare(`SELECT claude_session_id FROM bot_sessions WHERE chat_session_id=? AND bot_id=?`),
  setBotSession: db.prepare(`INSERT INTO bot_sessions (chat_session_id,bot_id,claude_session_id) VALUES (?,?,?)
    ON CONFLICT(chat_session_id,bot_id) DO UPDATE SET claude_session_id=excluded.claude_session_id`),
  // Positional parameters, like every other statement here: this runtime may be
  // node:sqlite (Node >= 22.5), whose named-parameter binding differs from
  // better-sqlite3's and rejects `@name` objects with "column index out of range".
  // `excluded.` lets the upsert reuse the same nine values without repeating them.
  upsertBot: db.prepare(`INSERT INTO bots (id,label,description,engine,model,system_prompt,active_skills,active_mcp,avatar,is_global)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      label=excluded.label, description=excluded.description, engine=excluded.engine,
      model=excluded.model, system_prompt=excluded.system_prompt,
      active_skills=excluded.active_skills, active_mcp=excluded.active_mcp,
      avatar=excluded.avatar, is_global=excluded.is_global, updated_at=datetime('now')`),
  createTerminalSession: db.prepare(`INSERT INTO sessions (id,title,active_mcp,active_skills,mode,agent_mode,model,workdir,kind,terminal_agent,agent_conv_id) VALUES (?,?,'[]','[]','auto','single',?,?,'terminal',?,?)`),
  updateTitle: db.prepare(`UPDATE sessions SET title=?,updated_at=datetime('now') WHERE id=?`),
  updateClaudeId: (() => {
    const _stmt = db.prepare(`UPDATE sessions SET claude_session_id=?,updated_at=datetime('now') WHERE id=?`);
    const _origRun = _stmt.run.bind(_stmt);
    _stmt.run = (cid, sessionId) => {
      const clean = sanitizeSessionId(cid);
      if (cid && !clean) log.warn('updateClaudeId: rejected non-UUID session_id', { raw: String(cid).substring(0, 80), sessionId });
      return _origRun(clean, sessionId);
    };
    return _stmt;
  })(),
  updateConfig: db.prepare(`UPDATE sessions SET active_mcp=?,active_skills=?,mode=?,agent_mode=?,model=?,workdir=?,updated_at=datetime('now') WHERE id=?`),
  getSessions: db.prepare(`SELECT id,title,created_at,updated_at,mode,agent_mode,model,workdir,claude_session_id FROM sessions ORDER BY CASE WHEN sort_order IS NULL THEN 0 ELSE 1 END ASC, sort_order ASC, updated_at DESC LIMIT 100`),
  getSessionsByWorkdir: db.prepare(`SELECT id,title,created_at,updated_at,mode,agent_mode,model,workdir,claude_session_id FROM sessions WHERE workdir=? ORDER BY CASE WHEN sort_order IS NULL THEN 0 ELSE 1 END ASC, sort_order ASC, updated_at DESC LIMIT 100`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id=?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE id=?`),
  addMsg: db.prepare(`INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,reply_to_id,attachments) VALUES (?,?,?,?,?,?,?,?)`),
  addTelegramMsg: db.prepare(`INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,reply_to_id,attachments,source) VALUES (?,?,?,?,?,?,?,?,'telegram')`),
  markInterruptDelivered: db.prepare(`UPDATE messages SET type='interrupt_delivered' WHERE id=?`),
  getMsgs: db.prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC, CASE WHEN type='thinking' THEN 0 ELSE 1 END ASC, id ASC`),
  // Lightweight: strip tool content (frontend only needs tool_name + agent_id for badge counts)
  getMsgsLite: db.prepare(`SELECT id, session_id, role, type, CASE WHEN type='tool' THEN '' ELSE content END AS content, tool_name, agent_id, created_at, reply_to_id, attachments, source FROM messages WHERE session_id=? ORDER BY created_at ASC, CASE WHEN type='thinking' THEN 0 ELSE 1 END ASC, id ASC`),
  getMsgsPaginated: db.prepare(`SELECT * FROM messages WHERE session_id=? AND (type IS NULL OR type != 'tool') ORDER BY created_at ASC, CASE WHEN type='thinking' THEN 0 ELSE 1 END ASC, id ASC LIMIT ? OFFSET ?`),
  countMsgs: db.prepare(`SELECT COUNT(*) AS total FROM messages WHERE session_id=? AND (type IS NULL OR type != 'tool')`),
  setLastUserMsg: db.prepare(`UPDATE sessions SET last_user_msg=? WHERE id=?`),
  clearLastUserMsg: db.prepare(`UPDATE sessions SET last_user_msg=NULL, retry_count=0 WHERE id=?`),
  setPartialText: db.prepare(`UPDATE sessions SET partial_text=? WHERE id=?`),
  getInterrupted: db.prepare(`SELECT id, title, last_user_msg FROM sessions WHERE last_user_msg IS NOT NULL`),
  incrementRetry: db.prepare(`UPDATE sessions SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id=?`),
  // Tasks (Kanban)
  getTasks: db.prepare(`
    SELECT t.*, s.title as sess_title, s.claude_session_id, s.model as sess_model,
           s.updated_at as sess_updated_at, COALESCE(s.retry_count, 0) as retry_count
    FROM tasks t LEFT JOIN sessions s ON t.session_id = s.id
    WHERE (@w IS NULL OR t.workdir = @w)
    ORDER BY t.sort_order ASC, t.created_at ASC
  `),
  getTask: db.prepare(`SELECT * FROM tasks WHERE id=?`),
  createTask: db.prepare(`INSERT INTO tasks (id,title,description,notes,status,sort_order,session_id,workdir,model,mode,agent_mode,max_turns,attachments,depends_on,chain_id,source_session_id,scheduled_at,recurrence,recurrence_end_at,effort,run_engine,bot_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateTask: db.prepare(`UPDATE tasks SET title=?,description=?,notes=?,status=?,sort_order=?,session_id=?,workdir=?,model=?,mode=?,agent_mode=?,max_turns=?,attachments=?,depends_on=?,chain_id=?,source_session_id=?,scheduled_at=?,recurrence=?,recurrence_end_at=?,effort=?,run_engine=?,bot_id=?,updated_at=datetime('now') WHERE id=?`),
  patchTaskStatus: db.prepare(`UPDATE tasks SET status=?,sort_order=?,updated_at=datetime('now') WHERE id=?`),
  deleteTask: db.prepare(`DELETE FROM tasks WHERE id=?`),
  deleteTasksBySession: db.prepare(`DELETE FROM tasks WHERE session_id=?`),
  countTasksBySession: db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE session_id=?`),
  getTasksEtag: db.prepare(`SELECT COALESCE(MAX(updated_at),'') as ts, COUNT(*) as n FROM tasks`),
  // processQueue hot-path — prepared once, reused every 60 s
  getTodoTasks:      db.prepare(`SELECT * FROM tasks WHERE status='todo' AND (scheduled_at IS NULL OR scheduled_at <= unixepoch()) ORDER BY sort_order ASC, created_at ASC`),
  getInProgressTasks: db.prepare(`SELECT * FROM tasks WHERE status='in_progress'`),
  getTasksByChain:   db.prepare(`SELECT * FROM tasks WHERE chain_id=? ORDER BY sort_order ASC`),
  // startTask hot-path
  setTaskSession:    db.prepare(`UPDATE tasks SET session_id=?, updated_at=datetime('now') WHERE id=?`),
  setTaskInProgress: db.prepare(`UPDATE tasks SET status='in_progress', updated_at=datetime('now') WHERE id=?`),
  // Stats queries
  activeAgents: db.prepare(`
    SELECT DISTINCT agent_id
    FROM messages
    WHERE role = 'assistant'
      AND agent_id IS NOT NULL
      AND datetime(created_at) >= datetime('now', '-5 minutes')
  `),
  dailyMessages: db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE role = 'user'
      AND date(created_at) = date('now')
  `),
  weeklyMessages: db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE role = 'user'
      AND datetime(created_at) >= datetime('now', '-7 days')
  `),
  contextTokens: db.prepare(`
    SELECT COALESCE(SUM(LENGTH(content)), 0) AS total
    FROM messages
    WHERE session_id = ?
  `),
  // getSession endpoint helpers — pre-compiled to avoid re-prepare on every load
  hasRunningTask: db.prepare(`SELECT id FROM tasks WHERE session_id=? AND status='in_progress' LIMIT 1`),
  inProgressTaskSessions: db.prepare(`SELECT DISTINCT session_id FROM tasks WHERE status='in_progress' AND session_id IS NOT NULL`),
  getChainTasks:  db.prepare(`SELECT id, title, status, depends_on, chain_id FROM tasks WHERE source_session_id=? ORDER BY sort_order ASC`),
  // Task chains (groups)
  getChains: db.prepare(`SELECT * FROM task_chains WHERE (@w IS NULL OR workdir = @w) ORDER BY sort_order ASC, created_at ASC`),
  getChain: db.prepare(`SELECT * FROM task_chains WHERE id=?`),
  createChain: db.prepare(`INSERT INTO task_chains (id,title,workdir,model,mode,agent_mode,max_turns,session_id,scheduled_at,recurrence,recurrence_end_at,source_session_id,sort_order,effort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateChain: db.prepare(`UPDATE task_chains SET title=?,workdir=?,model=?,mode=?,agent_mode=?,max_turns=?,session_id=?,scheduled_at=?,recurrence=?,recurrence_end_at=?,sort_order=?,effort=?,updated_at=datetime('now') WHERE id=?`),
  deleteChain: db.prepare(`DELETE FROM task_chains WHERE id=?`),
  deleteChainTasks: db.prepare(`DELETE FROM tasks WHERE chain_id=?`),
  getChainTasksList: db.prepare(`SELECT * FROM tasks WHERE chain_id=? ORDER BY sort_order ASC, created_at ASC`),
  getChainsEtag: db.prepare(`SELECT COALESCE(MAX(updated_at),'') as ts, COUNT(*) as n FROM task_chains`),
  // Dashboard analytics — pre-compiled for performance (11 queries per request)
  dashSummary: db.prepare(`SELECT (SELECT COUNT(*) FROM sessions) AS total_sessions, (SELECT COUNT(*) FROM messages) AS total_messages, (SELECT COUNT(*) FROM messages WHERE type='tool') AS total_tool_calls, (SELECT COUNT(*) FROM messages WHERE role='assistant' AND type='text') AS assistant_messages, (SELECT COALESCE(SUM(LENGTH(content)),0) FROM messages) AS total_chars`),
  dashTools: db.prepare(`SELECT tool_name AS name, COUNT(*) AS count FROM messages WHERE type='tool' AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC LIMIT 15`),
  dashModels: db.prepare(`SELECT model, COUNT(*) AS count FROM sessions WHERE model IS NOT NULL GROUP BY model`),
  dashAgentModes: db.prepare(`SELECT agent_mode, COUNT(*) AS count FROM sessions WHERE agent_mode IS NOT NULL GROUP BY agent_mode`),
  dashModes: db.prepare(`SELECT mode, COUNT(*) AS count FROM sessions WHERE mode IS NOT NULL GROUP BY mode`),
  dashDailyActivity: db.prepare(`SELECT date(created_at) AS date, COUNT(*) AS count FROM messages WHERE created_at >= date('now', '-90 days') GROUP BY date(created_at) ORDER BY date ASC`),
  dashHourlyDist: db.prepare(`SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS count FROM messages GROUP BY hour ORDER BY hour`),
  dashTopSessions: db.prepare(`SELECT s.id, s.title, s.model, s.agent_mode, s.created_at, s.workdir, COUNT(m.id) AS msg_count, SUM(CASE WHEN m.type='tool' THEN 1 ELSE 0 END) AS tool_count FROM sessions s JOIN messages m ON m.session_id = s.id GROUP BY s.id ORDER BY msg_count DESC LIMIT 10`),
  dashSessionStats: db.prepare(`SELECT ROUND(AVG(cnt),1) AS avg_messages_per_session, MAX(cnt) AS max_messages_in_session FROM (SELECT COUNT(*) AS cnt FROM messages GROUP BY session_id)`),
  dashMultiAgentStats: db.prepare(`SELECT COUNT(DISTINCT agent_id) AS unique_agents, COUNT(*) AS agent_messages FROM messages WHERE agent_id IS NOT NULL`),
  dashWeeklyTrend: db.prepare(`SELECT strftime('%Y-W%W', created_at) AS week, COUNT(*) AS count, SUM(CASE WHEN type='tool' THEN 1 ELSE 0 END) AS tool_count FROM messages WHERE created_at >= date('now', '-84 days') GROUP BY week ORDER BY week ASC`),
  // Archived stats (merged into dashboard for deleted sessions)
  archSummary: db.prepare(`SELECT * FROM stats_archived WHERE id = 1`),
  archTools: db.prepare(`SELECT key AS name, count FROM stats_archived_detail WHERE category='tool' ORDER BY count DESC`),
  archModels: db.prepare(`SELECT key AS model, count FROM stats_archived_detail WHERE category='model'`),
  archAgentModes: db.prepare(`SELECT key AS agent_mode, count FROM stats_archived_detail WHERE category='agent_mode'`),
  archModes: db.prepare(`SELECT key AS mode, count FROM stats_archived_detail WHERE category='mode'`),
  archDailyActivity: db.prepare(`SELECT key AS date, count FROM stats_archived_detail WHERE category='daily' AND key >= date('now', '-90 days') ORDER BY key ASC`),
  archHourlyDist: db.prepare(`SELECT CAST(key AS INTEGER) AS hour, count FROM stats_archived_detail WHERE category='hourly' ORDER BY hour`),
  archWeeklyTrend: db.prepare(`SELECT key AS week, count, tool_count FROM stats_archived_detail WHERE category='weekly' AND key >= strftime('%Y-W%W', date('now', '-84 days')) ORDER BY key ASC`),
  // Task Manager MCP prepared statements
  countChildTasks: db.prepare(`SELECT COUNT(*) AS cnt FROM tasks WHERE parent_task_id=?`),
  getParentTaskId: db.prepare(`SELECT parent_task_id FROM tasks WHERE id=?`),
  setTaskContext: db.prepare(`UPDATE tasks SET context=?, parent_task_id=?, updated_at=datetime('now') WHERE id=?`),
  setTaskOutput: db.prepare(`UPDATE tasks SET task_output=?, updated_at=datetime('now') WHERE id=?`),
  cancelTask: db.prepare(`UPDATE tasks SET status='cancelled', failure_reason=?, updated_at=datetime('now') WHERE id=?`),
};
// Auto-sanitize ALL prepared statements — prevents "Too few parameter values"
// on every code path (chat, tasks, queue, reconnect, telegram, etc.)
for (const [name, stmt] of Object.entries(stmts)) wrapStmt(stmt, name);

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/**
 * Merge two arrays of row objects by a key field, summing numeric fields.
 * Used to combine live dashboard data with archived stats from deleted sessions.
 * @param {Array} liveRows - Rows from live sessions/messages tables
 * @param {Array} archivedRows - Rows from stats_archived_detail
 * @param {string} keyField - Field to group by (e.g. 'name', 'model', 'date')
 * @param {string[]} sumFields - Numeric fields to sum (e.g. ['count', 'tool_count'])
 * @returns {Array} Merged rows
 */
function mergeDashRows(liveRows, archivedRows, keyField, sumFields) {
  const map = new Map();
  for (const row of liveRows) map.set(String(row[keyField]), { ...row });
  for (const row of archivedRows) {
    const k = String(row[keyField]);
    const existing = map.get(k);
    if (existing) {
      for (const f of sumFields) existing[f] = (existing[f] || 0) + (row[f] || 0);
    } else {
      map.set(k, { ...row });
    }
  }
  return [...map.values()];
}

/**
 * Archive dashboard statistics for sessions about to be deleted.
 * Must be called BEFORE deleting sessions (ON DELETE CASCADE removes messages).
 * Preserves cumulative stats so the dashboard remains accurate after cleanup.
 */
function archiveSessionStats(sessionIds) {
  if (!sessionIds || sessionIds.length === 0) return;
  const json = JSON.stringify(sessionIds);

  const archiveTxn = db.transaction((jsonIds) => {
    // Count ALL sessions being deleted (including those with no messages)
    const sessionCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM sessions WHERE id IN (SELECT value FROM json_each(?))
    `).get(jsonIds)?.cnt || 0;

    if (sessionCount === 0) return;

    // Aggregate message-level stats (may be zero if sessions had no messages)
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total_messages,
        SUM(CASE WHEN type='tool' THEN 1 ELSE 0 END) AS total_tool_calls,
        SUM(CASE WHEN role='assistant' AND type='text' THEN 1 ELSE 0 END) AS assistant_messages,
        COALESCE(SUM(LENGTH(content)), 0) AS total_chars,
        SUM(CASE WHEN agent_id IS NOT NULL THEN 1 ELSE 0 END) AS agent_messages
      FROM messages
      WHERE session_id IN (SELECT value FROM json_each(?))
    `).get(jsonIds);

    const totalMessages = stats?.total_messages || 0;

    // Max messages in a single session (0 if no messages)
    const maxRow = totalMessages > 0 ? db.prepare(`
      SELECT MAX(cnt) AS max_msg FROM (
        SELECT COUNT(*) AS cnt FROM messages
        WHERE session_id IN (SELECT value FROM json_each(?))
        GROUP BY session_id
      )
    `).get(jsonIds) : null;

    // Upsert cumulative counters (singleton row)
    db.prepare(`
      INSERT INTO stats_archived (id, total_sessions, total_messages, total_tool_calls, assistant_messages, total_chars, agent_messages, max_messages_in_session)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_sessions = total_sessions + excluded.total_sessions,
        total_messages = total_messages + excluded.total_messages,
        total_tool_calls = total_tool_calls + excluded.total_tool_calls,
        assistant_messages = assistant_messages + excluded.assistant_messages,
        total_chars = total_chars + excluded.total_chars,
        agent_messages = agent_messages + excluded.agent_messages,
        max_messages_in_session = MAX(max_messages_in_session, excluded.max_messages_in_session)
    `).run(
      sessionCount,
      totalMessages,
      stats?.total_tool_calls || 0,
      stats?.assistant_messages || 0,
      stats?.total_chars || 0,
      stats?.agent_messages || 0,
      maxRow?.max_msg || 0
    );

    // Reusable upsert for dimensional data
    const upsertDetail = db.prepare(`
      INSERT INTO stats_archived_detail (category, key, count, tool_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(category, key) DO UPDATE SET
        count = count + excluded.count,
        tool_count = tool_count + excluded.tool_count
    `);

    // Session-level distributions (always archive, even for sessions with no messages)
    const models = db.prepare(`
      SELECT model AS key, COUNT(*) AS count
      FROM sessions WHERE id IN (SELECT value FROM json_each(?)) AND model IS NOT NULL GROUP BY model
    `).all(jsonIds);
    for (const m of models) upsertDetail.run('model', m.key, m.count, 0);

    const agentModes = db.prepare(`
      SELECT agent_mode AS key, COUNT(*) AS count
      FROM sessions WHERE id IN (SELECT value FROM json_each(?)) AND agent_mode IS NOT NULL GROUP BY agent_mode
    `).all(jsonIds);
    for (const a of agentModes) upsertDetail.run('agent_mode', a.key, a.count, 0);

    const modes = db.prepare(`
      SELECT mode AS key, COUNT(*) AS count
      FROM sessions WHERE id IN (SELECT value FROM json_each(?)) AND mode IS NOT NULL GROUP BY mode
    `).all(jsonIds);
    for (const m of modes) upsertDetail.run('mode', m.key, m.count, 0);

    // Message-level distributions (only if messages exist)
    if (totalMessages > 0) {
      const tools = db.prepare(`
        SELECT tool_name AS key, COUNT(*) AS count
        FROM messages
        WHERE session_id IN (SELECT value FROM json_each(?)) AND type='tool' AND tool_name IS NOT NULL
        GROUP BY tool_name
      `).all(jsonIds);
      for (const t of tools) upsertDetail.run('tool', t.key, t.count, 0);

      const daily = db.prepare(`
        SELECT date(created_at) AS key, COUNT(*) AS count,
          SUM(CASE WHEN type='tool' THEN 1 ELSE 0 END) AS tool_count
        FROM messages WHERE session_id IN (SELECT value FROM json_each(?))
        GROUP BY date(created_at)
      `).all(jsonIds);
      for (const d of daily) upsertDetail.run('daily', d.key, d.count, d.tool_count);

      const hourly = db.prepare(`
        SELECT CAST(strftime('%H', created_at) AS INTEGER) AS key, COUNT(*) AS count
        FROM messages WHERE session_id IN (SELECT value FROM json_each(?)) GROUP BY key
      `).all(jsonIds);
      for (const h of hourly) upsertDetail.run('hourly', String(h.key), h.count, 0);

      const weekly = db.prepare(`
        SELECT strftime('%Y-W%W', created_at) AS key, COUNT(*) AS count,
          SUM(CASE WHEN type='tool' THEN 1 ELSE 0 END) AS tool_count
        FROM messages WHERE session_id IN (SELECT value FROM json_each(?)) GROUP BY key
      `).all(jsonIds);
      for (const w of weekly) upsertDetail.run('weekly', w.key, w.count, w.tool_count);
    }

    log.info(`[archive] Archived stats for ${sessionCount} sessions (${totalMessages} messages)`);
  });

  try {
    archiveTxn(json);
  } catch (err) {
    log.error('[archive] Failed to archive session stats:', err.message);
    // Don't block deletion on archive failure
  }
}

// Derive chain status from its child tasks (no stored status — eliminates sync bugs)
function deriveChainStatusFromTasks(tasks) {
  if (!tasks.length) return 'backlog';
  if (tasks.every(t => t.status === 'done')) return 'done';
  if (tasks.some(t => t.status === 'in_progress')) return 'in_progress';
  if (tasks.some(t => t.status === 'cancelled') &&
      !tasks.some(t => t.status === 'in_progress' || t.status === 'todo')) return 'cancelled';
  if (tasks.some(t => t.status === 'todo')) return 'todo';
  return 'backlog';
}
function deriveChainStatus(chainId) {
  return deriveChainStatusFromTasks(stmts.getChainTasksList.all(chainId));
}

// Build chain summary for API responses (single query per chain)
function chainWithSummary(chain) {
  const tasks = stmts.getChainTasksList.all(chain.id);
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const in_progress = tasks.filter(t => t.status === 'in_progress').length;
  const failed = tasks.filter(t => t.status === 'cancelled').length;
  return {
    ...chain,
    derived_status: deriveChainStatusFromTasks(tasks),
    tasks_summary: { total, done, in_progress, failed },
    tasks,
  };
}

// ─── Active task registry ─────────────────────────────────────────────────
// Keeps running Claude subprocesses alive when the browser tab closes/reloads.
// Key: localSessionId, Value: { proxy, abortController, cleanupTimer }
const activeTasks = new Map();
// How long a task keeps running after its browser WebSocket detaches (tab closed,
// laptop asleep, network drop) before it is aborted. This is NOT an idle timer — the
// task may be working the whole time. Re-attaching clears it. 0 disables the abort
// entirely, so a detached task runs to completion. Default 30 min.
const TASK_DISCONNECT_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.TASK_DISCONNECT_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 30 * 60 * 1000;
})();

// ─── Session Watchers (real-time task worker → chat streaming) ────────────
// When chat client opens a session, it subscribes via WS. Task worker broadcasts
// text/tool/done events to all watchers of that session.
const sessionWatchers = new Map(); // sessionId → Set<WebSocket>
const taskBuffers = new Map();     // taskId → accumulated text (for late subscribers)
const chatBuffers = new Map();     // sessionId → accumulated text for direct chat (for catch-up on reconnect)
const MAX_CHAT_BUFFER = 2 * 1024 * 1024; // 2 MB cap per session — prevents unbounded growth
const sessionQueues = new Map();   // sessionId → [msg, ...] — queue persistence across WS reconnects (page refresh)
const activeChatSessions = new Set(); // Cross-connection lock: prevents two WS connections from running processChat on the same session
const sessionQueueCleanupTimers = new Map(); // sessionId → setTimeout handle — delayed cleanup to survive WS reconnect race

// ─── Liveness: one source of truth for "a chat turn is running in this process" ──
// Two maps carry that state and BOTH must be consulted:
//   activeTasks        — set once the CLI subprocess is spawned (web + telegram workers)
//   activeChatSessions — set at the very top of processChat, i.e. it also covers the
//                        window BEFORE activeTasks.set(). With autoSkill that window
//                        holds `await classifyTask()` (~10-15s), so an activeTasks-only
//                        check reports a live turn as idle for the whole classification.
// Every membership test must go through isSessionLive(); every "which sessions are
// live" enumeration through liveSessionIds(). Do not re-inline the union.
const isSessionLive = (id) => activeTasks.has(id) || activeChatSessions.has(id);
const liveSessionIds = () => {
  const ids = new Set(activeChatSessions);
  for (const id of activeTasks.keys()) ids.add(id);
  return ids;
};

// ─── Ask User (Internal MCP) ─────────────────────────────────────────────
// Pending user questions: requestId → { resolve, sessionId, timer, question, options, inputType }
const pendingAskUser = new Map();
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ASK_USER_SECRET = require('crypto').randomBytes(16).toString('hex');


// ─── Notify User (Internal MCP) ──────────────────────────────────────────
const NOTIFY_SECRET = require('crypto').randomBytes(16).toString('hex');

// ─── Set UI State (Internal MCP) ──────────────────────────────────────────
const SET_UI_STATE_SECRET = require('crypto').randomBytes(16).toString('hex');

// ─── Task Manager (Internal MCP) ─────────────────────────────────────────
const TASK_MANAGER_SECRET = require('crypto').randomBytes(16).toString('hex');

// ─── Bot-to-bot dispatch (Internal MCP) ─────────────────────────────────
const BOTS_SECRET = require('crypto').randomBytes(16).toString('hex');
// Hand-offs allowed per USER MESSAGE, shared by every bot in the turn — not per bot.
// A per-bot allowance multiplies with the line-up size, so three mentioned bots at
// three hand-offs each is a nine-bot turn nobody asked for. 3 is enough for the real
// case (specialist pulls in one or two peers) and keeps the worst case legible.
const BOT_DISPATCH_BUDGET = 3;
// sessionId -> { roster, queued, pending, budget } for the turn currently running.
// Lives only for the duration of runBotTurns: the MCP subprocess posts into it and
// the turn loop drains it. Absent entry = no bot turn in flight, so a stray call is
// rejected rather than queued against the next message.
const botDispatch = new Map();

// ─── User Interrupt (Internal MCP) ──────────────────────────────────────
const INTERRUPT_SECRET = require('crypto').randomBytes(16).toString('hex');
// How long an interrupt's saved files stay on disk after the agent is told about
// them. 60 s was too short: the agent is handed a path and may run several other
// tools before reading it, and a long turn can easily outlast a minute — the Read
// would then fail on a path that no longer exists. These live in the OS temp
// directory, so an occasional leftover is swept up by the system anyway.
const INTERRUPT_FILE_TTL_MS = parseInt(process.env.CCS_INTERRUPT_FILE_TTL_MS || '1800000', 10) || 1800000;
const pendingInterrupts = new Map(); // sessionId → [{ id, content, attachments?, createdAt }]
let _interruptIdCounter = 0;

// Save interrupt attachments to temp dir for MCP consumption.
// Returns array of saved attachment descriptors (with path, base64 for images, etc.)
function saveInterruptAttachments(rawAttachments, sessionId, interruptId, { enrichSsh = false } = {}) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return [];
  const saved = [];
  const tmpDir = path.join(os.tmpdir(), `claude-int-${sessionId}-${interruptId}`);
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  for (const att of rawAttachments) {
    const normalized = normalizeStoredAttachment(att);
    if (!normalized) continue;
    if (normalized.type === 'ssh') {
      if (enrichSsh && normalized.hostId) {
        try {
          const rh = loadRemoteHosts().find(h => h.id === normalized.hostId);
          if (rh) {
            normalized.sshKeyPath = rh.sshKeyPath || '';
            normalized.password = decryptPassword(rh.password) || '';
          }
        } catch {}
      }
      saved.push({ type: 'ssh', label: normalized.label, host: normalized.host, port: normalized.port, sshKeyPath: normalized.sshKeyPath || '', password: normalized.password || '' });
      continue;
    }
    if (normalized.base64) {
      let safeName = (normalized.name || `att-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
      // Avoid name collisions within the same interrupt
      if (fs.existsSync(path.join(tmpDir, safeName))) {
        const ext = path.extname(safeName);
        const base = safeName.slice(0, -ext.length || undefined);
        safeName = `${base}-${Date.now()}${ext}`;
      }
      const filePath = path.join(tmpDir, safeName);
      try {
        fs.writeFileSync(filePath, Buffer.from(normalized.base64, 'base64'));
        const entry = { type: normalized.type, name: normalized.name || safeName, path: filePath };
        if (isImageAttachment(normalized)) {
          entry.base64 = normalized.base64;
          entry.mimeType = getImageMimeType(normalized);
        }
        saved.push(entry);
      } catch (err) {
        log.warn('[interrupt] failed to save attachment', { name: normalized.name, err: err.message });
      }
    }
  }
  return saved;
}

// Clean up temp files created for interrupt attachments.
// delayMs: delay cleanup to give Claude time to read files after MCP delivery.
function cleanupInterruptAttachments(messages, delayMs = 0) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const dirs = new Set();
  for (const m of messages) {
    if (!Array.isArray(m.attachments)) continue;
    for (const att of m.attachments) {
      if (att.path) dirs.add(path.dirname(att.path));
    }
  }
  if (dirs.size === 0) return;
  const doCleanup = () => {
    for (const dir of dirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
  if (delayMs > 0) setTimeout(doCleanup, delayMs);
  else doCleanup();
}

function broadcastToSession(sessionId, data) {
  const watchers = sessionWatchers.get(sessionId);
  if (!watchers?.size) return;
  const msg = JSON.stringify(data);
  for (const w of watchers) {
    if (w.readyState === 1) {
      try { w.send(msg); } catch { watchers.delete(w); }
    } else if (w.readyState > 1) {
      watchers.delete(w); // CLOSING/CLOSED — won't recover
    }
  }
  if (!watchers.size) sessionWatchers.delete(sessionId);
}

// Same fan-out, minus one socket. Used by the plain-chat path, where the originating
// socket is served by its own WsProxy (which buffers while the browser is away) and
// would otherwise receive the frame twice — double-firing _bgNotify and loadHist.
function broadcastToSessionExcept(sessionId, exceptWs, data) {
  const watchers = sessionWatchers.get(sessionId);
  if (!watchers?.size) return;
  const msg = JSON.stringify(data);
  for (const w of watchers) {
    if (w === exceptWs) continue;
    if (w.readyState === 1) {
      try { w.send(msg); } catch { watchers.delete(w); }
    } else if (w.readyState > 1) {
      watchers.delete(w);
    }
  }
  if (!watchers.size) sessionWatchers.delete(sessionId);
}

// ─── Activity panel: tell ALL connected clients the live/scheduled state changed.
// Debounced (~400ms) + lightweight signal only — clients re-fetch /api/activity and
// diff-render just the Activity section. Clients also reconciliation-poll as a
// backstop, so a missed signal self-heals.
let _activityDirtyTimer = null;
function markActivityDirty() {
  if (_activityDirtyTimer) return;
  _activityDirtyTimer = setTimeout(() => {
    _activityDirtyTimer = null;
    const msg = JSON.stringify({ type: 'activity_dirty' });
    for (const w of wss.clients) {
      if (w.readyState === 1) { try { w.send(msg); } catch {} }
    }
  }, 400);
}

// ─── Kanban Task Queue Worker ─────────────────────────────────────────────
const MAX_TASK_WORKERS = Math.max(1, parseInt(process.env.MAX_TASK_WORKERS || '5', 10));
const taskRunning = new Set();        // task IDs currently executing
const runningTaskAborts = new Map();  // taskId → AbortController
const stoppingTasks = new Set();      // task IDs being manually stopped (onDone must not overwrite status)
// task IDs started via the independent-worker path. Authoritative count for the
// MAX_TASK_WORKERS cap — DB session_id can't be used, because startTask() assigns
// a session to every independent task on launch, so they'd vanish from a
// `session_id IS NULL` count on the very next processQueue tick (the old bug let
// the cap reset each tick → unbounded parallel `claude` subprocesses).
const independentRunning = new Set();

async function startTask(task) {
  if (taskRunning.has(task.id)) return;
  taskRunning.add(task.id);
  markActivityDirty();
  console.log(`[taskWorker] starting "${task.title}" (${task.id})`);
  let _retryBackoffMs = 0; // Set by auto-retry logic, used by finally for processQueue delay
  let sessionId = task.session_id;
  let _taskStartedAt = Date.now();
  try {
    // Create session + link task + mark in_progress — all atomic
    db.transaction(() => {
      if (!sessionId) {
        sessionId = genId();
        stmts.createSession.run(sessionId, task.title.substring(0, 200), '[]', '[]', task.mode || 'auto', task.agent_mode || 'single', task.model || 'sonnet', task.workdir || null);
        stmts.setTaskSession.run(sessionId, task.id);
      }
      stmts.setTaskInProgress.run(task.id);
    })();
    // Build prompt
    const parts = [task.title];
    if (task.description?.trim()) parts.push(task.description.trim());
    if (task.notes?.trim()) parts.push(`---\nУточнення:\n${task.notes.trim()}`);
    // Write attachment files to workspace so Claude Code can read them
    if (task.attachments) {
      try {
        const atts = JSON.parse(task.attachments);
        if (Array.isArray(atts) && atts.length) {
          const attDir = path.join(task.workdir || WORKDIR, '.kanban-attachments', task.id);
          fs.mkdirSync(attDir, { recursive: true });
          const names = [];
          for (const att of atts) {
            if (att.base64 && att.name) {
              // Sanitize filename: strip directory traversal, keep only the base name
              const safeName = path.basename(att.name);
              if (!safeName) continue;
              fs.writeFileSync(path.join(attDir, safeName), Buffer.from(att.base64, 'base64'));
              names.push(safeName);
            }
          }
          if (names.length) {
            parts.push(`---\nAttached files (in .kanban-attachments/${task.id}/):\n${names.map(n => `- ${n}`).join('\n')}`);
          }
        }
      } catch (e) { console.error('[taskWorker] attachments write error:', e); }
    }
    // Chain task: add dependency context as safety net (primary context via --resume)
    if (task.depends_on) {
      try {
        const deps = JSON.parse(task.depends_on);
        const depNames = deps.map(depId => { const dep = stmts.getTask.get(depId); return dep ? dep.title : null; }).filter(Boolean);
        if (depNames.length) {
          parts.push(`---\nPrevious tasks completed: ${depNames.join(', ')}\nTheir results are in your session context via --resume.`);
        }
      } catch {}
    }
    // Parent context: if this task was created by another task via MCP, include the curated context
    if (task.context) {
      let contextStr = task.context;
      try { const parsed = JSON.parse(task.context); contextStr = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2); } catch {}
      parts.push(`---\nContext from parent task:\n${contextStr}`);
    }
    // A bot-owned task runs AS that bot: its system prompt defines who is working,
    // and the roster lets it hand work on. Falls back to an ordinary task run if the
    // bot was deleted — the handle stays reserved, so history still reads correctly.
    let taskBot = null;
    if (task.bot_id) {
      try {
        taskBot = stmts.getBot.get(task.bot_id) || null;
        if (!taskBot) log.warn('task bot not found — running without it', { taskId: task.id, botId: task.bot_id });
      } catch {}
    }
    // Task manager instruction: inform Claude about available task management tools
    parts.push(TASK_MANAGER_INSTRUCTION);
    const prompt = parts.join('\n\n') + TASK_VERIFICATION_SUFFIX;
    _taskStartedAt = Date.now(); // reset to accurate time after prompt building
    // Check if this is a restart: only skip saving if the LAST user message
    // has the exact same prompt (crash recovery). Previously checked for ANY
    // user message which broke when a new task reused an existing session.
    const lastUserMsg = db.prepare(`SELECT id, content FROM messages WHERE session_id=? AND role='user' ORDER BY id DESC LIMIT 1`).get(sessionId);
    const isRetry = lastUserMsg && lastUserMsg.content === prompt;
    if (!isRetry) {
      // New task or different prompt — save user message
      try { stmts.addMsg.run(sessionId, 'user', 'text', prompt, null, null, null, null); }
      catch (e) { log.error('startTask addMsg failed', { sessionId, promptLen: prompt.length, err: e.message, stack: e.stack }); throw e; }
    } else {
      // Restart after crash with same prompt — increment retry counter, don't duplicate
      try { stmts.incrementRetry.run(sessionId); } catch (e) { log.error('startTask incrementRetry failed', { err: e.message }); }
    }
    // Resume existing claude session if any
    const session = stmts.getSession.get(sessionId);
    const claudeSessionId = sanitizeSessionId(session?.claude_session_id) || null;
    const cli = new ClaudeCLI({ cwd: task.workdir || WORKDIR });
    const taskAbort = new AbortController();
    runningTaskAborts.set(task.id, taskAbort);
    let fullText = '', newCid = claudeSessionId, hasError = false;
    taskBuffers.set(task.id, '');
    // Notify watchers — use task_retrying for restarts, task_started for first run
    // Include prompt so client can show user message bubble during live streaming
    if (isRetry) {
      const retryCount = session?.retry_count || 1;
      broadcastToSession(sessionId, { type: 'task_retrying', taskId: task.id, title: task.title, prompt, retryCount, tabId: sessionId });
    } else {
      broadcastToSession(sessionId, { type: 'task_started', taskId: task.id, title: task.title, prompt, tabId: sessionId });
    }
    // Auto-continue loop: keep resuming until agent completes or budget exhausted
    let taskContinueCount = 0;
    let taskOverloadRetryCount = 0;
    let currentTaskPrompt = prompt;
    let currentTaskCid = claudeSessionId;
    let lastTaskResult = null;
    let lastTaskTurnUsage = null; // usage of the most recent assistant turn → real ctx-window occupancy
    const effectiveTaskMaxTurns = task.max_turns || 30;

    // Build MCP config for task execution — user MCPs from config + internal task-manager
    const taskMcpServers = {};
    // Include user-configured MCPs from config.json (all enabled servers)
    try {
      const cfg = loadConfig();
      for (const [mid, m] of Object.entries(cfg.mcpServers || {})) {
        if (!m || m.enabled === false) continue;
        if (m.type === 'http' || m.type === 'sse' || m.url) {
          taskMcpServers[mid] = { type: m.type || 'http', url: m.url, ...(m.headers ? { headers: m.headers } : {}), ...(m.env ? { env: expandTildeInObj(m.env) } : {}) };
        } else if (m.command) {
          taskMcpServers[mid] = { command: m.command, args: m.args || [], env: expandTildeInObj(m.env || {}) };
        }
      }
    } catch {}
    // Always inject internal task-manager MCP
    // The pull channel too: with the tool absent the worker cannot check for messages
    // even if it wants to.
    taskMcpServers['_ccs_user_interrupt'] = {
      command: NODE_CMD,
      args: [path.join(__dirname, 'mcp-user-interrupt.js')],
      env: {
        INTERRUPT_SERVER_URL: `http://127.0.0.1:${PORT}`,
        INTERRUPT_SESSION_ID: sessionId,
        INTERRUPT_SECRET,
      },
    };
    taskMcpServers['_ccs_task_manager'] = {
      command: NODE_CMD,
      args: [path.join(__dirname, 'mcp-task-manager.js')],
      env: {
        TASK_MANAGER_SERVER_URL: `http://127.0.0.1:${PORT}`,
        TASK_MANAGER_TASK_ID: task.id,
        TASK_MANAGER_SESSION_ID: sessionId,
        TASK_MANAGER_SECRET: TASK_MANAGER_SECRET,
      },
    };

    // Engine selection: subscription tasks run via the persistent interactive
    // tmux Claude session (billed on Claude Max), one-shot, no auto-continue.
    const _taskEngine = (task.run_engine === 'subscription') ? 'subscription' : 'api';

    while (true) {
      lastTaskResult = null;
      hasError = false; // Reset per iteration — only the LAST iteration's error state matters for final status
      const _ftBefore = fullText.length; // baseline to isolate THIS iteration's output (overload detection)

      if (_taskEngine === 'subscription') {
        // One-shot: interactive Claude runs to end_turn naturally. The proxy only
        // broadcasts live frames to the session; persistence is mirrored from the
        // returned value below (same shape the chat path uses).
        const _proxy = { send: (str) => { try { broadcastToSession(sessionId, JSON.parse(str)); } catch {} } };
        const r = await runInteractiveSingle({
          prompt: currentTaskPrompt, systemPrompt: '', model: session?.model || task.model || 'sonnet',
          mode: task.mode || 'auto', ws: _proxy, sessionId, abortController: taskAbort,
          claudeSessionId: currentTaskCid, workdir: task.workdir || WORKDIR, mcpServers: taskMcpServers,
        });
        for (const ev of (r.toolEvents || [])) {
          try { stmts.addMsg.run(sessionId, 'assistant', 'tool', (ev.input || '').substring(0, 500), ev.name, null, null, null); } catch {}
        }
        if (r.fullText) {
          fullText += r.fullText;
          const _tb = (taskBuffers.get(task.id) || '') + r.fullText;
          taskBuffers.set(task.id, _tb.length > MAX_CHAT_BUFFER ? _tb.slice(-MAX_CHAT_BUFFER) : _tb);
        }
        if (r.cid) { newCid = r.cid; currentTaskCid = r.cid; try { stmts.updateClaudeId.run(r.cid, sessionId); } catch {} }
        if (!r.completed) hasError = true;
        lastTaskResult = r.completed ? { subtype: 'success' } : { subtype: 'error' };
        break; // one-shot: interactive runs to end_turn, no auto-continue
      }

      // Interrupt delivery, same as a chat turn. A running task ACCEPTS clarifications
      // — the interrupt handler explicitly checks activeTasks — but without these the
      // message was stored, never handed to the worker, and cleaned up at the end.
      const taskInterruptCmd = `"${NODE_CMD}" "${path.join(__dirname, 'hooks', 'check-interrupt.js')}"`;
      const taskInterruptSettings = {
        hooks: {
          PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: taskInterruptCmd, timeout: 3 }] }],
          Stop: [{ hooks: [{ type: 'command', command: taskInterruptCmd, timeout: 3 }] }],
        },
      };
      const taskInterruptEnv = {
        CCS_INTERRUPT_URL: `http://127.0.0.1:${PORT}`,
        CCS_INTERRUPT_SESSION: sessionId,
        CCS_INTERRUPT_SECRET: INTERRUPT_SECRET,
      };
      const taskBotSp = taskBot
        ? botsLogic.buildBotSystemPrompt(taskBot, stmts.listBots.all()) + USER_INTERRUPT_INSTRUCTION
        : undefined;
      const stream = cli.send({ prompt: currentTaskPrompt, sessionId: currentTaskCid,
        // The bot's own model wins over the task's: picking a bot is picking who does
        // the work, and its model is part of that choice.
        model: taskBot?.model || session?.model || task.model || 'sonnet',
        systemPrompt: taskBotSp,
        // A bot-owned task follows the project's conventions but not the user's
        // personal CLAUDE.md — same boundary as a bot answering in chat, or every
        // reply opens with the user's own activation preamble.
        ...(taskBot ? { settingSources: 'project,local' } : {}),
        maxTurns: effectiveTaskMaxTurns, mcpServers: taskMcpServers, abortController: taskAbort, name: taskBot?.label || task.title, effort: task.effort || null, extraEnv: taskInterruptEnv, extraSettings: taskInterruptSettings });
      // Save subprocess PID so startup recovery can kill orphans on restart
      if (stream.process?.pid) {
        db.prepare(`UPDATE tasks SET worker_pid=? WHERE id=?`).run(stream.process.pid, task.id);
      }
      await new Promise(resolve => {
        stream
          .onText(t => {
            fullText += t;
            { const _tb = (taskBuffers.get(task.id) || '') + t; taskBuffers.set(task.id, _tb.length > MAX_CHAT_BUFFER ? _tb.slice(-MAX_CHAT_BUFFER) : _tb); }
            broadcastToSession(sessionId, { type: 'text', text: t, tabId: sessionId });
          })
          .onTool((name, inp) => {
            try { stmts.addMsg.run(sessionId, 'assistant', 'tool', (inp || '').substring(0, 500), name, null, null, null); } catch {}
            if (name !== 'ask_user' && name !== 'notify_user' && name !== 'set_ui_state') {
              broadcastToSession(sessionId, { type: 'tool', tool: name, input: (inp || '').substring(0, 600), tabId: sessionId });
            }
          })
          .onSessionId(sid => { newCid = sid; currentTaskCid = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
          .onResult(r => { lastTaskResult = r; })
          .onUsage(u => { if (u) lastTaskTurnUsage = u; })
          .onError(err => {
            hasError = true;
            console.error(`[taskWorker] task ${task.id} error:`, err);
            try { stmts.addMsg.run(sessionId, 'assistant', 'text', `❌ ${err.substring(0, 500)}`, null, null, null, null); } catch {}
            broadcastToSession(sessionId, { type: 'error', error: err.substring(0, 500), tabId: sessionId });
          })
          .onDone(sid => {
            if (sid) { newCid = sid; currentTaskCid = sid; }
            resolve();
          });
      });

      // 🌐 Transient server overload (HTTP 429/529) — short pause + retry, before the
      // success break and WITHOUT consuming the auto-continue budget. Same root cause as
      // the chat loop: the CLI reports the throttle as text/result, not stderr, so it can
      // ride along with subtype:'success'. Notice text avoids the trigger phrases so it
      // does not pollute the post-loop isRateLimited classifier (which scans fullText).
      {
        const _lastTurn = fullText.slice(_ftBefore);
        const _resultText = typeof lastTaskResult?.result === 'string' ? lastTaskResult.result : '';
        if (shouldRetryOverload({ texts: [_lastTurn, _resultText], subtype: lastTaskResult?.subtype, isError: lastTaskResult?.is_error }) &&
            !(taskAbort?.signal?.aborted || stoppingTasks.has(task.id))) {
          if (taskOverloadRetryCount < MAX_OVERLOAD_RETRIES) {
            taskOverloadRetryCount++;
            const _bMs = Math.min(OVERLOAD_BACKOFF_BASE_MS + (taskOverloadRetryCount - 1) * OVERLOAD_BACKOFF_STEP_MS, OVERLOAD_BACKOFF_MAX_MS);
            log.warn(`[taskWorker] task ${task.id}: server throttled, backing off ${Math.ceil(_bMs/1000)}s (${taskOverloadRetryCount}/${MAX_OVERLOAD_RETRIES})`);
            const _n = `\n⏳ Server busy (throttled) — pausing ~${Math.ceil(_bMs/1000)}s and retrying (${taskOverloadRetryCount}/${MAX_OVERLOAD_RETRIES})...\n`;
            fullText += _n;
            { const _tb = (taskBuffers.get(task.id) || '') + _n; taskBuffers.set(task.id, _tb.length > MAX_CHAT_BUFFER ? _tb.slice(-MAX_CHAT_BUFFER) : _tb); }
            broadcastToSession(sessionId, { type: 'text', text: _n, tabId: sessionId });
            await _sleepAbortable(_bMs, taskAbort?.signal);
            if (taskAbort?.signal?.aborted || stoppingTasks.has(task.id)) break;
            // If a session exists, switch to continuation so non-idempotent task work is not
            // re-executed; with no session yet, keep the original prompt so the retry re-sends it.
            if (currentTaskCid) {
              currentTaskPrompt = 'Continue where you left off. Complete the remaining work. When finished, run the MANDATORY POST-TASK VERIFICATION from your original instructions.';
            }
            continue; // retry; do not increment taskContinueCount
          }
          // Retries exhausted — fall through to normal handling (will be classified rate_limited).
        }
      }

      // ✅ Success — agent finished naturally
      if (lastTaskResult?.subtype === 'success') break;
      // 💰 Budget limit — can't continue
      if (lastTaskResult?.subtype === 'error_max_budget_usd') break;
      // 🛑 User stopped or aborted
      if (taskAbort?.signal?.aborted || stoppingTasks.has(task.id)) break;
      // 🔄 Auto-continue budget exhausted
      if (taskContinueCount >= MAX_AUTO_CONTINUES) {
        console.log(`[taskWorker] task ${task.id}: auto-continue budget exhausted (${MAX_AUTO_CONTINUES})`);
        break;
      }

      // 🔄 Auto-continue — agent stopped but didn't finish
      taskContinueCount++;
      console.log(`[taskWorker] task ${task.id}: auto-continuing (${taskContinueCount}/${MAX_AUTO_CONTINUES}), reason: ${lastTaskResult?.subtype || 'unknown'}`);
      const notice = `\n⏳ Auto-continuing (${taskContinueCount}/${MAX_AUTO_CONTINUES})...\n`;
      fullText += notice;
      { const _tb = (taskBuffers.get(task.id) || '') + notice; taskBuffers.set(task.id, _tb.length > MAX_CHAT_BUFFER ? _tb.slice(-MAX_CHAT_BUFFER) : _tb); }
      broadcastToSession(sessionId, { type: 'text', text: notice, tabId: sessionId });
      currentTaskPrompt = 'Continue where you left off. Complete the remaining work. When finished, run the MANDATORY POST-TASK VERIFICATION from your original instructions.';
    }

    // After loop: persist text and determine task status
    try {
      if (newCid) { try { stmts.updateClaudeId.run(newCid, sessionId); } catch (e) { log.error('taskWorker updateClaudeId failed', { cid: String(newCid).substring(0,50), sessionId, err: e.message, stack: e.stack }); } }
      if (fullText) { try { stmts.addMsg.run(sessionId, 'assistant', 'text', fullText, null, null, null, null); } catch (e) { log.error('taskWorker addMsg(assistant) failed', { sessionId, textLen: fullText.length, err: e.message, stack: e.stack }); } }
      const wasStopped = stoppingTasks.has(task.id);
      stoppingTasks.delete(task.id);
      if (!wasStopped) {
        const isSuccess = lastTaskResult?.subtype === 'success' && !hasError;
        const isRateLimited = isTransientOverload(fullText)
          || (hasError && (fullText.includes('rate_limit') || fullText.includes('overloaded') || fullText.includes('Too many')));
        const MAX_CHAIN_RETRIES = 2;

        if (isSuccess) {
          // ✅ Success — recurring standalone tasks re-arm directly (skip intermediate 'done')
          const reArmed = (task.recurrence && !task.chain_id) ? scheduleNextRun(task) : false;
          if (!reArmed) {
            db.prepare(`UPDATE tasks SET status='done', failure_reason=NULL, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
              .run(task.id);
          }
          db.prepare(`UPDATE sessions SET retry_count=0 WHERE id=?`).run(sessionId);
          log.info(`[taskWorker] task ${task.id}: ${reArmed ? 're-armed' : 'done'}`);
          // 🔗 Chain completion: check if all tasks in a manual chain are done
          if (task.chain_id) {
            try {
              const chain = stmts.getChain.get(task.chain_id);
              if (chain) {
                const allChainTasks = stmts.getChainTasksList.all(task.chain_id);
                const allDone = allChainTasks.every(ct => ct.status === 'done');
                if (allDone) {
                  db.prepare(`UPDATE task_chains SET updated_at=datetime('now') WHERE id=?`).run(task.chain_id);
                  log.info(`[taskWorker] chain ${task.chain_id} completed: all ${allChainTasks.length} tasks done`);
                  if (chain.recurrence) {
                    scheduleNextChainRun(chain, allChainTasks);
                  }
                } else {
                  db.prepare(`UPDATE task_chains SET updated_at=datetime('now') WHERE id=?`).run(task.chain_id);
                }
              }
            } catch (e) { log.error('Chain completion check failed', { chainId: task.chain_id, error: e.message }); }
          }
          // Notify Telegram about completed task
          if (telegramBot && telegramBot.isRunning()) {
            telegramBot.notifyTaskComplete({
              sessionId,
              title: task.title || 'Task',
              status: 'done',
              duration: Date.now() - _taskStartedAt,
            }).catch(() => {});
          }
        } else if (task.chain_id && (task.task_retry_count || 0) < MAX_CHAIN_RETRIES) {
          // 🔄 Auto-retry for chain tasks — don't give up on first failure
          const reason = isRateLimited ? 'rate_limited' : 'agent_incomplete';
          _retryBackoffMs = isRateLimited ? Math.min(60000 * ((task.task_retry_count || 0) + 1), 300000) : 3000;
          db.prepare(`UPDATE tasks SET status='todo', failure_reason=?, task_retry_count=COALESCE(task_retry_count,0)+1, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
            .run(reason, task.id);
          log.warn(`[taskWorker] task ${task.id}: chain retry ${(task.task_retry_count||0)+1}/${MAX_CHAIN_RETRIES}, reason: ${reason}, backoff: ${_retryBackoffMs}ms`);
          if (task.source_session_id) {
            const _ctx = getNotificationContext(task.source_session_id);
            broadcastToSession(task.source_session_id, {
              type: 'notification', level: 'warn',
              title: `Retrying: "${task.title}"`,
              detail: `Attempt ${(task.task_retry_count||0)+2}/${MAX_CHAIN_RETRIES+1}${isRateLimited ? '. Rate limited, backing off.' : ''}`,
              tabId: task.source_session_id,
              chainTaskId: task.id, chainStatus: 'retry',
              sessionTitle: _ctx.sessionTitle, projectName: _ctx.projectName,
            });
          }
        } else {
          // ❌ Failed — retries exhausted or not a chain task
          const reason = isRateLimited ? 'rate_limited' : 'agent_incomplete';
          db.prepare(`UPDATE tasks SET status='cancelled', failure_reason=?, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
            .run(reason, task.id);
          log.error(`[taskWorker] task ${task.id}: cancelled (${reason}, subtype: ${lastTaskResult?.subtype || 'unknown'})`);
          // Notify source chat about the failed task
          if (task.source_session_id) {
            const _ctx = getNotificationContext(task.source_session_id);
            broadcastToSession(task.source_session_id, {
              type: 'notification', level: 'error',
              title: `Task failed: "${task.title}"`,
              detail: task.chain_id ? `Retries exhausted (${reason}). Dependent tasks will be cancelled.` : reason,
              tabId: task.source_session_id,
              chainTaskId: task.id, chainStatus: 'cancelled',
              sessionTitle: _ctx.sessionTitle, projectName: _ctx.projectName,
            });
          }
          // Notify Telegram about failed task
          if (telegramBot && telegramBot.isRunning()) {
            telegramBot.notifyTaskComplete({
              sessionId,
              title: task.title || 'Task',
              status: 'error',
              duration: Date.now() - _taskStartedAt,
              error: reason,
            }).catch(() => {});
          }
          // Cascade cancel of dependents happens in next processQueue() run
          // 🔄 Recurring tasks: schedule next run even after failure (fresh session)
          scheduleNextRun(task);
        }
      } else {
        // User manually stopped — mark as user_cancelled, cascade will follow
        db.prepare(`UPDATE tasks SET status='cancelled', failure_reason='user_cancelled', worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
          .run(task.id);
        log.info(`[taskWorker] task ${task.id}: stopped by user`);
        // 🔄 Recurring tasks: stopping one run should not kill the entire schedule
        scheduleNextRun(task);
      }
    } catch (e) {
      console.error(`[taskWorker] task ${task.id} onDone DB error:`, e);
    }
    const _taskModelInfo = lastTaskResult?.modelUsage ? Object.values(lastTaskResult.modelUsage)[0] : null;
    const _taskMeta = lastTaskResult ? { cost: lastTaskResult.total_cost_usd, usage: lastTaskResult.usage, lastTurnUsage: lastTaskTurnUsage, numTurns: lastTaskResult.num_turns, durationMs: lastTaskResult.duration_ms, contextWindow: _taskModelInfo?.contextWindow || 0 } : null;
    broadcastToSession(sessionId, { type: 'done', tabId: sessionId, taskId: task.id, duration: Date.now() - _taskStartedAt, ...(_taskMeta ? { resultMeta: _taskMeta } : {}) });
  } catch (err) {
    log.error(`[taskWorker] task ${task.id} exception`, { message: err.message, name: err.name, stack: err.stack });
    try {
      // Exception: auto-retry for chain tasks, cancel for non-chain
      const failureMsg = `${err.name}: ${err.message}`;
      if (task.chain_id && (task.task_retry_count || 0) < 2) {
        db.prepare(`UPDATE tasks SET status='todo', failure_reason=?, task_retry_count=COALESCE(task_retry_count,0)+1, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`).run(failureMsg, task.id);
        _retryBackoffMs = 5000;
        log.warn(`[taskWorker] task ${task.id}: exception → auto-retry`);
      } else {
        db.prepare(`UPDATE tasks SET status='cancelled', failure_reason=?, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`).run(failureMsg, task.id);
        // 🔄 Recurring tasks: schedule next run even after exception (fresh session)
        scheduleNextRun(task);
      }
    } catch {}
    // Send done so the client doesn't wait forever for an event that will never arrive.
    if (sessionId) broadcastToSession(sessionId, { type: 'done', tabId: sessionId, taskId: task.id, duration: Date.now() - _taskStartedAt });
  } finally {
    taskBuffers.delete(task.id);
    taskRunning.delete(task.id);
    independentRunning.delete(task.id);
    markActivityDirty();
    runningTaskAborts.delete(task.id);
    setTimeout(processQueue, _retryBackoffMs || 500);
  }
}

// ─── Recurring task scheduler ────────────────────────────────────────────────
// Recurrence token grammar (stored verbatim in the `recurrence` TEXT column):
//   every:N:unit    unit ∈ hour|day|week|month, N≥1  — fixed interval
//   times:N:month   N≥1                              — N runs per calendar month
//   hourly|daily|weekly|monthly                      — legacy aliases (= every:1:<unit>)
// Returns the next run (unix secs), or null when the token is unrecognised so the
// caller can end the series instead of spinning the catch-up loop.
//
// Design notes:
// • Local wall-clock arithmetic is intentional — a "daily" task fires at the same
//   local time the user picked, even across DST. (Trade-off: a DST shift can move an
//   hourly run by ±1h on the transition day. Acceptable for a personal scheduler.)
// • Sub-hour intervals are deliberately NOT exposed, so the catch-up loop in
//   scheduleNextRun stays bounded (guard 10000 ≈ 416 days of hourly catch-up).
// • "times:N:month" uses a rubber-band step (days-in-current-month / N): ~N runs per
//   calendar month, phase-relative to the anchor, with no fixed-date pinning.
const RECUR_ALIASES = { hourly: 'every:1:hour', daily: 'every:1:day', weekly: 'every:1:week', monthly: 'every:1:month' };
function calcNextRun(scheduled_at, recurrence) {
  const token = RECUR_ALIASES[recurrence] || recurrence;
  const d = new Date(scheduled_at * 1000);
  let m;
  if ((m = /^every:(\d+):(hour|day|week|month)$/.exec(token))) {
    const n = parseInt(m[1], 10);
    if (!n) return null;
    if (m[2] === 'hour')  d.setHours(d.getHours() + n);
    if (m[2] === 'day')   d.setDate(d.getDate() + n);
    if (m[2] === 'week')  d.setDate(d.getDate() + 7 * n);
    if (m[2] === 'month') d.setMonth(d.getMonth() + n);
    return Math.floor(d.getTime() / 1000);
  }
  if ((m = /^times:(\d+):month$/.exec(token))) {
    const n = parseInt(m[1], 10);
    if (!n) return null;
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return scheduled_at + Math.floor((daysInMonth * 86400) / n);
  }
  return null; // unknown recurrence — caller ends the series
}

// Returns true if task was re-armed, false if series ended or skipped.
function scheduleNextRun(task) {
  if (!task.recurrence) return false;
  const now = Math.floor(Date.now() / 1000);
  // If no scheduled_at (recurring without fixed date), calculate next from now
  const baseTime = task.scheduled_at || now;
  let next = calcNextRun(baseTime, task.recurrence);
  if (next == null) { log.warn(`[schedule] Unrecognised recurrence "${task.recurrence}" for "${task.title}", ending series`); return false; }
  let guard = 0;
  while (next != null && next <= now && guard < 10000) { next = calcNextRun(next, task.recurrence); guard++; }
  if (next == null || guard >= 10000) { log.warn(`[schedule] Could not compute next run for "${task.title}", skipping`); return false; }
  // Respect end date
  if (task.recurrence_end_at && next > task.recurrence_end_at) {
    log.info(`[schedule] Recurrence series ended for "${task.title}"`);
    return false;
  }
  // Re-arm: reset same task to 'todo' with next scheduled_at (no cloning)
  db.prepare(`UPDATE tasks SET status='todo', scheduled_at=?, session_id=NULL, failure_reason=NULL, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
    .run(next, task.id);
  log.info(`[schedule] Re-armed: "${task.title}" → ${new Date(next * 1000).toISOString()}`);
  return true;
}

// Re-arm entire chain + tasks for recurring chain execution
function scheduleNextChainRun(chain, oldTasks) {
  if (!chain.recurrence) return;
  const now = Math.floor(Date.now() / 1000);
  const baseTime = chain.scheduled_at || now;
  let next = calcNextRun(baseTime, chain.recurrence);
  if (next == null) { log.warn(`[schedule] Unrecognised chain recurrence "${chain.recurrence}": "${chain.title}", ending series`); return; }
  let guard = 0;
  while (next != null && next <= now && guard < 10000) { next = calcNextRun(next, chain.recurrence); guard++; }
  if (next == null || guard >= 10000) { log.warn(`[schedule] Could not compute next chain run: "${chain.title}"`); return; }
  if (chain.recurrence_end_at && next > chain.recurrence_end_at) {
    log.info(`[schedule] Chain recurrence ended: "${chain.title}"`); return;
  }
  const newSessionId = genId();
  db.transaction(() => {
    // Fresh shared session for next chain run
    stmts.createSession.run(newSessionId, chain.title, '[]', '[]',
      chain.mode || 'auto', chain.agent_mode || 'single', chain.model || 'sonnet',
      chain.workdir || null);
    // Re-arm chain with next scheduled_at + new session
    db.prepare(`UPDATE task_chains SET scheduled_at=?, session_id=?, updated_at=datetime('now') WHERE id=?`)
      .run(next, newSessionId, chain.id);
    // Re-arm all tasks back to 'todo' with shared session
    for (const t of oldTasks) {
      db.prepare(`UPDATE tasks SET status='todo', scheduled_at=?, session_id=?, failure_reason=NULL, worker_pid=NULL, task_retry_count=0, updated_at=datetime('now') WHERE id=?`)
        .run(next, newSessionId, t.id);
    }
  })();
  log.info(`[schedule] Chain re-armed: "${chain.title}" → ${new Date(next * 1000).toISOString()}, ${oldTasks.length} tasks reset`);
}

function processQueue() {
  const todo = stmts.getTodoTasks.all();
  if (!todo.length) return;
  const inProg = stmts.getInProgressTasks.all();
  // Sessions currently occupied (in_progress or just started by taskRunning)
  const occupiedSids = new Set(inProg.filter(t => t.session_id).map(t => t.session_id));
  // Workdir-level lock: prevents parallel chain tasks from writing to the same directory concurrently
  const occupiedWorkdirs = new Set(inProg.filter(t => t.workdir).map(t => t.workdir));
  // Count independent running tasks via the in-memory registry (see independentRunning decl)
  let indepRunning = independentRunning.size;
  const startedSids = new Set();
  const startedWorkdirs = new Set();
  for (const task of todo) {
    if (taskRunning.has(task.id)) continue;
    // Dependency gate: check depends_on before starting chain tasks
    if (task.depends_on) {
      try {
        const deps = JSON.parse(task.depends_on);
        if (deps.length) {
          const failedDep = deps.find(depId => {
            const dep = stmts.getTask.get(depId);
            return dep && dep.status === 'cancelled';
          });
          if (failedDep) {
            // Cascade cancel: dependency failed, this task can't run
            db.prepare(`UPDATE tasks SET status='cancelled', failure_reason='dep_failed', notes=?, updated_at=datetime('now') WHERE id=?`)
              .run(`Blocked: dependency ${failedDep} failed`, task.id);
            log.warn('Task cascade-cancelled', { taskId: task.id, failedDep });
            if (task.source_session_id) {
              const _ctx = getNotificationContext(task.source_session_id);
              broadcastToSession(task.source_session_id, {
                type: 'notification', level: 'warn',
                title: `Task cancelled: "${task.title}"`,
                detail: 'Dependency failed',
                tabId: task.source_session_id,
                chainTaskId: task.id, chainStatus: 'cancelled',
                sessionTitle: _ctx.sessionTitle, projectName: _ctx.projectName,
              });
            }
            continue;
          }
          const allDone = deps.every(depId => {
            const dep = stmts.getTask.get(depId);
            return !dep || dep.status === 'done'; // deleted dep = satisfied
          });
          if (!allDone) continue; // deps not ready yet
        }
      } catch (e) { log.error('depends_on parse error', { taskId: task.id, error: e.message }); }
    }
    // Workdir lock: only for chain tasks — prevents parallel chains from conflicting in the same directory.
    // Independent tasks (no chain_id) can run in parallel per workdir; the user explicitly chose concurrency.
    if (task.chain_id && task.workdir && (occupiedWorkdirs.has(task.workdir) || startedWorkdirs.has(task.workdir))) continue;
    if (task.session_id) {
      // Shared session: one at a time per session
      if (!occupiedSids.has(task.session_id) && !startedSids.has(task.session_id)) {
        occupiedSids.add(task.session_id);
        startedSids.add(task.session_id);
        if (task.workdir) startedWorkdirs.add(task.workdir);
        startTask(task).catch(e => console.error('[taskWorker]', e));
      }
    } else {
      // Independent: up to MAX_TASK_WORKERS concurrent
      if (indepRunning < MAX_TASK_WORKERS) {
        indepRunning++;
        independentRunning.add(task.id);
        if (task.workdir) startedWorkdirs.add(task.workdir);
        startTask(task).catch(e => { independentRunning.delete(task.id); console.error('[taskWorker]', e); });
      }
    }
  }
}
// Run every 15s (fast enough to pick up unblocked tasks promptly,
// light enough to be negligible — just two SELECT queries on SQLite)
setInterval(processQueue, 15000);
// Safety net: periodically clean up orphaned activeChatSessions entries.
// An entry is orphaned if no WS connection has _tabBusy=true for it AND no activeTasks entry exists.
// This prevents permanent session lock from edge cases in the stale-finally path.
setInterval(() => {
  if (activeChatSessions.size === 0) return;
  for (const sid of activeChatSessions) {
    if (activeTasks.has(sid)) continue; // still running — keep
    let anyWsBusy = false;
    for (const client of wss.clients) {
      if (client._tabBusy?.[sid]) { anyWsBusy = true; break; }
    }
    if (!anyWsBusy) {
      activeChatSessions.delete(sid);
      log.warn('activeChatSessions orphan cleaned', { sessionId: sid });
      // Trigger dequeue on any live WS watching this session (queue may have been stuck)
      const watchers = sessionWatchers.get(sid);
      if (watchers) {
        for (const liveWs of watchers) {
          if (liveWs.readyState === 1 && liveWs._tabQueue?.[sid]?.length > 0) {
            liveWs.emit('message', JSON.stringify({ type: '_dequeue_next', tabId: sid }));
            break;
          }
        }
      }
    }
  }
}, 30000);
// Kick off on startup — smart recovery for in_progress tasks
setTimeout(() => {
  const stuck = db.prepare(`SELECT * FROM tasks WHERE status='in_progress'`).all();
  for (const task of stuck) {
    // Step 1: Kill orphaned subprocess to prevent double-execution.
    // When Node restarts, spawned 'claude' processes become OS orphans and keep running.
    // We kill them before deciding what to do with the task.
    if (task.worker_pid) {
      killByPid(task.worker_pid);
      console.log(`[startup] sent kill to orphan PID ${task.worker_pid} for task "${task.title}"`);
    }
    // Step 2: Determine if the task actually completed.
    // Assistant text is only written to DB on onDone — so its presence means success.
    let newStatus = 'todo'; // default: retry (task was interrupted)
    if (task.chain_id) {
      // Chain task: ALWAYS retry. Shared session has messages from other tasks in the
      // chain, so the "has assistant message" heuristic gives false positives.
      // --resume will recover full context from the shared Claude session.
      newStatus = 'todo';
    } else if (task.session_id) {
      const assistantMsg = db.prepare(
        `SELECT id FROM messages WHERE session_id=? AND role='assistant' AND type='text' LIMIT 1`
      ).get(task.session_id);
      if (assistantMsg) {
        if (task.recurrence && scheduleNextRun(task)) {
          // 🔄 Recurring: re-arm sets status='todo' + next scheduled_at, skip overwrite below
          newStatus = null; // signal: already handled
        } else {
          newStatus = 'done'; // completed before/during restart
        }
      }
    }
    if (newStatus) {
      db.prepare(`UPDATE tasks SET status=?, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
        .run(newStatus, task.id);
    }
    console.log(`[startup] recovered task "${task.title}" (${task.id}): in_progress → ${newStatus || 're-armed'}`);
  }
  processQueue();
}, 3000);

// Watchdog: detect tasks stuck in 'in_progress' with no live worker process.
// Runs every 60s. If a task is in_progress in DB but not in taskRunning (memory),
// the worker died without cleanup — recover the task.
setInterval(() => {
  const inProg = stmts.getInProgressTasks.all();
  for (const task of inProg) {
    if (taskRunning.has(task.id)) continue; // worker is alive
    // Worker is dead — recover
    log.warn(`[watchdog] task "${task.title}" (${task.id}) stuck in_progress with no live worker, recovering`);
    if (task.worker_pid) killByPid(task.worker_pid);
    const recovered = task.recurrence ? scheduleNextRun(task) : false;
    if (!recovered) {
      db.prepare(`UPDATE tasks SET status='todo', worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
        .run(task.id);
    }
    if (task.session_id) broadcastToSession(task.session_id, { type: 'done', tabId: task.session_id, taskId: task.id });
  }
}, 60000);

class WsProxy {
  constructor(ws) { this._ws = ws; this._buffer = []; }
  send(data) {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(data);
    } else if (this._buffer.length < 1000) {
      this._buffer.push(data);
    } else {
      // Past the cap the stream is dropped rather than grown without bound. Count it
      // so the reattaching client can be told its view is incomplete instead of
      // quietly missing tool cards.
      this._dropped = (this._dropped || 0) + 1;
    }
  }
  attach(newWs) {
    this._ws = newWs;
    const buf = this._buffer.splice(0);
    for (const msg of buf) { try { newWs.send(msg); } catch {} }
    // Tell the client its replay is incomplete instead of letting it believe an
    // unbroken stream. The text itself is re-read from the database on done; what
    // goes missing here is live activity, so say so rather than show a gap.
    if (this._dropped) {
      try { newWs.send(JSON.stringify({ type: 'stream_gap', dropped: this._dropped })); } catch {}
      this._dropped = 0;
    }
  }
  detach() { this._ws = null; }
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/sql',
  'application/x-sh',
  'application/x-shellscript',
  'image/svg+xml',
]);
const TEXT_FILE_EXTS = new Set([
  '.txt', '.md', '.mdx', '.json', '.csv', '.log', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.env', '.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss', '.less', '.sh', '.bash',
  '.zsh', '.sql', '.graphql', '.php', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp',
  '.swift', '.cs', '.vue', '.svelte', '.mjs', '.cjs', '.lock', '.pine',
]);

function isImageAttachment(att) {
  const type = String(att?.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  const name = String(att?.name || '').toLowerCase();
  const ext = path.extname(name);
  return IMAGE_EXTS.has(ext);
}

function getImageMimeType(att) {
  const type = String(att?.type || '').toLowerCase();
  if (type.startsWith('image/')) return type;
  switch (path.extname(String(att?.name || '').toLowerCase())) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.bmp':
      return 'image/bmp';
    case '.ico':
      return 'image/x-icon';
    case '.avif':
      return 'image/avif';
    default:
      return 'image/png';
  }
}

function isTextAttachment(att) {
  const type = String(att?.type || '').toLowerCase();
  if (TEXT_MIME_PREFIXES.some(prefix => type.startsWith(prefix))) return true;
  if (TEXT_MIME_EXACT.has(type)) return true;
  const name = String(att?.name || '').toLowerCase();
  const ext = path.extname(name);
  return TEXT_FILE_EXTS.has(ext);
}

function normalizeStoredAttachment(att = {}) {
  if (!att || typeof att !== 'object') return null;
  if (isImageAttachment(att)) {
    return {
      type: getImageMimeType(att),
      name: att.name || 'image.png',
      base64: att.base64 || '',
    };
  }
  if (att.type === 'ssh') {
    return {
      type: 'ssh',
      hostId: att.hostId || null,
      label: att.label || att.host || 'SSH',
      host: att.host || '',
      port: Number(att.port) || 22,
      sshKeyPath: att.sshKeyPath || '',
      password: att.password || '',
    };
  }
  return {
    type: att.type || att.mimeType || 'application/octet-stream',
    name: att.name || 'attachment.bin',
    base64: att.base64 || '',
  };
}

function serializeMessageAttachments(attachments = []) {
  return attachments
    .map(normalizeStoredAttachment)
    .filter(Boolean);
}

function parseMessageAttachments(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    return Array.isArray(parsed) ? parsed.map(normalizeStoredAttachment).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function buildAttachmentContentBlocks(attachments = []) {
  const blocks = [];
  for (const att of attachments) {
    if (isImageAttachment(att)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: getImageMimeType(att), data: att.base64 } });
      continue;
    }
    if (att.type === 'ssh') {
      let sshKeyPath = att.sshKeyPath || '';
      let password = att.password || '';
      if ((!sshKeyPath && !password) && att.hostId) {
        try {
          const rh = loadRemoteHosts().find(h => h.id === att.hostId);
          if (rh) {
            sshKeyPath = rh.sshKeyPath || '';
            password = decryptPassword(rh.password) || '';
          }
        } catch {}
      }
      let sshText = `[SSH Host: ${att.label || att.host || 'SSH'}]\nHost: ${att.host}:${att.port || 22}`;
      if (sshKeyPath) sshText += `\nSSH Key: ${sshKeyPath}`;
      else if (password) sshText += `\nPassword: ${password}`;
      blocks.push({ type: 'text', text: sshText });
      continue;
    }
    if (isTextAttachment(att)) {
      // Pass text files as 'file' blocks (same as images/binaries) so claude-cli.js
      // saves them to temp and passes paths — Claude CLI reads them via its Read tool.
      // This keeps the prompt small and avoids Windows command-line length limits.
      blocks.push({
        type: 'file',
        source: {
          type: 'base64',
          media_type: att.type || 'text/plain',
          data: att.base64,
          name: att.name || 'attachment.txt',
        },
      });
      continue;
    }
    blocks.push({
      type: 'file',
      source: {
        type: 'base64',
        media_type: att.type || 'application/octet-stream',
        data: att.base64,
        name: att.name || 'attachment.bin',
      },
    });
  }
  return blocks;
}

// Build Claude content blocks from text + file attachments.
// Returns plain string when no attachments, or ContentBlock[] when attachments present.
function buildUserContent(text, attachments = []) {
  if (!attachments || attachments.length === 0) return text;
  const blocks = buildAttachmentContentBlocks(attachments);
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

function buildReplyQuoteFromHistory(msgMap, replyToId) {
  if (!replyToId) return '';
  const ref = msgMap.get(replyToId);
  if (!ref?.content) return '';
  const snippet = String(ref.content).slice(0, 200);
  return `[Replying to: ${ref.role || 'user'}: ${snippet}]`;
}

function buildSessionReplayContent(sessionId) {
  const rawMsgs = stmts.getMsgsLite.all(sessionId);
  if (!rawMsgs.length) return null;

  const msgMap = new Map(rawMsgs.map(m => [m.id, m]));
  const blocks = [{
    type: 'text',
    text: '[Session recovery]\nThe previous Claude session was unavailable. Treat the following replay as the full prior conversation history for this chat. The latest user turn appears last and should be answered next.',
  }];

  let userTurn = 0;
  let assistantTurn = 0;
  for (const msg of rawMsgs) {
    if (msg.type === 'tool' || msg.type === 'thinking') continue;

    const attachments = parseMessageAttachments(msg.attachments);
    const replyQuote = buildReplyQuoteFromHistory(msgMap, msg.reply_to_id);

    if (msg.role === 'user') {
      userTurn++;
      blocks.push({ type: 'text', text: `[User turn ${userTurn}]` });
      if (replyQuote) blocks.push({ type: 'text', text: replyQuote });
      if (attachments.length) {
        blocks.push({ type: 'text', text: `[Attachments from user turn ${userTurn}]` });
        blocks.push(...buildAttachmentContentBlocks(attachments));
      }
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      continue;
    }

    if (msg.role === 'assistant' && msg.content) {
      assistantTurn++;
      blocks.push({ type: 'text', text: `[Assistant turn ${assistantTurn}]\n${msg.content}` });
    }
  }

  return blocks;
}

// ============================================
// CONFIG
// ============================================

/** Default slash commands — seeded into config.json on first run / fresh install. */
// `template` is the one-shot delegation form (existing behaviour). The terminal
// fields are what a live attached session needs: `interactive` starts a TUI,
// `newIdFlag` pins the conversation id we generate so a later resume is exact,
// `resume`/`resumeLast` restore after a host reboot or a reap.
//
// Every modern agent CLI can resume by id — the flag spelling is all that differs,
// which is why it lives in config and not in code. Only some can PIN the id of a
// new conversation (`newIdFlag`); for the rest we resume by id once we know one and
// otherwise fall back to "the agent's most recent conversation".
//
// Flags measured against the binaries installed on 2026-08-18 (codex-cli 0.147.0
// has no --session-id / --resume: it uses the `codex resume <id>` subcommand). A
// user whose CLI version differs edits these in the agent settings.
const DEFAULT_EXTERNAL_AGENTS = {
  claude:       { label: 'Claude Code',    interactive: 'claude',       newIdFlag: '--session-id {sid}', resume: 'claude --resume {sid}',       resumeLast: 'claude --continue' },
  codex:        { label: 'OpenAI Codex',   template: 'codex {prompt}',        interactive: 'codex',        resume: 'codex resume {sid}',        resumeLast: 'codex resume --last' },
  grok:         { label: 'Grok CLI',       interactive: 'grok',         newIdFlag: '-s {sid}',          resume: 'grok --resume {sid}',         resumeLast: 'grok --continue' },
  agy:          { label: 'Antigravity CLI', template: 'agy -i {prompt}',      interactive: 'agy',          resume: 'agy --conversation {sid}',  resumeLast: 'agy --continue' },
  opencode:     { label: 'opencode',       template: 'opencode run {prompt}', interactive: 'opencode',     resume: 'opencode -s {sid}',         resumeLast: 'opencode -c' },
  hermes:       { label: 'Hermes',         interactive: 'hermes',       resume: 'hermes --resume {sid}',       resumeLast: 'hermes --continue' },
  'cursor-agent': { label: 'Cursor Agent', interactive: 'cursor-agent', newIdCommand: 'cursor-agent create-chat', resume: 'cursor-agent --resume {sid}', resumeLast: 'cursor-agent --continue' },
  kimi:         { label: 'Kimi',           interactive: 'kimi',         resume: 'kimi --session {sid}',        resumeLast: 'kimi --continue' },
};

const DEFAULT_SLASH_COMMANDS = [
  { id: 'sc1', name: '/check',    text: 'Check this step by step: syntax, logic, edge cases, and potential bugs. Be thorough.' },
  { id: 'sc2', name: '/review',   text: 'Do a thorough code review: readability, performance, security, and adherence to best practices. Point out issues with severity levels (critical / warning / suggestion).' },
  { id: 'sc3', name: '/fix',      text: 'Find and fix the bug. Explain what caused it and exactly what you changed.' },
  { id: 'sc4', name: '/explain',  text: 'Explain this code clearly: what it does, how it works, and why it\'s structured this way. Use examples if helpful.' },
  { id: 'sc5', name: '/refactor', text: 'Refactor this code for clarity and maintainability. Keep the exact same behavior. Show what changed and why.' },
  { id: 'sc6', name: '/test',     text: 'Write comprehensive tests: happy path, edge cases, and error scenarios. Explain what each test covers.' },
  { id: 'sc7', name: '/docs',     text: 'Write clear documentation: purpose, parameters, return values, usage examples, and any gotchas.' },
  { id: 'sc8', name: '/optimize', text: 'Analyze performance and optimize. Identify bottlenecks, propose improvements, quantify the expected gains.' },
  { id: 'sc9', name: '/compact',  text: 'Summarize our conversation so far into a concise recap: key decisions made, what was built or changed, current state, and what still needs to be done. Be brief and structured.' },
  { id: 'sc10', name: '/init',    text: 'Analyze this project and create a CLAUDE.md file in the project root. Include: project overview, tech stack, architecture, key conventions, common commands (build, test, lint), and any gotchas a developer should know. Be thorough but concise.' },
];

/** Load LOCAL config only — used by write operations (add/delete MCP, upload/delete skill).
 *  Seeds default slash commands AND external agents into config.json on fresh install
 *  and after updates: only adds defaults not yet present — never overwrites user entries. */
function loadConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { c = {}; }
  if (!c.mcpServers)      c.mcpServers      = {};
  if (!c.skills)          c.skills          = {};
  if (!c.slashCommands)   c.slashCommands   = [];
  if (!c.externalAgents)  c.externalAgents  = {};
  if (!c._removedAgents)  c._removedAgents  = [];
  // Merge-in any default commands the user doesn't have yet (match by name).
  // This handles fresh installs AND version upgrades that add new defaults.
  let dirty = false;
  const existingNames = new Set(c.slashCommands.map(cmd => cmd.name));
  const toAdd = DEFAULT_SLASH_COMMANDS.filter(def => !existingNames.has(def.name));
  if (toAdd.length > 0) {
    c.slashCommands.push(...toAdd);
    dirty = true;
  }
  // Merge-in default external agents (skip explicitly removed ones). Backfills
  // newly-introduced fields (interactive/resume/...) onto agents the user already
  // customised, without touching any field they set themselves.
  if (mergeAgentDefaults(c, DEFAULT_EXTERNAL_AGENTS).dirty) dirty = true;
  // Terminal sessions are off until explicitly enabled: a browser terminal is
  // remote code execution by design, and this studio can be published through a
  // tunnel.
  if (!c.terminal) { c.terminal = { enabled: false, idleTimeoutMin: 30, maxLive: 3 }; dirty = true; }
  if (dirty) {
    // atomicWriteJSON, not a bare writeFileSync: this is the writer that CREATES
    // config.json on a fresh install, and config.json holds MCP `Authorization:
    // Bearer <api key>` headers — it must land at 0600 like every other write path.
    try { atomicWriteJSON(CONFIG_PATH, c); } catch {}
  }
  return c;
}

function readJsonIfExists(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function extractSkillUiMeta(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    let frontmatterDescription = '';
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
      if (descMatch) frontmatterDescription = descMatch[1].trim().replace(/^["']|["']$/g, '');
    }

    const body = content
      .replace(/^---\n[\s\S]*?\n---\n?/, '')
      .replace(/\r/g, '');
    const bodyLines = body.split('\n').map(line => line.trim());
    let paragraph = '';
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      if (!line || line.startsWith('#') || line.startsWith('```') || line.startsWith('|') || line.startsWith('- ') || line.startsWith('* ')) continue;
      if (i > 0 && (bodyLines[i - 1].startsWith('#') || bodyLines[i - 1] === '')) {
        paragraph = line;
        break;
      }
      if (!paragraph) paragraph = line;
    }

    const summary = frontmatterDescription || paragraph || '';
    return { summary: summary.slice(0, 320) };
  } catch {
    return { summary: '' };
  }
}

function normalizeSkillKeyPart(value, fallback) {
  const normalized = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function discoverFlatSkills(dirPath, makeEntry) {
  const out = {};
  if (!fs.existsSync(dirPath)) return out;
  for (const fileName of fs.readdirSync(dirPath).filter(f => f.endsWith('.md'))) {
    const id = path.parse(fileName).name;
    out[id] = makeEntry(fileName, id);
  }
  return out;
}

function addDiscoveredSkill(target, id, entry) {
  if (!target[id]) target[id] = entry;
}

function discoverPluginSkillsFromRoot(pluginRoot, source) {
  const out = {};
  const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return out;
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return out;

  const manifest = readJsonIfExists(manifestPath) || {};
  const pluginName = String(manifest.name || path.basename(pluginRoot) || 'plugin').trim();
  const pluginKey = normalizeSkillKeyPart(pluginName, 'plugin');
  const pluginVersion = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  const sourceLabel = source === 'marketplace'
    ? 'Marketplace plugin skill'
    : 'Installed plugin skill';

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const skillDir = path.join(skillsDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const uiMeta = extractSkillUiMeta(skillFile);
    const skillKey = normalizeSkillKeyPart(skillName, 'skill');
    const id = `plugin:${pluginKey}:${skillKey}`;
    const technicalDescription = pluginVersion
      ? `${sourceLabel} (${pluginName} v${pluginVersion})`
      : `${sourceLabel} (${pluginName})`;
    const tooltip = [
      uiMeta.summary || technicalDescription,
      technicalDescription,
      `Skill: ${skillName}`,
    ].join('\n\n');
    out[id] = {
      label: `🧩 ${pluginName}/${skillName}`,
      shortLabel: skillName,
      description: uiMeta.summary || technicalDescription,
      technicalDescription,
      tooltip,
      file: skillFile,
      plugin: true,
      pluginName,
      pluginVersion,
      pluginRoot,
      skillDir,
      category: 'plugin',
      external: true,
      source,
    };
  }

  return out;
}

function discoverMarketplacePluginSkills() {
  const out = {};
  if (!fs.existsSync(GLOBAL_PLUGIN_MARKETPLACES_DIR)) return out;
  for (const entry of fs.readdirSync(GLOBAL_PLUGIN_MARKETPLACES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginRoot = path.join(GLOBAL_PLUGIN_MARKETPLACES_DIR, entry.name);
    const discovered = discoverPluginSkillsFromRoot(pluginRoot, 'marketplace');
    for (const [id, skill] of Object.entries(discovered)) addDiscoveredSkill(out, id, skill);
  }
  return out;
}

function discoverCachedPluginSkills() {
  const out = {};
  if (!fs.existsSync(GLOBAL_PLUGIN_CACHE_DIR)) return out;
  for (const vendor of fs.readdirSync(GLOBAL_PLUGIN_CACHE_DIR, { withFileTypes: true })) {
    if (!vendor.isDirectory()) continue;
    const vendorDir = path.join(GLOBAL_PLUGIN_CACHE_DIR, vendor.name);
    for (const plugin of fs.readdirSync(vendorDir, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(vendorDir, plugin.name);
      for (const version of fs.readdirSync(pluginDir, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        const pluginRoot = path.join(pluginDir, version.name);
        const discovered = discoverPluginSkillsFromRoot(pluginRoot, 'cache');
        for (const [id, skill] of Object.entries(discovered)) addDiscoveredSkill(out, id, skill);
      }
    }
  }
  return out;
}

function addAutoDiscoveredSkills(config) {
  const merged = {
    ...config,
    skills: { ...(config.skills || {}) },
  };

  const globalSkills = discoverFlatSkills(GLOBAL_SKILLS_DIR, (fileName, id) => ({
    label: `🌐 ${id}`,
    description: 'Global skill (~/.claude/skills/)',
    file: path.join(GLOBAL_SKILLS_DIR, fileName),
    global: true,
  }));
  for (const [id, skill] of Object.entries(globalSkills)) addDiscoveredSkill(merged.skills, id, skill);

  const localSkills = discoverFlatSkills(SKILLS_DIR, (fileName, id) => {
    const meta = BUNDLED_SKILL_META[id] || {};
    return {
      label: meta.label || `📄 ${id}`,
      description: 'Local skill',
      file: `skills/${fileName}`,
      ...(meta.category ? { category: meta.category } : {}),
    };
  });
  for (const [id, skill] of Object.entries(localSkills)) addDiscoveredSkill(merged.skills, id, skill);

  const bundledSkillsDir = path.join(__dirname, 'skills');
  if (bundledSkillsDir !== SKILLS_DIR) {
    const bundledSkills = discoverFlatSkills(bundledSkillsDir, (fileName, id) => {
      const meta = BUNDLED_SKILL_META[id] || {};
      return {
        label: meta.label || `📄 ${id}`,
        description: 'Bundled skill',
        file: path.join(bundledSkillsDir, fileName),
        ...(meta.category ? { category: meta.category } : {}),
      };
    });
    for (const [id, skill] of Object.entries(bundledSkills)) addDiscoveredSkill(merged.skills, id, skill);
  }

  const marketplaceSkills = discoverMarketplacePluginSkills();
  for (const [id, skill] of Object.entries(marketplaceSkills)) addDiscoveredSkill(merged.skills, id, skill);

  const cachedPluginSkills = discoverCachedPluginSkills();
  for (const [id, skill] of Object.entries(cachedPluginSkills)) addDiscoveredSkill(merged.skills, id, skill);

  return merged;
}

/** Write to temp file then atomic rename — prevents partial reads on concurrent access.
 *  0600 because everything routed through here can carry secrets: config.json holds MCP
 *  `Authorization: Bearer <api key>` headers, remote-hosts.json / projects.json hold SSH
 *  user+port and encrypted passwords. Mirrors atomicWrite() in auth.js.
 *  The explicit chmod is not belt-and-braces: the { mode } option is applied only when
 *  the file is CREATED, so a .tmp left behind by an older version (or a crash) keeps its
 *  old 0644 — and rename() carries the tmp inode's mode onto the target. Verified both
 *  behaviours on darwin/APFS before writing this. */
function atomicWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {} // filesystem without POSIX modes — write still succeeds
  fs.renameSync(tmp, filePath);
}

function saveConfig(c) {
  atomicWriteJSON(CONFIG_PATH, c);
  _mergedConfigCache = null; // invalidate on every write
  _skillContentCache.clear(); // skill files may have changed
  _systemPromptCache.clear(); // prompts depend on skill content
}

// In-memory cache for the merged (global + local) config.
// Hot path: processChat calls loadMergedConfig() on every request — caching
// eliminates 2× readFileSync per chat turn.
// Invalidated by saveConfig() and by GET /api/config (which forces a fresh
// read so the config UI always reflects the current state on disk).
let _mergedConfigCache = null;

/** Merge global (~/.claude/config.json) + local config.json for read/display/execution.
 *  Local entries override global entries with the same key. */
function loadMergedConfig() {
  if (_mergedConfigCache !== null) return _mergedConfigCache;
  let g = {}, l = {};
  try { g = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')); } catch {}
  try { l = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  _mergedConfigCache = addAutoDiscoveredSkills({
    mcpServers:    { ...(g.mcpServers||{}), ...(l.mcpServers||{}) },
    skills:        { ...(g.skills||{}),     ...(l.skills||{})     },
    slashCommands: [...(l.slashCommands||[])],
    lang:          l.lang || g.lang || 'en',
    defaultEngine: l.defaultEngine || g.defaultEngine || 'api',
    recentProjectsCount: l.recentProjectsCount ?? g.recentProjectsCount ?? 5,
  });
  return _mergedConfigCache;
}

/** Resolve skill file path.
 *  - Absolute path → used as-is.
 *  - Relative path → try ~/.claude/skills/<basename> first, then project root. */
function resolveSkillFile(file) {
  if (path.isAbsolute(file)) return file;
  const globalPath = path.join(GLOBAL_SKILLS_DIR, path.basename(file));
  if (fs.existsSync(globalPath)) return globalPath;
  // Try APP_DIR first (user-uploaded skills), then __dirname (bundled skills)
  const appPath = path.join(APP_DIR, file);
  if (fs.existsSync(appPath)) return appPath;
  return path.join(__dirname, file);
}

// ─── Skill content cache (avoids fs.readFileSync on every chat turn) ─────────
// Key: resolved file path → { content, mtimeMs }
// Invalidated when file mtime changes. saveConfig() clears entire cache.
const _skillContentCache = new Map();
function getSkillContent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cached = _skillContentCache.get(filePath);
    if (cached && cached.mtimeMs >= stat.mtimeMs) return cached.content;
    const content = fs.readFileSync(filePath, 'utf-8');
    _skillContentCache.set(filePath, { content, mtimeMs: stat.mtimeMs });
    return content;
  } catch { return ''; }
}

// ─── System prompt builder with caching ──────────────────────────────────────
// Caches assembled system prompt by sorted skill IDs → avoids repeated string
// concatenation + disk reads on every chat turn with the same skill set.
const _systemPromptCache = new Map();
const MAX_PROMPT_CACHE_SIZE = 32;

// Base instructions (always included) — kept concise to save tokens
const BASE_SYSTEM_INSTRUCTIONS = `When you are answering a specific question or task that is one of several questions or tasks in the user's message, begin your response with a short quote (1–2 lines) of that specific question or task formatted as a markdown blockquote:
> <original question or task text>
Then provide your answer below it. Do not add the blockquote if the message contains only a single question or task.`;

// Language names for UI language instruction
const LANG_NAMES = { en: 'English', uk: 'Ukrainian', ru: 'Russian', fr: 'French', he: 'Hebrew' };

// Internal MCP tool instructions — compact versions (~140 tokens vs original ~240)
const ASK_USER_INSTRUCTION = `\n\nYou have access to an "ask_user" tool (via MCP server "_ccs_ask_user"). When you need user input BEFORE proceeding — such as choosing between approaches, confirming an action, or clarifying requirements — you MUST call ask_user instead of writing questions as text. The ask_user tool pauses execution and waits for the user's response. Do NOT ask questions in your text output and then continue working — always use the ask_user tool for questions.`;

const NOTIFY_USER_INSTRUCTION = `\n\nYou have access to a "notify_user" tool (via MCP server "_ccs_notify"). Use it to send non-blocking progress updates to the user. Call notify_user for milestones ("Completed database migration"), warnings ("Rate limit approaching"), errors ("Test suite has 3 failures"), or progress tracking (with current/total steps). Unlike ask_user, notify_user does NOT pause execution — you continue working immediately. Do NOT overuse it: send notifications only for meaningful status changes, not for every minor step.`;

const SET_UI_STATE_INSTRUCTION = `\n\nYou have access to a "set_ui_state" tool (via MCP server "_ccs_set_ui_state"). You MUST call this tool when you transition between phases so the UI toolbar reflects your current state. Specifically:
- When you finish PLANNING and start EXECUTING: call set_ui_state({ mode: "auto" }) IMMEDIATELY
- When you switch models: call set_ui_state({ model: "opus" }) or set_ui_state({ model: "haiku" })
This is REQUIRED behavior, not optional. The tool is fire-and-forget — execution continues immediately.`;

const TASK_MANAGER_INSTRUCTION = `\n\nYou have access to task management tools (via MCP server "_ccs_task_manager"):
- **create_task**: Create a new task for follow-up work. Pass curated context so the child task knows what to do.
- **create_chain**: Create multiple sequential tasks in one call. Tasks run in order with shared session.
- **list_tasks**: Check existing tasks (useful to avoid duplicates before creating new ones).
- **get_current_task**: Read YOUR task details including context passed by the parent. Call this FIRST if you were created by another task.
- **report_result**: Store structured output (JSON) so dependent tasks can read it via get_task_result.
- **get_task_result**: Read the result of a completed task you depend on.
- **cancel_task**: Cancel a task that is no longer needed.
When creating child tasks, decide carefully what context to pass — include only what the child needs (issue details, file paths, error messages), not your entire conversation.
Most tasks should be completed directly without creating subtasks. Only create child tasks when the work genuinely requires decomposition into independent units.`;

const USER_INTERRUPT_INSTRUCTION = `\n\nYou have access to a "check_user_messages" tool (via MCP server "_ccs_user_interrupt"). The user can send clarifications or corrections WHILE you are working. Call check_user_messages BEFORE starting each major step (e.g. before editing files, running commands, or making design decisions). If it returns messages, acknowledge them and adjust your approach. If no messages, continue normally. This check is lightweight — do not skip it.`;

// Only appended when the bot actually has peers. The roster block already lists them;
// without this the bot reads the list as trivia, because nothing tells it the list is
// actionable. Says "after you finish" twice on purpose — the failure mode in testing was
// a bot calling message_bot and then writing its answer as if the reply had come back.
const BOTS_DISPATCH_INSTRUCTION = `\n\nYou can hand work to any bot in the roster above with the "message_bot" tool (MCP server "_ccs_bots"): message_bot(handle, task). Use it when the work genuinely belongs to someone else's specialty — not to split your own task or to ask a peer's opinion. The bot runs AFTER you finish your turn, in the same conversation, and the user sees its answer directly. You will NOT see its reply, so never write as if you had: finish your own answer completely, and mention the hand-off in one line. Write "task" so it stands alone — the callee sees only that text, not this conversation.`;

// Status line + tool call instructions (~100 tokens vs original ~170)
const STATUS_LINE_INSTRUCTION = `\n\nIMPORTANT: Always end your response with a single clear status line separated by "---". Use one of these patterns:
- "✅ Done — [brief summary of what was completed]." when the task is fully finished.
- "⏳ In progress — [what's happening now and what comes next]." when you're still working and will continue.
- "❓ Waiting for input — [what you need from the user]." when you need the user to answer or decide something.
- "⚠️ Blocked — [what went wrong and what's needed to proceed]." when something prevents you from continuing.
This status line must always be the very last thing in your response. Never skip it.`;

const TOOL_CALL_INSTRUCTION = `\n\nCRITICAL: After finishing tool calls (Read, Bash, Edit, Write, Grep, etc.), you MUST write a final text response with the status line. NEVER end your turn on a tool call without a text summary. The user cannot see tool results — they only see your text. If you called tools, summarize what you found or did in 1-3 sentences, then add the "---" status line.`;

// Mandatory verification suffix — appended to every Kanban task prompt.
// Stays in context on --resume turns because it is part of the first user message.
const TASK_VERIFICATION_SUFFIX = `

---
## MANDATORY POST-TASK VERIFICATION

After completing all work above, run this verification loop BEFORE finishing:

### Step 1 — Requirements Audit
Re-read the task and list every requirement explicitly (numbered).

### Step 2 — Proof of Completion
For each requirement: run a command or inspect output that PROVES it is satisfied.
Do NOT skip — execute actual commands and show the output.

### Step 3 — Fix & Re-verify
If any check fails: fix it immediately, then re-run the exact check to confirm it passes.

### Step 4 — Self-Audit
Ask: "If a senior engineer reviews this right now, would they approve without any changes?"
If the answer is no — fix the issues first.

### Verification Report (required, always at the end)
\`\`\`
VERIFICATION:
✅ [requirement 1]: [command / output as proof]
✅ [requirement 2]: [command / output as proof]
❌ [requirement N]: ISSUE FOUND → FIXED: [what was done] → ✅ confirmed
FINAL: ✅ All requirements verified [/ ⚠️ N issues found and fixed]
\`\`\``;

/**
 * Build system prompt for a chat turn.
 * Caches by sorted skill IDs + UI language to avoid rebuilding identical prompts.
 * @param {string[]} skillIds - active skill IDs
 * @param {object} config - merged config with skills definitions and UI language
 * @returns {string} assembled system prompt
 */
function buildSystemPrompt(skillIds, config) {
  const uiLang = config.lang || 'en';
  const cacheKey = [...skillIds].sort().join('|') + `|lang:${uiLang}`;
  const cached = _systemPromptCache.get(cacheKey);
  if (cached) return cached;

  let prompt = BASE_SYSTEM_INSTRUCTIONS;

  // Language instruction: reasoning in English, user-facing in UI language
  const langName = LANG_NAMES[uiLang] || 'English';
  prompt += `\n\nLANGUAGE: All internal reasoning, thinking, and inter-agent communication MUST be in English (token-efficient). All user-facing text (responses, explanations, questions) MUST be in ${langName}.`;

  for (const sid of skillIds) {
    const s = config.skills[sid];
    if (!s) continue;
    const resolvedFile = resolveSkillFile(s.file);
    const content = getSkillContent(resolvedFile);
    if (!content) continue;
    if (s.plugin) {
      const skillDir = s.skillDir || path.dirname(resolvedFile);
      const pluginRoot = s.pluginRoot || path.resolve(skillDir, '..', '..');
      prompt += `\n\n--- SKILL: ${s.label} ---\nPLUGIN CONTEXT:\n- Plugin root: ${pluginRoot}\n- Skill directory: ${skillDir}\n- If the skill text references \${CLAUDE_PLUGIN_ROOT}, use the plugin root above.\n- Relative paths like references/, examples/, and scripts/ are relative to the skill directory above.\n${content}`;
      continue;
    }
    prompt += `\n\n--- SKILL: ${s.label} ---\n${content}`;
  }

  prompt += ASK_USER_INSTRUCTION;
  prompt += NOTIFY_USER_INSTRUCTION;
  prompt += SET_UI_STATE_INSTRUCTION;
  prompt += USER_INTERRUPT_INSTRUCTION;
  prompt += STATUS_LINE_INSTRUCTION;
  prompt += TOOL_CALL_INSTRUCTION;

  // Evict oldest if cache full
  if (_systemPromptCache.size >= MAX_PROMPT_CACHE_SIZE) {
    const oldest = _systemPromptCache.keys().next().value;
    _systemPromptCache.delete(oldest);
  }
  _systemPromptCache.set(cacheKey, prompt);
  return prompt;
}

// ============================================
// LLM-BASED TASK CLASSIFIER (haiku)
// ============================================
// Single haiku call returns both specialist skills AND a short chat title.
// Replaces client-side keyword matching + ugly message truncation.
// Haiku via CLI → ~10-15s (CLI overhead), but runs before main agent.
const CLASSIFY_TIMEOUT_MS = 45000;

async function classifyTask(userMessage, currentSkills, config, workdir) {
  // Filter out meta/system skills that are never useful for task classification
  const CLASSIFIER_SKIP = /^auto-mode$|:cancel$|:help$|:doctor$|:setup$|:omc-setup$|:release$|:skill$|:learner$|:local-skills-setup$|:mcp-setup$|:hud$|:note$|:psm$|:project-session-manager$|:learn-about-omc$/;
  const catalog = Object.entries(config.skills || {})
    .filter(([id]) => !CLASSIFIER_SKIP.test(id))
    .map(([id, s]) => {
      const label = (s.label || id).replace(/^\S+\s/, '');
      const desc = s.description || '';
      const kw = Array.isArray(s.keywords) && s.keywords.length ? ` [${s.keywords.join(', ')}]` : '';
      return `- ${id}: ${label} — ${desc}${kw}`;
    })
    .join('\n');

  const currentCtx = currentSkills.length
    ? `\nCurrently active: ${currentSkills.filter(id => id !== 'auto-mode').join(', ')}`
    : '';

  const prompt = `Specialists:\n${catalog}${currentCtx}\n\nUser task: "${userMessage.substring(0, 600)}"`;

  const cli = new ClaudeCLI({ cwd: workdir });

  return new Promise((resolve) => {
    let fullText = '';
    let settled = false;
    const fallback = { skills: [], title: '' };
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(fallback); }
    }, CLASSIFY_TIMEOUT_MS);

    cli.send({
      prompt,
      model: 'haiku',
      maxTurns: 1,
      settingSources: 'user', // skip project CLAUDE.md — service call, everything explicit
      tools: '',           // disable all built-in tools (--tools "")
      mcpServers: {},
      systemPrompt: 'You are a task classifier. Analyze the user task and:\n1. Select 1-4 most relevant specialist IDs from the list\n2. Generate a short chat title (3-7 words, in the SAME language as user\'s message)\n\nRules:\n- Match the INTENT and DOMAIN of the task to specialists. The user may write in any language — match meaning, not exact words.\n- When the task clearly relates to a domain (design, UI, UX, security, backend, frontend, etc.) — always select ALL matching specialists from the list, including plugin specialists (IDs starting with "plugin:").\n- For coding tasks — select the most relevant engineering specialist(s).\n- Prefer selecting a relevant specialist over skipping. When in doubt, include it.\n- Plugin skills (IDs like "plugin:name:skill") are equally valid — select them when their description matches the task.\n- Skip only: generic meta/system/setup/cancel skills, and pure general-knowledge questions with no coding/design/engineering aspect.\n- Use the keywords field [in brackets] (if present) to improve matching — they describe typical tasks for each specialist.\n- Return the EXACT skill IDs as shown in the list. Copy them precisely, including any "plugin:" prefix.\n\nReturn ONLY a JSON object: {"skills":["id1","id2"],"title":"Short title here"}\nNo explanation, no markdown.',
    })
    .onText(t => { fullText += t; })
    .onDone(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const match = fullText.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          const rawSkills = parsed.skills || [];
          const skills = rawSkills.filter(id => typeof id === 'string' && config.skills[id] && id !== 'auto-mode');
          const rejected = rawSkills.filter(id => typeof id === 'string' && !config.skills[id]);
          const title = typeof parsed.title === 'string' ? parsed.title.trim().substring(0, 80) : '';
          if (rejected.length) log.warn('[classify] Haiku returned unknown skill IDs', { rejected });
          log.info('[classify] raw response', { rawSkills, accepted: skills, title });
          resolve({
            skills: skills.length > 0 && config.skills['auto-mode'] ? ['auto-mode', ...skills] : skills,
            title,
          });
          return;
        }
        log.warn('[classify] No JSON found in Haiku response', { fullText: fullText.substring(0, 300) });
        resolve(fallback);
      } catch {
        resolve(fallback);
      }
    })
    .onError(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

// ============================================
// PROJECTS
// ============================================
function loadProjects() { try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8')); } catch { return []; } }
function saveProjects(p) { const d=path.dirname(PROJECTS_FILE); if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); atomicWriteJSON(PROJECTS_FILE, p); }

/**
 * Get notification context (session title + project name) for enriching notification payloads.
 * @param {string} sessionId - session ID to look up
 * @returns {{ sessionTitle: string|null, projectName: string|null }}
 */
function getNotificationContext(sessionId) {
  if (!sessionId) return { sessionTitle: null, projectName: null };
  try {
    const sess = stmts.getSession.get(sessionId);
    if (!sess) return { sessionTitle: null, projectName: null };
    const sessionTitle = (sess.title && !DEFAULT_SESSION_TITLES.has(sess.title)) ? sess.title : null;
    let projectName = null;
    if (sess.workdir) {
      const proj = loadProjects().find(p => p.workdir === sess.workdir);
      projectName = proj?.name || null;
    }
    return { sessionTitle, projectName };
  } catch {
    return { sessionTitle: null, projectName: null };
  }
}

function loadRemoteHosts() { try { return JSON.parse(fs.readFileSync(REMOTE_HOSTS_FILE, 'utf-8')); } catch { return []; } }
function saveRemoteHosts(h) { const d=path.dirname(REMOTE_HOSTS_FILE); if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); atomicWriteJSON(REMOTE_HOSTS_FILE, h); }

// ─── SSH password encryption (AES-256-GCM, persistent key) ───────────────────
// Key is generated once and stored in data/hosts.key (600 perms).
// Stored format: "enc:<base64(16-byte-IV + 16-byte-authTag + ciphertext)>"
// Prefix "enc:" enables backward compatibility with existing plaintext entries.
function _loadOrCreateHostsKey() {
  try { const k = fs.readFileSync(HOSTS_KEY_FILE); if (k.length === 32) return k; } catch {}
  const k = crypto.randomBytes(32);
  const d = path.dirname(HOSTS_KEY_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(HOSTS_KEY_FILE, k, { mode: 0o600 });
  return k;
}
const HOSTS_ENCRYPT_KEY = _loadOrCreateHostsKey();

function encryptPassword(plain) {
  if (!plain) return '';
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv('aes-256-gcm', HOSTS_ENCRYPT_KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decryptPassword(stored) {
  if (!stored) return '';
  if (!stored.startsWith('enc:')) return stored; // backward compat: plaintext
  try {
    const buf = Buffer.from(stored.slice(4), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', HOSTS_ENCRYPT_KEY, buf.subarray(0, 16));
    d.setAuthTag(buf.subarray(16, 32));
    return d.update(buf.subarray(32)).toString('utf8') + d.final('utf8');
  } catch { return ''; }
}

// A remote project keeps its own copy of the host's SSH password. Projects created
// before encryption landed stored it as plaintext, and decryptPassword's
// backward-compat branch reads plaintext happily — so those rows were never upgraded
// and sat readable on disk indefinitely. Rewrite them once, at boot.
(function migratePlaintextProjectPasswords() {
  try {
    const projects = loadProjects();
    let n = 0;
    for (const pr of projects) {
      if (pr.password && !String(pr.password).startsWith('enc:')) {
        pr.password = encryptPassword(String(pr.password));
        n++;
      }
    }
    if (n) { saveProjects(projects); log.info('encrypted plaintext project passwords', { count: n }); }
  } catch (e) {
    log.warn('project password migration skipped', { err: e.message });
  }
})();

// testSshConnection is now exported from claude-ssh.js (uses ssh2 library, supports password auth)

// ============================================
// EXECUTION ENGINES
// ============================================

// Maximum number of auto-continue attempts when agent hits --max-turns limit.
// Each continue resumes the session, giving the agent another maxTurns window.
const MAX_AUTO_CONTINUES = 3;
const MAX_RATE_LIMIT_WAITS = 3;
const MAX_RATE_LIMIT_WAIT_MS = 30 * 60 * 1000; // 30 min — skip auto-wait if reset is further out
const MIN_RATE_LIMIT_WAIT_MS = 10 * 1000; // 10s floor to avoid rapid-fire retries
// Transient server-side overload (HTTP 429/529 "temporarily limiting requests") — a brief
// throttle, NOT the account usage quota. Short pause + retry (per "15–30s" guidance), not the
// long reset-based wait above. Backoff grows mildly so a sustained throttle eases off.
const MAX_OVERLOAD_RETRIES = 5;
const OVERLOAD_BACKOFF_BASE_MS = 20 * 1000; // 20s — first pause
const OVERLOAD_BACKOFF_STEP_MS = 10 * 1000; // +10s per subsequent attempt
const OVERLOAD_BACKOFF_MAX_MS = 60 * 1000;  // cap at 60s

// Sleep that resolves on timeout or when signal fires (whichever first)
function _sleepAbortable(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isResettableClaudeSessionError(errorText = '') {
  return /Invalid signature in thinking block|invalid session|session .* not found|could not find .*session|no conversation found|resume .*failed|failed to resume|conversation .* not found/i.test(errorText || '');
}

// --- CLI Single Agent ---
async function runCliSingle(p) {
  const { prompt, userContent, systemPrompt, mcpServers, model, maxTurns, ws, sessionId, abortController, claudeSessionId, forkSession, mode, workdir, tabId, name, effort } = p;
  const mp = mode==='planning' ? 'MODE: PLANNING ONLY. Analyze, plan, DO NOT modify files.\n\n' : mode==='task' ? 'MODE: EXECUTION.\n\n' : '';
  const sp = (mp + (systemPrompt||'')).trim() || undefined;
  // MCP tools must use the mcp__<serverName>__<toolName> format in allowedTools
  const mcpTools = ['mcp___ccs_set_ui_state__set_ui_state', 'mcp___ccs_ask_user__ask_user', 'mcp___ccs_notify__notify_user', 'mcp___ccs_user_interrupt__check_user_messages'];
  const tools = mode==='planning'
    ? ['View','GlobTool','GrepTool','ListDir','ReadNotebook', ...mcpTools]
    : ['Bash','View','GlobTool','GrepTool','ReadNotebook','NotebookEditCell','ListDir','SearchReplace','Write', ...mcpTools];
  const effectiveMaxTurns = maxTurns || 30;
  let fullText = '', fullThinking = '', newCid = claudeSessionId, chunkCount = 0;
  let currentPrompt = prompt;
  let continueCount = 0;
  let rateLimitWaitCount = 0;
  let overloadRetryCount = 0;
  // Usage of the most recent assistant turn (real context-window occupancy at the
  // end). Persists across auto-continue iterations; the last write wins.
  let lastTurnUsage = null;
  // First invocation carries attachments; subsequent auto-continues do not
  let currentContentBlocks = Array.isArray(userContent) ? userContent : null;

  const cli = new ClaudeCLI({ cwd: workdir || WORKDIR });
  let pendingFork = !!forkSession; // only fork on first CLI call

  // Run a single CLI invocation and return { resultData, sid, errorText, rateLimitInfo }
  const runOnce = (runPrompt, contentBlocks, resumeId) => new Promise((resolve) => {
    let resultData = null;
    let errorText = '';
    let rateLimitInfo = null;
    let _done = false;
    const _finish = (sid) => { if (!_done) { _done = true; resolve({ resultData, sid, errorText, rateLimitInfo }); } };
    const useFork = pendingFork; pendingFork = false;

    // Inject PreToolUse + Stop hooks for mid-task interrupt delivery via --settings.
    // PreToolUse covers tasks that call tools; Stop closes the gap for text-only answers
    // (or the text tail after the last tool call), where a user clarification would
    // otherwise be drained undelivered in finally (see pendingInterrupts cleanup below).
    // Both consume the same one-shot queue, so an emptied queue makes the next Stop
    // approve — no infinite loop.
    const interruptCmd = `"${NODE_CMD}" "${path.join(__dirname, 'hooks', 'check-interrupt.js')}"`;
    const interruptHookSettings = {
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: interruptCmd, timeout: 3 }] }],
        Stop: [{ hooks: [{ type: 'command', command: interruptCmd, timeout: 3 }] }],
      },
    };
    const interruptEnv = {
      CCS_INTERRUPT_URL: `http://127.0.0.1:${PORT}`,
      CCS_INTERRUPT_SESSION: sessionId,
      CCS_INTERRUPT_SECRET: INTERRUPT_SECRET,
    };

    cli.send({ prompt: runPrompt, contentBlocks, sessionId: resumeId, model, maxTurns: effectiveMaxTurns, systemPrompt: sp, mcpServers, allowedTools: tools, abortController, forkSession: useFork, extraEnv: interruptEnv, extraSettings: interruptHookSettings, name, effort })
      .onText(t => {
        fullText += t;
        { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        ws.send(JSON.stringify({ type:'text', text:t, ...(tabId ? { tabId } : {}) }));
        if (++chunkCount % 5 === 0) {
          try { stmts.setPartialText.run(fullText, sessionId); } catch {}
        }
      })
      .onThinking(t => { fullThinking += t; log.info('[THINKING-DIAG-CLI] onThinking fired', { len: t.length, totalLen: fullThinking.length, sessionId }); ws.send(JSON.stringify({ type:'thinking', text:t, ...(tabId ? { tabId } : {}) })); })
      .onTool((name, inp) => {
        if (name === 'ask_user' || name === 'notify_user' || name === 'set_ui_state' || name === 'check_user_messages') {
          try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
          return;
        }
        // AskUserQuestion (the CLI's own question tool) deliberately falls through to the
        // generic tool block; 9b9d8b9 used to drop it here, so the user saw a silent gap
        // where a question should be. Two things that commit got wrong, recorded so nobody
        // reinstates the branch: the bogus "ask card" it was killing came from the `Task*`
        // family (`'task'.includes('ask')` is true in the old substring filter), not from
        // AskUserQuestion; and bypass did NOT auto-resolve this tool on CLI 2.1.59.
        // On 2.1.228 the tool is gated out of headless runs entirely (isEnabled() is false
        // when non-interactive without --permission-prompt-tool), so this line is insurance
        // for older and future builds rather than a live path. Visible-but-unanswerable is
        // the honest behaviour — `claude -p` has stdin closed, so an answerable card would
        // be a lie. Do not add one back unless the CLI gains a way to receive the answer.
        ws.send(JSON.stringify({ type:'tool', tool:name, input:(inp||'').substring(0,600), ...(tabId ? { tabId } : {}) }));
        try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
      })
      .onSessionId(sid => { newCid = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
      .onRateLimit(info => {
        try { ws.send(JSON.stringify({ type:'rate_limit', info, ...(tabId ? { tabId } : {}) })); } catch {}
        if (info && info.status === 'rejected') rateLimitInfo = info;
      })
      .onResult(r => { resultData = r; })
      .onUsage(u => { if (u) lastTurnUsage = u; })
      .onError(err => {
        // Capture error text for the main loop to inspect (e.g. thinking block signature errors)
        errorText += err;
        // Don't resolve here — let onDone be the sole resolver (matches taskWorker pattern).
        // This ensures resultData is fully populated before the loop checks it.
        try { ws.send(JSON.stringify({ type:'error', error:err.substring(0,500), ...(tabId ? { tabId } : {}) })); } catch {}
      })
      .onDone(sid => {
        if (sid) newCid = sid;
        _finish(newCid);
      });
  });

  // Main loop: run agent, auto-continue until it finishes successfully or budget exhausted
  let lastResult = null;
  let totalCostUsd = 0;
  while (true) {
    const fullTextBefore = fullText.length;
    const { resultData, errorText, rateLimitInfo } = await runOnce(currentPrompt, currentContentBlocks, newCid);
    const hadOutputBeforeRateLimit = fullText.length > fullTextBefore;
    lastResult = resultData;
    totalCostUsd += resultData?.total_cost_usd || 0;

    // 🌐 Transient server overload (HTTP 429/529 "temporarily limiting requests").
    // NOT the account usage quota — the server is briefly throttling and the request
    // just needs a short pause + retry. The CLI reports it as assistant text or in the
    // result payload (never stderr), so it bypasses the errorText detector below and can
    // even ride along with subtype:'success'. Detect it here, before the success break.
    {
      const lastTurnText = fullText.slice(fullTextBefore);
      const resultText = typeof resultData?.result === 'string' ? resultData.result : '';
      // shouldRetryOverload skips clean successes (incidental phrase, e.g. the user asking
      // about this very error) and structured usage-quota rejections (own reset-based wait).
      if (shouldRetryOverload({ texts: [lastTurnText, resultText, errorText], subtype: resultData?.subtype, isError: resultData?.is_error, rateLimitRejected: rateLimitInfo?.status === 'rejected' })) {
        if (overloadRetryCount >= MAX_OVERLOAD_RETRIES) {
          const notice = `\n\n⚠️ **Server overloaded** — still limiting after ${MAX_OVERLOAD_RETRIES} retries. Please try again shortly.\n\n`;
          fullText += notice;
          { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
          try { ws.send(JSON.stringify({ type:'text', text: notice, session_restart_available: true, sessionId, ...(tabId ? { tabId } : {}) })); } catch {}
          break;
        }
        overloadRetryCount++;
        const backoffMs = Math.min(OVERLOAD_BACKOFF_BASE_MS + (overloadRetryCount - 1) * OVERLOAD_BACKOFF_STEP_MS, OVERLOAD_BACKOFF_MAX_MS);
        const backoffSec = Math.ceil(backoffMs / 1000);
        log.warn('overload-backoff', { sessionId, attempt: overloadRetryCount, maxAttempts: MAX_OVERLOAD_RETRIES, backoffMs });
        const notice = `\n\n⏳ **Server busy** — temporarily limiting requests (not your usage limit). Pausing ~${backoffSec}s and retrying (${overloadRetryCount}/${MAX_OVERLOAD_RETRIES})...\n\n`;
        fullText += notice;
        { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
        try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'waiting', secondsLeft: backoffSec, rateLimitType: 'overloaded', attempt: overloadRetryCount, maxAttempts: MAX_OVERLOAD_RETRIES, ...(tabId ? { tabId } : {}) })); } catch {}

        const waitEnd = Date.now() + backoffMs;
        while (Date.now() < waitEnd) {
          if (abortController?.signal?.aborted) break;
          const remaining = Math.max(0, Math.ceil((waitEnd - Date.now()) / 1000));
          try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'countdown', secondsLeft: remaining, rateLimitType: 'overloaded', ...(tabId ? { tabId } : {}) })); } catch {}
          await _sleepAbortable(Math.min(5000, remaining * 1000), abortController?.signal);
        }
        if (abortController?.signal?.aborted) break;

        try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'resuming', rateLimitType: 'overloaded', ...(tabId ? { tabId } : {}) })); } catch {}
        const resumeNotice = '\n✅ **Resuming**...\n\n';
        fullText += resumeNotice;
        { const _cb = (chatBuffers.get(sessionId) || '') + resumeNotice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text: resumeNotice, ...(tabId ? { tabId } : {}) })); } catch {}

        // Switch to a continuation prompt only when a session exists to resume AND real
        // output streamed before the throttle. Otherwise (no session yet, or result-only
        // error) keep the original prompt + attachments so the retry re-sends the request —
        // never "continue where you left off" against an empty/non-existent session.
        if (newCid && hadOutputBeforeRateLimit) {
          currentPrompt = 'Continue where you left off. Complete the remaining work.';
          currentContentBlocks = null;
        }
        continue;
      }
    }

    // ✅ Success — agent finished naturally
    if (resultData?.subtype === 'success') break;

    // 🚦 Rate limit rejected — wait for reset and auto-retry
    {
      const isRateLimitRejected = (rateLimitInfo?.status === 'rejected') ||
        (errorText && /rate.?limit|overloaded|too many requests|429/i.test(errorText));
      if (isRateLimitRejected) {
        const resetsAt = rateLimitInfo?.resetsAt;
        const rateLimitType = rateLimitInfo?.rateLimitType || 'unknown';
        const waitMs = Math.max(MIN_RATE_LIMIT_WAIT_MS, resetsAt ? (resetsAt * 1000) - Date.now() + 5000 : 60000 * (rateLimitWaitCount + 1)); // +5s buffer, fallback 60s

        // Don't auto-wait if retries exhausted, too far away, or 7-day limit
        if (rateLimitWaitCount >= MAX_RATE_LIMIT_WAITS || waitMs > MAX_RATE_LIMIT_WAIT_MS || rateLimitType === 'seven_day') {
          const reason = rateLimitWaitCount >= MAX_RATE_LIMIT_WAITS ? 'retries exhausted' : rateLimitType === 'seven_day' ? '7-day limit' : 'reset too far';
          const notice = `\n\n⚠️ **Rate limit** — ${reason}. Please retry manually later.\n\n`;
          fullText += notice;
          { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
          try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
          break;
        }

        rateLimitWaitCount++;
        const waitSec = Math.ceil(waitMs / 1000);
        log.warn('rate-limit-wait', { sessionId, rateLimitType, resetsAt, waitMs, attempt: rateLimitWaitCount, maxAttempts: MAX_RATE_LIMIT_WAITS });

        const notice = `\n\n⏳ **Rate limit** (${rateLimitType}) — auto-waiting ~${Math.ceil(waitSec / 60)} min for reset (${rateLimitWaitCount}/${MAX_RATE_LIMIT_WAITS})...\n\n`;
        fullText += notice;
        { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
        try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'waiting', secondsLeft: waitSec, resetsAt, rateLimitType, attempt: rateLimitWaitCount, maxAttempts: MAX_RATE_LIMIT_WAITS, ...(tabId ? { tabId } : {}) })); } catch {}

        // Wait loop with periodic countdown updates (every 30s)
        const waitEnd = Date.now() + waitMs;
        while (Date.now() < waitEnd) {
          if (abortController?.signal?.aborted) break;
          const remaining = Math.max(0, Math.ceil((waitEnd - Date.now()) / 1000));
          try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'countdown', secondsLeft: remaining, resetsAt, ...(tabId ? { tabId } : {}) })); } catch {}
          await _sleepAbortable(Math.min(30000, remaining * 1000), abortController?.signal);
        }

        if (abortController?.signal?.aborted) break;

        // Rate limit reset — notify and resume
        try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'resuming', ...(tabId ? { tabId } : {}) })); } catch {}
        const resumeNotice = '\n✅ **Rate limit reset** — resuming...\n\n';
        fullText += resumeNotice;
        { const _cb = (chatBuffers.get(sessionId) || '') + resumeNotice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text: resumeNotice, ...(tabId ? { tabId } : {}) })); } catch {}

        // If Claude produced output before rate limit, switch to continuation prompt
        if (hadOutputBeforeRateLimit) {
          currentPrompt = 'Continue where you left off. Complete the remaining work.';
          currentContentBlocks = null;
        }
        // else: keep currentPrompt as-is (retry original request)
        continue;
      }
    }

    // 🔑 Resume/session state is broken — start fresh
    // Covers both signature expiry and missing/invalid remote Claude session state.
    if (errorText && isResettableClaudeSessionError(errorText)) {
      const isThinkingSig = /Invalid signature in thinking block/i.test(errorText);
      log.warn('claude-session-reset', { sessionId, oldCid: newCid, reason: isThinkingSig ? 'thinking-signature' : 'missing-or-invalid-session' });
      const notice = isThinkingSig
        ? '\n\n⚠️ **Session reset** — thinking block signature expired, starting fresh session...\n\n'
        : '\n\n⚠️ **Session reset** — previous Claude session was missing or invalid, starting fresh session...\n\n';
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
      // Clear session ID — next iteration will start a fresh Claude session
      newCid = null;
      fullThinking = ''; // Reset thinking for fresh session — old thinking belongs to the discarded session
      try { stmts.updateClaudeId.run(null, sessionId); } catch {}
      const replayContent = buildSessionReplayContent(sessionId);
      currentPrompt = replayContent
        ? 'Continue this chat from the replayed history above. The latest user turn is included last. Respond to that latest user request.'
        : prompt;
      currentContentBlocks = replayContent || (Array.isArray(userContent) ? userContent : null);
      continueCount++;
      if (continueCount >= MAX_AUTO_CONTINUES) break;
      continue;
    }

    // 💰 Budget exceeded — hard limit, cannot continue
    if (resultData?.subtype === 'error_max_budget_usd') {
      const notice = '\n\n⚠️ **Budget limit reached** — agent stopped.\n\n';
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
      break;
    }

    // 🛑 User aborted
    if (abortController?.signal?.aborted) break;

    // 🔄 Auto-continue budget exhausted
    if (continueCount >= MAX_AUTO_CONTINUES) {
      const notice = `\n\n⚠️ **Agent did not complete** after ${MAX_AUTO_CONTINUES} auto-continues. Continue manually if needed.\n\n`;
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, session_restart_available: true, sessionId, ...(tabId ? { tabId } : {}) })); } catch {}
      break;
    }

    // 🔄 Auto-continue: agent stopped but didn't finish
    continueCount++;

    if (resultData?.subtype === 'error_max_turns') {
      // Max-turns hit — notify user explicitly
      log.info('auto-continue (max_turns)', { sessionId, attempt: continueCount, maxAttempts: MAX_AUTO_CONTINUES, turnsUsed: resultData.num_turns });
      const notice = `\n\n---\n⏳ **Auto-continuing** (${continueCount}/${MAX_AUTO_CONTINUES}) — hit ${effectiveMaxTurns}-turn limit, resuming...\n\n`;
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
    } else {
      // Any other non-success stop (error_during_execution, process crash, etc.) — auto-continue silently
      log.info('auto-continue (non-success)', { sessionId, attempt: continueCount, subtype: resultData?.subtype || 'unknown' });
    }

    // Resume session with continuation prompt — no attachments on subsequent runs
    currentPrompt = 'Continue where you left off. Complete the remaining work.';
    currentContentBlocks = null;
  }

  // Persist final text and clean up
  log.info('[THINKING-DIAG-CLI] save phase', { sessionId, hasThinking: !!fullThinking, thinkingLen: fullThinking.length, hasText: !!fullText, textLen: fullText.length });

  // If stream didn't deliver thinking, extract from JSONL file (CLI always writes thinking there)
  let thinkingFromJsonl = false;
  if (!fullThinking && newCid) {
    try {
      const extracted = extractThinkingFromJsonl(newCid, workdir || WORKDIR);
      if (extracted) {
        fullThinking = extracted;
        thinkingFromJsonl = true;
        log.info('[THINKING-JSONL] extracted thinking from JSONL', { sessionId, claudeSessionId: newCid, len: extracted.length });
      }
    } catch (e) { log.warn('[THINKING-JSONL] extraction failed', { sessionId, error: e.message }); }
  }

  try { if (fullThinking) stmts.addMsg.run(sessionId, 'assistant', 'thinking', fullThinking, null, null, null, null); } catch (e) { log.error('[THINKING-SAVE-ERR] CLI thinking save failed', { sessionId, error: e.message }); }
  // If thinking was extracted from JSONL (not streamed), send it to client now
  // so the badge renders on the done event without requiring a page reload
  if (thinkingFromJsonl && fullThinking) {
    try { ws.send(JSON.stringify({ type: 'thinking', text: fullThinking, ...(tabId ? { tabId } : {}) })); } catch {}
  }
  try { if (fullText) stmts.addMsg.run(sessionId, 'assistant', 'text', fullText, null, null, null, null); } catch (e) { log.error('[THINKING-SAVE-ERR] CLI text save failed', { sessionId, error: e.message }); }
  try { stmts.setPartialText.run(null, sessionId); } catch {}
  const _modelInfo = lastResult?.modelUsage ? Object.values(lastResult.modelUsage)[0] : null;
  const resultMeta = lastResult ? {
    cost: totalCostUsd || lastResult.total_cost_usd,
    usage: lastResult.usage,
    lastTurnUsage,
    numTurns: lastResult.num_turns,
    durationMs: lastResult.duration_ms,
    contextWindow: _modelInfo?.contextWindow || 0,
  } : null;
  return { cid: newCid, completed: lastResult?.subtype === 'success', resultMeta };
}

// --- SSH Remote Agent ---
async function runSshSingle(p) {
  const { prompt, userContent, systemPrompt, model, maxTurns, ws, sessionId, abortController, claudeSessionId, forkSession, mode, remoteHost, remoteWorkdir, sshKeyPath, password, port, tabId, name, effort } = p;
  const mp = mode==='planning' ? 'MODE: PLANNING ONLY. Analyze, plan, DO NOT modify files.\n\n' : mode==='task' ? 'MODE: EXECUTION.\n\n' : '';
  const sp = (mp + (systemPrompt||'')).trim() || undefined;
  // MCP tools must use the mcp__<serverName>__<toolName> format in allowedTools
  const mcpTools = ['mcp___ccs_set_ui_state__set_ui_state', 'mcp___ccs_ask_user__ask_user', 'mcp___ccs_notify__notify_user', 'mcp___ccs_user_interrupt__check_user_messages'];
  const tools = mode==='planning'
    ? ['View','GlobTool','GrepTool','ListDir','ReadNotebook', ...mcpTools]
    : ['Bash','View','GlobTool','GrepTool','ListDir','SearchReplace','Write', ...mcpTools];
  const effectiveMaxTurns = maxTurns || 30;
  let fullText = '', fullThinking = '', newCid = claudeSessionId, chunkCount = 0;
  let currentPrompt = prompt;
  let continueCount = 0;
  let rateLimitWaitCount = 0;
  let overloadRetryCount = 0;
  // Usage of the most recent assistant turn (real context-window occupancy at the end).
  let lastTurnUsage = null;
  let currentContentBlocks = Array.isArray(userContent) ? userContent : null;

  const ssh = new ClaudeSSH({ host: remoteHost, workdir: remoteWorkdir, sshKeyPath, password, port });
  let pendingFork = !!forkSession; // only fork on first SSH call

  const runOnce = (runPrompt, contentBlocks, resumeId) => new Promise((resolve) => {
    let resultData = null;
    let errorText = '';
    let rateLimitInfo = null;
    let _done = false;
    const _finish = (sid) => { if (!_done) { _done = true; resolve({ resultData, sid, errorText, rateLimitInfo }); } };
    const useFork = pendingFork; pendingFork = false;

    ssh.send({ prompt: runPrompt, contentBlocks, sessionId: resumeId, model, maxTurns: effectiveMaxTurns, systemPrompt: sp, allowedTools: tools, abortController, forkSession: useFork, name, effort })
      .onText(t => {
        fullText += t;
        { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        ws.send(JSON.stringify({ type:'text', text:t, ...(tabId ? { tabId } : {}) }));
        if (++chunkCount % 5 === 0) {
          try { stmts.setPartialText.run(fullText, sessionId); } catch {}
        }
      })
      .onThinking(t => { fullThinking += t; log.info('[THINKING-DIAG-SSH] onThinking fired', { len: t.length, totalLen: fullThinking.length, sessionId }); ws.send(JSON.stringify({ type:'thinking', text:t, ...(tabId ? { tabId } : {}) })); })
      .onTool((name, inp) => {
        if (name === 'ask_user' || name === 'notify_user' || name === 'set_ui_state' || name === 'check_user_messages') {
          try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
          return;
        }
        ws.send(JSON.stringify({ type:'tool', tool:name, input:(inp||'').substring(0,600), ...(tabId ? { tabId } : {}) }));
        try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
      })
      .onSessionId(sid => { newCid = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
      .onRateLimit(info => {
        try { ws.send(JSON.stringify({ type:'rate_limit', info, ...(tabId ? { tabId } : {}) })); } catch {}
        if (info && info.status === 'rejected') rateLimitInfo = info;
      })
      .onResult(r => { resultData = r; })
      .onUsage(u => { if (u) lastTurnUsage = u; })
      .onError(err => {
        errorText += err;
        try { ws.send(JSON.stringify({ type:'error', error:err.substring(0,500), ...(tabId ? { tabId } : {}) })); } catch {}
      })
      .onDone(sid => {
        if (sid) newCid = sid;
        _finish(newCid);
      });
  });

  let lastResult = null;
  let totalCostUsd = 0;
  while (true) {
    const fullTextBefore = fullText.length;
    const { resultData, errorText, rateLimitInfo } = await runOnce(currentPrompt, currentContentBlocks, newCid);
    const hadOutputBeforeRateLimit = fullText.length > fullTextBefore;
    lastResult = resultData;
    totalCostUsd += resultData?.total_cost_usd || 0;

    // 🌐 Transient server overload (HTTP 429/529) — short pause + retry, before success break.
    // See the CLI loop above for the full rationale; mirrored here for the SSH engine.
    {
      const lastTurnText = fullText.slice(fullTextBefore);
      const resultText = typeof resultData?.result === 'string' ? resultData.result : '';
      if (shouldRetryOverload({ texts: [lastTurnText, resultText, errorText], subtype: resultData?.subtype, isError: resultData?.is_error, rateLimitRejected: rateLimitInfo?.status === 'rejected' })) {
        if (overloadRetryCount >= MAX_OVERLOAD_RETRIES) {
          const notice = `\n\n⚠️ **Server overloaded** — still limiting after ${MAX_OVERLOAD_RETRIES} retries. Please try again shortly.\n\n`;
          fullText += notice;
          { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
          try { ws.send(JSON.stringify({ type:'text', text: notice, session_restart_available: true, sessionId, ...(tabId ? { tabId } : {}) })); } catch {}
          break;
        }
        overloadRetryCount++;
        const backoffMs = Math.min(OVERLOAD_BACKOFF_BASE_MS + (overloadRetryCount - 1) * OVERLOAD_BACKOFF_STEP_MS, OVERLOAD_BACKOFF_MAX_MS);
        const backoffSec = Math.ceil(backoffMs / 1000);
        log.warn('ssh-overload-backoff', { sessionId, attempt: overloadRetryCount, maxAttempts: MAX_OVERLOAD_RETRIES, backoffMs });
        const notice = `\n\n⏳ **Server busy** — temporarily limiting requests (not your usage limit). Pausing ~${backoffSec}s and retrying (${overloadRetryCount}/${MAX_OVERLOAD_RETRIES})...\n\n`;
        fullText += notice;
        { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
        try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'waiting', secondsLeft: backoffSec, rateLimitType: 'overloaded', attempt: overloadRetryCount, maxAttempts: MAX_OVERLOAD_RETRIES, ...(tabId ? { tabId } : {}) })); } catch {}
        const waitEnd = Date.now() + backoffMs;
        while (Date.now() < waitEnd) {
          if (abortController?.signal?.aborted) break;
          const remaining = Math.max(0, Math.ceil((waitEnd - Date.now()) / 1000));
          try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'countdown', secondsLeft: remaining, rateLimitType: 'overloaded', ...(tabId ? { tabId } : {}) })); } catch {}
          await _sleepAbortable(Math.min(5000, remaining * 1000), abortController?.signal);
        }
        if (abortController?.signal?.aborted) break;
        try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'resuming', rateLimitType: 'overloaded', ...(tabId ? { tabId } : {}) })); } catch {}
        const resumeNotice = '\n✅ **Resuming**...\n\n';
        fullText += resumeNotice;
        { const _cb = (chatBuffers.get(sessionId) || '') + resumeNotice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text: resumeNotice, ...(tabId ? { tabId } : {}) })); } catch {}
        // Continue only with an established session + streamed output; else retry original (see CLI loop).
        if (newCid && hadOutputBeforeRateLimit) {
          currentPrompt = 'Continue where you left off. Complete the remaining work.';
          currentContentBlocks = null;
        }
        continue;
      }
    }

    if (resultData?.subtype === 'success') break;

    // 🚦 Rate limit rejected — wait for reset and auto-retry
    {
      const isRateLimitRejected = (rateLimitInfo?.status === 'rejected') ||
        (errorText && /rate.?limit|overloaded|too many requests|429/i.test(errorText));
      if (isRateLimitRejected) {
        const resetsAt = rateLimitInfo?.resetsAt;
        const rateLimitType = rateLimitInfo?.rateLimitType || 'unknown';
        const waitMs = Math.max(MIN_RATE_LIMIT_WAIT_MS, resetsAt ? (resetsAt * 1000) - Date.now() + 5000 : 60000 * (rateLimitWaitCount + 1));
        if (rateLimitWaitCount >= MAX_RATE_LIMIT_WAITS || waitMs > MAX_RATE_LIMIT_WAIT_MS || rateLimitType === 'seven_day') {
          const reason = rateLimitWaitCount >= MAX_RATE_LIMIT_WAITS ? 'retries exhausted' : rateLimitType === 'seven_day' ? '7-day limit' : 'reset too far';
          const notice = `\n\n⚠️ **Rate limit** — ${reason}. Please retry manually later.\n\n`;
          fullText += notice;
          { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
          try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
          break;
        }
        rateLimitWaitCount++;
        const waitSec = Math.ceil(waitMs / 1000);
        log.warn('ssh-rate-limit-wait', { sessionId, rateLimitType, resetsAt, waitMs, attempt: rateLimitWaitCount, maxAttempts: MAX_RATE_LIMIT_WAITS });
        const notice = `\n\n⏳ **Rate limit** (${rateLimitType}) — auto-waiting ~${Math.ceil(waitSec / 60)} min for reset (${rateLimitWaitCount}/${MAX_RATE_LIMIT_WAITS})...\n\n`;
        fullText += notice;
        { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
        try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'waiting', secondsLeft: waitSec, resetsAt, rateLimitType, attempt: rateLimitWaitCount, maxAttempts: MAX_RATE_LIMIT_WAITS, ...(tabId ? { tabId } : {}) })); } catch {}
        const waitEnd = Date.now() + waitMs;
        while (Date.now() < waitEnd) {
          if (abortController?.signal?.aborted) break;
          const remaining = Math.max(0, Math.ceil((waitEnd - Date.now()) / 1000));
          try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'countdown', secondsLeft: remaining, resetsAt, ...(tabId ? { tabId } : {}) })); } catch {}
          await _sleepAbortable(Math.min(30000, remaining * 1000), abortController?.signal);
        }
        if (abortController?.signal?.aborted) break;
        try { ws.send(JSON.stringify({ type: 'rate_limit_wait', status: 'resuming', ...(tabId ? { tabId } : {}) })); } catch {}
        const resumeNotice = '\n✅ **Rate limit reset** — resuming...\n\n';
        fullText += resumeNotice;
        { const _cb = (chatBuffers.get(sessionId) || '') + resumeNotice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text: resumeNotice, ...(tabId ? { tabId } : {}) })); } catch {}
        if (hadOutputBeforeRateLimit) {
          currentPrompt = 'Continue where you left off. Complete the remaining work.';
          currentContentBlocks = null;
        }
        continue;
      }
    }

    if (errorText && isResettableClaudeSessionError(errorText)) {
      const isThinkingSig = /Invalid signature in thinking block/i.test(errorText);
      log.warn('ssh-claude-session-reset', { sessionId, oldCid: newCid, reason: isThinkingSig ? 'thinking-signature' : 'missing-or-invalid-session' });
      const notice = isThinkingSig
        ? '\n\n⚠️ **Session reset** — remote thinking block signature expired, starting a fresh session...\n\n'
        : '\n\n⚠️ **Session reset** — previous remote Claude session was missing or invalid, starting a fresh session...\n\n';
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
      newCid = null;
      fullThinking = ''; // Reset thinking for fresh session
      try { stmts.updateClaudeId.run(null, sessionId); } catch {}
      const replayContent = buildSessionReplayContent(sessionId);
      currentPrompt = replayContent
        ? 'Continue this chat from the replayed history above. The latest user turn is included last. Respond to that latest user request.'
        : prompt;
      currentContentBlocks = replayContent || (Array.isArray(userContent) ? userContent : null);
      continueCount++;
      if (continueCount >= MAX_AUTO_CONTINUES) break;
      continue;
    }
    if (resultData?.subtype === 'error_max_budget_usd') {
      const notice = '\n\n⚠️ **Budget limit reached** — agent stopped.\n\n';
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
      break;
    }
    if (abortController?.signal?.aborted) break;
    if (continueCount >= MAX_AUTO_CONTINUES) {
      const notice = `\n\n⚠️ **Agent did not complete** after ${MAX_AUTO_CONTINUES} auto-continues.\n\n`;
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, session_restart_available: true, sessionId, ...(tabId ? { tabId } : {}) })); } catch {}
      break;
    }
    continueCount++;
    if (resultData?.subtype === 'error_max_turns') {
      const notice = `\n\n---\n⏳ **Auto-continuing** (${continueCount}/${MAX_AUTO_CONTINUES}) — resuming on remote...\n\n`;
      fullText += notice;
      { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
      try { ws.send(JSON.stringify({ type:'text', text: notice, ...(tabId ? { tabId } : {}) })); } catch {}
    }
    currentPrompt = 'Continue where you left off. Complete the remaining work.';
    currentContentBlocks = null;
  }

  log.info('[THINKING-DIAG-SSH] save phase', { sessionId, hasThinking: !!fullThinking, thinkingLen: fullThinking.length, hasText: !!fullText, textLen: fullText.length });
  try { if (fullThinking) stmts.addMsg.run(sessionId, 'assistant', 'thinking', fullThinking, null, null, null, null); } catch (e) { log.error('[THINKING-SAVE-ERR] SSH thinking save failed', { sessionId, error: e.message }); }
  try { if (fullText) stmts.addMsg.run(sessionId, 'assistant', 'text', fullText, null, null, null, null); } catch (e) { log.error('[THINKING-SAVE-ERR] SSH text save failed', { sessionId, error: e.message }); }
  try { stmts.setPartialText.run(null, sessionId); } catch {}
  const _modelInfo = lastResult?.modelUsage ? Object.values(lastResult.modelUsage)[0] : null;
  const resultMeta = lastResult ? {
    cost: totalCostUsd || lastResult.total_cost_usd,
    usage: lastResult.usage,
    lastTurnUsage,
    numTurns: lastResult.num_turns,
    durationMs: lastResult.duration_ms,
    contextWindow: _modelInfo?.contextWindow || 0,
  } : null;
  return { cid: newCid, completed: lastResult?.subtype === 'success', resultMeta };
}

// --- Multi-Agent (CLI only) ---
// Upper bound on turns per sub-agent. Matches the UI's own limit (public/index.html
// #maxTurns has max="200"), so the number a user types is the number they get; this path
// used to clamp to a hardcoded 50 with no notice. Still bounded on purpose — unbounded
// turns invite tool loops, and each agent may additionally auto-continue up to
// MAX_AUTO_CONTINUES times, so the worst case per agent is cap × (1 + MAX_AUTO_CONTINUES).
const MULTI_AGENT_MAX_TURNS_CAP = parseInt(process.env.MULTI_AGENT_MAX_TURNS_CAP || '200', 10) || 200;


// ─── Bot dispatch ────────────────────────────────────────────────────────────
// Runs the bots a user @mentioned, in order, each seeing what the ones before it
// produced. Simpler than runMultiAgent on purpose:
//   - bots run SEQUENTIALLY, so there is no concurrent-resume race and no need for
//     --fork-session; each bot instead owns a persistent session of its own
//     (bot_sessions), so it remembers its side of this chat across turns.
//   - the first turn passes the bot's system prompt; later turns resume, where
//     claude-cli.js deliberately does NOT resend it (the prompt is already baked into
//     the session, and changing it invalidates thinking-block signatures).
// Returns the chat's own claude_session_id unchanged: a bot turn must never move the
// assistant's session pointer.
async function runBotTurns(p, { bots, prompt, rosterBots }) {
  const { mcpServers, model, maxTurns, ws, sessionId, abortController, claudeSessionId, workdir, tabId, effort, userContent } = p;
  const cli = new ClaudeCLI({ cwd: workdir || WORKDIR });
  // Same tool set as a normal turn, plus the internal MCP tools — without
  // check_user_messages a bot cannot see a clarification the user sends mid-run.
  const botMcpTools = ['mcp___ccs_set_ui_state__set_ui_state', 'mcp___ccs_ask_user__ask_user',
                       'mcp___ccs_notify__notify_user', 'mcp___ccs_user_interrupt__check_user_messages',
                       'mcp___ccs_bots__message_bot'];
  const botTools = ['Bash','View','GlobTool','GrepTool','ListDir','SearchReplace','Write', ...botMcpTools];
  // Interrupt delivery, identical to runCliSingle: a PreToolUse hook fires on every
  // tool call and a Stop hook covers a text-only answer, so a message sent while a
  // bot is working reaches it during the run instead of waiting for the next turn.
  const botInterruptCmd = `"${NODE_CMD}" "${path.join(__dirname, 'hooks', 'check-interrupt.js')}"`;
  const botInterruptSettings = {
    hooks: {
      PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: botInterruptCmd, timeout: 3 }] }],
      Stop: [{ hooks: [{ type: 'command', command: botInterruptCmd, timeout: 3 }] }],
    },
  };
  const botInterruptEnv = {
    CCS_INTERRUPT_URL: `http://127.0.0.1:${PORT}`,
    CCS_INTERRUPT_SESSION: sessionId,
    CCS_INTERRUPT_SECRET: INTERRUPT_SECRET,
  };
  const turnCap = Math.min(maxTurns || 30, MULTI_AGENT_MAX_TURNS_CAP);
  const previous = [];
  // The line-up is a QUEUE, not the fixed argument list: a bot may append peers to it via
  // message_bot while the turn is running. Growth is bounded by BOT_DISPATCH_BUDGET and by
  // the once-per-handle rule in planDispatch, so this terminates.
  const queue = bots.slice();
  // handle -> { from, task } for bots that were pulled in by a peer rather than mentioned
  // by the user. Only these get a rewritten prompt.
  const dispatched = new Map();
  const rosterMap = new Map((rosterBots || []).map(b => [b.id, b]));
  // Owner token for the map entry below, and a string form of it for the MCP subprocess.
  //
  // Two turns for the same session CAN overlap. The obvious path — Stop, then a new
  // message — is actually closed: Stop clears `ws._tabBusy` and `activeChatSessions`
  // but not `activeTasks`, and the guard reads all three, so the next message queues.
  // The open path is the disconnect timeout, which calls `activeTasks.delete(sid)` while
  // runBotTurns is still running; the 15s sweeper then drops `activeChatSessions` and
  // every lock is off. Without the token the old loop's drain would mutate the new turn's
  // queue and its finally would delete the new turn's entry, after which every
  // message_bot call answers "no bot turn is running".
  const dispatchOwner = abortController || {};
  const dispatchTurn = require('crypto').randomBytes(8).toString('hex');
  // Bots may only hand work to peers that exist in this project's roster — the same list
  // buildBotSystemPrompt shows them. Using the install-wide list here would let a bot
  // summon someone the user never put in this project.
  botDispatch.set(sessionId, {
    owner: dispatchOwner,
    turn: dispatchTurn,
    roster: rosterMap,
    queued: new Set(queue.map(b => b.id)),
    pending: [],
    budget: rosterMap.size > 1 ? BOT_DISPATCH_BUDGET : 0,
  });

  // Announce the whole line-up before the first one starts, so the UI can show who
  // is queued instead of revealing participants one at a time as they begin.
  // `growth: true` marks a RE-announce, when a hand-off appended someone mid-turn. The
  // client merges those and resets on everything else — without the flag it cannot tell
  // "the line-up grew" from "a new user message", and a bot the user mentions twice in a
  // row would start its second turn still wearing the previous turn's ✅ chip.
  const announceQueue = (growth) => {
    try {
      ws.send(JSON.stringify({
        type: 'bots_turn',
        bots: queue.map(b => ({ id: b.id, label: b.label, avatar: b.avatar || '🤖', model: b.model || model })),
        ...(growth ? { growth: true } : {}),
        ...(tabId ? { tabId } : {}),
      }));
    } catch {}
  };
  announceQueue();

  const emitState = (id, state, detail) => {
    try { ws.send(JSON.stringify({ type: 'bot_state', bot: id, state, detail: detail || '', ...(tabId ? { tabId } : {}) })); } catch {}
  };

  try {
  for (let qi = 0; qi < queue.length; qi++) {
    const bot = queue[qi];
    if (abortController?.signal?.aborted) {
      // Everyone still waiting is skipped, not silently dropped.
      emitState(bot.id, 'skipped');
      continue;
    }
    emitState(bot.id, 'running');

    const ctx = previous.length
      ? '\n\nWhat the bots before you produced in this same turn:\n'
        + previous.map(x => `[@${x.handle}]: ${x.text.substring(0, 4000)}`).join('\n\n')
      : '';
    // A bot the user mentioned answers the user's message. A bot a PEER pulled in answers
    // the task that peer wrote — handing it the original message instead would have it
    // redo work the caller already did, which is the thing the hand-off was avoiding.
    // The user's message still goes in as background so the answer stays on topic.
    const handoff = dispatched.get(bot.id);
    const botPrompt = handoff
      ? `@${handoff.from} asked you to do this as part of the conversation below.\n\nYour task:\n${handoff.task}\n\nThe user's message that started this turn:\n${prompt}${ctx}`
      : prompt + ctx;
    const isFirst = previous.length === 0;
    // The same standing instruction a normal turn gets: tell the bot the tool exists
    // and when to call it, or it will not think to look.
    const botSp = botsLogic.buildBotSystemPrompt(bot, rosterBots) + USER_INTERRUPT_INSTRUCTION
      + (rosterMap.size > 1 ? BOTS_DISPATCH_INSTRUCTION : '');
    const prior = stmts.getBotSession.get(sessionId, bot.id);
    let botSession = prior?.claude_session_id || null;

    // claude-cli.js only passes --system-prompt when there is NO session to resume
    // (claude-cli.js:190), and every bot keeps a persistent session per chat. So a bot that
    // has already spoken here never sees an updated system prompt — not a peer added to the
    // project since, and not the line below telling it message_bot exists. Without this the
    // whole feature would be dead in every existing chat and live only in brand-new ones.
    // Re-sent in the USER turn, the one channel --resume always delivers.
    const standing = botSession
      ? '\n\n' + [botsLogic.renderRoster(rosterBots, bot.id),
                  rosterMap.size > 1 ? BOTS_DISPATCH_INSTRUCTION.trim() : ''].filter(Boolean).join('\n\n')
      : '';

    // Injected per bot, not once for the turn: BOTS_CALLER differs for each, and it is what
    // the endpoint uses to reject self-dispatch and to label the hand-off.
    const botMcpServers = rosterMap.size > 1
      ? { ...mcpServers, _ccs_bots: {
          command: NODE_CMD,
          args: [path.join(__dirname, 'mcp-bots.js')],
          env: {
            BOTS_SERVER_URL: `http://127.0.0.1:${PORT}`,
            BOTS_SESSION_ID: sessionId,
            BOTS_CALLER: bot.id,
            // Identifies the TURN, not just the session. A handle set alone is not a
            // signature: a subprocess from a stopped turn whose bot is mentioned again
            // in the next one would pass the `queued` check and post into a conversation
            // that is already over.
            BOTS_TURN: dispatchTurn,
            BOTS_SECRET,
          },
        } }
      : mcpServers;

    ws.send(JSON.stringify({ type: 'agent_status', agent: bot.id, status: `${bot.avatar || '🤖'} ${bot.label}`, ...(tabId ? { tabId } : {}) }));

    let botText = '', botResult = null, botErrored = false;
    await new Promise(res => {
      let _settled = false;
      const _res = () => { if (!_settled) { _settled = true; res(); } };
      cli.send({
        prompt: botPrompt + standing,
        // Images and files the user attached go to the FIRST bot only: the ones after
        // it receive that bot's output as context, and re-sending the same screenshot
        // to each in turn would pay for it several times over.
        //
        // The trailing text block is dropped HERE rather than left to claude-cli.js.
        // That drop is an exact `block.text !== prompt` compare (claude-cli.js:259) and
        // `standing` breaks the equality, so a bot with a prior session plus an
        // attachment would get the user's message twice — once as the block, once as
        // the prompt. Filtering against `botPrompt` is the thing we actually mean.
        contentBlocks: (isFirst && Array.isArray(userContent))
          ? userContent.filter(b => !(b?.type === 'text' && b.text === botPrompt))
          : null,
        sessionId: botSession,
        // A bot may pin its own model; otherwise it follows the chat's.
        model: bot.model || model,
        maxTurns: turnCap,
        // Only applied when there is no session to resume — that is exactly why each
        // bot needs its own session rather than sharing the chat's.
        systemPrompt: botSp,
        mcpServers: botMcpServers,
        allowedTools: botTools,
        abortController,
        effort,
        name: bot.label,
        extraEnv: botInterruptEnv,
        extraSettings: botInterruptSettings,
        // 'project,local' deliberately omits 'user': a bot must follow the project's
        // conventions, but the user's personal CLAUDE.md is an agreement between them
        // and their own assistant. Inheriting it made every bot reply open with the
        // user's activation-token preamble — noise the bot was never asked for.
        settingSources: 'project,local',
      })
        .onText(t => {
          botText += t;
          const _cb = (chatBuffers.get(sessionId) || '') + t;
          chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb);
          try { ws.send(JSON.stringify({ type: 'text', text: t, agent: bot.id, ...(tabId ? { tabId } : {}) })); } catch {}
        })
        .onTool((n, i) => {
          if (n !== 'ask_user' && n !== 'notify_user' && n !== 'set_ui_state') {
            try { ws.send(JSON.stringify({ type: 'tool', tool: n, input: (i || '').substring(0, 600), agent: bot.id, ...(tabId ? { tabId } : {}) })); } catch {}
          }
          try { stmts.addMsg.run(sessionId, 'assistant', 'tool', (i || '').substring(0, 500), n, bot.id, null, null); } catch {}
        })
        .onResult(r => { botResult = r; })
        .onSessionId(sid => { botSession = sid; })
        .onError(err => {
          botErrored = true;
          try { ws.send(JSON.stringify({ type: 'agent_status', agent: bot.id, status: `❌ ${String(err).substring(0, 200)}`, ...(tabId ? { tabId } : {}) })); } catch {}
          _res();
        })
        .onDone(() => _res());
    });

    // Remember this bot's session so the next mention resumes the same thread. The id
    // can arrive either from .onSessionId (first run) or in the result frame (resume) —
    // same normalisation as claude-cli.js.
    const _rid = botResult?.session_id;
    const _sid = typeof _rid === 'string' ? _rid
      : (_rid && typeof _rid === 'object' && typeof _rid.session_id === 'string') ? _rid.session_id
      : botSession;
    if (_sid) { try { stmts.setBotSession.run(sessionId, bot.id, _sid); } catch {} }

    if (botText) { try { stmts.addMsg.run(sessionId, 'assistant', 'text', botText, null, bot.id, null, null); } catch {} }

    // An incomplete answer is never handed to the next bot: a truncated or failed run
    // reads as fact to whoever receives it, and the error compounds down the chain.
    const ok = !botErrored && isAgentSuccess(botResult);
    emitState(bot.id, abortController?.signal?.aborted ? 'stopped' : (ok ? 'done' : 'failed'),
      ok ? '' : agentStopReason(botResult, botErrored));
    if (ok) {
      previous.push({ handle: bot.id, text: botText });
      // Drain only on success, and only after the bot has fully finished. An incomplete
      // answer dispatches nobody: a truncated run's hand-off would be work requested by a
      // sentence the bot never got to finish. Appending here rather than starting anything
      // keeps dispatch flat — the new bot is just the next iteration of this same loop.
      const dctx = botDispatch.get(sessionId);
      // Owner check: if a newer turn for this session replaced the entry, its queue is
      // none of our business — draining it here would append bots to someone else's line-up.
      const handoffs = (dctx && dctx.owner === dispatchOwner) ? dctx.pending.splice(0) : [];
      const added = [];
      for (const d of handoffs) {
        const peer = dctx.roster.get(d.handle);
        if (!peer || dctx.queued.has(d.handle)) continue;
        dctx.queued.add(d.handle);
        dispatched.set(d.handle, { from: d.from, task: d.task });
        queue.push(peer);
        added.push(peer);
      }
      if (added.length) {
        announceQueue(true);
        const note = `\n\n↪️ @@${bot.id} handed work to ${added.map(b => '@@' + b.id).join(', ')}.\n\n`;
        // Persisted, not just streamed: this line is the ONLY place a hand-off is
        // explained. Without the row, a reload shows a bot answering that the user
        // never mentioned and nothing saying who pulled it in.
        try { stmts.addMsg.run(sessionId, 'assistant', 'text', note, null, bot.id, null, null); } catch {}
        try { ws.send(JSON.stringify({ type: 'text', text: note, agent: bot.id, ...(tabId ? { tabId } : {}) })); } catch {}
      }
    } else {
      // Anything this bot asked for is dropped with it — see the drain comment above.
      // Owner-checked for the same reason the drain is. The budget those hand-offs spent
      // IS returned: they are discarded here and this bot does not run again, so there is
      // no retry loop to feed — and charging a later bot for work that never happened
      // would refuse it a peer over a quota nothing consumed.
      try {
        const dctx = botDispatch.get(sessionId);
        if (dctx && dctx.owner === dispatchOwner) dctx.budget += dctx.pending.splice(0).length;
      } catch {}
      // Always visible as `text` — not just when another bot follows. `agent_status`/
      // `bot_state` reach the web UI's sidebar, but TelegramProxy.send() does not
      // handle either type at all, so on Telegram those are silently dropped; `text`
      // is the one event type every surface renders. A failure on the LAST bot used
      // to emit nothing anywhere but the sidebar — Telegram just showed "✅ Done".
      const note = `\n\n⚠️ @${bot.id} did not finish (${agentStopReason(botResult, botErrored)})`
        + (qi < queue.length - 1 ? ' — its output is not passed to the next bot.\n\n' : '.\n\n');
      // Persisted for the same reason the hand-off note is: after a reload a failed bot
      // would otherwise be indistinguishable from one that answered with nothing.
      try { stmts.addMsg.run(sessionId, 'assistant', 'text', note, null, bot.id, null, null); } catch {}
      try { ws.send(JSON.stringify({ type: 'text', text: note, agent: bot.id, ...(tabId ? { tabId } : {}) })); } catch {}
    }
  }
  } finally {
    // The entry is what makes /api/internal/message-bot accept anything. Dropping it here
    // means an MCP subprocess that outlives its bot cannot queue work against the next
    // user message, and nothing leaks if the loop throws. Only ever delete OUR entry: a
    // newer turn for this session may already own the slot.
    if (botDispatch.get(sessionId)?.owner === dispatchOwner) botDispatch.delete(sessionId);
  }
  return claudeSessionId || null;
}

async function runMultiAgent(p) {
  const { prompt, systemPrompt, mcpServers, model, maxTurns, ws, sessionId, abortController, claudeSessionId, workdir, tabId, effort, userContent } = p;
  // Entry guard: the caller creates the AbortController before prompt classification and
  // does not re-check it before dispatching here, so Stop during that phase lands us with
  // an already-aborted signal. cli.send() only listens for a FUTURE abort
  // (claude-cli.js:473-478), so the planner below would spawn a process nothing can kill.
  if (abortController?.signal?.aborted) {
    ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'Stopped', statusKey:'agent.stopped', ...(tabId ? { tabId } : {}) }));
    return claudeSessionId || null;
  }
  ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'🧠 Planning...', statusKey:'agent.planning', ...(tabId ? { tabId } : {}) }));

  const effectiveWorkdir = workdir || WORKDIR;
  const cli = new ClaudeCLI({ cwd: effectiveWorkdir });
  let planText = '';
  // Orchestrator gets existing session context via --resume if available
  const planPrompt = `You are a lead architect. Break this into 2-5 subtasks. Respond ONLY in JSON:\n{"plan":"...","agents":[{"id":"agent-1","role":"...","task":"...","depends_on":[]}]}\n\nTASK: ${prompt}`;
  let currentSessionId = claudeSessionId || null;

  // Schema-validated structured output guarantees the plan parses without
  // regex extraction. Mirrors the shape of planPrompt above.
  const planSchema = {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      agents: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            role: { type: 'string' },
            task: { type: 'string' },
            depends_on: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'role', 'task'],
        },
      },
    },
    required: ['plan', 'agents'],
  };

  await new Promise(res => {
    let _settled = false;
    const _res = () => { if (!_settled) { _settled = true; res(); } };
    // Plan call must be deterministic: with --json-schema, model emits the
    // result via a synthetic "StructuredOutput" tool. We strip everything else
    // so it can't burn the single turn on an unrelated tool/skill call:
    //   tools=''         → disables all built-in tools (Read, Bash, …)
    //   settingSources='' → skips user/project/local CLAUDE.md and skills
    // StructuredOutput is injected by --json-schema and remains available.
    cli.send({ prompt:planPrompt, sessionId: currentSessionId, model, maxTurns:1, allowedTools:[], tools:'', settingSources:'', abortController, effort, jsonSchema: planSchema })
      .onText(t => { planText+=t; })
      // With --json-schema the model emits the result via the synthetic
      // "StructuredOutput" tool_use rather than plain text. Capture its input
      // as planText so the JSON.parse below works in either streaming path.
      .onTool((name, input) => { if (name === 'StructuredOutput' && input) planText = typeof input === 'string' ? input : JSON.stringify(input); })
      .onSessionId(sid => { currentSessionId = sid; })
      .onError(() => _res())
      .onDone(() => _res());
  });

  let plan = null;
  try { const m = planText.match(/\{[\s\S]*\}/); if (m) plan = JSON.parse(m[0]); } catch {}

  // Stop during planning leaves planText empty, which would otherwise look like a bad plan
  // and fall through to runCliSingle — spawning yet another run from an aborted signal.
  if (abortController?.signal?.aborted) {
    ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'Stopped', statusKey:'agent.stopped', ...(tabId ? { tabId } : {}) }));
    return currentSessionId || claudeSessionId || null;
  }

  if (!plan?.agents?.length) {
    ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'⚠️ Falling back to single mode', statusKey:'agent.fallback_single', ...(tabId ? { tabId } : {}) }));
    // runCliSingle returns { cid, completed } — extract .cid to match
    // runMultiAgent's contract of returning a plain session ID string.
    const fallback = await runCliSingle(p);
    return fallback?.cid || null;
  }

  const planSummaryText = `📋 **${plan.plan}**\n🤖 ${plan.agents.map(a=>`${a.id}(${a.role})`).join(', ')}\n---\n`;
  { const _cb = (chatBuffers.get(sessionId) || '') + planSummaryText; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
  ws.send(JSON.stringify({ type:'text', text: planSummaryText, ...(tabId ? { tabId } : {}) }));
  ws.send(JSON.stringify({ type:'agent_plan', plan: plan.plan, agents: plan.agents.map(a => ({ id: a.id, role: a.role, task: a.task })), ...(tabId ? { tabId } : {}) }));
  try {
    const _apJson = JSON.stringify({ plan: plan.plan, agents: plan.agents.map(a => ({ id: a.id, role: a.role, task: a.task })), dispatched: false });
    stmts.addMsg.run(sessionId,'assistant','agent_plan',_apJson,null,'orchestrator',null,null);
  } catch {}

  const completed = new Set(), results = {};
  const remaining = [...plan.agents];

  // Run agents with session context
  while (remaining.length) {
    // Stop/disconnect must not launch another wave. cli.send() only listens for a FUTURE
    // abort (claude-cli.js:473-478), so a process spawned with an already-aborted signal
    // would run on uncancellable to its idle timeout.
    if (abortController?.signal?.aborted) break;
    const runnable = remaining.filter(a => (a.depends_on||[]).every(d => completed.has(d)));
    if (!runnable.length) { ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'Circular deps', statusKey:'agent.circular_deps', ...(tabId ? { tabId } : {}) })); break; }

    await Promise.all(runnable.map(async agent => {
      remaining.splice(remaining.indexOf(agent), 1);
      ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`🔄 ${agent.role}`, ...(tabId ? { tabId } : {}) }));
      const depCtx = (agent.depends_on||[]).map(d => results[d] ? `\n[${d}]:${results[d].substring(0,2000)}` : '').join('');
      const agentPrompt = agent.task + (depCtx ? '\nContext:'+depCtx : '');
      // Same standing instruction a single-agent turn gets: without it a worker does
      // not know user clarifications can arrive mid-run.
      const agentSp = `You are ${agent.role}. Complete your assigned task thoroughly. Be concise in output.` + USER_INTERRUPT_INSTRUCTION;
      const agentTools = ['Bash','View','GlobTool','GrepTool','ListDir','SearchReplace','Write',
        'mcp___ccs_user_interrupt__check_user_messages'];
      // Interrupt delivery, identical to runCliSingle. Workers had neither the hooks
      // nor the tool, so a clarification sent while the team was working was silently
      // discarded at the end of the turn.
      const agentInterruptCmd = `"${NODE_CMD}" "${path.join(__dirname, 'hooks', 'check-interrupt.js')}"`;
      const agentInterruptSettings = {
        hooks: {
          PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: agentInterruptCmd, timeout: 3 }] }],
          Stop: [{ hooks: [{ type: 'command', command: agentInterruptCmd, timeout: 3 }] }],
        },
      };
      const agentInterruptEnv = {
        CCS_INTERRUPT_URL: `http://127.0.0.1:${PORT}`,
        CCS_INTERRUPT_SESSION: sessionId,
        CCS_INTERRUPT_SECRET: INTERRUPT_SECRET,
      };
      const agentTurnCap = Math.min(maxTurns||30, MULTI_AGENT_MAX_TURNS_CAP);
      let agentText = '';
      let agentResult = null;   // CLI result frame — carries why the run stopped
      let agentErrored = false; // .onError already reported a failure for this agent
      let agentContinues = 0;
      // Each sub-agent owns its session. Agents in a wave run CONCURRENTLY, so they must
      // never resume — or overwrite — the orchestrator's id: two `claude --resume <same id>`
      // processes interleave writes into one transcript, and the last .onSessionId to fire
      // would decide which branch the summarizer (and the saved chat) continues from.
      // --fork-session branches the plan context into a private transcript per agent.
      let agentSessionId = currentSessionId;
      let agentFork = !!currentSessionId; // fork once, off the plan; continues resume the branch
      let agentOwnsSession = false;       // true once agentSessionId is THIS agent's own branch
      let agentPromptNow = agentPrompt;

      while (true) {
        agentResult = null;
        await new Promise(res => {
          let _settled = false;
          const _res = () => { if (!_settled) { _settled = true; res(); } };
          cli.send({ prompt:agentPromptNow,
            // Attachments go to the first wave only: later agents receive their
            // dependencies' output as context, and re-sending the same image to every
            // worker would pay for it once per agent.
            contentBlocks: (agentContinues === 0 && !completed.size && Array.isArray(userContent)) ? userContent : null,
            sessionId: agentSessionId, model, maxTurns:agentTurnCap, systemPrompt:agentSp, mcpServers, allowedTools:agentTools, abortController, forkSession: agentFork, effort,
            extraEnv: agentInterruptEnv, extraSettings: agentInterruptSettings })
            .onText(t => { agentText+=t; { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); } try { ws.send(JSON.stringify({ type:'text', text:t, agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} })
            .onTool((n,i) => { if (n !== 'ask_user' && n !== 'notify_user' && n !== 'set_ui_state') { try { ws.send(JSON.stringify({ type:'tool', tool:n, input:(i||'').substring(0,600), agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} } try { stmts.addMsg.run(sessionId,'assistant','tool',(i||'').substring(0,500),n,agent.id,null,null); } catch {} })
            .onResult(r => { agentResult = r; })
            .onSessionId(sid => { agentSessionId = sid; agentOwnsSession = true; }) // LOCAL — never the orchestrator's
            .onError(err => { agentErrored = true; try { ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`❌ ${err.substring(0,200)}`, ...(tabId ? { tabId } : {}) })); } catch {} _res(); })
            .onDone(() => _res());
        });
        // Pick the branch id out of the result frame. .onSessionId cannot deliver it on a
        // resume: claude-cli.js seeds _detectedSid with the id we resumed from
        // (claude-cli.js:297) and only fires when that is empty (claude-cli.js:566), so a
        // forked run never reports its new id. Same normalisation as claude-cli.js:568 —
        // session_id may arrive nested in an object.
        const _rid = agentResult?.session_id;
        const _branchId = typeof _rid === 'string' ? _rid
          : (_rid && typeof _rid === 'object' && typeof _rid.session_id === 'string') ? _rid.session_id
          : null;
        // Ownership means a branch that is genuinely NOT the shared plan session. Encoding
        // that rather than assuming it: were a future CLI to echo the resume source here
        // (or ignore --fork-session), claiming ownership would send the next continue to
        // `--resume <plan>` unforked — the write race again. Failing the check instead
        // stops the agent and reports it incomplete, which is the safe direction.
        if (_branchId && _branchId !== currentSessionId) {
          agentSessionId = _branchId; agentOwnsSession = true; agentFork = false;
        }

        if (abortController?.signal?.aborted) break;
        // No branch id means agentSessionId is still the SHARED plan session. Resuming that
        // concurrently is exactly the write race this design removes, so stop instead and
        // let the agent be reported incomplete — never continue onto someone else's session.
        if (!agentOwnsSession) break;
        if (!shouldAutoContinue(agentResult, agentErrored, agentContinues, MAX_AUTO_CONTINUES)) break;

        agentContinues++;
        const cont = `\n\n⏳ **${agent.id}** auto-continuing (${agentContinues}/${MAX_AUTO_CONTINUES}) — hit the ${agentTurnCap}-turn limit, resuming...\n\n`;
        agentText += cont;
        { const _cb = (chatBuffers.get(sessionId) || '') + cont; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text:cont, agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {}
        ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`🔄 ${agent.role} (${agentContinues}/${MAX_AUTO_CONTINUES})`, ...(tabId ? { tabId } : {}) }));
        agentPromptNow = 'Continue where you left off. Complete the remaining work.';
      }

      // A finished stream is not a finished job — the CLI reports why it stopped in
      // result.subtype, and emits no result frame at all when it was killed mid-run.
      // Reporting ✅ in either case hid truncated work from the user AND handed it to
      // dependent agents (and the summarizer) as if it were complete.
      const agentOk = isAgentSuccess(agentResult, agentErrored);
      if (!agentOk) {
        const why = agentStopReason(agentResult, agentErrored, agentTurnCap, agentContinues);
        const notice = `\n\n⚠️ **${agent.id}** (${agent.role}) did not finish — ${why}. The output above is incomplete.\n\n`;
        agentText += notice; // carried into results[] so dependents/summarizer see it too
        { const _cb = (chatBuffers.get(sessionId) || '') + notice; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        try { ws.send(JSON.stringify({ type:'text', text:notice, agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {}
      }

      results[agent.id] = agentText;
      try { if (agentText) stmts.addMsg.run(sessionId,'assistant','text',agentText,null,agent.id,null,null); } catch {}
      completed.add(agent.id); // always — dependents would otherwise stall as "circular deps"
      if (agentOk) {
        ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`✅ ${agent.role}`, ...(tabId ? { tabId } : {}) }));
      } else if (!agentErrored) {
        // .onError already emitted ❌ for its case; don't overwrite it with a second status
        ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`⚠️ ${agent.role} — incomplete`, ...(tabId ? { tabId } : {}) }));
      }
    }));
  }

  // Summarizer agent: synthesizes results and provides final session_id for resume.
  // Skipped when aborted — same reason as the wave guard above: an already-aborted signal
  // never fires claude-cli's listener, so this would spawn an uncancellable extra run.
  if (abortController?.signal?.aborted) {
    ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'Stopped', statusKey:'agent.stopped', ...(tabId ? { tabId } : {}) }));
    return currentSessionId;
  }
  ws.send(JSON.stringify({ type:'agent_status', agent:'summarizer', status:'📝 Synthesizing results...', ...(tabId ? { tabId } : {}) }));
  const summaryPrompt = `You are a coordinator. Synthesize the results from all agents and provide a concise summary.

AGENT RESULTS:
${Object.entries(results).map(([id, text]) => `【${id}】\n${(text||'No output').substring(0,3000)}`).join('\n\n')}

Provide a clear summary of what was accomplished. Be concise.`;

  let summaryText = '';
  await new Promise(res => {
    let _settled = false;
    const _res = () => { if (!_settled) { _settled = true; res(); } };
    cli.send({ prompt:summaryPrompt, sessionId: currentSessionId, model, maxTurns:1, allowedTools:[], abortController, effort })
      .onText(t => { summaryText+=t; { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); } try { ws.send(JSON.stringify({ type:'text', text:t, agent:'summarizer', ...(tabId ? { tabId } : {}) })); } catch {} })
      .onSessionId(sid => { currentSessionId = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
      .onError(() => _res())
      .onDone(() => _res());
  });

  if (summaryText) {
    try { stmts.addMsg.run(sessionId,'assistant','text',summaryText,null,'summarizer',null,null); } catch {}
  }
  ws.send(JSON.stringify({ type:'agent_status', agent:'summarizer', status:'✅ Summary complete', ...(tabId ? { tabId } : {}) }));
  ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'All agents done', statusKey:'agent.done', ...(tabId ? { tabId } : {}) }));

  // Return session_id for future resume
  return currentSessionId;
}

// ============================================
// EXPRESS
// ============================================
// CSP disabled: SPA uses inline scripts/styles; all other helmet headers applied
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit:'5mb' }));
app.use(cookieParser());

// ─── HTTP Request Logging ─────────────────────────────────────────────────────
// Logs method, path, status, and duration for every request.
// Skips the health endpoint to avoid noisy polling logs.
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log[lvl]('http', { method: req.method, path: req.path, status: res.statusCode, ms });
  });
  next();
});

// ─── Internal MCP: ask_user endpoint ─────────────────────────────────────────
// Registered BEFORE authMiddleware — MCP subprocess authenticates with ASK_USER_SECRET,
// not with a user session token. The Bearer secret is a 32-char hex generated per process.
app.post('/api/internal/ask-user', express.json(), (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${ASK_USER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { requestId, sessionId, question, questions, options, inputType } = req.body;
  if (!requestId || !sessionId || !question) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Normalize: if new-style `questions` array is present, use it; otherwise wrap legacy fields
  const normalizedQuestions = Array.isArray(questions) && questions.length
    ? questions
    : [{ question, options: options || null, multiSelect: inputType === 'multi_choice' }];

  // Set up a timer that auto-resolves if the user doesn't answer
  const timer = setTimeout(() => {
    const entry = pendingAskUser.get(requestId);
    if (entry) {
      pendingAskUser.delete(requestId);
      entry.resolve({ answer: '[No response — proceed with your best judgment.]' });
      // Notify client that the question timed out so it can disable the card
      const task = activeTasks.get(sessionId);
      if (task?.proxy) {
        try { task.proxy.send(JSON.stringify({ type: 'ask_user_timeout', requestId, tabId: sessionId })); } catch {}
      }
    }
  }, ASK_USER_TIMEOUT_MS);

  // Store the pending question — resolve will be called by WS handler
  const promise = new Promise((resolve) => {
    pendingAskUser.set(requestId, {
      resolve,
      sessionId,
      timer,
      question,
      questions: normalizedQuestions,
    });
  });

  // Route question to the client via the active task's proxy (survives WS reconnects)
  const activeTask = activeTasks.get(sessionId);
  if (activeTask?.proxy) {
    const payload = JSON.stringify({
      type: 'ask_user',
      requestId,
      question,
      questions: normalizedQuestions,
      tabId: sessionId,
    });
    try { activeTask.proxy.send(payload); } catch {}
  }

  // Wait for the user's answer (or timeout)
  promise.then((result) => {
    res.json(result);
  }).catch((err) => {
    res.status(500).json({ error: err.message || 'Internal error' });
  });
});

// ─── Notify User endpoint (non-blocking, fire-and-forget) ────────────────────
app.post('/api/internal/notify', express.json(), (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${NOTIFY_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { sessionId, level, title, detail, progress } = req.body;
  if (!sessionId || !title) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const ctx = getNotificationContext(sessionId);
  const payload = JSON.stringify({
    type: 'notification',
    level: level || 'info',
    title: String(title).substring(0, 120),
    detail: detail ? String(detail).substring(0, 500) : '',
    progress: progress || null,
    tabId: sessionId,
    timestamp: Date.now(),
    sessionTitle: ctx.sessionTitle,
    projectName: ctx.projectName,
  });

  // Route via active task proxy (survives WS reconnects)
  const activeTask = activeTasks.get(sessionId);
  if (activeTask?.proxy) {
    try { activeTask.proxy.send(payload); } catch {}
  }

  // Also broadcast to session watchers (Kanban task viewers)
  broadcastToSession(sessionId, JSON.parse(payload));

  res.json({ ok: true });
});

// ─── Set UI State endpoint (non-blocking, fire-and-forget) ───────────────────
app.post('/api/internal/set-ui-state', express.json(), (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${SET_UI_STATE_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { sessionId, mode, model, agent } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }
  if (!mode && !model && !agent) {
    return res.status(400).json({ error: 'At least one of mode, model, or agent must be provided' });
  }

  // Broadcast to session watchers — UI will receive via WebSocket
  const payload = { type: 'ui_state_change' };
  if (mode) payload.mode = mode;
  if (model) payload.model = model;
  if (agent) payload.agent = agent;
  payload.tabId = sessionId;

  // Route via active task proxy (survives WS reconnects)
  const activeTask = activeTasks.get(sessionId);
  if (activeTask?.proxy) {
    try { activeTask.proxy.send(JSON.stringify(payload)); } catch {}
  }

  // Also broadcast to session watchers
  broadcastToSession(sessionId, payload);

  res.json({ ok: true });
});

// ─── Task Manager endpoint (internal MCP — autonomous task creation) ─────────
// Safety limits: prevent runaway task creation by a single task execution
const MAX_TASK_CHILDREN_PER_RUN = 10;
const MAX_CHAIN_DEPTH = 5;

app.post('/api/internal/task-manager', express.json({ limit: '1mb' }), (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${TASK_MANAGER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, taskId: callerTaskId } = req.body;
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // Helper: convert ISO string or Unix timestamp to integer seconds
  const toUnixTs = (v) => {
    if (!v) return null;
    if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v; // ms → s
    const ms = Date.parse(v);
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  };

  try {
    switch (action) {

      // ── create_task ────────────────────────────────────────────────────
      case 'create_task': {
        const { title, description = '', context = null, model, mode, agent_mode,
                depends_on, chain_id, scheduled_at, max_turns } = req.body;
        if (!title) return res.status(400).json({ error: 'Missing title' });

        // Safety: count how many children this task has already created
        if (callerTaskId) {
          const childCount = stmts.countChildTasks.get(callerTaskId);
          if (childCount.cnt >= MAX_TASK_CHILDREN_PER_RUN) {
            return res.status(429).json({ error: `Child task limit reached (${MAX_TASK_CHILDREN_PER_RUN}). Cannot create more tasks in this run.` });
          }
        }

        // Safety: check chain depth to prevent infinite recursion
        if (callerTaskId) {
          let depth = 0, cursor = callerTaskId;
          while (cursor && depth < MAX_CHAIN_DEPTH + 1) {
            const parent = stmts.getParentTaskId.get(cursor);
            if (!parent?.parent_task_id) break;
            cursor = parent.parent_task_id;
            depth++;
          }
          if (depth >= MAX_CHAIN_DEPTH) {
            return res.status(429).json({ error: `Chain depth limit reached (${MAX_CHAIN_DEPTH}). Cannot create deeper nested tasks.` });
          }
        }

        // Inherit workdir from caller task
        const callerTask = callerTaskId ? stmts.getTask.get(callerTaskId) : null;
        const workdir = callerTask?.workdir || null;

        const id = genId();
        const contextJson = context ? (typeof context === 'string' ? context : JSON.stringify(context)).substring(0, 10000) : null;
        const depsJson = depends_on ? JSON.stringify(depends_on) : null;

        stmts.createTask.run(
          id, String(title).substring(0, 200), String(description).substring(0, 2000),
          '', // notes
          'todo', // status — immediately eligible for processQueue
          0,  // sort_order
          (chain_id ? callerTask?.session_id : null) || null, // session_id — only inherit for chain tasks
          workdir,
          model || callerTask?.model || 'sonnet',
          mode || callerTask?.mode || 'auto',
          agent_mode || callerTask?.agent_mode || 'single',
          max_turns || callerTask?.max_turns || 30,
          null, // attachments
          depsJson,
          chain_id || null,
          callerTask?.source_session_id || null,
          toUnixTs(scheduled_at),
          null, // recurrence
          null, // recurrence_end_at
          callerTask?.effort || null,  // effort: inherit from caller task by default
          callerTask?.run_engine || null  // run_engine: inherit from caller task by default
        );

        // Set new columns that aren't in createTask prepared statement
        stmts.setTaskContext.run(contextJson, callerTaskId || null, id);

        // Trigger queue to pick up new task
        setImmediate(processQueue);

        // Notify UI
        if (callerTask?.source_session_id) {
          const _ctx = getNotificationContext(callerTask.source_session_id);
          broadcastToSession(callerTask.source_session_id, {
            type: 'notification', level: 'info',
            title: `New task created: "${String(title).substring(0, 60)}"`,
            detail: `Created by task "${callerTask.title}"`,
            tabId: callerTask.source_session_id,
            sessionTitle: _ctx.sessionTitle, projectName: _ctx.projectName,
          });
        }

        const task = stmts.getTask.get(id);
        log.info('[task-manager] create_task', { id, title, parentId: callerTaskId });
        return res.json({ task_id: id, status: task.status, title: task.title });
      }

      // ── create_chain ───────────────────────────────────────────────────
      case 'create_chain': {
        const { title = 'Task Chain', tasks: taskDefs, model: chainModel,
                scheduled_at: chainScheduledAt, recurrence, recurrence_end_at,
                effort: chainEffort } = req.body;
        if (!Array.isArray(taskDefs) || !taskDefs.length) {
          return res.status(400).json({ error: 'Missing or empty tasks array' });
        }
        if (taskDefs.length > MAX_TASK_CHILDREN_PER_RUN) {
          return res.status(429).json({ error: `Too many tasks in chain (max ${MAX_TASK_CHILDREN_PER_RUN})` });
        }

        // Chain depth check (same as create_task)
        if (callerTaskId) {
          let depth = 0, cursor = callerTaskId;
          while (cursor && depth < MAX_CHAIN_DEPTH + 1) {
            const parent = stmts.getParentTaskId.get(cursor);
            if (!parent?.parent_task_id) break;
            cursor = parent.parent_task_id;
            depth++;
          }
          if (depth >= MAX_CHAIN_DEPTH) {
            return res.status(429).json({ error: `Chain depth limit reached (${MAX_CHAIN_DEPTH}). Cannot create deeper nested tasks.` });
          }
        }

        const callerTask = callerTaskId ? stmts.getTask.get(callerTaskId) : null;
        const workdir = callerTask?.workdir || null;

        // Create chain + shared session
        const chainId = genId();
        const chainSessionId = genId();
        const effectiveModel = chainModel || callerTask?.model || 'sonnet';

        stmts.createSession.run(chainSessionId, String(title).substring(0, 200), '[]', '[]',
          'auto', 'single', effectiveModel, workdir);
        const effectiveEffort = chainEffort || callerTask?.effort || null;
        stmts.createChain.run(chainId, String(title).substring(0, 200), workdir,
          effectiveModel, 'auto', 'single', 30,
          chainSessionId, toUnixTs(chainScheduledAt), recurrence || null,
          toUnixTs(recurrence_end_at), callerTask?.source_session_id || null, 0,
          effectiveEffort);

        // Create tasks with auto-linked depends_on
        const taskIds = [];
        const localIdMap = {}; // maps local ref index → real task ID

        for (let i = 0; i < taskDefs.length; i++) {
          const td = taskDefs[i];
          const taskId = genId();
          taskIds.push(taskId);
          localIdMap[i] = taskId;

          // Resolve depends_on: can reference by index (0-based) in the chain
          let depsJson = null;
          if (td.depends_on_index && Array.isArray(td.depends_on_index)) {
            const resolved = td.depends_on_index.map(idx => localIdMap[idx]).filter(Boolean);
            if (resolved.length) depsJson = JSON.stringify(resolved);
          } else if (i > 0) {
            // Default: sequential — depends on previous task
            depsJson = JSON.stringify([taskIds[i - 1]]);
          }

          const contextJson = td.context ? (typeof td.context === 'string' ? td.context : JSON.stringify(td.context)).substring(0, 10000) : null;

          stmts.createTask.run(
            taskId, String(td.title || `Step ${i + 1}`).substring(0, 200),
            String(td.description || '').substring(0, 2000),
            '', // notes
            'todo',
            i * 1000, // sort_order
            chainSessionId,
            workdir,
            td.model || effectiveModel,
            'auto', 'single',
            td.max_turns || 30,
            null, // attachments
            depsJson,
            chainId,
            callerTask?.source_session_id || null,
            toUnixTs(chainScheduledAt),
            null, null,
            td.effort || effectiveEffort,  // effort: per-task override, else chain default
            td.run_engine || callerTask?.run_engine || null  // run_engine: per-task override, else inherit from caller
          );

          stmts.setTaskContext.run(contextJson, callerTaskId || null, taskId);
        }

        setImmediate(processQueue);
        log.info('[task-manager] create_chain', { chainId, taskCount: taskIds.length, parentId: callerTaskId });
        return res.json({ chain_id: chainId, task_ids: taskIds });
      }

      // ── list_tasks ─────────────────────────────────────────────────────
      case 'list_tasks': {
        const { status: filterStatus, chain_id: filterChain, limit = 20 } = req.body;
        let query = 'SELECT id, title, status, sort_order, chain_id, depends_on, parent_task_id, scheduled_at, created_at FROM tasks WHERE 1=1';
        const params = [];

        // Scope to same workdir as caller (explicit NULL handling)
        const callerTask = callerTaskId ? stmts.getTask.get(callerTaskId) : null;
        if (callerTask?.workdir) {
          query += ' AND workdir=?';
          params.push(callerTask.workdir);
        } else if (callerTask) {
          query += ' AND workdir IS NULL';
        }
        if (filterStatus) { query += ' AND status=?'; params.push(filterStatus); }
        if (filterChain) { query += ' AND chain_id=?'; params.push(filterChain); }

        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(Math.min(limit, 50));

        const tasks = db.prepare(query).all(...params);
        return res.json({ tasks });
      }

      // ── get_current_task ───────────────────────────────────────────────
      case 'get_current_task': {
        if (!callerTaskId) return res.status(400).json({ error: 'No task ID provided (not running as a task?)' });
        const task = stmts.getTask.get(callerTaskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        // Parse context
        let context = task.context;
        if (context) {
          try { context = JSON.parse(context); } catch { /* keep as string */ }
        }

        return res.json({
          task_id: task.id,
          title: task.title,
          description: task.description,
          context,
          chain_id: task.chain_id,
          parent_task_id: task.parent_task_id,
          depends_on: task.depends_on ? JSON.parse(task.depends_on) : [],
          workdir: task.workdir,
          model: task.model,
          status: task.status,
        });
      }

      // ── report_result ──────────────────────────────────────────────────
      case 'report_result': {
        const { data } = req.body;
        if (!callerTaskId) return res.status(400).json({ error: 'No task ID' });
        if (data === undefined) return res.status(400).json({ error: 'Missing data' });

        const outputJson = (typeof data === 'string' ? data : JSON.stringify(data)).substring(0, 10000);
        stmts.setTaskOutput.run(outputJson, callerTaskId);

        log.info('[task-manager] report_result', { taskId: callerTaskId, outputLen: outputJson.length });
        return res.json({ ok: true });
      }

      // ── get_task_result ────────────────────────────────────────────────
      case 'get_task_result': {
        const { task_id } = req.body;
        if (!task_id) return res.status(400).json({ error: 'Missing task_id' });
        const task = stmts.getTask.get(task_id);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        // Workdir scoping: only allow reading results from same project
        const _callerTask = callerTaskId ? stmts.getTask.get(callerTaskId) : null;
        if (_callerTask && ((_callerTask.workdir || null) !== (task.workdir || null))) {
          return res.status(403).json({ error: 'Cannot read task results outside your project' });
        }

        let output = task.task_output;
        if (output) {
          try { output = JSON.parse(output); } catch { /* keep as string */ }
        }

        return res.json({
          task_id: task.id,
          title: task.title,
          status: task.status,
          output,
          completed_at: task.status === 'done' ? task.updated_at : null,
        });
      }

      // ── cancel_task ────────────────────────────────────────────────────
      case 'cancel_task': {
        const { task_id, reason } = req.body;
        if (!task_id) return res.status(400).json({ error: 'Missing task_id' });
        const task = stmts.getTask.get(task_id);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        // Workdir scoping: only allow cancelling tasks in same project
        const _callerTask2 = callerTaskId ? stmts.getTask.get(callerTaskId) : null;
        if (_callerTask2 && ((_callerTask2.workdir || null) !== (task.workdir || null))) {
          return res.status(403).json({ error: 'Cannot cancel tasks outside your project' });
        }

        if (task.status === 'done') {
          return res.status(400).json({ error: 'Cannot cancel a completed task' });
        }

        // Abort running process if in_progress
        if (task.status === 'in_progress') {
          const ctrl = runningTaskAborts.get(task_id);
          if (ctrl) { stoppingTasks.add(task_id); ctrl.abort(); }
          else if (task.worker_pid) { stoppingTasks.add(task_id); killByPid(task.worker_pid); }
        }

        stmts.cancelTask.run(reason || 'Cancelled by task-manager MCP', task_id);

        log.info('[task-manager] cancel_task', { taskId: task_id, reason, cancelledBy: callerTaskId });
        return res.json({ ok: true, task_id, status: 'cancelled' });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    log.error('[task-manager] endpoint error', { action, err: err.message, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// ─── Internal MCP: user-interrupt endpoint ──────────────────────────────────
// Called by mcp-user-interrupt.js to fetch and consume pending clarifications.
// Registered BEFORE authMiddleware — MCP subprocess authenticates with INTERRUPT_SECRET.
app.post('/api/internal/user-interrupt', express.json(), (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${INTERRUPT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  // Atomically read and clear pending messages for this session
  const messages = pendingInterrupts.get(sessionId) || [];
  if (messages.length > 0) {
    pendingInterrupts.delete(sessionId);

    // Persist delivery status in DB + notify clients + track count for done-event reconciliation
    const task = activeTasks.get(sessionId);
    for (const m of messages) {
      if (m.dbId) { try { stmts.markInterruptDelivered.run(m.dbId); } catch {} }
      const payload = JSON.stringify({ type: 'interrupt_delivered', interruptId: m.id, tabId: sessionId });
      // Send via proxy (direct processChat connection) AND broadcast (all session watchers).
      // Both are needed: proxy covers new sessions not yet subscribed; broadcast covers multi-tab.
      if (task?.proxy) {
        try { task.proxy.send(payload); } catch {}
        task.proxy._deliveredInterruptCount = (task.proxy._deliveredInterruptCount || 0) + 1;
      }
      broadcastToSession(sessionId, { type: 'interrupt_delivered', interruptId: m.id, tabId: sessionId });
    }

    // Schedule temp file cleanup after delay (Claude needs time to read attached files)
    cleanupInterruptAttachments(messages, INTERRUPT_FILE_TTL_MS);
  }

  return res.json({ messages });
});

// ─── Internal MCP: bot-to-bot dispatch endpoint ─────────────────────────────
// Called by mcp-bots.js when a running bot hands work to a peer.
// Registered BEFORE authMiddleware — MCP subprocess authenticates with BOTS_SECRET.
//
// Always answers 200 with { ok, accepted, reason? }. A refusal is a normal outcome the
// model must be able to read and adapt to, not an HTTP error it would surface as a tool
// failure. Only a bad secret or a malformed body get a 4xx.
//
// This records an intent; it does not start anything. The turn loop in runBotTurns drains
// the queue after the calling bot finishes, so dispatch stays flat and sequential — no
// nested run, no concurrent resume of the same bot session.
app.post('/api/internal/message-bot', express.json(), (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${BOTS_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { sessionId, from, handle, task, turn } = req.body || {};
  if (!sessionId || !from) return res.status(400).json({ error: 'Missing sessionId or from' });

  const ctx = botDispatch.get(sessionId);
  // No entry means the turn already ended — a late call from a subprocess that outlived
  // its bot. Refusing beats queueing it against whatever the user sends next.
  if (!ctx) return res.json({ ok: true, accepted: false, reason: 'no bot turn is running' });

  // The caller must belong to the turn that currently owns this session. An MCP subprocess
  // from a stopped turn can still be alive when the user's next message starts a new one;
  // without this it would post into the new turn's queue and summon a bot on behalf of a
  // conversation that is already over. The turn token is what makes that check exact —
  // membership in `queued` alone would still pass for a bot mentioned in both turns.
  const caller = String(from).trim().toLowerCase();
  if (ctx.turn !== turn || !ctx.queued.has(caller)) {
    return res.json({ ok: true, accepted: false, reason: 'this turn is no longer running' });
  }

  const want = String(handle || '').trim().toLowerCase();
  if (!ctx.roster.has(want)) {
    return res.json({ ok: true, accepted: false, reason: `no bot @${want || '?'} in this project` });
  }

  // planDispatch owns every other rule. Pending hand-offs count as queued so a peer named
  // twice in the same round is caught, and the budget passed is what is actually left.
  const already = [...ctx.queued, ...ctx.pending.map(d => d.handle)];
  const { accepted, rejected } = botsLogic.planDispatch({
    requested: [{ from, handle: want, task }],
    alreadyQueued: already,
    budget: ctx.budget,
  });

  if (accepted.length) {
    ctx.pending.push(accepted[0]);
    // Spent on record, returned only if the calling bot fails and its hand-offs are
    // discarded (see the failure branch in runBotTurns). Returning it there cannot loop —
    // the failed bot does not run again — while charging for a hand-off that never
    // happened would refuse a later bot a peer over a quota nothing consumed.
    ctx.budget -= 1;
    return res.json({ ok: true, accepted: true });
  }
  return res.json({ ok: true, accepted: false, reason: DISPATCH_REASONS[rejected[0]?.reason] || 'refused' });
});

// Rejection codes from planDispatch are terse identifiers; the model reads prose.
// `already-queued` says what to do instead, not just what was refused: the peer is
// already in line and every bot after this one is handed this bot's answer as context
// (`previous` in runBotTurns), so instructions written into the answer DO reach it.
// Without that sentence the model reads "refused" and the task text it wrote is lost.
const DISPATCH_REASONS = {
  invalid: 'the handle or task was empty or malformed',
  self: 'a bot cannot hand work to itself',
  'already-queued': 'that bot is already part of this turn and runs after you — it will be '
    + 'shown your answer, so put anything you wanted to tell it in your answer instead',
  duplicate: 'you already handed work to that bot in this turn',
  budget: 'the hand-off budget for this message is used up',
};

app.use(auth.authMiddleware);
// Prevent browser caching for all API responses.
// Without this Express sends ETag but no Cache-Control, so browsers may
// serve stale cached JSON (e.g. task list after a DELETE still contains
// the deleted item until the heuristic cache expires).
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Language ─────────────────────────────────────────────────────────────────
app.get('/api/lang', (req, res) => {
  const c = loadConfig();
  res.json({ lang: c.lang || 'en' });
});

app.put('/api/lang', express.json(), (req, res) => {
  const lang = req.body.lang;
  if (!['uk', 'en', 'ru', 'fr', 'he'].includes(lang)) return res.status(400).json({ error: 'Invalid lang' });
  const c = loadConfig();
  c.lang = lang;
  saveConfig(c);
  // Update bot language if running
  if (telegramBot) telegramBot.lang = lang;
  res.json({ ok: true });
});

// Global default engine for NEW chats/tasks ('api' | 'subscription'). Per-item
// run_engine override still persists; this only seeds fresh selectors.
app.put('/api/default-engine', express.json(), (req, res) => {
  const e = req.body.engine === 'subscription' ? 'subscription' : 'api';
  const c = loadConfig();
  c.defaultEngine = e;
  saveConfig(c);
  res.json({ ok: true, defaultEngine: e });
});

// ─── Translate via Claude CLI ─────────────────────────────────────────────────
// One-shot translation using haiku model, no session persistence.
// Source text is written to a temp file to avoid OS ARG_MAX limits on large thinking blocks.
// Translation result is read from a temp file written by Claude via the Write tool.

app.post('/api/translate', express.json({ limit: '500kb' }), (req, res) => {
  const { text, targetLang } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const langName = LANG_NAMES[targetLang] || 'English';

  const bin = claudeCli.claudeBin;
  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (!env.ANTHROPIC_BASE_URL) delete env.ANTHROPIC_API_KEY;

  // Write source text to temp file — avoids CLI argument length limits
  const tmpId = `claude-translate-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const tmpDir = path.join(os.tmpdir(), tmpId);
  fs.mkdirSync(tmpDir, { recursive: true });
  const srcFile = path.join(tmpDir, 'source.txt');
  const dstFile = path.join(tmpDir, 'translated.txt');
  fs.writeFileSync(srcFile, text, 'utf-8');

  const sysPrompt = 'You are a translator. Follow file I/O instructions exactly. Never add commentary.';
  const prompt = `Read the file ${srcFile}. Translate the entire content to ${langName}. Write ONLY the pure translation (no comments, no explanations, preserve all line breaks and structure) to ${dstFile}.`;
  const args = [
    '--print',
    '--model', 'haiku',
    '--max-turns', '3',
    '--no-session-persistence',
    '--dangerously-skip-permissions',
    '--tools', 'Read,Write',
    '--output-format', 'text',
    '--system-prompt', sysPrompt,
    prompt,
  ];

  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const proc = spawnProc(bin, args, { cwd: tmpDir, env, stdio: ['pipe', 'pipe', 'pipe'], shell: needsShell });
  proc.stdin.end();

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', d => { stdout += d; });
  proc.stderr.on('data', d => { stderr += d; });

  const timeout = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 120_000);
  let responded = false;

  proc.on('close', code => {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;
    try {
      if (code !== 0) {
        console.error('[translate] claude exit code', code, stderr.substring(0, 500));
        return res.status(502).json({ error: 'Translation failed' });
      }
      // Primary: read from output file; fallback: use stdout if file was not created
      let translated = '';
      if (fs.existsSync(dstFile)) {
        translated = fs.readFileSync(dstFile, 'utf-8').trim();
      } else if (stdout.trim()) {
        translated = stdout.trim();
      }
      if (!translated) {
        console.error('[translate] empty translation, stderr:', stderr.substring(0, 500));
        return res.status(502).json({ error: 'Translation failed' });
      }
      res.json({ translated });
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  proc.on('error', err => {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;
    console.error('[translate] spawn error', err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: 'Failed to spawn translator' });
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
// Deep health check: verifies DB connectivity, reports uptime / memory / WS connections.
// Returns HTTP 503 if any critical subsystem is degraded.
app.get('/api/version', (_, res) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  // tmuxAvailable: lets the UI disable the "Subscription" engine up front when the
  // server lacks tmux (e.g. native Windows) instead of failing only after a send.
  res.json({ version: pkg.version, name: pkg.name, tmuxAvailable: tmuxAvailable(), defaultEngine: (loadMergedConfig().defaultEngine === 'subscription' ? 'subscription' : 'api') });
});

// Capability-checked, never OS-sniffed — the same pattern as tmuxAvailable for the
// subscription engine. Native Windows has no tmux (and Node has no ConPTY API
// without a native module), so terminal sessions are simply unavailable there and
// the UI disables the entry point instead of failing after a click.
app.get('/api/terminal/capability', (_, res) => {
  const cfg = loadConfig();
  const enabled = cfg.terminal?.enabled === true;
  const tmuxOk = termBridge.tmuxAvailable();
  const tunnelOn = !!tunnelManager?.isRunning?.();
  // reasonKey lets the UI show a localized, actionable explanation; `reason` stays
  // for logs and any older client. A bare "disabled in config (terminal.enabled)"
  // told the user nothing about how to turn the feature on.
  let reason = '', reasonKey = '';
  if (!enabled) { reason = 'disabled in config (terminal.enabled)'; reasonKey = 'term.off.config'; }
  else if (!tmuxOk) { reason = 'tmux not found on this host'; reasonKey = 'term.off.tmux'; }
  else if (tunnelOn) { reason = 'a public tunnel is active — terminal access is blocked'; reasonKey = 'term.off.tunnel'; }
  res.json({ available: enabled && tmuxOk && !tunnelOn, reason, reasonKey });
});

app.get('/api/health', (_, res) => {
  let dbOk = false;
  try { db.prepare('SELECT 1').get(); dbOk = true; } catch { /* db unavailable */ }

  const mem   = process.memoryUsage();
  const status = dbOk ? 'healthy' : 'degraded';
  const payload = {
    ok:           dbOk,
    status,
    uptime:       Math.floor(process.uptime()),       // seconds
    timestamp:    new Date().toISOString(),
    version:      (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version; } catch { return 'unknown'; } })(),
    db:           dbOk ? 'ok' : 'error',
    connections:  wss.clients.size,
    memory: {
      rss_mb:  Math.round(mem.rss        / 1024 / 1024),
      heap_mb: Math.round(mem.heapUsed   / 1024 / 1024),
    },
  };
  res.status(dbOk ? 200 : 503).json(payload);
});

// Test endpoint to simulate Ask tool (for UI testing)
// Stats
app.get('/api/stats', (req, res) => {
  const sessionId = req.query.session_id || null;

  // Unique agent_ids active in the last 5 minutes (assistant messages only)
  const activeAgents = stmts.activeAgents.all().map(r => r.agent_id);

  // User message counts — used only for pct calculation, not exposed raw
  const daily  = stmts.dailyMessages.get().count;
  const weekly = stmts.weeklyMessages.get().count;

  // Pre-compute usage percentages server-side
  const dailyPct  = Math.min(100, Math.round(daily  / CLAUDE_MAX_LIMITS.daily  * 100));
  const weeklyPct = Math.min(100, Math.round(weekly / CLAUDE_MAX_LIMITS.weekly * 100));

  // Next reset timestamps (UTC-based ISO strings)
  const now = new Date();
  const dailyResetAt  = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
  ));
  const daysToMon = now.getUTCDay() === 0 ? 1 : 8 - now.getUTCDay();
  const weeklyResetAt = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMon
  ));

  // Context size estimate: sum of all content lengths in session ÷ 4 chars/token
  let contextTokens = 0;
  if (sessionId) {
    const { total } = stmts.contextTokens.get(sessionId) || { total: 0 };
    contextTokens = Math.round(total / 4);
  }

  res.json({
    active_agents:    activeAgents,
    daily_pct:        dailyPct,
    weekly_pct:       weeklyPct,
    daily_reset_at:   dailyResetAt.toISOString(),
    weekly_reset_at:  weeklyResetAt.toISOString(),
    context_tokens:   contextTokens,
    limits:           CLAUDE_MAX_LIMITS,
  });
});
app.get('/api/auth/status', (req,res) => {
  if (process.env.CCS_DESKTOP === '1') return res.json({ setupDone:true, loggedIn:true, displayName:'Desktop' });
  const setupDone = auth.isSetupDone();
  const token = req.cookies?.token || req.headers['x-auth-token'];
  const loggedIn = setupDone && auth.validateToken(token);
  const ad = auth.loadAuth();
  res.json({ setupDone, loggedIn, displayName:loggedIn?ad?.displayName:null });
});

app.post('/api/auth/setup', authLimiter, async (req,res) => {
  try {
    const { password, displayName } = req.body;
    const token = await auth.setupUser(password, displayName);
    res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure:SECURE_COOKIES, maxAge:30*24*60*60*1000 });
    res.json({ ok:true, displayName:displayName||'Admin' });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.post('/api/auth/login', authLimiter, async (req,res) => {
  try {
    const token = await auth.login(req.body.password);
    res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure:SECURE_COOKIES, maxAge:30*24*60*60*1000 });
    res.json({ ok:true, displayName:auth.loadAuth()?.displayName });
  } catch(e) { res.status(401).json({ error:e.message }); }
});

app.post('/api/auth/logout', (req,res) => { if(req.cookies?.token) auth.revokeToken(req.cookies.token); res.clearCookie('token'); res.json({ ok:true }); });

app.post('/api/auth/change-password', async (req,res) => {
  try {
    const token = await auth.changePassword(req.body.oldPassword, req.body.newPassword);
    res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure:SECURE_COOKIES, maxAge:30*24*60*60*1000 });
    res.json({ ok:true });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.get('/setup', (_,res) => { if(auth.isSetupDone()) return res.redirect('/'); res.sendFile(path.join(__dirname,'public','auth.html')); });
app.get('/login', (_,res) => { if(!auth.isSetupDone()) return res.redirect('/setup'); res.sendFile(path.join(__dirname,'public','auth.html')); });
app.get('/kanban', (_,res) => res.sendFile(path.join(__dirname,'public','kanban.html')));
app.get('/schedule', (_,res) => res.sendFile(path.join(__dirname,'public','schedule.html')));
app.get('/dashboard', (_,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));

// ─── Dashboard Analytics ────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  try {
    const summary = stmts.dashSummary.get();
    const archived = stmts.archSummary.get();

    // Merge archived stats from deleted sessions into live totals
    if (archived) {
      summary.total_sessions += archived.total_sessions;
      summary.total_messages += archived.total_messages;
      summary.total_tool_calls += archived.total_tool_calls;
      summary.assistant_messages += archived.assistant_messages;
      summary.total_chars += archived.total_chars;
    }

    // Estimated time saved: tool calls ~30s manual work each, assistant messages ~2min research each
    summary.estimated_hours_saved = Math.round(((summary.total_tool_calls * 0.5) + (summary.assistant_messages * 2)) / 60 * 10) / 10;

    // Merge dimensional data: live + archived
    const tools = mergeDashRows(stmts.dashTools.all(), stmts.archTools.all(), 'name', ['count']);
    tools.sort((a, b) => b.count - a.count);
    const topTools = tools.slice(0, 15);

    const models = mergeDashRows(stmts.dashModels.all(), stmts.archModels.all(), 'model', ['count']);
    const agentModes = mergeDashRows(stmts.dashAgentModes.all(), stmts.archAgentModes.all(), 'agent_mode', ['count']);
    const modes = mergeDashRows(stmts.dashModes.all(), stmts.archModes.all(), 'mode', ['count']);

    const dailyActivity = mergeDashRows(stmts.dashDailyActivity.all(), stmts.archDailyActivity.all(), 'date', ['count']);
    dailyActivity.sort((a, b) => a.date.localeCompare(b.date));

    const hourlyDist = mergeDashRows(stmts.dashHourlyDist.all(), stmts.archHourlyDist.all(), 'hour', ['count']);
    hourlyDist.sort((a, b) => a.hour - b.hour);

    const weeklyTrend = mergeDashRows(stmts.dashWeeklyTrend.all(), stmts.archWeeklyTrend.all(), 'week', ['count', 'tool_count']);
    weeklyTrend.sort((a, b) => a.week.localeCompare(b.week));

    // Top sessions: only from live data (deleted sessions can't be navigated to)
    const topSessions = stmts.dashTopSessions.all();

    // Session stats: recalculate avg/max across live + archived
    const liveSessionStats = stmts.dashSessionStats.get();
    const sessionStats = {
      avg_messages_per_session: Math.round(summary.total_messages / Math.max(1, summary.total_sessions) * 10) / 10,
      max_messages_in_session: Math.max(liveSessionStats?.max_messages_in_session || 0, archived?.max_messages_in_session || 0)
    };

    // Multi-agent stats: merge live + archived
    const liveMulti = stmts.dashMultiAgentStats.get();
    const multiAgentStats = {
      unique_agents: liveMulti?.unique_agents || 0,
      agent_messages: (liveMulti?.agent_messages || 0) + (archived?.agent_messages || 0)
    };

    // Automation Index (0-100): weighted score of tool usage, multi-agent adoption, and activity
    // 60% = tool-to-message ratio (higher = more automated), 25% = multi-agent usage, 15% = session count (capped at 30)
    const toolRatio = summary.total_messages > 0 ? summary.total_tool_calls / summary.total_messages : 0;
    const multiRatio = agentModes.reduce((acc, m) => m.agent_mode === 'multi' ? acc + m.count : acc, 0) /
      Math.max(1, agentModes.reduce((acc, m) => acc + m.count, 0));
    const efficiencyScore = Math.min(100, Math.round(
      (toolRatio * 60) + (multiRatio * 25) + (Math.min(summary.total_sessions, 30) / 30 * 15)
    ));

    res.json({
      summary, tools: topTools, models, agentModes, modes,
      dailyActivity, hourlyDist, topSessions,
      sessionStats, multiAgentStats, weeklyTrend,
      efficiencyScore
    });
  } catch (e) {
    log.error('Dashboard analytics error', { err: e.message });
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ─── Tasks (Kanban) ───────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  const workdir = req.query.workdir || null;
  const rows = stmts.getTasks.all({ w: workdir || null });
  const result = rows.map(t => ({
    ...t,
    is_active: t.session_id ? activeTasks.has(t.session_id) : false,
  }));
  res.json(result);
});
app.get('/api/tasks/etag', (req, res) => { res.json(stmts.getTasksEtag.get()); });
// Returns session IDs that are running right now — used by the client to restore
// spinners on EVERY tab after a reload, including tabs that are not the active one.
// In-memory part comes from liveSessionIds(), the same union isChatRunning reads via
// isSessionLive(), so the two endpoints can never disagree; the DB part adds task
// workers on top. A plain web chat never writes a `tasks` row, so a DB-only query
// reported [] while a chat was mid-turn and background tabs silently lost their busy
// dot on reload.
app.get('/api/tasks/running-sessions', (req, res) => {
  const ids = liveSessionIds();
  for (const r of stmts.inProgressTaskSessions.all()) ids.add(r.session_id);
  res.json([...ids]);
});
// ─── Activity panel aggregate (live + scheduled + recent, across ALL projects) ──
// live      = in-memory activeTasks (web/telegram chats) UNION db tasks.status='in_progress'
//             (scheduler/kanban runs). A task in_progress in the DB but absent from the
//             in-memory maps (e.g. right after a server restart) is flagged 'recovering'
//             instead of being shown as a healthy live run.
// scheduled = upcoming todo tasks that carry a scheduled_at.
// recent    = most-recently-touched sessions that are not currently live (<=20).
// Project {id,name} is resolved server-side from workdir so the client never parses paths.
app.get('/api/activity', (req, res) => {
  try {
    const projList = loadProjects();
    const projByWorkdir = new Map();
    for (const p of projList) {
      try { projByWorkdir.set(path.resolve(p.workdir), { id: p.id, name: p.name || path.basename(p.workdir) }); } catch {}
    }
    const resolveProj = (workdir) => {
      if (!workdir) return { project_id: null, project_name: null };
      let key; try { key = path.resolve(workdir); } catch { key = workdir; }
      const m = projByWorkdir.get(key);
      return m ? { project_id: m.id, project_name: m.name }
               : { project_id: null, project_name: path.basename(workdir) };
    };
    const sessMeta = db.prepare('SELECT id,title,workdir,model,updated_at FROM sessions WHERE id=?');

    const live = [];
    const liveIds = new Set();

    // 1) In-memory active chats (web/telegram) — authoritative "running now".
    for (const [sid, info] of activeTasks) {
      const s = sessMeta.get(sid);
      live.push({
        kind: 'chat',
        session_id: sid,
        title: s?.title || 'Untitled',
        source: info?.source || 'web',
        started_at: info?.startedAt || null,
        status: 'running',
        ...resolveProj(s?.workdir || null),
      });
      liveIds.add(sid);
    }

    // 2) DB in_progress tasks (scheduler / kanban). Skip ones already represented by an
    //    in-memory chat (precedence activeTasks > task). No live worker => 'recovering'.
    const inProg = db.prepare(`SELECT id,title,session_id,workdir FROM tasks WHERE status='in_progress'`).all();
    for (const tsk of inProg) {
      const sid = tsk.session_id;
      if (sid && liveIds.has(sid)) continue;
      const hasWorker = taskRunning.has(tsk.id) || independentRunning.has(tsk.id);
      const s = sid ? sessMeta.get(sid) : null;
      live.push({
        kind: 'task',
        session_id: sid || null,
        task_id: tsk.id,
        title: tsk.title || s?.title || 'Task',
        source: 'scheduler',
        started_at: null,
        status: hasWorker ? 'running' : 'recovering',
        ...resolveProj(tsk.workdir || s?.workdir || null),
      });
      if (sid) liveIds.add(sid);
    }

    // 2.5) Terminal (external-agent PTY) sessions currently busy. A raw terminal has
    //      no discrete "turn" to signal completion of, so tmux's own window_activity
    //      timestamp is the liveness proxy — same signal the terminal reaper already
    //      relies on (see its comment: session_activity does NOT move on pane output,
    //      measured; window_activity does, and is "the correct idle signal"). Recent
    //      activity (<= a few seconds ago) means the agent is actively writing to the
    //      pane right now, not that the user is mid-keystroke — human typing is far
    //      burstier than this window catches on a 12s client poll cadence.
    const TERM_BUSY_THRESHOLD_SEC = 5;
    if (termBridge.tmuxAvailable()) {
      try {
        for (const name of termBridge.listTerminalSessions()) {
          const info = termBridge.sessionInfo(name);
          if (!info.exists || info.paneDead || info.activityAgeSec > TERM_BUSY_THRESHOLD_SEC) continue;
          const sid = name.slice(TMUX_PREFIX.length);
          if (liveIds.has(sid)) continue;
          const s = sessMeta.get(sid);
          if (!s) continue; // tmux session outlived its DB row — reaper will clean it up
          live.push({
            kind: 'terminal',
            session_id: sid,
            title: s.title || 'Terminal',
            source: 'terminal',
            started_at: null,
            status: 'running',
            ...resolveProj(s.workdir || null),
          });
          liveIds.add(sid);
        }
      } catch (e) { log.warn('/api/activity terminal scan failed', { err: e.message }); }
    }

    // 3) Scheduled (upcoming) todo tasks.
    const sched = db.prepare(`SELECT id,title,session_id,workdir,scheduled_at,recurrence FROM tasks WHERE status='todo' AND scheduled_at IS NOT NULL ORDER BY scheduled_at ASC LIMIT 50`).all();
    const scheduled = sched.map(tsk => ({
      task_id: tsk.id,
      session_id: tsk.session_id || null,
      title: tsk.title || 'Task',
      scheduled_at: tsk.scheduled_at, // unix seconds
      recurrence: tsk.recurrence || null,
      ...resolveProj(tsk.workdir),
    }));

    // 4) Recent finished sessions (exclude anything currently live).
    const recentRows = db.prepare('SELECT id,title,workdir,updated_at FROM sessions ORDER BY updated_at DESC LIMIT 40').all();
    const recent = [];
    for (const s of recentRows) {
      if (liveIds.has(s.id)) continue;
      recent.push({
        session_id: s.id,
        title: s.title || 'Untitled',
        updated_at: s.updated_at,
        ...resolveProj(s.workdir),
      });
      if (recent.length >= 10) break;
    }

    res.json({ live, scheduled, recent });
  } catch (e) {
    log.error('/api/activity failed', { err: e.message });
    res.status(500).json({ error: 'activity_failed' });
  }
});
app.post('/api/tasks', (req, res) => {
  const { title=i18nTask(), description='', notes='', status='backlog', sort_order=0, session_id=null, workdir=null,
          model='sonnet', mode='auto', agent_mode='single', max_turns=30, attachments=null,
          depends_on=null, chain_id=null, source_session_id=null,
          scheduled_at=null, recurrence=null, recurrence_end_at=null, effort=null, run_engine=null,
          bot_id=null } = req.body;
  const id = genId();
  stmts.createTask.run(id, String(title).substring(0,200), String(description).substring(0,2000), String(notes||'').substring(0,2000), sqlVal(status), sqlVal(sort_order), sqlVal(session_id)||null, sqlVal(workdir)||null, sqlVal(model), sqlVal(mode), sqlVal(agent_mode), sqlVal(max_turns), sqlVal(attachments)||null, sqlVal(depends_on)||null, sqlVal(chain_id)||null, sqlVal(source_session_id)||null, sqlVal(scheduled_at)||null, sqlVal(recurrence)||null, sqlVal(recurrence_end_at)||null, sqlVal(effort)||null, sqlVal(run_engine)||null, sqlVal(bot_id)||null);
  const task = stmts.getTask.get(id);
  if (status === 'todo') setImmediate(processQueue);
  res.json(task);
});
app.put('/api/tasks/:id', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const { title=task.title, description=task.description, notes=task.notes,
          status=task.status, sort_order=task.sort_order,
          session_id=task.session_id, workdir=task.workdir,
          model=task.model||'sonnet', mode=task.mode||'auto', agent_mode=task.agent_mode||'single',
          max_turns=task.max_turns||30, attachments=task.attachments,
          depends_on=task.depends_on, chain_id=task.chain_id, source_session_id=task.source_session_id,
          scheduled_at=task.scheduled_at, recurrence=task.recurrence, recurrence_end_at=task.recurrence_end_at,
          effort=task.effort, run_engine=task.run_engine,
          bot_id=task.bot_id } = req.body;
  // Stop running process when task is moved away from in_progress
  if (task.status === 'in_progress' && status !== 'in_progress') {
    const ctrl = runningTaskAborts.get(req.params.id);
    if (ctrl) {
      stoppingTasks.add(req.params.id);
      ctrl.abort();
      console.log(`[taskWorker] aborting task "${task.title}" (${req.params.id}) — moved to ${status}`);
    } else if (task.worker_pid) {
      stoppingTasks.add(req.params.id);
      killByPid(task.worker_pid);
    }
  }
  stmts.updateTask.run(
    String(title).substring(0,200), String(description).substring(0,2000),
    String(notes||'').substring(0,2000),
    sqlVal(status), sqlVal(sort_order), sqlVal(session_id) || null, sqlVal(workdir) || null,
    sqlVal(model), sqlVal(mode), sqlVal(agent_mode), sqlVal(max_turns), sqlVal(attachments) || null,
    sqlVal(depends_on) || null, sqlVal(chain_id) || null, sqlVal(source_session_id) || null,
    sqlVal(scheduled_at) || null, sqlVal(recurrence) || null, sqlVal(recurrence_end_at) || null,
    sqlVal(effort) || null,
    sqlVal(run_engine) || null,
    sqlVal(bot_id) || null,
    req.params.id
  );
  const updated = stmts.getTask.get(req.params.id);
  // Trigger queue whenever status is todo (covers "Run now" on scheduled tasks too)
  if (status === 'todo') setImmediate(processQueue);
  res.json(updated);
});
app.delete('/api/tasks/:id', (req, res) => {
  const tid = req.params.id;
  // Abort running subprocess if this task is in progress
  const taskAbort = runningTaskAborts.get(tid);
  if (taskAbort) {
    stoppingTasks.add(tid);
    try { taskAbort.abort(); } catch {}
  }
  // Kill worker process directly if PID is known
  const task = stmts.getTask.get(tid);
  if (task?.worker_pid) killByPid(task.worker_pid);
  // Re-link depends_on for chain tasks so the next task doesn't get stuck
  if (task?.chain_id) {
    const siblings = stmts.getChainTasksList.all(task.chain_id);
    const idx = siblings.findIndex(t => t.id === tid);
    if (idx >= 0 && idx < siblings.length - 1) {
      const nextTask = siblings[idx + 1];
      const prevId = idx > 0 ? siblings[idx - 1].id : null;
      db.prepare(`UPDATE tasks SET depends_on=?, updated_at=datetime('now') WHERE id=?`)
        .run(prevId ? JSON.stringify([prevId]) : null, nextTask.id);
    }
  }
  stmts.deleteTask.run(tid);
  res.json({ ok: true });
});

// ─── Task Chains (Groups) ────────────────────────────────────────────────
app.get('/api/task-chains', (req, res) => {
  const workdir = req.query.workdir || null;
  const rows = stmts.getChains.all({ w: workdir || null });
  res.json(rows.map(chainWithSummary));
});
app.get('/api/task-chains/etag', (req, res) => {
  // Combine chains etag with tasks etag for accurate change detection
  const ce = stmts.getChainsEtag.get();
  const te = stmts.getTasksEtag.get();
  res.json({ ts: [ce.ts, te.ts].join('|'), n: ce.n });
});
app.get('/api/task-chains/:id', (req, res) => {
  const chain = stmts.getChain.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Not found' });
  res.json(chainWithSummary(chain));
});
app.post('/api/task-chains', (req, res) => {
  const { title = 'Task Group', workdir = null, model = 'sonnet', mode = 'auto',
          agent_mode = 'single', max_turns = 30, scheduled_at = null,
          recurrence = null, recurrence_end_at = null, effort = null } = req.body;
  const id = genId();
  // Create shared session for the chain
  const sessionId = genId();
  stmts.createSession.run(sessionId, String(title).substring(0, 200), '[]', '[]',
    sqlVal(mode), sqlVal(agent_mode), sqlVal(model), sqlVal(workdir) || null);
  stmts.createChain.run(id, String(title).substring(0, 200), sqlVal(workdir) || null,
    sqlVal(model), sqlVal(mode), sqlVal(agent_mode), sqlVal(max_turns),
    sessionId, sqlVal(scheduled_at) || null, sqlVal(recurrence) || null,
    sqlVal(recurrence_end_at) || null, null, 0, sqlVal(effort) || null);
  res.json(chainWithSummary(stmts.getChain.get(id)));
});
app.put('/api/task-chains/:id', (req, res) => {
  const chain = stmts.getChain.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Not found' });
  const { title = chain.title, workdir = chain.workdir, model = chain.model,
          mode = chain.mode, agent_mode = chain.agent_mode, max_turns = chain.max_turns,
          session_id = chain.session_id, scheduled_at = chain.scheduled_at,
          recurrence = chain.recurrence, recurrence_end_at = chain.recurrence_end_at,
          sort_order = chain.sort_order, effort = chain.effort } = req.body;
  stmts.updateChain.run(String(title).substring(0, 200), sqlVal(workdir) || null,
    sqlVal(model), sqlVal(mode), sqlVal(agent_mode), sqlVal(max_turns),
    sqlVal(session_id) || null, sqlVal(scheduled_at) || null, sqlVal(recurrence) || null,
    sqlVal(recurrence_end_at) || null, sqlVal(sort_order), sqlVal(effort) || null, req.params.id);
  // If scheduled_at changed, propagate to child tasks
  if (scheduled_at !== chain.scheduled_at) {
    const tasks = stmts.getChainTasksList.all(req.params.id);
    for (const t of tasks) {
      db.prepare(`UPDATE tasks SET scheduled_at=?, updated_at=datetime('now') WHERE id=?`)
        .run(sqlVal(scheduled_at) || null, t.id);
    }
  }
  res.json(chainWithSummary(stmts.getChain.get(req.params.id)));
});
app.delete('/api/task-chains/:id', (req, res) => {
  const chain = stmts.getChain.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Not found' });
  // Abort any running tasks in this chain
  const tasks = stmts.getChainTasksList.all(req.params.id);
  for (const t of tasks) {
    if (t.status === 'in_progress') {
      const ctrl = runningTaskAborts.get(t.id);
      if (ctrl) { stoppingTasks.add(t.id); ctrl.abort(); }
      else if (t.worker_pid) { stoppingTasks.add(t.id); killByPid(t.worker_pid); }
    }
  }
  stmts.deleteChainTasks.run(req.params.id);
  stmts.deleteChain.run(req.params.id);
  res.json({ ok: true });
});
// Add task to chain — auto-sets depends_on to previous task
app.post('/api/task-chains/:id/tasks', (req, res) => {
  const chain = stmts.getChain.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Chain not found' });
  const { title = 'Subtask', description = '', notes = '' } = req.body;
  const existing = stmts.getChainTasksList.all(req.params.id);
  const lastTask = existing[existing.length - 1];
  const sortOrder = existing.length ? (lastTask?.sort_order || 0) + 1000 : 0;
  const dependsOn = lastTask ? JSON.stringify([lastTask.id]) : null;
  // Inherit chain's derived status for new tasks
  const chainStatus = deriveChainStatus(req.params.id);
  const taskStatus = (chainStatus === 'in_progress' || chainStatus === 'todo') ? 'todo' : 'backlog';
  const taskId = genId();
  stmts.createTask.run(taskId, String(title).substring(0, 200), String(description).substring(0, 2000),
    String(notes || '').substring(0, 2000), taskStatus, sortOrder,
    chain.session_id || null, chain.workdir || null, chain.model || 'sonnet',
    chain.mode || 'auto', chain.agent_mode || 'single', chain.max_turns || 30,
    null, dependsOn, req.params.id, chain.source_session_id || null,
    chain.scheduled_at || null, null, null, chain.effort || null, chain.run_engine || null);
  if (taskStatus === 'todo') setImmediate(processQueue);
  res.json(stmts.getTask.get(taskId));
});
// Reorder tasks within a chain — rebuilds depends_on chain
app.put('/api/task-chains/:id/tasks/reorder', (req, res) => {
  const chain = stmts.getChain.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Chain not found' });
  const { task_ids } = req.body;
  if (!Array.isArray(task_ids)) return res.status(400).json({ error: 'task_ids must be an array' });
  db.transaction(() => {
    for (let i = 0; i < task_ids.length; i++) {
      const tid = task_ids[i];
      const prevId = i > 0 ? task_ids[i - 1] : null;
      const dependsOn = prevId ? JSON.stringify([prevId]) : null;
      db.prepare(`UPDATE tasks SET sort_order=?, depends_on=?, updated_at=datetime('now') WHERE id=? AND chain_id=?`)
        .run(i * 1000, dependsOn, tid, req.params.id);
    }
  })();
  db.prepare(`UPDATE task_chains SET updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.json(chainWithSummary(stmts.getChain.get(req.params.id)));
});
// Activate chain — set all tasks to todo, first one has no depends_on
app.post('/api/task-chains/:id/activate', (req, res) => {
  const chain = stmts.getChain.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Chain not found' });
  const tasks = stmts.getChainTasksList.all(req.params.id);
  if (!tasks.length) return res.status(400).json({ error: 'Chain has no tasks' });
  db.transaction(() => {
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      // Skip already completed/in-progress tasks
      if (t.status === 'done' || t.status === 'in_progress') continue;
      const prevId = i > 0 ? tasks[i - 1].id : null;
      const dependsOn = prevId ? JSON.stringify([prevId]) : null;
      db.prepare(`UPDATE tasks SET status='todo', depends_on=?, sort_order=?, scheduled_at=?, updated_at=datetime('now') WHERE id=?`)
        .run(dependsOn, i * 1000, chain.scheduled_at || null, t.id);
    }
    db.prepare(`UPDATE task_chains SET updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  })();
  setImmediate(processQueue);
  res.json(chainWithSummary(stmts.getChain.get(req.params.id)));
});
// Remove a single task from chain — re-links depends_on
app.delete('/api/task-chains/:chainId/tasks/:taskId', (req, res) => {
  const { chainId, taskId } = req.params;
  const chain = stmts.getChain.get(chainId);
  if (!chain) return res.status(404).json({ error: 'Chain not found' });
  const tasks = stmts.getChainTasksList.all(chainId);
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx < 0) return res.status(404).json({ error: 'Task not in chain' });
  // Abort if running
  const task = stmts.getTask.get(taskId);
  const ctrl = runningTaskAborts.get(taskId);
  if (ctrl) { stoppingTasks.add(taskId); ctrl.abort(); }
  else if (task?.worker_pid) { stoppingTasks.add(taskId); killByPid(task.worker_pid); }
  // Re-link: next task's depends_on points to previous task
  if (idx < tasks.length - 1) {
    const nextTask = tasks[idx + 1];
    const prevId = idx > 0 ? tasks[idx - 1].id : null;
    const newDeps = prevId ? JSON.stringify([prevId]) : null;
    db.prepare(`UPDATE tasks SET depends_on=?, updated_at=datetime('now') WHERE id=?`).run(newDeps, nextTask.id);
  }
  stmts.deleteTask.run(taskId);
  db.prepare(`UPDATE task_chains SET updated_at=datetime('now') WHERE id=?`).run(chainId);
  res.json(chainWithSummary(stmts.getChain.get(chainId)));
});

// ─── Task Dispatch (Chat → Kanban chain) ─────────────────────────────────
app.post('/api/tasks/dispatch', (req, res) => {
  const {
    plan_description,
    tasks: planTasks,
    workdir,
    model = 'sonnet',
    source_session_id,
    claude_session_id,
    effort = null,
    run_engine = null,
  } = req.body;

  if (!planTasks?.length) return res.status(400).json({ error: 'No tasks provided' });
  if (planTasks.length > 10) return res.status(400).json({ error: 'Max 10 tasks per dispatch' });

  // Circular dependency detection (DFS)
  // Validate dependency references exist + detect cycles
  const validIds = new Set(planTasks.map(t => t.id));
  for (const t of planTasks) {
    for (const dep of (t.depends_on || [])) {
      if (!validIds.has(dep)) return res.status(400).json({ error: `Unknown dependency: ${dep}` });
    }
  }
  const adj = {};
  for (const t of planTasks) adj[t.id] = t.depends_on || [];
  const _visited = new Set(), _stack = new Set();
  function _hasCycle(node) {
    if (_stack.has(node)) return true;
    if (_visited.has(node)) return false;
    _visited.add(node); _stack.add(node);
    for (const dep of (adj[node] || [])) { if (_hasCycle(dep)) return true; }
    _stack.delete(node);
    return false;
  }
  if (planTasks.some(t => _hasCycle(t.id))) {
    return res.status(400).json({ error: 'Circular dependency detected in plan' });
  }

  const chainId = genId();

  // Inherit MCP + skills from source session
  const source = source_session_id ? stmts.getSession.get(source_session_id) : null;
  const chainSessionId = genId();
  stmts.createSession.run(
    chainSessionId,
    (plan_description || 'Task chain').substring(0, 200),
    source?.active_mcp || '[]',
    source?.active_skills || '[]',
    'auto', 'single', sqlVal(model) || 'sonnet',
    sqlVal(workdir) || null
  );

  // Register chain in task_chains table (gives it a title, session, and metadata)
  stmts.createChain.run(chainId, (plan_description || 'Task chain').substring(0, 200),
    sqlVal(workdir) || null, sqlVal(model) || 'sonnet', 'auto', 'single', 30,
    chainSessionId, null, null, null, source_session_id || null, 0, sqlVal(effort) || null);

  // Chain gets its OWN Claude session — first task starts fresh,
  // subsequent tasks --resume from the chain's session (NOT the source chat's).

  // First pass: assign real IDs to all tasks (handles forward references in depends_on)
  const idMap = {};
  for (const t of planTasks) idMap[t.id] = genId();
  const createdTasks = [];

  db.transaction(() => {
    for (let i = 0; i < planTasks.length; i++) {
      const t = planTasks[i];
      const taskId = idMap[t.id];
      const realDeps = (t.depends_on || []).map(d => idMap[d]).filter(Boolean);

      stmts.createTask.run(
        taskId,
        (t.title || t.role || 'Subtask').substring(0, 200),
        (t.description || t.task || '').substring(0, 2000),
        '',            // notes
        'todo',
        i,             // sort_order preserves plan ordering
        chainSessionId,
        sqlVal(workdir) || null,
        sqlVal(model) || 'sonnet',
        'auto', 'single', 30,
        null,          // attachments
        realDeps.length ? JSON.stringify(realDeps) : null,
        chainId,
        source_session_id || null,
        null, null, null, // scheduled_at, recurrence, recurrence_end_at
        sqlVal(t.effort || effort) || null,  // per-task override else dispatch-level effort
        sqlVal(t.run_engine || run_engine) || null  // per-task override else dispatch-level engine
      );
      createdTasks.push(stmts.getTask.get(taskId));
    }
  })();

  setImmediate(processQueue);
  log.info('Tasks dispatched', { chainId, count: createdTasks.length, workdir });
  res.json({ chain_id: chainId, session_id: chainSessionId, tasks: createdTasks });
});

// Sessions
app.get('/api/sessions', (req,res) => {
  const { workdir } = req.query;
  res.json(workdir ? stmts.getSessionsByWorkdir.all(workdir) : stmts.getSessions.all());
});
app.post('/api/sessions', (req, res) => {
  const { title = i18nSession(), workdir = null, model = 'sonnet', mode = 'auto', agentMode = 'single', kind = 'chat', terminalAgent = null } = req.body || {};
  const id = genId();
  if (kind === 'terminal') {
    // loadConfig(), not loadMergedConfig(): the merged view is a whitelist of
    // mcpServers/skills/slashCommands/lang/defaultEngine and does NOT carry
    // externalAgents — same reason /api/external-agents reads loadConfig().
    const agents = loadConfig().externalAgents || {};
    if (!terminalAgent || !supportsTerminal(agents[terminalAgent])) {
      return res.status(400).json({ error: 'terminalAgent must name an agent with an "interactive" command' });
    }
    // Get an exact conversation id up front so a later restore targets THIS
    // conversation instead of "the agent's most recent one". Two mechanisms:
    //   newIdFlag    — we mint the id and pass it at launch (claude, grok)
    //   newIdCommand — the CLI mints it and prints it (cursor-agent create-chat)
    // Agents with neither stay on the resumeLast fallback.
    const cmds = resolveAgentCommands(agents[terminalAgent]);
    let convId = null;
    if (cmds.newIdFlag) {
      convId = crypto.randomUUID();
    } else if (cmds.newIdCommand) {
      try {
        const r = spawnSync('/bin/sh', ['-c', cmds.newIdCommand], { encoding: 'utf8', timeout: 30000 });
        convId = r.status === 0 ? parseNewIdOutput(r.stdout) : null;
        if (!convId) log.warn('newIdCommand produced no usable id', { agent: terminalAgent, status: r.status });
      } catch (e) {
        log.warn('newIdCommand failed', { agent: terminalAgent, err: e.message });
      }
    }
    stmts.createTerminalSession.run(id, String(title).substring(0, 200), sqlVal(model), sqlVal(workdir) || null, terminalAgent, convId);
    return res.json(stmts.getSession.get(id));
  }
  stmts.createSession.run(id, String(title).substring(0, 200), '[]', '[]', sqlVal(mode), sqlVal(agentMode), sqlVal(model), sqlVal(workdir) || null);
  res.json(stmts.getSession.get(id));
});
// Fork session — create a branch from an existing conversation
app.post('/api/sessions/:id/fork', (req, res) => {
  const source = stmts.getSession.get(req.params.id);
  if (!source) return res.status(404).json({ error: 'session not found' });
  if (!source.claude_session_id) return res.status(400).json({ error: 'session has no Claude session to fork from' });
  const id = genId();
  const title = `Fork: ${(source.title || '').substring(0, 80)}`;
  stmts.createSession.run(id, title, source.active_mcp || '[]', source.active_skills || '[]',
    source.mode || 'auto', source.agent_mode || 'single', source.model || 'sonnet', source.workdir || null);
  // Set claude_session_id to source's so --resume picks it up, and fork_from_cid to trigger --fork-session
  db.prepare(`UPDATE sessions SET claude_session_id=?, fork_from_cid=? WHERE id=?`).run(source.claude_session_id, source.claude_session_id, id);
  res.json(stmts.getSession.get(id));
});
app.get('/api/sessions/interrupted', (req, res) => { res.json(stmts.getInterrupted.all()); });

// ─── CLI Session Import ───────────────────────────────────────────────────────
// Convert workdir path to Claude Code CLI project directory name
// e.g. /Users/admin/_Projects/foo  →  -Users-admin--Projects-foo
function cwdToCliProjectName(cwd) {
  if (cwd.startsWith('~')) cwd = os.homedir() + cwd.slice(1);
  if (/^[A-Za-z]:/.test(cwd)) {
    // Windows path: normalize backslash separator and replace drive-letter colon
    return cwd.replace(/\\/g, '/').replace(/[/_:]/g, '-');
  }
  return cwd.replace(/[/_]/g, '-');
}

// Extract thinking blocks from the last assistant turn in a Claude CLI JSONL session file.
// Reads only the tail of the file (last 200KB) for efficiency on large session files.
// Returns concatenated thinking text or null if none found.
function extractThinkingFromJsonl(claudeSessionId, workdir) {
  if (!claudeSessionId || !/^[a-f0-9-]+$/i.test(claudeSessionId)) return null;
  const homeDir = os.homedir();
  const projectDir = path.resolve(path.join(homeDir, '.claude', 'projects', cwdToCliProjectName(workdir)));
  const jsonlPath = path.resolve(path.join(projectDir, claudeSessionId + '.jsonl'));
  if (!jsonlPath.startsWith(projectDir)) return null;
  if (!fs.existsSync(jsonlPath)) return null;

  // Read only the tail — single JSONL lines can reach 600KB+ (large tool_use),
  // so we need enough to capture the last assistant turn + result line
  const stat = fs.statSync(jsonlPath);
  const TAIL_SIZE = 1024 * 1024; // 1MB
  let raw;
  if (stat.size > TAIL_SIZE) {
    const buf = Buffer.alloc(TAIL_SIZE);
    const fd = fs.openSync(jsonlPath, 'r');
    fs.readSync(fd, buf, 0, TAIL_SIZE, stat.size - TAIL_SIZE);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
    // Drop the first partial line
    const nlIdx = raw.indexOf('\n');
    if (nlIdx >= 0) raw = raw.slice(nlIdx + 1);
  } else {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  }

  const lines = raw.trim().split('\n');
  const thinkingParts = [];
  // Walk backwards to find the last assistant message
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      for (const block of d.message.content) {
        if (block.type === 'thinking' && block.thinking) {
          thinkingParts.push(block.thinking);
        }
      }
      break;
    }
  }
  return thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null;
}


app.get('/api/sessions/cli-list', (req, res) => {
  const workdir = String(req.query.workdir || WORKDIR || '');
  const homeDir = os.homedir();
  const safeBase = path.resolve(path.join(homeDir, '.claude', 'projects'));
  const projectPath = path.resolve(path.join(safeBase, cwdToCliProjectName(workdir)));
  if (!projectPath.startsWith(safeBase)) return res.status(400).json({ error: 'invalid workdir' });
  if (!fs.existsSync(projectPath)) return res.json({ sessions: [], projectPath });

  let filenames;
  try { filenames = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl')); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const importedIds = new Set(
    db.prepare(`SELECT claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL`).all()
      .map(r => r.claude_session_id)
  );

  const sessions = [];
  for (const fname of filenames) {
    const sessionId = fname.replace('.jsonl', '');
    // Basic UUID format check
    if (!/^[a-f0-9-]{8,}$/i.test(sessionId)) continue;
    const filePath = path.join(projectPath, fname);
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      let timestamp = '', title = '', titleFound = false, userCount = 0, assistantCount = 0;
      for (const line of lines) {
        let d; try { d = JSON.parse(line); } catch { continue; }
        if (!timestamp && d.timestamp) timestamp = d.timestamp;
        if (d.type === 'user') {
          userCount++;
          if (!titleFound) {
            const mc = d.message?.content;
            if (typeof mc === 'string' && mc.trim()) { title = mc.substring(0, 100); titleFound = true; }
            else if (Array.isArray(mc)) {
              const tb = mc.find(b => b.type === 'text' && b.text);
              if (tb) { title = tb.text.substring(0, 100); titleFound = true; }
            }
          }
        } else if (d.type === 'assistant') assistantCount++;
      }
      if (!title) title = sessionId.substring(0, 8) + '…';
      sessions.push({ sessionId, title, timestamp, messageCount: userCount + assistantCount, alreadyImported: importedIds.has(sessionId) });
    } catch { /* skip unreadable */ }
  }
  sessions.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  res.json({ sessions, projectPath });
});

app.post('/api/sessions/cli-import', (req, res) => {
  const { sessionIds, workdir } = req.body || {};
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return res.status(400).json({ error: 'no sessionIds' });
  const targetWorkdir = String(workdir || WORKDIR || '');
  const homeDir = os.homedir();
  const safeBase = path.resolve(path.join(homeDir, '.claude', 'projects'));
  const projectPath = path.resolve(path.join(safeBase, cwdToCliProjectName(targetWorkdir)));
  if (!projectPath.startsWith(safeBase)) return res.status(400).json({ error: 'invalid workdir' });

  const imported = [], skipped = [], errors = [];
  const updateClaudeId = db.prepare(`UPDATE sessions SET claude_session_id=? WHERE id=?`);
  const updateTimestamps = db.prepare(`UPDATE sessions SET created_at=?, updated_at=? WHERE id=?`);
  const insertMsg = db.prepare(`INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,created_at) VALUES (?,?,?,?,?,?,?)`);

  const tx = db.transaction(() => {
    for (const sessionId of sessionIds) {
      if (!/^[a-f0-9-]{8,}$/i.test(sessionId)) { errors.push({ sessionId, error: 'invalid id' }); continue; }
      const existing = db.prepare(`SELECT id FROM sessions WHERE claude_session_id=?`).get(sessionId);
      if (existing) { skipped.push(sessionId); continue; }

      const filePath = path.resolve(path.join(projectPath, sessionId + '.jsonl'));
      if (!filePath.startsWith(projectPath)) { errors.push({ sessionId, error: 'path traversal' }); continue; }
      try {
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
        let title = '', titleFound = false, sessionTs = null, cwd = targetWorkdir;
        const msgs = [];

        for (const line of lines) {
          let d; try { d = JSON.parse(line); } catch { continue; }
          if (!sessionTs && d.timestamp) sessionTs = d.timestamp;
          if (d.cwd && !cwd) cwd = d.cwd;

          if (d.type === 'user') {
            const mc = d.message?.content;
            const ts = d.timestamp || sessionTs;
            if (Array.isArray(mc)) {
              const nonTool = mc.filter(b => b.type !== 'tool_result');
              if (nonTool.length === 0) continue; // skip pure tool_result entries
              const text = nonTool.filter(b => b.type === 'text').map(b => b.text).join('\n');
              if (text.trim()) {
                if (!titleFound) { title = text.substring(0, 100); titleFound = true; }
                msgs.push({ role: 'user', type: 'text', content: text, tool_name: null, ts });
              }
            } else if (typeof mc === 'string' && mc.trim()) {
              if (!titleFound) { title = mc.substring(0, 100); titleFound = true; }
              msgs.push({ role: 'user', type: 'text', content: mc, tool_name: null, ts });
            }
          } else if (d.type === 'assistant') {
            const mc = d.message?.content;
            const ts = d.timestamp || sessionTs;
            if (!Array.isArray(mc)) continue;
            for (const block of mc) {
              if (block.type === 'thinking' && block.thinking)
                msgs.push({ role: 'assistant', type: 'thinking', content: block.thinking, tool_name: null, ts });
              else if (block.type === 'text' && block.text)
                msgs.push({ role: 'assistant', type: 'text', content: block.text, tool_name: null, ts });
              else if (block.type === 'tool_use' && block.name)
                msgs.push({ role: 'assistant', type: 'tool', content: JSON.stringify(block.input || {}), tool_name: block.name, ts });
            }
          }
        }

        if (msgs.length === 0) { skipped.push(sessionId); continue; }
        if (!title) title = 'CLI: ' + sessionId.substring(0, 8);

        const newId = genId();
        stmts.createSession.run(newId, title.substring(0, 200), '[]', '[]', 'auto', 'single', 'sonnet', cwd || null);
        updateClaudeId.run(sessionId, newId);
        if (sessionTs) updateTimestamps.run(sessionTs, sessionTs, newId);
        for (const m of msgs) insertMsg.run(newId, m.role, m.type, m.content, m.tool_name, null, m.ts || sessionTs);
        imported.push({ sessionId, newId, title, messageCount: msgs.length });
      } catch (e) { errors.push({ sessionId, error: e.message }); }
    }
  });

  try { tx(); res.json({ imported, skipped, errors }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Enrich existing sessions with thinking blocks from JSONL files.
// Finds sessions that have a claude_session_id but no thinking messages,
// reads thinking from the corresponding JSONL, and inserts them.
app.post('/api/sessions/enrich-thinking', (req, res) => {
  const workdir = String(req.body?.workdir || WORKDIR || '');
  const homeDir = os.homedir();
  const safeBase = path.resolve(path.join(homeDir, '.claude', 'projects'));
  const projectPath = path.resolve(path.join(safeBase, cwdToCliProjectName(workdir)));
  if (!projectPath.startsWith(safeBase)) return res.status(400).json({ error: 'invalid workdir' });

  // Find sessions with a claude_session_id matching the target workdir (or null workdir)
  const sessions = db.prepare(`SELECT id, claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL AND (workdir = ? OR workdir IS NULL)`).all(workdir);
  // Find which sessions already have thinking messages
  const sessionsWithThinking = new Set(
    db.prepare(`SELECT DISTINCT session_id FROM messages WHERE type='thinking'`).all().map(r => r.session_id)
  );

  const insertThinking = db.prepare(`INSERT INTO messages (session_id, role, type, content, tool_name, agent_id, created_at) VALUES (?, 'assistant', 'thinking', ?, NULL, NULL, ?)`);

  let enriched = 0, skipped = 0, errored = 0;
  const tx = db.transaction(() => {
    for (const sess of sessions) {
      if (sessionsWithThinking.has(sess.id)) { skipped++; continue; }

      const jsonlPath = path.resolve(path.join(projectPath, sess.claude_session_id + '.jsonl'));
      if (!jsonlPath.startsWith(projectPath)) { skipped++; continue; }
      if (!fs.existsSync(jsonlPath)) { skipped++; continue; }

      try {
        const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
        let inserted = 0;

        for (const line of lines) {
          let d;
          try { d = JSON.parse(line); } catch { continue; }
          if (d.type !== 'assistant' || !Array.isArray(d.message?.content)) continue;

          const ts = d.timestamp || null;
          for (const block of d.message.content) {
            if (block.type === 'thinking' && block.thinking) {
              insertThinking.run(sess.id, block.thinking, ts);
              inserted++;
            }
          }
        }

        if (inserted > 0) enriched++;
        else skipped++;
      } catch (e) {
        log.error('[ENRICH-THINKING] failed for session', { sessionId: sess.id, error: e.message });
        errored++;
      }
    }
  });

  try {
    tx();
    res.json({ enriched, skipped, errored, total: sessions.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sessions/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'no ids' });
  const update = db.prepare(`UPDATE sessions SET sort_order=? WHERE id=?`);
  const tx = db.transaction(() => { ids.forEach((id, i) => update.run(i, String(id))); });
  tx();
  res.json({ ok: true });
});
// ─── Export session as JSON ───────────────────────────────────────────────
app.get('/api/sessions/:id/export', (req, res) => {
  const sess = stmts.getSession.get(req.params.id);
  if (!sess) return res.status(404).json({ error: 'Not found' });
  const messages = stmts.getMsgs.all(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="session-${req.params.id}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ version: 1, exported_at: new Date().toISOString(), session: sess, messages });
});

// ─── Import session from JSON export ──────────────────────────────────────
app.post('/api/sessions/import', (req, res) => {
  const { session, messages } = req.body || {};
  if (!session || typeof session !== 'object' || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid import body: session object and messages array required' });
  }
  const newId = genId();
  const tx = db.transaction(() => {
    stmts.createSession.run(
      newId,
      String(session.title || 'Imported session').substring(0, 200),
      session.active_mcp || '[]',
      session.active_skills || '[]',
      session.mode || 'auto',
      session.agent_mode || 'single',
      session.model || 'sonnet',
      session.workdir || null
    );
    const importMsg = db.prepare('INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,reply_to_id,attachments,created_at) VALUES (?,?,?,?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP))');
    const limit = Math.min(messages.length, 2000);
    // reply_to_id holds row ids from the SOURCE database. Inserting them verbatim
    // either violates the self-FK (foreign_keys=ON → whole import fails) or points
    // at unrelated messages. Pass 1 inserts with reply_to_id=NULL while recording
    // old→new id; pass 2 rewrites reply_to_id through that map (unknown refs stay NULL).
    const idMap = new Map();
    for (let i = 0; i < limit; i++) {
      const m = messages[i];
      const info = importMsg.run(newId, m.role, m.type, m.content || '', m.tool_name || null, m.agent_id || null, null, m.attachments || null, m.created_at || null);
      if (m.id != null) idMap.set(String(m.id), Number(info.lastInsertRowid));
    }
    const updReply = db.prepare('UPDATE messages SET reply_to_id=? WHERE id=?');
    for (let i = 0; i < limit; i++) {
      const m = messages[i];
      if (m.reply_to_id == null || m.id == null) continue;
      const newSelf = idMap.get(String(m.id));
      const newTarget = idMap.get(String(m.reply_to_id));
      if (newSelf != null && newTarget != null) updReply.run(newTarget, newSelf);
    }
  });
  try {
    tx();
    res.status(201).json({ ok: true, session: stmts.getSession.get(newId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions/:id', (req,res) => {
  const s = stmts.getSession.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });

  s.messages = stmts.getMsgsLite.all(req.params.id);
  s.hasRunningTask = !!stmts.hasRunningTask.get(req.params.id);
  s.isChatRunning = isSessionLive(req.params.id);
  const chainTasks = stmts.getChainTasks.all(req.params.id);
  if (chainTasks.length) {
    const chains = {};
    for (const t of chainTasks) {
      if (!t.chain_id) continue;
      if (!chains[t.chain_id]) chains[t.chain_id] = [];
      chains[t.chain_id].push({ id: t.id, title: t.title, status: t.status, depends_on: t.depends_on });
    }
    s.chains = chains;
  }
  res.json(s);
});
app.put('/api/sessions/:id', (req, res) => {
  const { title, active_mcp, active_skills, notes } = req.body;
  if (title) stmts.updateTitle.run(title, req.params.id);
  if (notes !== undefined) db.prepare(`UPDATE sessions SET notes=?,updated_at=datetime('now') WHERE id=?`).run(notes, req.params.id);
  if (active_mcp !== undefined || active_skills !== undefined) {
    db.prepare(`UPDATE sessions SET active_mcp=COALESCE(?,active_mcp),active_skills=COALESCE(?,active_skills),updated_at=datetime('now') WHERE id=?`)
      .run(
        active_mcp !== undefined ? JSON.stringify(active_mcp) : null,
        active_skills !== undefined ? JSON.stringify(active_skills) : null,
        req.params.id
      );
  }
  res.json({ok:true});
});
// ─── Compact session → create new session with summary ───────────────────
app.post('/api/sessions/:id/compact', async (req, res) => {
  const sid = req.params.id;
  const sess = stmts.getSession.get(sid);
  if (!sess) return res.status(404).json({ error: 'Session not found' });

  // Fetch all text messages (skip tool messages — they're noise for summary)
  const msgs = stmts.getMsgs.all(sid).filter(m => m.type === 'text' && m.content);
  if (msgs.length === 0) return res.status(400).json({ error: 'No messages to compact' });

  // Build conversation transcript (cap at ~80K chars to stay within context)
  const MAX_TRANSCRIPT = 80000;
  let transcript = '';
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const prefix = m.role === 'user' ? '👤 User' : '🤖 Assistant';
    const chunk = `${prefix}:\n${m.content}\n\n`;
    if (transcript.length + chunk.length > MAX_TRANSCRIPT) {
      transcript += `\n[...${msgs.length - i} more messages truncated...]\n`;
      break;
    }
    transcript += chunk;
  }

  const compactPrompt = `Here is a conversation transcript from a coding session. Create a concise but comprehensive summary that captures:

1. **Context**: What project/codebase was being worked on
2. **Key decisions**: Important technical decisions made
3. **What was built/changed**: Files modified, features added, bugs fixed
4. **Current state**: Where things stand now
5. **Open items**: What still needs to be done or was discussed but not started

Be structured and actionable — this summary will be used as context to continue the work in a new chat session.

---
CONVERSATION TRANSCRIPT:
${transcript}`;

  // Use CLI (Haiku) for fast summarization — no tools needed
  const cli = new ClaudeCLI({ cwd: sess.workdir || WORKDIR });
  let summaryText = '';

  try {
    await new Promise((resolve, reject) => {
      const ac = new AbortController();
      const timeout = setTimeout(() => { ac.abort(); reject(new Error('Compact timed out')); }, 120000);

      cli.send({
        prompt: compactPrompt,
        model: 'haiku',
        maxTurns: 1,
        tools: '',
        mcpServers: {},
        abortController: ac,
      })
        .onText(t => { summaryText += t; })
        .onError(err => { log.error('compact onError', { sid, err }); })
        .onDone(() => { clearTimeout(timeout); resolve(); });
    });
  } catch (err) {
    log.error('compact failed', { sid, err: err.message });
    return res.status(500).json({ error: 'Failed to generate summary: ' + err.message });
  }

  if (!summaryText.trim()) {
    return res.status(500).json({ error: 'Empty summary generated' });
  }

  // Create new session inheriting settings from the original
  const newId = genId();
  const compactTitle = (sess.title || 'Chat').substring(0, 150) + ' (compact)';
  stmts.createSession.run(
    newId,
    compactTitle,
    sess.active_mcp || '[]',
    sess.active_skills || '[]',
    sess.mode || 'auto',
    sess.agent_mode || 'single',
    sess.model || 'sonnet',
    sess.workdir || null
  );

  // Insert the compact summary as the first user message so Claude gets context
  const contextMsg = `# 📋 Context from previous session\n\nThis is a continuation of a previous chat session. Here is the compact summary:\n\n${summaryText.trim()}`;
  stmts.addMsg.run(newId, 'user', 'text', contextMsg, null, null, null, null);

  log.info('session compacted', { originalId: sid, newId, msgCount: msgs.length, summaryLen: summaryText.length });
  res.json({ id: newId, title: compactTitle, originalId: sid });
});

app.get('/api/sessions/:id/tasks-count', (req,res) => { res.json(stmts.countTasksBySession.get(req.params.id)); });
app.delete('/api/sessions/:id', (req,res) => {
  const sid = req.params.id;
  // Abort any running Claude subprocess for this session before deleting
  const active = activeTasks.get(sid);
  if (active) {
    try { active.abortController.abort(); } catch {}
    if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
    activeTasks.delete(sid);
  }
  chatBuffers.delete(sid);
  // Archive dashboard stats before deletion (ON DELETE CASCADE removes messages)
  archiveSessionStats([sid]);
  // Best-effort: kill the interactive tmux session tied to this studio session
  try { killInteractiveTmux(sid); } catch {}
  // Unlink recurring tasks from session (preserve the schedule), delete the rest
  db.prepare(`UPDATE tasks SET session_id=NULL WHERE session_id=? AND recurrence IS NOT NULL`).run(sid);
  stmts.deleteTasksBySession.run(sid);
  stmts.deleteSession.run(sid);
  sessionQueues.delete(sid);
  res.json({ok:true});
});
app.post('/api/sessions/bulk-delete', (req,res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'no ids' });
  // Abort running subprocesses before deleting
  for (const id of ids) {
    const active = activeTasks.get(id);
    if (active) {
      try { active.abortController.abort(); } catch {}
      if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
      activeTasks.delete(id);
    }
    chatBuffers.delete(id);
  }
  // Archive dashboard stats before deletion (ON DELETE CASCADE removes messages)
  archiveSessionStats(ids);
  // Best-effort: kill interactive tmux sessions tied to these studio sessions
  for (const id of ids) { try { killInteractiveTmux(id); } catch {} }
  // Terminal sessions live under their own tmux prefix and need their own cleanup,
  // plus the scrollback file the reaper may have left behind.
  for (const id of ids) {
    try { termBridge.killSession(tmuxNameFor(id)); } catch {}
    try { fs.unlinkSync(path.join(os.tmpdir(), `ccsterm-sb-${id}.txt`)); } catch {}
  }
  const del = db.transaction(() => {
    for (const id of ids) {
      // Unlink recurring tasks from session (preserve the schedule), delete the rest
      db.prepare(`UPDATE tasks SET session_id=NULL WHERE session_id=? AND recurrence IS NOT NULL`).run(id);
      stmts.deleteTasksBySession.run(id); stmts.deleteSession.run(id); sessionQueues.delete(id);
      try { stmts.delQueuedBySession.run(id); } catch {}
    }
  });
  del();
  res.json({ ok: true, deleted: ids.length });
});
app.post('/api/sessions/:id/open-terminal', (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  const _cleanSid = sanitizeSessionId(session?.claude_session_id);
  if (!_cleanSid) return res.status(400).json({ error: 'No Claude session ID' });
  const safeSid = _cleanSid.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeSid) return res.status(400).json({ error: 'Invalid session ID' });
  // Baseline the catch-up cursor on first terminal open (only when never set) so the
  // next "⤵ Дочитати" captures exactly this terminal session's work — first click, no
  // throwaway baseline. An existing cursor is left untouched (don't drop prior progress).
  if (session.transcript_offset == null) {
    try { const _tsz = transcriptSize(_cleanSid); db.prepare(`UPDATE sessions SET transcript_offset=? WHERE id=?`).run(_tsz == null ? 0 : _tsz, req.params.id); } catch {}
  }
  const workdir = session.workdir || WORKDIR;
  if (/[&|;<>%^\r\n`]/.test(workdir) || workdir.includes('$(')) {
    return res.status(400).json({ error: 'Invalid directory path: contains unsafe characters' });
  }
  const platform = process.platform;
  let fullCmd, ok = false;
  try {
    if (platform === 'win32') {
      fullCmd = `cd /d "${workdir}" && set CLAUDECODE= && claude --resume ${safeSid}`;
      // Empty title "" required: without it cmd.exe treats first quoted arg as window title.
      // The quotes around the workdir are passed through UNESCAPED on purpose: `\` is not
      // an escape character for cmd, it only counts quotes. `\"` made the inner `cmd /k`
      // hand `cd` the literal path `\C:\proj\` (invalid) → cd failed → `&&` short-circuited
      // and the window opened without claude. Left as-is the quotes stay balanced: the
      // `&&` sits inside a quoted region for the OUTER cmd (so it is not split there) and
      // outside one for the inner `cmd /k` (so it chains, as intended). workdir is already
      // rejected above if it contains & | ; < > % ^ ` or a newline, and Windows forbids `"`
      // in a path, so there is nothing left for the replace to escape.
      execSync(`start "" cmd /k "${fullCmd}"`, { shell: true });
      ok = true;
    } else if (platform === 'darwin') {
      const safeWorkdir = workdir.replace(/'/g, "'\\''");
      fullCmd = `cd '${safeWorkdir}' && unset CLAUDECODE; claude --resume ${safeSid}`;
      // do script BEFORE activate: on a cold Terminal launch, activate-first opens an
      // empty default window and then do script opens a SECOND one. Running do script
      // first makes it reuse the window Terminal auto-opens on launch (single window).
      execSync(`osascript -e 'tell application "Terminal" to do script "${fullCmd.replace(/"/g, '\\"')}"' -e 'tell application "Terminal" to activate'`);
      ok = true;
    } else {
      // Linux: try common terminal emulators using spawn+detach (non-blocking)
      // execSync would kill xterm after the timeout; spawnProc+unref lets it live.
      const safeWorkdir = workdir.replace(/'/g, "'\\''");
      fullCmd = `cd '${safeWorkdir}' && unset CLAUDECODE; claude --resume ${safeSid}`;
      const termCandidates = [
        ['gnome-terminal', ['--', 'bash', '-c', `${fullCmd}; exec bash`]],
        ['xterm',          ['-e', 'bash', '-c', `${fullCmd}; exec bash`]],
        ['konsole',        ['-e', 'bash', '-c', fullCmd]],
      ];
      for (const [cmd, args] of termCandidates) {
        try {
          const p = spawnProc(cmd, args, { detached: true, stdio: 'ignore' });
          p.unref();
          ok = true; break;
        } catch {}
      }
    }
  } catch {}
  res.json({ ok, command: fullCmd });
});

// Catch up: pull conversation that happened directly in an opened
// `claude --resume <cid>` terminal (the "⚡ Claude Code" button) into the web chat.
// Reads <cid>.jsonl bytes appended since the stored cursor, persists them as
// messages, and advances the cursor. Pull-on-demand — no live watcher.
app.post('/api/sessions/:id/catch-up', (req, res) => {
  const id = req.params.id;
  const session = stmts.getSession.get(id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const cid = sanitizeSessionId(session.claude_session_id);
  if (!cid) return res.status(400).json({ error: 'No Claude session ID' });
  // Don't race a live web turn — its own post-turn cursor sync would fight ours.
  if (isSessionLive(id)) {
    return res.status(409).json({ error: 'Session is busy — wait for the current reply to finish.' });
  }
  // First catch-up ever (cursor never set): baseline at the current EOF and import
  // nothing, so prior history already in SQLite is never re-imported as duplicates.
  if (session.transcript_offset == null) {
    const sz = transcriptSize(cid);
    try { db.prepare(`UPDATE sessions SET transcript_offset=? WHERE id=?`).run(sz == null ? 0 : sz, id); } catch {}
    return res.json({ ok: true, count: 0, baseline: true });
  }
  const r = catchUpFromTranscript({ cid, startOffset: Number(session.transcript_offset) || 0 });
  if (!r.found) return res.json({ ok: true, count: 0, note: 'no transcript on this host' });
  // Persist with each message's REAL transcript timestamp as created_at (not
  // datetime('now')): caught-up turns slot into history at the time they actually
  // happened, and multi-turn imports keep correct order — datetime('now') has 1s
  // resolution, so same-second ties would let the getMsgsLite "thinking-first"
  // tiebreaker reorder across turns. Monotonic fallback covers a missing/bad ts.
  const insertAt = db.prepare(`INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,reply_to_id,attachments,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const _tsBase = Date.now();
  const toSqliteTs = (iso, i) => {
    let d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) d = new Date(_tsBase + i);
    return d.toISOString().replace('T', ' ').replace('Z', '');
  };
  try {
    const persist = db.transaction((events, offset) => {
      events.forEach((e, i) => {
        insertAt.run(id, e.role, e.type, e.content, e.tool_name || null, null, null, null, toSqliteTs(e.ts, i));
      });
      db.prepare(`UPDATE sessions SET transcript_offset=?, updated_at=datetime('now') WHERE id=?`).run(offset, id);
    });
    persist(r.events, r.offset);
  } catch (e) {
    log.error('catch-up persist failed', { sessionId: id, err: e.message });
    return res.status(500).json({ error: 'Failed to persist caught-up messages' });
  }
  res.json({ ok: true, count: r.events.length });
});

// Paginated messages — GET /api/sessions/:id/messages?limit=50&offset=0
app.get('/api/sessions/:id/messages', (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const MAX_LIMIT = 200;
  const DEFAULT_LIMIT = 50;

  const rawLimit  = parseInt(req.query.limit,  10);
  const rawOffset = parseInt(req.query.offset, 10);

  const limit  = Number.isFinite(rawLimit)  && rawLimit  > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  const { total } = stmts.countMsgs.get(req.params.id);
  const messages  = stmts.getMsgsPaginated.all(req.params.id, limit, offset);

  res.json({
    messages,
    total,
    limit,
    offset,
    hasMore: offset + messages.length < total,
  });
});

// Config
app.get('/api/config', (_,res) => {
  _mergedConfigCache = null; // always fresh for the config UI — disk may have changed externally
  const c = loadMergedConfig();
  res.json(c);
});
app.post('/api/mcp/add', (req,res) => {
  const{id,label,description,type,command,args,env,url,headers}=req.body;
  // Validate id server-side (same rule as /api/mcp/import) — it lands unescaped
  // in inline onclick handlers in the MCP list, so reject anything but a safe
  // identifier to prevent stored JS injection (audit MEDIUM).
  if(!id||!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return res.status(400).json({error:'invalid_id'});
  const c=loadConfig();
  const entry={label:label||id,description:description||'',enabled:true,custom:true};
  if(type==='sse'||type==='http'){
    entry.type=type; entry.url=url||''; entry.headers=headers||{}; entry.env=env||{};
  } else {
    entry.command=command; entry.args=args||[]; entry.env=env||{};
  }
  c.mcpServers[id]=entry; saveConfig(c); res.json({ok:true});
});
app.put('/api/mcp/:id', (req,res) => {
  const c=loadConfig(); const id=req.params.id;
  const{env,headers,url,args,label,description,type,command}=req.body;
  if(!c.mcpServers[id]){
    const merged=loadMergedConfig();
    if(!merged.mcpServers[id]) return res.status(404).json({error:'Not found'});
    c.mcpServers[id]={...merged.mcpServers[id]};
  }
  if(label!==undefined) c.mcpServers[id].label=label;
  if(description!==undefined) c.mcpServers[id].description=description;
  if(type!==undefined) c.mcpServers[id].type=type;
  if(command!==undefined) c.mcpServers[id].command=command;
  if(env !== undefined) c.mcpServers[id].env=env;
  if(headers!==undefined) c.mcpServers[id].headers=headers;
  if(url!==undefined) c.mcpServers[id].url=url;
  if(args!==undefined) c.mcpServers[id].args=args;
  saveConfig(c); res.json({ok:true});
});
app.delete('/api/mcp/:id', (req,res) => { const c=loadConfig(); if(c.mcpServers[req.params.id]?.custom){delete c.mcpServers[req.params.id]; saveConfig(c)} res.json({ok:true}); });

app.post('/api/mcp/import', (req, res) => {
  const { servers, replace } = req.body;
  if (!servers || typeof servers !== 'object') return res.status(400).json({ error: 'Invalid servers object' });
  const c = loadConfig();
  if (!c.mcpServers) c.mcpServers = {};
  if (replace) {
    for (const id of Object.keys(c.mcpServers)) {
      if (c.mcpServers[id]?.custom) delete c.mcpServers[id];
    }
  }
  const ID_VALID = /^[a-zA-Z0-9_-]{1,64}$/;
  let imported = 0;
  for (const [id, m] of Object.entries(servers)) {
    if (!id || !ID_VALID.test(id) || typeof m !== 'object') continue;
    const entry = { label: m.label || id, description: m.description || '', enabled: true, custom: true };
    if (m.type === 'sse' || m.type === 'http' || m.url) {
      entry.type = m.type || 'http'; entry.url = m.url || ''; entry.headers = m.headers || {}; entry.env = m.env || {};
    } else {
      entry.command = m.command || ''; entry.args = m.args || []; entry.env = m.env || {};
    }
    c.mcpServers[id] = entry;
    imported++;
  }
  saveConfig(c);
  res.json({ ok: true, imported });
});

app.get('/api/mcp/export', (req, res) => {
  const c = loadMergedConfig();
  const mcpServers = {};
  for (const [id, m] of Object.entries(c.mcpServers || {})) {
    const entry = {};
    if (m.label && m.label !== id) entry.label = m.label;
    if (m.description) entry.description = m.description;
    if (m.type === 'sse' || m.type === 'http' || m.url) {
      entry.type = m.type || 'http'; entry.url = m.url || '';
      if (m.headers && Object.keys(m.headers).length) entry.headers = m.headers;
      if (m.env && Object.keys(m.env).length) entry.env = m.env;
    } else {
      entry.command = m.command || ''; entry.args = m.args || [];
      if (m.env && Object.keys(m.env).length) entry.env = m.env;
    }
    mcpServers[id] = entry;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="mcp-config.json"');
  res.json({ mcpServers });
});

const upload = multer({ dest: path.join(os.tmpdir(), 'skills-upload') });
app.post('/api/skills/upload', upload.single('file'), (req,res) => {
  if(!req.file) return res.status(400).json({error:'No file'});
  const name=req.body.name||path.parse(req.file.originalname).name;
  const id=name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const destFile=`skills/${id}.md`; fs.mkdirSync(SKILLS_DIR,{recursive:true}); fs.copyFileSync(req.file.path, path.join(APP_DIR,destFile)); fs.unlinkSync(req.file.path);
  const c=loadConfig(); c.skills[id]={label:req.body.label||`📄 ${name}`,description:req.body.description||'Custom',file:destFile,custom:true}; saveConfig(c); res.json({ok:true,id});
});
app.delete('/api/skills/:id', (req,res) => { const c=loadConfig(); const s=c.skills[req.params.id]; if(s?.custom){try{fs.unlinkSync(path.join(APP_DIR,s.file))}catch{} delete c.skills[req.params.id]; saveConfig(c)} res.json({ok:true}); });
// Raw skill text for client-side actions that need it outside the chat system prompt
// (e.g. pasting a skill into a terminal tab) — reuses the same cached read as buildSystemPrompt.
app.get('/api/skills/:id/content', (req, res) => {
  const s = loadConfig().skills[req.params.id];
  if (!s) return res.status(404).json({ error: 'skill not found' });
  res.json({ content: getSkillContent(resolveSkillFile(s.file)) });
});

// ============================================
// SLASH COMMANDS CRUD
// ============================================
app.post('/api/commands', (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'name and text required' });
  const c = loadConfig();
  if (!c.slashCommands) c.slashCommands = [];
  const id = Date.now().toString();
  const safeName = name.startsWith('/') ? name : '/' + name;
  c.slashCommands.push({ id, name: safeName, text });
  saveConfig(c);
  res.json({ ok: true, id });
});

app.put('/api/commands/:id', (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'name and text required' });
  const c = loadConfig();
  if (!c.slashCommands) c.slashCommands = [];
  const cmd = c.slashCommands.find(cmd => cmd.id === req.params.id);
  if (!cmd) return res.status(404).json({ error: 'Not found' });
  cmd.name = name.startsWith('/') ? name : '/' + name;
  cmd.text = text;
  saveConfig(c);
  res.json({ ok: true });
});

app.delete('/api/commands/:id', (req, res) => {
  const c = loadConfig();
  if (!c.slashCommands) c.slashCommands = [];
  c.slashCommands = c.slashCommands.filter(cmd => cmd.id !== req.params.id);
  saveConfig(c);
  res.json({ ok: true });
});

// ============================================
// FILE UPLOAD  (images / text / PDF)
// ============================================
const ALLOWED_MIME_RE  = /^(image\/|text\/|application\/pdf$)/;
const UPLOAD_MAX_AGE   = 60 * 60 * 1000;          // 1 h — files older than this are deleted
const UPLOAD_MAX_SIZE  = 20 * 1024 * 1024;         // 20 MB per file

const fileUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file,  cb) => {
    const id  = genId();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, id + ext);
  },
});

const fileUpload = multer({
  storage:    fileUploadStorage,
  limits:     { fileSize: UPLOAD_MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_RE.test(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error(`Unsupported MIME type: ${file.mimetype}`), { status: 415 }));
  },
});

/** Delete uploads older than UPLOAD_MAX_AGE */
function cleanOldUploads() {
  try {
    const cutoff = Date.now() - UPLOAD_MAX_AGE;
    for (const name of fs.readdirSync(UPLOADS_DIR)) {
      const fp = path.join(UPLOADS_DIR, name);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
    }
  } catch {}
}
cleanOldUploads();                             // run once on startup
setInterval(cleanOldUploads, 30 * 60 * 1000); // then every 30 min

// Database maintenance: sessions cleanup + WAL checkpoint
runDatabaseMaintenance();                                            // run once on startup
setInterval(runDatabaseMaintenance, CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000); // every N hours

app.post('/api/upload', fileUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  try {
    const data   = fs.readFileSync(req.file.path);
    const base64 = data.toString('base64');
    const id     = path.parse(req.file.filename).name;
    res.json({
      id,
      name:   req.file.originalname,
      type:   req.file.mimetype,
      size:   req.file.size,
      base64,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Multer MIME-filter errors → 415
app.use((err, _req, res, next) => {
  if (err?.status === 415) return res.status(415).json({ error: err.message });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${UPLOAD_MAX_SIZE / 1024 / 1024} MB)` });
  next(err);
});

// Config files editor
app.get('/api/config-files', (_,res) => {
  const files={};
  try{files['config.json']=fs.readFileSync(CONFIG_PATH,'utf-8')}catch{files['config.json']='{}'}
  try{files['CLAUDE.md']=fs.readFileSync(path.join(WORKDIR,'CLAUDE.md'),'utf-8')}catch{files['CLAUDE.md']=''}
  try{files['.claude/settings.json']=fs.readFileSync(path.join(os.homedir(),'.claude','settings.json'),'utf-8')}catch{files['.claude/settings.json']='{}'}
  try{files['.env']=fs.readFileSync(path.join(APP_DIR,'.env'),'utf-8')}catch{files['.env']=''}
  res.json(files);
});
app.put('/api/config-files', (req,res) => {
  const{filename,content}=req.body;
  const allowed={'config.json':CONFIG_PATH,'CLAUDE.md':path.join(WORKDIR,'CLAUDE.md'),'.claude/settings.json':path.join(os.homedir(),'.claude','settings.json'),'.env':path.join(APP_DIR,'.env')};
  const target=allowed[filename]; if(!target) return res.status(400).json({error:'Unknown'});
  try{
    const dir=path.dirname(target); if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    if(filename==='config.json'){
      // Validate + atomic write, then invalidate the merged-config / skill / prompt
      // caches — otherwise edits made through the UI don't reach chats until a
      // GET /api/config happens to force a fresh read.
      let parsed; try{ parsed=JSON.parse(content); }catch{ return res.status(400).json({error:'Invalid JSON'}); }
      saveConfig(parsed);
    } else {
      const tmp=target+'.tmp'; fs.writeFileSync(tmp,content,'utf-8'); fs.renameSync(tmp,target);
    }
    res.json({ok:true});
  }
  catch(e){res.status(500).json({error:e.message})}
});

// CLAUDE.md editor — global (~/.claude/CLAUDE.md) + local (WORKDIR/CLAUDE.md)
const GLOBAL_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const LOCAL_CLAUDE_MD  = path.join(WORKDIR, 'CLAUDE.md');

app.get('/api/claude-md', (req,res) => {
  if (req.query.dir && !isPathAllowed(req.query.dir)) return res.status(403).json({ error: 'path not allowed' });
  const localDir = req.query.dir ? path.resolve(req.query.dir) : null;
  const localMd  = localDir ? path.join(localDir, 'CLAUDE.md') : LOCAL_CLAUDE_MD;
  const result = { global: '', local: '', globalPath: GLOBAL_CLAUDE_MD, localPath: localMd };
  try { result.global = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf-8'); } catch {}
  try { result.local  = fs.readFileSync(localMd, 'utf-8'); } catch {}
  res.json(result);
});

app.post('/api/claude-md', (req,res) => {
  const { type, content, dir } = req.body;
  if (!['global','local'].includes(type))
    return res.status(400).json({ error: 'type must be "global" or "local"' });
  if (type === 'local' && dir && !isPathAllowed(dir)) return res.status(403).json({ error: 'path not allowed' });
  const localMd = dir ? path.join(path.resolve(dir), 'CLAUDE.md') : LOCAL_CLAUDE_MD;
  const target  = type === 'global' ? GLOBAL_CLAUDE_MD : localMd;
  try {
    const d = path.dirname(target);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(target, content ?? '', 'utf-8');
    res.json({ ok: true, path: target });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Files browser
// Resolve the effective workspace for /api/files and /api/files/download.
// Priority: ?workdir= query param (must match a registered project) → global WORKDIR.
// Returns null if workdir is unknown, or { workdir, isRemote } object.
function resolveFilesWorkdir(reqWorkdir) {
  if (reqWorkdir) {
    const projects = loadProjects();
    const match = projects.find(p => path.resolve(p.workdir) === path.resolve(reqWorkdir));
    if (match) return { workdir: path.resolve(match.workdir), isRemote: !!match.isRemote };
    return null; // not a registered project — deny
  }
  return { workdir: path.resolve(WORKDIR), isRemote: false };
}

app.get('/api/files', (req,res) => {
  const dir=req.query.path||'';
  const resolved = resolveFilesWorkdir(req.query.workdir);
  if (!resolved) return res.status(403).json({error:'Workdir not in registered projects'});
  if (resolved.isRemote) return res.json({type:'remote'}); // remote FS can't be browsed locally
  const workdirReal = resolved.workdir;
  const fp=path.resolve(workdirReal,dir);
  if(fp!==workdirReal && !fp.startsWith(workdirReal+path.sep)) return res.status(403).json({error:'Denied'});
  try{
    const stat=fs.statSync(fp);
    if(stat.isDirectory()){
      const items=fs.readdirSync(fp,{withFileTypes:true}).filter(d=>!d.name.startsWith('.'))
        .map(d=>({name:d.name,type:d.isDirectory()?'dir':'file',path:path.join(dir,d.name),size:d.isFile()?fs.statSync(path.join(fp,d.name)).size:null}));
      res.json({type:'dir',items,workdir:workdirReal});
    } else {
      const ext=path.extname(fp).toLowerCase();
      const te=['.js','.ts','.py','.html','.css','.json','.md','.txt','.yaml','.yml','.sh','.env','.toml','.sql','.jsx','.tsx','.pine','.cfg','.log','.mjs','.go','.rs','.rb','.php'];
      // Hard size cap regardless of extension: a multi-GB .log/.json would otherwise be
      // read fully into memory and ERR_STRING_TOO_LONG surfaces as a misleading 404.
      const MAX_PREVIEW = 2 * 1024 * 1024; // 2 MB
      const content = stat.size > MAX_PREVIEW ? '[File too large to preview (>2 MB)]'
        : (te.includes(ext)||stat.size<512*1024) ? fs.readFileSync(fp,'utf-8') : '[Binary]';
      res.json({type:'file',name:path.basename(fp),content,ext,workdir:workdirReal});
    }
  }catch{res.status(404).json({error:'Not found'})}
});

app.get('/api/files/download', (req,res) => {
  const fp_rel = req.query.path || '';
  const resolved = resolveFilesWorkdir(req.query.workdir);
  if (!resolved) return res.status(403).json({error:'Workdir not in registered projects'});
  if (resolved.isRemote) return res.status(400).json({error:'File download not available for remote projects'});
  const workdirReal = resolved.workdir;
  const fp = path.resolve(workdirReal, fp_rel);
  if (fp !== workdirReal && !fp.startsWith(workdirReal + path.sep)) return res.status(403).json({error:'Denied'});
  try {
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) return res.status(400).json({error:'Cannot download a directory'});
    const _dlFilename = path.basename(fp).replace(/[^\w.\-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${_dlFilename}"`);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(fp).pipe(res);
  } catch { res.status(404).json({error:'Not found'}); }
});

app.get('/api/files/raw', (req, res) => {
  const fp_rel = req.query.path || '';
  const resolved = resolveFilesWorkdir(req.query.workdir);
  if (!resolved) return res.status(403).json({error:'Workdir not in registered projects'});
  if (resolved.isRemote) return res.status(400).json({error:'Raw file access not available for remote projects'});
  const workdirReal = resolved.workdir;
  const fp = path.resolve(workdirReal, fp_rel);
  if (fp !== workdirReal && !fp.startsWith(workdirReal + path.sep)) return res.status(403).json({error:'Denied'});
  try {
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) return res.status(400).json({error:'Cannot serve directory'});
    const ext = path.extname(fp).toLowerCase();
    const mimeMap = {
      '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
      '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml',
      '.pdf':'application/pdf',
      '.mp4':'video/mp4', '.webm':'video/webm', '.ogg':'video/ogg',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(fp).pipe(res);
  } catch { res.status(404).json({error:'Not found'}); }
});

// ─── Project file search (for @ mention) ────────────────────────────────────
const TEXT_EXTS = new Set(['.js','.ts','.jsx','.tsx','.mjs','.cjs','.py','.rb','.go','.rs','.php','.java','.kt','.swift','.cs','.cpp','.c','.h','.html','.css','.scss','.less','.json','.yaml','.yml','.toml','.ini','.cfg','.env','.md','.txt','.sh','.bash','.zsh','.sql','.graphql','.xml','.vue','.svelte','.lock','.log','.pine','.r','.jl']);
const SKIP_DIRS  = new Set(['node_modules','.git','.next','.nuxt','__pycache__','dist','build','.cache','vendor','venv','.venv','.svn','.hg']);
const MAX_FILE_SIZE = 512 * 1024; // 512 KB

function searchProjectFiles(rootDir, query, maxResults = 80) {
  const results = [];
  const qLow = (query || '').toLowerCase();
  function walk(dir, depth) {
    if (depth > 6 || results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!TEXT_EXTS.has(ext)) continue;
        const relPath = path.relative(rootDir, path.join(dir, e.name));
        if (!qLow || relPath.toLowerCase().includes(qLow) || e.name.toLowerCase().includes(qLow)) {
          results.push({ name: e.name, relPath, absPath: path.join(dir, e.name) });
        }
      }
    }
  }
  walk(rootDir, 0);
  // Sort: exact name matches first, then by path length
  if (qLow) results.sort((a, b) => {
    const aName = a.name.toLowerCase().startsWith(qLow) ? 0 : 1;
    const bName = b.name.toLowerCase().startsWith(qLow) ? 0 : 1;
    return aName - bName || a.relPath.length - b.relPath.length;
  });
  return results;
}

app.get('/api/project-files', (req, res) => {
  const { dir, q } = req.query;
  if (!dir) return res.status(400).json({ error: 'dir required' });
  const absDir = path.resolve(dir);
  // Security: dir must be one of the registered project workdirs
  const projects = loadProjects();
  const allowed = projects.some(p => {
    const pd = path.resolve(p.workdir);
    return absDir === pd || absDir.startsWith(pd + path.sep);
  });
  if (!allowed) return res.status(403).json({ error: 'Dir not in any registered project' });
  if (!fs.existsSync(absDir)) return res.status(404).json({ error: 'Not found' });
  const files = searchProjectFiles(absDir, q || '');
  res.json({ files });
});

app.get('/api/project-files/read', (req, res) => {
  const { path: filePath, dir } = req.query;
  if (!filePath || !dir) return res.status(400).json({ error: 'path and dir required' });
  const absFile = path.resolve(filePath);
  const absDir  = path.resolve(dir);
  // Security: file must be inside the project dir
  if (!absFile.startsWith(absDir + path.sep) && absFile !== absDir) {
    return res.status(403).json({ error: 'Path outside project dir' });
  }
  const projects = loadProjects();
  const allowed = projects.some(p => {
    const pd = path.resolve(p.workdir);
    return absDir === pd || absDir.startsWith(pd + path.sep);
  });
  if (!allowed) return res.status(403).json({ error: 'Dir not in any registered project' });
  try {
    const stat = fs.statSync(absFile);
    if (stat.size > MAX_FILE_SIZE) return res.status(413).json({ error: 'File too large (max 512 KB)' });
    const content = fs.readFileSync(absFile, 'utf-8');
    res.json({ content, name: path.basename(absFile), path: absFile });
  } catch (e) { res.status(404).json({ error: 'Not found' }); }
});

// Projects CRUD
// The stored SSH password is used only server-side (claude-ssh.js). The UI edits
// credentials through /api/remote-hosts, which masks them as '***' — so this list
// has no reason to carry the secret at all, encrypted or not.
app.get('/api/projects', (_,res) => res.json(loadProjects().map(({ password, ...rest }) => rest)));

app.post('/api/projects', (req,res) => {
  const { name, workdir, gitInit, isRemote=false, remoteHostId='', remoteWorkdir='', sshKeyPath='', port=22 } = req.body;
  if (!name || !workdir) return res.status(400).json({ error:'name and workdir required' });
  try {
    const actions = [];
    if (isRemote) {
      // Remote project: workdir is the path on the remote server — don't create locally
      const hosts = loadRemoteHosts();
      const rh = hosts.find(h => h.id === remoteHostId);
      if (!rh) return res.status(400).json({ error:'Remote host not found. Add a host first.' });
      const projects = loadProjects();
      const existing = projects.find(p => p.workdir === workdir && p.remoteHostId === remoteHostId);
      if (existing) { existing.name = name; saveProjects(projects); return res.json({ ok:true, id:existing.id, actions, updated:true }); }
      const id = 'proj-' + genId();
      projects.push({ id, name, workdir, isRemote:true, remoteHostId, remoteHost: rh.host, sshKeyPath: rh.sshKeyPath||'', password: rh.password||'', port: rh.port||Number(port)||22, createdAt:new Date().toISOString() });
      saveProjects(projects);
      return res.json({ ok:true, id, actions });
    }
    // Local project (existing behavior)
    // Checked here too, and not only in /api/project/init: a registered workdir
    // becomes an allowed root for isPathAllowed, so an unchecked create would let
    // one request widen the allowlist to anywhere and disable every other check.
    if (!isPathAllowed(workdir)) return res.status(403).json({ error: 'path not allowed' });
    if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive:true });
    if (gitInit && !fs.existsSync(path.join(workdir,'.git'))) {
      try { execSync('git init', { cwd:workdir, stdio:'pipe' }); actions.push('git init'); }
      catch(e) { return res.json({ ok:true, id:null, actions, gitError:(e.stderr?.toString()||e.message).trim() }); }
    }
    const projects = loadProjects();
    const existing = projects.find(p => p.workdir === workdir);
    if (existing) { existing.name = name; saveProjects(projects); return res.json({ ok:true, id:existing.id, actions, updated:true }); }
    const id = 'proj-' + genId();
    projects.push({ id, name, workdir, createdAt:new Date().toISOString() });
    saveProjects(projects);
    res.json({ ok:true, id, actions });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/projects/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'no ids' });
  const all = loadProjects();
  const byId = Object.fromEntries(all.map(p => [p.id, p]));
  const ordered = ids.map(id => byId[id]).filter(Boolean);
  const inSet = new Set(ids);
  all.filter(p => !inSet.has(p.id)).forEach(p => ordered.push(p));
  saveProjects(ordered);
  res.json({ ok: true });
});
app.patch('/api/projects/:id', (req,res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error:'name required' });
  const projects = loadProjects();
  const p = projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error:'not found' });
  p.name = name.trim();
  saveProjects(projects);
  res.json({ ok:true });
});

app.delete('/api/projects/:id', (req,res) => {
  saveProjects(loadProjects().filter(p => p.id !== req.params.id));
  res.json({ ok:true });
});

// ─── Remote SSH Hosts CRUD ────────────────────────────────────────────────────
app.get('/api/remote-hosts', (_,res) => res.json(
  loadRemoteHosts().map(h => ({ ...h, password: h.password ? '***' : '' }))
));

app.post('/api/remote-hosts', (req,res) => {
  const { label, host, port=22, sshKeyPath='', password='' } = req.body;
  if (!label || !host) return res.status(400).json({ error:'label and host required' });
  const hosts = loadRemoteHosts();
  const id = 'rh-' + genId();
  const entry = { id, label, host, port: Number(port)||22, sshKeyPath: sshKeyPath||'', password: encryptPassword(password||''), createdAt: new Date().toISOString() };
  hosts.push(entry);
  saveRemoteHosts(hosts);
  // Don't expose password in response
  res.json({ ok:true, id, host: { ...entry, password: entry.password ? '***' : '' } });
});

app.put('/api/remote-hosts/:id', (req,res) => {
  const { label, host, port=22, sshKeyPath='', password } = req.body;
  const hosts = loadRemoteHosts();
  const idx = hosts.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:'Not found' });
  // If password not sent (undefined), keep existing encrypted value; if sent, encrypt the new value
  const newPassword = password === undefined ? (hosts[idx].password || '') : encryptPassword(password || '');
  hosts[idx] = { ...hosts[idx], label, host, port: Number(port)||22, sshKeyPath: sshKeyPath||'', password: newPassword };
  saveRemoteHosts(hosts);
  res.json({ ok:true, host: { ...hosts[idx], password: hosts[idx].password ? '***' : '' } });
});

app.delete('/api/remote-hosts/:id', (req,res) => {
  saveRemoteHosts(loadRemoteHosts().filter(h => h.id !== req.params.id));
  res.json({ ok:true });
});

// Test SSH connection — for new (unsaved) host (must be before /:id/test)
app.post('/api/remote-hosts/test-new', async (req,res) => {
  const { host, port=22, sshKeyPath='', password='' } = req.body;
  if (!host) return res.status(400).json({ error:'host required' });
  try {
    const result = await testSshConnection({ host, port: Number(port)||22, sshKeyPath, password });
    res.json({ ok:true, message:'Connection successful', latencyMs: result.latencyMs });
  } catch(e) { res.status(400).json({ error: e.message||'Connection failed' }); }
});

// Test SSH connection — for saved host
app.post('/api/remote-hosts/:id/test', async (req,res) => {
  const hosts = loadRemoteHosts();
  const rh = hosts.find(h => h.id === req.params.id);
  if (!rh) return res.status(404).json({ error:'Host not found' });
  try {
    const result = await testSshConnection({ host: rh.host, port: rh.port||22, sshKeyPath: rh.sshKeyPath||'', password: decryptPassword(rh.password)||'' });
    res.json({ ok:true, message:'Connection successful', latencyMs: result.latencyMs });
  } catch(e) { res.status(400).json({ error: e.message||'Connection failed' }); }
});

// Directory browser — lists directories under an allowed root (see isPathAllowed)
app.get('/api/browse-dirs', (req, res) => {
  // Windows: show drive list when explicitly requested OR when no path given (initial open)
  if (process.platform === 'win32' && (!req.query.path || req.query.path === '__drives__')) {
    const drives = [];
    for (let i = 65; i <= 90; i++) { // A–Z
      const drive = String.fromCharCode(i) + ':\\';
      try { fs.accessSync(drive); drives.push({ name: String.fromCharCode(i) + ':', path: drive, hidden: false }); } catch {}
    }
    return res.json({ path: '__drives__', parent: null, items: drives });
  }
  const dir = path.resolve(req.query.path || os.homedir());
  if (!isPathAllowed(dir)) return res.status(403).json({ error: 'path not allowed' });
  try {
    if (!fs.statSync(dir).isDirectory()) return res.status(400).json({ error: 'Not a directory' });
    const raw = fs.readdirSync(dir, { withFileTypes: true });
    const items = raw
      .filter(d => d.isDirectory())
      .sort((a, b) => {
        const ah = a.name.startsWith('.'), bh = b.name.startsWith('.');
        if (ah !== bh) return ah ? 1 : -1; // hidden dirs last
        return a.name.localeCompare(b.name);
      })
      .map(d => ({ name: d.name, path: path.join(dir, d.name), hidden: d.name.startsWith('.') }));
    // On Windows, drive roots have dirname === self; use '__drives__' as virtual parent
    let parent = path.dirname(dir) !== dir ? path.dirname(dir) : null;
    if (process.platform === 'win32' && parent === null) parent = '__drives__';
    res.json({ path: dir, parent, items });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Initialize project directory (create dir + optional git init)
app.post('/api/project/init', (req, res) => {
  const { workdir, gitInit } = req.body;
  if (!workdir) return res.status(400).json({ error: 'workdir required' });
  if (!isPathAllowed(workdir)) return res.status(403).json({ error: 'path not allowed' });
  try {
    if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive: true });
    const actions = [];
    if (gitInit && !fs.existsSync(path.join(workdir, '.git'))) {
      try {
        execSync('git init', { cwd: workdir, stdio: 'pipe' });
        actions.push('git init');
      } catch(e) { return res.json({ ok: true, actions, gitError: (e.stderr?.toString()||e.message).trim() }); }
    }
    res.json({ ok: true, actions });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// TUNNEL MANAGER
// ============================================
let tunnelManager = null;

function initTunnelManager() {
  if (process.env.CCS_DESKTOP === '1') { log.info('[desktop] tunnel disabled'); return; }
  tunnelManager = new TunnelManager({ log, port: PORT });

  tunnelManager.on('url', (url) => {
    // Notify all WebSocket clients
    wss.clients.forEach(ws => {
      try { ws.send(JSON.stringify({ type: 'tunnel_url', url })); } catch {}
    });
    // Notify all paired Telegram devices
    if (telegramBot?.isRunning()) {
      telegramBot.notifyTunnelUrl(url).catch(e => log.error('[tunnel] notifyTunnelUrl failed:', e.message));
    }
  });

  tunnelManager.on('close', (reason) => {
    wss.clients.forEach(ws => {
      try { ws.send(JSON.stringify({ type: 'tunnel_closed', reason })); } catch {}
    });
    if (telegramBot?.isRunning()) {
      telegramBot.notifyTunnelClosed().catch(e => log.error('[tunnel] notifyTunnelClosed failed:', e.message));
    }
  });
}

// ============================================
// TELEGRAM BOT
// ============================================
let telegramBot = null;

// Helper: clean up Telegram ask_user state when answered from elsewhere (web UI)
function _clearTelegramAskState(sessionId) {
  if (!telegramBot) return;
  const task = activeTasks.get(sessionId);
  if (task?.userId) {
    const ctx = telegramBot.getContext(task.userId);
    if (ctx.state === 'AWAITING_ASK_RESPONSE') {
      ctx.state = 'IDLE';
      ctx.stateData = null;
    }
  }
}

// ─── Process a chat message from Telegram ────────────────────────────────────
// Reuses the same core logic as processChat but without WebSocket dependency.
async function processTelegramChat({ sessionId, text, userId, chatId, threadId, attachments }) {
  if (!telegramBot) return;

  // Check if session is busy — queue as interrupt instead of dropping the message.
  // isSessionLive() covers both web and Telegram chat workers (activeTasks) AND the
  // early phase of web processChat before activeTasks.set() is called.
  // This check must fire for EVERY engine, remote included: skipping it for remote
  // sessions used to let a second message dispatch a fully parallel run against the
  // SAME sessionId — two overlapping `activeTasks.set()`/`chatBuffers.set()` calls
  // stomping on each other, and two `claude --resume` processes racing to write the
  // same claude_session_id. A remote (SSH) session still cannot receive an interrupt
  // MID-run — the hook script's callback URL is 127.0.0.1, unreachable from the
  // remote host — so a queued message there is not delivered until the run in
  // progress finishes, at which point the `finally` block below runs it as the next
  // message rather than discarding it.
  if (isSessionLive(sessionId)) {
    // Queue as interrupt (same mechanism as web UI mid-task clarifications)
    if (!pendingInterrupts.has(sessionId)) pendingInterrupts.set(sessionId, []);
    const queue = pendingInterrupts.get(sessionId);
    if (queue.length >= 10) {
      const opts = threadId ? { message_thread_id: threadId } : {};
      await telegramBot.sendMessage(chatId, '⚠️ Interrupt queue full (max 10). Wait for completion or use /stop.', opts);
      return;
    }
    const interruptId = ++_interruptIdCounter;
    const savedAttachments = saveInterruptAttachments(attachments, sessionId, interruptId);

    let dbId = null;
    const attJson = attachments?.length ? JSON.stringify(serializeMessageAttachments(attachments)) : null;
    try { const info = stmts.addMsg.run(sessionId, 'user', 'interrupt', text, null, null, null, attJson); dbId = Number(info.lastInsertRowid); } catch {}

    queue.push({
      id: interruptId,
      content: text,
      attachments: savedAttachments.length ? savedAttachments : undefined,
      createdAt: new Date().toISOString(),
      dbId,
    });

    // Notify all watchers about the queued interrupt
    const task = activeTasks.get(sessionId);
    if (task?.proxy) {
      try { task.proxy.send(JSON.stringify({ type: 'interrupt_queued', interruptId, tabId: sessionId, text })); } catch {}
    }
    broadcastToSession(sessionId, { type: 'interrupt_queued', interruptId, tabId: sessionId, text });

    const attachNote = savedAttachments.length > 0 ? ` (+${savedAttachments.length} file${savedAttachments.length > 1 ? 's' : ''})` : '';
    const confirmMsg = `✉️ Clarification queued${attachNote}. Claude will see it at the next checkpoint.`;
    const opts = threadId ? { message_thread_id: threadId } : {};
    await telegramBot.sendMessage(chatId, confirmMsg, opts);

    log.info('[interrupt] queued from telegram', { sessionId, interruptId, textLen: text.length, attachments: savedAttachments.length });
    return;
  }

  // Load session from DB
  const session = stmts.getSession.get(sessionId);
  if (!session) {
    // Explicit threadId, not the bot's mutable `_currentThreadId` — this runs after
    // an await, by which point a concurrently-processed update from a DIFFERENT
    // topic may already have overwritten that field, misdelivering this notice.
    await telegramBot.sendMessage(chatId, '❌ Session not found.', threadId ? { message_thread_id: threadId } : {});
    return;
  }

  const proxy = telegramBot.createResponseHandler({ userId, chatId, sessionId, threadId, broadcastToSession });
  const abortController = new AbortController();

  activeTasks.set(sessionId, {
    proxy,
    abortController,
    source: 'telegram',
    userId,
    chatId,
    startedAt: Date.now()
  });
  markActivityDirty();
  chatBuffers.set(sessionId, '');

  try {
    // Build user content (with attachments if any)
    const userContent = buildUserContent(text, attachments || []);
    const attJson = attachments?.length ? JSON.stringify(serializeMessageAttachments(attachments)) : null;

    // Store user message in DB (marked as telegram source)
    stmts.addTelegramMsg.run(sessionId, 'user', 'text', typeof userContent === 'string' ? userContent : text, null, null, null, attJson);

    // Broadcast user message to web UI watchers (so web chat updates in real-time)
    broadcastToSession(sessionId, {
      type: 'task_started',
      prompt: typeof userContent === 'string' ? userContent : text,
      source: 'telegram',
      tabId: sessionId,
    });

    // Load session config
    const model = session.model || 'sonnet';
    const mode = session.mode || 'auto';
    const workdir = session.workdir || WORKDIR;

    // The web UI branches on agent_mode === 'multi' (routes to runMultiAgent, warns
    // on the subscription engine); Telegram did neither — a session left in multi
    // mode from the web UI just silently ran as a single agent here with no signal
    // that the orchestrator/subtask plan it would normally get was skipped.
    if (session.agent_mode === 'multi') {
      try {
        await telegramBot.sendMessage(chatId,
          'ℹ️ This chat is set to multi-agent mode, which Telegram cannot run yet — answering as a single agent instead.',
          threadId ? { message_thread_id: threadId } : {});
      } catch {}
    }

    // Parse active MCP and skills
    let mcpIds = [];
    let skillIds = [];
    try { mcpIds = JSON.parse(session.active_mcp || '[]'); } catch(e) {}
    try { skillIds = JSON.parse(session.active_skills || '[]'); } catch(e) {}

    // Build system prompt from skills (same logic as processChat)
    const config = loadMergedConfig();
    const systemPrompt = buildSystemPrompt(skillIds, config);

    // Build MCP servers map
    const mcpServers = {};
    for (const mid of mcpIds) {
      const m = config.mcpServers[mid];
      if (!m) continue;
      if (m.type === 'http' || m.type === 'sse' || m.url) {
        mcpServers[mid] = { type: m.type || 'http', url: m.url, ...(m.headers ? { headers: m.headers } : {}), ...(m.env ? { env: expandTildeInObj(m.env) } : {}) };
      } else {
        mcpServers[mid] = { command: m.command, args: m.args || [], env: expandTildeInObj(m.env || {}) };
      }
    }

    // Internal MCPs (always injected)
    mcpServers['_ccs_ask_user'] = {
      command: NODE_CMD,
      args: [path.join(__dirname, 'mcp-ask-user.js')],
      env: {
        ASK_USER_SERVER_URL: `http://127.0.0.1:${PORT}`,
        ASK_USER_SESSION_ID: sessionId,
        ASK_USER_SECRET: ASK_USER_SECRET,
      },
    };
    mcpServers['_ccs_notify'] = {
      command: NODE_CMD,
      args: [path.join(__dirname, 'mcp-notify.js')],
      env: {
        NOTIFY_SERVER_URL: `http://127.0.0.1:${PORT}`,
        NOTIFY_SESSION_ID: sessionId,
        NOTIFY_SECRET: NOTIFY_SECRET,
      },
    };
    mcpServers['_ccs_set_ui_state'] = {
      command: NODE_CMD,
      args: [path.join(__dirname, 'mcp-set-ui-state.js')],
      env: {
        SET_UI_STATE_SERVER_URL: `http://127.0.0.1:${PORT}`,
        SET_UI_STATE_SESSION_ID: sessionId,
        SET_UI_STATE_SECRET: SET_UI_STATE_SECRET,
      },
    };
    mcpServers['_ccs_user_interrupt'] = {
      command: NODE_CMD,
      args: [path.join(__dirname, 'mcp-user-interrupt.js')],
      env: {
        INTERRUPT_SERVER_URL: `http://127.0.0.1:${PORT}`,
        INTERRUPT_SESSION_ID: sessionId,
        INTERRUPT_SECRET: INTERRUPT_SECRET,
      },
    };

    // Save last user msg for reconnect recovery
    stmts.setLastUserMsg.run(text, sessionId);

    // Send visible "Processing..." indicator (deleted when first content arrives or on finalize)
    await proxy.startThinking();

    // ── Bot mentions from Telegram ──────────────────────────────────────────
    // Resolved against every handle so a bot that exists in another project gets a
    // useful answer instead of silence, same as the web path.
    let tgBots = [], tgProjectBots = [], tgPrompt = text;
    try {
      const allBots = stmts.listBots.all();
      if (allBots.length) {
        const wd = session?.workdir || WORKDIR;
        const proj = loadProjects().find(pr => pr.workdir === wd);
        tgProjectBots = proj ? stmts.listProjectBots.all(proj.id) : [];
        const available = new Set(tgProjectBots.map(b => b.id));
        const parsed = botsLogic.parseMentions(text || '', allBots.map(b => b.id));
        if (parsed.handles.length || parsed.unknown.length) {
          tgPrompt = parsed.cleaned || BARE_MENTION_PROMPT;
          const byId = new Map(allBots.map(b => [b.id, b]));
          tgBots = parsed.handles.filter(h => available.has(h)).map(h => byId.get(h));
          const notes = [
            ...parsed.handles.filter(h => !available.has(h))
              .map(h => `ℹ️ @@${h} (${byId.get(h)?.label || h}) is not in this project.`),
            ...parsed.unknown.map(h => `ℹ️ There is no bot @@${h}.`),
          ];
          for (const n of notes) {
            try { await telegramBot.sendMessage(chatId, n, threadId ? { message_thread_id: threadId } : {}); } catch {}
          }
        }
      }
    } catch (e) { log.warn('telegram bot mention resolution failed', { err: e.message }); }

    // A SEPARATE content-blocks build from `tgPrompt` (mention-stripped), not the
    // `userContent` built above from raw `text` — that one is for DB/broadcast
    // display, where showing the mention verbatim is correct. Dispatching it to the
    // CLI as well used to duplicate the message: claude-cli.js only drops an
    // attachment's trailing text block when it exactly equals the top-level
    // `prompt`, and raw-with-mention never equals cleaned, so the mention text came
    // back as a "prefix" ahead of the cleaned prompt.
    const dispatchUserContent = buildUserContent(tgPrompt, attachments || []);

    const params = {
      // Defaults to `text` unchanged when there was no mention; becomes the
      // mention-stripped/bare-mention-fallback text otherwise. Using raw `text` here
      // unconditionally used to leave a leftover "@@unknownbot" token in the prompt
      // whenever every mentioned handle turned out unknown/unavailable and the run
      // fell through to the plain single-agent path below instead of a bot.
      prompt: tgPrompt,
      userContent: dispatchUserContent,
      systemPrompt,
      mcpServers,
      model,
      maxTurns: 30,
      ws: proxy,
      sessionId,
      abortController,
      claudeSessionId: sanitizeSessionId(session.claude_session_id) || undefined,
      mode,
      workdir,
      tabId: sessionId,
    };

    // Check if the active project is a remote SSH project
    const _activeProj = loadProjects().find(p => p.workdir === workdir && p.isRemote);
    const _isSubscriptionEngine = (session.run_engine || 'api') === 'subscription';
    if (tgBots.length && (_activeProj || _isSubscriptionEngine)) {
      // Bots run through the headless `api` engine only (runBotTurns spawns its own
      // ClaudeCLI per bot) — SSH and subscription/tmux sessions silently ran the
      // mention as a normal single-agent turn with no bot involved and no word to
      // the user about why. Say so explicitly instead.
      try {
        await telegramBot.sendMessage(chatId,
          `ℹ️ Bots aren't available on this chat's engine (${_activeProj ? 'SSH' : 'subscription'}) — answering as the regular assistant instead. Switch this chat to the API engine to use @@mentions.`,
          threadId ? { message_thread_id: threadId } : {});
      } catch {}
    }
    if (_activeProj) {
      await runSshSingle({
        ...params,
        remoteHost:    _activeProj.remoteHost,
        remoteWorkdir: _activeProj.workdir,
        sshKeyPath:    _activeProj.sshKeyPath || '',
        password:      decryptPassword(_activeProj.password) || '',
        port:          _activeProj.port || 22,
      });
    } else if (_isSubscriptionEngine) {
      // Respect the chat's billing engine choice from Telegram too — interactive
      // module collects output without touching SQLite, so persist it here
      // (mirrors the WS chat handler's subscription branch).
      const r = await runInteractiveSingle({
        ...params,
        // Matches the web WS handler's subscription branch (server.js ~7927):
        // without a drain function, a clarification typed into a busy Telegram
        // chat on this engine sat in pendingInterrupts and was NEVER delivered —
        // this engine has no hook to pull it mid-run, only this explicit drain call.
        drainInterrupts: () => {
          const msgs = pendingInterrupts.get(sessionId) || [];
          if (msgs.length) pendingInterrupts.delete(sessionId);
          for (const m of msgs) { try { if (m.dbId) stmts.markInterruptDelivered.run(m.dbId); } catch {} }
          return msgs;
        },
      });
      for (const ev of r.toolEvents) {
        try { stmts.addMsg.run(sessionId,'assistant','tool',(ev.input||'').substring(0,500),ev.name,null,null,null); } catch {}
      }
      if (r.fullThinking) { try { stmts.addMsg.run(sessionId,'assistant','thinking',r.fullThinking,null,null,null,null); } catch {} }
      if (r.fullText) {
        try { stmts.addMsg.run(sessionId,'assistant','text',r.fullText,null,null,null,null); } catch {}
        const _cb = (chatBuffers.get(sessionId) || '') + r.fullText;
        chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb);
      }
      if (r.cid) { try { stmts.updateClaudeId.run(r.cid, sessionId); } catch {} }
    } else if (tgBots.length) {
      // Mentions work from Telegram exactly as they do in the chat: same parser, same
      // sequential dispatch, same per-bot session. The reply carries a header per bot
      // so a phone screen still shows who said what. `params` already carries the
      // mention-stripped prompt/content built above.
      proxy._botsById = Object.fromEntries(tgProjectBots.map(b => [b.id, b]));
      await runBotTurns(params, { bots: tgBots, prompt: tgPrompt, rosterBots: tgProjectBots });
    } else {
      await runCliSingle(params);
    }

    const _taskStart = activeTasks.get(sessionId)?.startedAt;
    proxy.send(JSON.stringify({ type: 'done', tabId: sessionId, duration: _taskStart ? Date.now() - _taskStart : 0 }));
  } catch (err) {
    log.error('[processTelegramChat] Error', { message: err.message, name: err.name, stack: err.stack });
    proxy.send(JSON.stringify({ type: 'error', error: err.message, tabId: sessionId }));
  } finally {
    activeTasks.delete(sessionId);
    markActivityDirty();
    chatBuffers.delete(sessionId);
    // Clean up pending ask_user questions for this session
    for (const [rid, entry] of pendingAskUser) {
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timer);
        pendingAskUser.delete(rid);
        entry.resolve({ answer: '[Session ended]' });
      }
    }
    // Clean up pending ask_user state on Telegram bot context
    if (userId && telegramBot) {
      const ctx = telegramBot.getContext(userId);
      if (ctx.state === 'AWAITING_ASK_RESPONSE') {
        ctx.state = 'IDLE';
        ctx.stateData = null;
      }
    }
    try { stmts.clearLastUserMsg.run(sessionId); } catch {}

    // A message that arrived while this run was busy is queued in pendingInterrupts
    // (see the busy check above). The local `api` engine's PreToolUse/Stop hook
    // usually drains it mid-run via /api/internal/user-interrupt, which deletes the
    // queue entry — so by the time we get here it is normally already empty. What's
    // still here is exactly what could NOT be delivered mid-run (subscription/tmux
    // without a drain call, SSH, or a race that finished before the hook polled).
    // Run it now as the next message instead of leaving it to rot until cleanup.
    const _queued = pendingInterrupts.get(sessionId);
    if (_queued?.length) {
      pendingInterrupts.delete(sessionId);
      for (const m of _queued) { if (m.dbId) { try { stmts.markInterruptDelivered.run(m.dbId); } catch {} } }
      const _followText = _queued.map(m => m.content).join('\n\n');
      const _followAttachments = _queued.flatMap(m => m.attachments || []);
      setImmediate(() => {
        processTelegramChat({ sessionId, text: _followText, userId, chatId, threadId, attachments: _followAttachments })
          .catch(e => log.error('[processTelegramChat] follow-up run failed', { sessionId, err: e.message }));
      });
      cleanupInterruptAttachments(_queued, INTERRUPT_FILE_TTL_MS);
    }
  }
}

function _attachTelegramListeners(bot) {
  bot.on('device_paired', (device) => {
    wss.clients.forEach(ws => {
      try { ws.send(JSON.stringify({ type: 'telegram_device_paired', device })); } catch {}
    });
  });
  bot.on('device_removed', (data) => {
    wss.clients.forEach(ws => {
      try { ws.send(JSON.stringify({ type: 'telegram_device_removed', ...data })); } catch {}
    });
  });

  // ask_user responses from Telegram
  bot.on('ask_user_response', ({ requestId, answer }) => {
    const entry = pendingAskUser.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pendingAskUser.delete(requestId);
      entry.resolve({ answer: answer || '[Empty response]' });
    }
  });

  // Phase 2: Process messages sent from Telegram to Claude
  bot.on('send_message', async ({ sessionId, text, userId, chatId, threadId, attachments, callback }) => {
    try {
      if (callback) callback({ ok: true });
      await processTelegramChat({ sessionId, text, userId, chatId, threadId, attachments });
    } catch (err) {
      console.error('[Telegram] send_message error:', err.message);
      // Note: callback already called before processTelegramChat — errors are
      // reported via TelegramProxy._sendError, not via callback
    }
  });

  // Active chats query from Telegram status screen
  bot.on('get_active_chats', (callback) => {
    const chats = [];
    for (const [sessionId, task] of activeTasks) {
      const session = stmts.getSession.get(sessionId);
      chats.push({
        sessionId,
        title: session?.title || 'Untitled',
        source: task.source || 'web',
        startedAt: task.startedAt,
      });
    }
    callback(chats);
  });

  // Tunnel: status query from Telegram
  bot.on('tunnel_get_status', (callback) => {
    const status = tunnelManager?.getStatus() || { running: false };
    callback(status);
  });

  // Tunnel control from Telegram
  bot.on('tunnel_start', async ({ chatId }) => {
    try {
      if (!tunnelManager) initTunnelManager();
      if (tunnelManager.isRunning()) {
        const s = tunnelManager.getStatus();
        await bot.sendMessage(chatId, `🟢 Already running:\n${bot.escHtml(s.publicUrl)}`);
        return;
      }
      const c = loadConfig();
      const provider = c.tunnel?.provider || 'cloudflared';
      const config = { ngrokAuthtoken: c.tunnel?.ngrokAuthtoken };
      await bot.sendMessage(chatId, `⏳ Starting ${bot.escHtml(provider)}...`);
      const { publicUrl } = await tunnelManager.start(provider, config);
      await bot.sendMessage(chatId, `🟢 Remote Access active!\n\n🔗 ${bot.escHtml(publicUrl)}`);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error: ${bot.escHtml(err.message)}`);
    }
  });

  bot.on('tunnel_stop', async ({ chatId }) => {
    try {
      if (!tunnelManager?.isRunning()) {
        await bot.sendMessage(chatId, bot.t('tn_not_running'));
        return;
      }
      tunnelManager.stop();
      await bot.sendMessage(chatId, bot.t('tn_notify_stopped'));
    } catch (err) {
      try { await bot.sendMessage(chatId, `❌ ${bot.escHtml(err.message)}`); } catch {}
    }
  });

  bot.on('tunnel_status', async ({ chatId }) => {
    try {
      const s = tunnelManager?.getStatus();
      if (s?.running) {
        await bot.sendMessage(chatId, `🟢 Remote Access active\n\n🔗 ${bot.escHtml(s.publicUrl)}\n⏱ Since: ${bot.escHtml(String(s.startedAt))}`);
      } else {
        await bot.sendMessage(chatId, bot.t('tn_not_running'));
      }
    } catch (err) {
      try { await bot.sendMessage(chatId, `❌ ${bot.escHtml(err.message)}`); } catch {}
    }
  });

  // Phase 2: Stop running task from Telegram
  bot.on('stop_task', async ({ sessionId, chatId, threadId }) => {
    const opts = threadId ? { message_thread_id: threadId } : {};
    const task = activeTasks.get(sessionId);
    if (task && task.abortController) {
      task.abortController.abort();
      // Mirror the web /stop handler (server.js ~8268): drop anything queued as an
      // interrupt for this session too — otherwise a stopped run still leaves
      // clarifications and saved attachment files behind that would silently feed
      // into whatever the NEXT run of this session happens to be.
      const _stoppedInterrupts = pendingInterrupts.get(sessionId);
      pendingInterrupts.delete(sessionId);
      cleanupInterruptAttachments(_stoppedInterrupts);
      await bot.sendMessage(chatId, '🛑 Task stopped.', opts);
    } else if (stmts.hasRunningTask.get(sessionId)) {
      // A Kanban/Schedule task worker runs this session without an activeTasks
      // entry (that map covers web + Telegram chat workers only) — "No active
      // task" would be a flat lie here, telling the user nothing is running when
      // a task genuinely is, just not one Telegram's /stop can reach.
      await bot.sendMessage(chatId, 'ℹ️ A Kanban/Schedule task is running on this session — stop it from the Kanban board, not /stop.', opts);
    } else {
      await bot.sendMessage(chatId, 'No active task in this session.', opts);
    }
  });
}

function initTelegramBot() {
  // The bot polls Telegram outbound (no tunnel required), and /api/telegram/start
  // already starts it in desktop mode — so resume it on boot too when the user
  // enabled it. Previously CCS_DESKTOP returned here, so a saved+enabled bot
  // silently stopped working after every restart. (Caveat: if you ALSO run the
  // web-server build with the same token, only one instance may poll — Telegram
  // permits a single getUpdates consumer per token.)
  const c = loadConfig();
  const tg = c.telegram;
  if (!tg || !tg.enabled || !tg.botToken) return;

  telegramBot = new TelegramBot(db, { log, lang: c.lang || 'uk' });
  telegramBot.acceptNewConnections = tg.acceptNewConnections !== false;
  _attachTelegramListeners(telegramBot);

  telegramBot.start(tg.botToken).catch(err => {
    log.error('[telegram] Failed to start bot', { error: err.message });
    telegramBot = null;
  });
}

// ─── Telegram API Endpoints ─────────────────────────────────────────────────

app.get('/api/telegram/status', (_, res) => {
  const c = loadConfig();
  const tg = c.telegram || {};
  res.json({
    enabled: !!tg.enabled,
    running: telegramBot?.isRunning() || false,
    botInfo: telegramBot?.getBotInfo() || null,
    acceptNewConnections: telegramBot?.acceptNewConnections ?? tg.acceptNewConnections ?? true,
    hasToken: !!tg.botToken,
    devices: telegramBot?.getDevices() || [],
  });
});

app.post('/api/telegram/start', (req, res) => {
  const { botToken } = req.body;
  if (!botToken) return res.status(400).json({ error: 'botToken required' });

  // Save to config
  const c = loadConfig();
  if (!c.telegram) c.telegram = {};
  c.telegram.botToken = botToken;
  c.telegram.enabled = true;
  if (c.telegram.acceptNewConnections === undefined) c.telegram.acceptNewConnections = true;
  saveConfig(c);

  // Stop existing bot if running
  if (telegramBot) {
    telegramBot.stop();
    telegramBot = null;
  }

  // Start new bot
  telegramBot = new TelegramBot(db, { log, lang: c.lang || 'uk' });
  telegramBot.acceptNewConnections = c.telegram.acceptNewConnections !== false;
  _attachTelegramListeners(telegramBot);

  telegramBot.start(botToken)
    .then(botInfo => {
      res.json({ ok: true, botInfo });
    })
    .catch(err => {
      telegramBot = null;
      // Don't disable in config — let user fix the token
      res.status(400).json({ error: err.message });
    });
});

app.post('/api/telegram/stop', (_, res) => {
  if (telegramBot) {
    telegramBot.stop();
    telegramBot = null;
  }
  const c = loadConfig();
  if (c.telegram) c.telegram.enabled = false;
  saveConfig(c);
  res.json({ ok: true });
});

app.post('/api/telegram/pairing-code', (_, res) => {
  if (!telegramBot || !telegramBot.isRunning()) {
    return res.status(400).json({ error: 'Bot is not running' });
  }
  const result = telegramBot.generatePairingCode();
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.delete('/api/telegram/devices/:id', (req, res) => {
  if (!telegramBot) return res.status(400).json({ error: 'Bot is not running' });
  const id = parseInt(req.params.id, 10);
  const removed = telegramBot.removeDevice(id);
  res.json({ ok: removed });
});

app.put('/api/telegram/accept-connections', (req, res) => {
  const { accept } = req.body;
  if (typeof accept !== 'boolean') return res.status(400).json({ error: 'accept (boolean) required' });

  // Save to config
  const c = loadConfig();
  if (!c.telegram) c.telegram = {};
  c.telegram.acceptNewConnections = accept;
  saveConfig(c);

  // Apply to running bot
  if (telegramBot) {
    telegramBot.acceptNewConnections = accept;
  }

  res.json({ ok: true, acceptNewConnections: accept });
});

// ============================================
// TUNNEL API
// ============================================

app.get('/api/tunnel/status', (_, res) => {
  const s = tunnelManager?.getStatus() || { running: false };
  const c = loadConfig();
  res.json({
    running: s.running,
    provider: s.provider || c.tunnel?.provider || 'cloudflared',
    publicUrl: s.publicUrl || null,
    startedAt: s.startedAt || null,
    pid: s.pid || null,
    error: s.error || null,
    savedProvider: c.tunnel?.provider || 'cloudflared',
    hasNgrokToken: !!c.tunnel?.ngrokAuthtoken,
  });
});

let _tunnelStartLock = false;
app.post('/api/tunnel/start', async (req, res) => {
  if (tunnelManager?.isRunning()) {
    return res.json({ ok: true, publicUrl: tunnelManager.getStatus().publicUrl, already: true });
  }
  if (_tunnelStartLock) {
    return res.status(409).json({ error: 'Tunnel start already in progress' });
  }

  const { provider, ngrokAuthtoken } = req.body;
  const prov = provider || 'cloudflared';
  if (!['cloudflared', 'ngrok'].includes(prov)) {
    return res.status(400).json({ error: `Unknown provider: ${prov}` });
  }

  // Save preferences to config
  const c = loadConfig();
  if (!c.tunnel) c.tunnel = {};
  c.tunnel.provider = prov;
  if (ngrokAuthtoken) c.tunnel.ngrokAuthtoken = ngrokAuthtoken;
  saveConfig(c);

  // Initialize manager if not done
  if (!tunnelManager) initTunnelManager();

  _tunnelStartLock = true;
  try {
    const { publicUrl } = await tunnelManager.start(prov, {
      ngrokAuthtoken: ngrokAuthtoken || c.tunnel.ngrokAuthtoken,
    });
    res.json({ ok: true, publicUrl });
  } catch (err) {
    const resp = { error: err.message };
    if (err.installUrl) {
      resp.installUrl = err.installUrl;
      resp.installCmd = err.installCmd;
    }
    res.status(400).json(resp);
  } finally {
    _tunnelStartLock = false;
  }
});

app.post('/api/tunnel/notify-telegram', async (_, res) => {
  if (!tunnelManager?.isRunning()) {
    return res.status(400).json({ error: 'Remote access is not running' });
  }
  if (!telegramBot?.isRunning()) {
    return res.status(400).json({ error: 'Telegram bot is not running' });
  }
  const url = tunnelManager.getStatus().publicUrl;
  try {
    await telegramBot.notifyTunnelUrl(url);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to notify Telegram devices' });
  }
});

app.post('/api/tunnel/stop', (_, res) => {
  if (tunnelManager?.isRunning()) {
    tunnelManager.stop();
  }
  res.json({ ok: true });
});

// ============================================
// CROSS-AGENT DELEGATION
// ============================================

const activeDelegations = new Map(); // delegationId -> { id, agentId, mode, workdir, delegationDir, startedAt, watcher }
const CROSSWORK_DIR = '.crosswork';

function getDelegationDir(workdir, delegationId) {
  return path.join(workdir, CROSSWORK_DIR, delegationId);
}

function saveDelegationState(delegation) {
  const statePath = path.join(delegation.delegationDir, 'state.json');
  const state = {
    id: delegation.id,
    agentId: delegation.agentId,
    agentLabel: delegation.agentLabel,
    mode: delegation.mode,
    workdir: delegation.workdir,
    delegationDir: delegation.delegationDir,
    sessionId: delegation.sessionId,
    task: delegation.task,
    startedAt: delegation.startedAt,
  };
  try { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch {}
}

function restoreDelegations() {
  // Scan all known workdirs for .crosswork/*/state.json
  const workdirs = new Set();
  try {
    const rows = db.prepare('SELECT DISTINCT workdir FROM sessions WHERE workdir IS NOT NULL').all();
    for (const r of rows) workdirs.add(r.workdir);
  } catch {}
  workdirs.add(path.resolve(WORKDIR));

  for (const wd of workdirs) {
    const crossworkDir = path.join(wd, CROSSWORK_DIR);
    if (!fs.existsSync(crossworkDir)) continue;
    try {
      const entries = fs.readdirSync(crossworkDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const statePath = path.join(crossworkDir, entry.name, 'state.json');
        if (!fs.existsSync(statePath)) continue;
        try {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
          if (activeDelegations.has(state.id)) continue;
          const watcher = state.mode === 'sync'
            ? startDelegationWatcher(state.id, state.delegationDir)
            : null;
          activeDelegations.set(state.id, {
            ...state,
            lastUpdate: Date.now(),
            lastDialog: '',
            watcher,
          });
          log.info('Restored delegation', { delegationId: state.id, agentId: state.agentId });
        } catch {}
      }
    } catch {}
  }
}

function ensureDelegationDir(workdir, delegationId) {
  const dir = getDelegationDir(workdir, delegationId);
  fs.mkdirSync(dir, { recursive: true });
  // Auto-add .crosswork/ to .gitignore if not already there
  const gitignorePath = path.join(workdir, '.gitignore');
  try {
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    if (!existing.includes(CROSSWORK_DIR)) {
      fs.appendFileSync(gitignorePath, `\n# Cross-agent delegation workspace\n${CROSSWORK_DIR}/\n`);
    }
  } catch { /* non-critical */ }
  return dir;
}

function buildContextMd(session, messages, task, relPath, mode) {
  const now = new Date().toISOString();
  const textMsgs = messages.filter(m => m.type !== 'tool' && m.content);
  const recent = textMsgs.slice(-40);
  let conversation = '';
  for (const m of recent) {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const content = m.content.length > 1000 ? m.content.slice(0, 1000) + '...' : m.content;
    conversation += `### ${role}\n${content}\n\n`;
  }

  let md = `# Cross-Agent Context Handoff
- Generated: ${now}
- Source: Claude Code Studio, session "${session.title || 'Untitled'}"
- Project: ${session.workdir || 'unknown'}

## Task
${task}

## Recent Conversation
${conversation}`;

  if (mode === 'sync') {
    md += `## Communication Protocol
You are continuing work delegated from another AI agent (Claude Code Studio).
Both agents work in parallel and communicate through a shared dialog file.

1. Read this file first for full context of prior work
2. Before EVERY write to ${relPath}/DIALOG.md — re-read it first (another agent may have added messages)
3. Write progress updates to ${relPath}/DIALOG.md using this format:
   ## [YYYY-MM-DD HH:MM:SS] {your-agent-name}
   Your progress note here.
4. When you have a FINAL ANSWER for the human user, use this format instead:
   ## [YYYY-MM-DD HH:MM:SS] {your-agent-name} | answer
   Your clear, well-formatted answer here. This will be shown directly to the user.
5. After each completed work step — append your update to ${relPath}/DIALOG.md
6. Never overwrite or delete content in DIALOG.md — only APPEND
7. The other agent may send follow-up instructions at any time via DIALOG.md
8. If you finish all work, write a final answer (with | answer tag) in DIALOG.md
`;
  }

  return md;
}

function appendDialog(delegationDir, agentName, message) {
  const dialogPath = path.join(delegationDir, 'DIALOG.md');
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const entry = `\n## [${timestamp}] ${agentName}\n${message}\n`;
  if (!fs.existsSync(dialogPath)) {
    fs.writeFileSync(dialogPath, `# Agent Dialog\n${entry}`);
  } else {
    fs.appendFileSync(dialogPath, entry);
  }
}

function readDialog(delegationDir) {
  const dialogPath = path.join(delegationDir, 'DIALOG.md');
  try { return fs.readFileSync(dialogPath, 'utf-8'); } catch { return ''; }
}

function buildTerminalCommand(agentConfig, workdir, prompt) {
  return buildDelegateCommand(agentConfig, workdir, prompt, os.platform());
}

function openTerminal(shellCommand) {
  const platform = os.platform();
  if (platform === 'darwin') {
    // macOS — open Terminal.app via osascript
    // Write command to a temp script file to avoid shell/AppleScript escaping issues
    const tmpScript = path.join(os.tmpdir(), `ccs-delegate-${Date.now()}.sh`);
    fs.writeFileSync(tmpScript, `#!/bin/bash\n${shellCommand}\n`, { mode: 0o755 });
    // do script BEFORE activate so a cold launch reuses Terminal's auto-opened window
    // instead of leaving an empty default window plus the command window (two windows).
    const script = `tell application "Terminal"\n  do script "${tmpScript}"\n  activate\nend tell`;
    try {
      spawnProc('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => { try { fs.unlinkSync(tmpScript); } catch {} }, 10000);
      return { ok: true };
    } catch (err) {
      try { fs.unlinkSync(tmpScript); } catch {}
      return { ok: false, error: err.message };
    }
  } else if (platform === 'win32') {
    // Windows — write a .bat script and open it in a new cmd window
    const tmpBat = path.join(os.tmpdir(), `ccs-delegate-${Date.now()}.bat`);
    fs.writeFileSync(tmpBat, `@echo off\n${shellCommand}\n`);
    try {
      // winTerminalArgs quotes the window title (bare `start Delegate ...` made Windows
      // look for a program called "Delegate" — issue #22); windowsVerbatimArguments keeps
      // Node from re-quoting those already-quoted arguments.
      spawnProc('cmd.exe', winTerminalArgs(tmpBat), { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
      setTimeout(() => { try { fs.unlinkSync(tmpBat); } catch {} }, 10000);
      return { ok: true };
    } catch (err) {
      try { fs.unlinkSync(tmpBat); } catch {}
      return { ok: false, error: err.message };
    }
  } else {
    // Linux — try common terminal emulators
    const terminals = ['gnome-terminal', 'xterm', 'konsole'];
    for (const term of terminals) {
      try {
        spawnProc(term, ['--', 'bash', '-c', shellCommand], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
      } catch { continue; }
    }
    return { ok: false, error: 'No supported terminal emulator found' };
  }
}

function startDelegationWatcher(delegationId, delegationDir) {
  let debounceTimer = null;
  try {
    const watcher = fs.watch(delegationDir, { persistent: false }, (eventType, filename) => {
      if (filename === 'DIALOG.md') {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const delegation = activeDelegations.get(delegationId);
          if (!delegation) return;
          delegation.lastUpdate = Date.now();
          const dialog = readDialog(delegationDir);
          for (const client of wss.clients) {
            if (client.readyState === 1) {
              client.send(JSON.stringify({
                type: 'delegate_update',
                delegationId,
                dialog,
                lastUpdate: delegation.lastUpdate,
              }));
            }
          }
        }, 300);
      }
    });
    return watcher;
  } catch {
    return null;
  }
}

// --- Bots API ---
// A bot is a named chat participant: handle (= id), label, description, engine,
// model and system prompt. Mirrors the external-agents API in shape.

// Without ?project= this is the whole library (the bot management screen). With it,
// only the bots available in that project — which is what the @ palette offers.
app.get('/api/bots', (req, res) => {
  // Either identifier works: the chat knows the project id, the Kanban board only
  // knows the working directory. Making the caller resolve that mapping is how the
  // board silently ended up showing an empty roster.
  let projectId = req.query.project ? String(req.query.project) : null;
  if (!projectId && req.query.workdir) {
    const proj = loadProjects().find(pr => pr.workdir === String(req.query.workdir));
    if (proj) projectId = proj.id;
    else return res.json([]);   // a directory with no project has no roster
  }
  const rows = projectId ? stmts.listProjectBots.all(projectId) : stmts.listBots.all();
  res.json(withProjects(rows));
});

// A bot row carries the projects it is available in. The UI needs this to say
// "also in Alpha, Beta" before an edit and to warn that a delete is global —
// without it every bot list would cost one extra request per bot.
function withProjects(rows) {
  if (!rows.length) return rows;
  const names = new Map(loadProjects().map(p => [String(p.id), p.name]));
  const byBot = new Map();
  for (const r of stmts.allProjectBots.all()) {
    if (!byBot.has(r.bot_id)) byBot.set(r.bot_id, []);
    // A membership whose project was deleted from projects.json is skipped rather
    // than shown as an unnamed id — the row is harmless, it just has nothing to name.
    const name = names.get(String(r.project_id));
    if (name !== undefined) byBot.get(r.bot_id).push({ id: String(r.project_id), name });
  }
  return rows.map(b => ({ ...b, projects: byBot.get(b.id) || [] }));
}

app.post('/api/projects/:projectId/bots/:botId', (req, res) => {
  if (!stmts.getBot.get(req.params.botId)) return res.status(404).json({ error: 'bot not found' });
  stmts.addBotToProject.run(String(req.params.projectId), req.params.botId);
  res.json({ ok: true });
});

app.delete('/api/projects/:projectId/bots/:botId', (req, res) => {
  // Removing a bot from a project never deletes the bot or its past messages — it
  // only stops offering it here.
  stmts.removeBotFromProject.run(String(req.params.projectId), req.params.botId);
  res.json({ ok: true });
});

// Length caps. A system prompt is re-sent on every turn, so it is a running cost,
// not a one-off — an unbounded one would be paid for forever.
const BOT_PROMPT_MAX = 8192;
const BOT_DESC_MAX = 500;
const BOT_LABEL_MAX = 100;

// Shared writer for create and update. `mode` decides what an existing handle means:
// creating over one is a conflict, updating a missing one is a 404.
function saveBot(req, res, mode) {
  const body = req.body || {};
  const cleanLabel = String(body.label || '').trim();
  if (!cleanLabel) return res.status(400).json({ error: 'label required' });
  const engine = body.engine || 'claude';
  if (engine !== 'claude') {
    // The column exists so adding an engine later is not a migration, but only the
    // Claude path is wired into a chat turn today.
    return res.status(400).json({ error: `engine "${engine}" is not supported yet` });
  }

  let handle;
  if (mode === 'update') {
    handle = String(req.params.id || '').toLowerCase();
    if (!stmts.getBot.get(handle)) return res.status(404).json({ error: 'bot not found' });
  } else {
    const asked = String(body.id || '').trim().toLowerCase();
    if (asked) {
      if (!botsLogic.isValidHandle(asked)) {
        return res.status(400).json({ error: 'handle must be 2-32 chars of a-z, 0-9, - or _, and may not end in - or _' });
      }
      // getBotAny, not getBot: a soft-deleted handle stays reserved so a new bot can
      // never inherit authorship of the old one's messages.
      if (stmts.getBotAny.get(asked)) return res.status(409).json({ error: `handle "${asked}" is taken` });
      handle = asked;
    } else {
      const base = botsLogic.handleFromLabel(cleanLabel);
      if (!base) return res.status(400).json({ error: 'could not derive a handle from that label' });
      handle = botsLogic.uniqueHandle(base, stmts.allBotHandles.all().map(b => b.id));
      if (!handle) return res.status(400).json({ error: 'could not allocate a free handle' });
    }
  }

  const prompt = String(body.systemPrompt ?? '');
  if (prompt.length > BOT_PROMPT_MAX) {
    return res.status(400).json({ error: `system prompt is too long (${prompt.length} > ${BOT_PROMPT_MAX} characters)` });
  }

  try {
    // A field absent from the request keeps its stored value; a field present but
    // empty clears it. A partial edit must never wipe what it did not mention.
    const prev = stmts.getBot.get(handle) || {};
    const keep = (key, fallback) => (body[key] === undefined ? fallback : body[key]);
    const jsonList = (v) => JSON.stringify(Array.isArray(v) ? v : []);
    stmts.upsertBot.run(
      handle,
      cleanLabel.substring(0, BOT_LABEL_MAX),
      String(keep('description', prev.description || '')).substring(0, BOT_DESC_MAX),
      engine,
      keep('model', prev.model) ? String(keep('model', prev.model)) : null,
      body.systemPrompt === undefined ? (prev.system_prompt || '') : prompt,
      body.activeSkills === undefined ? (prev.active_skills || '[]') : jsonList(body.activeSkills),
      body.activeMcp === undefined ? (prev.active_mcp || '[]') : jsonList(body.activeMcp),
      // Array.from, not substring: an emoji is several UTF-16 units and a family/ZWJ
      // sequence is many, so slicing by unit can cut a surrogate pair in half.
      Array.from(String(keep('avatar', prev.avatar || ''))).slice(0, 8).join(''),
      (body.isGlobal === undefined ? (prev.is_global ? 1 : 0) : (body.isGlobal ? 1 : 0)),
    );
  } catch (e) {
    log.error('bot save failed', { handle, err: e.message });
    return res.status(500).json({ error: 'could not save the bot' });
  }
  // A bot created while a project is open belongs to that project immediately —
  // otherwise every creation would be followed by a separate "add it here" step.
  if (mode === 'create' && body.projectId && !body.isGlobal) {
    try { stmts.addBotToProject.run(String(body.projectId), handle); } catch {}
  }
  res.json(withProjects([stmts.getBot.get(handle)])[0]);
}

app.post('/api/bots', express.json(), (req, res) => saveBot(req, res, 'create'));

// ─── Export bots as JSON ──────────────────────────────────────────────────
// Registered before the ':id' routes: a literal path must win over a parameter, or
// /api/bots/import would read as a bot whose handle is "import".
app.get('/api/bots/export', (req, res) => {
  // Scoped to a project by default is wrong here: the point of an export is to move
  // bots, and the caller says which set it means. No project → the whole roster.
  const projectId = req.query.project ? String(req.query.project) : null;
  const rows = projectId ? stmts.listProjectBots.all(projectId) : stmts.listBots.all();
  // Only what describes a bot. Timestamps and project membership are this install's
  // bookkeeping — carrying them across would import ids that mean nothing there.
  const bots = rows.map(b => ({
    id: b.id,
    label: b.label,
    description: b.description || '',
    model: b.model || null,
    system_prompt: b.system_prompt || '',
    active_skills: b.active_skills || '[]',
    active_mcp: b.active_mcp || '[]',
    avatar: b.avatar || '',
    is_global: b.is_global ? 1 : 0,
  }));
  res.setHeader('Content-Disposition', 'attachment; filename="bots.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json({ version: 1, exported_at: new Date().toISOString(), bots });
});

// ─── Import bots from a JSON export ───────────────────────────────────────
app.post('/api/bots/import', express.json({ limit: '4mb' }), (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body) ? body : (Array.isArray(body.bots) ? body.bots : null);
  if (!incoming) return res.status(400).json({ error: 'Invalid import body: a "bots" array is required' });

  const plan = botsLogic.planBotImport({
    incoming,
    live: stmts.listBots.all().map(b => b.id),
    reserved: stmts.allBotHandles.all().map(b => b.id),
    overwrite: !!body.overwrite,
  });

  const writes = [...plan.create, ...plan.overwrite];
  // One transaction: a partial roster is worse than none, because the half that landed
  // looks like a complete import and the user has no way to tell which half is missing.
  try {
    db.transaction(() => {
      for (const b of writes) {
        stmts.upsertBot.run(
          b.id,
          b.label.substring(0, BOT_LABEL_MAX),
          b.description.substring(0, BOT_DESC_MAX),
          'claude',
          b.model,
          b.system_prompt.substring(0, BOT_PROMPT_MAX),
          b.active_skills,
          b.active_mcp,
          Array.from(b.avatar).slice(0, 8).join(''),
          b.is_global,
        );
        // A non-global bot imported while a project is open joins it, exactly as a bot
        // created there would. Without this an import lands nowhere the user can see.
        if (body.projectId && !b.is_global) {
          try { stmts.addBotToProject.run(String(body.projectId), b.id); } catch {}
        }
      }
    })();
  } catch (e) {
    log.error('bot import failed', { err: e.message });
    return res.status(500).json({ error: 'could not import the bots' });
  }

  res.json({
    ok: true,
    created: plan.create.length,
    updated: plan.overwrite.length,
    skipped: plan.skipped,
    // Reported separately because it is the one refusal `overwrite` will NOT resolve —
    // the UI offers a retry with overwrite, and must not offer it for these.
    conflicts: plan.skipped.filter(s => s.reason === 'exists').length,
  });
});

app.put('/api/bots/:id', express.json(), (req, res) => saveBot(req, res, 'update'));

app.delete('/api/bots/:id', (req, res) => {
  const bot = stmts.getBot.get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'bot not found' });
  // Soft: past messages keep their agent_id, and the handle can never be reused by a
  // different bot that would then look like their author.
  stmts.softDeleteBot.run(req.params.id);
  res.json({ ok: true });
});

// --- External agents config API ---

app.get('/api/external-agents', (_, res) => {
  const config = loadConfig();
  res.json(config.externalAgents || {});
});

app.post('/api/external-agents', express.json(), (req, res) => {
  const { id, label, template, interactive, newIdFlag, resume, resumeLast } = req.body;
  if (!id || !label) return res.status(400).json({ error: 'id and label required' });
  // An agent is useful for delegation (template), for terminal sessions
  // (interactive), or both — but at least one, or it can do nothing.
  const hasTemplate = String(template || '').trim();
  const hasInteractive = String(interactive || '').trim();
  if (!hasTemplate && !hasInteractive) {
    return res.status(400).json({ error: 'either a delegation template or an interactive command is required' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'id must be alphanumeric (a-z, 0-9, -, _)' });
  const config = loadConfig();
  // Preserve fields this request does not carry, so editing one half of an agent
  // never wipes the other half.
  const prev = config.externalAgents[id] || {};
  const next = { ...prev, label };
  for (const [k, v] of Object.entries({ template, interactive, newIdFlag, resume, resumeLast })) {
    if (v === undefined) continue;              // not submitted — keep whatever is stored
    const s = String(v).trim();
    if (s) next[k] = s; else delete next[k];    // submitted empty — clear it
  }
  config.externalAgents[id] = next;
  // If re-adding a previously removed default, clear the removal marker
  if (config._removedAgents) {
    config._removedAgents = config._removedAgents.filter(r => r !== id);
  }
  saveConfig(config);
  res.json({ ok: true });
});

app.post('/api/external-agents/:id/test', (req, res) => {
  const config = loadConfig();
  const agentConfig = config.externalAgents[req.params.id];
  if (!agentConfig) return res.status(404).json({ error: 'Agent not found' });
  // Extract base command from template (first word before space). A terminal-only
  // agent has no template — fall back to its interactive command, otherwise a
  // perfectly working agent is reported as "Empty template".
  const baseSource = agentConfig.template || resolveAgentCommands(agentConfig).interactive || '';
  const baseCmd = baseSource.split(/\s+/)[0];
  if (!baseCmd) return res.json({ ok: false, error: 'Empty template' });
  // Validate command name to prevent injection (only allow safe chars)
  if (!/^[a-zA-Z0-9._-]+$/.test(baseCmd)) return res.json({ ok: false, error: 'Invalid command name' });
  const whichCmd = os.platform() === 'win32' ? 'where' : 'which';
  try {
    const result = execSync(`${whichCmd} ${baseCmd}`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
    res.json({ ok: true, path: result.split('\n')[0] });
  } catch {
    res.json({ ok: false, error: `"${baseCmd}" not found in PATH` });
  }
});

app.delete('/api/external-agents/:id', (req, res) => {
  const config = loadConfig();
  const id = req.params.id;
  delete config.externalAgents[id];
  // Remember explicitly removed defaults so loadConfig() won't re-add them
  if (DEFAULT_EXTERNAL_AGENTS[id]) {
    if (!config._removedAgents) config._removedAgents = [];
    if (!config._removedAgents.includes(id)) config._removedAgents.push(id);
  }
  saveConfig(config);
  res.json({ ok: true });
});

// --- Delegation API ---

app.post('/api/delegate', express.json(), (req, res) => {
  const { agentId, mode, task, sessionId } = req.body;
  if (!agentId || !task) return res.status(400).json({ error: 'agentId and task required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) return res.status(400).json({ error: 'Invalid agentId' });

  const config = loadConfig();
  const agentConfig = config.externalAgents[agentId];
  if (!agentConfig) return res.status(404).json({ error: `Agent "${agentId}" not configured` });
  // Delegation needs a one-shot `template`. Terminal-only agents (interactive but
  // no template, e.g. the built-in `claude` entry) would otherwise sail through:
  // buildTerminalCommand yields a bare `cd <workdir> && `, a terminal window opens
  // and exits, the API answers {ok:true}, and sync mode waits forever on a
  // DIALOG.md that no agent will ever write. Fail loudly instead.
  if (!String(agentConfig.template || '').trim()) {
    return res.status(400).json({ error: `Agent "${agentId}" does not support delegation (no template configured)` });
  }

  const session = sessionId ? stmts.getSession.get(sessionId) : null;
  const workdir = session?.workdir || WORKDIR;

  // 1. Generate delegation ID and create its subdirectory
  const delegationId = genId();
  const delegationMode = mode || 'handoff';
  const delegationDir = ensureDelegationDir(workdir, delegationId);
  const relPath = `.crosswork/${delegationId}`;

  // 2. Build context from session messages
  const messages = sessionId ? stmts.getMsgs.all(sessionId) : [];
  const contextMd = buildContextMd(session || { title: 'New delegation', workdir }, messages, task, relPath, delegationMode);
  fs.writeFileSync(path.join(delegationDir, 'CONTEXT.md'), contextMd);

  // 3. Initialize DIALOG.md with delegation message
  appendDialog(delegationDir, 'claude-code-studio', `Delegated task to ${agentConfig.label}.\nTask: ${task}\nMode: ${delegationMode}\nFull context in CONTEXT.md.`);

  // 4. Build prompt for the external agent
  let agentPrompt;
  if (delegationMode === 'sync') {
    agentPrompt = `Read ${relPath}/CONTEXT.md for full context of the delegated task, then start working. Follow the protocol described in that file for communicating through ${relPath}/DIALOG.md. After each completed step, write a summary to DIALOG.md. Check DIALOG.md before and after each step for new instructions. IMPORTANT: When you have a final answer for the user, write it to DIALOG.md using the tag "| answer" after your agent name, like: ## [timestamp] your-name | answer. This answer will be shown directly to the human user, so write it in a clear, well-formatted way.`;
  } else {
    agentPrompt = `Read ${relPath}/CONTEXT.md for full context of the delegated task, then start working. IMPORTANT: When you have a final result, write it to ${relPath}/DIALOG.md using this format: ## [YYYY-MM-DD HH:MM:SS] your-agent-name | answer — followed by a clear, well-formatted answer for the user. This will be shown directly to the human.`;
  }

  // 5. Open terminal with the agent
  const shellCommand = buildTerminalCommand(agentConfig, workdir, agentPrompt);
  const termResult = openTerminal(shellCommand);

  if (!termResult.ok) {
    return res.status(500).json({ error: `Failed to open terminal: ${termResult.error}` });
  }

  // 6. Track delegation — watch for dialog changes in sync mode
  const watcher = delegationMode === 'sync' ? startDelegationWatcher(delegationId, delegationDir) : null;

  activeDelegations.set(delegationId, {
    id: delegationId,
    agentId,
    agentLabel: agentConfig.label,
    mode: delegationMode,
    workdir,
    delegationDir,
    sessionId: sessionId || null,
    task,
    startedAt: Date.now(),
    lastUpdate: Date.now(),
    lastDialog: '',
    watcher,
  });

  saveDelegationState(activeDelegations.get(delegationId));
  log.info('Delegation created', { delegationId, agentId, mode: delegationMode, workdir });

  res.json({
    ok: true,
    delegationId,
    mode: delegationMode,
    agent: agentConfig.label,
    crossworkPath: delegationDir,
  });
});

app.get('/api/delegate/status', (_, res) => {
  const delegations = [];
  for (const [, d] of activeDelegations) {
    delegations.push({
      id: d.id,
      agentId: d.agentId,
      agentLabel: d.agentLabel,
      mode: d.mode,
      workdir: d.workdir,
      sessionId: d.sessionId,
      task: d.task,
      startedAt: d.startedAt,
      lastUpdate: d.lastUpdate,
    });
  }
  res.json({ delegations });
});

app.get('/api/delegate/:id/dialog', (req, res) => {
  const delegation = activeDelegations.get(req.params.id);
  if (!delegation) return res.status(404).json({ error: 'Delegation not found' });
  const dialog = readDialog(delegation.delegationDir);
  res.json({ dialog, lastUpdate: delegation.lastUpdate });
});

app.post('/api/delegate/:id/message', express.json(), (req, res) => {
  const delegation = activeDelegations.get(req.params.id);
  if (!delegation) return res.status(404).json({ error: 'Delegation not found' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  appendDialog(delegation.delegationDir, 'claude-code-studio', message);
  delegation.lastUpdate = Date.now();
  res.json({ ok: true });
});

app.post('/api/delegate/:id/check', (req, res) => {
  const delegation = activeDelegations.get(req.params.id);
  if (!delegation) return res.status(404).json({ error: 'Delegation not found' });
  const dialog = readDialog(delegation.delegationDir);
  const changed = dialog !== (delegation.lastDialog || '');
  if (changed) {
    delegation.lastUpdate = Date.now();
    delegation.lastDialog = dialog;
  }
  res.json({ dialog, lastUpdate: delegation.lastUpdate });
});

// Save delegate agent message to session history (so it survives page reload)
app.post('/api/delegate/:id/save-msg', express.json(), (req, res) => {
  const delegation = activeDelegations.get(req.params.id);
  if (!delegation) return res.status(404).json({ error: 'Delegation not found' });
  if (!delegation.sessionId) return res.status(400).json({ error: 'No session linked' });
  const { content, agentLabel } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const toolName = `delegate:${delegation.agentId}`;
  try {
    stmts.addMsg.run(delegation.sessionId, 'assistant', 'delegate', content, toolName, null, null, null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/delegate/:id', (req, res) => {
  const delegation = activeDelegations.get(req.params.id);
  if (!delegation) return res.status(404).json({ error: 'Delegation not found' });
  if (delegation.watcher) { try { delegation.watcher.close(); } catch {} }
  // Remove state file so it won't be restored on next restart
  try { fs.unlinkSync(path.join(delegation.delegationDir, 'state.json')); } catch {}
  activeDelegations.delete(req.params.id);
  log.info('Delegation stopped', { delegationId: req.params.id });
  res.json({ ok: true });
});

// ============================================
// WEBSOCKET
// ============================================
server.on('upgrade', (req, socket, head) => {
  const cookies = {};
  (req.headers.cookie||'').split(';').forEach(c => { const[k,v]=c.trim().split('='); if(k&&v) cookies[k]=v; });
  const bearerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const token = cookies.token || req.headers['x-auth-token'] || bearerToken;
  if (!auth.validateWsToken(token)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  // Route AFTER the auth check — the terminal endpoint reuses it verbatim and must
  // never grow an auth path of its own.
  let pathname = req.url;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch {}
  if (pathname === '/ws/terminal') {
    wssTerm.handleUpgrade(req, socket, head, ws => wssTerm.emit('connection', ws, req));
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// ─── Terminal sessions WebSocket ─────────────────────────────────────────────
// Protocol:
//   server → client: binary frames = raw terminal bytes; JSON text = control
//   client → server: {type:'input',data} | {type:'paste',data} | {type:'resize',cols,rows} | {type:'kill'}
wssTerm.on('connection', (ws, req) => {
  ws.on('error', (e) => { try { log.warn('terminal ws error', { msg: e?.message }); } catch {} });
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  const fail = (error) => { send({ type: 'error', error }); try { ws.close(); } catch {} };

  const cfg = loadConfig();
  if (cfg.terminal?.enabled !== true) return fail('terminal sessions are disabled');
  // A published tunnel plus a browser terminal is a public shell. Refuse regardless
  // of the enable flag.
  if (tunnelManager?.isRunning?.()) return fail('blocked while a public tunnel is active');
  if (!termBridge.tmuxAvailable()) return fail('tmux unavailable on this host');

  let sessionId = null;
  // The client's real terminal size travels WITH the connect, not in a resize message
  // that arrives a beat later. Attaching at a hardcoded 80x24 first made tmux reflow a
  // running TUI down to 80 columns and back on every re-attach — the agent's screen
  // visibly scrambled, and the capture-pane bootstrap could snapshot the mangled frame.
  // Missing/garbage params fall back to 80x24; attach() clamps.
  let termCols = 80, termRows = 24;
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    sessionId = q.get('session');
    termCols = parseInt(q.get('cols'), 10) || 80;
    termRows = parseInt(q.get('rows'), 10) || 24;
  } catch {}
  const session = sessionId ? stmts.getSession.get(sessionId) : null;
  if (!session || session.kind !== 'terminal') return fail('not a terminal session');

  const agents = loadConfig().externalAgents || {};
  const commands = resolveAgentCommands(agents[session.terminal_agent]);
  if (!commands.interactive) return fail(`agent "${session.terminal_agent}" has no interactive command`);

  const name = tmuxNameFor(session.id);
  const sbFile = path.join(os.tmpdir(), `ccsterm-sb-${session.id}.txt`);
  let handle = null;
  let attempts = 0;

  // Start the agent and attach a client. `asRestore` picks the resume command over
  // the fresh-start one.
  //
  // Self-healing: an exact conversation id can exist on OUR side and not on the
  // agent's — we mint it at session creation, but an agent only persists the
  // conversation once it has actually been used (verified: `claude --resume <unused
  // uuid>` answers "No conversation found with session ID"). A restore that dies
  // within seconds therefore means "nothing to resume", not "broken", so we start
  // fresh once instead of leaving the user with a dead terminal.
  function startAndAttach(asRestore) {
    attempts++;
    const launch = buildLaunchCommand({ commands, convId: session.agent_conv_id, isRestore: asRestore });
    let state;
    try {
      state = termBridge.ensureSession({ name, workdir: session.workdir || WORKDIR, launchCommand: launch });
    } catch (e) {
      log.warn('terminal session start failed', { sessionId: session.id, err: e.message });
      fail(`could not start the agent: ${e.message}`);
      return;
    }

    send({
      type: 'ready',
      state,
      agent: session.terminal_agent,
      restored: asRestore,
      restoredExact: asRestore && !!(session.agent_conv_id && commands.resume),
    });

    // Replay the scrollback the reaper saved before killing this session, so a
    // reaped terminal returns with the picture the user last saw.
    if (attempts === 1 && state !== 'attach') {
      try {
        if (fs.existsSync(sbFile)) ws.send(Buffer.from(fs.readFileSync(sbFile, 'utf8').replace(/\n/g, '\r\n') + '\r\n'));
      } catch {}
    }

    const startedAt = Date.now();
    try {
      handle = termBridge.attach({
        name, cols: termCols, rows: termRows,
        onData: (buf) => {
          // Drop output rather than let a slow browser grow an unbounded send queue.
          if (ws.bufferedAmount > 4 * 1024 * 1024) return;
          try { ws.send(buf); } catch {}
        },
        onExit: () => {
          if (asRestore && attempts === 1 && Date.now() - startedAt < 10000) {
            log.info('terminal restore found nothing to resume — starting fresh', { sessionId: session.id });
            try { handle?.close(); } catch {}
            termBridge.killSession(name);
            send({ type: 'restore_failed' });
            startAndAttach(false);
            return;
          }
          send({ type: 'exit' });
          try { ws.close(); } catch {}
        },
      });
    } catch (e) {
      fail(`could not attach: ${e.message}`);
    }
  }

  if (!session.terminal_started) { try { stmts.markTerminalStarted.run(session.id); } catch {} }
  startAndAttach(session.terminal_started === 1);

  ws.on('message', (raw, isBinary) => {
    if (!handle) return;
    if (isBinary) { handle.write(raw); return; }
    let msg = null;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (msg.type === 'input') handle.write(msg.data);
    else if (msg.type === 'paste') handle.paste(msg.data);
    else if (msg.type === 'resize') handle.resize(msg.cols, msg.rows);
    else if (msg.type === 'kill') {
      termBridge.killSession(name);
      try { fs.unlinkSync(sbFile); } catch {}
      try { ws.close(); } catch {}
    }
  });

  // Closing the browser tab detaches the CLIENT only — the agent keeps working.
  ws.on('close', () => { try { handle?.close(); } catch {} });
});

wss.on('connection', (ws) => {
  log.info('ws connected', { clients: wss.clients.size });
  // A socket-level 'error' event with no listener is thrown by EventEmitter →
  // uncaughtException → whole-process crash. Swallow+log it instead (audit H5).
  ws.on('error', (e) => { try { log.warn('ws socket error', { msg: e?.message }); } catch {} });
  // Per-tab concurrency tracking
  ws._tabBusy  = {};  // tabId → bool
  ws._tabQueue = {};  // tabId → msg[]
  ws._tabAbort = {};  // tabId → AbortController
  // Legacy single-connection state (kept for backward compat with start_session)
  let legacySessionId = null, legacyClaudeId = undefined;
  // Legacy queue (for messages without tabId)
  ws._queue = []; ws._busy = false; ws._queueIdCounter = 0;

  function queuePayload(tabId) {
    const queue = tabId ? (ws._tabQueue[tabId] || []) : ws._queue;
    return JSON.stringify({
      type: 'queue_update',
      tabId,
      pending: queue.length,
      items: queue.map(m => ({ id: m._queueId, queueId: m.queueId || null, text: m.text || '', attachments: m.attachments || [] })),
    });
  }

  async function processChat(msg) {
    const tabId = msg.tabId || null;
    const proxy = new WsProxy(ws); // buffers output when browser disconnects

    // Mark this tab as busy (per-connection + cross-connection)
    if (tabId) { ws._tabBusy[tabId] = true; activeChatSessions.add(tabId); }
    else ws._busy = true;

    // Track OUR abort controller so finally can detect if a stop+new processChat
    // happened while we were running (stale finally must not reset _tabBusy).
    let myAbortController = null;

    // Pre-declared so catch/finally always have scope for busy-state cleanup.
    // effectiveTabId starts as tabId: if an error is thrown before the real
    // effectiveTabId (= localSessionId) is computed, finally still resets the
    // correct _tabBusy key and avoids leaving the tab permanently stuck.
    let localSessionId = null, localClaudeId = undefined, effectiveTabId = tabId;
    const _chatStartedAt = Date.now();

    try {
      ws.send(queuePayload(tabId));

      // Resolve session: use sessionId from message, or legacy, or create new
      localSessionId = msg.sessionId || (tabId ? null : legacySessionId);

      // Single DB lookup — reused for workdir check, existence check, claude_session_id, and auto-title
      let existSess = localSessionId ? stmts.getSession.get(localSessionId) : null;

      // A terminal session is driven by a human through the terminal WebSocket and
      // must never be driven by the chat engine as well. Two drivers on one tmux
      // session is the exact failure the typed-session design exists to prevent:
      // the engine's paste-buffer lands in the same input box the human is typing
      // in, and paneBusy() reads the human's keystrokes as "agent still working"
      // until the 10-minute idle watchdog fires. Refuse instead of silently racing.
      if (existSess && existSess.kind === 'terminal') {
        proxy.send(JSON.stringify({ type: 'error', error: 'This is a terminal session — open it in the terminal view instead of sending chat messages.', ...(tabId ? { tabId } : {}) }));
        return;
      }

      // ── Bot mentions ────────────────────────────────────────────────────────
      // '@@handle' calls a bot; a single '@' remains the file-attachment trigger.
      // Resolution runs against EVERY handle, not just this project's, so a bot
      // that exists elsewhere gets a useful answer rather than silence.
      let mentionedBots = [], projectBots = [], botPrompt = msg.text || '';
      try {
        const allBots = stmts.listBots.all();
        if (allBots.length) {
          const wd = existSess?.workdir || msg.workdir || WORKDIR;
          const proj = loadProjects().find(pr => pr.workdir === wd);
          projectBots = proj ? stmts.listProjectBots.all(proj.id) : [];
          const available = new Set(projectBots.map(b => b.id));
          const parsed = botsLogic.parseMentions(msg.text || '', allBots.map(b => b.id));
          if (parsed.handles.length || (parsed.unknown || []).length) {
            botPrompt = parsed.cleaned || BARE_MENTION_PROMPT;
            const byId = new Map(allBots.map(b => [b.id, b]));
            mentionedBots = parsed.handles.filter(h => available.has(h)).map(h => byId.get(h));
            for (const h of parsed.handles.filter(x => !available.has(x))) {
              const label = byId.get(h)?.label || h;
              proxy.send(JSON.stringify({ type: 'text',
                text: `ℹ️ **@@${h}** (${label}) exists but is not in this project.\n`
                    + `Open the Bots panel and add it here, or mention a bot from this project.\n\n`,
                ...(tabId ? { tabId } : {}) }));
            }
            // '@@' states the intent outright, so an unknown handle is answered
            // rather than passed through as prose the assistant has to guess at.
            for (const h of (parsed.unknown || [])) {
              proxy.send(JSON.stringify({ type: 'text',
                text: `ℹ️ There is no bot **@@${h}**. Create one in the Bots panel.\n\n`,
                ...(tabId ? { tabId } : {}) }));
            }
          }
        }
      } catch (e) { log.warn('bot mention resolution failed', { err: e.message }); }

      // Validate workdir: if the session belongs to a different project, don't reuse it.
      if (existSess && msg.workdir && existSess.workdir && existSess.workdir !== msg.workdir) {
        log.warn('workdir mismatch — refusing to reuse session from different project', { sessionId: localSessionId, sessionWorkdir: existSess.workdir, msgWorkdir: msg.workdir });
        localSessionId = null;
        existSess = null;
      }

      let isNewSession = false;
      if (!localSessionId || !existSess) {
        localSessionId = genId();
        stmts.createSession.run(localSessionId,i18nSession(),'[]','[]',sqlVal(msg.mode)||'auto',sqlVal(msg.agentMode)||'single',sqlVal(msg.model)||'sonnet',sqlVal(msg.workdir)||null);
        isNewSession = true;
      } else {
        localClaudeId = sanitizeSessionId(existSess.claude_session_id) || undefined;
      }

      // For legacy (no tabId) mode, keep WS-level state in sync
      if (!tabId) { legacySessionId = localSessionId; }

      // Tell client which real session this tab is using (converts temp tab id → real session id)
      ws.send(JSON.stringify({ type:'session_started', sessionId:localSessionId, tabId }));

      // After session_started, use localSessionId as the effective tabId for all subsequent events.
      // The client renames the tab from tempId → localSessionId upon receiving session_started,
      // so further events must carry localSessionId (not the original temp tabId) to be routed correctly.
      effectiveTabId = tabId ? localSessionId : null;
      // Migrate _tabBusy/_tabAbort keys from tempId to real session id
      if (tabId && tabId !== localSessionId) {
        ws._tabBusy[localSessionId] = true; delete ws._tabBusy[tabId];
        activeChatSessions.add(localSessionId); activeChatSessions.delete(tabId);
        if (ws._tabQueue[tabId]) {
          const q = ws._tabQueue[tabId];
          // Fix: update tabId + sessionId in queued messages so they continue in the same session,
          // not create new ones. Without this, msgs queued before session_started (on a new tab)
          // had tabId:'new-abc'/sessionId:null and each created a fresh phantom session on dequeue.
          for (const m of q) { m.tabId = localSessionId; m.sessionId = localSessionId; }
          ws._tabQueue[localSessionId] = q; delete ws._tabQueue[tabId]; sessionQueues.set(localSessionId, q); sessionQueues.delete(tabId);
        }
      }

      const { text:userMessage, attachments=[], skills:sIds=[], mcpServers:mIds=[], mode='auto', agentMode='single', model='sonnet', maxTurns=30, workdir=null, reply_to=null, retry=false, autoSkill=false, effort=null, engine='api' } = msg;

      let replyQuote = '';
      if (reply_to && reply_to.content) {
        const snippet = String(reply_to.content).slice(0, 200);
        replyQuote = `[Replying to: ${reply_to.role || 'user'}: ${snippet}]\n\n`;
      }
      const replyToId = sqlVal(reply_to?.id ?? null);
      const engineMessage = replyQuote + userMessage;
      // Enrich SSH attachments with stored auth credentials (key path or decrypted password)
      const enrichedAttachments = attachments.map(att => {
        if (att.type !== 'ssh' || !att.hostId) return att;
        const hosts = loadRemoteHosts();
        const rh = hosts.find(h => h.id === att.hostId);
        if (!rh) return att;
        return { ...att, sshKeyPath: rh.sshKeyPath || '', password: decryptPassword(rh.password) || '' };
      });
      let userContent = buildUserContent(engineMessage, enrichedAttachments);
      const shouldReplaySessionHistory = !!existSess && !localClaudeId;
      let enginePrompt = engineMessage;

      if (!retry) {
        const attJson = attachments.length
          ? JSON.stringify(serializeMessageAttachments(attachments))
          : null;
        try { stmts.addMsg.run(localSessionId,'user','text',userMessage,null,null,replyToId,attJson); }
        catch (e) { log.error('addMsg(user) failed', { sessionId: localSessionId, replyToId, attJsonLen: attJson?.length, err: e.message, stack: e.stack }); throw e; }
      } else {
        try { stmts.incrementRetry.run(localSessionId); }
        catch (e) { log.error('incrementRetry failed', { sessionId: localSessionId, err: e.message, stack: e.stack }); }
      }

      // Load config early — needed for skill classification
      const config = loadMergedConfig();

      // Create AbortController EARLY — before classification — so that pressing
      // Stop during the 10-15s classification phase actually aborts this processChat.
      // Previously it was created AFTER classification, causing a race: Stop reset
      // _tabBusy but couldn't abort, allowing a second processChat to start in parallel.
      const abortController = new AbortController();
      myAbortController = abortController;
      if (effectiveTabId) ws._tabAbort[effectiveTabId] = abortController;
      else ws._abort = abortController;

      // ─── LLM-based task classification ──────────────────────────────
      // When autoSkill=true, classify the user message with haiku (~10-15s via CLI).
      // Returns both specialist skills AND a short chat title in one call.
      // Skip on resumed sessions (localClaudeId set) — skills already baked into session
      // context, no need to pay for a Haiku call on every subsequent message.
      let effectiveSkills = sIds;
      let classifiedTitle = '';
      const shouldClassify = autoSkill && !localClaudeId;
      log.info('[classify] start', { autoSkill, shouldClassify, sIds, msgLen: userMessage.length });
      if (shouldClassify) {
        try {
          proxy.send(JSON.stringify({ type:'agent_status', status:'⚡ Classifying task...', statusKey:'status.classifying', tabId: effectiveTabId }));
          const classification = await classifyTask(userMessage, sIds, config, workdir || WORKDIR);
          classifiedTitle = classification.title;
          // Merge classified skills into existing (not replace)
          const merged = new Set(sIds);
          for (const s of classification.skills) merged.add(s);
          effectiveSkills = [...merged];
          log.info('[classify] done', { newSkills: classification.skills, merged: effectiveSkills, title: classifiedTitle, msgPreview: userMessage.substring(0, 120) });
          if (effectiveSkills.length > 0) {
            proxy.send(JSON.stringify({ type:'skills_auto', skills: effectiveSkills, tabId: effectiveTabId }));
          }
        } catch (err) {
          log.error('[classify] Failed', { err: err.message });
          if (!effectiveSkills.length) effectiveSkills = config.skills['auto-mode'] ? ['auto-mode'] : [];
        }
      }

      // Bail out early if user pressed Stop during classification
      if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      try { stmts.updateConfig.run(JSON.stringify(mIds),JSON.stringify(effectiveSkills),sqlVal(mode),sqlVal(agentMode),sqlVal(model),sqlVal(workdir)||null,localSessionId); }
      catch (e) { log.error('updateConfig failed', { sessionId: localSessionId, mode, agentMode, model, mIdsLen: mIds.length, skillsLen: effectiveSkills.length, err: e.message, stack: e.stack }); throw e; }
      // Persist engine choice (coerce anything other than 'subscription' to 'api')
      try { db.prepare(`UPDATE sessions SET run_engine=? WHERE id=?`).run(engine === 'subscription' ? 'subscription' : 'api', localSessionId); } catch {}

      // Auto-title: use LLM-generated title if available, otherwise smart-truncate message
      if (isNewSession || DEFAULT_SESSION_TITLES.has(existSess?.title)) {
        let title = classifiedTitle;
        if (!title) {
          // Smart truncation: break at word boundary, max 40 chars
          const raw = userMessage.replace(/\s+/g, ' ').trim();
          if (!raw) {
            title = i18nSession();
          } else if (raw.length <= 40) {
            title = raw;
          } else {
            const cut = raw.lastIndexOf(' ', 40);
            title = raw.substring(0, cut > 15 ? cut : 40) + '…';
          }
        }
        try { stmts.updateTitle.run(title, localSessionId); } catch (e) { log.error('updateTitle failed', { err: e.message }); }
        ws.send(JSON.stringify({ type:'session_title', sessionId:localSessionId, title, tabId: effectiveTabId }));
      }

      // Build system prompt — cached by skill combination, skill files cached in memory.
      // Skipped on resumed sessions (localClaudeId set): claude-cli.js blocks --system-prompt
      // when --resume is used (cryptographic signatures on thinking blocks), so building
      // it would be pure waste. System prompt was already set on the first turn of this session.
      const systemPrompt = localClaudeId ? undefined : buildSystemPrompt(effectiveSkills, config);

      if (shouldReplaySessionHistory) {
        const replayContent = buildSessionReplayContent(localSessionId);
        if (replayContent?.length) {
          userContent = replayContent;
          enginePrompt = 'Continue this chat from the replayed history above. The latest user turn is included last. Respond to that latest user request.';
        }
      }

      const mcpServers = {};
      for (const mid of mIds) {
        const m = config.mcpServers[mid];
        if (!m) continue;
        if (m.type === 'http' || m.type === 'sse' || m.url) {
          mcpServers[mid] = { type: m.type || 'http', url: m.url, ...(m.headers ? { headers: m.headers } : {}), ...(m.env ? { env: expandTildeInObj(m.env) } : {}) };
        } else {
          mcpServers[mid] = { command: m.command, args: m.args || [], env: expandTildeInObj(m.env || {}) };
        }
      }

      // --- Internal MCPs (always injected, invisible to user) ---
      mcpServers['_ccs_ask_user'] = {
        command: NODE_CMD,
        args: [path.join(__dirname, 'mcp-ask-user.js')],
        env: {
          ASK_USER_SERVER_URL: `http://127.0.0.1:${PORT}`,
          ASK_USER_SESSION_ID: localSessionId,
          ASK_USER_SECRET: ASK_USER_SECRET,
        },
      };

      mcpServers['_ccs_notify'] = {
        command: NODE_CMD,
        args: [path.join(__dirname, 'mcp-notify.js')],
        env: {
          NOTIFY_SERVER_URL: `http://127.0.0.1:${PORT}`,
          NOTIFY_SESSION_ID: localSessionId,
          NOTIFY_SECRET: NOTIFY_SECRET,
        },
      };
      mcpServers['_ccs_set_ui_state'] = {
        command: NODE_CMD,
        args: [path.join(__dirname, 'mcp-set-ui-state.js')],
        env: {
          SET_UI_STATE_SERVER_URL: `http://127.0.0.1:${PORT}`,
          SET_UI_STATE_SESSION_ID: localSessionId,
          SET_UI_STATE_SECRET: SET_UI_STATE_SECRET,
        },
      };
      mcpServers['_ccs_user_interrupt'] = {
        command: NODE_CMD,
        args: [path.join(__dirname, 'mcp-user-interrupt.js')],
        env: {
          INTERRUPT_SERVER_URL: `http://127.0.0.1:${PORT}`,
          INTERRUPT_SESSION_ID: localSessionId,
          INTERRUPT_SECRET: INTERRUPT_SECRET,
        },
      };

      proxy.send(JSON.stringify({ type:'status', status:'thinking', mode, agentMode, model, tabId: effectiveTabId }));

      // Register task in activeTasks so it survives client disconnect/reload
      try { stmts.setLastUserMsg.run(userMessage, localSessionId); } catch (e) { log.error('setLastUserMsg failed', { err: e.message }); }
      chatBuffers.set(localSessionId, ''); // reset buffer for this session
      activeTasks.set(localSessionId, { proxy, abortController, cleanupTimer: null, source: 'web', startedAt: Date.now() });
      markActivityDirty();

      // Detect fork: if fork_from_cid is set, this is the first message in a forked session
      const _forkCid = existSess?.fork_from_cid || null;

      const _sessName = (existSess?.title && !DEFAULT_SESSION_TITLES.has(existSess.title)) ? existSess.title : null;
      const params = {
        prompt: enginePrompt,
        userContent,
        systemPrompt,
        mcpServers,
        model,
        maxTurns,
        ws: proxy,
        sessionId: localSessionId,
        abortController,
        claudeSessionId: localClaudeId,
        forkSession: !!_forkCid,
        mode,
        workdir: workdir || WORKDIR,
        tabId: effectiveTabId,
        name: _sessName,
        effort,
      };

      let newCid;
      let resultMeta = null;
      // Check if the active project is a remote SSH project
      const _activeProj = loadProjects().find(p => p.workdir === (workdir || WORKDIR) && p.isRemote);
      if (_activeProj) {
        // Route to SSH engine — runs claude on remote server
        const sshResult = await runSshSingle({
          ...params,
          remoteHost:   _activeProj.remoteHost,
          remoteWorkdir: _activeProj.workdir,
          sshKeyPath:   _activeProj.sshKeyPath || '',
          password:     decryptPassword(_activeProj.password) || '',
          port:         _activeProj.port || 22,
        });
        newCid = sshResult.cid;
        resultMeta = sshResult.resultMeta;
        // Track remote host on session for UI indicators
        try { db.prepare(`UPDATE sessions SET remote_host=? WHERE id=?`).run(_activeProj.remoteHost, localSessionId); } catch {}
      } else if (engine === 'subscription') {
        // Interactive tmux engine (Claude Max subscription billing) — module collects
        // output without touching SQLite; persistence mirrors runCliSingle's save phase.
        // Checked BEFORE multi-agent: multi runs through API-billed headless calls and
        // would silently override the user's explicit billing choice.
        if (agentMode === 'multi') {
          try { proxy.send(JSON.stringify({ type: 'text', text: 'ℹ️ Multi-agent mode uses the API engine — running in single-agent interactive mode instead.\n\n', tabId: effectiveTabId })); } catch {}
        }
        // The interactive engine has no hooks to inject, so it is handed a drain
        // function and types clarifications into the live pane itself.
        const r = await runInteractiveSingle({
          ...params,
          drainInterrupts: () => {
            const msgs = pendingInterrupts.get(localSessionId) || [];
            if (msgs.length) pendingInterrupts.delete(localSessionId);
            for (const m of msgs) { try { if (m.dbId) stmts.markInterruptDelivered.run(m.dbId); } catch {} }
            return msgs;
          },
        });
        for (const ev of r.toolEvents) {
          try { stmts.addMsg.run(localSessionId,'assistant','tool',(ev.input||'').substring(0,500),ev.name,null,null,null); } catch {}
        }
        if (r.fullThinking) { try { stmts.addMsg.run(localSessionId,'assistant','thinking',r.fullThinking,null,null,null,null); } catch {} }
        if (r.fullText) {
          try { stmts.addMsg.run(localSessionId,'assistant','text',r.fullText,null,null,null,null); } catch {}
          { const _cb = (chatBuffers.get(localSessionId) || '') + r.fullText; chatBuffers.set(localSessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        }
        newCid = r.cid;
        resultMeta = r.resultMeta;
      } else if (mentionedBots.length) {
        // @mentions take precedence over the agent-mode setting: naming a bot is an
        // explicit instruction about who answers, and it would be wrong to hand the
        // turn to the planner instead.
        // params.userContent was built from the RAW message (mention still in it, if
        // one was attached alongside a file) — claude-cli.js only drops an
        // attachment's trailing text block when it exactly equals the prompt text, so
        // passing the raw block next to the cleaned `botPrompt` would duplicate the
        // message (same class of bug fixed for the Telegram bot path).
        const botUserContent = buildUserContent(botPrompt, enrichedAttachments);
        newCid = await runBotTurns({ ...params, userContent: botUserContent }, { bots: mentionedBots, prompt: botPrompt, rosterBots: projectBots });
      } else if (agentMode==='multi') {
        newCid = await runMultiAgent(params);
      } else {
        const result = await runCliSingle(params);
        newCid = result.cid;
        resultMeta = result.resultMeta;
      }
      if (newCid) { try { stmts.updateClaudeId.run(newCid, localSessionId); } catch (e) { log.error('updateClaudeId failed', { cid: String(newCid).substring(0,50), sessionId: localSessionId, err: e.message, stack: e.stack }); } }
      // Catch-up cursor sync: everything in the transcript up to its current EOF is now
      // reflected in SQLite by this web turn (API via stdout, subscription via transcript
      // read). A later /catch-up therefore surfaces only bytes appended afterwards — i.e.
      // work done directly in an opened `claude --resume` terminal.
      if (newCid) { try { const _tsz = transcriptSize(newCid); if (_tsz != null) db.prepare(`UPDATE sessions SET transcript_offset=? WHERE id=?`).run(_tsz, localSessionId); } catch {} }
      // Clear fork flag after first successful CLI call — session now has its own claude_session_id
      if (_forkCid) { try { db.prepare(`UPDATE sessions SET fork_from_cid=NULL WHERE id=?`).run(localSessionId); } catch {} }

      const _dic = proxy._deliveredInterruptCount || 0;
      const _donePayload = { type:'done', tabId: effectiveTabId, duration: Date.now() - _chatStartedAt, ...(resultMeta ? { resultMeta } : {}), ...(_dic ? { deliveredInterruptCount: _dic } : {}) };
      proxy.send(JSON.stringify(_donePayload));
      // `done` is what clears a tab's busy dot. Other sockets watching this session
      // (a second window, or a background tab subscribed with noCatchUp:true — which
      // deliberately skips proxy.attach) are not behind this proxy, so without the
      // fan-out their spinner runs until the page is reloaded. Skip proxy._ws: it
      // already got the frame above.
      if (effectiveTabId) broadcastToSessionExcept(effectiveTabId, proxy._ws, _donePayload);
      proxy.send(JSON.stringify({ type:'files_changed' }));
      // Notify Telegram (if task was NOT started from Telegram — those get notified via TelegramProxy)
      if (telegramBot && telegramBot.isRunning()) {
        const _tgTask = activeTasks.get(localSessionId);
        if (!_tgTask || _tgTask.source !== 'telegram') {
          const _tgSess = stmts.getSession.get(localSessionId);
          telegramBot.notifyTaskComplete({
            sessionId: localSessionId,
            title: _tgSess?.title || 'Chat',
            status: 'done',
            duration: Date.now() - _chatStartedAt
          });
        }
      }
    } catch(err) {
      if(err.name==='AbortError') proxy.send(JSON.stringify({ type:'agent_status', status:'Stopped', statusKey:'status.stopped', tabId: effectiveTabId }));
      else { log.error('chat error', { message: err.message, name: err.name, stack: err.stack }); proxy.send(JSON.stringify({ type:'error', error:err.message, tabId: effectiveTabId })); }
      { const _dic = proxy._deliveredInterruptCount || 0;
        const _donePayload = { type:'done', tabId: effectiveTabId, duration: Date.now() - _chatStartedAt, ...(_dic ? { deliveredInterruptCount: _dic } : {}) };
        proxy.send(JSON.stringify(_donePayload));
        // Same fan-out as the success path — an aborted or failed turn must clear
        // every watcher's spinner, not just the originating socket's.
        if (effectiveTabId) broadcastToSessionExcept(effectiveTabId, proxy._ws, _donePayload); }
      // Notify Telegram about error (if task was NOT started from Telegram)
      if (telegramBot && telegramBot.isRunning() && err.name !== 'AbortError') {
        const _tgTask = activeTasks.get(localSessionId);
        if (!_tgTask || _tgTask.source !== 'telegram') {
          telegramBot.notifyTaskComplete({
            sessionId: localSessionId,
            title: stmts.getSession.get(localSessionId)?.title || 'Chat',
            status: 'error',
            error: err.message
          });
        }
      }
    } finally {
      // Guard: only delete activeTasks/chatBuffers if WE are the owner. In stop+new-chat
      // scenario, a newer processChat may have already called activeTasks.set() with its own
      // entry — blindly deleting would remove the new owner's task tracking.
      const _ownTask = activeTasks.get(localSessionId);
      if (!_ownTask || _ownTask.abortController === myAbortController) {
        activeTasks.delete(localSessionId);
        chatBuffers.delete(localSessionId); // cleanup in-memory buffer — only if we own the session
        markActivityDirty();
      }
      // Detect stale finally early: if a stop happened, ws._tabAbort was deleted or replaced
      // by a new processChat. In that case, another processChat now owns this tab — our
      // cleanup would stomp on its state. Skip session-specific cleanup and let the new owner handle it.
      const isStale = myAbortController !== null && (effectiveTabId
        ? ws._tabAbort?.[effectiveTabId] !== myAbortController
        : ws._abort !== myAbortController);
      if (!isStale) {
        const _drainedInterrupts = pendingInterrupts.get(localSessionId);
        pendingInterrupts.delete(localSessionId);
        cleanupInterruptAttachments(_drainedInterrupts);
        for (const [rid, entry] of pendingAskUser) {
          if (entry.sessionId === localSessionId) {
            clearTimeout(entry.timer);
            pendingAskUser.delete(rid);
            entry.resolve({ answer: '[Session ended]' });
          }
        }
        try { stmts.clearLastUserMsg.run(localSessionId); } catch {}
      }
      if (!isStale && effectiveTabId) {
        ws._tabBusy[effectiveTabId] = false;
        activeChatSessions.delete(effectiveTabId);
        delete ws._tabAbort[effectiveTabId];
        const tabQ = ws._tabQueue[effectiveTabId] || [];
        if (tabQ.length > 0) {
          const next = tabQ.shift();
          // Delete before running: see the table comment — losing one message on a
          // crash beats running the same turn twice.
          if (next?._dbQueueId) { try { stmts.delQueuedMsg.run(next._dbQueueId); } catch {} }
          if (tabQ.length === 0) { delete ws._tabQueue[effectiveTabId]; sessionQueues.delete(effectiveTabId); }
          try { ws.send(queuePayload(effectiveTabId)); } catch {}
          processChat(next).catch(err => log.error('processChat tab-queue error', { message: err.message }));
        } else {
          delete ws._tabQueue[effectiveTabId];
          sessionQueues.delete(effectiveTabId);
          try { ws.send(JSON.stringify({ type: 'queue_update', tabId: effectiveTabId, pending: 0, items: [] })); } catch {}
          // Fix: WS-reconnect scenario — old WS had empty queue but a newer WS (page refresh / network blip)
          // may have restored queue items from sessionQueues into its own _tabQueue (shared-ref).
          // Since the shared-ref persists after sessionQueues.delete, check sessionWatchers for a live
          // WS with pending items and fire _dequeue_next on it so the queue isn't stuck.
          setImmediate(() => {
            const watchers = sessionWatchers.get(effectiveTabId);
            if (!watchers) return;
            for (const liveWs of watchers) {
              if (liveWs !== ws && liveWs.readyState === 1 &&
                  liveWs._tabQueue?.[effectiveTabId]?.length > 0 &&
                  !liveWs._tabBusy?.[effectiveTabId] &&
                  !activeChatSessions.has(effectiveTabId) &&
                  !activeTasks.has(effectiveTabId)) {
                liveWs.emit('message', JSON.stringify({ type: '_dequeue_next', tabId: effectiveTabId }));
                break;
              }
            }
          });
        }
      } else if (!isStale) {
        ws._busy = false;
        ws._abort = null;
        if (ws._queue.length > 0) {
          const next = ws._queue.shift();
          try { ws.send(queuePayload(null)); } catch {}
          try { await processChat(next); } catch (err) { log.error('processChat legacy-queue error', { message: err.message }); }
        } else {
          try { ws.send(JSON.stringify({ type: 'queue_update', pending: 0, items: [] })); } catch {}
        }
      } else if (isStale && effectiveTabId) {
        // Fix: clean up activeChatSessions in stale path to prevent permanent session lock.
        // When WS disconnects during processChat, isStale becomes true because ws._tabAbort
        // was cleared by ws.on('close'). Without this cleanup, activeChatSessions retains the
        // session ID forever — all new messages get queued but never dequeued (stuck queue bug).
        // Only skip cleanup if a NEW processChat has taken over on this same WS (stop+new-chat
        // scenario where ws._tabAbort[effectiveTabId] holds the new controller).
        if (!ws._tabAbort?.[effectiveTabId]) {
          activeChatSessions.delete(effectiveTabId);
        }
        // Page refresh scenario: task finished on old (closed) WS but queue items
        // persist in sessionQueues. Trigger dequeue on the live WS that now owns this session.
        const pendingQueue = sessionQueues.get(effectiveTabId);
        if (pendingQueue?.length > 0) {
          setImmediate(() => {
            const watchers = sessionWatchers.get(effectiveTabId);
            if (!watchers) return;
            for (const liveWs of watchers) {
              if (liveWs.readyState === 1 &&
                  !activeChatSessions.has(effectiveTabId)) {
                liveWs.emit('message', JSON.stringify({ type: '_dequeue_next', tabId: effectiveTabId }));
                break;
              }
            }
          });
        }
      }
    }
  }

  ws.on('message', async (raw) => {
    let msg; try{msg=JSON.parse(raw)}catch{return}

    if (msg.type==='start_session') {
      legacySessionId = msg.sessionId || genId();
      const existing = stmts.getSession.get(legacySessionId);
      if (existing) {
        legacyClaudeId = sanitizeSessionId(existing.claude_session_id) || undefined;
        // Don't send session_started for existing sessions — the client's session_started
        // handler resets streaming.el which destroys the just-restored _bgTxt bubble on tab switch.
        // session_started is only needed for NEW sessions (to map temp tab ID → real session ID).
      } else {
        stmts.createSession.run(legacySessionId,i18nSession(),'[]','[]',sqlVal(msg.mode)||'auto',sqlVal(msg.agentMode)||'single',sqlVal(msg.model)||'sonnet',null);
        ws.send(JSON.stringify({ type:'session_started', sessionId:legacySessionId }));
      }
      return;
    }

    // Internal: dequeue next item after page refresh (triggered by stale finally block via setImmediate)
    // Internal: dequeue next queued message after page refresh or task completion on stale WS.
    // Triggered via setImmediate + emit('message') because processChat is scoped to each WS connection.
    if (msg.type === '_dequeue_next') {
      const tabId = msg.tabId;
      if (!tabId) return;
      // Guard: session may have been deleted while dequeue was pending
      if (!stmts.getSession.get(tabId)) { sessionQueues.delete(tabId); return; }
      if (ws._tabQueue[tabId]?.length > 0 && !ws._tabBusy[tabId] && !activeChatSessions.has(tabId) && !activeTasks.has(tabId)) {
        const next = ws._tabQueue[tabId].shift();
        if (ws._tabQueue[tabId].length === 0) { delete ws._tabQueue[tabId]; sessionQueues.delete(tabId); }
        ws.send(queuePayload(tabId));
        processChat(next).catch(err => log.error('processChat dequeue error', { message: err.message }));
      }
      return;
    }

    if (msg.type==='chat') {
      const tabId = msg.tabId || null;
      if (tabId) {
        // Per-tab concurrency: queue if this specific tab is busy (same WS connection),
        // another WS connection is processing this session (activeChatSessions), or
        // a Telegram/task worker is processing this session (activeTasks).
        if (ws._tabBusy[tabId] || activeChatSessions.has(tabId) || activeTasks.has(tabId)) {
          if (!ws._tabQueue[tabId]) {
            ws._tabQueue[tabId] = sessionQueues.get(tabId) || [];
            sessionQueues.set(tabId, ws._tabQueue[tabId]);
          }
          // Prevent unbounded queue growth
          if (ws._tabQueue[tabId].length >= 20) {
            // Hand the text back: the composer cleared it before sending, so a bare
            // error left the user with their message gone and no way to recover it.
            ws.send(JSON.stringify({ type: 'error', error: 'Queue full (max 20). Wait for current task to finish.', tabId,
              restoreText: msg.text || '', queueRejected: true }));
            return;
          }
          msg._queueId = ++ws._queueIdCounter;
          // Persist before enqueuing, so a crash between the two cannot leave a
          // message the user believes is waiting but which exists nowhere.
          try {
            const info = stmts.addQueuedMsg.run(tabId, JSON.stringify(msg));
            msg._dbQueueId = Number(info.lastInsertRowid);
          } catch (e) { log.warn('queue persist failed', { err: e.message }); }
          ws._tabQueue[tabId].push(msg);
          ws.send(queuePayload(tabId));
          return;
        }
      } else {
        // Legacy single-tab mode
        if (ws._busy) {
          msg._queueId = ++ws._queueIdCounter;
          ws._queue.push(msg);
          ws.send(queuePayload(null));
          return;
        }
      }
      processChat(msg).catch(err => log.error('processChat error', { message: err.message })); // don't await — allows parallel tabs
      return;
    }

    // ─── Mid-task interrupt: user sends clarification to running Claude process ───
    if (msg.type === 'interrupt') {
      const tabId = msg.tabId;
      const text = (msg.text || '').trim();
      const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
      if (!tabId || (!text && !hasAttachments)) return;

      // Nothing is running: this is not a clarification, it is a new message. Storing
      // it anyway meant it survived in memory and was injected into the NEXT,
      // unrelated run — the agent would suddenly react to a remark from a finished
      // task. The SPA sends `interrupt` while it still believes the tab is
      // generating, and the server may already have finished, so this window is
      // reached in normal use, not only under load.
      // hasRunningTask is essential here, not belt-and-braces: a Kanban task worker is
      // NOT registered in activeTasks (that map holds web and Telegram chat runs), so
      // without this check a clarification sent to a running task would be dispatched
      // as a fresh chat turn on the same session — two `claude --resume` processes on
      // one session id, which is the write race the rest of this file works to avoid.
      const _taskRunning = (() => { try { return !!stmts.hasRunningTask.get(tabId); } catch { return false; } })();
      if (!ws._tabBusy[tabId] && !activeTasks.has(tabId) && !activeChatSessions.has(tabId) && !_taskRunning) {
        log.info('[interrupt] session is idle — handling as a normal message', { tabId });
        processChat({
          type: 'chat',
          text,
          tabId,
          sessionId: tabId,
          attachments: Array.isArray(msg.attachments) ? msg.attachments : undefined,
          model: msg.model,
          workdir: msg.workdir,
        }).catch(err => log.error('processChat error', { message: err.message }));
        return;
      }

      // Store pending interrupt
      if (!pendingInterrupts.has(tabId)) pendingInterrupts.set(tabId, []);
      const queue = pendingInterrupts.get(tabId);
      if (queue.length >= 10) {
        ws.send(JSON.stringify({ type: 'error', error: 'Interrupt queue full (max 10).', tabId,
          restoreText: text || '', queueRejected: true }));
        return;
      }
      const interruptId = ++_interruptIdCounter;

      // Save to DB as a user message with special type, capture row ID for later delivery tracking
      let dbId = null;
      const rawAttachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      const attJson = rawAttachments.length ? JSON.stringify(serializeMessageAttachments(rawAttachments)) : null;
      try { const info = stmts.addMsg.run(tabId, 'user', 'interrupt', text, null, null, null, attJson); dbId = Number(info.lastInsertRowid); } catch {}

      const savedAttachments = saveInterruptAttachments(rawAttachments, tabId, interruptId, { enrichSsh: true });

      const interruptContent = text || (savedAttachments.length ? '[See attached files]' : '');
      queue.push({
        id: interruptId,
        content: interruptContent,
        attachments: savedAttachments.length ? savedAttachments : undefined,
        createdAt: new Date().toISOString(),
        dbId,
      });

      // Confirm to client
      ws.send(JSON.stringify({ type: 'interrupt_queued', interruptId, tabId, text: interruptContent }));

      log.info('[interrupt] queued', { sessionId: tabId, interruptId, textLen: text.length, attachments: savedAttachments.length });
      return;
    }

    if (msg.type==='stop') {
      const tabId = msg.tabId;
      if (tabId && ws._tabAbort && ws._tabAbort[tabId]) {
        // Stop specific tab — immediately mark as not busy so the next chat
        // message is processed directly instead of being queued (race condition fix).
        // The stale finally guard in processChat prevents the old finally from
        // resetting _tabBusy after a new processChat has already started.
        ws._tabBusy[tabId] = false;
        activeChatSessions.delete(tabId);
        if (ws._tabQueue) ws._tabQueue[tabId] = [];
        sessionQueues.delete(tabId);
        const _stoppedInterrupts = pendingInterrupts.get(tabId);
        pendingInterrupts.delete(tabId);
        cleanupInterruptAttachments(_stoppedInterrupts);
        ws._tabAbort[tabId].abort();
        delete ws._tabAbort[tabId];
      } else if (!tabId) {
        // Legacy (no-tab) stop — only abort the legacy controller, leave tab-mode untouched
        ws._queue = [];
        if (ws._abort) ws._abort.abort();
      }
      // Clear last_user_msg so reconnect doesn't auto-retry a user-stopped task
      if (tabId) { try { stmts.clearLastUserMsg.run(tabId); } catch {} }
      // tabId present but no active controller → tab is idle, nothing to abort
      // Also stop any Kanban task running under this session
      if (tabId) {
        const runningTask = db.prepare(`SELECT id, worker_pid FROM tasks WHERE session_id=? AND status='in_progress' LIMIT 1`).get(tabId);
        if (runningTask) {
          stoppingTasks.add(runningTask.id);
          db.prepare(`UPDATE tasks SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(runningTask.id);
          const ctrl = runningTaskAborts.get(runningTask.id);
          if (ctrl) { ctrl.abort(); }
          else if (runningTask.worker_pid) { killByPid(runningTask.worker_pid); }
          log.info('ws stop aborted kanban task', { taskId: runningTask.id, sessionId: tabId });
        }
      }
      // Resolve any pending ask_user questions for this session with "[Cancelled]"
      if (tabId) {
        for (const [rid, entry] of pendingAskUser) {
          if (entry.sessionId === tabId) {
            clearTimeout(entry.timer);
            pendingAskUser.delete(rid);
            entry.resolve({ answer: '[Cancelled]' });
          }
        }
      }
    }

    // ─── Queue management: remove / edit ────────────────────────────────────
    if (msg.type === 'queue_remove') {
      const { queueId, tabId: rmTabId } = msg;
      if (queueId) {
        // Remove from per-tab queue
        for (const [tid, queue] of Object.entries(ws._tabQueue || {})) {
          const idx = queue.findIndex(m => m.queueId === queueId);
          if (idx !== -1) {
            queue.splice(idx, 1);
            if (queue.length === 0) sessionQueues.delete(tid);
            ws.send(JSON.stringify({ type: 'queue_removed', queueId, tabId: tid }));
            ws.send(queuePayload(tid));
            break;
          }
        }
        // Also check legacy queue
        const li = ws._queue.findIndex(m => m.queueId === queueId);
        if (li !== -1) {
          ws._queue.splice(li, 1);
          ws.send(JSON.stringify({ type: 'queue_removed', queueId }));
          ws.send(queuePayload(null));
        }
      }
      return;
    }

    if (msg.type === 'queue_edit') {
      const { queueId, text } = msg;
      if (queueId && text != null) {
        // Update in per-tab queues
        for (const queue of Object.values(ws._tabQueue || {})) {
          const item = queue.find(m => m.queueId === queueId);
          if (item) { item.text = text; break; }
        }
        // Also check legacy queue
        const legacyItem = ws._queue.find(m => m.queueId === queueId);
        if (legacyItem) legacyItem.text = text;
        ws.send(JSON.stringify({ type: 'queue_edited', queueId }));
      }
      return;
    }

    // ─── Session restart (manual recovery from broken sessions) ───────────
    if (msg.type === 'restart_session') {
      const sessionId = msg.sessionId || msg.tabId;
      if (!sessionId) return;

      const session = stmts.getSession.get(sessionId);
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', error: 'Session not found', tabId: sessionId }));
        return;
      }

      const task = activeTasks.get(sessionId);
      if (task && !task.abortController?.signal?.aborted) {
        ws.send(JSON.stringify({ type: 'error', error: 'Task is still running', tabId: sessionId }));
        return;
      }

      // Get user messages from the session to transfer context
      const userMessages = stmts.getMsgsLite.all(sessionId).filter(m => m.role === 'user');

      // Clear broken Claude session state so the next user turn starts truly fresh.
      try { stmts.updateClaudeId.run(null, sessionId); } catch {}
      try { stmts.clearLastUserMsg.run(sessionId); } catch {}
      try { stmts.setPartialText.run(null, sessionId); } catch {}

      // Notify client that session was successfully reset and ready for a fresh Claude session
      log.info('session restart cleared claude_session_id', { sessionId, userMessages: userMessages.length });
      ws.send(JSON.stringify({
        type: 'session_restart_done',
        sessionId,
        tabId: sessionId,
        userMessages: userMessages.length > 0
      }));
      return;
    }

    // ─── Ask User responses ──────────────────────────────────────────────────
    if (msg.type === 'ask_user_response') {
      const entry = pendingAskUser.get(msg.requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingAskUser.delete(msg.requestId);
        entry.resolve({ answer: msg.answer || '[Empty response]' });
        // Clean up Telegram pending ask state (prevents stale intercept swallowing next message)
        _clearTelegramAskState(entry.sessionId);
      }
      return;
    }

    if (msg.type === 'ask_user_cancel') {
      const entry = pendingAskUser.get(msg.requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingAskUser.delete(msg.requestId);
        entry.resolve({ answer: '[Skipped by user]' });
        _clearTelegramAskState(entry.sessionId);
      }
      return;
    }

    if (msg.type==='new_session') {
      ws._queue = [];
      if (ws._abort) ws._abort.abort();
      legacySessionId=null; legacyClaudeId=undefined;
      ws.send(JSON.stringify({ type:'session_reset' }));
    }

    if (msg.type==='new_session_silent') {
      // Reset server state for a specific tab without sending session_reset back
      // (used when client auto-creates a tab and sends first message)
      // Nothing to do here since processChat now uses per-message sessionId
      // Just clear legacy state if no tabId involved
    }

    if (msg.type === 'subscribe_session') {
      const { sessionId, noCatchUp } = msg;
      if (sessionId) {
        // Allow multi-session watching: do NOT remove from other sessions.
        // Cleanup happens on WS disconnect (ws.on('close') handler).
        if (!sessionWatchers.has(sessionId)) sessionWatchers.set(sessionId, new Set());
        sessionWatchers.get(sessionId).add(ws);
        // Catch up new subscriber with any already-running task (unless suppressed)
        if (!noCatchUp) {
          const runningTask = db.prepare(
            `SELECT * FROM tasks WHERE session_id=? AND status='in_progress' LIMIT 1`
          ).get(sessionId);
          if (runningTask && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'task_started', taskId: runningTask.id, title: runningTask.title, tabId: sessionId }));
            const buf = taskBuffers.get(runningTask.id);
            if (buf) ws.send(JSON.stringify({ type: 'text', text: buf, tabId: sessionId }));
          } else if (!activeTasks.has(sessionId)) {
            // Check for interrupted chat session (server crash recovery).
            // Only when no live task exists in memory — prevents false interrupts on WS hiccup.
            // isSessionLive() (not activeTasks alone) because a turn that is still in the
            // pre-activeTasks phase of processChat is live, not interrupted: announcing a
            // retry there would offer to re-run a turn that is already running.
            const sess = isSessionLive(sessionId) ? null : stmts.getSession.get(sessionId);
            if (sess?.last_user_msg && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'task_interrupted', sessionId, tabId: sessionId, prompt: sess.last_user_msg, retryCount: sess.retry_count || 0 }));
            }
          } else {
            const activeTask = activeTasks.get(sessionId);
            // Guard: abort() may have been called (timer fired or user stopped) but the
            // subprocess hasn't exited yet so the entry is still in activeTasks.
            // Reattaching the proxy to a dying stream would leave the client waiting
            // forever for output that will never arrive.
            if (activeTask.abortController.signal.aborted) {
              // Stream is being killed — treat as interrupted so client can retry.
              const sess = stmts.getSession.get(sessionId);
              if (sess?.last_user_msg && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'task_interrupted', sessionId, tabId: sessionId, prompt: sess.last_user_msg, retryCount: sess.retry_count || 0 }));
              }
            } else {
              // Chat task is running normally — cancel cleanup timer and reattach proxy.
              if (activeTask.cleanupTimer) { clearTimeout(activeTask.cleanupTimer); activeTask.cleanupTimer = null; }
              // Replay ALL accumulated text from the start so the client never has a gap.
              // chatBuffers holds everything from onText since the session started.
              const chatBuf = chatBuffers.get(sessionId);
              if (chatBuf && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'text', text: chatBuf, tabId: sessionId, catchUp: true }));
              }
              // Keep non-text events from proxy buffer (tool activity, done, error, status).
              // Text is already replayed via chatBuf above — discard text/thinking to avoid duplication.
              if (Array.isArray(activeTask.proxy._buffer)) {
                activeTask.proxy._buffer = activeTask.proxy._buffer.filter(raw => {
                  try { const d = JSON.parse(raw); return d.type !== 'text' && d.type !== 'thinking'; } catch { return false; }
                });
              }
              activeTask.proxy.attach(ws);
              ws._tabAbort[sessionId] = activeTask.abortController;
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'task_resumed', sessionId, tabId: sessionId }));
              // Re-send any pending ask_user questions for this session
              for (const [rid, entry] of pendingAskUser) {
                if (entry.sessionId === sessionId && ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'ask_user', requestId: rid, question: entry.question, questions: entry.questions, tabId: sessionId }));
                }
              }
            }
          }
        }
        // Cancel any pending delayed cleanup — a live WS is reclaiming this session
        const _cleanupTimer = sessionQueueCleanupTimers.get(sessionId);
        if (_cleanupTimer) { clearTimeout(_cleanupTimer); sessionQueueCleanupTimers.delete(sessionId); }
        // Fix: clean up orphaned activeChatSessions entry on subscribe.
        // A previous WS disconnect during processChat can leave activeChatSessions with a stale
        // entry that permanently blocks queue dequeue. Detect: session is in activeChatSessions
        // but no live WS has _tabBusy=true and no activeTasks entry exists → orphaned lock.
        if (activeChatSessions.has(sessionId) && !activeTasks.has(sessionId)) {
          let _anyBusy = false;
          for (const client of wss.clients) {
            if (client._tabBusy?.[sessionId]) { _anyBusy = true; break; }
          }
          if (!_anyBusy) {
            activeChatSessions.delete(sessionId);
            log.warn('subscribe: cleaned orphaned activeChatSessions', { sessionId });
          }
        }
        // Restore queue from persistent storage (survives page refresh / WS reconnect)
        if (!ws._tabQueue[sessionId]?.length && sessionQueues.has(sessionId) && sessionQueues.get(sessionId).length > 0) {
          ws._tabQueue[sessionId] = sessionQueues.get(sessionId); // shared ref
        }
        // Re-send queue state so client can restore queued message badges after tab switch
        if (ws._tabQueue?.[sessionId]?.length > 0 && ws.readyState === 1) {
          ws.send(queuePayload(sessionId));
          // If the session is idle (task already finished while WS was disconnected),
          // immediately start processing the first queued item.
          if (!ws._tabBusy[sessionId] && !activeTasks.has(sessionId) && !activeChatSessions.has(sessionId)) {
            setImmediate(() => {
              if (ws.readyState === 1) {
                ws.emit('message', JSON.stringify({ type: '_dequeue_next', tabId: sessionId }));
              }
            });
          }
        }
      }
      return;
    }

    // ─── Task Dispatch: decompose + dispatch to Kanban ─────────────────────
    if (msg.type === 'dispatch_plan') {
      (async () => {
        try {
          const { text, plan, agents, sessionId, workdir, model, tabId, effort = null } = msg;
          let finalPlan, finalAgents;

          // Save user's dispatch text to DB (so it survives page refresh)
          if (text && sessionId) {
            try { stmts.addMsg.run(sessionId, 'user', 'text', text, null, null, null, null); } catch {}
          }

          if (plan && agents?.length) {
            // Mode 1: Plan already provided (from agent_plan card "📋 Kanban" button)
            finalPlan = plan;
            finalAgents = agents;
          } else if (text) {
            // Mode 2: Decompose first (from "Plan" agent mode)
            ws.send(JSON.stringify({ type: 'agent_status', agent: 'orchestrator', status: 'Planning...', statusKey: 'agent.planning', ...(tabId ? { tabId } : {}) }));

            const effectiveWorkdir = workdir || WORKDIR;
            const cli = new ClaudeCLI({ cwd: effectiveWorkdir });
            const planPrompt = `You are a lead architect. Break this into 2-5 subtasks. Respond ONLY in JSON:\n{"plan":"...","agents":[{"id":"agent-1","role":"...","task":"...","depends_on":[]}]}\n\nTASK: ${text}`;

            // Mirror runMultiAgent's plan schema so the Kanban dispatcher gets the
            // same structured-output guarantee — no regex extraction, no fallback.
            const planSchema = {
              type: 'object',
              properties: {
                plan: { type: 'string' },
                agents: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      role: { type: 'string' },
                      task: { type: 'string' },
                      depends_on: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['id', 'role', 'task'],
                  },
                },
              },
              required: ['plan', 'agents'],
            };

            const session = sessionId ? stmts.getSession.get(sessionId) : null;
            let planText = '';

            await new Promise(resolve => {
              let done = false;
              // Same hardening as runMultiAgent's plan call: tools='' disables built-in tools,
              // settingSources='' skips CLAUDE.md + skills, --json-schema makes the model emit
              // via the synthetic StructuredOutput tool — captured in .onTool below.
              cli.send({ prompt: planPrompt, sessionId: sanitizeSessionId(session?.claude_session_id), model: model || 'sonnet', maxTurns: 1, allowedTools: [], tools: '', settingSources: '', jsonSchema: planSchema })
                .onText(t => { planText += t; })
                .onTool((name, input) => { if (name === 'StructuredOutput' && input) planText = typeof input === 'string' ? input : JSON.stringify(input); })
                .onError(() => { if (!done) { done = true; resolve(); } })
                .onDone(() => { if (!done) { done = true; resolve(); } });
            });

            try {
              const m = planText.match(/\{[\s\S]*\}/);
              const parsed = m ? JSON.parse(m[0]) : null;
              finalPlan = parsed?.plan;
              finalAgents = parsed?.agents;
            } catch {}

            if (!finalAgents?.length) {
              ws.send(JSON.stringify({ type: 'error', error: 'Failed to decompose task into subtasks', ...(tabId ? { tabId } : {}) }));
              return;
            }

            // Show plan in chat & save as agent_plan message (restorable on refresh)
            ws.send(JSON.stringify({ type: 'agent_plan', plan: finalPlan, agents: finalAgents.map(a => ({ id: a.id, role: a.role, task: a.task })), dispatched: true, ...(tabId ? { tabId } : {}) }));
            try {
              if (sessionId) {
                const agentPlanJson = JSON.stringify({ plan: finalPlan, agents: finalAgents.map(a => ({ id: a.id, role: a.role, task: a.task })), dispatched: true });
                stmts.addMsg.run(sessionId, 'assistant', 'agent_plan', agentPlanJson, null, 'orchestrator', null, null);
              }
            } catch {}
          } else {
            ws.send(JSON.stringify({ type: 'error', error: 'No plan or text provided for dispatch', ...(tabId ? { tabId } : {}) }));
            return;
          }

          // Save agent_plan to DB for Mode 1 (plan from 📋 Kanban button — wasn't saved above)
          if (plan && agents?.length && sessionId) {
            try {
              const agentPlanJson = JSON.stringify({ plan: finalPlan, agents: finalAgents.map(a => ({ id: a.id, role: a.role, task: a.task })), dispatched: true });
              stmts.addMsg.run(sessionId, 'assistant', 'agent_plan', agentPlanJson, null, 'orchestrator', null, null);
            } catch {}
          }

          // Circular dependency check
          const adj = {};
          for (const a of finalAgents) adj[a.id] = a.depends_on || [];
          const _v = new Set(), _s = new Set();
          function _cyc(n) { if (_s.has(n)) return true; if (_v.has(n)) return false; _v.add(n); _s.add(n); for (const d of (adj[n]||[])) { if (_cyc(d)) return true; } _s.delete(n); return false; }
          if (finalAgents.some(a => _cyc(a.id))) {
            ws.send(JSON.stringify({ type: 'error', error: 'Circular dependency detected in plan', ...(tabId ? { tabId } : {}) }));
            return;
          }

          // Create chain session + tasks
          const chainId = genId();
          const source = sessionId ? stmts.getSession.get(sessionId) : null;
          const chainSessionId = genId();
          stmts.createSession.run(
            chainSessionId,
            (finalPlan || 'Task chain').substring(0, 200),
            source?.active_mcp || '[]',
            source?.active_skills || '[]',
            'auto', 'single', sqlVal(model) || 'sonnet',
            sqlVal(workdir) || null
          );
          // Register chain in task_chains table
          stmts.createChain.run(chainId, (finalPlan || 'Task chain').substring(0, 200),
            sqlVal(workdir) || null, sqlVal(model) || 'sonnet', 'auto', 'single', 30,
            chainSessionId, null, null, null, sessionId || null, 0, sqlVal(effort) || null);
          // Chain gets its OWN Claude session — first task starts fresh,
          // subsequent tasks --resume from the chain's session (NOT the source chat's).
          // Sharing claude_session_id with source chat causes context mixing chaos.

          // First pass: assign real IDs (handles forward references in depends_on)
          const idMap = {};
          for (const a of finalAgents) idMap[a.id] = genId();
          const created = [];

          db.transaction(() => {
            for (let i = 0; i < finalAgents.length; i++) {
              const a = finalAgents[i];
              const taskId = idMap[a.id];
              const realDeps = (a.depends_on || []).map(d => idMap[d]).filter(Boolean);
              stmts.createTask.run(
                taskId,
                (a.role || 'Subtask').substring(0, 200),
                (a.task || '').substring(0, 2000),
                '', 'todo', i, chainSessionId, sqlVal(workdir) || null,
                sqlVal(model) || 'sonnet', 'auto', 'single', 30, null,
                realDeps.length ? JSON.stringify(realDeps) : null,
                chainId, sessionId || null,
                null, null, null,  // scheduled_at, recurrence, recurrence_end_at
                sqlVal(a.effort || effort) || null,
                sqlVal(a.run_engine || source?.run_engine) || null  // run_engine: per-agent override else inherit source session
              );
              created.push(stmts.getTask.get(taskId));
            }
          })();

          setImmediate(processQueue);

          // Notify client
          const _kanbanCtx = tabId ? getNotificationContext(tabId) : { sessionTitle: null, projectName: null };
          ws.send(JSON.stringify({
            type: 'notification', level: 'success',
            title: 'Dispatched to Kanban',
            detail: `${created.length} tasks created`,
            ...(tabId ? { tabId } : {}),
            sessionTitle: _kanbanCtx.sessionTitle, projectName: _kanbanCtx.projectName,
          }));

          // Send chain info so frontend can render progress widget
          ws.send(JSON.stringify({
            type: 'chain_dispatched',
            chain_id: chainId,
            session_id: chainSessionId,
            tasks: created.map(t => ({ id: t.id, title: t.title, status: t.status, depends_on: t.depends_on })),
            ...(tabId ? { tabId } : {}),
          }));

          // Auto-watch the chain session to stream results back to source chat
          if (!sessionWatchers.has(chainSessionId)) sessionWatchers.set(chainSessionId, new Set());
          sessionWatchers.get(chainSessionId).add(ws);

          log.info('Plan dispatched via WS', { chainId, count: created.length });
        } catch (e) {
          log.error('dispatch_plan error', { error: e.message });
          ws.send(JSON.stringify({ type: 'error', error: `Dispatch failed: ${e.message}`, ...(msg.tabId ? { tabId: msg.tabId } : {}) }));
        }
      })();
      return;
    }

    if (msg.type === 'resume_task') {
      const { sessionId, tabId } = msg;
      const task = activeTasks.get(sessionId);
      if (task) {
        // Guard: abort() may have been called (user stopped, or idle timer fired) but the
        // subprocess hasn't exited yet so the entry is still in activeTasks.
        if (task.abortController.signal.aborted) {
          const session = stmts.getSession.get(sessionId);
          if (session?.last_user_msg) {
            ws.send(JSON.stringify({ type: 'task_interrupted', sessionId, tabId, prompt: session.last_user_msg, retryCount: session.retry_count || 0 }));
          } else {
            ws.send(JSON.stringify({ type: 'task_lost', sessionId, tabId }));
          }
        } else {
          // Task is still running — cancel cleanup timer and re-attach to new WS
          if (task.cleanupTimer) { clearTimeout(task.cleanupTimer); task.cleanupTimer = null; }
          // Replay all accumulated text before re-attaching so the client has no gap
          const chatBuf = chatBuffers.get(sessionId);
          if (chatBuf && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'text', text: chatBuf, tabId: tabId || sessionId, catchUp: true }));
          }
          // Keep non-text events (tool, done, error, status) — discard text/thinking
          // to avoid duplication with chatBuf replay above
          if (Array.isArray(task.proxy._buffer)) {
            task.proxy._buffer = task.proxy._buffer.filter(raw => {
              try { const d = JSON.parse(raw); return d.type !== 'text' && d.type !== 'thinking'; } catch { return false; }
            });
          }
          task.proxy.attach(ws);
          if (tabId) ws._tabAbort[tabId] = task.abortController;
          ws.send(JSON.stringify({ type: 'task_resumed', sessionId, tabId }));
        }
      } else {
        // Task not in memory — check if it was interrupted (server crash)
        const session = stmts.getSession.get(sessionId);
        if (session?.last_user_msg) {
          ws.send(JSON.stringify({ type: 'task_interrupted', sessionId, tabId, prompt: session.last_user_msg, retryCount: session.retry_count || 0 }));
        } else {
          ws.send(JSON.stringify({ type: 'task_lost', sessionId, tabId }));
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    log.info('ws disconnected', { clients: wss.clients.size - 1 });
    ws._queue = [];
    // Clean up session watchers
    for (const [sid, set] of sessionWatchers) { set.delete(ws); if (!set.size) sessionWatchers.delete(sid); }
    // Detach from active task proxies — tasks keep running in background
    for (const [sid, task] of activeTasks) {
      if (task.proxy._ws === ws) {
        task.proxy.detach();
        if (TASK_DISCONNECT_TIMEOUT_MS > 0 && !task.cleanupTimer) {
          task.cleanupTimer = setTimeout(() => {
            log.info('task disconnect timeout, aborting', { sessionId: sid });
            try { task.abortController.abort(); } catch {}
            activeTasks.delete(sid);
          }, TASK_DISCONNECT_TIMEOUT_MS);
        }
      }
    }
    // Abort legacy (no-tab) session tasks only
    if (ws._abort) { ws._abort.abort(); ws._abort = null; }
    // WS-1: clean up per-tab state — abort CLI runs that are NOT tracked in activeTasks.
    // Sessions in activeTasks have a disconnect timeout (TASK_DISCONNECT_TIMEOUT_MS,
    // default 30 min, 0 = never) and can be reattached on reconnect. A run is only
    // registered there after prompt classification, so this loop also covers the first
    // seconds of a run — TASK_DISCONNECT_TIMEOUT_MS=0 must be honoured here too, or
    // "never abort on disconnect" would silently not hold for a run that just started.
    if (TASK_DISCONNECT_TIMEOUT_MS > 0) {
      for (const [tid, ac] of Object.entries(ws._tabAbort || {})) {
        if (!activeTasks.has(tid)) { try { ac.abort(); } catch {} }
      }
    }
    // Clean up orphaned sessionQueues entries: if no other watcher and no active task,
    // the queue will never be processed — schedule delayed removal to prevent memory leak.
    // Delay is needed because on page refresh the new WS hasn't subscribed yet when the
    // old WS close fires, creating a race where the queue is deleted before reconnect.
    for (const tid of Object.keys(ws._tabQueue || {})) {
      const watchers = sessionWatchers.get(tid);
      const hasOtherWatcher = watchers && [...watchers].some(w => w !== ws && w.readyState === 1);
      if (!hasOtherWatcher && !activeTasks.has(tid)) {
        const q = sessionQueues.get(tid);
        if (!q || q.length === 0) {
          // Empty queue — delete immediately, no data to preserve
          sessionQueues.delete(tid);
        } else {
          // Non-empty queue — delay cleanup to give reconnecting WS time to reclaim it
          if (!sessionQueueCleanupTimers.has(tid)) {
            const timer = setTimeout(() => {
              sessionQueueCleanupTimers.delete(tid);
              const currentWatchers = sessionWatchers.get(tid);
              const hasLiveWatcher = currentWatchers && [...currentWatchers].some(w => w.readyState === 1);
              if (!hasLiveWatcher && !activeTasks.has(tid)) {
                sessionQueues.delete(tid);
              }
            }, 30_000);
            sessionQueueCleanupTimers.set(tid, timer);
          }
        }
      }
    }
    ws._tabAbort = {};
    ws._tabBusy  = {};
    ws._tabQueue = {};
  });
});

// Seed default slash commands on startup so they are available immediately
// (not deferred until the first config-write operation).
loadConfig();

// Initialize tunnel manager
initTunnelManager();

// Start Telegram bot if configured
initTelegramBot();

// Restore delegations from .crosswork/*/state.json (survives server restarts)
restoreDelegations();

// Terminal error handler — MUST be last (after every route). Returns JSON
// instead of leaking an HTML stack trace with filesystem paths on e.g. a
// malformed JSON body (audit H7).
app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err?.status || err?.statusCode || 500;
  const body = err?.type === 'entity.parse.failed' ? { error: 'invalid_json' } : { error: 'internal_error' };
  try { log.warn('request error', { status, msg: err?.message }); } catch {}
  res.status(status).json(body);
});

// ─── Terminal reaper ─────────────────────────────────────────────────────────
// Agents are expensive and tmux is not — measured RSS: opencode ~1.8 GB, claude
// ~1 GB, tmux server 3.7 MB. So the target is the agent process.
//
// Every check short-circuits to "keep", cheapest first:
//   1. attached          — somebody is watching
//   2. session age       — never reap something just created
//   3. window_activity   — cheap idle filter. NOT session_activity: that one does
//                          not move when the pane produces output (measured), so a
//                          reaper built on it would kill working agents.
//   4. pane hash x2      — the decisive busy check. A redrawing pane means the
//                          agent is working, and killing it mid-edit can leave a
//                          half-written file on disk. Resume restores the
//                          conversation; it does not restore that file.
function startTerminalReaper({ intervalMs = 60000 } = {}) {
  if (!termBridge.tmuxAvailable()) return null;
  const tick = async () => {
    try {
      const cfg = loadConfig();
      if (cfg.terminal?.enabled !== true) return;
      const idleThresholdSec = Math.max(60, (cfg.terminal?.idleTimeoutMin ?? 30) * 60);
      const maxLive = cfg.terminal?.maxLive ?? 3;

      const live = termBridge.listTerminalSessions()
        .map(name => ({ name, ...termBridge.sessionInfo(name) }))
        .filter(s => s.exists);
      if (!live.length) return;

      // Over-cap sessions are closed because of the cap, not because they are idle
      // long enough — so they skip the idle threshold but still face the busy check.
      const overflow = new Set(pickOverflow(live, maxLive));
      const candidates = live.filter(s => overflow.has(s.name)
        || isReapCandidate({ attached: s.attached, idleSec: s.activityAgeSec, sessionAgeSec: s.ageSec, idleThresholdSec }));
      if (!candidates.length) return;

      const first = new Map();
      for (const s of candidates) first.set(s.name, termBridge.paneHash(s.name));
      await new Promise(r => setTimeout(r, 3000));

      for (const s of candidates) {
        const info = termBridge.sessionInfo(s.name);
        if (!info.exists || info.attached > 0) continue;   // someone connected meanwhile
        const decided = shouldReap({
          attached: info.attached,
          idleSec: info.activityAgeSec,
          sessionAgeSec: info.ageSec,
          paneHashA: first.get(s.name),
          paneHashB: termBridge.paneHash(s.name),
          idleThresholdSec: overflow.has(s.name) ? 0 : idleThresholdSec,
          minAgeSec: overflow.has(s.name) ? 0 : undefined,
        });
        if (!decided) continue;
        const sid = s.name.slice('ccsterm-'.length);
        // Keep the picture the user last saw: it is replayed on the next open.
        termBridge.saveScrollback(s.name, path.join(os.tmpdir(), `ccsterm-sb-${sid}.txt`));
        termBridge.killSession(s.name);
        log.info('terminal session reaped', { name: s.name, idleSec: info.activityAgeSec, overCap: overflow.has(s.name) });
      }
    } catch (e) {
      log.warn('terminal reaper failed', { msg: e?.message });
    }
  };
  return setInterval(tick, intervalMs);
}

// Restore queued chat messages left by a previous process. They never started —
// dequeue deletes the row before the run begins — so re-queuing them cannot
// duplicate work. They land in sessionQueues and the next WebSocket that owns the
// session drains them, exactly as a live queue would.
try {
  const rows = stmts.allQueuedMsgs.all();
  if (rows.length) {
    let restored = 0;
    for (const row of rows) {
      let msg = null;
      try { msg = JSON.parse(row.payload); } catch { }
      if (!msg || !row.session_id) { try { stmts.delQueuedMsg.run(row.id); } catch {} ; continue; }
      msg._dbQueueId = row.id;
      if (!sessionQueues.has(row.session_id)) sessionQueues.set(row.session_id, []);
      sessionQueues.get(row.session_id).push(msg);
      restored++;
    }
    if (restored) log.info('restored queued messages from a previous run', { count: restored });
  }
} catch (e) { log.warn('queue restore failed', { err: e.message }); }

// The `tmux -C` clients are children of this process and SURVIVE a studio restart,
// staying attached and pinning session_attached above zero — which would stop the
// reaper from ever firing. Drop them before anything else can attach.
try {
  if (termBridge.tmuxAvailable()) {
    for (const name of termBridge.listTerminalSessions()) termBridge.detachClients(name);
  }
} catch {}
startTerminalReaper({ intervalMs: 60000 });

server.listen(...(process.env.CCS_DESKTOP === '1' ? [PORT, '127.0.0.1'] : [PORT]), () => {
  log.info('server started', {
    port:      PORT,
    url:       `http://localhost:${PORT}`,
    workdir:   WORKDIR,
    setup:     auth.isSetupDone() ? 'done' : 'required',
    nodeEnv:   process.env.NODE_ENV || 'development',
    logLevel:  process.env.LOG_LEVEL || 'info',
    telegram:  telegramBot?.isRunning() ? 'running' : 'off',
    tunnel:    tunnelManager?.isRunning() ? tunnelManager.getStatus().publicUrl : 'off',
  });
});

// Safety net: log unhandled rejections instead of crashing the process.
// All known async paths have explicit .catch() — this catches any that slipped through.
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { message: reason?.message || String(reason), stack: reason?.stack });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n⚠️  ${signal} received — shutting down gracefully…`);

  // 0. Stop tunnel first (close external access immediately)
  if (tunnelManager?.isRunning()) { tunnelManager.stop(); }

  // 0b. Stop Telegram bot
  if (telegramBot) { telegramBot.stop(); telegramBot = null; }

  // 0c. Close delegation watchers
  for (const [, d] of activeDelegations) {
    if (d.watcher) { try { d.watcher.close(); } catch {} }
  }
  activeDelegations.clear();

  // 1. Abort all running Claude subprocesses
  wss.clients.forEach(ws => {
    ws._queue = [];
    if (ws._abort) { try { ws._abort.abort(); } catch {} }
    if (ws._tabAbort) { Object.values(ws._tabAbort).forEach(ac => { try { ac.abort(); } catch {} }); }
    // Close WebSocket with "server going down" code so clients reconnect
    try { ws.close(1001, 'Server shutting down'); } catch {}
  });

  // 2. Force-exit after 10 s if server.close() hangs (long-lived WS connections)
  const forceExit = setTimeout(() => {
    console.error('⚠️  Force exit after 10 s timeout');
    try { db.pragma('optimize'); db.close(); } catch {}
    process.exit(1);
  }, 10000);
  forceExit.unref(); // don't keep the event loop alive just for this timer

  // 3. Stop accepting new HTTP connections; wait for in-flight requests
  server.close(() => {
    clearTimeout(forceExit);
    try { db.pragma('optimize'); } catch {} // update query planner stats
    db.close();
    console.log('✅ Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
