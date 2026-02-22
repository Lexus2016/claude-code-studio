const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const { execSync } = require('child_process');
const multer = require('multer');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const auth = require('./auth');
const ClaudeCLI = require('./claude-cli');

// ─── Load .env file (no external dependency needed) ───────────────────────
{
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
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

const PORT = process.env.PORT || 3005;
const WORKDIR = process.env.WORKDIR || path.join(__dirname, 'workspace');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ─── Security config ──────────────────────────────────────────────────────────
// Trust X-Forwarded-For when behind nginx/Caddy (needed for rate limiting)
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
// Set secure flag on cookies only when served over HTTPS (behind a proxy)
const SECURE_COOKIES = process.env.TRUST_PROXY === 'true';
// Directories that authenticated users may browse/create projects in
const ALLOWED_BROWSE_ROOTS = [
  path.resolve(os.homedir()),
  path.resolve(WORKDIR),
  path.resolve(__dirname),
];
const SKILLS_DIR = path.join(__dirname, 'skills');
const DB_PATH = path.join(__dirname, 'data', 'chats.db');
const PROJECTS_FILE = path.join(__dirname, 'data', 'projects.json');
const UPLOADS_DIR   = path.join(__dirname, 'data', 'uploads');

// ─── Global Claude Code directory (priority: global → local) ─────────────────
const GLOBAL_CLAUDE_DIR  = path.join(os.homedir(), '.claude');
const GLOBAL_SKILLS_DIR  = path.join(GLOBAL_CLAUDE_DIR, 'skills');
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CLAUDE_DIR, 'config.json');

const claudeCli = new ClaudeCLI({ cwd: WORKDIR });

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
    engine TEXT DEFAULT 'cli',
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

const stmts = {
  createSession: db.prepare(`INSERT INTO sessions (id,title,active_mcp,active_skills,mode,agent_mode,model,engine,workdir) VALUES (?,?,?,?,?,?,?,?,?)`),
  updateTitle: db.prepare(`UPDATE sessions SET title=?,updated_at=datetime('now') WHERE id=?`),
  updateClaudeId: db.prepare(`UPDATE sessions SET claude_session_id=?,updated_at=datetime('now') WHERE id=?`),
  updateConfig: db.prepare(`UPDATE sessions SET active_mcp=?,active_skills=?,mode=?,agent_mode=?,model=?,engine=?,workdir=?,updated_at=datetime('now') WHERE id=?`),
  getSessions: db.prepare(`SELECT id,title,created_at,updated_at,mode,agent_mode,model,engine,workdir FROM sessions ORDER BY updated_at DESC LIMIT 100`),
  getSessionsByWorkdir: db.prepare(`SELECT id,title,created_at,updated_at,mode,agent_mode,model,engine,workdir FROM sessions WHERE workdir=? ORDER BY updated_at DESC LIMIT 100`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id=?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE id=?`),
  addMsg: db.prepare(`INSERT INTO messages (session_id,role,type,content,tool_name,agent_id,reply_to_id) VALUES (?,?,?,?,?,?,?)`),
  getMsgs: db.prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY id ASC`),
  getMsgsPaginated: db.prepare(`SELECT * FROM messages WHERE session_id=? AND (type IS NULL OR type != 'tool') ORDER BY id ASC LIMIT ? OFFSET ?`),
  countMsgs: db.prepare(`SELECT COUNT(*) AS total FROM messages WHERE session_id=? AND (type IS NULL OR type != 'tool')`),
  setLastUserMsg: db.prepare(`UPDATE sessions SET last_user_msg=? WHERE id=?`),
  clearLastUserMsg: db.prepare(`UPDATE sessions SET last_user_msg=NULL WHERE id=?`),
  getInterrupted: db.prepare(`SELECT id, title, last_user_msg FROM sessions WHERE last_user_msg IS NOT NULL`),
  // Tasks (Kanban)
  getTasks: db.prepare(`
    SELECT t.*, s.title as sess_title, s.claude_session_id, s.model as sess_model,
           s.updated_at as sess_updated_at
    FROM tasks t LEFT JOIN sessions s ON t.session_id = s.id
    WHERE (@w IS NULL OR t.workdir = @w)
    ORDER BY t.sort_order ASC, t.created_at ASC
  `),
  getTask: db.prepare(`SELECT * FROM tasks WHERE id=?`),
  createTask: db.prepare(`INSERT INTO tasks (id,title,description,status,sort_order,workdir) VALUES (?,?,?,?,?,?)`),
  updateTask: db.prepare(`UPDATE tasks SET title=?,description=?,status=?,sort_order=?,session_id=?,workdir=?,updated_at=datetime('now') WHERE id=?`),
  patchTaskStatus: db.prepare(`UPDATE tasks SET status=?,sort_order=?,updated_at=datetime('now') WHERE id=?`),
  deleteTask: db.prepare(`DELETE FROM tasks WHERE id=?`),
  getTasksEtag: db.prepare(`SELECT COALESCE(MAX(updated_at),'') as ts, COUNT(*) as n FROM tasks`),
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
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

/** Merge global (~/.claude/config.json) + local config.json for read/display/execution.
 *  Local entries override global entries with the same key. */
function loadMergedConfig() {
  let g = {}, l = {};
  try { g = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')); } catch {}
  try { l = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  return {
    mcpServers: { ...(g.mcpServers||{}), ...(l.mcpServers||{}) },
    skills:     { ...(g.skills||{}),     ...(l.skills||{})     },
  };
}

/** Resolve skill file path.
 *  - Absolute path → used as-is.
 *  - Relative path → try ~/.claude/skills/<basename> first, then project root. */
function resolveSkillFile(file) {
  if (path.isAbsolute(file)) return file;
  const globalPath = path.join(GLOBAL_SKILLS_DIR, path.basename(file));
  if (fs.existsSync(globalPath)) return globalPath;
  return path.join(__dirname, file);
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
    let fullText='', newCid=claudeSessionId;
    const cli = new ClaudeCLI({ cwd: workdir || WORKDIR });

    // Pass content blocks to CLI when attachments are present (images need vision input)
    const contentBlocks = Array.isArray(userContent) ? userContent : null;
    cli.send({ prompt, contentBlocks, sessionId:claudeSessionId, model, maxTurns:maxTurns||30, systemPrompt:sp, mcpServers, allowedTools:tools, abortController })
      .onText(t => { fullText+=t; ws.send(JSON.stringify({ type:'text', text:t, ...(tabId ? { tabId } : {}) })); })
      .onThinking(t => { ws.send(JSON.stringify({ type:'thinking', text:t, ...(tabId ? { tabId } : {}) })); })
      .onTool((name, inp) => { ws.send(JSON.stringify({ type:'tool', tool:name, input:(inp||'').substring(0,600), ...(tabId ? { tabId } : {}) })); stmts.addMsg.run(sessionId,'assistant','tool',inp||'',name,null,null); })
      .onSessionId(sid => { newCid=sid; })
      .onError(err => { ws.send(JSON.stringify({ type:'error', error:err.substring(0,500), ...(tabId ? { tabId } : {}) })); })
      .onDone(sid => { if(sid) newCid=sid; if(fullText) stmts.addMsg.run(sessionId,'assistant','text',fullText,null,null,null); resolve(newCid); });
  });
}

// --- Multi-Agent (CLI only) ---
async function runMultiAgent(p) {
  const { prompt, systemPrompt, mcpServers, model, maxTurns, ws, sessionId, abortController, tabId } = p;
  ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'🧠 Планування...', ...(tabId ? { tabId } : {}) }));

  // Get plan via CLI
  let planText = '';
  const planPrompt = `You are a lead architect. Break this into 2-5 subtasks. Respond ONLY in JSON:\n{"plan":"...","agents":[{"id":"agent-1","role":"...","task":"...","depends_on":[]}]}\n\nTASK: ${prompt}`;

  await new Promise(res => {
    claudeCli.send({ prompt:planPrompt, model, maxTurns:1, allowedTools:[], abortController })
      .onText(t => { planText+=t; }).onDone(() => res());
  });

  let plan = null;
  try { const m = planText.match(/\{[\s\S]*\}/); if (m) plan = JSON.parse(m[0]); } catch {}

  if (!plan?.agents?.length) {
    ws.send(JSON.stringify({ type:'agent_status', agent:'orchestrator', status:'⚠️ Перехід до одиночного режиму', ...(tabId ? { tabId } : {}) }));
    return runCliSingle(p);
  }

  ws.send(JSON.stringify({ type:'text', text:`📋 **${plan.plan}**\n🤖 ${plan.agents.map(a=>`${a.id}(${a.role})`).join(', ')}\n---\n`, ...(tabId ? { tabId } : {}) }));
  stmts.addMsg.run(sessionId,'assistant','text',`Plan: ${plan.plan}`,null,'orchestrator',null);

  const completed = new Set(), results = {};
  const remaining = [...plan.agents];

  while (remaining.length) {
    const runnable = remaining.filter(a => (a.depends_on||[]).every(d => completed.has(d)));
    if (!runnable.length) { ws.send(JSON.stringify({ type:'error', error:'Circular deps', ...(tabId ? { tabId } : {}) })); break; }

    await Promise.all(runnable.map(async agent => {
      remaining.splice(remaining.indexOf(agent), 1);
      ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`🔄 ${agent.role}`, ...(tabId ? { tabId } : {}) }));
      const depCtx = (agent.depends_on||[]).map(d => results[d] ? `\n[${d}]:${results[d].substring(0,500)}` : '').join('');
      const agentPrompt = agent.task + (depCtx ? '\nContext:'+depCtx : '');
      const agentSp = `You are ${agent.role}. ${systemPrompt||''}`;
      const agentTools = ['Bash','View','GlobTool','GrepTool','ListDir','SearchReplace','Write'];
      let agentText = '';

      await new Promise(res => {
        claudeCli.send({ prompt:agentPrompt, model, maxTurns:Math.min(maxTurns,15), systemPrompt:agentSp, mcpServers, allowedTools:agentTools, abortController })
          .onText(t => { agentText+=t; ws.send(JSON.stringify({ type:'text', text:t, agent:agent.id, ...(tabId ? { tabId } : {}) })); })
          .onTool((n,i) => { ws.send(JSON.stringify({ type:'tool', tool:n, input:(i||'').substring(0,600), agent:agent.id, ...(tabId ? { tabId } : {}) })); stmts.addMsg.run(sessionId,'assistant','tool',i||'',n,agent.id,null); })
          .onDone(() => res());
      });

      results[agent.id] = agentText;
      if (agentText) stmts.addMsg.run(sessionId,'assistant','text',agentText,null,agent.id,null);
      completed.add(agent.id);
      ws.send(JSON.stringify({ type:'agent_status', agent:agent.id, status:`✅ ${agent.role}`, ...(tabId ? { tabId } : {}) }));
    }));
  }
  ws.send(JSON.stringify({ type:'text', text:'\n---\n✅ Всі агенти завершили\n', ...(tabId ? { tabId } : {}) }));
}

// ============================================
// EXPRESS
// ============================================
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
    version:      process.env.npm_package_version || '4.0.0',
    db:           dbOk ? 'ok' : 'error',
    connections:  wss.clients.size,
    memory: {
      rss_mb:  Math.round(mem.rss        / 1024 / 1024),
      heap_mb: Math.round(mem.heapUsed   / 1024 / 1024),
    },
  };
  res.status(dbOk ? 200 : 503).json(payload);
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

app.post('/api/auth/setup', async (req,res) => {
  try {
    const { password, displayName } = req.body;
    const token = await auth.setupUser(password, displayName);
    res.cookie('token', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*60*60*1000 });
    res.json({ ok:true, displayName:displayName||'Admin' });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.post('/api/auth/login', async (req,res) => {
  try {
    const token = await auth.login(req.body.password);
    res.cookie('token', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*60*60*1000 });
    res.json({ ok:true, displayName:auth.loadAuth()?.displayName });
  } catch(e) { res.status(401).json({ error:e.message }); }
});

app.post('/api/auth/logout', (req,res) => { if(req.cookies?.token) auth.revokeToken(req.cookies.token); res.clearCookie('token'); res.json({ ok:true }); });

app.post('/api/auth/change-password', async (req,res) => {
  try {
    const token = await auth.changePassword(req.body.oldPassword, req.body.newPassword);
    res.cookie('token', token, { httpOnly:true, sameSite:'lax', maxAge:30*24*60*60*1000 });
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
app.post('/api/tasks', (req, res) => {
  const { title='Нова задача', description='', status='backlog', sort_order=0, workdir=null } = req.body;
  const id = genId();
  stmts.createTask.run(id, title.substring(0,200), description.substring(0,2000), status, sort_order, workdir||null);
  res.json(stmts.getTask.get(id));
});
app.put('/api/tasks/:id', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const { title=task.title, description=task.description, status=task.status,
          sort_order=task.sort_order, session_id=task.session_id, workdir=task.workdir } = req.body;
  stmts.updateTask.run(
    String(title).substring(0,200), String(description).substring(0,2000),
    status, sort_order, session_id || null, workdir || null, req.params.id
  );
  res.json(stmts.getTask.get(req.params.id));
});
app.delete('/api/tasks/:id', (req, res) => {
  stmts.deleteTask.run(req.params.id); res.json({ ok: true });
});

// Sessions
app.get('/api/sessions', (req,res) => {
  const { workdir } = req.query;
  res.json(workdir ? stmts.getSessionsByWorkdir.all(workdir) : stmts.getSessions.all());
});
app.get('/api/sessions/interrupted', (req, res) => { res.json(stmts.getInterrupted.all()); });
app.get('/api/sessions/:id', (req,res) => { const s=stmts.getSession.get(req.params.id); if(!s) return res.status(404).json({error:'Not found'}); s.messages=stmts.getMsgs.all(req.params.id); res.json(s); });
app.put('/api/sessions/:id', (req,res) => { if(req.body.title) stmts.updateTitle.run(req.body.title, req.params.id); res.json({ok:true}); });
app.delete('/api/sessions/:id', (req,res) => { stmts.deleteSession.run(req.params.id); res.json({ok:true}); });
app.post('/api/sessions/:id/open-terminal', (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session?.claude_session_id) return res.status(400).json({ error: 'No Claude session ID' });
  const safeSid = session.claude_session_id.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeSid) return res.status(400).json({ error: 'Invalid session ID' });
  try {
    execSync(`osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "claude --resume ${safeSid}"'`);
    res.json({ ok: true });
  } catch {
    res.json({ ok: false, command: `claude --resume ${safeSid}` });
  }
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
  const c = loadMergedConfig();
  // Auto-discover skills from global dir that are not already in config
  if (fs.existsSync(GLOBAL_SKILLS_DIR)) {
    for (const f of fs.readdirSync(GLOBAL_SKILLS_DIR).filter(f => f.endsWith('.md'))) {
      const id = path.parse(f).name;
      if (!c.skills[id]) c.skills[id] = { label:`🌐 ${id}`, description:'Global skill (~/.claude/skills/)', file:path.join(GLOBAL_SKILLS_DIR, f), global:true };
    }
  }
  // Auto-discover skills from local dir that are not already in config
  if (fs.existsSync(SKILLS_DIR)) {
    for (const f of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'))) {
      const id = path.parse(f).name;
      if (!c.skills[id]) c.skills[id] = { label:`📄 ${id}`, description:'Local skill', file:`skills/${f}` };
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
  if(env) c.mcpServers[id].env={...(c.mcpServers[id].env||{}),...env};
  if(headers) c.mcpServers[id].headers={...(c.mcpServers[id].headers||{}),...headers};
  if(url!==undefined) c.mcpServers[id].url=url;
  if(args) c.mcpServers[id].args=args;
  saveConfig(c); res.json({ok:true});
});
app.delete('/api/mcp/:id', (req,res) => { const c=loadConfig(); if(c.mcpServers[req.params.id]?.custom){delete c.mcpServers[req.params.id]; saveConfig(c)} res.json({ok:true}); });

const upload = multer({ dest:'/tmp/skills-upload/' });
app.post('/api/skills/upload', upload.single('file'), (req,res) => {
  if(!req.file) return res.status(400).json({error:'No file'});
  const name=req.body.name||path.parse(req.file.originalname).name;
  const id=name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const destFile=`skills/${id}.md`; fs.copyFileSync(req.file.path, path.join(__dirname,destFile)); fs.unlinkSync(req.file.path);
  const c=loadConfig(); c.skills[id]={label:req.body.label||`📄 ${name}`,description:req.body.description||'Custom',file:destFile,custom:true}; saveConfig(c); res.json({ok:true,id});
});
app.delete('/api/skills/:id', (req,res) => { const c=loadConfig(); const s=c.skills[req.params.id]; if(s?.custom){try{fs.unlinkSync(path.join(__dirname,s.file))}catch{} delete c.skills[req.params.id]; saveConfig(c)} res.json({ok:true}); });

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
  try{files['.claude/settings.json']=fs.readFileSync(path.join(process.env.HOME||'/root','.claude','settings.json'),'utf-8')}catch{files['.claude/settings.json']='{}'}
  try{files['.env']=fs.readFileSync(path.join(__dirname,'.env'),'utf-8')}catch{files['.env']=''}
  res.json(files);
});
app.put('/api/config-files', (req,res) => {
  const{filename,content}=req.body;
  const allowed={'config.json':CONFIG_PATH,'CLAUDE.md':path.join(WORKDIR,'CLAUDE.md'),'.claude/settings.json':path.join(process.env.HOME||'/root','.claude','settings.json'),'.env':path.join(__dirname,'.env')};
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
  const parsed = url.parse(req.url, true);
  const token = cookies.token || parsed.query.token;
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

    ws.send(queuePayload(tabId));

    // Resolve session: use sessionId from message, or legacy, or create new
    let localSessionId = msg.sessionId || (tabId ? null : legacySessionId);
    let localClaudeId  = undefined;

    if (!localSessionId || !stmts.getSession.get(localSessionId)) {
      localSessionId = genId();
      stmts.createSession.run(localSessionId,'Нова сесія','[]','[]',msg.mode||'auto',msg.agentMode||'single',msg.model||'sonnet',msg.engine||'cli',msg.workdir||null);
    } else {
      localClaudeId = stmts.getSession.get(localSessionId)?.claude_session_id || undefined;
    }

    // For legacy (no tabId) mode, keep WS-level state in sync
    if (!tabId) { legacySessionId = localSessionId; }

    // Tell client which real session this tab is using (converts temp tab id → real session id)
    ws.send(JSON.stringify({ type:'session_started', sessionId:localSessionId, tabId }));

    // After session_started, use localSessionId as the effective tabId for all subsequent events.
    // The client renames the tab from tempId → localSessionId upon receiving session_started,
    // so further events must carry localSessionId (not the original temp tabId) to be routed correctly.
    const effectiveTabId = tabId ? localSessionId : null;
    // Migrate _tabBusy/_tabAbort keys from tempId to real session id
    if (tabId && tabId !== localSessionId) {
      ws._tabBusy[localSessionId] = true; delete ws._tabBusy[tabId];
      if (ws._tabQueue[tabId]) { ws._tabQueue[localSessionId] = ws._tabQueue[tabId]; delete ws._tabQueue[tabId]; }
    }

    const { text:userMessage, attachments=[], skills:sIds=[], mcpServers:mIds=[], mode='auto', agentMode='single', model='sonnet', maxTurns=30, engine='cli', workdir=null, reply_to=null } = msg;

    let replyQuote = '';
    if (reply_to && reply_to.content) {
      const snippet = String(reply_to.content).slice(0, 200);
      replyQuote = `[Replying to: ${reply_to.role || 'user'}: ${snippet}]\n\n`;
    }
    const replyToId = reply_to?.id ?? null;
    const engineMessage = replyQuote + userMessage;
    const userContent = buildUserContent(engineMessage, attachments);

    stmts.addMsg.run(localSessionId,'user','text',userMessage,null,null,replyToId);
    stmts.updateConfig.run(JSON.stringify(mIds),JSON.stringify(sIds),mode,agentMode,model,engine,workdir||null,localSessionId);

    // Auto-title
    const session = stmts.getSession.get(localSessionId);
    if (session?.title==='Нова сесія') {
      const title=userMessage.substring(0,60)+(userMessage.length>60?'...':'');
      stmts.updateTitle.run(title, localSessionId);
      ws.send(JSON.stringify({ type:'session_title', sessionId:localSessionId, title, tabId: effectiveTabId }));
    }

    try {
      const config = loadMergedConfig();
      const abortController = new AbortController();
      if (effectiveTabId) ws._tabAbort[effectiveTabId] = abortController;
      else ws._abort = abortController;

      let systemPrompt = `When you are answering a specific question or task that is one of several questions or tasks in the user's message, begin your response with a short quote (1–2 lines) of that specific question or task formatted as a markdown blockquote:\n> <original question or task text>\nThen provide your answer below it. Do not add the blockquote if the message contains only a single question or task.`;
      for (const sid of sIds) { const s=config.skills[sid]; if(s) try{systemPrompt+=`\n\n--- SKILL: ${s.label} ---\n${fs.readFileSync(resolveSkillFile(s.file),'utf-8')}`}catch{} }

      const mcpServers = {};
      for (const mid of mIds) {
        const m = config.mcpServers[mid];
        if (!m) continue;
        if (m.type === 'http' || m.type === 'sse' || m.url) {
          mcpServers[mid] = { type: m.type || 'http', url: m.url, ...(m.headers ? { headers: m.headers } : {}), ...(m.env ? { env: m.env } : {}) };
        } else {
          mcpServers[mid] = { command: m.command, args: m.args || [], env: m.env || {} };
        }
      }

      proxy.send(JSON.stringify({ type:'status', status:'thinking', mode, agentMode, model, engine, tabId: effectiveTabId }));

      // Register task in activeTasks so it survives client disconnect/reload
      stmts.setLastUserMsg.run(userMessage, localSessionId);
      activeTasks.set(localSessionId, { proxy, abortController, cleanupTimer: null });

      const params = { prompt:engineMessage, userContent, systemPrompt, mcpServers, model, maxTurns, ws: proxy, sessionId:localSessionId, abortController, claudeSessionId:localClaudeId, mode, workdir: workdir || WORKDIR, tabId: effectiveTabId };

      let newCid;
      if (agentMode==='multi') {
        await runMultiAgent(params);
      } else {
        newCid = await runCliSingle(params);
        if (newCid) { stmts.updateClaudeId.run(newCid, localSessionId); }
      }

      proxy.send(JSON.stringify({ type:'done', tabId: effectiveTabId }));
      proxy.send(JSON.stringify({ type:'files_changed' }));
    } catch(err) {
      if(err.name==='AbortError') proxy.send(JSON.stringify({ type:'text', text:'\n[Зупинено]', tabId: effectiveTabId }));
      else { log.error('chat error', { message: err.message, name: err.name }); proxy.send(JSON.stringify({ type:'error', error:err.message, tabId: effectiveTabId })); }
      proxy.send(JSON.stringify({ type:'done', tabId: effectiveTabId }));
    } finally {
      activeTasks.delete(localSessionId);
      try { stmts.clearLastUserMsg.run(localSessionId); } catch {}
      if (effectiveTabId) {
        ws._tabBusy[effectiveTabId] = false;
        delete ws._tabAbort[effectiveTabId];
        const tabQ = ws._tabQueue[effectiveTabId] || [];
        if (tabQ.length > 0) {
          const next = tabQ.shift();
          ws.send(queuePayload(effectiveTabId));
          processChat(next); // fire and don't await to avoid blocking other tabs
        } else {
          delete ws._tabQueue[effectiveTabId];
          ws.send(JSON.stringify({ type: 'queue_update', tabId: effectiveTabId, pending: 0, items: [] }));
        }
      } else {
        ws._busy = false;
        ws._abort = null;
        if (ws._queue.length > 0) {
          const next = ws._queue.shift();
          ws.send(queuePayload(null));
          await processChat(next);
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
      else stmts.createSession.run(legacySessionId,'Нова сесія','[]','[]',msg.mode||'auto',msg.agentMode||'single',msg.model||'sonnet',msg.engine||'cli',null);
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
      processChat(msg); // don't await — allows parallel tabs
      return;
    }

    if (msg.type==='stop') {
      const tabId = msg.tabId;
      if (tabId && ws._tabAbort && ws._tabAbort[tabId]) {
        if (ws._tabQueue) ws._tabQueue[tabId] = [];
        ws._tabAbort[tabId].abort();
        delete ws._tabAbort[tabId];
      } else {
        ws._queue = [];
        if (ws._abort) ws._abort.abort();
        if (ws._tabAbort) { Object.values(ws._tabAbort).forEach(ac => { try { ac.abort(); } catch {} }); ws._tabAbort = {}; }
        if (ws._tabQueue) ws._tabQueue = {};
      }
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

    if (msg.type === 'resume_task') {
      const { sessionId, tabId } = msg;
      const task = activeTasks.get(sessionId);
      if (task) {
        // Task is still running — cancel cleanup timer and re-attach to new WS
        if (task.cleanupTimer) { clearTimeout(task.cleanupTimer); task.cleanupTimer = null; }
        task.proxy.attach(ws);
        if (tabId) ws._tabAbort[tabId] = task.abortController;
        ws.send(JSON.stringify({ type: 'task_resumed', sessionId, tabId }));
      } else {
        // Task not in memory — check if it was interrupted (server crash)
        const session = stmts.getSession.get(sessionId);
        if (session?.last_user_msg) {
          ws.send(JSON.stringify({ type: 'task_interrupted', sessionId, tabId, prompt: session.last_user_msg }));
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
