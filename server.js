const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const { execSync, spawn: spawnProc } = require('child_process');
const crypto = require('crypto');
const multer = require('multer');
const openDatabase = require('./db-adapter');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const auth = require('./auth');
const ClaudeCLI = require('./claude-cli');
const ClaudeSSH = require('./claude-ssh');
const { testSshConnection } = require('./claude-ssh');
const TelegramBot = require('./telegram-bot');
const TunnelManager = require('./tunnel-manager');

// ─── Load .env file (no external dependency needed) ───────────────────────
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

const PORT = process.env.PORT || 3000;
// When launched via npx/global install, cli.js sets APP_DIR to cwd so user
// data persists in the user's directory, not inside the npm cache.
const APP_DIR = process.env.APP_DIR || __dirname;
const WORKDIR = process.env.WORKDIR || path.join(APP_DIR, 'workspace');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');

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
  'postgres-wizard':   { label:'🗄️ PostgreSQL Wizard',          category:'engineering' },
  'data-engineer':     { label:'📊 Data Engineer',              category:'engineering' },
  'llm-architect':     { label:'🧠 LLM Architect',              category:'ai'          },
  'prompt-engineer':   { label:'✍️ Prompt Engineer',            category:'ai'          },
  'rag-engineer':      { label:'🔍 RAG Engineer',               category:'ai'          },
  'code-quality':      { label:'💎 Code Quality',               category:'quality'     },
  'debugging-master':  { label:'🐛 Debugging Master',           category:'quality'     },
  'code-review':       { label:'👁️ Code Reviewer',              category:'quality'     },
  'system-designer':   { label:'🏗️ System Designer',            category:'quality'     },
  'security':          { label:'🔒 Security Expert',            category:'security'    },
  'auth-specialist':   { label:'🛡️ Auth Specialist',            category:'security'    },
  'ui-design':         { label:'🎭 UI Designer',                category:'design'      },
  'ux-design':         { label:'🧩 UX Designer',                category:'design'      },
  'product-management':{ label:'📋 Product Manager',            category:'product'     },
  'docs-engineer':     { label:'📚 Docs Engineer',              category:'product'     },
  'technical-writer':  { label:'✒️ Technical Writer',           category:'product'     },
  'investment-banking':{ label:'💼 Investment Banking Analyst', category:'finance'     },
  'researcher':        { label:'🔬 Deep Researcher',            category:'research'    },
};

// ─── Server-side i18n for user-facing defaults ──────────────────────────────
const SERVER_I18N = {
  uk: { newSession: 'Нова сесія', newTask: 'Нова задача' },
  en: { newSession: 'New session', newTask: 'New task' },
  ru: { newSession: 'Новая сессия', newTask: 'Новая задача' },
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
try { db.exec(`ALTER TABLE sessions ADD COLUMN remote_host TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN remote_workdir TEXT`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN sort_order REAL`); } catch {}
// Performance indexes — safe to re-run (IF NOT EXISTS)
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_status   ON tasks(status)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_session  ON tasks(session_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_created   ON messages(created_at)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_chain    ON tasks(chain_id)`); } catch {}
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
`);

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
  getMsgs: db.prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY id ASC`),
  // Lightweight: strip tool content (frontend only needs tool_name + agent_id for badge counts)
  getMsgsLite: db.prepare(`SELECT id, session_id, role, type, CASE WHEN type='tool' THEN '' ELSE content END AS content, tool_name, agent_id, created_at, reply_to_id, attachments, source FROM messages WHERE session_id=? ORDER BY id ASC`),
  getMsgsPaginated: db.prepare(`SELECT * FROM messages WHERE session_id=? AND (type IS NULL OR type != 'tool') ORDER BY id ASC LIMIT ? OFFSET ?`),
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
  createTask: db.prepare(`INSERT INTO tasks (id,title,description,notes,status,sort_order,session_id,workdir,model,mode,agent_mode,max_turns,attachments,depends_on,chain_id,source_session_id,scheduled_at,recurrence,recurrence_end_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateTask: db.prepare(`UPDATE tasks SET title=?,description=?,notes=?,status=?,sort_order=?,session_id=?,workdir=?,model=?,mode=?,agent_mode=?,max_turns=?,attachments=?,depends_on=?,chain_id=?,source_session_id=?,scheduled_at=?,recurrence=?,recurrence_end_at=?,updated_at=datetime('now') WHERE id=?`),
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
  getChainTasks:  db.prepare(`SELECT id, title, status, depends_on, chain_id FROM tasks WHERE source_session_id=? ORDER BY sort_order ASC`),
  // Task chains (groups)
  getChains: db.prepare(`SELECT * FROM task_chains WHERE (@w IS NULL OR workdir = @w) ORDER BY sort_order ASC, created_at ASC`),
  getChain: db.prepare(`SELECT * FROM task_chains WHERE id=?`),
  createChain: db.prepare(`INSERT INTO task_chains (id,title,workdir,model,mode,agent_mode,max_turns,session_id,scheduled_at,recurrence,recurrence_end_at,source_session_id,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateChain: db.prepare(`UPDATE task_chains SET title=?,workdir=?,model=?,mode=?,agent_mode=?,max_turns=?,session_id=?,scheduled_at=?,recurrence=?,recurrence_end_at=?,sort_order=?,updated_at=datetime('now') WHERE id=?`),
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
const TASK_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // abort orphaned tasks after 30 min

// ─── Session Watchers (real-time task worker → chat streaming) ────────────
// When chat client opens a session, it subscribes via WS. Task worker broadcasts
// text/tool/done events to all watchers of that session.
const sessionWatchers = new Map(); // sessionId → Set<WebSocket>
const taskBuffers = new Map();     // taskId → accumulated text (for late subscribers)
const chatBuffers = new Map();     // sessionId → accumulated text for direct chat (for catch-up on reconnect)
const MAX_CHAT_BUFFER = 2 * 1024 * 1024; // 2 MB cap per session — prevents unbounded growth
const sessionQueues = new Map();   // sessionId → [msg, ...] — queue persistence across WS reconnects (page refresh)
const sessionQueueCleanupTimers = new Map(); // sessionId → setTimeout handle — delayed cleanup to survive WS reconnect race

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

// ─── Kanban Task Queue Worker ─────────────────────────────────────────────
const MAX_TASK_WORKERS = Math.max(1, parseInt(process.env.MAX_TASK_WORKERS || '5', 10));
const taskRunning = new Set();        // task IDs currently executing
const runningTaskAborts = new Map();  // taskId → AbortController
const stoppingTasks = new Set();      // task IDs being manually stopped (onDone must not overwrite status)

async function startTask(task) {
  if (taskRunning.has(task.id)) return;
  taskRunning.add(task.id);
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
    let currentTaskPrompt = prompt;
    let currentTaskCid = claudeSessionId;
    let lastTaskResult = null;
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
    taskMcpServers['_ccs_task_manager'] = {
      command: 'node',
      args: [path.join(__dirname, 'mcp-task-manager.js')],
      env: {
        TASK_MANAGER_SERVER_URL: `http://127.0.0.1:${PORT}`,
        TASK_MANAGER_TASK_ID: task.id,
        TASK_MANAGER_SESSION_ID: sessionId,
        TASK_MANAGER_SECRET: TASK_MANAGER_SECRET,
      },
    };

    while (true) {
      lastTaskResult = null;
      hasError = false; // Reset per iteration — only the LAST iteration's error state matters for final status
      const stream = cli.send({ prompt: currentTaskPrompt, sessionId: currentTaskCid, model: session?.model || task.model || 'sonnet', maxTurns: effectiveTaskMaxTurns, mcpServers: taskMcpServers, abortController: taskAbort });
      // Save subprocess PID so startup recovery can kill orphans on restart
      if (stream.process?.pid) {
        db.prepare(`UPDATE tasks SET worker_pid=? WHERE id=?`).run(stream.process.pid, task.id);
      }
      await new Promise(resolve => {
        stream
          .onText(t => {
            fullText += t;
            taskBuffers.set(task.id, (taskBuffers.get(task.id) || '') + t);
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
      taskBuffers.set(task.id, (taskBuffers.get(task.id) || '') + notice);
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
        const isRateLimited = hasError && (fullText.includes('rate_limit') || fullText.includes('overloaded') || fullText.includes('Too many'));
        const MAX_CHAIN_RETRIES = 2;

        if (isSuccess) {
          // ✅ Success
          db.prepare(`UPDATE tasks SET status='done', failure_reason=NULL, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
            .run(task.id);
          db.prepare(`UPDATE sessions SET retry_count=0 WHERE id=?`).run(sessionId);
          log.info(`[taskWorker] task ${task.id}: done`);
          // 🔄 Auto-schedule next occurrence for recurring tasks
          scheduleNextRun(task);
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
                  if (chain.recurrence && chain.scheduled_at) {
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
          scheduleNextRun(task, { inheritSession: false });
        }
      } else {
        // User manually stopped — mark as user_cancelled, cascade will follow
        db.prepare(`UPDATE tasks SET status='cancelled', failure_reason='user_cancelled', worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
          .run(task.id);
        log.info(`[taskWorker] task ${task.id}: stopped by user`);
        // 🔄 Recurring tasks: stopping one run should not kill the entire schedule
        scheduleNextRun(task, { inheritSession: false });
      }
    } catch (e) {
      console.error(`[taskWorker] task ${task.id} onDone DB error:`, e);
    }
    broadcastToSession(sessionId, { type: 'done', tabId: sessionId, taskId: task.id, duration: Date.now() - _taskStartedAt });
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
        scheduleNextRun(task, { inheritSession: false });
      }
    } catch {}
    // Send done so the client doesn't wait forever for an event that will never arrive.
    if (sessionId) broadcastToSession(sessionId, { type: 'done', tabId: sessionId, taskId: task.id, duration: Date.now() - _taskStartedAt });
  } finally {
    taskBuffers.delete(task.id);
    taskRunning.delete(task.id);
    runningTaskAborts.delete(task.id);
    setTimeout(processQueue, _retryBackoffMs || 500);
  }
}

// ─── Recurring task scheduler ────────────────────────────────────────────────
function calcNextRun(scheduled_at, recurrence) {
  const d = new Date(scheduled_at * 1000);
  if (recurrence === 'hourly')  d.setHours(d.getHours() + 1);
  if (recurrence === 'daily')   d.setDate(d.getDate() + 1);
  if (recurrence === 'weekly')  d.setDate(d.getDate() + 7);
  if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
  return Math.floor(d.getTime() / 1000);
}

function scheduleNextRun(task, { inheritSession = true } = {}) {
  if (!task.recurrence || !task.scheduled_at) return;
  const now = Math.floor(Date.now() / 1000);
  // Find next future occurrence — handles server downtime gaps gracefully.
  // Cap iterations to prevent runaway loops for very old tasks.
  let next = calcNextRun(task.scheduled_at, task.recurrence);
  let guard = 0;
  while (next <= now && guard < 10000) { next = calcNextRun(next, task.recurrence); guard++; }
  if (guard >= 10000) { log.warn(`[schedule] Too many iterations for "${task.title}", skipping`); return; }
  // Respect end date
  if (task.recurrence_end_at && next > task.recurrence_end_at) {
    log.info(`[schedule] Recurrence series ended for "${task.title}"`);
    return;
  }
  const newId = genId();
  stmts.createTask.run(
    newId, task.title, task.description || '', task.notes || '', 'todo', task.sort_order || 0,
    inheritSession ? (task.session_id || null) : null, task.workdir || null, task.model || 'sonnet',
    task.mode || 'auto', task.agent_mode || 'single', task.max_turns || 30,
    null, null, null, null,
    next, task.recurrence, task.recurrence_end_at || null
  );
  log.info(`[schedule] Next run queued: "${task.title}" → ${new Date(next * 1000).toISOString()}`);
}

// Clone entire chain + tasks for recurring chain execution
function scheduleNextChainRun(chain, oldTasks) {
  if (!chain.recurrence || !chain.scheduled_at) return;
  const now = Math.floor(Date.now() / 1000);
  let next = calcNextRun(chain.scheduled_at, chain.recurrence);
  let guard = 0;
  while (next <= now && guard < 10000) { next = calcNextRun(next, chain.recurrence); guard++; }
  if (guard >= 10000) { log.warn(`[schedule] Chain recurrence too many iterations: "${chain.title}"`); return; }
  if (chain.recurrence_end_at && next > chain.recurrence_end_at) {
    log.info(`[schedule] Chain recurrence ended: "${chain.title}"`); return;
  }
  const newChainId = genId();
  const newSessionId = genId();
  db.transaction(() => {
    // Create new session for next run
    stmts.createSession.run(newSessionId, chain.title, '[]', '[]',
      chain.mode || 'auto', chain.agent_mode || 'single', chain.model || 'sonnet',
      chain.workdir || null);
    // Clone chain
    stmts.createChain.run(newChainId, chain.title, chain.workdir || null,
      chain.model || 'sonnet', chain.mode || 'auto', chain.agent_mode || 'single',
      chain.max_turns || 30, newSessionId, next, chain.recurrence,
      chain.recurrence_end_at || null, chain.source_session_id || null, chain.sort_order || 0);
    // Clone tasks with new IDs, re-map depends_on
    const idMap = {};
    for (const t of oldTasks) idMap[t.id] = genId();
    for (let i = 0; i < oldTasks.length; i++) {
      const t = oldTasks[i];
      const newId = idMap[t.id];
      let newDeps = null;
      if (t.depends_on) {
        try {
          const deps = JSON.parse(t.depends_on).map(d => idMap[d]).filter(Boolean);
          if (deps.length) newDeps = JSON.stringify(deps);
        } catch {}
      }
      stmts.createTask.run(newId, t.title, t.description || '', t.notes || '', 'todo',
        i * 1000, newSessionId, chain.workdir || null, chain.model || 'sonnet',
        chain.mode || 'auto', chain.agent_mode || 'single', chain.max_turns || 30,
        null, newDeps, newChainId, chain.source_session_id || null,
        next, null, null);
    }
  })();
  log.info(`[schedule] Chain next run queued: "${chain.title}" → ${new Date(next * 1000).toISOString()}, ${oldTasks.length} tasks cloned`);
}

function processQueue() {
  const todo = stmts.getTodoTasks.all();
  if (!todo.length) return;
  const inProg = stmts.getInProgressTasks.all();
  // Sessions currently occupied (in_progress or just started by taskRunning)
  const occupiedSids = new Set(inProg.filter(t => t.session_id).map(t => t.session_id));
  // Workdir-level lock: prevents parallel chain tasks from writing to the same directory concurrently
  const occupiedWorkdirs = new Set(inProg.filter(t => t.workdir).map(t => t.workdir));
  // Count independent running tasks (null session_id)
  let indepRunning = inProg.filter(t => !t.session_id).length;
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
        if (task.workdir) startedWorkdirs.add(task.workdir);
        startTask(task).catch(e => console.error('[taskWorker]', e));
      }
    }
  }
}
// Run every 15s (fast enough to pick up unblocked tasks promptly,
// light enough to be negligible — just two SELECT queries on SQLite)
setInterval(processQueue, 15000);
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
        newStatus = 'done'; // completed before/during restart
        // 🔄 Recurring tasks: ensure next run is scheduled after crash recovery
        if (task.recurrence) scheduleNextRun(task);
      }
    }
    db.prepare(`UPDATE tasks SET status=?, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(newStatus, task.id);
    console.log(`[startup] recovered task "${task.title}" (${task.id}): in_progress → ${newStatus}`);
  }
  processQueue();
}, 3000);

class WsProxy {
  constructor(ws) { this._ws = ws; this._buffer = []; }
  send(data) {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(data);
    } else if (this._buffer.length < 1000) {
      this._buffer.push(data);
    }
  }
  attach(newWs) {
    this._ws = newWs;
    const buf = this._buffer.splice(0);
    for (const msg of buf) { try { newWs.send(msg); } catch {} }
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
 *  Seeds default slash commands into config.json on fresh install and after updates:
 *  only adds defaults whose name is not yet present — never overwrites user commands. */
function loadConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { c = {}; }
  if (!c.mcpServers)      c.mcpServers      = {};
  if (!c.skills)          c.skills          = {};
  if (!c.slashCommands)   c.slashCommands   = [];
  if (!c.externalAgents)  c.externalAgents  = {};
  // Merge-in any default commands the user doesn't have yet (match by name).
  // This handles fresh installs AND version upgrades that add new defaults.
  const existingNames = new Set(c.slashCommands.map(cmd => cmd.name));
  const toAdd = DEFAULT_SLASH_COMMANDS.filter(def => !existingNames.has(def.name));
  if (toAdd.length > 0) {
    c.slashCommands.push(...toAdd);
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); } catch {}
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

function saveConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
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
const LANG_NAMES = { en: 'English', uk: 'Ukrainian', ru: 'Russian' };

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
function saveProjects(p) { const d=path.dirname(PROJECTS_FILE); if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(PROJECTS_FILE, JSON.stringify(p, null, 2)); }

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
function saveRemoteHosts(h) { const d=path.dirname(REMOTE_HOSTS_FILE); if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(REMOTE_HOSTS_FILE, JSON.stringify(h, null, 2)); }

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

// testSshConnection is now exported from claude-ssh.js (uses ssh2 library, supports password auth)

// ============================================
// EXECUTION ENGINES
// ============================================

// Maximum number of auto-continue attempts when agent hits --max-turns limit.
// Each continue resumes the session, giving the agent another maxTurns window.
const MAX_AUTO_CONTINUES = 3;

function isResettableClaudeSessionError(errorText = '') {
  return /Invalid signature in thinking block|invalid session|session .* not found|could not find .*session|no conversation found|resume .*failed|failed to resume|conversation .* not found/i.test(errorText || '');
}

// --- CLI Single Agent ---
async function runCliSingle(p) {
  const { prompt, userContent, systemPrompt, mcpServers, model, maxTurns, ws, sessionId, abortController, claudeSessionId, mode, workdir, tabId } = p;
  const mp = mode==='planning' ? 'MODE: PLANNING ONLY. Analyze, plan, DO NOT modify files.\n\n' : mode==='task' ? 'MODE: EXECUTION.\n\n' : '';
  const sp = (mp + (systemPrompt||'')).trim() || undefined;
  // MCP tools must use the mcp__<serverName>__<toolName> format in allowedTools
  const mcpTools = ['mcp___ccs_set_ui_state__set_ui_state', 'mcp___ccs_ask_user__ask_user', 'mcp___ccs_notify__notify_user'];
  const tools = mode==='planning'
    ? ['View','GlobTool','GrepTool','ListDir','ReadNotebook', ...mcpTools]
    : ['Bash','View','GlobTool','GrepTool','ReadNotebook','NotebookEditCell','ListDir','SearchReplace','Write', ...mcpTools];
  const effectiveMaxTurns = maxTurns || 30;
  let fullText = '', fullThinking = '', newCid = claudeSessionId, chunkCount = 0;
  let currentPrompt = prompt;
  let continueCount = 0;
  // First invocation carries attachments; subsequent auto-continues do not
  let currentContentBlocks = Array.isArray(userContent) ? userContent : null;

  const cli = new ClaudeCLI({ cwd: workdir || WORKDIR });

  // Run a single CLI invocation and return { resultData, sid, errorText }
  const runOnce = (runPrompt, contentBlocks, resumeId) => new Promise((resolve) => {
    let resultData = null;
    let errorText = '';
    let _done = false;
    const _finish = (sid) => { if (!_done) { _done = true; resolve({ resultData, sid, errorText }); } };

    cli.send({ prompt: runPrompt, contentBlocks, sessionId: resumeId, model, maxTurns: effectiveMaxTurns, systemPrompt: sp, mcpServers, allowedTools: tools, abortController })
      .onText(t => {
        fullText += t;
        { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        ws.send(JSON.stringify({ type:'text', text:t, ...(tabId ? { tabId } : {}) }));
        if (++chunkCount % 5 === 0) {
          try { stmts.setPartialText.run(fullText, sessionId); } catch {}
        }
      })
      .onThinking(t => { fullThinking += t; ws.send(JSON.stringify({ type:'thinking', text:t, ...(tabId ? { tabId } : {}) })); })
      .onTool((name, inp) => {
        if (name === 'ask_user' || name === 'notify_user' || name === 'set_ui_state') {
          try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
          return;
        }
        if (name === 'AskUserQuestion') {
          try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
          return;
        }
        ws.send(JSON.stringify({ type:'tool', tool:name, input:(inp||'').substring(0,600), ...(tabId ? { tabId } : {}) }));
        try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
      })
      .onSessionId(sid => { newCid = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
      .onRateLimit(info => { ws.send(JSON.stringify({ type:'rate_limit', info, ...(tabId ? { tabId } : {}) })); })
      .onResult(r => { resultData = r; })
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
  while (true) {
    const { resultData, errorText } = await runOnce(currentPrompt, currentContentBlocks, newCid);
    lastResult = resultData;

    // ✅ Success — agent finished naturally
    if (resultData?.subtype === 'success') break;

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
  try { if (fullThinking) stmts.addMsg.run(sessionId, 'assistant', 'thinking', fullThinking, null, null, null, null); } catch {}
  try { if (fullText) stmts.addMsg.run(sessionId, 'assistant', 'text', fullText, null, null, null, null); } catch {}
  try { stmts.setPartialText.run(null, sessionId); } catch {}
  return { cid: newCid, completed: lastResult?.subtype === 'success' };
}

// --- SSH Remote Agent ---
async function runSshSingle(p) {
  const { prompt, userContent, systemPrompt, model, maxTurns, ws, sessionId, abortController, claudeSessionId, mode, remoteHost, remoteWorkdir, sshKeyPath, password, port, tabId } = p;
  const mp = mode==='planning' ? 'MODE: PLANNING ONLY. Analyze, plan, DO NOT modify files.\n\n' : mode==='task' ? 'MODE: EXECUTION.\n\n' : '';
  const sp = (mp + (systemPrompt||'')).trim() || undefined;
  // MCP tools must use the mcp__<serverName>__<toolName> format in allowedTools
  const mcpTools = ['mcp___ccs_set_ui_state__set_ui_state', 'mcp___ccs_ask_user__ask_user', 'mcp___ccs_notify__notify_user'];
  const tools = mode==='planning'
    ? ['View','GlobTool','GrepTool','ListDir','ReadNotebook', ...mcpTools]
    : ['Bash','View','GlobTool','GrepTool','ListDir','SearchReplace','Write', ...mcpTools];
  const effectiveMaxTurns = maxTurns || 30;
  let fullText = '', fullThinking = '', newCid = claudeSessionId, chunkCount = 0;
  let currentPrompt = prompt;
  let continueCount = 0;
  let currentContentBlocks = Array.isArray(userContent) ? userContent : null;

  const ssh = new ClaudeSSH({ host: remoteHost, workdir: remoteWorkdir, sshKeyPath, password, port });

  const runOnce = (runPrompt, contentBlocks, resumeId) => new Promise((resolve) => {
    let resultData = null;
    let errorText = '';
    let _done = false;
    const _finish = (sid) => { if (!_done) { _done = true; resolve({ resultData, sid, errorText }); } };

    ssh.send({ prompt: runPrompt, contentBlocks, sessionId: resumeId, model, maxTurns: effectiveMaxTurns, systemPrompt: sp, allowedTools: tools, abortController })
      .onText(t => {
        fullText += t;
        { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); }
        ws.send(JSON.stringify({ type:'text', text:t, ...(tabId ? { tabId } : {}) }));
        if (++chunkCount % 5 === 0) {
          try { stmts.setPartialText.run(fullText, sessionId); } catch {}
        }
      })
      .onThinking(t => { fullThinking += t; ws.send(JSON.stringify({ type:'thinking', text:t, ...(tabId ? { tabId } : {}) })); })
      .onTool((name, inp) => {
        if (name === 'ask_user' || name === 'notify_user' || name === 'set_ui_state') {
          try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
          return;
        }
        ws.send(JSON.stringify({ type:'tool', tool:name, input:(inp||'').substring(0,600), ...(tabId ? { tabId } : {}) }));
        try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,500),name,null,null,null); } catch {}
      })
      .onSessionId(sid => { newCid = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} })
      .onRateLimit(info => { ws.send(JSON.stringify({ type:'rate_limit', info, ...(tabId ? { tabId } : {}) })); })
      .onResult(r => { resultData = r; })
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
  while (true) {
    const { resultData, errorText } = await runOnce(currentPrompt, currentContentBlocks, newCid);
    lastResult = resultData;
    if (resultData?.subtype === 'success') break;
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

  try { if (fullThinking) stmts.addMsg.run(sessionId, 'assistant', 'thinking', fullThinking, null, null, null, null); } catch {}
  try { if (fullText) stmts.addMsg.run(sessionId, 'assistant', 'text', fullText, null, null, null, null); } catch {}
  try { stmts.setPartialText.run(null, sessionId); } catch {}
  return { cid: newCid, completed: lastResult?.subtype === 'success' };
}

// --- Multi-Agent (CLI only) ---
async function runMultiAgent(p) {
  const { prompt, systemPrompt, mcpServers, model, maxTurns, ws, sessionId, abortController, claudeSessionId, workdir, tabId } = p;
  ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'🧠 Planning...', statusKey:'agent.planning', ...(tabId ? { tabId } : {}) }));

  const effectiveWorkdir = workdir || WORKDIR;
  const cli = new ClaudeCLI({ cwd: effectiveWorkdir });
  let planText = '';
  // Orchestrator gets existing session context via --resume if available
  const planPrompt = `You are a lead architect. Break this into 2-5 subtasks. Respond ONLY in JSON:\n{"plan":"...","agents":[{"id":"agent-1","role":"...","task":"...","depends_on":[]}]}\n\nTASK: ${prompt}`;
  let currentSessionId = claudeSessionId || null;

  await new Promise(res => {
    let _settled = false;
    const _res = () => { if (!_settled) { _settled = true; res(); } };
    cli.send({ prompt:planPrompt, sessionId: currentSessionId, model, maxTurns:1, allowedTools:[], abortController })
      .onText(t => { planText+=t; })
      .onSessionId(sid => { currentSessionId = sid; })
      .onError(() => _res())
      .onDone(() => _res());
  });

  let plan = null;
  try { const m = planText.match(/\{[\s\S]*\}/); if (m) plan = JSON.parse(m[0]); } catch {}

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
    const runnable = remaining.filter(a => (a.depends_on||[]).every(d => completed.has(d)));
    if (!runnable.length) { ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'Circular deps', statusKey:'agent.circular_deps', ...(tabId ? { tabId } : {}) })); break; }

    await Promise.all(runnable.map(async agent => {
      remaining.splice(remaining.indexOf(agent), 1);
      ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`🔄 ${agent.role}`, ...(tabId ? { tabId } : {}) }));
      const depCtx = (agent.depends_on||[]).map(d => results[d] ? `\n[${d}]:${results[d].substring(0,2000)}` : '').join('');
      const agentPrompt = agent.task + (depCtx ? '\nContext:'+depCtx : '');
      const agentSp = `You are ${agent.role}. Complete your assigned task thoroughly. Be concise in output.`;
      const agentTools = ['Bash','View','GlobTool','GrepTool','ListDir','SearchReplace','Write'];
      let agentText = '';

      await new Promise(res => {
        let _settled = false;
        const _res = () => { if (!_settled) { _settled = true; res(); } };
        // Agent resumes session to maintain context
        cli.send({ prompt:agentPrompt, sessionId: currentSessionId, model, maxTurns:Math.min(maxTurns||30, 50), systemPrompt:agentSp, mcpServers, allowedTools:agentTools, abortController })
          .onText(t => { agentText+=t; { const _cb = (chatBuffers.get(sessionId) || '') + t; chatBuffers.set(sessionId, _cb.length > MAX_CHAT_BUFFER ? _cb.slice(-MAX_CHAT_BUFFER) : _cb); } try { ws.send(JSON.stringify({ type:'text', text:t, agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} })
          .onTool((n,i) => { if (n !== 'ask_user' && n !== 'notify_user' && n !== 'set_ui_state') { try { ws.send(JSON.stringify({ type:'tool', tool:n, input:(i||'').substring(0,600), agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} } try { stmts.addMsg.run(sessionId,'assistant','tool',(i||'').substring(0,500),n,agent.id,null,null); } catch {} })
          .onSessionId(sid => { currentSessionId = sid; })
          .onError(err => { try { ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`❌ ${err.substring(0,200)}`, ...(tabId ? { tabId } : {}) })); } catch {} _res(); })
          .onDone(() => _res());
      });

      results[agent.id] = agentText;
      try { if (agentText) stmts.addMsg.run(sessionId,'assistant','text',agentText,null,agent.id,null,null); } catch {}
      completed.add(agent.id);
      ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`✅ ${agent.role}`, ...(tabId ? { tabId } : {}) }));
    }));
  }

  // Summarizer agent: synthesizes results and provides final session_id for resume
  ws.send(JSON.stringify({ type:'agent_status', agent:'summarizer', status:'📝 Synthesizing results...', ...(tabId ? { tabId } : {}) }));
  const summaryPrompt = `You are a coordinator. Synthesize the results from all agents and provide a concise summary.

AGENT RESULTS:
${Object.entries(results).map(([id, text]) => `【${id}】\n${(text||'No output').substring(0,3000)}`).join('\n\n')}

Provide a clear summary of what was accomplished. Be concise.`;

  let summaryText = '';
  await new Promise(res => {
    let _settled = false;
    const _res = () => { if (!_settled) { _settled = true; res(); } };
    cli.send({ prompt:summaryPrompt, sessionId: currentSessionId, model, maxTurns:1, allowedTools:[], abortController })
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
          null  // recurrence_end_at
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
                scheduled_at: chainScheduledAt, recurrence, recurrence_end_at } = req.body;
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
        stmts.createChain.run(chainId, String(title).substring(0, 200), workdir,
          effectiveModel, 'auto', 'single', 30,
          chainSessionId, toUnixTs(chainScheduledAt), recurrence || null,
          toUnixTs(recurrence_end_at), callerTask?.source_session_id || null, 0);

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
            null, null
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
  if (!['uk', 'en', 'ru'].includes(lang)) return res.status(400).json({ error: 'Invalid lang' });
  const c = loadConfig();
  c.lang = lang;
  saveConfig(c);
  // Update bot language if running
  if (telegramBot) telegramBot.lang = lang;
  res.json({ ok: true });
});

// ─── Health check ─────────────────────────────────────────────────────────────
// Deep health check: verifies DB connectivity, reports uptime / memory / WS connections.
// Returns HTTP 503 if any critical subsystem is degraded.
app.get('/api/version', (_, res) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  res.json({ version: pkg.version, name: pkg.name });
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
// Returns session IDs that currently have in_progress tasks — used by client to show spinners on all tabs
app.get('/api/tasks/running-sessions', (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT session_id FROM tasks WHERE status='in_progress' AND session_id IS NOT NULL`).all();
  res.json(rows.map(r => r.session_id));
});
app.post('/api/tasks', (req, res) => {
  const { title=i18nTask(), description='', notes='', status='backlog', sort_order=0, session_id=null, workdir=null,
          model='sonnet', mode='auto', agent_mode='single', max_turns=30, attachments=null,
          depends_on=null, chain_id=null, source_session_id=null,
          scheduled_at=null, recurrence=null, recurrence_end_at=null } = req.body;
  const id = genId();
  stmts.createTask.run(id, String(title).substring(0,200), String(description).substring(0,2000), String(notes||'').substring(0,2000), sqlVal(status), sqlVal(sort_order), sqlVal(session_id)||null, sqlVal(workdir)||null, sqlVal(model), sqlVal(mode), sqlVal(agent_mode), sqlVal(max_turns), sqlVal(attachments)||null, sqlVal(depends_on)||null, sqlVal(chain_id)||null, sqlVal(source_session_id)||null, sqlVal(scheduled_at)||null, sqlVal(recurrence)||null, sqlVal(recurrence_end_at)||null);
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
          scheduled_at=task.scheduled_at, recurrence=task.recurrence, recurrence_end_at=task.recurrence_end_at } = req.body;
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
          recurrence = null, recurrence_end_at = null } = req.body;
  const id = genId();
  // Create shared session for the chain
  const sessionId = genId();
  stmts.createSession.run(sessionId, String(title).substring(0, 200), '[]', '[]',
    sqlVal(mode), sqlVal(agent_mode), sqlVal(model), sqlVal(workdir) || null);
  stmts.createChain.run(id, String(title).substring(0, 200), sqlVal(workdir) || null,
    sqlVal(model), sqlVal(mode), sqlVal(agent_mode), sqlVal(max_turns),
    sessionId, sqlVal(scheduled_at) || null, sqlVal(recurrence) || null,
    sqlVal(recurrence_end_at) || null, null, 0);
  res.json(chainWithSummary(stmts.getChain.get(id)));
});
app.put('/api/task-chains/:id', (req, res) => {
  const chain = stmts.getChain.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Not found' });
  const { title = chain.title, workdir = chain.workdir, model = chain.model,
          mode = chain.mode, agent_mode = chain.agent_mode, max_turns = chain.max_turns,
          session_id = chain.session_id, scheduled_at = chain.scheduled_at,
          recurrence = chain.recurrence, recurrence_end_at = chain.recurrence_end_at,
          sort_order = chain.sort_order } = req.body;
  stmts.updateChain.run(String(title).substring(0, 200), sqlVal(workdir) || null,
    sqlVal(model), sqlVal(mode), sqlVal(agent_mode), sqlVal(max_turns),
    sqlVal(session_id) || null, sqlVal(scheduled_at) || null, sqlVal(recurrence) || null,
    sqlVal(recurrence_end_at) || null, sqlVal(sort_order), req.params.id);
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
    chain.scheduled_at || null, null, null);
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
    chainSessionId, null, null, null, source_session_id || null, 0);

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
        null, null, null  // scheduled_at, recurrence, recurrence_end_at
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
  const { title = i18nSession(), workdir = null, model = 'sonnet', mode = 'auto', agentMode = 'single' } = req.body || {};
  const id = genId();
  stmts.createSession.run(id, String(title).substring(0, 200), '[]', '[]', sqlVal(mode), sqlVal(agentMode), sqlVal(model), sqlVal(workdir) || null);
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
    for (let i = 0; i < limit; i++) {
      const m = messages[i];
      importMsg.run(newId, m.role, m.type, m.content || '', m.tool_name || null, m.agent_id || null, m.reply_to_id || null, m.attachments || null, m.created_at || null);
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
  s.isChatRunning = activeTasks.has(req.params.id);
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
  const { title, active_mcp, active_skills } = req.body;
  if (title) stmts.updateTitle.run(title, req.params.id);
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
  const del = db.transaction(() => {
    for (const id of ids) {
      // Unlink recurring tasks from session (preserve the schedule), delete the rest
      db.prepare(`UPDATE tasks SET session_id=NULL WHERE session_id=? AND recurrence IS NOT NULL`).run(id);
      stmts.deleteTasksBySession.run(id); stmts.deleteSession.run(id); sessionQueues.delete(id);
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
  const workdir = session.workdir || WORKDIR;
  const platform = process.platform;
  let fullCmd, ok = false;
  try {
    if (platform === 'win32') {
      fullCmd = `cd /d "${workdir}" && set CLAUDECODE= && claude --resume ${safeSid}`;
      // Empty title "" required: without it cmd.exe treats first quoted arg as window title
      execSync(`start "" cmd /k "${fullCmd.replace(/"/g, '\\"')}"`, { shell: true });
      ok = true;
    } else if (platform === 'darwin') {
      const safeWorkdir = workdir.replace(/'/g, "'\\''");
      fullCmd = `cd '${safeWorkdir}' && unset CLAUDECODE; claude --resume ${safeSid}`;
      execSync(`osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${fullCmd.replace(/"/g, '\\"')}"'`);
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
  try{const dir=path.dirname(target); if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(target,content,'utf-8'); res.json({ok:true})}
  catch(e){res.status(500).json({error:e.message})}
});

// CLAUDE.md editor — global (~/.claude/CLAUDE.md) + local (WORKDIR/CLAUDE.md)
const GLOBAL_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const LOCAL_CLAUDE_MD  = path.join(WORKDIR, 'CLAUDE.md');

app.get('/api/claude-md', (req,res) => {
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
      const content=(te.includes(ext)||stat.size<512*1024)?fs.readFileSync(fp,'utf-8'):'[Binary]';
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
app.get('/api/projects', (_,res) => res.json(loadProjects()));

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

// Directory browser — list directories at given path (no restriction to WORKDIR)
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

  // Check if session is busy
  if (activeTasks.has(sessionId)) {
    await telegramBot.sendMessage(chatId, '⏳ This session is busy. Wait for completion or use /stop.');
    return;
  }

  // Load session from DB
  const session = stmts.getSession.get(sessionId);
  if (!session) {
    await telegramBot.sendMessage(chatId, '❌ Session not found.');
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
      command: 'node',
      args: [path.join(__dirname, 'mcp-ask-user.js')],
      env: {
        ASK_USER_SERVER_URL: `http://127.0.0.1:${PORT}`,
        ASK_USER_SESSION_ID: sessionId,
        ASK_USER_SECRET: ASK_USER_SECRET,
      },
    };
    mcpServers['_ccs_notify'] = {
      command: 'node',
      args: [path.join(__dirname, 'mcp-notify.js')],
      env: {
        NOTIFY_SERVER_URL: `http://127.0.0.1:${PORT}`,
        NOTIFY_SESSION_ID: sessionId,
        NOTIFY_SECRET: NOTIFY_SECRET,
      },
    };
    mcpServers['_ccs_set_ui_state'] = {
      command: 'node',
      args: [path.join(__dirname, 'mcp-set-ui-state.js')],
      env: {
        SET_UI_STATE_SERVER_URL: `http://127.0.0.1:${PORT}`,
        SET_UI_STATE_SESSION_ID: sessionId,
        SET_UI_STATE_SECRET: SET_UI_STATE_SECRET,
      },
    };

    // Save last user msg for reconnect recovery
    stmts.setLastUserMsg.run(text, sessionId);

    // Send "thinking" indicator only in legacy mode (draft streaming provides its own visual)
    await proxy.startThinking();

    const params = {
      prompt: text,
      userContent,
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
    if (_activeProj) {
      await runSshSingle({
        ...params,
        remoteHost:    _activeProj.remoteHost,
        remoteWorkdir: _activeProj.workdir,
        sshKeyPath:    _activeProj.sshKeyPath || '',
        password:      decryptPassword(_activeProj.password) || '',
        port:          _activeProj.port || 22,
      });
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
  bot.on('stop_task', async ({ sessionId, chatId }) => {
    const task = activeTasks.get(sessionId);
    if (task && task.abortController) {
      task.abortController.abort();
      await bot.sendMessage(chatId, '🛑 Task stopped.');
    } else {
      await bot.sendMessage(chatId, 'No active task in this session.');
    }
  });
}

function initTelegramBot() {
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

function shellEscape(s) {
  // Single-quote wrapping: replace ' with '\'' (end quote, escaped quote, start quote)
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildTerminalCommand(agentConfig, workdir, prompt) {
  const template = agentConfig.template || '';
  const cmd = template.replace('{prompt}', shellEscape(prompt));
  // Gemini has no --cwd, so always cd first
  return `cd ${shellEscape(workdir)} && ${cmd}`;
}

function openTerminal(shellCommand) {
  const platform = os.platform();
  if (platform === 'darwin') {
    // macOS — open Terminal.app via osascript
    // Write command to a temp script file to avoid shell/AppleScript escaping issues
    const tmpScript = path.join(os.tmpdir(), `ccs-delegate-${Date.now()}.sh`);
    fs.writeFileSync(tmpScript, `#!/bin/bash\n${shellCommand}\n`, { mode: 0o755 });
    const script = `tell application "Terminal"\n  activate\n  do script "${tmpScript}"\nend tell`;
    try {
      spawnProc('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
      // Clean up temp script after a delay (terminal has started by then)
      setTimeout(() => { try { fs.unlinkSync(tmpScript); } catch {} }, 10000);
      return { ok: true };
    } catch (err) {
      try { fs.unlinkSync(tmpScript); } catch {}
      return { ok: false, error: err.message };
    }
  } else {
    // Linux fallback — try common terminal emulators
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

// --- External agents config API ---

app.get('/api/external-agents', (_, res) => {
  const config = loadConfig();
  res.json(config.externalAgents || {});
});

app.post('/api/external-agents', express.json(), (req, res) => {
  const { id, label, template } = req.body;
  if (!id || !label || !template) return res.status(400).json({ error: 'id, label, template required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'id must be alphanumeric (a-z, 0-9, -, _)' });
  const config = loadConfig();
  config.externalAgents[id] = { label, template };
  saveConfig(config);
  res.json({ ok: true });
});

app.delete('/api/external-agents/:id', (req, res) => {
  const config = loadConfig();
  delete config.externalAgents[req.params.id];
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
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  log.info('ws connected', { clients: wss.clients.size });
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

    // Mark this tab as busy
    if (tabId) ws._tabBusy[tabId] = true;
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
        if (ws._tabQueue[tabId]) {
          const q = ws._tabQueue[tabId];
          // Fix: update tabId + sessionId in queued messages so they continue in the same session,
          // not create new ones. Without this, msgs queued before session_started (on a new tab)
          // had tabId:'new-abc'/sessionId:null and each created a fresh phantom session on dequeue.
          for (const m of q) { m.tabId = localSessionId; m.sessionId = localSessionId; }
          ws._tabQueue[localSessionId] = q; delete ws._tabQueue[tabId]; sessionQueues.set(localSessionId, q); sessionQueues.delete(tabId);
        }
      }

      const { text:userMessage, attachments=[], skills:sIds=[], mcpServers:mIds=[], mode='auto', agentMode='single', model='sonnet', maxTurns=30, workdir=null, reply_to=null, retry=false, autoSkill=false } = msg;

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
        command: 'node',
        args: [path.join(__dirname, 'mcp-ask-user.js')],
        env: {
          ASK_USER_SERVER_URL: `http://127.0.0.1:${PORT}`,
          ASK_USER_SESSION_ID: localSessionId,
          ASK_USER_SECRET: ASK_USER_SECRET,
        },
      };

      mcpServers['_ccs_notify'] = {
        command: 'node',
        args: [path.join(__dirname, 'mcp-notify.js')],
        env: {
          NOTIFY_SERVER_URL: `http://127.0.0.1:${PORT}`,
          NOTIFY_SESSION_ID: localSessionId,
          NOTIFY_SECRET: NOTIFY_SECRET,
        },
      };
      mcpServers['_ccs_set_ui_state'] = {
        command: 'node',
        args: [path.join(__dirname, 'mcp-set-ui-state.js')],
        env: {
          SET_UI_STATE_SERVER_URL: `http://127.0.0.1:${PORT}`,
          SET_UI_STATE_SESSION_ID: localSessionId,
          SET_UI_STATE_SECRET: SET_UI_STATE_SECRET,
        },
      };

      proxy.send(JSON.stringify({ type:'status', status:'thinking', mode, agentMode, model, tabId: effectiveTabId }));

      // Register task in activeTasks so it survives client disconnect/reload
      try { stmts.setLastUserMsg.run(userMessage, localSessionId); } catch (e) { log.error('setLastUserMsg failed', { err: e.message }); }
      chatBuffers.set(localSessionId, ''); // reset buffer for this session
      activeTasks.set(localSessionId, { proxy, abortController, cleanupTimer: null, source: 'web', startedAt: Date.now() });

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
        mode,
        workdir: workdir || WORKDIR,
        tabId: effectiveTabId,
      };

      let newCid;
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
        // Track remote host on session for UI indicators
        try { db.prepare(`UPDATE sessions SET remote_host=? WHERE id=?`).run(_activeProj.remoteHost, localSessionId); } catch {}
      } else if (agentMode==='multi') {
        newCid = await runMultiAgent(params);
      } else {
        const result = await runCliSingle(params);
        newCid = result.cid;
      }
      if (newCid) { try { stmts.updateClaudeId.run(newCid, localSessionId); } catch (e) { log.error('updateClaudeId failed', { cid: String(newCid).substring(0,50), sessionId: localSessionId, err: e.message, stack: e.stack }); } }

      proxy.send(JSON.stringify({ type:'done', tabId: effectiveTabId, duration: Date.now() - _chatStartedAt }));
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
      proxy.send(JSON.stringify({ type:'done', tabId: effectiveTabId, duration: Date.now() - _chatStartedAt }));
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
      activeTasks.delete(localSessionId);
      chatBuffers.delete(localSessionId); // cleanup in-memory buffer
      // Clean up any pending ask_user questions for this session
      for (const [rid, entry] of pendingAskUser) {
        if (entry.sessionId === localSessionId) {
          clearTimeout(entry.timer);
          pendingAskUser.delete(rid);
          entry.resolve({ answer: '[Session ended]' });
        }
      }
      try { stmts.clearLastUserMsg.run(localSessionId); } catch {}
      // Detect stale finally: if a stop happened, ws._tabAbort was deleted or replaced
      // by a new processChat. In that case, another processChat now owns this tab — our
      // cleanup would stomp on its _tabBusy flag. Skip cleanup and let the new owner handle it.
      const isStale = myAbortController !== null && (effectiveTabId
        ? ws._tabAbort?.[effectiveTabId] !== myAbortController
        : ws._abort !== myAbortController);
      if (!isStale && effectiveTabId) {
        ws._tabBusy[effectiveTabId] = false;
        delete ws._tabAbort[effectiveTabId];
        const tabQ = ws._tabQueue[effectiveTabId] || [];
        if (tabQ.length > 0) {
          const next = tabQ.shift();
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
                  !liveWs._tabBusy?.[effectiveTabId]) {
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
        // Page refresh scenario: task finished on old (closed) WS but queue items
        // persist in sessionQueues. Trigger dequeue on the live WS that now owns this session.
        const pendingQueue = sessionQueues.get(effectiveTabId);
        if (pendingQueue?.length > 0) {
          setImmediate(() => {
            const watchers = sessionWatchers.get(effectiveTabId);
            if (!watchers) return;
            for (const liveWs of watchers) {
              if (liveWs.readyState === 1) {
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
      if (ws._tabQueue[tabId]?.length > 0 && !ws._tabBusy[tabId]) {
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
        // Per-tab concurrency: queue if this specific tab is busy
        if (ws._tabBusy[tabId]) {
          if (!ws._tabQueue[tabId]) {
            ws._tabQueue[tabId] = sessionQueues.get(tabId) || [];
            sessionQueues.set(tabId, ws._tabQueue[tabId]);
          }
          // Prevent unbounded queue growth
          if (ws._tabQueue[tabId].length >= 20) {
            ws.send(JSON.stringify({ type: 'error', error: 'Queue full (max 20). Wait for current task to finish.', tabId }));
            return;
          }
          msg._queueId = ++ws._queueIdCounter;
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

    if (msg.type==='stop') {
      const tabId = msg.tabId;
      if (tabId && ws._tabAbort && ws._tabAbort[tabId]) {
        // Stop specific tab — immediately mark as not busy so the next chat
        // message is processed directly instead of being queued (race condition fix).
        // The stale finally guard in processChat prevents the old finally from
        // resetting _tabBusy after a new processChat has already started.
        ws._tabBusy[tabId] = false;
        if (ws._tabQueue) ws._tabQueue[tabId] = [];
        sessionQueues.delete(tabId);
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
            const sess = stmts.getSession.get(sessionId);
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
        // Restore queue from persistent storage (survives page refresh / WS reconnect)
        if (!ws._tabQueue[sessionId]?.length && sessionQueues.has(sessionId) && sessionQueues.get(sessionId).length > 0) {
          ws._tabQueue[sessionId] = sessionQueues.get(sessionId); // shared ref
        }
        // Re-send queue state so client can restore queued message badges after tab switch
        if (ws._tabQueue?.[sessionId]?.length > 0 && ws.readyState === 1) {
          ws.send(queuePayload(sessionId));
          // If the session is idle (task already finished while WS was disconnected),
          // immediately start processing the first queued item.
          if (!ws._tabBusy[sessionId] && !activeTasks.has(sessionId)) {
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
          const { text, plan, agents, sessionId, workdir, model, tabId } = msg;
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

            const session = sessionId ? stmts.getSession.get(sessionId) : null;
            let planText = '';

            await new Promise(resolve => {
              let done = false;
              cli.send({ prompt: planPrompt, sessionId: sanitizeSessionId(session?.claude_session_id), model: model || 'sonnet', maxTurns: 1, allowedTools: [] })
                .onText(t => { planText += t; })
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
            chainSessionId, null, null, null, sessionId || null, 0);
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
                null, null, null  // scheduled_at, recurrence, recurrence_end_at
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
        if (!task.cleanupTimer) {
          task.cleanupTimer = setTimeout(() => {
            log.info('task idle timeout, aborting', { sessionId: sid });
            try { task.abortController.abort(); } catch {}
            activeTasks.delete(sid);
          }, TASK_IDLE_TIMEOUT_MS);
        }
      }
    }
    // Abort legacy (no-tab) session tasks only
    if (ws._abort) { ws._abort.abort(); ws._abort = null; }
    // WS-1: clean up per-tab state — abort CLI runs that are NOT tracked in activeTasks.
    // Sessions in activeTasks have a 30-min idle timeout and can be reattached on reconnect.
    for (const [tid, ac] of Object.entries(ws._tabAbort || {})) {
      if (!activeTasks.has(tid)) { try { ac.abort(); } catch {} }
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

server.listen(PORT, () => {
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
