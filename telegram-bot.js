// ─── Telegram Bot Module for Claude Code Studio ─────────────────────────────
// Long-polling bot that runs alongside the main server.
// No external dependencies — uses Node 20 built-in fetch.
// Security: Telegram User ID whitelist via pairing codes, content sanitization.
'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');

const TELEGRAM_API = 'https://api.telegram.org/bot';
const PAIRING_CODE_TTL = 5 * 60 * 1000; // 5 minutes
const PAIRING_CODE_LENGTH = 6;
const MAX_FAILED_ATTEMPTS = 3;
const BLOCK_DURATION = 15 * 60 * 1000; // 15 minutes after too many wrong codes
const POLL_TIMEOUT = 30; // seconds (Telegram long-polling)
const MAX_MESSAGE_LENGTH = 4000; // Telegram max ~4096, keep margin
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30; // commands per minute

// Patterns that indicate sensitive content — never sent through Telegram
const SENSITIVE_FILE_PATTERNS = [
  /\.env$/i, /\.env\.\w+$/i,
  /auth\.json$/i, /sessions-auth\.json$/i,
  /config\.json$/i,
  /credentials/i, /secrets?\./i,
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
  /id_rsa/i, /id_ed25519/i,
];

const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*['"]?[\w\-\.]{8,}/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /glpat-[a-zA-Z0-9\-_]{20,}/g,
  /xoxb-[a-zA-Z0-9\-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[a-zA-Z0-9\-_.~+/]{20,}/g,
];

// ─── FSM States ─────────────────────────────────────────────────────────────
const FSM_STATES = {
  IDLE: 'IDLE',
  COMPOSING: 'COMPOSING',
  AWAITING_TASK_TITLE: 'AWAITING_TASK_TITLE',
  AWAITING_TASK_DESCRIPTION: 'AWAITING_TASK_DESCRIPTION',
  AWAITING_ASK_RESPONSE: 'AWAITING_ASK_RESPONSE',
};

// ─── Screen Registry ────────────────────────────────────────────────────────
// Defines the navigation hierarchy: each screen has a handler method and a parent.
// parent can be a string (static) or a function (dynamic, e.g. depends on context).
const SCREENS = {
  MAIN:        { parent: null,                                             handler: '_screenMainMenu' },
  PROJECTS:    { parent: 'MAIN',                                           handler: '_screenProjects' },
  PROJECT:     { parent: 'PROJECTS',                                       handler: '_screenProjectSelect' },
  CHATS:       { parent: (ctx) => ctx.projectWorkdir ? 'PROJECT' : 'MAIN', handler: '_screenChats' },
  DIALOG:      { parent: 'CHATS',                                          handler: '_screenDialog' },
  DIALOG_FULL: { parent: 'DIALOG',                                         handler: '_screenDialogFull' },
  FILES:       { parent: (ctx) => ctx.projectWorkdir ? 'PROJECT' : 'MAIN', handler: '_screenFiles' },
  TASKS:       { parent: (ctx) => ctx.projectWorkdir ? 'PROJECT' : 'MAIN', handler: '_screenTasks' },
  STATUS:      { parent: 'MAIN',                                           handler: '_screenStatus' },
  TUNNEL:      { parent: 'MAIN',                                           handler: '_cmdTunnel' },
  SETTINGS:    { parent: 'MAIN',                                           handler: '_screenSettings' },
};

// Maps callback_data prefixes to SCREENS keys for routing lookup.
// Preserves backward compatibility — old buttons in chat history still route correctly.
const CALLBACK_TO_SCREEN = {
  'm:menu':     'MAIN',
  'p:list':     'PROJECTS',
  'p:sel:':     'PROJECT',
  'c:list:':    'CHATS',
  'd:overview': 'DIALOG',
  'd:all:':     'DIALOG_FULL',
  'f:':         'FILES',
  't:list':     'TASKS',
  't:all':      'TASKS',
  'm:status':   'STATUS',
  'tn:menu':    'TUNNEL',
  's:menu':     'SETTINGS',
};

// Reverse map: SCREENS key -> callback_data for Back button navigation.
// Used by _buildBackButton to generate reliable parent callback_data.
const SCREEN_TO_CALLBACK = {
  MAIN:        'm:menu',
  PROJECTS:    'p:list',
  PROJECT:     'p:list',     // back to projects list (project detail needs index we don't have)
  CHATS:       'c:list:0',
  DIALOG:      'd:overview',
  DIALOG_FULL: 'd:all:0',
  FILES:       'f:.',
  TASKS:       't:list',
  STATUS:      'm:status',
  TUNNEL:      'tn:menu',
  SETTINGS:    's:menu',
};

// ─── Bot Internationalization ───────────────────────────────────────────────
const BOT_I18N = require('./telegram-bot-i18n');


class TelegramBot extends EventEmitter {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} opts
   * @param {object} opts.log - Logger instance { info, warn, error, debug }
   */
  constructor(db, opts = {}) {
    super();
    this.db = db;
    this.log = opts.log || console;
    this.token = null;
    this.running = false;
    this._pollTimer = null;
    this._offset = 0;
    this._acceptNewConnections = true;
    this.lang = opts.lang || 'uk';

    // In-memory state
    this._pairingCodes = new Map();  // code → { createdAt, expiresAt }
    this._failedAttempts = new Map(); // telegramUserId → { count, blockedUntil }
    this._userContext = new Map();    // telegramUserId → { sessionId, projectWorkdir }
    this._rateLimit = new Map();     // telegramUserId → { count, resetAt }
    this._currentThreadId = null;    // message_thread_id of the update being processed (forum topics)
    this._forumTopics = new Map();   // threadId → { type, workdir, chatId } (populated from DB)
    this._botId = null;              // bot's own user ID (set on start)

    // DB setup
    this._initDb();
    this._prepareStmts();
  }

  // ─── i18n ─────────────────────────────────────────────────────────────────

  _t(key, params = {}) {
    const dict = BOT_I18N[this.lang] || BOT_I18N.uk;
    let text = dict[key] || BOT_I18N.uk[key] || key;
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return text;
  }

  // ─── Database ──────────────────────────────────────────────────────────────

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL UNIQUE,
        telegram_chat_id INTEGER NOT NULL,
        display_name TEXT,
        username TEXT,
        paired_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active TEXT,
        notifications_enabled INTEGER DEFAULT 1
      );
    `);

    // Phase 2: session persistence columns
    try { this.db.exec("ALTER TABLE telegram_devices ADD COLUMN last_session_id TEXT"); } catch(e) {}
    try { this.db.exec("ALTER TABLE telegram_devices ADD COLUMN last_workdir TEXT"); } catch(e) {}

    // Forum mode: forum_chat_id on device (the supergroup ID)
    try { this.db.exec("ALTER TABLE telegram_devices ADD COLUMN forum_chat_id INTEGER"); } catch(e) {}

    // Forum topics mapping table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS forum_topics (
        thread_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        workdir TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (thread_id, chat_id)
      );
    `);
  }

  _prepareStmts() {
    this._stmts = {
      getDevice:       this.db.prepare('SELECT * FROM telegram_devices WHERE telegram_user_id = ?'),
      getAllDevices:    this.db.prepare('SELECT * FROM telegram_devices ORDER BY paired_at DESC'),
      addDevice:       this.db.prepare('INSERT INTO telegram_devices (telegram_user_id, telegram_chat_id, display_name, username) VALUES (?, ?, ?, ?)'),
      removeDevice:    this.db.prepare('DELETE FROM telegram_devices WHERE id = ?'),
      removeByUserId:  this.db.prepare('DELETE FROM telegram_devices WHERE telegram_user_id = ?'),
      updateLastActive: this.db.prepare('UPDATE telegram_devices SET last_active = datetime(\'now\') WHERE telegram_user_id = ?'),
      getDeviceById:   this.db.prepare('SELECT * FROM telegram_devices WHERE id = ?'),
      updateNotifications: this.db.prepare('UPDATE telegram_devices SET notifications_enabled = ? WHERE telegram_user_id = ?'),
      // Forum mode
      setForumChatId:    this.db.prepare('UPDATE telegram_devices SET forum_chat_id = ? WHERE telegram_user_id = ?'),
      getForumDevice:    this.db.prepare('SELECT * FROM telegram_devices WHERE forum_chat_id = ? AND telegram_user_id = ?'),
      getForumDevices:   this.db.prepare('SELECT * FROM telegram_devices WHERE forum_chat_id IS NOT NULL AND notifications_enabled = 1'),
      addForumTopic:     this.db.prepare('INSERT OR REPLACE INTO forum_topics (thread_id, chat_id, type, workdir) VALUES (?, ?, ?, ?)'),
      getForumTopic:     this.db.prepare('SELECT * FROM forum_topics WHERE thread_id = ? AND chat_id = ?'),
      getForumTopics:    this.db.prepare('SELECT * FROM forum_topics WHERE chat_id = ?'),
      getForumTopicByWorkdir: this.db.prepare('SELECT * FROM forum_topics WHERE chat_id = ? AND type = ? AND workdir = ?'),
      deleteForumTopic:  this.db.prepare('DELETE FROM forum_topics WHERE thread_id = ? AND chat_id = ?'),
      deleteForumTopicsByChatId: this.db.prepare('DELETE FROM forum_topics WHERE chat_id = ?'),
      // Forum sessions
      insertSession:     this.db.prepare("INSERT INTO sessions (id, title, created_at, updated_at, workdir, model, engine) VALUES (?, ?, datetime('now'), datetime('now'), ?, 'sonnet', 'cli')"),
      getSessionsByWorkdir: this.db.prepare('SELECT id, title, updated_at, (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as msg_count FROM sessions s WHERE workdir = ? ORDER BY updated_at DESC LIMIT 15'),
      // Forum tasks
      insertTask:        this.db.prepare("INSERT INTO tasks (id, title, description, notes, status, sort_order, workdir) VALUES (?, ?, '', '', 'backlog', 0, ?)"),
      listTasksOrdered:  this.db.prepare("SELECT id, title, status FROM tasks ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 WHEN 'blocked' THEN 3 WHEN 'done' THEN 4 END, sort_order ASC LIMIT 30"),
      findTaskByIdLike:  this.db.prepare('SELECT * FROM tasks WHERE id LIKE ?'),
      updateTaskStatus:  this.db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?"),
      // Ask notification
      getSessionInfo:    this.db.prepare('SELECT title, workdir FROM sessions WHERE id = ?'),
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the bot with the given token.
   * @param {string} botToken
   */
  async start(botToken) {
    if (this.running) return;
    this.token = botToken;
    if (!this.token) throw new Error('Bot token is required');

    // Validate token and ensure clean polling state
    try {
      const me = await this._callApi('getMe');
      this._botInfo = me;
      this._botId = me.id;

      // Delete any stale webhook — Telegram ignores getUpdates if webhook is set
      await this._callApi('deleteWebhook', { drop_pending_updates: false });

      // Set bot command menu (only /start, /help, /cancel, /status)
      await this._setCommands();

      this.log.info(`[telegram] Bot started: @${me.username} (${me.first_name})`);
    } catch (err) {
      this.log.error(`[telegram] Invalid bot token: ${err.message}`);
      throw new Error(`Invalid bot token: ${err.message}`);
    }

    this.running = true;
    this._poll();

    // Periodic cleanup of in-memory Maps to prevent unbounded growth
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this._pairingCodes) if (now > v.expiresAt) this._pairingCodes.delete(k);
      for (const [k, v] of this._failedAttempts) if (now > v.blockedUntil) this._failedAttempts.delete(k);
      for (const [k, v] of this._rateLimit) if (now > v.resetAt) this._rateLimit.delete(k);
    }, 10 * 60 * 1000); // every 10 minutes

    return this._botInfo;
  }

  stop() {
    this.running = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.log.info('[telegram] Bot stopped');
  }

  isRunning() { return this.running; }

  getBotInfo() { return this._botInfo || null; }

  // ─── Lock Mode ─────────────────────────────────────────────────────────────

  get acceptNewConnections() { return this._acceptNewConnections; }
  set acceptNewConnections(val) {
    this._acceptNewConnections = !!val;
    if (!val) {
      // Clear all pending pairing codes when locking
      this._pairingCodes.clear();
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  async _poll() {
    if (!this.running) return;
    try {
      const updates = await this._callApi('getUpdates', {
        offset: this._offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: JSON.stringify(['message', 'callback_query']),
      });

      if (updates && updates.length > 0) {
        for (const update of updates) {
          this._offset = update.update_id + 1;
          try {
            await this._handleUpdate(update);
          } catch (err) {
            this.log.error(`[telegram] Error handling update: ${err.message}`);
          }
        }
      }
    } catch (err) {
      // Network errors — retry after delay
      if (!err.message?.includes('Invalid bot token')) {
        this.log.warn(`[telegram] Poll error (retrying in 5s): ${err.message}`);
        this._pollTimer = setTimeout(() => this._poll(), 5000);
        return;
      }
      this.log.error(`[telegram] Fatal poll error: ${err.message}`);
      this.stop();
      return;
    }

    // Schedule next poll immediately (long-polling handles the wait)
    if (this.running) {
      this._pollTimer = setTimeout(() => this._poll(), 100);
    }
  }

  // ─── Telegram API ──────────────────────────────────────────────────────────

  async _callApi(method, params = {}) {
    const url = `${TELEGRAM_API}${this.token}/${method}`;

    const body = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) body[k] = v;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POLL_TIMEOUT * 1000 + 10000), // poll timeout + margin
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || `Telegram API error: ${method}`);
    }
    return data.result;
  }

  async _sendMessage(chatId, text, options = {}) {
    // Truncate long messages
    let safeText = text;
    if (safeText.length > MAX_MESSAGE_LENGTH) {
      safeText = safeText.substring(0, MAX_MESSAGE_LENGTH) + '\n\n' + this._t('files_truncated_short');
    }

    const params = {
      chat_id: chatId,
      text: safeText,
      parse_mode: 'HTML',
      ...options,
    };

    // Auto-inject thread_id for forum topics (unless already specified)
    if (this._currentThreadId && !params.message_thread_id) {
      params.message_thread_id = this._currentThreadId;
    }

    try {
      return await this._callApi('sendMessage', params);
    } catch (err) {
      // Retry without parse_mode if HTML parsing fails
      if (err.message?.includes("can't parse")) {
        params.parse_mode = undefined;
        return await this._callApi('sendMessage', params);
      }
      throw err;
    }
  }

  async _editScreen(chatId, msgId, text, keyboard) {
    if (!msgId) {
      // No message to edit — send a new one
      return this._showScreen(chatId, null, text, keyboard);
    }

    const params = {
      chat_id: chatId,
      message_id: msgId,
      text: text.length > MAX_MESSAGE_LENGTH ? text.substring(0, MAX_MESSAGE_LENGTH) + '\n\n' + this._t('files_truncated_short') : text,
      parse_mode: 'HTML',
    };
    if (keyboard) params.reply_markup = JSON.stringify({ inline_keyboard: keyboard });

    try {
      return await this._callApi('editMessageText', params);
    } catch (err) {
      if (err.message?.includes('message is not modified')) return null;
      if (err.message?.includes("can't parse")) {
        params.parse_mode = undefined;
        try { return await this._callApi('editMessageText', params); } catch { /* fall through */ }
      }
      // Any edit failure — fall back to sending a new message
      this.log.warn(`[telegram] editScreen fallback to new message: ${err.message}`);
      return this._showScreen(chatId, null, text, keyboard);
    }
  }

  async _showScreen(chatId, userId, text, keyboard) {
    const params = {};
    if (keyboard) params.reply_markup = JSON.stringify({ inline_keyboard: keyboard });
    const sent = await this._sendMessage(chatId, text, params);
    return sent;
  }

  async _answerCallback(callbackQueryId, text) {
    try {
      await this._callApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
    } catch {}
  }

  /**
   * Build a Back button row for the given screen key.
   * Uses the SCREENS registry parent chain to determine the back destination.
   * @param {string} screenKey - Key from SCREENS registry (e.g. 'PROJECTS', 'DIALOG')
   * @param {object} ctx - User context (for dynamic parent resolution)
   * @returns {Array|null} Inline keyboard row with back button, or null for MAIN
   */
  _buildBackButton(screenKey, ctx) {
    const screen = SCREENS[screenKey];
    if (!screen) return null;
    let parentKey;
    if (typeof screen.parent === 'function') {
      parentKey = screen.parent(ctx);
    } else {
      parentKey = screen.parent;
    }
    if (!parentKey) return null; // MAIN has no back button
    const parentCb = SCREEN_TO_CALLBACK[parentKey] || 'm:menu';
    return [{ text: this._t('btn_back'), callback_data: parentCb }];
  }

  /**
   * Build a context header line showing active project/chat.
   * Prepended to every screen's text body for consistent context visibility.
   * @param {object} ctx - User context (projectWorkdir, sessionId)
   * @returns {string} Formatted header with trailing double newline
   */
  _buildContextHeader(ctx) {
    const parts = [];
    if (ctx.projectWorkdir) {
      const name = ctx.projectWorkdir.split('/').filter(Boolean).pop() || '...';
      parts.push(this._t('header_project', { name: this._escHtml(name) }));
    }
    if (ctx.sessionId) {
      try {
        const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
        if (sess?.title) {
          parts.push(this._t('header_chat', { title: this._escHtml(sess.title.substring(0, 30)) }));
        }
      } catch { /* ignore DB errors in header */ }
    }
    if (parts.length === 0) return this._t('header_none') + '\n\n';
    return parts.join(this._t('header_separator')) + '\n\n';
  }

  // ─── Persistent Reply Keyboard ────────────────────────────────────────────

  /**
   * Build a dynamic context-aware persistent reply keyboard.
   * Row 1: Write button (+ chat name if session active), Menu button.
   * Row 2: Project button (if project active), Status button.
   * @param {object} ctx - User context
   * @returns {object} ReplyKeyboardMarkup object
   */
  _buildReplyKeyboard(ctx) {
    const row1 = [];

    // Write button always first — includes chat name when session active
    if (ctx.sessionId) {
      let chatName;
      try {
        const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
        chatName = (sess?.title || this._t('chat_untitled')).substring(0, 18);
      } catch {
        chatName = this._t('chat_untitled');
      }
      row1.push({ text: `${this._t('kb_write')} · ${chatName}` });
    } else {
      row1.push({ text: this._t('kb_write') });
    }
    row1.push({ text: this._t('kb_menu') });

    const rows = [row1];

    // Second row: project context + status
    if (ctx.projectWorkdir) {
      const pName = ctx.projectWorkdir.split('/').filter(Boolean).pop() || '...';
      rows.push([
        { text: `${this._t('kb_project_prefix')} ${pName}`.substring(0, 28) },
        { text: this._t('kb_status') },
      ]);
    } else {
      rows.push([{ text: this._t('kb_status') }]);
    }

    return {
      keyboard: rows,
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  /**
   * Send a message with the dynamic persistent reply keyboard attached.
   * Use when context changes (project/chat selection) to refresh the bottom bar.
   * @param {number} chatId
   * @param {object} ctx - User context
   * @param {string} message - Text to send alongside keyboard update
   */
  async _sendReplyKeyboard(chatId, ctx, message) {
    return this._sendMessage(chatId, message, {
      reply_markup: JSON.stringify(this._buildReplyKeyboard(ctx)),
    });
  }

  /**
   * Set the bot's command menu via setMyCommands.
   * Called once at startup. Only includes /start, /help, /cancel, /status.
   * Navigation commands (/project, /chat, etc.) are intentionally excluded.
   */
  async _setCommands() {
    try {
      await this._callApi('setMyCommands', {
        commands: [
          { command: 'start', description: this._t('cmd_start_desc') },
          { command: 'help', description: this._t('cmd_help_desc') },
          { command: 'cancel', description: this._t('cmd_cancel_desc') },
          { command: 'status', description: this._t('cmd_status_desc') },
        ],
      });
    } catch (err) {
      this.log.warn(`[telegram] Failed to set commands: ${err.message}`);
    }
  }

  // ─── Pairing ───────────────────────────────────────────────────────────────

  /**
   * Generate a new 6-character pairing code.
   * @returns {{ code: string, formattedCode: string, expiresAt: number } | { error: string }}
   */
  generatePairingCode() {
    if (!this._acceptNewConnections) {
      return { error: 'New connections are disabled' };
    }
    if (!this.running) {
      return { error: 'Bot is not running' };
    }

    // Clear expired codes
    const now = Date.now();
    for (const [code, data] of this._pairingCodes) {
      if (now > data.expiresAt) this._pairingCodes.delete(code);
    }

    // Generate unique code
    let code;
    do {
      code = crypto.randomBytes(4).toString('hex').substring(0, PAIRING_CODE_LENGTH).toUpperCase();
    } while (this._pairingCodes.has(code));

    const expiresAt = now + PAIRING_CODE_TTL;
    this._pairingCodes.set(code, { createdAt: now, expiresAt });

    // Format as "XXX·XXX"
    const formattedCode = `${code.slice(0, 3)}·${code.slice(3)}`;

    return { code, formattedCode, expiresAt };
  }

  /**
   * Validate a pairing code submitted by a Telegram user.
   * @returns {boolean}
   */
  _validatePairingCode(code) {
    const clean = code.replace(/[\s·\-\.]/g, '').toUpperCase();
    const data = this._pairingCodes.get(clean);
    if (!data) return false;
    if (Date.now() > data.expiresAt) {
      this._pairingCodes.delete(clean);
      return false;
    }
    // One-time use
    this._pairingCodes.delete(clean);
    return true;
  }

  // ─── Rate Limiting ─────────────────────────────────────────────────────────

  _checkRateLimit(userId) {
    const now = Date.now();
    const entry = this._rateLimit.get(userId);
    if (!entry || now > entry.resetAt) {
      this._rateLimit.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
  }

  _isBlocked(userId) {
    const entry = this._failedAttempts.get(userId);
    if (!entry) return false;
    if (Date.now() > entry.blockedUntil) {
      this._failedAttempts.delete(userId);
      return false;
    }
    return entry.count >= MAX_FAILED_ATTEMPTS;
  }

  _recordFailedAttempt(userId) {
    const entry = this._failedAttempts.get(userId) || { count: 0, blockedUntil: 0 };
    entry.count++;
    if (entry.count >= MAX_FAILED_ATTEMPTS) {
      entry.blockedUntil = Date.now() + BLOCK_DURATION;
    }
    this._failedAttempts.set(userId, entry);
    return entry.count;
  }

  // ─── Authorization ─────────────────────────────────────────────────────────

  _isAuthorized(userId) {
    const device = this._stmts.getDevice.get(userId);
    return !!device;
  }

  // ─── Content Security ──────────────────────────────────────────────────────

  _isSensitiveFile(filePath) {
    return SENSITIVE_FILE_PATTERNS.some(p => p.test(filePath));
  }

  _sanitize(text) {
    if (!text) return '';
    let safe = String(text);
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0; // safety: reset stale state from global regex
      safe = safe.replace(pattern, '[REDACTED]');
    }
    return safe;
  }

  // ─── Update Handler ────────────────────────────────────────────────────────

  async _handleUpdate(update) {
    // Handle callback queries (inline button taps)
    if (update.callback_query) {
      // Set thread context from callback source message
      this._currentThreadId = update.callback_query.message?.message_thread_id || null;
      try {
        await this._handleCallback(update.callback_query);
      } finally {
        this._currentThreadId = null;
      }
      return;
    }

    const msg = update.message;
    if (!msg) return;

    const userId = msg.from?.id;
    const chatId = msg.chat?.id;
    if (!userId || !chatId) return;

    // Set thread context for forum topics
    this._currentThreadId = msg.message_thread_id || null;
    const isForum = msg.chat?.type === 'supergroup' && msg.is_topic_message;

    try {
      // Supergroup: handle /connect command early (before forum routing and auth)
      // Works both with and without @botname suffix, in topics and General
      if (msg.chat?.type === 'supergroup' && msg.text) {
        const connectText = msg.text.trim().toLowerCase().replace(/@\w+$/, '');
        if (connectText === '/connect') {
          return await this._handleForumConnect(msg);
        }
      }

      // Forum mode: route to forum handler if message is from this user's paired forum group
      if (isForum && this._isAuthorized(userId)) {
        const device = this._stmts.getDevice.get(userId);
        if (device?.forum_chat_id !== chatId) return; // Not this user's forum
        if (!this._checkRateLimit(userId)) return;    // Rate-limit forum too
        this._stmts.updateLastActive.run(userId);
        this._restoreDeviceContext(userId);
        return await this._handleForumMessage(msg);
      }

      // Handle media messages (photos, documents, files)
      if (msg.photo || msg.document) {
        if (!this._isAuthorized(userId)) return;
        if (!this._checkRateLimit(userId)) return;
        this._stmts.updateLastActive.run(userId);
        this._restoreDeviceContext(userId);
        return this._handleMediaMessage(msg);
      }

      if (!msg.text) return;

      const text = msg.text.trim();

      // Rate limiting for authorized users
      if (this._isAuthorized(userId) && !this._checkRateLimit(userId)) {
        await this._sendMessage(chatId, this._t('rate_limit'));
        return;
      }

      // If user is not authorized — only handle pairing
      if (!this._isAuthorized(userId)) {
        await this._handleUnauthorized(msg);
        return;
      }

      // Update last active
      this._stmts.updateLastActive.run(userId);

      // Restore persisted context on first interaction
      this._restoreDeviceContext(userId);

      // Persistent keyboard buttons (prefix match for dynamic labels like "✉ Write · chatName")
      if (text === this._t('kb_menu')) { return this._screenMainMenu(chatId, userId); }
      if (text.startsWith(this._t('kb_write'))) { return this._handleWriteButton(chatId, userId); }
      if (text === this._t('kb_status')) { return this._screenStatus(chatId, userId); }
      if (text.startsWith(this._t('kb_project_prefix'))) {
        // Project button tap — show project list (current project context)
        return this._screenProjects(chatId, userId, 'p:list:0');
      }
      // Legacy: 🔔 bell button (replaced by Settings, but keep for backwards compat)
      if (text === '🔔') {
        const device = this._stmts.getDevice.get(userId);
        const newVal = device?.notifications_enabled ? 0 : 1;
        this._stmts.updateNotifications.run(newVal, userId);
        return this._sendMessage(chatId, newVal ? this._t('notif_on') : this._t('notif_off'));
      }

      // Intercept: if there's a pending ask_user question, any text resolves it
      const ctx = this._getContext(userId);
      if (ctx.state === FSM_STATES.AWAITING_ASK_RESPONSE) {
        const requestId = ctx.stateData?.askRequestId;
        ctx.state = FSM_STATES.IDLE;
        ctx.stateData = null;
        this.emit('ask_user_response', { requestId, answer: text });
        await this._sendMessage(chatId, this._t('ask_answered'));
        return;
      }

      // Route commands
      if (text.startsWith('/')) {
        await this._handleCommand(msg);
      } else {
        // Free text — send to active chat session
        await this._handleTextMessage(msg);
      }
    } finally {
      this._currentThreadId = null;
    }
  }

  // ─── Unauthorized User (Pairing Flow) ──────────────────────────────────────

  async _handleUnauthorized(msg) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Check if blocked
    if (this._isBlocked(userId)) {
      await this._sendMessage(chatId, this._t('blocked'));
      return;
    }

    // /start command
    if (text === '/start') {
      if (!this._acceptNewConnections) {
        await this._sendMessage(chatId, this._t('new_conn_disabled'));
        return;
      }
      await this._sendMessage(chatId, this._t('start_pairing'));
      return;
    }

    // Anything else — treat as pairing code attempt
    if (!this._acceptNewConnections) {
      await this._sendMessage(chatId, this._t('new_conn_off'));
      return;
    }

    // Validate pairing code
    const isValid = this._validatePairingCode(text);
    if (isValid) {
      // Register device
      const displayName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Unknown';
      const username = msg.from.username || null;

      try {
        this._stmts.addDevice.run(userId, chatId, displayName, username);
      } catch (err) {
        // UNIQUE constraint — user already paired (shouldn't happen, but handle gracefully)
        if (err.message?.includes('UNIQUE')) {
          await this._sendMessage(chatId, this._t('already_paired'));
          return;
        }
        throw err;
      }

      // Reset failed attempts
      this._failedAttempts.delete(userId);

      this.log.info(`[telegram] Device paired: ${displayName} (@${username || 'no-username'}) [${userId}]`);

      await this._sendMessage(chatId, this._t('paired_ok', { name: this._escHtml(displayName) }));

      // Set persistent Reply Keyboard (dynamic, context-aware)
      const ctx = this._getContext(userId);
      await this._sendReplyKeyboard(chatId, ctx, this._t('use_menu'));

      // Emit event so UI can update in real-time
      this.emit('device_paired', {
        telegram_user_id: userId,
        telegram_chat_id: chatId,
        display_name: displayName,
        username,
      });

    } else {
      const attempts = this._recordFailedAttempt(userId);
      const remaining = MAX_FAILED_ATTEMPTS - attempts;

      if (remaining <= 0) {
        await this._sendMessage(chatId, this._t('blocked'));
      } else {
        await this._sendMessage(chatId, this._t('invalid_code', { remaining }));
      }
    }
  }

  // ─── Command Router ────────────────────────────────────────────────────────

  async _handleCommand(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@\w+$/, ''); // strip @botname

    // FSM-03: Cancel any in-progress input state before executing command
    const ctx = this._getContext(userId);
    ctx.state = FSM_STATES.IDLE;
    ctx.stateData = null;

    switch (cmd) {
      case '/help':    return this._cmdHelp(chatId, userId);
      case '/start':   return this._screenMainMenu(chatId, userId); // already authorized
      // Legacy command — removed from / menu (KB-03), handler kept for backward compat
      case '/projects':return this._cmdProjects(chatId, userId);
      // Legacy command — removed from / menu (KB-03), handler kept for backward compat
      case '/project': return this._cmdProject(chatId, userId, args);
      // Legacy command — removed from / menu (KB-03), handler kept for backward compat
      case '/chats':   return this._cmdChats(chatId, userId);
      // Legacy command — removed from / menu (KB-03), handler kept for backward compat
      case '/chat':    return this._cmdChat(chatId, userId, args);
      case '/last':    return this._cmdLast(chatId, userId, args);
      case '/full':    return this._cmdFull(chatId, userId);
      case '/status':  return this._cmdStatus(chatId, userId);
      case '/tasks':   return this._cmdTasks(chatId, userId);
      case '/files':   return this._cmdFiles(chatId, userId, args);
      case '/cat':     return this._cmdCat(chatId, userId, args);
      case '/diff':    return this._cmdDiff(chatId, userId);
      case '/log':     return this._cmdLog(chatId, userId, args);
      case '/notify':  return this._cmdNotify(chatId, userId, args);
      case '/stop':    return this._cmdStop(chatId, userId);
      case '/info':    return this._cmdInfo(chatId, userId);
      case '/new':     return this._cmdNew(chatId, userId, args.join(' '));
      case '/back':    return this._cmdBack(chatId, userId);
      case '/unlink':  return this._cmdUnlink(chatId, userId);
      case '/forum':   return this._cmdForum(chatId, userId);
      case '/tunnel':  return this._cmdTunnel(chatId, userId);
      case '/url':     return this._cmdUrl(chatId);
      default:
        await this._sendMessage(chatId, this._t('error_unknown_cmd', { cmd }), {
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
          ] }),
        });
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  async _cmdHelp(chatId, userId) {
    await this._showScreen(chatId, userId, this._t('help_text'),
      [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
  }

  async _cmdProjects(chatId, userId) {
    return this._screenProjects(chatId, userId, 'p:list:0');
  }

  async _cmdProject(chatId, userId, args) {
    const ctx = this._getContext(userId);

    if (args.length === 0) {
      if (ctx.projectWorkdir) {
        const name = this._escHtml(ctx.projectWorkdir.split('/').filter(Boolean).pop());
        await this._sendMessage(chatId, this._t('project_current', { name }));
      } else {
        await this._sendMessage(chatId, this._t('project_hint'));
      }
      return;
    }

    const idx = parseInt(args[0], 10) - 1;
    if (!ctx.projectList || idx < 0 || idx >= ctx.projectList.length) {
      await this._sendMessage(chatId, this._t('project_invalid'));
      return;
    }

    ctx.projectWorkdir = ctx.projectList[idx];
    ctx.sessionId = null; // reset chat context
    const name = this._escHtml(ctx.projectWorkdir.split('/').filter(Boolean).pop());
    await this._sendMessage(chatId, this._t('project_set', { name }));
  }

  async _cmdChats(chatId, userId) {
    // Redirect to button-based screen
    return this._screenChats(chatId, userId, 'c:list:0');
  }

  async _cmdChat(chatId, userId, args) {
    const ctx = this._getContext(userId);

    if (args.length === 0) {
      if (ctx.sessionId) {
        const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
        await this._sendMessage(chatId, this._t('chat_active', { title: this._escHtml(sess?.title || ctx.sessionId) }));
      } else {
        await this._sendMessage(chatId, this._t('chat_hint'));
      }
      return;
    }

    const idx = parseInt(args[0], 10) - 1;
    if (!ctx.chatList || idx < 0 || idx >= ctx.chatList.length) {
      await this._sendMessage(chatId, this._t('chat_invalid'));
      return;
    }

    ctx.sessionId = ctx.chatList[idx];

    // Show last 3 messages
    await this._showMessages(chatId, ctx.sessionId, 3);
  }

  async _cmdLast(chatId, userId, args) {
    const ctx = this._getContext(userId);
    if (!ctx.sessionId) {
      await this._sendMessage(chatId, this._t('select_chat_hint'));
      return;
    }

    const n = Math.min(parseInt(args[0], 10) || 5, 20);
    await this._showMessages(chatId, ctx.sessionId, n);
  }

  async _cmdFull(chatId, userId) {
    const ctx = this._getContext(userId);
    if (!ctx.sessionId) {
      await this._sendMessage(chatId, this._t('select_chat_first'));
      return;
    }

    try {
      const lastMsg = this.db.prepare(`
        SELECT content FROM messages
        WHERE session_id = ? AND role = 'assistant' AND type = 'text'
        ORDER BY id DESC LIMIT 1
      `).get(ctx.sessionId);

      if (!lastMsg) {
        await this._sendMessage(chatId, this._t('no_responses'));
        return;
      }

      const sanitized = this._sanitize(lastMsg.content);
      const converted = this._mdToHtml(sanitized);

      // Split into multiple messages if too long — add action bar to last chunk
      const chunks = this._chunkForTelegram(converted, MAX_MESSAGE_LENGTH - 100);
      const isForumTopic = !!this._currentThreadId;
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `📄 <i>(${i + 1}/${chunks.length})</i>\n\n` : '';
        const opts = { parse_mode: 'HTML' };

        // Add action buttons to the last chunk so user always has navigation at the bottom
        if (i === chunks.length - 1) {
          const actionButtons = isForumTopic
            ? [
                [
                  { text: this._t('fm_btn_continue'), callback_data: 'fm:compose' },
                  { text: this._t('fm_btn_diff'), callback_data: 'fm:diff' },
                  { text: this._t('fm_btn_files'), callback_data: 'fm:files' },
                ],
                [
                  { text: this._t('fm_btn_history'), callback_data: 'fm:history' },
                  { text: this._t('fm_btn_new'), callback_data: 'fm:new' },
                  { text: this._t('fm_btn_info'), callback_data: 'fm:info' },
                ],
              ]
            : [
                [
                  { text: this._t('btn_write'), callback_data: 'cm:compose' },
                  { text: this._t('btn_back_chats'), callback_data: 'c:list:0' },
                  { text: this._t('btn_back_menu'), callback_data: 'm:menu' },
                ],
              ];
          opts.reply_markup = JSON.stringify({ inline_keyboard: actionButtons });
        }

        await this._sendMessage(chatId, prefix + chunks[i], opts).catch(() => {
          return this._sendMessage(chatId, (prefix + chunks[i]).replace(/<[^>]+>/g, ''), opts);
        });
      }
    } catch (err) {
      await this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(err.message) }));
    }
  }

  async _cmdStatus(chatId, userId) {
    // Redirect to button-based status screen
    return this._screenStatus(chatId, userId);
  }

  async _cmdTasks(chatId, userId) {
    // Redirect to button-based screen
    return this._screenTasks(chatId, userId, 't:list');
  }

  async _cmdFiles(chatId, userId, args) {
    // Redirect to button-based file browser
    const subPath = args.join(' ') || '.';
    return this._screenFiles(chatId, userId, `f:${subPath}`);
  }

  async _cmdCat(chatId, userId, args) {
    const ctx = this._getContext(userId);
    const fs = require('fs');
    const pathMod = require('path');
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };

    if (args.length === 0) {
      await this._sendMessage(chatId, this._t('cat_usage'), navButtons);
      return;
    }

    const baseDir = ctx.projectWorkdir || process.env.WORKDIR || pathMod.join(process.cwd(), 'workspace');
    const filePath = pathMod.resolve(baseDir, args.join(' '));

    // Security: path traversal check
    if (!filePath.startsWith(baseDir)) {
      await this._sendMessage(chatId, this._t('files_denied'), navButtons);
      return;
    }

    // Security: sensitive file check
    if (this._isSensitiveFile(filePath)) {
      await this._sendMessage(chatId, this._t('files_sensitive'), navButtons);
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const sanitized = this._sanitize(content);
      const ext = pathMod.extname(filePath).slice(1) || 'txt';
      const name = pathMod.basename(filePath);

      if (sanitized.length > MAX_MESSAGE_LENGTH - 200) {
        const truncated = sanitized.substring(0, MAX_MESSAGE_LENGTH - 200);
        await this._sendMessage(chatId,
          `📄 <b>${this._escHtml(name)}</b>\n\n<pre><code class="language-${ext}">${this._escHtml(truncated)}</code></pre>\n\n${this._t('files_truncated', { len: content.length })}`, navButtons);
      } else {
        await this._sendMessage(chatId,
          `📄 <b>${this._escHtml(name)}</b>\n\n<pre><code class="language-${ext}">${this._escHtml(sanitized)}</code></pre>`, navButtons);
      }
    } catch (err) {
      await this._sendMessage(chatId, `❌ ${this._escHtml(err.message)}`, navButtons);
    }
  }

  async _cmdDiff(chatId, userId) {
    const ctx = this._getContext(userId);
    const { execSync } = require('child_process');

    const workdir = ctx.projectWorkdir || process.env.WORKDIR || require('path').join(process.cwd(), 'workspace');
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };

    try {
      const diff = execSync('git diff --stat HEAD', {
        cwd: workdir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (!diff) {
        await this._sendMessage(chatId, this._t('git_no_changes'), navButtons);
        return;
      }

      await this._sendMessage(chatId,
        `📊 <b>Git Diff</b>\n\n<pre><code>${this._escHtml(this._sanitize(diff))}</code></pre>`, navButtons);
    } catch (err) {
      const msg = (err.stderr || err.message || '').toString();
      if (msg.includes('not a git repository') || msg.includes('fatal:')) {
        await this._sendMessage(chatId, this._t('git_no_changes'), navButtons);
      } else {
        await this._sendMessage(chatId, `❌ ${this._escHtml(msg.slice(0, 200))}`, navButtons);
      }
    }
  }

  async _cmdLog(chatId, userId, args) {
    const ctx = this._getContext(userId);
    const { execSync } = require('child_process');

    const n = Math.min(parseInt(args[0], 10) || 5, 15);
    const workdir = ctx.projectWorkdir || process.env.WORKDIR || require('path').join(process.cwd(), 'workspace');
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };

    try {
      const log = execSync(`git log --oneline -${n}`, {
        cwd: workdir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (!log) {
        await this._sendMessage(chatId, this._t('git_not_repo'), navButtons);
        return;
      }

      await this._sendMessage(chatId,
        `${this._t('git_last_commits', { n })}\n\n<pre><code>${this._escHtml(log)}</code></pre>`, navButtons);
    } catch (err) {
      const msg = (err.stderr || err.message || '').toString();
      if (msg.includes('not a git repository') || msg.includes('fatal:')) {
        await this._sendMessage(chatId, this._t('git_not_repo'), navButtons);
      } else {
        await this._sendMessage(chatId, `❌ ${this._escHtml(msg.slice(0, 200))}`, navButtons);
      }
    }
  }

  async _cmdNotify(chatId, userId, args) {
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };
    const val = args[0]?.toLowerCase();
    if (val === 'on' || val === 'off') {
      this._stmts.updateNotifications.run(val === 'on' ? 1 : 0, userId);
      await this._sendMessage(chatId,
        val === 'on' ? this._t('notify_on') : this._t('notify_off'), navButtons);
    } else {
      const device = this._stmts.getDevice.get(userId);
      const current = device?.notifications_enabled ? this._t('status_conn_on') : this._t('status_conn_off');
      await this._sendMessage(chatId, this._t('notify_current', { status: current }), navButtons);
    }
  }

  async _cmdBack(chatId, userId) {
    const ctx = this._getContext(userId);
    if (ctx.sessionId) {
      ctx.sessionId = null;
      return this._screenChats(chatId, userId, 'c:list:0');
    } else if (ctx.projectWorkdir) {
      ctx.projectWorkdir = null;
      ctx.chatList = null;
      return this._screenProjects(chatId, userId, 'p:list:0');
    } else {
      return this._screenMainMenu(chatId, userId);
    }
  }

  async _cmdUnlink(chatId, userId) {
    // Redirect to Settings screen with confirmation instead of instant unlink
    return this._screenSettings(chatId, userId);
  }

  // ─── Tunnel Commands ──────────────────────────────────────────────────────

  async _cmdTunnel(chatId, userId, { editMsgId } = {}) {
    const ctx = this._getContext(userId);
    const keyboard = [
      [
        { text: this._t('tn_btn_start'), callback_data: 'tn:start' },
        { text: this._t('tn_btn_stop'), callback_data: 'tn:stop' },
      ],
      [
        { text: this._t('tn_btn_status'), callback_data: 'tn:status' },
      ],
    ];
    const backRow = this._buildBackButton('TUNNEL', ctx);
    if (backRow) keyboard.push(backRow);

    // Emit to get current status (synchronous handler, timeout as safety net)
    const statusPromise = new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 500);
      this.emit('tunnel_get_status', (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });

    const status = await statusPromise;
    let text;
    if (status?.running) {
      text = this._buildContextHeader(ctx) + this._t('tn_screen_active', { url: status.publicUrl || '—' });
    } else {
      text = this._buildContextHeader(ctx) + this._t('tn_screen_inactive');
    }

    if (editMsgId) {
      await this._editScreen(chatId, editMsgId, text, keyboard);
    } else {
      await this._showScreen(chatId, userId, text, keyboard);
    }
  }

  async _cmdUrl(chatId) {
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };
    const statusPromise = new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 500);
      this.emit('tunnel_get_status', (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });

    const status = await statusPromise;
    if (status?.running && status.publicUrl) {
      await this._sendMessage(chatId, `🔗 ${status.publicUrl}`, navButtons);
    } else {
      await this._sendMessage(chatId, this._t('tn_not_running'), navButtons);
    }
  }

  /**
   * Notify all paired devices about a new tunnel URL.
   * Called by server.js when tunnel starts.
   */
  async notifyTunnelUrl(url) {
    if (!this.running) return;
    const text = this._t('tn_notify_started', { url });
    const devices = this._stmts.getAllDevices.all();
    for (const dev of devices) {
      if (!dev.notifications_enabled) continue;
      if (dev.forum_chat_id) {
        try {
          const ok = await this._notifyForumActivity(dev.forum_chat_id, text);
          if (!ok) await this._sendMessage(dev.telegram_chat_id, text);
        } catch {
          try { await this._sendMessage(dev.telegram_chat_id, text); } catch {}
        }
      } else {
        try { await this._sendMessage(dev.telegram_chat_id, text); } catch {}
      }
    }
  }

  /**
   * Notify all paired devices that the tunnel was closed.
   */
  async notifyTunnelClosed() {
    if (!this.running) return;
    const text = this._t('tn_notify_stopped');
    const devices = this._stmts.getAllDevices.all();
    for (const dev of devices) {
      if (!dev.notifications_enabled) continue;
      if (dev.forum_chat_id) {
        try {
          const ok = await this._notifyForumActivity(dev.forum_chat_id, text);
          if (!ok) await this._sendMessage(dev.telegram_chat_id, text);
        } catch {
          try { await this._sendMessage(dev.telegram_chat_id, text); } catch {}
        }
      } else {
        try { await this._sendMessage(dev.telegram_chat_id, text); } catch {}
      }
    }
  }

  // ─── Text Messages (Send to Chat) ─────────────────────────────────────────

  async _handleTextMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const ctx = this._getContext(userId);

    // ─── Task creation input handling ─────────────────────────────────────
    if (ctx.state === FSM_STATES.AWAITING_TASK_TITLE) {
      const title = (msg.text || '').trim().substring(0, 200);
      if (!title) return;

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const workdir = ctx.stateData?.workdir || null;

      this.db.prepare(
        "INSERT INTO tasks (id, title, description, notes, status, sort_order, workdir) VALUES (?, ?, '', '', 'backlog', 0, ?)"
      ).run(id, title, workdir);

      // Move to description input
      ctx.state = FSM_STATES.AWAITING_TASK_DESCRIPTION;
      ctx.stateData = { ...ctx.stateData, taskId: id, title };

      await this._sendMessage(chatId,
        this._t('new_task_created', { title: this._escHtml(title) }) + '\n\n' + this._t('new_task_with_desc'),
        {
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._t('btn_skip'), callback_data: 't:skip' }],
          ]}),
        }
      );
      return;
    }

    if (ctx.state === FSM_STATES.AWAITING_TASK_DESCRIPTION) {
      const description = (msg.text || '').trim().substring(0, 2000);
      const taskId = ctx.stateData?.taskId;
      const title = ctx.stateData?.title || '';

      if (taskId && description) {
        this.db.prepare("UPDATE tasks SET description = ?, updated_at = datetime('now') WHERE id = ?")
          .run(description, taskId);
      }

      ctx.state = FSM_STATES.IDLE;
      ctx.stateData = null;

      // Show tasks list
      await this._sendMessage(chatId,
        `✅ ${this._escHtml(title)}`,
        {
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._t('btn_tasks'), callback_data: 't:list' }],
            [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
          ]}),
        }
      );
      return;
    }

    // Reset compose mode after sending
    if (ctx.state === FSM_STATES.COMPOSING) {
      ctx.state = FSM_STATES.IDLE;
      ctx.stateData = null;
    }

    if (!ctx.sessionId) {
      // Auto-restore: find last session for current project or create new one
      const workdir = ctx.projectWorkdir || process.env.WORKDIR || './workspace';
      const lastSession = this._stmts.getSessionsByWorkdir.all(workdir);
      if (lastSession.length > 0) {
        ctx.sessionId = lastSession[0].id;
        this._saveDeviceContext(userId);
      } else {
        // Create new session automatically
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        this.db.prepare(
          "INSERT INTO sessions (id, title, created_at, updated_at, workdir, model, engine) VALUES (?, ?, datetime('now'), datetime('now'), ?, 'sonnet', 'cli')"
        ).run(id, 'Telegram Session', workdir);
        ctx.sessionId = id;
        this._saveDeviceContext(userId);
      }
    }

    // Session-project safety: ensure session belongs to current project
    if (ctx.projectWorkdir && ctx.sessionId) {
      const sess = this.db.prepare('SELECT workdir FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (sess && sess.workdir && sess.workdir !== ctx.projectWorkdir) {
        // Session belongs to different project — switch to correct session
        const lastForProject = this._stmts.getSessionsByWorkdir.all(ctx.projectWorkdir);
        if (lastForProject.length > 0) {
          ctx.sessionId = lastForProject[0].id;
        } else {
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          this.db.prepare(
            "INSERT INTO sessions (id, title, created_at, updated_at, workdir, model, engine) VALUES (?, ?, datetime('now'), datetime('now'), ?, 'sonnet', 'cli')"
          ).run(id, 'Telegram Session', ctx.projectWorkdir);
          ctx.sessionId = id;
        }
        this._saveDeviceContext(userId);
      }
    }

    // Collect any pending attachments
    const attachments = ctx.pendingAttachments || [];
    ctx.pendingAttachments = []; // Clear after use

    // Emit event for server.js to handle (send message to Claude)
    this.emit('send_message', {
      sessionId: ctx.sessionId,
      text: msg.text,
      userId,
      chatId,
      attachments,
      callback: async (result) => {
        if (result.error) {
          await this._sendMessage(chatId, `❌ ${this._escHtml(result.error)}`, {
            reply_markup: JSON.stringify({ inline_keyboard: [
              [{ text: '🔄 ' + this._t('btn_refresh'), callback_data: 'cm:compose' },
               { text: this._t('btn_back_menu'), callback_data: 'm:menu' }]
            ]})
          });
        } else {
          const attachNote = attachments.length > 0 ? ` (+ ${attachments.length} file${attachments.length > 1 ? 's' : ''})` : '';
          await this._sendMessage(chatId, this._t('compose_sent', { note: attachNote }), {
            reply_markup: JSON.stringify({ inline_keyboard: [[
              { text: this._t('btn_back_menu'), callback_data: 'm:menu' },
              { text: '💬 ' + this._t('btn_back_chats'), callback_data: 'c:list:0' },
            ]] }),
          });
        }
      },
    });

    // Persist context after sending
    this._saveDeviceContext(userId);
  }

  // ─── Ask User Callback (inline button tap) ────────────────────────────────

  async _handleAskCallback(chatId, userId, msgId, data) {
    const ctx = this._getContext(userId);
    const requestId = ctx.stateData?.askRequestId;

    if (!requestId) {
      await this._sendMessage(chatId, this._t('ask_no_pending'));
      return;
    }

    const suffix = data.slice(4); // after "ask:"

    if (suffix === 'skip') {
      // User skipped the question
      ctx.state = FSM_STATES.IDLE;
      ctx.stateData = null;
      this.emit('ask_user_response', { requestId, answer: '[Skipped by user]' });
      // Edit the question message to show it was skipped
      try {
        await this._callApi('editMessageText', {
          chat_id: chatId,
          message_id: msgId,
          text: this._t('ask_skipped'),
          parse_mode: 'HTML',
        });
      } catch {}
      return;
    }

    // Option selected by index
    const idx = parseInt(suffix, 10);
    if (isNaN(idx) || idx < 0) {
      await this._sendMessage(chatId, this._t('ask_no_pending'));
      return;
    }
    const questions = ctx.stateData?.askQuestions || [];
    const q = questions[0];
    const options = q?.options || [];
    const selected = options[idx];
    const answer = typeof selected === 'string' ? selected : (selected?.value || selected?.label || `Option ${idx + 1}`);

    ctx.state = FSM_STATES.IDLE;
    ctx.stateData = null;
    this.emit('ask_user_response', { requestId, answer });

    // Edit the question message to show what was selected
    try {
      await this._callApi('editMessageText', {
        chat_id: chatId,
        message_id: msgId,
        text: this._t('ask_selected', { option: this._escHtml(answer) }),
        parse_mode: 'HTML',
      });
    } catch {}
  }

  // ─── Notifications (called from server.js) ────────────────────────────────

  /**
   * Send a notification to all paired devices with notifications enabled.
   * @param {string} text - HTML-formatted message
   */
  async notifyAll(text) {
    if (!this.running) return;
    const devices = this._stmts.getAllDevices.all().filter(d => d.notifications_enabled);

    for (const device of devices) {
      try {
        await this._sendMessage(device.telegram_chat_id, text);
      } catch (err) {
        this.log.warn(`[telegram] Failed to notify ${device.display_name}: ${err.message}`);
      }
    }
  }

  /**
   * Send a notification to a specific user.
   */
  async notifyUser(userId, text) {
    if (!this.running) return;
    const device = this._stmts.getDevice.get(userId);
    if (!device || !device.notifications_enabled) return;

    try {
      await this._sendMessage(device.telegram_chat_id, text);
    } catch (err) {
      this.log.warn(`[telegram] Failed to notify ${device.display_name}: ${err.message}`);
    }
  }

  // ─── Device Management ────────────────────────────────────────────────────

  getDevices() {
    return this._stmts.getAllDevices.all();
  }

  removeDevice(id) {
    const device = this._stmts.getDeviceById.get(id);
    if (!device) return false;

    this._stmts.removeDevice.run(id);
    this._userContext.delete(device.telegram_user_id);
    this.emit('device_removed', { telegram_user_id: device.telegram_user_id, id });

    // Notify the user their device was unlinked
    this._sendMessage(device.telegram_chat_id, this._t('unlink_admin')).catch(() => {});

    return true;
  }

  // ─── Inline Keyboard Navigation ───────────────────────────────────────────

  async _handleCallback(cbq) {
    const userId = cbq.from.id;
    const chatId = cbq.message?.chat?.id;
    const msgId = cbq.message?.message_id;
    const data = cbq.data || '';

    if (!chatId || !this._isAuthorized(userId)) {
      this._answerCallback(cbq.id);
      return;
    }
    if (!this._checkRateLimit(userId)) {
      this._answerCallback(cbq.id);
      return;
    }
    this._stmts.updateLastActive.run(userId);

    const ctx = this._getContext(userId);
    const opts = { editMsgId: msgId };

    try {
      // Reset task input state on any non-task navigation
      if ((ctx.state === FSM_STATES.AWAITING_TASK_TITLE ||
           ctx.state === FSM_STATES.AWAITING_TASK_DESCRIPTION) &&
          !data.startsWith('t:')) {
        ctx.state = FSM_STATES.IDLE;
        ctx.stateData = null;
      }

      // ask_user option selection
      if (data.startsWith('ask:')) return this._handleAskCallback(chatId, userId, msgId, data);

      // Forum project topic guard — prevent cross-project navigation
      if (this._currentThreadId) {
        const topicInfo = this._getTopicInfo(chatId, this._currentThreadId);
        if (topicInfo?.type === 'project') {
          // "Back to menu" goes to forum project info, not the global menu
          if (data === 'm:menu' || data === 'm:status')
            return this._forumShowInfo(chatId, userId, topicInfo.workdir);
          // Block global project navigation (p:list, p:sel:N) — no project switching from forum topics
          if (data === 'p:list' || data.startsWith('p:list:') || data.startsWith('p:sel:'))
            return;
          // Scope chats / new-chat navigation to this topic's project
          if (data.startsWith('c:') || data.startsWith('ch:'))
            ctx.projectWorkdir = topicInfo.workdir;
        }
      }

      // Route by prefix — pass opts (editMsgId) to all screen handlers
      if (data === 'm:menu')       return this._screenMainMenu(chatId, userId, opts);
      if (data === 'm:status')     return this._screenStatus(chatId, userId, opts);
      if (data === 'm:noop')       return;
      if (data === 'p:list' || data.startsWith('p:list:')) return this._screenProjects(chatId, userId, data, opts);
      if (data.startsWith('p:sel:'))  return this._screenProjectSelect(chatId, userId, data, opts);
      if (data.startsWith('pm:'))     return this._routeProjectMenu(chatId, userId, data, opts);
      if (data === 'c:new')            return this._handleNewChat(chatId, userId, opts);
      if (data.startsWith('c:list:')) return this._screenChats(chatId, userId, data, opts);
      if (data.startsWith('ch:'))     return this._screenChatSelect(chatId, userId, data, opts);
      if (data.startsWith('cm:'))     return this._routeChatMenu(chatId, userId, data, opts);
      if (data.startsWith('d:'))      return this._routeDialog(chatId, userId, data, opts);
      if (data.startsWith('fs:'))     return this._handleForumSessionCallback(chatId, userId, data);
      if (data.startsWith('fm:'))     return this._handleForumActionCallback(chatId, userId, data);
      if (data.startsWith('fa:'))     return this._handleForumActivityCallback(chatId, userId, data);
      if (data.startsWith('f:'))      return this._screenFiles(chatId, userId, data, opts);
      if (data === 't:list' || data === 't:all') return this._screenTasks(chatId, userId, data, opts);
      if (data === 't:new')         return this._handleNewTask(chatId, userId, opts);
      if (data === 't:skip')        return this._handleSkipTaskDesc(chatId, userId, opts);
      if (data === 's:menu')       return this._screenSettings(chatId, userId, opts);
      if (data.startsWith('s:'))   return this._routeSettings(chatId, userId, data, opts);
      if (data.startsWith('tn:'))  return this._routeTunnel(chatId, userId, data, opts);
    } catch (err) {
      this.log.error(`[telegram] Callback error: ${err.message}`);
      await this._editScreen(chatId, msgId, this._t('error_prefix', { msg: this._escHtml(err.message) }), [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
    } finally {
      this._answerCallback(cbq.id);
    }
  }

  // ─── Screens ─────────────────────────────────────────────────────────────

  async _screenMainMenu(chatId, userId, { editMsgId } = {}) {
    const ctx = this._getContext(userId);
    const lines = [this._buildContextHeader(ctx) + this._t('main_title') + '\n'];
    lines.push(this._t('main_choose'));

    const keyboard = [
      [{ text: this._t('btn_projects'), callback_data: 'p:list' }, { text: this._t('btn_chats'), callback_data: 'c:list:0' }],
      [{ text: this._t('btn_tasks'), callback_data: 't:list' }, { text: this._t('btn_status'), callback_data: 'm:status' }],
      [{ text: this._t('btn_remote_access'), callback_data: 'tn:menu' }, { text: this._t('btn_settings'), callback_data: 's:menu' }],
    ];

    if (ctx.sessionId) {
      const activeSess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
      if (activeSess) {
        keyboard.unshift([{ text: `✉ ${(activeSess.title || this._t('chat_untitled')).substring(0, 35)}`, callback_data: 'cm:compose' }]);
      }
    }

    if (editMsgId) {
      await this._editScreen(chatId, editMsgId, lines.join('\n'), keyboard);
    } else {
      await this._showScreen(chatId, userId, lines.join('\n'), keyboard);
    }
  }

  /**
   * Smart Write button handler (persistent keyboard).
   * Routes for 2-tap optimization:
   *   - Session active → compose mode directly (0 more taps)
   *   - Project set, 1 chat → auto-select chat, compose (0 more taps)
   *   - Project set, N chats → show chats list (1 more tap)
   *   - No project, 1 project → auto-select, then show chats (1 more tap)
   *   - No project, N projects → show projects list (2 more taps)
   */
  async _handleWriteButton(chatId, userId) {
    const ctx = this._getContext(userId);

    if (ctx.sessionId) {
      // Has active session — go directly to compose (0 more taps)
      ctx.state = FSM_STATES.COMPOSING;
      let composeText = this._t('compose_mode');
      const sess = this.db.prepare('SELECT title, workdir FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (sess) {
        const sessTitle = (sess.title || this._t('chat_untitled')).substring(0, 40);
        const projName = (sess.workdir || '').split('/').filter(Boolean).pop() || '';
        composeText += `\n\n${projName ? `📁 ${this._escHtml(projName)} → ` : ''}💬 ${this._escHtml(sessTitle)}`;
      }
      await this._showScreen(chatId, userId, composeText,
        [[{ text: this._t('btn_cancel'), callback_data: 'd:overview' }]]);
      return;
    }

    if (ctx.projectWorkdir) {
      // Has project but no session — auto-select if exactly 1 chat
      try {
        const rows = this.db.prepare(
          'SELECT id, title FROM sessions WHERE workdir = ? ORDER BY updated_at DESC LIMIT 2'
        ).all(ctx.projectWorkdir);

        if (rows.length === 1) {
          // Auto-select the single chat → compose directly
          ctx.sessionId = rows[0].id;
          ctx.state = FSM_STATES.COMPOSING;
          this._saveDeviceContext(userId);
          const title = (rows[0].title || this._t('chat_untitled')).substring(0, 40);
          const projName = ctx.projectWorkdir.split('/').filter(Boolean).pop() || '';
          const composeText = this._t('compose_mode') + `\n\n📁 ${this._escHtml(projName)} → 💬 ${this._escHtml(title)}`;
          await this._showScreen(chatId, userId, composeText,
            [[{ text: this._t('btn_cancel'), callback_data: 'd:overview' }]]);
          // Update persistent keyboard with new session info
          await this._sendReplyKeyboard(chatId, ctx, `✓ ${this._escHtml(title)}`);
          return;
        }
      } catch (_) { /* fall through to chats list */ }

      // Multiple chats or error — show chats list (1 more tap to select)
      return this._screenChats(chatId, userId, 'c:list:0');
    }

    // Nothing selected — auto-select if exactly 1 project
    try {
      const rows = this.db.prepare(
        "SELECT workdir FROM sessions WHERE workdir IS NOT NULL AND workdir != '' GROUP BY workdir ORDER BY MAX(updated_at) DESC LIMIT 2"
      ).all();

      if (rows.length === 1) {
        // Auto-select the single project, then show its chats
        ctx.projectWorkdir = rows[0].workdir;
        ctx.projectList = [rows[0].workdir];
        this._saveDeviceContext(userId);
        // Update persistent keyboard with project context
        const projName = rows[0].workdir.split('/').filter(Boolean).pop() || '';
        await this._sendReplyKeyboard(chatId, ctx, `📁 ${this._escHtml(projName)}`);
        return this._screenChats(chatId, userId, 'c:list:0');
      }
    } catch (_) { /* fall through to projects list */ }

    // Multiple projects or none — show projects list
    return this._screenProjects(chatId, userId, 'p:list:0');
  }

  async _screenProjects(chatId, userId, data, { editMsgId } = {}) {
    const page = parseInt(data.split(':')[2] || '0', 10) || 0;
    const perPage = 5;
    const ctx = this._getContext(userId);

    try {
      const rows = this.db.prepare(`
        SELECT workdir, COUNT(*) as chat_count, MAX(updated_at) as last_active
        FROM sessions WHERE workdir IS NOT NULL AND workdir != ''
        GROUP BY workdir ORDER BY last_active DESC LIMIT 30
      `).all();

      ctx.projectList = rows.map(r => r.workdir);

      const backRow = this._buildBackButton('PROJECTS', ctx);

      if (rows.length === 0) {
        const emptyKb = [];
        if (backRow) emptyKb.push(backRow);
        const emptyText = this._buildContextHeader(ctx) + this._t('projects_empty');
        if (editMsgId) {
          return this._editScreen(chatId, editMsgId, emptyText, emptyKb);
        }
        return this._showScreen(chatId, userId, emptyText, emptyKb);
      }

      const totalPages = Math.ceil(rows.length / perPage);
      const pageRows = rows.slice(page * perPage, (page + 1) * perPage);

      const keyboard = pageRows.map((r, i) => {
        const idx = page * perPage + i;
        const name = r.workdir.split('/').filter(Boolean).pop() || '...';
        const label = `📁 ${name}  ·  ${this._t('project_chats_label', { count: r.chat_count })}  ·  ${this._timeAgo(r.last_active)}`;
        return [{ text: label.substring(0, 60), callback_data: `p:sel:${idx}` }];
      });

      // Pagination row
      if (totalPages > 1) {
        const navRow = [];
        if (page > 0) navRow.push({ text: this._t('btn_back'), callback_data: `p:list:${page-1}` });
        navRow.push({ text: `${page+1}/${totalPages}`, callback_data: 'm:noop' });
        if (page < totalPages - 1) navRow.push({ text: this._t('btn_next'), callback_data: `p:list:${page+1}` });
        keyboard.push(navRow);
      }

      if (backRow) keyboard.push(backRow);

      const text = this._buildContextHeader(ctx) + this._t('projects_title', { count: rows.length });
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, text, keyboard);
      } else {
        await this._showScreen(chatId, userId, text, keyboard);
      }
    } catch (err) {
      const errBackRow = this._buildBackButton('PROJECTS', ctx) || [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }];
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, `❌ ${this._escHtml(err.message)}`,
          [errBackRow]);
      } else {
        await this._showScreen(chatId, userId, `❌ ${this._escHtml(err.message)}`,
          [errBackRow]);
      }
    }
  }

  async _screenProjectSelect(chatId, userId, data, { editMsgId } = {}) {
    const idx = parseInt(data.split(':')[2], 10);
    const ctx = this._getContext(userId);

    if (!ctx.projectList || idx < 0 || idx >= ctx.projectList.length) {
      const backRow = this._buildBackButton('PROJECT', ctx) || [{ text: this._t('btn_back_projects'), callback_data: 'p:list' }];
      if (editMsgId) {
        return this._editScreen(chatId, editMsgId, this._t('project_not_found'),
          [backRow]);
      }
      return this._showScreen(chatId, userId, this._t('project_not_found'),
        [backRow]);
    }

    ctx.projectWorkdir = ctx.projectList[idx];
    ctx.sessionId = null;
    ctx.chatPage = 0;
    const name = ctx.projectWorkdir.split('/').filter(Boolean).pop();

    const keyboard = [
      [{ text: this._t('btn_chats'), callback_data: 'c:list:0' }, { text: this._t('btn_files'), callback_data: 'f:.' }],
      [{ text: this._t('btn_git_log'), callback_data: 'pm:git' }, { text: this._t('btn_diff'), callback_data: 'pm:diff' }],
      [{ text: this._t('btn_tasks'), callback_data: 't:list' }],
      [{ text: this._t('btn_new_chat'), callback_data: 'c:new' }, { text: this._t('btn_new_task'), callback_data: 't:new' }],
    ];
    const backRow = this._buildBackButton('PROJECT', ctx);
    if (backRow) keyboard.push(backRow);

    const text = this._buildContextHeader(ctx) + `📁 <b>${this._escHtml(name)}</b>${this._t('project_choose')}`;
    if (editMsgId) {
      await this._editScreen(chatId, editMsgId, text, keyboard);
    } else {
      await this._showScreen(chatId, userId, text, keyboard);
    }

    // Update persistent keyboard to reflect new project context
    await this._sendReplyKeyboard(chatId, ctx, `✓ ${this._escHtml(name)}`);
  }

  async _routeProjectMenu(chatId, userId, data, opts = {}) {
    const action = data.split(':')[1];
    const ctx = this._getContext(userId);

    if (action === 'git') {
      // Send git log as NEW message, keep screen
      await this._cmdLog(chatId, userId, ['5']);
    } else if (action === 'diff') {
      await this._cmdDiff(chatId, userId);
    } else if (action === 'back') {
      return this._screenProjects(chatId, userId, 'p:list:0', opts);
    }
  }

  async _screenChats(chatId, userId, data, { editMsgId } = {}) {
    const page = parseInt(data.split(':')[2] || '0', 10) || 0;
    const perPage = 5;
    const ctx = this._getContext(userId);
    const workdir = ctx.projectWorkdir;

    try {
      let rows;
      if (workdir) {
        rows = this.db.prepare(`
          SELECT s.id, s.title, s.updated_at, COUNT(m.id) as msg_count
          FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
          WHERE s.workdir = ? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 50
        `).all(workdir);
      } else {
        rows = this.db.prepare(`
          SELECT s.id, s.title, s.updated_at, COUNT(m.id) as msg_count
          FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
          GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 50
        `).all();
      }

      ctx.chatList = rows.map(r => r.id);
      const backRow = this._buildBackButton('CHATS', ctx);

      if (rows.length === 0) {
        const emptyKb = [
          [{ text: this._t('btn_new_chat'), callback_data: 'c:new' }],
        ];
        if (backRow) emptyKb.push(backRow);
        const emptyText = this._buildContextHeader(ctx) + this._t('chats_empty');
        if (editMsgId) {
          return this._editScreen(chatId, editMsgId, emptyText, emptyKb);
        }
        return this._showScreen(chatId, userId, emptyText, emptyKb);
      }

      const totalPages = Math.ceil(rows.length / perPage);
      const pageRows = rows.slice(page * perPage, (page + 1) * perPage);

      const header = workdir
        ? this._t('chats_title_project', { project: this._escHtml(workdir.split('/').filter(Boolean).pop()) })
        : this._t('chats_title_all');

      const keyboard = pageRows.map((r, i) => {
        const globalIdx = page * perPage + i;
        const title = (r.title || this._t('chat_untitled')).substring(0, 35);
        const ago = this._timeAgo(r.updated_at);
        return [{ text: `💬 ${title}  ·  ${r.msg_count}  ·  ${ago}`, callback_data: `ch:${globalIdx}` }];
      });

      if (totalPages > 1) {
        const navRow = [];
        if (page > 0) navRow.push({ text: this._t('btn_back'), callback_data: `c:list:${page-1}` });
        navRow.push({ text: `${page+1}/${totalPages}`, callback_data: 'm:noop' });
        if (page < totalPages - 1) navRow.push({ text: this._t('btn_next'), callback_data: `c:list:${page+1}` });
        keyboard.push(navRow);
      }

      keyboard.push([{ text: this._t('btn_new_chat'), callback_data: 'c:new' }]);
      if (backRow) keyboard.push(backRow);

      const text = this._buildContextHeader(ctx) + `${header} (${rows.length})`;
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, text, keyboard);
      } else {
        await this._showScreen(chatId, userId, text, keyboard);
      }
    } catch (err) {
      const errBackRow = this._buildBackButton('CHATS', ctx) || [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }];
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, `❌ ${this._escHtml(err.message)}`,
          [errBackRow]);
      } else {
        await this._showScreen(chatId, userId, `❌ ${this._escHtml(err.message)}`,
          [errBackRow]);
      }
    }
  }

  async _screenChatSelect(chatId, userId, data, { editMsgId } = {}) {
    const idx = parseInt(data.split(':')[1], 10);
    const ctx = this._getContext(userId);

    if (!ctx.chatList || idx < 0 || idx >= ctx.chatList.length) {
      if (editMsgId) {
        return this._editScreen(chatId, editMsgId, this._t('chat_not_found'),
          [[{ text: this._t('btn_back_chats'), callback_data: 'c:list:0' }]]);
      }
      return this._showScreen(chatId, userId, this._t('chat_not_found'),
        [[{ text: this._t('btn_back_chats'), callback_data: 'c:list:0' }]]);
    }

    ctx.sessionId = ctx.chatList[idx];
    ctx.dialogPage = 0;
    this._saveDeviceContext(userId);
    await this._screenDialog(chatId, userId, { editMsgId });

    // Update persistent keyboard to reflect new active chat
    const title = (() => {
      try {
        const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
        return (sess?.title || this._t('chat_untitled')).substring(0, 25);
      } catch { return this._t('chat_untitled'); }
    })();
    await this._sendReplyKeyboard(chatId, ctx, `✓ ${this._escHtml(title)}`);
  }

  async _screenDialog(chatId, userId, { mode = 'overview', editMsgId } = {}) {
    const ctx = this._getContext(userId);
    const sid = ctx.sessionId;
    if (!sid) return this._screenChats(chatId, userId, 'c:list:0', { editMsgId });

    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!session) {
      const backRow = this._buildBackButton('DIALOG', ctx) || [{ text: this._t('btn_back_chats'), callback_data: 'c:list:0' }];
      if (editMsgId) {
        return this._editScreen(chatId, editMsgId, this._t('session_not_found'),
          [backRow]);
      }
      return this._showScreen(chatId, userId, this._t('session_not_found'),
        [backRow]);
    }

    // Get all non-tool messages
    const allMsgs = this.db.prepare(
      "SELECT * FROM messages WHERE session_id = ? AND type != 'tool' ORDER BY created_at ASC"
    ).all(sid);

    // Build context info
    const title = session.title || this._t('chat_untitled');
    const projectName = (session.workdir || ctx.projectWorkdir || '').split('/').filter(Boolean).pop() || '';
    const projectLine = projectName ? `📁 ${this._escHtml(projectName)} → ` : '';

    if (mode === 'all') {
      return this._screenDialogFull(chatId, userId, allMsgs, { title, projectLine, editMsgId });
    }

    // ── Overview mode: single-message digest ──
    // Everything fits in one editMessageText — no message spam!

    const parts = [];
    // Context header
    parts.push(this._buildContextHeader(ctx).trimEnd());
    // Header
    parts.push(`${projectLine}💬 <b>${this._escHtml(title)}</b>`);
    parts.push('─'.repeat(25));
    parts.push(this._t('dialog_messages', { count: allMsgs.length }));

    if (allMsgs.length === 0) {
      parts.push('');
      parts.push(this._t('chat_no_messages'));
    } else {
      // Build inline digest: first msg + separator + last user + last assistant
      const showMsgs = [];
      if (allMsgs.length <= 4) {
        showMsgs.push(...allMsgs);
      } else {
        showMsgs.push(allMsgs[0]);
        showMsgs.push(null); // separator placeholder
        let lastUser = null, lastAssistant = null;
        for (let i = allMsgs.length - 1; i >= 1; i--) {
          if (!lastAssistant && allMsgs[i].role === 'assistant') lastAssistant = allMsgs[i];
          if (!lastUser && allMsgs[i].role === 'user') lastUser = allMsgs[i];
          if (lastUser && lastAssistant) break;
        }
        if (lastUser) showMsgs.push(lastUser);
        if (lastAssistant) showMsgs.push(lastAssistant);
      }

      for (const msg of showMsgs) {
        if (msg === null) {
          // Separator
          const skipped = allMsgs.length - 3;
          parts.push('');
          parts.push(this._t('dialog_separator', { count: skipped }));
          parts.push('');
          continue;
        }

        const icon = msg.role === 'user' ? '👤' : '🤖';
        const time = new Date(msg.created_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
        const source = msg.source === 'telegram' ? ' 📱' : '';
        let content = this._sanitize(msg.content || '');
        content = this._mdToHtml(content);
        // Truncate each message to keep total under 4096
        const maxLen = allMsgs.length <= 4 ? 600 : 350;
        if (content.length > maxLen) {
          content = content.slice(0, maxLen) + '\n<i>' + this._t('dialog_truncated') + '</i>';
        }
        parts.push('─'.repeat(25));
        parts.push(`${icon} <b>${this._escHtml(msg.role)}</b>${source} · ${time}`);
        parts.push(content);
      }
    }

    const text = parts.join('\n');

    const keyboard = [
      [{ text: this._t('btn_write'), callback_data: 'cm:compose' }, { text: this._t('btn_all_messages'), callback_data: 'd:all:0' }],
      [{ text: this._t('btn_files'), callback_data: 'f:.' }, { text: this._t('btn_diff'), callback_data: 'pm:diff' }, { text: this._t('btn_git_log'), callback_data: 'pm:git' }],
      [{ text: '🔄', callback_data: 'd:overview' }],
    ];
    const backRow = this._buildBackButton('DIALOG', ctx);
    if (backRow) keyboard.push(backRow);

    if (editMsgId) {
      await this._editScreen(chatId, editMsgId, text, keyboard);
    } else {
      await this._showScreen(chatId, userId, text, keyboard);
    }
  }

  async _screenDialogFull(chatId, userId, allMsgs, { title, projectLine, editMsgId } = {}) {
    const ctx = this._getContext(userId);

    const PAGE_SIZE = 5;
    const totalPages = Math.max(1, Math.ceil(allMsgs.length / PAGE_SIZE));
    const page = Math.min(ctx.dialogPage || 0, totalPages - 1);
    const offset = page * PAGE_SIZE;
    const msgs = allMsgs.slice(offset, offset + PAGE_SIZE);

    // Build single message with all content inline
    const parts = [];
    // Context header
    parts.push(this._buildContextHeader(ctx).trimEnd());
    parts.push(`${projectLine}💬 <b>${this._escHtml(title)}</b>`);
    parts.push('─'.repeat(25));
    parts.push(this._t('dialog_page', { count: allMsgs.length, page: page + 1, total: totalPages }));

    for (const msg of msgs) {
      const icon = msg.role === 'user' ? '👤' : '🤖';
      const time = new Date(msg.created_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
      const source = msg.source === 'telegram' ? ' 📱' : '';
      let content = this._sanitize(msg.content || '');
      content = this._mdToHtml(content);
      if (content.length > 500) {
        content = content.slice(0, 500) + '\n<i>' + this._t('dialog_truncated') + '</i>';
      }
      parts.push('─'.repeat(25));
      parts.push(`${icon} <b>${this._escHtml(msg.role)}</b>${source} · ${time}`);
      parts.push(content);
    }

    const text = parts.join('\n');

    const navRow = [];
    if (page > 0) navRow.push({ text: '⬅️', callback_data: `d:all:${page - 1}` });
    navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'm:noop' });
    if (page < totalPages - 1) navRow.push({ text: '➡️', callback_data: `d:all:${page + 1}` });

    const keyboard = [
      navRow,
      [{ text: this._t('btn_write'), callback_data: 'cm:compose' }, { text: '🔄', callback_data: `d:all:${page}` }],
    ];
    const backRow = this._buildBackButton('DIALOG_FULL', ctx);
    if (backRow) keyboard.push(backRow);

    if (editMsgId) {
      await this._editScreen(chatId, editMsgId, text, keyboard);
    } else {
      await this._showScreen(chatId, userId, text, keyboard);
    }
  }

  async _sendBubble(chatId, msg) {
    const icon = msg.role === 'user' ? '👤' : '🤖';
    const time = new Date(msg.created_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    const source = msg.source === 'telegram' ? ' 📱' : '';

    let content = msg.content || '';
    content = this._sanitize(content);
    content = this._mdToHtml(content);

    let truncated = false;
    if (content.length > 3500) {
      content = content.slice(0, 3500) + '\n\n<i>' + this._t('dialog_truncated') + '</i>';
      truncated = true;
    }

    const formatted = `${icon} <b>${this._escHtml(msg.role)}</b>${source} | ${time}\n\n${content}`;

    const msgKeyboard = truncated ? {
      inline_keyboard: [[{ text: this._t('btn_full_msg'), callback_data: `d:full:${msg.id}` }]]
    } : undefined;

    await this._sendMessage(chatId, formatted.slice(0, 4096), {
      parse_mode: 'HTML',
      reply_markup: msgKeyboard ? JSON.stringify(msgKeyboard) : undefined,
    }).catch(() => {
      return this._sendMessage(chatId, formatted.replace(/<[^>]+>/g, '').slice(0, 4096), {
        reply_markup: msgKeyboard ? JSON.stringify(msgKeyboard) : undefined,
      });
    });
  }

  async _showFullMessage(chatId, msgId) {
    const msg = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!msg) return this._sendMessage(chatId, this._t('chat_not_found'));

    const icon = msg.role === 'user' ? '👤' : '🤖';
    let content = this._sanitize(msg.content || '');
    content = this._mdToHtml(content);

    const chunks = this._chunkForTelegram(`${icon} <b>${this._escHtml(msg.role)}</b>\n\n${content}`, MAX_MESSAGE_LENGTH - 100);
    const isForumTopic = !!this._currentThreadId;

    for (let i = 0; i < chunks.length; i++) {
      const opts = { parse_mode: 'HTML' };
      const isLast = i === chunks.length - 1;

      // Add action buttons to every chunk so user always has controls at the bottom
      const buttons = [];

      if (isLast) {
        // Last chunk: full action set
        if (isForumTopic) {
          buttons.push([
            { text: this._t('fm_btn_continue'), callback_data: 'fm:compose' },
            { text: this._t('fm_btn_diff'), callback_data: 'fm:diff' },
            { text: this._t('fm_btn_files'), callback_data: 'fm:files' },
          ]);
          buttons.push([
            { text: this._t('fm_btn_history'), callback_data: 'fm:history' },
            { text: this._t('fm_btn_new'), callback_data: 'fm:new' },
          ]);
        } else {
          buttons.push([
            { text: this._t('btn_write'), callback_data: 'cm:compose' },
            { text: this._t('btn_back_overview'), callback_data: 'd:overview' },
            { text: this._t('btn_back_menu'), callback_data: 'm:menu' },
          ]);
        }
      } else {
        // Intermediate chunks: compact action button so user is never stranded
        if (isForumTopic) {
          buttons.push([{ text: this._t('fm_btn_continue'), callback_data: 'fm:compose' }]);
        } else {
          buttons.push([{ text: this._t('btn_back_overview'), callback_data: 'd:overview' }]);
        }
      }

      if (buttons.length) {
        opts.reply_markup = JSON.stringify({ inline_keyboard: buttons });
      }

      await this._sendMessage(chatId, chunks[i], opts).catch(() => {
        return this._sendMessage(chatId, chunks[i].replace(/<[^>]+>/g, ''), { reply_markup: opts.reply_markup });
      });
    }
  }

  async _routeDialog(chatId, userId, data, opts = {}) {
    const ctx = this._getContext(userId);
    const { editMsgId } = opts;

    // Overview mode (default entry / back from full view)
    if (data === 'd:overview') {
      ctx.dialogPage = 0;
      return this._screenDialog(chatId, userId, { mode: 'overview', editMsgId });
    }

    // Full paginated view
    if (data.startsWith('d:all:')) {
      const page = parseInt(data.split(':')[2]) || 0;
      ctx.dialogPage = page;
      return this._screenDialog(chatId, userId, { mode: 'all', editMsgId });
    }

    // Legacy pagination (kept for compatibility)
    if (data.startsWith('d:page:')) {
      const page = parseInt(data.split(':')[2]) || 0;
      ctx.dialogPage = page;
      return this._screenDialog(chatId, userId, { mode: 'all', editMsgId });
    }

    // Show full message
    if (data.startsWith('d:full:')) {
      const fullMsgId = parseInt(data.split(':')[2]);
      return this._showFullMessage(chatId, fullMsgId);
    }

    // Clear pending attachments
    if (data === 'd:clear_attach') {
      ctx.pendingAttachments = [];
      return this._sendMessage(chatId, this._t('attach_cleared'));
    }

    // View session dialog (from notifications)
    if (data.startsWith('d:view:')) {
      const sid = data.split(':')[2];
      ctx.sessionId = sid;
      ctx.dialogPage = 0;
      this._saveDeviceContext(userId);
      return this._screenDialog(chatId, userId, { mode: 'overview', editMsgId });
    }

    // Compose in session
    if (data.startsWith('d:compose:')) {
      const composeSid = data.split(':')[2];
      ctx.sessionId = composeSid;
      const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(composeSid);
      const title = sess?.title || this._t('chat_untitled');
      ctx.state = FSM_STATES.COMPOSING;
      this._saveDeviceContext(userId);
      if (editMsgId) {
        return this._editScreen(chatId, editMsgId,
          `✉ ${this._t('compose_prompt')}\n\n💬 ${this._escHtml(title)}`,
          [[{ text: this._t('btn_cancel'), callback_data: 'd:overview' }]]);
      }
      return this._showScreen(chatId, userId,
        `✉ ${this._t('compose_prompt')}\n\n💬 ${this._escHtml(title)}`,
        [[{ text: this._t('btn_cancel'), callback_data: 'd:overview' }]]);
    }
  }

  async _routeChatMenu(chatId, userId, data, opts = {}) {
    const action = data.split(':')[1];
    const ctx = this._getContext(userId);
    const { editMsgId } = opts;

    if (action === 'more') {
      if (!ctx.sessionId) return;
      const offset = (ctx.chatOffset || 3) + 3;
      ctx.chatOffset = offset;

      const msgs = this.db.prepare(`
        SELECT role, content FROM messages
        WHERE session_id = ? AND (type IS NULL OR type != 'tool')
        ORDER BY id DESC LIMIT ?
      `).all(ctx.sessionId, offset).reverse();

      const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
      const title = sess?.title || this._t('chat_untitled');

      let text = `💬 <b>${this._escHtml(title)}</b> (${this._t('chat_messages', { count: msgs.length })})\n${'─'.repeat(20)}\n\n`;
      text += msgs.map(r => {
        const icon = r.role === 'user' ? '👤' : '🤖';
        const content = this._escHtml(this._sanitize(r.content || '').substring(0, 200));
        const trunc = (r.content?.length || 0) > 200 ? '...' : '';
        return `${icon} ${content}${trunc}`;
      }).join('\n\n');

      const keyboard = [
        [{ text: this._t('btn_more'), callback_data: 'cm:more' }, { text: this._t('btn_full_response'), callback_data: 'cm:full' }],
        [{ text: this._t('btn_write_chat'), callback_data: 'cm:compose' }],
        [{ text: this._t('btn_back_chats'), callback_data: 'c:list:0' }],
      ];

      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, text, keyboard);
      } else {
        await this._showScreen(chatId, userId, text, keyboard);
      }

    } else if (action === 'full') {
      // Send as new message, keep screen
      await this._cmdFull(chatId, userId);

    } else if (action === 'compose') {
      ctx.state = FSM_STATES.COMPOSING;
      // Show session context in compose mode
      let composeText = this._t('compose_mode');
      if (ctx.sessionId) {
        const sess = this.db.prepare('SELECT title, workdir FROM sessions WHERE id = ?').get(ctx.sessionId);
        if (sess) {
          const sessTitle = (sess.title || this._t('chat_untitled')).substring(0, 40);
          const projName = (sess.workdir || '').split('/').filter(Boolean).pop() || '';
          composeText += `\n\n${projName ? `📁 ${this._escHtml(projName)} → ` : ''}💬 ${this._escHtml(sessTitle)}`;
        }
      }
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId,
          composeText,
          [[{ text: this._t('btn_cancel'), callback_data: 'cm:cancel' }]]
        );
      } else {
        await this._showScreen(chatId, userId,
          composeText,
          [[{ text: this._t('btn_cancel'), callback_data: 'cm:cancel' }]]
        );
      }

    } else if (action === 'cancel') {
      ctx.state = FSM_STATES.IDLE;
      ctx.stateData = null;
      ctx.pendingAttachments = [];
      // Re-show dialog overview
      if (ctx.sessionId) {
        return this._screenDialog(chatId, userId, { mode: 'overview', editMsgId });
      }
      return this._screenMainMenu(chatId, userId, { editMsgId });

    } else if (action === 'stop') {
      return this._cmdStop(chatId, userId);

    } else if (action === 'back') {
      return this._screenChats(chatId, userId, 'c:list:0', opts);
    }
  }

  async _screenFiles(chatId, userId, data, { editMsgId } = {}) {
    const ctx = this._getContext(userId);
    const fs = require('fs');
    const pathMod = require('path');

    const baseDir = ctx.projectWorkdir || process.env.WORKDIR || pathMod.join(process.cwd(), 'workspace');

    let subPath;
    if (data.startsWith('f:c:')) {
      // Cached path lookup for long paths
      const key = parseInt(data.split(':')[2], 10);
      subPath = ctx.filePathCache?.get(key) || '.';
    } else {
      subPath = data.substring(2) || '.'; // strip "f:" prefix
    }

    const targetDir = pathMod.resolve(baseDir, subPath);
    if (!targetDir.startsWith(baseDir)) {
      const deniedBack = this._buildBackButton('FILES', ctx) || [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }];
      if (editMsgId) {
        return this._editScreen(chatId, editMsgId, this._t('files_denied'),
          [deniedBack]);
      }
      return this._showScreen(chatId, userId, this._t('files_denied'),
        [deniedBack]);
    }

    try {
      const stat = fs.statSync(targetDir);

      // If it's a file, show content as new message
      if (stat.isFile()) {
        if (this._isSensitiveFile(targetDir)) {
          return this._sendMessage(chatId, this._t('files_sensitive_short'));
        }
        const content = fs.readFileSync(targetDir, 'utf-8');
        const sanitized = this._sanitize(content);
        const ext = pathMod.extname(targetDir).slice(1) || 'txt';
        const name = pathMod.basename(targetDir);
        const display = sanitized.length > MAX_MESSAGE_LENGTH - 200
          ? sanitized.substring(0, MAX_MESSAGE_LENGTH - 200) + '\n\n' + this._t('files_truncated_short')
          : sanitized;
        await this._sendMessage(chatId, `📄 <b>${this._escHtml(name)}</b>\n\n<pre><code class="language-${ext}">${this._escHtml(display)}</code></pre>`);
        return; // Keep the file browser screen as is
      }

      // Directory listing
      const items = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(d => !d.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 20);

      ctx.filePath = subPath;
      if (!ctx.filePathCache) ctx.filePathCache = new Map();
      let cacheCounter = ctx.filePathCache.size;

      const keyboard = items.map(d => {
        const icon = d.isDirectory() ? '📁' : '📄';
        const rel = pathMod.join(subPath, d.name);
        let cbData;
        if (rel.length <= 61) { // 64 - "f:" prefix - margin
          cbData = `f:${rel}`;
        } else {
          cacheCounter++;
          ctx.filePathCache.set(cacheCounter, rel);
          cbData = `f:c:${cacheCounter}`;
        }
        return [{ text: `${icon} ${d.name}`, callback_data: cbData }];
      });

      // Parent directory button (if not at root)
      if (subPath !== '.' && subPath !== '') {
        const parent = pathMod.dirname(subPath);
        const parentCb = parent.length <= 61 ? `f:${parent || '.'}` : (() => {
          cacheCounter++;
          ctx.filePathCache.set(cacheCounter, parent);
          return `f:c:${cacheCounter}`;
        })();
        keyboard.push([{ text: this._t('btn_parent_dir'), callback_data: parentCb }]);
      }

      const backRow = this._buildBackButton('FILES', ctx);
      if (backRow) keyboard.push(backRow);

      const relDisplay = subPath === '.' ? '/' : subPath;
      const dirHeader = this._buildContextHeader(ctx);
      const text = items.length > 0
        ? `${dirHeader}📂 <b>${this._escHtml(relDisplay)}</b>`
        : `${dirHeader}📂 <b>${this._escHtml(relDisplay)}</b>\n\n${this._t('files_empty_label')}`;

      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, text, keyboard);
      } else {
        await this._showScreen(chatId, userId, text, keyboard);
      }
    } catch (err) {
      const errBackRow = this._buildBackButton('FILES', ctx) || [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }];
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, `❌ ${this._escHtml(err.message)}`, [errBackRow]);
      } else {
        await this._showScreen(chatId, userId, `❌ ${this._escHtml(err.message)}`, [errBackRow]);
      }
    }
  }

  async _screenTasks(chatId, userId, data, { editMsgId } = {}) {
    const ctx = this._getContext(userId);
    const showAll = data === 't:all';
    const workdir = showAll ? null : ctx.projectWorkdir;

    try {
      let rows;
      if (workdir) {
        rows = this.db.prepare(`
          SELECT title, status FROM tasks WHERE workdir = ?
          ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 WHEN 'blocked' THEN 3 WHEN 'done' THEN 4 END, sort_order ASC LIMIT 25
        `).all(workdir);
      } else {
        rows = this.db.prepare(`
          SELECT title, status FROM tasks
          ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 WHEN 'blocked' THEN 3 WHEN 'done' THEN 4 END, sort_order ASC LIMIT 25
        `).all();
      }

      const backRow = this._buildBackButton('TASKS', ctx);

      if (rows.length === 0) {
        const emptyKb = [
          [{ text: this._t('btn_new_task'), callback_data: 't:new' }],
        ];
        if (backRow) emptyKb.push(backRow);
        const emptyText = this._buildContextHeader(ctx) + this._t('tasks_empty');
        if (editMsgId) {
          return this._editScreen(chatId, editMsgId, emptyText, emptyKb);
        }
        return this._showScreen(chatId, userId, emptyText, emptyKb);
      }

      const icons = { backlog: '📋', todo: '📝', in_progress: '🔄', done: '✅', blocked: '🚫' };
      const grouped = {};
      for (const r of rows) {
        if (!grouped[r.status]) grouped[r.status] = [];
        grouped[r.status].push(r);
      }

      let text = this._buildContextHeader(ctx) + `${this._t('tasks_title', { count: rows.length })}\n\n`;
      for (const [status, items] of Object.entries(grouped)) {
        text += `${icons[status] || '•'} <b>${this._escHtml(status)}</b> (${items.length})\n`;
        text += items.map(t => `  · ${this._escHtml((t.title||'').substring(0, 45))}`).join('\n') + '\n\n';
      }

      const keyboard = [];
      keyboard.push([{ text: this._t('btn_new_task'), callback_data: 't:new' }]);
      if (ctx.projectWorkdir && !showAll) {
        keyboard.push([{ text: this._t('btn_all_tasks'), callback_data: 't:all' }]);
      }
      if (backRow) keyboard.push(backRow);

      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, text, keyboard);
      } else {
        await this._showScreen(chatId, userId, text, keyboard);
      }
    } catch (err) {
      const errBackRow = this._buildBackButton('TASKS', ctx) || [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }];
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, `❌ ${this._escHtml(err.message)}`, [errBackRow]);
      } else {
        await this._showScreen(chatId, userId, `❌ ${this._escHtml(err.message)}`, [errBackRow]);
      }
    }
  }

  async _screenStatus(chatId, userId, { editMsgId } = {}) {
    const ctx = this._getContext(userId);

    try {
      const sessionCount = this.db.prepare('SELECT COUNT(*) as n FROM sessions').get().n;
      const messageCount = this.db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
      const tasksByStatus = this.db.prepare('SELECT status, COUNT(*) as n FROM tasks GROUP BY status').all();
      const devices = this._stmts.getAllDevices.all();
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);

      let text = this._buildContextHeader(ctx) + this._t('status_title') + '\n──────────────────\n' +
        this._t('status_uptime', { hours, mins }) + '\n' +
        this._t('status_sessions', { count: sessionCount }) + '\n' +
        this._t('status_messages', { count: messageCount }) + '\n';

      if (tasksByStatus.length > 0) {
        const icons = { backlog: '📋', todo: '📝', in_progress: '🔄', done: '✅', blocked: '🚫' };
        text += '\n' + this._t('status_tasks_label') + '\n' + tasksByStatus.map(t => `  ${icons[t.status]||'•'} ${t.status}: ${t.n}`).join('\n') + '\n';
      }

      // Active chats (running right now) — with timeout fallback if listener not attached
      const activeChats = await Promise.race([
        new Promise(resolve => this.emit('get_active_chats', resolve)),
        new Promise(resolve => setTimeout(() => resolve([]), 500)),
      ]);
      if (activeChats && activeChats.length > 0) {
        text += '\n' + this._t('status_active_chats', { count: activeChats.length }) + '\n';
        for (const ac of activeChats) {
          const dur = Math.floor((Date.now() - ac.startedAt) / 1000);
          const durMin = Math.floor(dur / 60);
          const durSec = dur % 60;
          const srcLabel = ac.source === 'telegram' ? this._t('status_active_source_tg') : this._t('status_active_source_web');
          text += `  ⚡ ${this._escHtml(ac.title)} <i>(${durMin}:${String(durSec).padStart(2, '0')}, ${srcLabel})</i>\n`;
        }
      } else {
        text += '\n' + this._t('status_active_none') + '\n';
      }

      text += '\n' + this._t('status_devices_short', { count: devices.length });
      text += '\n' + this._t('status_new_conn', { status: this._acceptNewConnections ? this._t('status_conn_on') : this._t('status_conn_off') });
      text += '\n' + this._t('status_updated', { time: new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) });

      const keyboard = [
        [{ text: this._t('btn_refresh'), callback_data: 'm:status' }],
      ];
      const backRow = this._buildBackButton('STATUS', ctx);
      if (backRow) keyboard.push(backRow);

      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, text, keyboard);
      } else {
        await this._showScreen(chatId, userId, text, keyboard);
      }
    } catch (err) {
      const errBackRow = this._buildBackButton('STATUS', ctx) || [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }];
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId, `❌ ${this._escHtml(err.message)}`, [errBackRow]);
      } else {
        await this._showScreen(chatId, userId, `❌ ${this._escHtml(err.message)}`, [errBackRow]);
      }
    }
  }

  async _screenSettings(chatId, userId, { editMsgId } = {}) {
    const ctx = this._getContext(userId);
    const device = this._stmts.getDevice.get(userId);
    if (!device) return;

    const notif = device.notifications_enabled;
    const pairedDate = device.paired_at ? new Date(device.paired_at + 'Z').toLocaleDateString() : '—';

    let text = this._buildContextHeader(ctx) + this._t('settings_title') + '\n\n' +
      `📱 ${this._escHtml(device.display_name)}` + (device.username ? ` · @${this._escHtml(device.username)}` : '') + '\n' +
      this._t('settings_paired', { date: pairedDate }) + '\n' +
      this._t('settings_notif', { status: notif ? this._t('status_conn_on') : this._t('status_conn_off') });

    // Forum mode status
    if (device.forum_chat_id) {
      text += '\n' + '🏗 Forum: ' + this._t('status_conn_on');
    }

    const keyboard = [
      [{ text: notif ? this._t('btn_disable_notif') : this._t('btn_enable_notif'), callback_data: notif ? 's:notify:off' : 's:notify:on' }],
      [{ text: device.forum_chat_id ? this._t('btn_forum_disconnect') : this._t('btn_forum_setup'), callback_data: device.forum_chat_id ? 's:forum:off' : 's:forum' }],
      [{ text: this._t('btn_unlink_device'), callback_data: 's:unlink' }],
    ];
    const backRow = this._buildBackButton('SETTINGS', ctx);
    if (backRow) keyboard.push(backRow);

    if (editMsgId) {
      await this._editScreen(chatId, editMsgId, text, keyboard);
    } else {
      await this._showScreen(chatId, userId, text, keyboard);
    }
  }

  async _routeSettings(chatId, userId, data, opts = {}) {
    const ctx = this._getContext(userId);
    const { editMsgId } = opts;

    if (data === 's:notify:on' || data === 's:notify:off') {
      const val = data === 's:notify:on' ? 1 : 0;
      this._stmts.updateNotifications.run(val, userId);
      return this._screenSettings(chatId, userId, opts); // Re-render settings

    } else if (data === 's:unlink') {
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId,
          this._t('settings_unlink_confirm'),
          [
            [{ text: this._t('btn_confirm_unlink'), callback_data: 's:unlink:yes' }],
            [{ text: this._t('btn_cancel'), callback_data: 's:menu' }],
          ]
        );
      } else {
        await this._showScreen(chatId, userId,
          this._t('settings_unlink_confirm'),
          [
            [{ text: this._t('btn_confirm_unlink'), callback_data: 's:unlink:yes' }],
            [{ text: this._t('btn_cancel'), callback_data: 's:menu' }],
          ]
        );
      }

    } else if (data === 's:forum') {
      // Show forum setup instructions
      if (editMsgId) {
        await this._editScreen(chatId, editMsgId,
          this._t('forum_instructions'),
          [[{ text: this._t('btn_back'), callback_data: 's:menu' }]]
        );
      } else {
        await this._showScreen(chatId, userId,
          this._t('forum_instructions'),
          [[{ text: this._t('btn_back'), callback_data: 's:menu' }]]
        );
      }

    } else if (data === 's:forum:off') {
      await this._cmdForumDisconnect(chatId, userId);
      return this._screenSettings(chatId, userId, opts);

    } else if (data === 's:unlink:yes') {
      this._stmts.removeByUserId.run(userId);
      this._userContext.delete(userId);
      this.emit('device_removed', { telegram_user_id: userId });

      // Can't edit the screen anymore (no longer authorized), send final message
      await this._sendMessage(chatId, this._t('settings_unlinked'), {
        reply_markup: JSON.stringify({ remove_keyboard: true }),
      });
    }
  }

  async _routeTunnel(chatId, userId, data, opts = {}) {
    if (data === 'tn:menu') {
      return this._cmdTunnel(chatId, userId, opts);
    } else if (data === 'tn:start') {
      this.emit('tunnel_start', { chatId });
    } else if (data === 'tn:stop') {
      this.emit('tunnel_stop', { chatId });
    } else if (data === 'tn:status') {
      this.emit('tunnel_status', { chatId });
    }
  }

  // ─── Media Handling ────────────────────────────────────────────────────────

  async _handleMediaMessage(msg) {
    const userId = msg.from?.id;
    const chatId = msg.chat?.id;
    if (!userId || !chatId) return;

    const ctx = this._getContext(userId);

    try {
      let fileId, fileName, mimeType;

      if (msg.photo) {
        // Get largest photo
        const photo = msg.photo[msg.photo.length - 1];
        fileId = photo.file_id;
        fileName = `photo_${Date.now()}.jpg`;
        mimeType = 'image/jpeg';
      } else if (msg.document) {
        fileId = msg.document.file_id;
        fileName = msg.document.file_name || `file_${Date.now()}`;
        mimeType = msg.document.mime_type || 'application/octet-stream';

        // Size check (10MB limit)
        if (msg.document.file_size && msg.document.file_size > 10 * 1024 * 1024) {
          return this._sendMessage(chatId, this._t('files_too_large'));
        }
      }

      // Download file from Telegram
      const fileInfo = await this._callApi('getFile', { file_id: fileId });
      if (!fileInfo || !fileInfo.file_path) {
        return this._sendMessage(chatId, this._t('files_download_error'));
      }

      const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) {
        return this._sendMessage(chatId, this._t('files_download_failed'));
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');

      const attachment = {
        type: mimeType,
        name: fileName,
        base64: base64,
      };

      // If there's a caption, treat it as text + attachment
      const caption = msg.caption || '';

      if (caption && ctx.sessionId) {
        // Send immediately with caption as text
        this.emit('send_message', {
          sessionId: ctx.sessionId,
          text: caption,
          userId,
          chatId,
          threadId: msg.message_thread_id || null,
          attachments: [attachment],
          callback: (err) => {
            if (err) this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(err.message || 'error') }));
          }
        });
      } else if (ctx.state === FSM_STATES.COMPOSING && ctx.sessionId) {
        // In compose mode, attach to pending
        ctx.pendingAttachments = ctx.pendingAttachments || [];
        ctx.pendingAttachments.push(attachment);
        await this._sendMessage(chatId,
          this._t('attach_pending', { name: this._escHtml(fileName), size: Math.round(buffer.length / 1024) }),
          { parse_mode: 'HTML' }
        );
      } else if (ctx.sessionId) {
        // Has active session, store as pending
        ctx.pendingAttachments = ctx.pendingAttachments || [];
        ctx.pendingAttachments.push(attachment);
        await this._sendMessage(chatId,
          this._t('attach_pending_ask', { name: this._escHtml(fileName) }),
          {
            parse_mode: 'HTML',
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: this._t('btn_cancel'), callback_data: 'd:clear_attach' },
              ]],
            }),
          }
        );
      } else {
        // Auto-restore session for media, same as text handler
        const workdir = ctx.projectWorkdir || process.env.WORKDIR || './workspace';
        const lastSession = this._stmts.getSessionsByWorkdir.all(workdir);
        if (lastSession.length > 0) {
          ctx.sessionId = lastSession[0].id;
          this._saveDeviceContext(userId);
        } else {
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          this.db.prepare(
            "INSERT INTO sessions (id, title, created_at, updated_at, workdir, model, engine) VALUES (?, ?, datetime('now'), datetime('now'), ?, 'sonnet', 'cli')"
          ).run(id, 'Telegram Session', workdir);
          ctx.sessionId = id;
          this._saveDeviceContext(userId);
        }
        // Store as pending attachment
        ctx.pendingAttachments = ctx.pendingAttachments || [];
        ctx.pendingAttachments.push(attachment);
        await this._sendMessage(chatId,
          this._t('attach_pending_ask', { name: this._escHtml(fileName) }),
          {
            parse_mode: 'HTML',
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: this._t('btn_cancel'), callback_data: 'd:clear_attach' },
              ]],
            }),
          }
        );
      }
    } catch (err) {
      this.log.error(`[telegram] Media handling error: ${err.message}`);
      await this._sendMessage(chatId, this._t('files_process_error'));
    }
  }

  // ─── Send Files to Telegram ─────────────────────────────────────────────

  async sendDocument(chatId, buffer, fileName, opts = {}) {
    const url = `${TELEGRAM_API}${this.token}/sendDocument`;
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('document', new Blob([buffer]), fileName);
    if (opts.caption) formData.append('caption', opts.caption);
    if (opts.parse_mode) formData.append('parse_mode', opts.parse_mode);
    if (opts.reply_markup) formData.append('reply_markup', typeof opts.reply_markup === 'string' ? opts.reply_markup : JSON.stringify(opts.reply_markup));

    try {
      const res = await fetch(url, { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.ok) this.log.error(`[telegram] sendDocument error: ${data.description}`);
      return data.result;
    } catch (err) {
      this.log.error(`[telegram] sendDocument failed: ${err.message}`);
      return null;
    }
  }

  async sendPhoto(chatId, buffer, opts = {}) {
    const url = `${TELEGRAM_API}${this.token}/sendPhoto`;
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('photo', new Blob([buffer]), opts.fileName || 'photo.jpg');
    if (opts.caption) formData.append('caption', opts.caption);
    if (opts.parse_mode) formData.append('parse_mode', opts.parse_mode);
    if (opts.reply_markup) formData.append('reply_markup', typeof opts.reply_markup === 'string' ? opts.reply_markup : JSON.stringify(opts.reply_markup));

    try {
      const res = await fetch(url, { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.ok) this.log.error(`[telegram] sendPhoto error: ${data.description}`);
      return data.result;
    } catch (err) {
      this.log.error(`[telegram] sendPhoto failed: ${err.message}`);
      return null;
    }
  }

  // ─── Push Notifications ─────────────────────────────────────────────────

  async notifyTaskComplete({ sessionId, title, status, duration, error }) {
    if (!this.running) return;

    const devices = this.db.prepare(
      'SELECT * FROM telegram_devices WHERE notifications_enabled = 1'
    ).all();

    if (!devices.length) return;

    let icon, statusText;
    if (status === 'done') {
      icon = '✅';
      statusText = 'Completed';
    } else if (status === 'error') {
      icon = '❌';
      statusText = 'Failed';
    } else {
      icon = 'ℹ️';
      statusText = status;
    }

    let durationText = '';
    if (duration) {
      const secs = Math.round(duration / 1000);
      if (secs < 60) durationText = `${secs}s`;
      else if (secs < 3600) durationText = `${Math.floor(secs / 60)}m ${secs % 60}s`;
      else durationText = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
    }

    const text = [
      `${icon} <b>${this._escHtml(title || 'Task')}</b>`,
      `Status: ${statusText}`,
      durationText ? `Duration: ${durationText}` : '',
      error ? `Error: ${this._escHtml(error.slice(0, 200))}` : '',
    ].filter(Boolean).join('\n');

    const keyboard = {
      inline_keyboard: [[
        { text: this._t('fm_btn_view'), callback_data: `d:view:${sessionId}` },
        { text: this._t('fm_btn_resume'), callback_data: `d:compose:${sessionId}` },
        { text: this._t('btn_back_menu'), callback_data: 'm:menu' },
      ]],
    };

    for (const device of devices) {
      // Rate limit: max 1 notification per device per 5 seconds
      const ctx = this._getContext(device.telegram_user_id);
      const now = Date.now();
      if (now - (ctx.lastNotifiedAt || 0) < 5000) continue;
      ctx.lastNotifiedAt = now;

      if (device.forum_chat_id) {
        // Forum mode — try forum Activity topic first, fallback to private chat
        let forumOk = false;
        try {
          forumOk = await this._notifyForumActivity(device.forum_chat_id, text, sessionId);
        } catch (err) {
          this.log.warn(`[telegram] Forum activity notify failed: ${err.message}`);
        }
        if (!forumOk) {
          // Fallback: Activity topic missing or failed — send to private chat
          try {
            await this._sendMessage(device.telegram_chat_id, text, {
              parse_mode: 'HTML',
              reply_markup: JSON.stringify(keyboard),
            });
          } catch (err) {
            this.log.warn(`[telegram] Notify fallback failed for ${device.telegram_user_id}: ${err.message}`);
          }
        }
      } else {
        // Single mode — send to private chat
        try {
          await this._sendMessage(device.telegram_chat_id, text, {
            parse_mode: 'HTML',
            reply_markup: JSON.stringify(keyboard),
          });
        } catch (err) {
          this.log.warn(`[telegram] Notify failed for ${device.telegram_user_id}: ${err.message}`);
        }
      }
    }
  }

  // ─── Ask User Notification (cross-context alert) ──────────────────────

  /**
   * Notify all paired devices about a pending ask_user question.
   * Called from TelegramProxy._handleAskUser() after the question is sent
   * to the originating chat. Ensures the user sees the question even if
   * they are in a different Forum topic or on a different device.
   *
   * @param {Object} opts
   * @param {number} opts.userId - Telegram user ID
   * @param {string} opts.sessionId - Chat session ID
   * @param {number|string} opts.sourceChatId - Chat where the ask was already sent
   * @param {number|null} opts.sourceThreadId - Thread where the ask was already sent (Forum)
   * @param {string} opts.questionText - The question text from Claude
   * @param {Array} opts.questions - Full questions array (for options)
   */
  async notifyAskUser({ userId, sessionId, sourceChatId, sourceThreadId, questionText, questions }) {
    if (!this.running) return;

    const devices = this._stmts.getAllDevices.all().filter(d => d.notifications_enabled);
    if (!devices.length) return;

    // Session info for context
    const session = this._stmts.getSessionInfo.get(sessionId);
    const sessionTitle = session?.title || 'Claude';

    // Build notification text
    const q = (Array.isArray(questions) && questions.length) ? questions[0] : {};
    const truncatedQuestion = questionText.length > 500 ? questionText.slice(0, 500) + '…' : questionText;

    const text = [
      `❓ <b>${this._t('ask_notify_title')}</b>`,
      this._t('ask_notify_session', { title: this._escHtml(sessionTitle) }),
      '',
      this._escHtml(truncatedQuestion),
      '',
      q.options?.length ? `<i>${this._t('ask_choose_hint')}</i>` : `<i>${this._t('ask_text_hint')}</i>`,
    ].join('\n');

    // Build answer buttons (same callback_data as the original ask)
    const skipLabel = this._t('ask_skip_btn');
    const rows = [];
    if (q.options?.length) {
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const label = (typeof opt === 'string' ? opt : (opt.label || opt.value || `Option ${i + 1}`)).substring(0, 64);
        rows.push([{ text: label, callback_data: `ask:${i}` }]);
      }
    }
    rows.push([{ text: skipLabel, callback_data: 'ask:skip' }]);

    // No rate limit — ask notifications are urgent, one-time events.
    // Unlike task completions, missing an ask blocks Claude's progress.
    for (const device of devices) {
      try {
        if (device.forum_chat_id) {
          // Forum Mode — send to Activity topic with project link
          await this._notifyForumAskUser(device.forum_chat_id, text, session, rows);
        } else {
          // Private chat — skip if the ask was already sent to this exact chat
          if (String(device.telegram_chat_id) === String(sourceChatId) && !sourceThreadId) continue;
          await this._sendMessage(device.telegram_chat_id, text, {
            parse_mode: 'HTML',
            reply_markup: JSON.stringify({ inline_keyboard: rows }),
          });
        }
      } catch (err) {
        this.log.warn(`[telegram] Ask notification failed for ${device.display_name}: ${err.message}`);
      }
    }
  }

  /**
   * Send ask_user notification to Forum Activity topic with project link.
   */
  async _notifyForumAskUser(forumChatId, text, session, answerRows) {
    const topics = this._stmts.getForumTopics.all(forumChatId);
    const activityTopic = topics.find(t => t.type === 'activity');
    if (!activityTopic) return;

    // Clone rows and add "Go to chat" URL button if project topic exists
    const rows = answerRows.map(r => [...r]);
    if (session?.workdir) {
      const projectTopic = topics.find(t => t.type === 'project' && t.workdir === session.workdir);
      if (projectTopic) {
        const topicUrl = this._topicLink(forumChatId, projectTopic.thread_id);
        rows.push([{ text: this._t('ask_notify_go_to_chat'), url: topicUrl }]);
      }
    }

    await this._sendMessage(forumChatId, text, {
      message_thread_id: activityTopic.thread_id,
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({ inline_keyboard: rows }),
    });
  }

  // ─── Stop / New Commands ────────────────────────────────────────────────

  async _cmdStop(chatId, userId) {
    const ctx = this._getContext(userId);
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };
    if (!ctx.sessionId) {
      return this._sendMessage(chatId, this._t('error_no_session'), navButtons);
    }

    this.emit('stop_task', { sessionId: ctx.sessionId, chatId });
    await this._sendMessage(chatId, this._t('stop_sent'), navButtons);
  }

  // ─── Forum Mode ────────────────────────────────────────────────────────

  /**
   * /forum command in private chat — show setup instructions
   */
  async _cmdForum(chatId, userId) {
    const device = this._stmts.getDevice.get(userId);
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };
    if (device?.forum_chat_id) {
      return this._sendMessage(chatId, this._t('forum_already'), navButtons);
    }
    await this._sendMessage(chatId, this._t('forum_instructions'), navButtons);
  }

  /**
   * /connect command in a supergroup — pair the forum group
   */
  async _handleForumConnect(msg) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    // Must be a supergroup with Topics enabled
    if (msg.chat.type !== 'supergroup' || !msg.chat.is_forum) {
      return this._sendMessage(chatId, this._t('forum_not_supergroup'));
    }

    // User must already be paired via private chat
    if (!this._isAuthorized(userId)) {
      return this._sendMessage(chatId, this._t('forum_not_paired'));
    }

    // Check bot has manage_topics permission
    try {
      const botMember = await this._callApi('getChatMember', { chat_id: chatId, user_id: this._botId });
      const canManage = botMember?.can_manage_topics || botMember?.status === 'creator';
      if (!canManage) {
        return this._sendMessage(chatId, this._t('forum_not_admin'));
      }
    } catch {
      return this._sendMessage(chatId, this._t('forum_not_admin'));
    }

    // Save forum_chat_id (or keep existing)
    const device = this._stmts.getDevice.get(userId);
    const alreadyConnected = device?.forum_chat_id === chatId;
    if (!alreadyConnected) {
      this._stmts.setForumChatId.run(chatId, userId);
    }

    // Send status message BEFORE the actual creation
    await this._sendMessage(chatId, this._t(alreadyConnected ? 'forum_syncing' : 'forum_connected'));

    // Clear _currentThreadId so structure messages go to correct threads (not the /connect thread)
    const savedThreadId = this._currentThreadId;
    this._currentThreadId = null;

    try {
      await this._createForumStructure(chatId);
    } catch (err) {
      if (!alreadyConnected) {
        this._stmts.setForumChatId.run(null, userId);
      }
      this.log.error(`[telegram] Forum connect failed: ${err.message}`);
      await this._sendMessage(chatId, this._t('forum_not_admin'));
    } finally {
      this._currentThreadId = savedThreadId;
    }
  }

  /**
   * Create the initial forum structure: Tasks + Activity topics.
   * Project topics are created on demand.
   */
  async _createForumStructure(chatId) {
    try {
      // Check if topics already exist
      const existing = this._stmts.getForumTopics.all(chatId);
      const hasTasksTopic = existing.some(t => t.type === 'tasks');
      const hasActivityTopic = existing.some(t => t.type === 'activity');

      if (!hasTasksTopic) {
        this.log.info(`[telegram] Creating Tasks topic in forum ${chatId}`);
        const tasksTopic = await this._callApi('createForumTopic', {
          chat_id: chatId,
          name: '📋 Tasks',
        });
        this.log.info(`[telegram] Tasks topic created: thread_id=${tasksTopic.message_thread_id}`);
        this._stmts.addForumTopic.run(tasksTopic.message_thread_id, chatId, 'tasks', null);
        this._forumTopics.set(`${chatId}:${tasksTopic.message_thread_id}`, { type: 'tasks', workdir: null, chatId });

        // Pin instructions in Tasks topic (pass thread_id explicitly to avoid race condition)
        const pinMsg = await this._sendMessage(chatId, this._t('forum_topic_tasks'), {
          message_thread_id: tasksTopic.message_thread_id,
        });
        if (pinMsg) {
          this._callApi('pinChatMessage', { chat_id: chatId, message_id: pinMsg.message_id, disable_notification: true }).catch(() => {});
        }
      }

      if (!hasActivityTopic) {
        this.log.info(`[telegram] Creating Activity topic in forum ${chatId}`);
        const activityTopic = await this._callApi('createForumTopic', {
          chat_id: chatId,
          name: '🔔 Activity',
        });
        this.log.info(`[telegram] Activity topic created: thread_id=${activityTopic.message_thread_id}`);
        this._stmts.addForumTopic.run(activityTopic.message_thread_id, chatId, 'activity', null);
        this._forumTopics.set(`${chatId}:${activityTopic.message_thread_id}`, { type: 'activity', workdir: null, chatId });

        // Pin instructions in Activity topic (pass thread_id explicitly to avoid race condition)
        const pinMsg = await this._sendMessage(chatId, this._t('forum_topic_activity'), {
          message_thread_id: activityTopic.message_thread_id,
        });
        if (pinMsg) {
          this._callApi('pinChatMessage', { chat_id: chatId, message_id: pinMsg.message_id, disable_notification: true }).catch(() => {});
        }
      }

      // Notify in General topic (explicit no thread_id — goes to General)
      this.log.info(`[telegram] Forum structure created, sending confirmation`);
      await this._sendMessage(chatId, this._t('forum_created_topics'));

      // Create topics for existing projects
      await this._syncProjectTopics(chatId);
    } catch (err) {
      this.log.error(`[telegram] Failed to create forum structure: ${err.message}`);
      throw err; // Re-throw so _handleForumConnect can rollback
    }
  }

  /**
   * Create forum topics for projects that don't have one yet.
   */
  async _syncProjectTopics(chatId) {
    try {
      const projectsData = require('fs').readFileSync(
        require('path').join(process.cwd(), 'data', 'projects.json'), 'utf8'
      );
      const projects = JSON.parse(projectsData);
      if (!Array.isArray(projects)) return;

      for (const project of projects) {
        const workdir = typeof project === 'string' ? project : (project?.workdir || project?.path);
        if (!workdir) continue;

        const existing = this._stmts.getForumTopicByWorkdir.get(chatId, 'project', workdir);
        if (existing) continue;

        const name = (typeof project === 'object' && project?.name) || null;
        await this._createProjectTopic(chatId, workdir, name);
      }
    } catch {
      // projects.json may not exist — that's fine
    }
  }

  /**
   * Create a single project topic in the forum.
   */
  async _createProjectTopic(chatId, workdir, displayName) {
    const name = displayName || workdir.split('/').filter(Boolean).pop() || workdir;
    try {
      const topic = await this._callApi('createForumTopic', {
        chat_id: chatId,
        name: `📁 ${name}`,
      });

      this._stmts.addForumTopic.run(topic.message_thread_id, chatId, 'project', workdir);
      this._forumTopics.set(`${chatId}:${topic.message_thread_id}`, { type: 'project', workdir, chatId });

      // Pin project info (pass thread_id explicitly to avoid race condition)
      const pinMsg = await this._sendMessage(chatId, this._t('forum_topic_project', {
        name: this._escHtml(name),
        path: this._escHtml(workdir),
      }), {
        message_thread_id: topic.message_thread_id,
        reply_markup: JSON.stringify({ inline_keyboard: [[
          { text: this._t('fm_btn_history'), callback_data: 'fm:history' },
          { text: this._t('fm_btn_new'), callback_data: 'fm:new' },
          { text: this._t('fm_btn_info'), callback_data: 'fm:info' },
        ]] }),
      });
      if (pinMsg) {
        this._callApi('pinChatMessage', { chat_id: chatId, message_id: pinMsg.message_id, disable_notification: true }).catch(() => {});
      }

      return topic.message_thread_id;
    } catch (err) {
      this.log.error(`[telegram] Failed to create project topic for ${name}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get topic info by threadId (from cache or DB).
   */
  _getTopicInfo(chatId, threadId) {
    const key = `${chatId}:${threadId}`;
    if (this._forumTopics.has(key)) return this._forumTopics.get(key);

    const row = this._stmts.getForumTopic.get(threadId, chatId);
    if (row) {
      const info = { type: row.type, workdir: row.workdir, chatId };
      this._forumTopics.set(key, info);
      return info;
    }
    return null;
  }

  /**
   * Main handler for messages in a forum supergroup.
   * Routes based on which topic the message is in.
   */
  async _handleForumMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const threadId = msg.message_thread_id;
    const text = (msg.text || '').trim();

    // General topic (no thread_id) — handle basic commands
    if (!threadId) {
      if (text.startsWith('/')) return this._handleForumGeneralCommand(msg);
      return;
    }

    const topicInfo = this._getTopicInfo(chatId, threadId);
    if (!topicInfo) {
      // Unknown topic — either user-created or the General topic
      if (text.startsWith('/')) return this._handleForumGeneralCommand(msg);
      if (text) await this._sendMessage(chatId, this._t('forum_unknown_topic'));
      return;
    }

    switch (topicInfo.type) {
      case 'project':
        return this._handleForumProjectMessage(msg, topicInfo.workdir);
      case 'tasks':
        return this._handleForumTaskMessage(msg);
      case 'activity':
        if ((msg.text || '').trim()) {
          await this._sendMessage(chatId, this._t('forum_activity_readonly'));
        }
        return;
      default:
        return;
    }
  }

  /**
   * Handle commands in the General topic or unknown topics.
   */
  async _handleForumGeneralCommand(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');

    if (cmd === '/status') return this._cmdStatus(chatId, msg.from.id);
    if (cmd === '/help') return this._sendMessage(chatId, this._t('forum_help_general'));

    // Unknown command feedback
    if (cmd.startsWith('/')) {
      return this._sendMessage(chatId, this._t('forum_unknown_cmd', { cmd: this._escHtml(cmd) }));
    }
  }

  /**
   * Handle messages in a Project topic — send to Claude.
   */
  async _handleForumProjectMessage(msg, workdir) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text || '').trim();
    const ctx = this._getContext(userId);

    // Set project context + validate session belongs to this project
    ctx.projectWorkdir = workdir;
    if (ctx.sessionId) {
      const sess = this.db.prepare('SELECT workdir FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (!sess || sess.workdir !== workdir) {
        // Session from different project — restore last session for this project, or clear
        const lastForProject = this._stmts.getSessionsByWorkdir.all(workdir);
        ctx.sessionId = lastForProject.length ? lastForProject[0].id : null;
        this._saveDeviceContext(userId);
      }
    }

    // Persistent keyboard buttons send their label text into the topic — intercept before Claude
    if (text === this._t('kb_menu'))   return this._forumShowInfo(chatId, userId, workdir);
    if (text === this._t('kb_status')) return this._cmdStatus(chatId, userId);
    if (text.startsWith(this._t('kb_write')))  return; // In forum mode, just type directly in the topic
    if (text.startsWith(this._t('kb_project_prefix'))) return; // Project button ignored in forum mode

    // Handle project-specific commands
    if (text.startsWith('/')) {
      const [rawCmd, ...argParts] = text.split(/\s+/);
      const cmd = rawCmd.toLowerCase().replace(/@\w+$/, '');
      const args = argParts.join(' ');

      switch (cmd) {
        case '/new':
          return this._forumNewSession(chatId, userId, workdir);
        case '/history':
          return this._forumShowHistory(chatId, userId, workdir);
        case '/session': {
          const idx = parseInt(args) - 1;
          if (isNaN(idx) || idx < 0) return this._sendMessage(chatId, '💡 /session <i>N</i>');
          return this._forumSwitchSession(chatId, userId, workdir, idx);
        }
        case '/files':
          return this._cmdFiles(chatId, userId, argParts.length ? argParts : ['.']);
        case '/cat':
          return this._cmdCat(chatId, userId, argParts);
        case '/last':
          return this._cmdLast(chatId, userId, argParts);
        case '/full':
          return this._cmdFull(chatId, userId);
        case '/diff':
          return this._cmdDiff(chatId, userId);
        case '/log':
          return this._cmdLog(chatId, userId, argParts);
        case '/stop':
          return this._cmdStop(chatId, userId);
        case '/status':
          return this._cmdStatus(chatId, userId);
        case '/help':
          return this._sendMessage(chatId, this._t('forum_help_project'));
        case '/info':
          return this._forumShowInfo(chatId, userId, workdir);
        default:
          // Unknown command — treat as message to Claude
          break;
      }
    }

    if (!text) {
      if (msg.photo || msg.document) {
        return this._handleMediaMessage(msg);
      }
      return this._sendMessage(chatId, this._t('forum_no_text'));
    }

    // Ensure session exists for this project — show orientation on first interaction
    if (!ctx.sessionId) {
      const existing = this._stmts.getSessionsByWorkdir.all(workdir);
      if (existing.length > 0) {
        // Restore last session + show orientation
        ctx.sessionId = existing[0].id;
        this._saveDeviceContext(userId);
        const title = (existing[0].title || this._t('chat_untitled')).substring(0, 40);
        const buttons = [
          { text: this._t('fm_btn_history'), callback_data: 'fm:history' },
          { text: this._t('fm_btn_new'), callback_data: 'fm:new' },
        ];
        await this._sendMessage(chatId,
          `📌 ${this._escHtml(title)} (${existing[0].msg_count || 0} msg)\n` +
          (existing.length > 1 ? `📜 +${existing.length - 1} sessions\n` : ''),
          { reply_markup: JSON.stringify({ inline_keyboard: [buttons] }) }
        );
      } else {
        await this._forumNewSession(chatId, userId, workdir, true);
      }
    }

    // Collect attachments
    const attachments = ctx.pendingAttachments || [];
    ctx.pendingAttachments = [];

    // Send to Claude
    this.emit('send_message', {
      sessionId: ctx.sessionId,
      text,
      userId,
      chatId,
      threadId: msg.message_thread_id,
      attachments,
      callback: async (result) => {
        if (result.error) {
          await this._sendMessage(chatId, `❌ ${this._escHtml(result.error)}`);
        }
      },
    });
  }

  /**
   * Create a new session in a forum project topic.
   */
  async _forumNewSession(chatId, userId, workdir, silent = false) {
    const ctx = this._getContext(userId);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    this._stmts.insertSession.run(id, 'Telegram Session', workdir);

    ctx.sessionId = id;
    ctx.projectWorkdir = workdir;
    this._saveDeviceContext(userId);

    if (!silent) {
      const buttons = [
        { text: this._t('fm_btn_history'), callback_data: 'fm:history' },
      ];
      await this._sendMessage(chatId, this._t('forum_session_started'), {
        reply_markup: JSON.stringify({ inline_keyboard: [buttons] }),
      });
    }
  }

  /**
   * Show current session info and project state.
   */
  async _forumShowInfo(chatId, userId, workdir) {
    const ctx = this._getContext(userId);
    const projectName = workdir.split('/').filter(Boolean).pop() || workdir;
    const rows = this._stmts.getSessionsByWorkdir.all(workdir);

    let text = `📁 <b>${this._escHtml(projectName)}</b>\n📂 <code>${this._escHtml(workdir)}</code>\n`;

    if (ctx.sessionId) {
      const sess = this.db.prepare('SELECT title, updated_at FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (sess) {
        const title = (sess.title || this._t('chat_untitled')).substring(0, 45);
        const ago = this._timeAgo(sess.updated_at);
        const msgCount = this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(ctx.sessionId)?.c || 0;
        text += `\n💬 <b>${this._escHtml(title)}</b>\n📊 ${msgCount} msg · ${ago}`;
      }
    } else {
      text += `\n💬 <i>${this._t('error_no_session')}</i>`;
    }

    text += `\n📜 ${this._t('status_sessions', { count: rows.length })}`;

    const buttons = [
      { text: this._t('fm_btn_last5'), callback_data: 'fm:last' },
      { text: this._t('fm_btn_history'), callback_data: 'fm:history' },
      { text: this._t('fm_btn_new'), callback_data: 'fm:new' },
    ];
    await this._sendMessage(chatId, text, {
      reply_markup: JSON.stringify({ inline_keyboard: [buttons] }),
    });
  }

  /**
   * Show session history for a project in forum mode.
   */
  async _forumShowHistory(chatId, userId, workdir) {
    const ctx = this._getContext(userId);
    const rows = this._stmts.getSessionsByWorkdir.all(workdir);

    if (rows.length === 0) {
      return this._sendMessage(chatId, this._t('forum_history_empty'));
    }

    let text = this._t('forum_history_title', { count: rows.length });
    const keyboard = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const active = r.id === ctx.sessionId ? ' ◀️' : '';
      const title = (r.title || this._t('chat_untitled')).substring(0, 40);
      const ago = this._timeAgo(r.updated_at);
      text += `\n${i + 1}. ${this._escHtml(title)}  ·  ${r.msg_count} msgs  ·  ${ago}${active}`;
      // Inline button for quick switching (2 buttons per row)
      const btn = { text: `${i + 1}. ${title.substring(0, 25)}${active}`, callback_data: `fs:${i}` };
      if (i % 2 === 0) keyboard.push([btn]); else keyboard[keyboard.length - 1].push(btn);
    }

    await this._sendMessage(chatId, text, {
      reply_markup: JSON.stringify({ inline_keyboard: keyboard }),
    });
  }

  /**
   * Handle forum session switch callback (fs:N).
   */
  async _handleForumSessionCallback(chatId, userId, data) {
    const idx = parseInt(data.slice(3));
    if (isNaN(idx) || idx < 0) return;

    // Get workdir from the topic this callback originated in
    const threadId = this._currentThreadId;
    if (!threadId) return;
    const topicInfo = this._getTopicInfo(chatId, threadId);
    if (!topicInfo?.workdir) return;

    return this._forumSwitchSession(chatId, userId, topicInfo.workdir, idx);
  }

  /**
   * Handle forum action callbacks (fm:history, fm:new, fm:compose, fm:diff, fm:files, fm:stop, fm:retry, fm:last).
   */
  async _handleForumActionCallback(chatId, userId, data) {
    const action = data.slice(3);
    const threadId = this._currentThreadId;
    if (!threadId) return;
    const topicInfo = this._getTopicInfo(chatId, threadId);
    if (!topicInfo?.workdir) return;

    // Always sync user context to the topic we're acting in — prevents cross-project data leaks
    // when ctx.projectWorkdir/sessionId were set by another topic (e.g. via Activity fa:open)
    const ctx = this._getContext(userId);
    ctx.projectWorkdir = topicInfo.workdir;
    if (ctx.sessionId) {
      const sess = this.db.prepare('SELECT workdir FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (!sess || sess.workdir !== topicInfo.workdir) {
        const lastForProject = this._stmts.getSessionsByWorkdir.all(topicInfo.workdir);
        ctx.sessionId = lastForProject.length ? lastForProject[0].id : null;
      }
    }

    switch (action) {
      case 'history':
        return this._forumShowHistory(chatId, userId, topicInfo.workdir);
      case 'new':
        return this._forumNewSession(chatId, userId, topicInfo.workdir);
      case 'compose': {
        // Prompt user to type their message — in forum, all text goes to Claude automatically
        await this._sendMessage(chatId, this._t('compose_prompt'), {
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._t('btn_cancel'), callback_data: 'fm:info' }],
          ]}),
        });
        return;
      }
      case 'diff':
        return this._cmdDiff(chatId, userId);
      case 'files':
        return this._cmdFiles(chatId, userId, ['.']);
      case 'stop':
        return this._cmdStop(chatId, userId);
      case 'info':
        return this._forumShowInfo(chatId, userId, topicInfo.workdir);
      case 'last': {
        // Show last 5 messages of current session
        if (!ctx.sessionId) return this._sendMessage(chatId, this._t('forum_history_empty'));
        return this._cmdLast(chatId, userId, ['5']);
      }
      case 'retry': {
        // Resend the last user message
        if (!ctx.sessionId) return;
        const lastUserMsg = this.db.prepare(
          `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`
        ).get(ctx.sessionId);
        if (!lastUserMsg?.content) return;
        this.emit('send_message', {
          sessionId: ctx.sessionId,
          text: lastUserMsg.content,
          userId,
          chatId,
          threadId,
          attachments: [],
          callback: async (result) => {
            if (result.error) await this._sendMessage(chatId, `❌ ${this._escHtml(result.error)}`);
          },
        });
        return;
      }
    }
  }

  /**
   * Handle activity notification callbacks (fa:open:sessionId, fa:project:threadId).
   */
  async _handleForumActivityCallback(chatId, userId, data) {
    const parts = data.slice(3).split(':');
    const action = parts[0];
    const param = parts.slice(1).join(':');

    switch (action) {
      case 'open': {
        // Open chat — show last messages from this session
        const session = this.db.prepare('SELECT id, title, workdir FROM sessions WHERE id = ?').get(param);
        if (!session) return this._sendMessage(chatId, this._t('forum_task_not_found'));

        // Find project topic for this workdir and switch session there
        const topics = this._stmts.getForumTopics.all(chatId);
        let projectTopic = topics.find(t => t.type === 'project' && t.workdir === session.workdir);

        // Auto-create project topic if it doesn't exist yet
        if (!projectTopic) {
          const newThreadId = await this._createProjectTopic(chatId, session.workdir);
          if (!newThreadId) {
            return this._sendMessage(chatId, '❌ Failed to create project topic.');
          }
          projectTopic = { thread_id: newThreadId, type: 'project', workdir: session.workdir };
        }

        // Switch user's active session
        const ctx = this._getContext(userId);
        ctx.projectWorkdir = session.workdir;
        ctx.sessionId = session.id;
        this._saveDeviceContext(userId);

        // Show last messages in the project topic
        const msgs = this.db.prepare(
          `SELECT role, type, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 5`
        ).all(session.id).reverse();

        let text = `💬 <b>${this._escHtml((session.title || this._t('chat_untitled')).substring(0, 50))}</b>\n`;
        for (const m of msgs) {
          const icon = m.role === 'user' ? '👤' : '🤖';
          const content = (m.content || '').substring(0, 150).replace(/\n/g, ' ');
          text += `\n${icon} ${this._escHtml(content)}`;
        }
        if (msgs.length === 0) text += `\n<i>${this._t('chat_no_messages')}</i>`;

        // Send message to project topic + provide direct link for navigation
        const topicUrl = this._topicLink(chatId, projectTopic.thread_id);
        text += `\n\n${this._t('fm_session_activated_hint')}`;

        const buttons = [
          [
            { text: this._t('fm_btn_continue'), callback_data: 'fm:compose' },
            { text: this._t('fm_btn_full'), callback_data: 'fm:last' },
          ],
          [
            { text: this._t('fm_btn_history'), callback_data: 'fm:history' },
            { text: this._t('fm_btn_new'), callback_data: 'fm:new' },
          ],
        ];

        await this._sendMessage(chatId, text, {
          message_thread_id: projectTopic.thread_id,
          parse_mode: 'HTML',
          reply_markup: JSON.stringify({ inline_keyboard: buttons }),
        });

        // Also send a navigation link in the Activity topic so user can jump there
        await this._sendMessage(chatId, this._t('fm_session_activated_short'), {
          message_thread_id: this._currentThreadId,
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._t('fm_btn_go_project'), url: topicUrl }],
          ]}),
        });
        return;
      }

      case 'project': {
        // Navigate to project topic — send URL link for direct navigation
        const threadId = parseInt(param);
        if (isNaN(threadId)) return;

        const topicUrl = this._topicLink(chatId, threadId);
        await this._sendMessage(chatId, this._t('fm_write_in_topic'), {
          message_thread_id: this._currentThreadId,
          parse_mode: 'HTML',
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._t('fm_btn_go_project'), url: topicUrl }],
          ]}),
        });
        return;
      }
    }
  }

  /**
   * Switch to a specific session by index (from /history list).
   */
  async _forumSwitchSession(chatId, userId, workdir, idx) {
    const rows = this._stmts.getSessionsByWorkdir.all(workdir);

    if (idx >= rows.length) {
      return this._sendMessage(chatId, this._t('forum_task_not_found'));
    }

    const ctx = this._getContext(userId);
    ctx.sessionId = rows[idx].id;
    this._saveDeviceContext(userId);

    const title = (rows[idx].title || this._t('chat_untitled')).substring(0, 50);
    const msgCount = rows[idx].msg_count || 0;
    const text = this._t('forum_switch_session', { title: this._escHtml(title) })
      + `\n📊 ${msgCount} msg`;

    const buttons = [
      { text: this._t('fm_btn_last5'), callback_data: 'fm:last' },
      { text: this._t('fm_btn_history'), callback_data: 'fm:history' },
      { text: this._t('fm_btn_new'), callback_data: 'fm:new' },
    ];
    await this._sendMessage(chatId, text, {
      reply_markup: JSON.stringify({ inline_keyboard: [buttons] }),
    });
  }

  /**
   * Handle messages in the Tasks topic.
   */
  async _handleForumTaskMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const ctx = this._getContext(userId);
    const text = (msg.text || '').trim();

    if (!text.startsWith('/')) {
      // Plain text in tasks topic — create a task from it
      const title = text.substring(0, 200);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const workdir = ctx.projectWorkdir || null;

      this._stmts.insertTask.run(id, title, workdir);

      const workdirLine = workdir ? `\n📁 ${this._escHtml(workdir.split('/').filter(Boolean).pop())}` : '';
      return this._sendMessage(chatId, this._t('forum_task_created', {
        id: this._escHtml(id),
        title: this._escHtml(title),
        workdir_line: workdirLine,
      }));
    }

    const [rawCmd, ...argParts] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@\w+$/, '');
    const args = argParts.join(' ').trim();

    switch (cmd) {
      case '/new': {
        if (!args) return this._sendMessage(chatId, '💡 /new <i>task title</i>');
        const title = args.substring(0, 200);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const workdir = ctx.projectWorkdir || null;

        this._stmts.insertTask.run(id, title, workdir);

        const workdirLine = workdir ? `\n📁 ${this._escHtml(workdir.split('/').filter(Boolean).pop())}` : '';
        return this._sendMessage(chatId, this._t('forum_task_created', {
          id: this._escHtml(id),
          title: this._escHtml(title),
          workdir_line: workdirLine,
        }));
      }

      case '/list': {
        const rows = this._stmts.listTasksOrdered.all();

        if (rows.length === 0) return this._sendMessage(chatId, this._t('tasks_empty'));

        const icons = { backlog: '📋', todo: '📝', in_progress: '🔄', done: '✅', blocked: '🚫' };
        const grouped = {};
        for (const r of rows) {
          if (!grouped[r.status]) grouped[r.status] = [];
          grouped[r.status].push(r);
        }

        let listText = this._t('tasks_title', { count: rows.length }) + '\n\n';
        for (const [status, items] of Object.entries(grouped)) {
          listText += `${icons[status] || '•'} <b>${this._escHtml(status)}</b> (${items.length})\n`;
          listText += items.map(t => `  · <code>${t.id.slice(-4)}</code> ${this._escHtml((t.title || '').substring(0, 45))}`).join('\n') + '\n\n';
        }
        return this._sendMessage(chatId, listText);
      }

      case '/done':
      case '/start':
      case '/todo':
      case '/block':
      case '/backlog': {
        const taskIdSearch = args.replace('#', '').replace(/[%_]/g, '');
        if (!taskIdSearch) return this._sendMessage(chatId, `💡 ${cmd} <i>#id</i>`);

        const task = this._stmts.findTaskByIdLike.get(`%${taskIdSearch}`);
        if (!task) return this._sendMessage(chatId, this._t('forum_task_not_found'));

        const statusMap = { '/done': 'done', '/start': 'in_progress', '/todo': 'todo', '/block': 'blocked', '/backlog': 'backlog' };
        const iconMap = { done: '✅', in_progress: '🔄', todo: '📝', blocked: '🚫', backlog: '📋' };
        const newStatus = statusMap[cmd];
        this._stmts.updateTaskStatus.run(newStatus, task.id);

        const msgText = this._t('forum_task_updated', {
          icon: iconMap[newStatus],
          id: this._escHtml(task.id.slice(-4)),
          title: this._escHtml((task.title || '').substring(0, 50)),
          status: newStatus,
        });

        // Add "Go to project" button for actionable statuses if task has workdir
        const options = {};
        if (task.workdir && (newStatus === 'in_progress' || newStatus === 'todo')) {
          const device = this._stmts.getDevice.get(userId);
          if (device?.forum_chat_id) {
            const topics = this._stmts.getForumTopics.all(device.forum_chat_id);
            const projectTopic = topics.find(t => t.type === 'project' && t.workdir === task.workdir);
            if (projectTopic) {
              options.reply_markup = JSON.stringify({ inline_keyboard: [[
                { text: this._t('fm_btn_go_project_files'), callback_data: `fa:project:${projectTopic.thread_id}` },
              ]] });
            }
          }
        }

        return this._sendMessage(chatId, msgText, options);
      }

      case '/delete': {
        const taskIdSearch = args.replace('#', '').replace(/[%_]/g, '');
        if (!taskIdSearch) return this._sendMessage(chatId, '💡 /delete <i>#id</i>');

        const task = this._stmts.findTaskByIdLike.get(`%${taskIdSearch}`);
        if (!task) return this._sendMessage(chatId, this._t('forum_task_not_found'));

        this.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
        return this._sendMessage(chatId, `🗑 <b>#${this._escHtml(task.id.slice(-4))}</b> ${this._escHtml((task.title || '').substring(0, 50))} — deleted`);
      }

      case '/help':
        return this._sendMessage(chatId, this._t('forum_help_tasks'));

      default:
        return;
    }
  }

  /**
   * Disconnect forum — remove pairing, clean up DB + cache.
   */
  async _cmdForumDisconnect(chatId, userId) {
    const device = this._stmts.getDevice.get(userId);
    const forumChatId = device?.forum_chat_id;

    // Clear forum_chat_id from device
    this._stmts.setForumChatId.run(null, userId);

    // Clean up forum_topics in DB and _forumTopics cache
    if (forumChatId) {
      this._stmts.deleteForumTopicsByChatId.run(forumChatId);
      for (const key of this._forumTopics.keys()) {
        if (key.startsWith(`${forumChatId}:`)) this._forumTopics.delete(key);
      }
    }

    await this._sendMessage(chatId, this._t('forum_disconnected'));
  }

  /**
   * Send a notification to the Activity topic in the forum.
   */
  async _notifyForumActivity(forumChatId, text, sessionId) {
    const topics = this._stmts.getForumTopics.all(forumChatId);
    const activityTopic = topics.find(t => t.type === 'activity');
    if (!activityTopic) return false;

    // Build action buttons — find project topic for this session
    const options = { message_thread_id: activityTopic.thread_id, parse_mode: 'HTML' };

    if (sessionId) {
      const session = this.db.prepare('SELECT workdir FROM sessions WHERE id = ?').get(sessionId);
      if (session?.workdir) {
        const projectTopic = topics.find(t => t.type === 'project' && t.workdir === session.workdir);
        const buttons = [];

        // Use URL buttons for cross-topic navigation — Telegram client navigates directly
        if (projectTopic) {
          const topicUrl = this._topicLink(forumChatId, projectTopic.thread_id);
          buttons.push({ text: this._t('fm_btn_open_chat'), url: topicUrl });
        } else {
          // Fallback: callback button to auto-create project topic + show preview
          buttons.push({ text: this._t('fm_btn_open_chat'), callback_data: `fa:open:${sessionId}` });
        }

        options.reply_markup = JSON.stringify({ inline_keyboard: [buttons] });
      }
    }

    await this._sendMessage(forumChatId, text, options);
    return true;
  }

  // ─── Inline New Chat / New Task ──────────────────────────────────────────

  async _handleNewChat(chatId, userId, { editMsgId } = {}) {
    const ctx = this._getContext(userId);
    const workdir = ctx.projectWorkdir || process.env.WORKDIR || './workspace';

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    this.db.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at, workdir, model, engine) VALUES (?, ?, datetime('now'), datetime('now'), ?, 'sonnet', 'cli')"
    ).run(id, 'Telegram Session', workdir);

    ctx.sessionId = id;
    ctx.state = FSM_STATES.COMPOSING;
    ctx.stateData = null;
    ctx.dialogPage = 0;
    this._saveDeviceContext(userId);

    const newChatText = this._t('new_session_created', { id: this._escHtml(id) });
    const newChatKb = [[{ text: this._t('btn_cancel'), callback_data: 'd:overview' }]];
    if (editMsgId) {
      await this._editScreen(chatId, editMsgId, newChatText, newChatKb);
    } else {
      await this._showScreen(chatId, userId, newChatText, newChatKb);
    }

    // Update persistent keyboard to reflect new active chat
    await this._sendReplyKeyboard(chatId, ctx, this._t('new_session_created', { id: this._escHtml(id) }).split('\n')[0]);
  }

  async _handleNewTask(chatId, userId, { editMsgId } = {}) {
    const ctx = this._getContext(userId);
    ctx.state = FSM_STATES.AWAITING_TASK_TITLE;
    ctx.stateData = { workdir: ctx.projectWorkdir || null };

    const taskText = this._t('new_task_prompt');
    const taskKb = [[{ text: this._t('btn_cancel'), callback_data: ctx.projectWorkdir ? 't:list' : 'm:menu' }]];
    if (editMsgId) {
      await this._editScreen(chatId, editMsgId, taskText, taskKb);
    } else {
      await this._showScreen(chatId, userId, taskText, taskKb);
    }
  }

  async _handleSkipTaskDesc(chatId, userId, { editMsgId } = {}) {
    const ctx = this._getContext(userId);
    ctx.state = FSM_STATES.IDLE;
    ctx.stateData = null;

    // Go back to tasks list
    return this._screenTasks(chatId, userId, ctx.projectWorkdir ? 't:list' : 't:all', { editMsgId });
  }

  async _cmdInfo(chatId, userId) {
    const ctx = this._getContext(userId);
    const workdir = ctx.projectWorkdir || process.env.WORKDIR || './workspace';
    const projectName = workdir.split('/').filter(Boolean).pop() || workdir;

    let text = `📁 <b>${this._escHtml(projectName)}</b>\n📂 <code>${this._escHtml(workdir)}</code>\n`;

    if (ctx.sessionId) {
      const sess = this.db.prepare('SELECT title, updated_at FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (sess) {
        const title = (sess.title || this._t('chat_untitled')).substring(0, 45);
        const ago = this._timeAgo(sess.updated_at);
        const msgCount = this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(ctx.sessionId)?.c || 0;
        text += `\n💬 <b>${this._escHtml(title)}</b>\n📊 ${msgCount} msg · ${ago}`;
      }
    } else {
      text += `\n💬 <i>${this._t('error_no_session')}</i>`;
    }

    const rows = this._stmts.getSessionsByWorkdir.all(workdir);
    text += `\n📜 ${this._t('status_sessions', { count: rows.length })}`;

    const keyboard = [
      [{ text: this._t('btn_chats'), callback_data: 'c:list:0' },
       { text: this._t('btn_new_chat'), callback_data: 'c:new' }],
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ];

    await this._sendMessage(chatId, text, {
      reply_markup: JSON.stringify({ inline_keyboard: keyboard }),
    });
  }

  async _cmdNew(chatId, userId, args) {
    const ctx = this._getContext(userId);
    const workdir = ctx.projectWorkdir || process.env.WORKDIR || './workspace';

    // Generate text ID matching server.js genId() format
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    // Create new session in DB with proper text ID
    this.db.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at, workdir, model, engine) VALUES (?, ?, datetime('now'), datetime('now'), ?, 'sonnet', 'cli')"
    ).run(id, args || 'Telegram Session', workdir);

    ctx.sessionId = id;
    ctx.state = FSM_STATES.COMPOSING;
    ctx.dialogPage = 0;
    this._saveDeviceContext(userId);

    await this._showScreen(chatId, userId,
      this._t('new_session_created', { id: this._escHtml(id) }),
      [[{ text: this._t('btn_cancel'), callback_data: 'd:overview' }]]
    );
  }

  // ─── Session Persistence ────────────────────────────────────────────────

  _saveDeviceContext(userId) {
    const ctx = this._getContext(userId);
    try {
      this.db.prepare(
        'UPDATE telegram_devices SET last_session_id = ?, last_workdir = ? WHERE telegram_user_id = ?'
      ).run(ctx.sessionId || null, ctx.projectWorkdir || null, userId);
    } catch(e) {}
  }

  _restoreDeviceContext(userId) {
    const ctx = this._getContext(userId);
    // Only restore if context is completely empty (fresh process or after restart)
    if (ctx.sessionId != null && ctx.projectWorkdir != null) return;
    try {
      const device = this.db.prepare(
        'SELECT last_session_id, last_workdir FROM telegram_devices WHERE telegram_user_id = ?'
      ).get(userId);
      if (device) {
        if (device.last_session_id) ctx.sessionId = device.last_session_id;
        if (device.last_workdir) ctx.projectWorkdir = device.last_workdir;
      }
    } catch(e) {}
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async _showMessages(chatId, sessionId, limit) {
    try {
      const rows = this.db.prepare(`
        SELECT role, type, content, tool_name, created_at
        FROM messages
        WHERE session_id = ? AND (type IS NULL OR type != 'tool')
        ORDER BY id DESC
        LIMIT ?
      `).all(sessionId, limit).reverse();

      if (rows.length === 0) {
        await this._sendMessage(chatId, this._t('chat_no_messages'));
        return;
      }

      const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(sessionId);
      const title = sess?.title || this._t('chat_untitled');

      const lines = rows.map(r => {
        const icon = r.role === 'user' ? '👤' : '🤖';
        const content = this._escHtml(this._sanitize(r.content || '').substring(0, 300));
        const truncated = (r.content?.length || 0) > 300 ? '...' : '';
        return `${icon} ${content}${truncated}`;
      });

      // Build inline action buttons instead of text hints
      const isForumTopic = !!this._currentThreadId;
      const actionButtons = isForumTopic
        ? [
            [
              { text: this._t('fm_btn_full'), callback_data: 'fm:last' },
              { text: this._t('fm_btn_continue'), callback_data: 'fm:compose' },
              { text: this._t('fm_btn_diff'), callback_data: 'fm:diff' },
            ],
            [
              { text: this._t('fm_btn_history'), callback_data: 'fm:history' },
              { text: this._t('fm_btn_new'), callback_data: 'fm:new' },
            ],
          ]
        : [
            [
              { text: this._t('btn_full_msg'), callback_data: 'cm:full' },
              { text: this._t('btn_write'), callback_data: 'cm:compose' },
              { text: this._t('btn_back_menu'), callback_data: 'm:menu' },
            ],
          ];

      await this._sendMessage(chatId,
        `💬 <b>${this._escHtml(title)}</b>\n${'─'.repeat(20)}\n\n${lines.join('\n\n')}`,
        {
          parse_mode: 'HTML',
          reply_markup: JSON.stringify({ inline_keyboard: actionButtons }),
        }
      );
    } catch (err) {
      await this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(err.message) }));
    }
  }

  _getContext(userId) {
    if (!this._userContext.has(userId)) {
      this._userContext.set(userId, {
        sessionId: null,
        projectWorkdir: null,
        projectList: null,
        chatList: null,
        chatPage: 0,            // pagination for chat list
        filePath: null,         // current dir in file browser
        filePathCache: new Map(), // int key → absolute path
        // FSM: single state field replaces composing + pendingInput + pendingAskRequestId
        state: FSM_STATES.IDLE,
        stateData: null,        // carries context: { taskId, title, workdir } or { askRequestId, askQuestions }
        // Unchanged fields
        dialogPage: 0,           // dialog pagination offset
        pendingAttachments: [],   // files waiting for text message
        isStreaming: false,       // whether a response is currently streaming
        streamMsgId: null,        // message ID of streaming progress
        lastNotifiedAt: 0,        // rate limiting for notifications
      });
    }
    const ctx = this._userContext.get(userId);
    // Auto-migration: if old fields present, convert to FSM
    if ('pendingInput' in ctx || 'composing' in ctx || 'pendingAskRequestId' in ctx) {
      this._migrateContextToFSM(ctx);
    }
    return ctx;
  }

  _migrateContextToFSM(ctx) {
    if (ctx.pendingAskRequestId) {
      ctx.state = FSM_STATES.AWAITING_ASK_RESPONSE;
      ctx.stateData = {
        askRequestId: ctx.pendingAskRequestId,
        askQuestions: ctx.pendingAskQuestions || null,
      };
    } else if (ctx.pendingInput === 'task_title') {
      ctx.state = FSM_STATES.AWAITING_TASK_TITLE;
      ctx.stateData = ctx.pendingTaskData || null;
    } else if (ctx.pendingInput === 'task_description') {
      ctx.state = FSM_STATES.AWAITING_TASK_DESCRIPTION;
      ctx.stateData = ctx.pendingTaskData || null;
    } else if (ctx.composing) {
      ctx.state = FSM_STATES.COMPOSING;
      ctx.stateData = null;
    } else {
      ctx.state = FSM_STATES.IDLE;
      ctx.stateData = null;
    }
    delete ctx.composing;
    delete ctx.pendingInput;
    delete ctx.pendingAskRequestId;
    delete ctx.pendingAskQuestions;
    delete ctx.pendingTaskData;
  }

  _timeAgo(isoDate) {
    if (!isoDate) return this._t('time_ago_long');
    const diff = Date.now() - new Date(isoDate).getTime();
    if (diff < 60000) return this._t('time_ago_now');
    if (diff < 3600000) return this._t('time_ago_min', { n: Math.floor(diff / 60000) });
    if (diff < 86400000) return this._t('time_ago_hour', { n: Math.floor(diff / 3600000) });
    return this._t('time_ago_day', { n: Math.floor(diff / 86400000) });
  }

  /**
   * Generate a deep link URL to a specific forum topic.
   * Format: https://t.me/c/{internal_id}/{thread_id}
   * Works for private supergroups — navigates members directly to the topic.
   */
  _topicLink(chatId, threadId) {
    // Supergroup chat IDs follow the format -100XXXXXXXXXX
    // Strip the -100 prefix to get the internal ID
    const idStr = String(chatId);
    const internalId = idStr.startsWith('-100') ? idStr.slice(4) : idStr.replace('-', '');
    return `https://t.me/c/${internalId}/${threadId}`;
  }

  /** HTML-escape for Telegram HTML parse mode */
  _escHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Convert Markdown to Telegram HTML */
  _mdToHtml(text) {
    if (!text) return '';
    const parts = [];
    let lastEnd = 0;
    const fenceRe = /```(\w*)\n([\s\S]*?)(?:```|$)/g;
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
      const pre = text.slice(lastEnd, m.index);
      if (pre) parts.push(this._inlineToHtml(pre));
      const lang = (m[1] || '').trim();
      const code = this._escHtml(m[2].replace(/\n+$/, ''));
      parts.push(lang
        ? `<pre><code class="language-${lang}">${code}</code></pre>`
        : `<pre><code>${code}</code></pre>`);
      lastEnd = m.index + m[0].length;
    }
    const tail = text.slice(lastEnd);
    if (tail) parts.push(this._inlineToHtml(tail));
    return parts.join('');
  }

  /** Convert inline Markdown to Telegram HTML (no code fences) */
  _inlineToHtml(text) {
    // 0. Tables → readable text
    text = this._mdTableToText(text);

    // 0b. Headers → placeholder markers (before HTML escape)
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '\x02B\x02$1\x02/B\x02');

    // 0c. Save Markdown links [text](url) → placeholders
    const links = [];
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
      links.push([t, u]);
      return `\x01L${links.length - 1}\x01`;
    });

    // 0d. List markers → bullets
    text = text.replace(/^[\t ]*[-*]\s+/gm, '\u2022 ');

    // 0e. Checkboxes → bullets
    text = text.replace(/^(\s*)- \[[ x]\] /gm, '$1\u2022 ');

    // 0f. Blockquotes → bar
    text = text.replace(/^>\s?(.*)$/gm, '\u258e $1');

    // 0g. Horizontal rules
    text = text.replace(/^-{3,}$/gm, '\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014');

    // 1. Save inline `code` → placeholders (HTML-escaped inside)
    const codes = [];
    text = text.replace(/`([^`\n]+?)`/g, (_, c) => {
      codes.push(this._escHtml(c));
      return `\x01C${codes.length - 1}\x01`;
    });

    // 2. HTML-escape the rest
    text = this._escHtml(text);

    // 3. Inline formatting
    text = text.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
    text = text.replace(/__(.+?)__/gs, '<b>$1</b>');
    text = text.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
    text = text.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');
    text = text.replace(/~~(.+?)~~/gs, '<s>$1</s>');

    // 4. Restore inline code
    for (let i = 0; i < codes.length; i++) {
      text = text.replace(`\x01C${i}\x01`, `<code>${codes[i]}</code>`);
    }

    // 5. Restore links
    for (let i = 0; i < links.length; i++) {
      const [lt, lu] = links[i];
      text = text.replace(`\x01L${i}\x01`, `<a href="${this._escHtml(lu)}">${this._escHtml(lt)}</a>`);
    }

    // 6. Restore header markers
    text = text.replace(/\x02B\x02/g, '<b>').replace(/\x02\/B\x02/g, '</b>');

    return text;
  }

  /** Convert Markdown tables to readable plain text */
  _mdTableToText(text) {
    const lines = text.split('\n');
    const result = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (line.startsWith('|') && line.endsWith('|') && (line.match(/\|/g) || []).length >= 3) {
        const tableRows = [];
        while (i < lines.length) {
          const row = lines[i].trim();
          if (row.startsWith('|') && row.endsWith('|') && (row.match(/\|/g) || []).length >= 3) {
            const cells = row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
            if (!cells.every(c => /^[-:]+$/.test(c))) {
              tableRows.push(cells);
            }
            i++;
          } else {
            break;
          }
        }
        if (tableRows.length) {
          const headers = tableRows[0];
          if (tableRows.length > 1 && headers.length >= 2) {
            for (let r = 1; r < tableRows.length; r++) {
              const parts = tableRows[r].map((cell, j) =>
                j < headers.length && headers[j] ? `${headers[j]}: ${cell}` : cell
              );
              result.push('\u25aa ' + parts.join(' | '));
            }
          } else {
            for (const row of tableRows) {
              result.push('\u25aa ' + row.join(' | '));
            }
          }
        }
      } else {
        result.push(lines[i]);
        i++;
      }
    }
    return result.join('\n');
  }

  /** Split text into Telegram-safe chunks with code-fence awareness */
  _chunkForTelegram(text, limit = MAX_MESSAGE_LENGTH) {
    text = (text || '').trim();
    if (!text || text.length <= limit) return text ? [text] : [];

    const result = [];
    let pos = 0;
    let str = text;

    while (pos < str.length) {
      if (str.length - pos <= limit) {
        const tail = str.slice(pos).trim();
        if (tail) result.push(tail);
        break;
      }

      const window = str.slice(pos, pos + limit);

      // Count ``` — odd means we'd split inside an open fence
      const fences = [];
      let fi = -1;
      while ((fi = window.indexOf('```', fi + 1)) !== -1) fences.push(fi);

      if (fences.length % 2 === 1) {
        const lastOpen = fences[fences.length - 1];

        if (lastOpen > limit / 3) {
          // Enough content before code block — split before it
          const pre = window.slice(0, lastOpen).trimEnd();
          const splitAt = this._findSplit(pre, pre.length);
          result.push(str.slice(pos, pos + splitAt).trimEnd());
          pos += splitAt;
          while (pos < str.length && ' \t\n'.includes(str[pos])) pos++;
        } else {
          // Code block too early — split at newline inside it
          const nl = window.lastIndexOf('\n');
          const langM = window.slice(lastOpen).match(/^```(\w*)/);
          const lang = langM ? langM[1] : '';

          if (nl > limit / 4) {
            let chunk = str.slice(pos, pos + nl).trimEnd();
            if (!chunk.endsWith('```')) chunk += '\n```';
            result.push(chunk);
            pos += nl + 1;
          } else {
            result.push(str.slice(pos, pos + limit).trimEnd() + '\n```');
            pos += limit;
          }
          // Reopen fence for next chunk
          str = str.slice(0, pos) + '```' + lang + '\n' + str.slice(pos);
        }
      } else {
        // Standard split — no open code fence
        const splitAt = this._findSplit(window, limit);
        const chunk = str.slice(pos, pos + splitAt).trimEnd();
        if (chunk) result.push(chunk);
        pos += splitAt;
        while (pos < str.length && ' \t\n'.includes(str[pos])) pos++;
      }
    }

    return result.filter(c => c.trim());
  }

  /** Find the best split point within a text window */
  _findSplit(text, limit) {
    if (text.length <= limit) return text.length;
    const window = text.slice(0, limit);

    // Priority 1: paragraph boundary (double newline) — at least 1/3 into window
    let idx = window.lastIndexOf('\n\n');
    if (idx >= limit / 3) return idx;

    // Priority 2: single newline — at least 1/4 into window
    idx = window.lastIndexOf('\n');
    if (idx >= limit / 4) return idx + 1;

    // Priority 3: sentence end
    for (const marker of ['. ', '! ', '? ']) {
      idx = window.lastIndexOf(marker);
      if (idx >= limit / 5) return idx + marker.length;
    }

    // Priority 4: word boundary
    idx = window.lastIndexOf(' ');
    if (idx > 0) return idx + 1;

    return limit; // hard cut
  }
}

module.exports = TelegramBot;
module.exports.FSM_STATES = FSM_STATES;
module.exports.SCREENS = SCREENS;
module.exports.CALLBACK_TO_SCREEN = CALLBACK_TO_SCREEN;
