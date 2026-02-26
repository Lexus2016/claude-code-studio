const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const { execSync, spawn: spawnProc } = require('child_process');
const multer = require('multer');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const auth = require('./auth');
const ClaudeCLI = require('./claude-cli');

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

// ─── Global Claude Code directory (priority: global → local) ─────────────────
const GLOBAL_CLAUDE_DIR  = path.join(os.homedir(), '.claude');
const GLOBAL_SKILLS_DIR  = path.join(GLOBAL_CLAUDE_DIR, 'skills');
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
    const cutoff = `datetime('now', '-${SESSION_TTL_DAYS} days')`;
    const result = db.prepare(`DELETE FROM sessions WHERE updated_at < ${cutoff}`).run();
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
// DATABASE
// ============================================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// Performance pragmas — safe with WAL mode
db.pragma('synchronous = NORMAL');   // WAL durability guarantees make FULL unnecessary
db.pragma('cache_size = -32000');    // 32 MB page cache
db.pragma('temp_store = MEMORY');    // Temp tables in RAM
db.pragma('foreign_keys = ON');      // Enforce FK constraints (was silently off)
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Нова сесія',
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
    title TEXT NOT NULL DEFAULT 'Нова задача',
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
// Performance indexes — safe to re-run (IF NOT EXISTS)
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_status   ON tasks(status)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_session  ON tasks(session_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_created   ON messages(created_at)`); } catch {}

const stmts = {
  createSession: db.prepare(`INSERT INTO sessions (id,title,active_mcp,active_skills,mode,agent_mode,model,engine,workdir) VALUES (?,?,?,?,?,?,?,?,?)`),
  updateTitle: db.prepare(`UPDATE sessions SET title=?,updated_at=datetime('now') WHERE id=?`),
  updateClaudeId: db.prepare(`UPDATE sessions SET claude_session_id=?,updated_at=datetime('now') WHERE id=?`),
  updateConfig: db.prepare(`UPDATE sessions SET active_mcp=?,active_skills=?,mode=?,agent_mode=?,model=?,workdir=?,updated_at=datetime('now') WHERE id=?`),
  getSessions: db.prepare(`SELECT id,title,created_at,updated_at,mode,agent_mode,model,workdir,claude_session_id FROM sessions ORDER BY updated_at DESC LIMIT 100`),
  getSessionsByWorkdir: db.prepare(`SELECT id,title,created_at,updated_at,mode,agent_mode,model,workdir,claude_session_id FROM sessions WHERE workdir=? ORDER BY updated_at DESC LIMIT 100`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id=?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE id=?`),
  addMsg: db.prepare(`INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,reply_to_id,attachments) VALUES (?,?,?,?,?,?,?,?)`),
  getMsgs: db.prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY id ASC`),
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
  createTask: db.prepare(`INSERT INTO tasks (id,title,description,notes,status,sort_order,session_id,workdir,model,mode,agent_mode,max_turns,attachments) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateTask: db.prepare(`UPDATE tasks SET title=?,description=?,notes=?,status=?,sort_order=?,session_id=?,workdir=?,model=?,mode=?,agent_mode=?,max_turns=?,attachments=?,updated_at=datetime('now') WHERE id=?`),
  patchTaskStatus: db.prepare(`UPDATE tasks SET status=?,sort_order=?,updated_at=datetime('now') WHERE id=?`),
  deleteTask: db.prepare(`DELETE FROM tasks WHERE id=?`),
  deleteTasksBySession: db.prepare(`DELETE FROM tasks WHERE session_id=?`),
  countTasksBySession: db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE session_id=?`),
  getTasksEtag: db.prepare(`SELECT COALESCE(MAX(updated_at),'') as ts, COUNT(*) as n FROM tasks`),
  // processQueue hot-path — prepared once, reused every 60 s
  getTodoTasks:      db.prepare(`SELECT * FROM tasks WHERE status='todo' ORDER BY sort_order ASC, created_at ASC`),
  getInProgressTasks: db.prepare(`SELECT * FROM tasks WHERE status='in_progress'`),
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
};

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

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

// ─── Ask User (Internal MCP) ─────────────────────────────────────────────
// Pending user questions: requestId → { resolve, sessionId, timer, question, options, inputType }
const pendingAskUser = new Map();
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ASK_USER_SECRET = require('crypto').randomBytes(16).toString('hex');

// ─── CLI Ask Tool ──────────────────────────────────────────────────────────
// Pending CLI Ask tool questions: requestId → { sessionId, ws, resolved }
let pendingCliAsks = new Map();

// ─── Notify User (Internal MCP) ──────────────────────────────────────────
const NOTIFY_SECRET = require('crypto').randomBytes(16).toString('hex');

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
  try {
    // Create session + link task + mark in_progress — all atomic
    let sessionId = task.session_id;
    db.transaction(() => {
      if (!sessionId) {
        sessionId = genId();
        stmts.createSession.run(sessionId, task.title.substring(0, 200), '[]', '[]', task.mode || 'auto', task.agent_mode || 'single', task.model || 'sonnet', 'cli', task.workdir || null);
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
              fs.writeFileSync(path.join(attDir, att.name), Buffer.from(att.base64, 'base64'));
              names.push(att.name);
            }
          }
          if (names.length) {
            parts.push(`---\nAttached files (in .kanban-attachments/${task.id}/):\n${names.map(n => `- ${n}`).join('\n')}`);
          }
        }
      } catch (e) { console.error('[taskWorker] attachments write error:', e); }
    }
    const prompt = parts.join('\n\n');
    const _taskStartedAt = Date.now();
    // Check if this is a restart: only skip saving if the LAST user message
    // has the exact same prompt (crash recovery). Previously checked for ANY
    // user message which broke when a new task reused an existing session.
    const lastUserMsg = db.prepare(`SELECT id, content FROM messages WHERE session_id=? AND role='user' ORDER BY id DESC LIMIT 1`).get(sessionId);
    const isRetry = lastUserMsg && lastUserMsg.content === prompt;
    if (!isRetry) {
      // New task or different prompt — save user message
      stmts.addMsg.run(sessionId, 'user', 'text', prompt, null, null, null, null);
    } else {
      // Restart after crash with same prompt — increment retry counter, don't duplicate
      stmts.incrementRetry.run(sessionId);
    }
    // Resume existing claude session if any
    const session = stmts.getSession.get(sessionId);
    const claudeSessionId = session?.claude_session_id || null;
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
    const stream = cli.send({ prompt, sessionId: claudeSessionId, model: session?.model || task.model || 'sonnet', maxTurns: task.max_turns || 30, abortController: taskAbort });
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
          stmts.addMsg.run(sessionId, 'assistant', 'tool', inp || '', name, null, null, null);
          broadcastToSession(sessionId, { type: 'tool', tool: name, input: (inp || '').substring(0, 600), tabId: sessionId });
        })
        .onSessionId(sid => { newCid = sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} }) // persist early so open-terminal works during active task
        .onError(err => {
          hasError = true;
          console.error(`[taskWorker] task ${task.id} error:`, err);
          stmts.addMsg.run(sessionId, 'assistant', 'text', `❌ ${err.substring(0, 500)}`, null, null, null, null);
          broadcastToSession(sessionId, { type: 'error', error: err.substring(0, 500), tabId: sessionId });
        })
        .onDone(() => {
          // Wrap all DB writes in try-catch: a throw here would escape the sync
          // EventEmitter listener, leaving the Promise pending forever.
          try {
            if (newCid) stmts.updateClaudeId.run(newCid, sessionId);
            if (fullText) stmts.addMsg.run(sessionId, 'assistant', 'text', fullText, null, null, null, null);
            const wasStopped = stoppingTasks.has(task.id);
            stoppingTasks.delete(task.id);
            if (!wasStopped) {
              // Normal completion — set final status
              db.prepare(`UPDATE tasks SET status=?, worker_pid=NULL, updated_at=datetime('now') WHERE id=?`)
                .run(hasError ? 'cancelled' : 'done', task.id);
              if (!hasError) db.prepare(`UPDATE sessions SET retry_count=0 WHERE id=?`).run(sessionId);
              console.log(`[taskWorker] task ${task.id}: ${hasError ? 'cancelled' : 'done'}`);
            } else {
              // Manually stopped — status already set by PUT; just clear worker_pid
              db.prepare(`UPDATE tasks SET worker_pid=NULL, updated_at=datetime('now') WHERE id=?`).run(task.id);
              console.log(`[taskWorker] task ${task.id}: stopped by user`);
            }
          } catch (e) {
            console.error(`[taskWorker] task ${task.id} onDone DB error:`, e);
          }
          broadcastToSession(sessionId, { type: 'done', tabId: sessionId, taskId: task.id, duration: Date.now() - _taskStartedAt });
          resolve();
        });
    });
  } catch (err) {
    console.error(`[taskWorker] task ${task.id} exception:`, err);
    try { db.prepare(`UPDATE tasks SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(task.id); } catch {}
    // Send done so the client doesn't wait forever for an event that will never arrive.
    if (sessionId) broadcastToSession(sessionId, { type: 'done', tabId: sessionId, taskId: task.id, duration: Date.now() - _taskStartedAt });
  } finally {
    taskBuffers.delete(task.id);
    taskRunning.delete(task.id);
    runningTaskAborts.delete(task.id);
    setTimeout(processQueue, 500);
  }
}

function processQueue() {
  const todo = stmts.getTodoTasks.all();
  if (!todo.length) return;
  const inProg = stmts.getInProgressTasks.all();
  // Sessions currently occupied (in_progress or just started by taskRunning)
  const occupiedSids = new Set(inProg.filter(t => t.session_id).map(t => t.session_id));
  // Workdir-level lock: prevents two Claude instances from writing to the same directory concurrently
  const occupiedWorkdirs = new Set(inProg.filter(t => t.workdir).map(t => t.workdir));
  // Count independent running tasks (null session_id)
  let indepRunning = inProg.filter(t => !t.session_id).length;
  const startedSids = new Set();
  const startedWorkdirs = new Set();
  for (const task of todo) {
    if (taskRunning.has(task.id)) continue;
    // Workdir lock: skip if another task is already running in the same directory
    if (task.workdir && (occupiedWorkdirs.has(task.workdir) || startedWorkdirs.has(task.workdir))) continue;
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
// Run every 60s
setInterval(processQueue, 60000);
// Kick off on startup — smart recovery for in_progress tasks
setTimeout(() => {
  const stuck = db.prepare(`SELECT * FROM tasks WHERE status='in_progress'`).all();
  for (const task of stuck) {
    // Step 1: Kill orphaned subprocess to prevent double-execution.
    // When Node restarts, spawned 'claude' processes become OS orphans and keep running.
    // We kill them before deciding what to do with the task.
    if (task.worker_pid) {
      try {
        process.kill(task.worker_pid, 'SIGTERM');
        console.log(`[startup] killed orphan PID ${task.worker_pid} for task "${task.title}"`);
      } catch {} // ESRCH = process already dead — that's fine
    }
    // Step 2: Determine if the task actually completed.
    // Assistant text is only written to DB on onDone — so its presence means success.
    let newStatus = 'todo'; // default: retry (task was interrupted)
    if (task.session_id) {
      const assistantMsg = db.prepare(
        `SELECT id FROM messages WHERE session_id=? AND role='assistant' AND type='text' LIMIT 1`
      ).get(task.session_id);
      if (assistantMsg) newStatus = 'done'; // completed before/during restart
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

// Build Claude content blocks from text + file attachments.
// Returns plain string when no attachments, or ContentBlock[] when attachments present.
function buildUserContent(text, attachments = []) {
  if (!attachments || attachments.length === 0) return text;
  const blocks = [];
  for (const att of attachments) {
    if (att.type && att.type.startsWith('image/')) {
      // Vision block — base64 image
      blocks.push({ type: 'image', source: { type: 'base64', media_type: att.type, data: att.base64 } });
    } else {
      // Text / PDF — decode base64 and embed as readable text block
      let content = '(unable to decode)';
      try { content = Buffer.from(att.base64, 'base64').toString('utf-8'); } catch {}
      blocks.push({ type: 'text', text: `[File: ${att.name}]\n${content}` });
    }
  }
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

// ============================================
// CONFIG
// ============================================
/** Load LOCAL config only — used by write operations (add/delete MCP, upload/delete skill). */
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return { mcpServers:{}, skills:{} }; } }
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
  _mergedConfigCache = {
    mcpServers: { ...(g.mcpServers||{}), ...(l.mcpServers||{}) },
    skills:     { ...(g.skills||{}),     ...(l.skills||{})     },
  };
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

// Internal MCP tool instructions — compact versions (~140 tokens vs original ~240)
const ASK_USER_INSTRUCTION = `\n\nYou have access to an "ask_user" tool (via MCP server "_ccs_ask_user"). When you need user input BEFORE proceeding — such as choosing between approaches, confirming an action, or clarifying requirements — you MUST call ask_user instead of writing questions as text. The ask_user tool pauses execution and waits for the user's response. Do NOT ask questions in your text output and then continue working — always use the ask_user tool for questions.`;

const NOTIFY_USER_INSTRUCTION = `\n\nYou have access to a "notify_user" tool (via MCP server "_ccs_notify"). Use it to send non-blocking progress updates to the user. Call notify_user for milestones ("Completed database migration"), warnings ("Rate limit approaching"), errors ("Test suite has 3 failures"), or progress tracking (with current/total steps). Unlike ask_user, notify_user does NOT pause execution — you continue working immediately. Do NOT overuse it: send notifications only for meaningful status changes, not for every minor step.`;

// Status line + tool call instructions (~100 tokens vs original ~170)
const STATUS_LINE_INSTRUCTION = `\n\nIMPORTANT: Always end your response with a single clear status line separated by "---". Use one of these patterns:
- "✅ Done — [brief summary of what was completed]." when the task is fully finished.
- "⏳ In progress — [what's happening now and what comes next]." when you're still working and will continue.
- "❓ Waiting for input — [what you need from the user]." when you need the user to answer or decide something.
- "⚠️ Blocked — [what went wrong and what's needed to proceed]." when something prevents you from continuing.
This status line must always be the very last thing in your response. Never skip it.`;

const TOOL_CALL_INSTRUCTION = `\n\nCRITICAL: After finishing tool calls (Read, Bash, Edit, Write, Grep, etc.), you MUST write a final text response with the status line. NEVER end your turn on a tool call without a text summary. The user cannot see tool results — they only see your text. If you called tools, summarize what you found or did in 1-3 sentences, then add the "---" status line.`;

/**
 * Build system prompt for a chat turn.
 * Caches by sorted skill IDs to avoid rebuilding identical prompts.
 * @param {string[]} skillIds - active skill IDs
 * @param {object} config - merged config with skills definitions
 * @returns {string} assembled system prompt
 */
function buildSystemPrompt(skillIds, config) {
  const cacheKey = [...skillIds].sort().join('|');
  const cached = _systemPromptCache.get(cacheKey);
  if (cached) return cached;

  let prompt = BASE_SYSTEM_INSTRUCTIONS;

  for (const sid of skillIds) {
    const s = config.skills[sid];
    if (!s) continue;
    const content = getSkillContent(resolveSkillFile(s.file));
    if (content) prompt += `\n\n--- SKILL: ${s.label} ---\n${content}`;
  }

  prompt += ASK_USER_INSTRUCTION;
  prompt += NOTIFY_USER_INSTRUCTION;
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
// PROJECTS
// ============================================
function loadProjects() { try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8')); } catch { return []; } }
function saveProjects(p) { const d=path.dirname(PROJECTS_FILE); if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(PROJECTS_FILE, JSON.stringify(p, null, 2)); }

// ============================================
// EXECUTION ENGINES
// ============================================

// --- CLI Single Agent ---
function runCliSingle(p) {
  return new Promise((resolve, reject) => {
    const { prompt, userContent, systemPrompt, mcpServers, model, maxTurns, ws, sessionId, abortController, claudeSessionId, mode, workdir, tabId } = p;
    const mp = mode==='planning' ? 'MODE: PLANNING ONLY. Analyze, plan, DO NOT modify files.\n\n' : mode==='task' ? 'MODE: EXECUTION.\n\n' : '';
    const sp = (mp + (systemPrompt||'')).trim() || undefined;
    const tools = mode==='planning' ? ['View','GlobTool','GrepTool','ListDir','ReadNotebook'] : ['Bash','View','GlobTool','GrepTool','ReadNotebook','NotebookEditCell','ListDir','SearchReplace','Write'];
    let fullText='', newCid=claudeSessionId, chunkCount=0, _settled=false;
    // Safety net: Promise must always settle. onDone is the primary settler;
    // onError is the fallback in case onDone somehow doesn't fire.
    const _resolve = (cid) => { if (!_settled) { _settled=true; resolve(cid); } };
    const cli = new ClaudeCLI({ cwd: workdir || WORKDIR });

    // Pass content blocks to CLI when attachments are present (images need vision input)
    const contentBlocks = Array.isArray(userContent) ? userContent : null;
    cli.send({ prompt, contentBlocks, sessionId:claudeSessionId, model, maxTurns:maxTurns||30, systemPrompt:sp, mcpServers, allowedTools:tools, abortController })
      .onText(t => {
        fullText += t;
        // Accumulate in chatBuffers for catch-up replay on reconnect
        chatBuffers.set(sessionId, (chatBuffers.get(sessionId) || '') + t);
        ws.send(JSON.stringify({ type:'text', text:t, ...(tabId ? { tabId } : {}) }));
        // Persist partial text to DB every 5 chunks so page-refresh doesn't lose content
        if (++chunkCount % 5 === 0) {
          try { stmts.setPartialText.run(fullText, sessionId); } catch {}
        }
      })
      .onThinking(t => { ws.send(JSON.stringify({ type:'thinking', text:t, ...(tabId ? { tabId } : {}) })); })
      .onTool((name, inp) => {
        // Skip internal MCP tools - they have their own handling
        if (name === 'ask_user' || name === 'notify_user') {
          try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,10000),name,null,null,null); } catch {}
          return;
        }
        // Debug: log all tool names to find Ask tool
        if (name.toLowerCase().includes('ask') || name.toLowerCase().includes('question')) {
          log.info('Ask-like tool detected', { name, inputPreview: (inp||'').substring(0, 200) });
        }
        // Handle Ask tool from Claude Code CLI - render as interactive question card
        // Match: "Ask", "mcp__Ask", or tools with "ask" in name (but not ask_user/notify_user which are already filtered)
        if (name === 'Ask' || name === 'mcp__Ask' || (name.toLowerCase().includes('ask') && !name.includes('ask_user'))) {
          try {
            const askData = typeof inp === 'string' ? JSON.parse(inp) : inp;
            // Generate a unique request ID for this ask
            const askRequestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            // Store pending ask for response handling
            if (!pendingCliAsks) pendingCliAsks = new Map();
            pendingCliAsks.set(askRequestId, { sessionId, ws, resolved: false });
            // Send to client for rendering
            ws.send(JSON.stringify({
              type: 'ask_tool',
              requestId: askRequestId,
              question: askData.question || askData.prompt || '',
              options: askData.options || [],
              tabId
            }));
          } catch (e) {
            // If parsing fails, show as regular tool
            ws.send(JSON.stringify({ type:'tool', tool:name, input:(inp||'').substring(0,600), ...(tabId ? { tabId } : {}) }));
          }
        } else {
          ws.send(JSON.stringify({ type:'tool', tool:name, input:(inp||'').substring(0,600), ...(tabId ? { tabId } : {}) }));
        }
        try { stmts.addMsg.run(sessionId,'assistant','tool',(inp||'').substring(0,10000),name,null,null,null); } catch {}
      })
      .onSessionId(sid => { newCid=sid; try { stmts.updateClaudeId.run(sid, sessionId); } catch {} }) // persist early so open-terminal works during active chat
      .onRateLimit(info => { ws.send(JSON.stringify({ type:'rate_limit', info, ...(tabId ? { tabId } : {}) })); })
      .onError(err => {
        // ws.send can throw if the socket is already closed — catch to prevent
        // the exception from propagating back into claude-cli.js and blocking onDone.
        try { ws.send(JSON.stringify({ type:'error', error:err.substring(0,500), ...(tabId ? { tabId } : {}) })); } catch {}
        _resolve(newCid); // safety net: settle even if onDone never fires
      })
      .onDone(sid => {
        if(sid) newCid=sid;
        try { if(fullText) stmts.addMsg.run(sessionId,'assistant','text',fullText,null,null,null,null); } catch {}
        // Clear partial text — full message is now saved to messages table
        try { stmts.setPartialText.run(null, sessionId); } catch {}
        _resolve(newCid);
      });
  });
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
    return runCliSingle(p);
  }

  const planSummaryText = `📋 **${plan.plan}**\n🤖 ${plan.agents.map(a=>`${a.id}(${a.role})`).join(', ')}\n---\n`;
  chatBuffers.set(sessionId, (chatBuffers.get(sessionId) || '') + planSummaryText);
  ws.send(JSON.stringify({ type:'text', text: planSummaryText, ...(tabId ? { tabId } : {}) }));
  ws.send(JSON.stringify({ type:'agent_plan', plan: plan.plan, agents: plan.agents.map(a => ({ id: a.id, role: a.role, task: a.task })), ...(tabId ? { tabId } : {}) }));
  try { stmts.addMsg.run(sessionId,'assistant','text',`Plan: ${plan.plan}`,null,'orchestrator',null,null); } catch {}

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
        cli.send({ prompt:agentPrompt, sessionId: currentSessionId, model, maxTurns:Math.min(maxTurns,15), systemPrompt:agentSp, mcpServers, allowedTools:agentTools, abortController })
          .onText(t => { agentText+=t; chatBuffers.set(sessionId, (chatBuffers.get(sessionId) || '') + t); try { ws.send(JSON.stringify({ type:'text', text:t, agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} })
          .onTool((n,i) => { if (n !== 'ask_user' && n !== 'notify_user') { try { ws.send(JSON.stringify({ type:'tool', tool:n, input:(i||'').substring(0,600), agent:agent.id, ...(tabId ? { tabId } : {}) })); } catch {} } try { stmts.addMsg.run(sessionId,'assistant','tool',(i||'').substring(0,10000),n,agent.id,null,null); } catch {} })
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
      .onText(t => { summaryText+=t; chatBuffers.set(sessionId, (chatBuffers.get(sessionId) || '') + t); try { ws.send(JSON.stringify({ type:'text', text:t, agent:'summarizer', ...(tabId ? { tabId } : {}) })); } catch {} })
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

  const payload = JSON.stringify({
    type: 'notification',
    level: level || 'info',
    title: String(title).substring(0, 120),
    detail: detail ? String(detail).substring(0, 500) : '',
    progress: progress || null,
    tabId: sessionId,
    timestamp: Date.now(),
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

app.use(auth.authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

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
app.post('/api/test/ask-tool', express.json(), (req, res) => {
  const { sessionId, question, options } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  // Find active WebSocket for this session
  const task = activeTasks.get(sessionId);
  const ws = task?.proxy;
  if (!ws) return res.status(404).json({ error: 'No active session' });

  const askRequestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  ws.send(JSON.stringify({
    type: 'ask_tool',
    requestId: askRequestId,
    question: question || 'Which option do you prefer?',
    options: options || ['Option A', 'Option B', 'Option C'],
    tabId: sessionId
  }));

  res.json({ ok: true, requestId: askRequestId });
});

// Test endpoint to simulate MCP ask_user (for UI testing)
app.post('/api/test/ask-user', express.json(), (req, res) => {
  const { sessionId, question, questions, options, inputType } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  // Find active WebSocket for this session
  const task = activeTasks.get(sessionId);
  const ws = task?.proxy;
  if (!ws) return res.status(404).json({ error: 'No active session' });

  const requestId = crypto.randomUUID();

  // Build payload matching MCP ask_user format
  const payload = {
    type: 'ask_user',
    requestId,
    tabId: sessionId
  };

  // Single question format
  if (question) {
    payload.question = question;
    if (options) payload.options = options;
    if (inputType) payload.inputType = inputType;
  }

  // Multiple questions format (paginated)
  if (questions && Array.isArray(questions)) {
    payload.questions = questions;
  }

  // Default if nothing specified
  if (!question && !questions) {
    payload.question = 'What would you like to do?';
    payload.options = ['Option A', 'Option B', 'Option C'];
    payload.inputType = 'single_choice';
  }

  ws.send(JSON.stringify(payload));
  res.json({ ok: true, requestId, payload });
});

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
    const { total } = stmts.contextTokens.get(sessionId);
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
  const { title='Нова задача', description='', notes='', status='backlog', sort_order=0, session_id=null, workdir=null,
          model='sonnet', mode='auto', agent_mode='single', max_turns=30, attachments=null } = req.body;
  const id = genId();
  stmts.createTask.run(id, title.substring(0,200), description.substring(0,2000), (notes||'').substring(0,2000), status, sort_order, session_id||null, workdir||null, model, mode, agent_mode, max_turns, attachments||null);
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
          max_turns=task.max_turns||30, attachments=task.attachments } = req.body;
  // Stop running process when task is moved away from in_progress
  if (task.status === 'in_progress' && status !== 'in_progress') {
    const ctrl = runningTaskAborts.get(req.params.id);
    if (ctrl) {
      stoppingTasks.add(req.params.id);
      ctrl.abort();
      console.log(`[taskWorker] aborting task "${task.title}" (${req.params.id}) — moved to ${status}`);
    } else if (task.worker_pid) {
      stoppingTasks.add(req.params.id);
      try { process.kill(task.worker_pid, 'SIGTERM'); } catch {}
    }
  }
  stmts.updateTask.run(
    String(title).substring(0,200), String(description).substring(0,2000),
    String(notes||'').substring(0,2000),
    status, sort_order, session_id || null, workdir || null,
    model, mode, agent_mode, max_turns, attachments || null,
    req.params.id
  );
  const updated = stmts.getTask.get(req.params.id);
  if (status === 'todo' && task.status !== 'todo') setImmediate(processQueue);
  res.json(updated);
});
app.delete('/api/tasks/:id', (req, res) => {
  stmts.deleteTask.run(req.params.id); res.json({ ok: true });
});

// Sessions
app.get('/api/sessions', (req,res) => {
  const { workdir } = req.query;
  res.json(workdir ? stmts.getSessionsByWorkdir.all(workdir) : stmts.getSessions.all());
});
app.post('/api/sessions', (req, res) => {
  const { title = 'Нова сесія', workdir = null, model = 'sonnet', mode = 'auto', agentMode = 'single', engine = null } = req.body || {};
  const id = genId();
  stmts.createSession.run(id, String(title).substring(0, 200), '[]', '[]', mode, agentMode, model, engine, workdir || null);
  res.json(stmts.getSession.get(id));
});
app.get('/api/sessions/interrupted', (req, res) => { res.json(stmts.getInterrupted.all()); });
app.get('/api/sessions/:id', (req,res) => {
  const s = stmts.getSession.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.messages = stmts.getMsgs.all(req.params.id);
  // Include running-task flag so client can show spinner immediately on load
  const rt = db.prepare(`SELECT id FROM tasks WHERE session_id=? AND status='in_progress' LIMIT 1`).get(req.params.id);
  s.hasRunningTask = !!rt;
  // True when a direct-chat streaming session is alive in memory (not a Kanban task)
  s.isChatRunning = activeTasks.has(req.params.id);
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
app.get('/api/sessions/:id/tasks-count', (req,res) => { res.json(stmts.countTasksBySession.get(req.params.id)); });
app.delete('/api/sessions/:id', (req,res) => { stmts.deleteTasksBySession.run(req.params.id); stmts.deleteSession.run(req.params.id); res.json({ok:true}); });
app.post('/api/sessions/:id/open-terminal', (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session?.claude_session_id) return res.status(400).json({ error: 'No Claude session ID' });
  const safeSid = session.claude_session_id.replace(/[^a-zA-Z0-9-]/g, '');
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
  // Auto-discover skills from global dir that are not already in config
  if (fs.existsSync(GLOBAL_SKILLS_DIR)) {
    for (const f of fs.readdirSync(GLOBAL_SKILLS_DIR).filter(f => f.endsWith('.md'))) {
      const id = path.parse(f).name;
      if (!c.skills[id]) c.skills[id] = { label:`🌐 ${id}`, description:'Global skill (~/.claude/skills/)', file:path.join(GLOBAL_SKILLS_DIR, f), global:true };
    }
  }
  // Auto-discover skills from local dir (APP_DIR/skills/) that are not already in config
  if (fs.existsSync(SKILLS_DIR)) {
    for (const f of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'))) {
      const id = path.parse(f).name;
      if (!c.skills[id]) {
        const meta = BUNDLED_SKILL_META[id] || {};
        c.skills[id] = { label: meta.label || `📄 ${id}`, description:'Local skill', file:`skills/${f}`, ...(meta.category ? { category:meta.category } : {}) };
      }
    }
  }
  // Auto-discover bundled skills (__dirname/skills/) when running via npx (APP_DIR != __dirname)
  const BUNDLED_SKILLS_DIR = path.join(__dirname, 'skills');
  if (BUNDLED_SKILLS_DIR !== SKILLS_DIR && fs.existsSync(BUNDLED_SKILLS_DIR)) {
    for (const f of fs.readdirSync(BUNDLED_SKILLS_DIR).filter(f => f.endsWith('.md'))) {
      const id = path.parse(f).name;
      if (!c.skills[id]) {
        const meta = BUNDLED_SKILL_META[id] || {};
        c.skills[id] = { label: meta.label || `📄 ${id}`, description:'Bundled skill', file:path.join(BUNDLED_SKILLS_DIR, f), ...(meta.category ? { category:meta.category } : {}) };
      }
    }
  }
  for (const[k,s] of Object.entries(c.skills||{})) { try{s.content=fs.readFileSync(resolveSkillFile(s.file),'utf-8')}catch{s.content=''} }
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
  const{env,headers,url,args}=req.body;
  if(!c.mcpServers[id]){
    const merged=loadMergedConfig();
    if(!merged.mcpServers[id]) return res.status(404).json({error:'Not found'});
    c.mcpServers[id]={...merged.mcpServers[id]};
  }
  if(env !== undefined) c.mcpServers[id].env=env; // full replace, not merge — supports deletion
  if(headers) c.mcpServers[id].headers={...(c.mcpServers[id].headers||{}),...headers};
  if(url!==undefined) c.mcpServers[id].url=url;
  if(args) c.mcpServers[id].args=args;
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
function resolveFilesWorkdir(reqWorkdir) {
  if (reqWorkdir) {
    const projects = loadProjects();
    const match = projects.find(p => path.resolve(p.workdir) === path.resolve(reqWorkdir));
    if (match) return path.resolve(match.workdir);
    return null; // not a registered project — deny
  }
  return path.resolve(WORKDIR);
}

app.get('/api/files', (req,res) => {
  const dir=req.query.path||'';
  const workdirReal = resolveFilesWorkdir(req.query.workdir);
  if (!workdirReal) return res.status(403).json({error:'Workdir not in registered projects'});
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
  const workdirReal = resolveFilesWorkdir(req.query.workdir);
  if (!workdirReal) return res.status(403).json({error:'Workdir not in registered projects'});
  const fp = path.resolve(workdirReal, fp_rel);
  if (fp !== workdirReal && !fp.startsWith(workdirReal + path.sep)) return res.status(403).json({error:'Denied'});
  try {
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) return res.status(400).json({error:'Cannot download a directory'});
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(fp)}"`);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(fp).pipe(res);
  } catch { res.status(404).json({error:'Not found'}); }
});

app.get('/api/files/raw', (req, res) => {
  const fp_rel = req.query.path || '';
  const workdirReal = resolveFilesWorkdir(req.query.workdir);
  if (!workdirReal) return res.status(403).json({error:'Workdir not in registered projects'});
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
  const { name, workdir, gitInit } = req.body;
  if (!name || !workdir) return res.status(400).json({ error:'name and workdir required' });
  try {
    if (!fs.existsSync(workdir)) fs.mkdirSync(workdir, { recursive:true });
    const actions = [];
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

app.delete('/api/projects/:id', (req,res) => {
  saveProjects(loadProjects().filter(p => p.id !== req.params.id));
  res.json({ ok:true });
});

// Directory browser — list directories at given path (no restriction to WORKDIR)
app.get('/api/browse-dirs', (req, res) => {
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
    const parent = path.dirname(dir) !== dir ? path.dirname(dir) : null;
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
      items: queue.map(m => ({ id: m._queueId, queueId: m.queueId || null, text: m.text || '' })),
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
        stmts.createSession.run(localSessionId,'Нова сесія','[]','[]',msg.mode||'auto',msg.agentMode||'single',msg.model||'sonnet',msg.engine||null,msg.workdir||null);
        isNewSession = true;
      } else {
        localClaudeId = existSess.claude_session_id || undefined;
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
        if (ws._tabQueue[tabId]) { ws._tabQueue[localSessionId] = ws._tabQueue[tabId]; delete ws._tabQueue[tabId]; }
      }

      const { text:userMessage, attachments=[], skills:sIds=[], mcpServers:mIds=[], mode='auto', agentMode='single', model='sonnet', maxTurns=30, workdir=null, reply_to=null, retry=false } = msg;

      let replyQuote = '';
      if (reply_to && reply_to.content) {
        const snippet = String(reply_to.content).slice(0, 200);
        replyQuote = `[Replying to: ${reply_to.role || 'user'}: ${snippet}]\n\n`;
      }
      const replyToId = reply_to?.id ?? null;
      const engineMessage = replyQuote + userMessage;
      const userContent = buildUserContent(engineMessage, attachments);

      if (!retry) {
        const attJson = attachments.length ? JSON.stringify(attachments.map(a => ({ type: a.type, name: a.name, base64: a.base64 }))) : null;
        stmts.addMsg.run(localSessionId,'user','text',userMessage,null,null,replyToId,attJson);
      } else {
        stmts.incrementRetry.run(localSessionId);
      }
      stmts.updateConfig.run(JSON.stringify(mIds),JSON.stringify(sIds),mode,agentMode,model,workdir||null,localSessionId);

      // Auto-title (reuses existSess from initial lookup — no extra DB query)
      if (isNewSession || existSess?.title==='Нова сесія') {
        const title=userMessage.substring(0,60)+(userMessage.length>60?'...':'');
        stmts.updateTitle.run(title, localSessionId);
        ws.send(JSON.stringify({ type:'session_title', sessionId:localSessionId, title, tabId: effectiveTabId }));
      }
      const config = loadMergedConfig();
      const abortController = new AbortController();
      myAbortController = abortController;
      if (effectiveTabId) ws._tabAbort[effectiveTabId] = abortController;
      else ws._abort = abortController;

      // Build system prompt — cached by skill combination, skill files cached in memory
      const systemPrompt = buildSystemPrompt(sIds, config);

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

      proxy.send(JSON.stringify({ type:'status', status:'thinking', mode, agentMode, model, tabId: effectiveTabId }));

      // Register task in activeTasks so it survives client disconnect/reload
      stmts.setLastUserMsg.run(userMessage, localSessionId);
      chatBuffers.set(localSessionId, ''); // reset buffer for this session
      activeTasks.set(localSessionId, { proxy, abortController, cleanupTimer: null });

      const params = {
        prompt: engineMessage,
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
      if (agentMode==='multi') {
        newCid = await runMultiAgent(params);
      } else {
        newCid = await runCliSingle(params);
      }
      if (newCid) { stmts.updateClaudeId.run(newCid, localSessionId); }

      proxy.send(JSON.stringify({ type:'done', tabId: effectiveTabId, duration: Date.now() - _chatStartedAt }));
      proxy.send(JSON.stringify({ type:'files_changed' }));
    } catch(err) {
      if(err.name==='AbortError') proxy.send(JSON.stringify({ type:'agent_status', status:'Stopped', statusKey:'status.stopped', tabId: effectiveTabId }));
      else { log.error('chat error', { message: err.message, name: err.name }); proxy.send(JSON.stringify({ type:'error', error:err.message, tabId: effectiveTabId })); }
      proxy.send(JSON.stringify({ type:'done', tabId: effectiveTabId, duration: Date.now() - _chatStartedAt }));
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
          ws.send(queuePayload(effectiveTabId));
          processChat(next).catch(err => log.error('processChat tab-queue error', { message: err.message }));
        } else {
          delete ws._tabQueue[effectiveTabId];
          ws.send(JSON.stringify({ type: 'queue_update', tabId: effectiveTabId, pending: 0, items: [] }));
        }
      } else if (!isStale) {
        ws._busy = false;
        ws._abort = null;
        if (ws._queue.length > 0) {
          const next = ws._queue.shift();
          ws.send(queuePayload(null));
          try { await processChat(next); } catch (err) { log.error('processChat legacy-queue error', { message: err.message }); }
        } else {
          ws.send(JSON.stringify({ type: 'queue_update', pending: 0, items: [] }));
        }
      }
    }
  }

  ws.on('message', async (raw) => {
    let msg; try{msg=JSON.parse(raw)}catch{return}

    if (msg.type==='start_session') {
      legacySessionId = msg.sessionId || genId();
      const existing = stmts.getSession.get(legacySessionId);
      if (existing) legacyClaudeId = existing.claude_session_id || undefined;
      else stmts.createSession.run(legacySessionId,'Нова сесія','[]','[]',msg.mode||'auto',msg.agentMode||'single',msg.model||'sonnet',msg.engine||null,null);
      ws.send(JSON.stringify({ type:'session_started', sessionId:legacySessionId }));
      return;
    }

    if (msg.type==='chat') {
      const tabId = msg.tabId || null;
      if (tabId) {
        // Per-tab concurrency: queue if this specific tab is busy
        if (ws._tabBusy[tabId]) {
          if (!ws._tabQueue[tabId]) ws._tabQueue[tabId] = [];
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
          else if (runningTask.worker_pid) { try { process.kill(runningTask.worker_pid, 'SIGTERM'); } catch {} }
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

    // ─── Ask User responses ──────────────────────────────────────────────────
    if (msg.type === 'ask_user_response') {
      const entry = pendingAskUser.get(msg.requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingAskUser.delete(msg.requestId);
        entry.resolve({ answer: msg.answer || '[Empty response]' });
      }
      return;
    }

    if (msg.type === 'ask_user_cancel') {
      const entry = pendingAskUser.get(msg.requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingAskUser.delete(msg.requestId);
        entry.resolve({ answer: '[Skipped by user]' });
      }
      return;
    }

    // ─── CLI Ask Tool responses ───────────────────────────────────────────────
    if (msg.type === 'ask_tool_response') {
      const entry = pendingCliAsks.get(msg.requestId);
      if (entry && !entry.resolved) {
        entry.resolved = true;
        pendingCliAsks.delete(msg.requestId);
        // The answer will be sent as the next user message in the chat
        // This is handled client-side by adding the answer to the input
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
              // Clear proxy buffer — already covered by chatBuf above
              activeTask.proxy._buffer = [];
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
        // Re-send queue state so client can restore queued message badges after tab switch
        if (ws._tabQueue?.[sessionId]?.length > 0 && ws.readyState === 1) {
          ws.send(queuePayload(sessionId));
        }
      }
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
          task.proxy._buffer = [];
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
    ws._tabAbort = {};
    ws._tabBusy  = {};
    ws._tabQueue = {};
  });
});

server.listen(PORT, () => {
  log.info('server started', {
    port:      PORT,
    url:       `http://localhost:${PORT}`,
    workdir:   WORKDIR,
    setup:     auth.isSetupDone() ? 'done' : 'required',
    nodeEnv:   process.env.NODE_ENV || 'development',
    logLevel:  process.env.LOG_LEVEL || 'info',
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
