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

// ─── Telegram message constants (used by TelegramProxy) ─────────────────────
// Only collapse what genuinely does not fit a single Telegram message. At the old
// 800-char threshold, a normal answer routinely came back truncated to a preview —
// worst for multi-bot turns, where the second bot's whole reply vanished behind the
// "tap to expand" button because the combined text crossed 800 almost immediately.
const TG_COLLAPSE_THRESHOLD = 3500;
const TG_PREVIEW_LENGTH = 600;

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
    // Resolves a workdir to its bot roster plus whether this chat's engine can run one.
    // Projects live in a JSON file that only server.js reads, so this arrives as a
    // callback rather than a query — same composition as the Forum module's facade.
    this._getRoster = typeof opts.getRoster === 'function' ? opts.getRoster : null;

    // In-memory state
    this._pairingCodes = new Map();  // code → { createdAt, expiresAt }
    this._failedAttempts = new Map(); // telegramUserId → { count, blockedUntil }
    this._userContext = new Map();    // telegramUserId → { sessionId, projectWorkdir }
    this._rateLimit = new Map();     // telegramUserId → { count, resetAt }
    this._currentThreadId = null;    // Legacy: used by shared commands for forum-aware button generation. Will be removed in Phase 4.
    this._botId = null;              // bot's own user ID (set on start)

    // DB setup
    this._initDb();
    this._prepareStmts();

    // Forum module (composition pattern — receives API facade, not bot instance)
    const TelegramBotForum = require('./telegram-bot-forum');
    this._forum = new TelegramBotForum({
      db: this.db,
      log: this.log,
      callApi: this._callApi.bind(this),
      sendMessage: this._sendMessage.bind(this),
      editScreen: this._editScreen.bind(this),
      showScreen: this._showScreen.bind(this),
      t: this._t.bind(this),
      escHtml: this._escHtml.bind(this),
      sanitize: this._sanitize.bind(this),
      mdToHtml: this._mdToHtml.bind(this),
      chunkForTelegram: this._chunkForTelegram.bind(this),
      timeAgo: this._timeAgo.bind(this),
      stmts: this._stmts,
      emit: this.emit.bind(this),
      getDirectContext: this._getContext.bind(this),
      saveDeviceContext: this._saveDeviceContext.bind(this),
      botId: () => this._botId,
      botUsername: () => this._botInfo?.username || 'your_bot',
      cmdStatus: this._cmdStatus.bind(this),
      cmdBots: this._cmdBots.bind(this),
      // The roster itself, for the Forum module's bot topics. Same callback the /bots
      // listing uses; nothing in telegram-bot-forum.js can resolve a workdir on its own.
      getRoster: (workdir, sessionId) => (this._getRoster ? this._getRoster(workdir, sessionId) : null),
      cmdFiles: this._cmdFiles.bind(this),
      cmdCat: this._cmdCat.bind(this),
      cmdLast: this._cmdLast.bind(this),
      cmdFull: this._cmdFull.bind(this),
      cmdDiff: this._cmdDiff.bind(this),
      cmdLog: this._cmdLog.bind(this),
      cmdStop: this._cmdStop.bind(this),
      handleMediaMessage: this._handleMediaMessage.bind(this),
    });
  }

  // ─── i18n ─────────────────────────────────────────────────────────────────

  _t(key, params = {}) {
    const dict = BOT_I18N[this.lang] || BOT_I18N.uk;
    let text = dict[key] || BOT_I18N.uk[key] || key;
    for (const [k, v] of Object.entries(params)) {
      // A function replacer, not a string one: String.replace(regex, string) treats
      // '$&', '$`', "$'" and '$$' in the REPLACEMENT as special patterns. A param
      // value containing one (e.g. a real folder name like "a$`b") would otherwise
      // splice in unrelated parts of the template instead of its own literal text.
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
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
    // Which session was last active IN THIS TOPIC. Before this column, active session
    // was tracked only on the per-user ctx (one global field), so leaving a topic and
    // coming back could restore whichever session in that workdir had most recently
    // been touched ANYWHERE (including from the web UI) — not the one this topic
    // itself was last showing.
    try { this.db.exec("ALTER TABLE forum_topics ADD COLUMN session_id TEXT"); } catch(e) {}
    // Which bot owns this topic, for type='bot'. A bot topic is a project topic bound to
    // one handle: everything typed there is addressed to that bot, so the user does not
    // retype '@@handle' on every message. NULL for every other topic type.
    try { this.db.exec("ALTER TABLE forum_topics ADD COLUMN bot_id TEXT"); } catch(e) {}
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
      getForumOwner:     this.db.prepare('SELECT * FROM telegram_devices WHERE forum_chat_id = ? AND telegram_user_id != ? LIMIT 1'),
      getForumDevices:   this.db.prepare('SELECT * FROM telegram_devices WHERE forum_chat_id IS NOT NULL AND notifications_enabled = 1'),
      addForumTopic:     this.db.prepare('INSERT OR REPLACE INTO forum_topics (thread_id, chat_id, type, workdir) VALUES (?, ?, ?, ?)'),
      // Separate from addForumTopic rather than a fifth parameter on it: that statement
      // is INSERT OR REPLACE and is called from several places that know nothing about
      // bots, and widening it would have every one of them write NULL over a bot_id.
      addForumBotTopic:  this.db.prepare('INSERT OR REPLACE INTO forum_topics (thread_id, chat_id, type, workdir, bot_id) VALUES (?, ?, ?, ?, ?)'),
      getForumBotTopic:  this.db.prepare("SELECT * FROM forum_topics WHERE chat_id = ? AND type = 'bot' AND bot_id = ?"),
      getForumTopic:     this.db.prepare('SELECT * FROM forum_topics WHERE thread_id = ? AND chat_id = ?'),
      getForumTopics:    this.db.prepare('SELECT * FROM forum_topics WHERE chat_id = ?'),
      getForumTopicByWorkdir: this.db.prepare('SELECT * FROM forum_topics WHERE chat_id = ? AND type = ? AND workdir = ?'),
      setForumTopicSession: this.db.prepare('UPDATE forum_topics SET session_id = ? WHERE chat_id = ? AND workdir = ? AND type = ?'),
      deleteForumTopic:  this.db.prepare('DELETE FROM forum_topics WHERE thread_id = ? AND chat_id = ?'),
      deleteForumTopicsByChatId: this.db.prepare('DELETE FROM forum_topics WHERE chat_id = ?'),
      // Forum sessions
      insertSession:     this.db.prepare("INSERT INTO sessions (id, title, created_at, updated_at, workdir, model, engine) VALUES (?, ?, datetime('now'), datetime('now'), ?, 'sonnet', 'cli')"),
      getSessionsByWorkdir: this.db.prepare('SELECT id, title, updated_at, (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as msg_count FROM sessions s WHERE COALESCE(git_root, workdir) = ? ORDER BY updated_at DESC LIMIT 15'),
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
      // Network errors — retry after delay. A revoked/invalid token is fatal: Telegram
      // answers getUpdates with "Unauthorized" (401), not the string this used to look
      // for ("Invalid bot token" never appears in a live API error) — so a revoked
      // token used to retry forever, every 5s, with no signal to the operator.
      if (!/unauthorized|invalid bot token/i.test(err.message || '')) {
        this.log.warn(`[telegram] Poll error (retrying in 5s): ${err.message}`);
        if (this.running) {
          this._pollTimer = setTimeout(() => this._poll(), 5000);
        }
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

  async _callApi(method, params = {}, _retried = false) {
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
      // Telegram signals rate limiting as error_code 429 with the wait time in
      // parameters.retry_after (seconds) — the message text alone ("Too Many
      // Requests: retry after N") was being thrown and never actually matched
      // against '429' anywhere, so every 429 fell straight through as a normal
      // error. Wait the exact time Telegram asks for and retry once.
      if (data.error_code === 429 && !_retried) {
        const waitMs = (Number(data.parameters?.retry_after) || 1) * 1000 + 250;
        this.log?.warn?.(`[telegram] 429 rate limited on ${method}, waiting ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        return this._callApi(method, params, true);
      }
      throw new Error(data.description || `Telegram API error: ${method}`);
    }
    return data.result;
  }

  async _sendMessage(chatId, text, options = {}) {
    // Truncate long messages
    let safeText = text;
    if (safeText.length > MAX_MESSAGE_LENGTH) {
      safeText = this._safeCut(safeText, MAX_MESSAGE_LENGTH) + '\n\n' + this._t('files_truncated_short');
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
      text: text.length > MAX_MESSAGE_LENGTH ? this._safeCut(text, MAX_MESSAGE_LENGTH) + '\n\n' + this._t('files_truncated_short') : text,
      parse_mode: 'HTML',
    };
    if (keyboard) params.reply_markup = JSON.stringify({ inline_keyboard: keyboard });

    try {
      return await this._callApi('editMessageText', params);
    } catch (err) {
      if (err.message?.includes('message is not modified')) return null;
      // A parse failure is a CONTENT problem, not a missing-message problem: keep
      // editing the same screen (One Screen Message) rather than posting a new one.
      // First retry without parse_mode, then with markup stripped so the user sees
      // readable text instead of raw tags.
      if (err.message?.includes("can't parse")) {
        params.parse_mode = undefined;
        try { return await this._callApi('editMessageText', params); } catch { /* try stripped */ }
        try {
          return await this._callApi('editMessageText', { ...params, text: params.text.replace(/<[^>]+>/g, '') });
        } catch { /* fall through to new message */ }
      }
      // The message itself is gone or uneditable (deleted, too old) — only then is a
      // new message the right answer.
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
      this._rateLimit.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW, notified: false });
      return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
  }

  // Tell the user their message was dropped — ONCE per rate-limit window, so the
  // notice itself cannot become the flood. The forum path used to drop messages in
  // complete silence, which reads exactly like the bot being broken.
  async _notifyRateLimited(chatId, userId, threadId) {
    const entry = this._rateLimit.get(userId);
    if (entry?.notified) return;
    if (entry) entry.notified = true;
    const opts = threadId ? { message_thread_id: threadId } : {};
    try { await this._sendMessage(chatId, this._t('rate_limit'), opts); } catch {}
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
    // Telegram does NOT set `is_topic_message` for messages posted in the General
    // topic — gating on it meant a message typed in General silently skipped Forum
    // Mode entirely and fell through to private-chat-style handling with the wrong
    // workdir. Whether this is Forum Mode depends only on which chat it's in: the
    // user's paired forum supergroup, topic or General alike.
    const isSupergroup = msg.chat?.type === 'supergroup';

    try {
      // Supergroup: handle /connect command early (before forum routing and auth)
      // Works both with and without @botname suffix, in topics and General
      if (isSupergroup && msg.text) {
        const connectText = msg.text.trim().toLowerCase().replace(/@\w+$/, '');
        if (connectText === '/connect') {
          return await this._forum.handleConnect(msg);
        }
      }

      // Forum mode: route to forum handler if message is from this user's paired forum group
      if (isSupergroup && this._isAuthorized(userId)) {
        const device = this._stmts.getDevice.get(userId);
        if (device?.forum_chat_id === chatId) {
          if (!this._checkRateLimit(userId)) { await this._notifyRateLimited(chatId, userId, msg.message_thread_id || null); return; }
          this._stmts.updateLastActive.run(userId);
          this._restoreDeviceContext(userId);
          const threadId = msg.message_thread_id || null;
          return await this._forum.handleMessage(msg, threadId);
        }
        // Authorized user, but this supergroup isn't their paired forum — ignore,
        // same as before (do not fall through to private-chat-style handling here).
        return;
      }

      // Handle media messages (photos, documents, files)
      if (msg.photo || msg.document) {
        if (!this._isAuthorized(userId)) return;
        if (!this._checkRateLimit(userId)) { await this._notifyRateLimited(chatId, userId, msg.message_thread_id || null); return; }
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
      // Fallback: match keyboard button text from any language (handles encoding/language mismatches)
      {
        const low = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
        const menuWords = ['menu', 'меню'];
        const statusWords = ['status', 'статус'];
        if (menuWords.includes(low)) { return this._screenMainMenu(chatId, userId); }
        if (statusWords.includes(low)) { return this._screenStatus(chatId, userId); }
      }
      // Legacy: 🔔 bell button (replaced by Settings, but keep for backwards compat)
      if (text === '🔔') {
        const device = this._stmts.getDevice.get(userId);
        const newVal = device?.notifications_enabled ? 0 : 1;
        this._stmts.updateNotifications.run(newVal, userId);
        return this._sendMessage(chatId, newVal ? this._t('notif_on') : this._t('notif_off'));
      }

      // Intercept: if there's a pending ask_user question, any text resolves it —
      // except a command, which must always route as a command. Without this guard,
      // /stop typed while a question was pending was swallowed as its literal answer.
      const ctx = this._getContext(userId);
      if (ctx.state === FSM_STATES.AWAITING_ASK_RESPONSE && !text.startsWith('/')) {
        const requestId = ctx.stateData?.askRequestId;
        const origAskMsgId = ctx.stateData?.askMsgId;
        const origAskChatId = ctx.stateData?.askChatId;
        ctx.state = FSM_STATES.IDLE;
        ctx.stateData = null;
        this.emit('ask_user_response', { requestId, answer: text });
        await this._sendMessage(chatId, this._t('ask_answered'));
        // Clean up original ask message (remove stale buttons)
        if (origAskMsgId && origAskChatId) {
          this._callApi('editMessageText', {
            chat_id: origAskChatId,
            message_id: origAskMsgId,
            text: this._t('ask_answered'),
            parse_mode: 'HTML',
          }).catch(() => {});
        }
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
      case '/bots':    return this._cmdBots(chatId, userId);
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
      case '/forum':   return this._forum.cmdForum(chatId, userId);
      case '/tunnel':  return this._cmdTunnel(chatId, userId);
      case '/url':     return this._cmdUrl(chatId);
      case '/cancel':  return this._cmdCancel(chatId, userId);
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

  // The bots a mention can reach from this chat. Mentions have worked from Telegram for
  // a while (server.js resolves them in processTelegramChat), but nothing here ever said
  // WHICH handles exist — the roster was reachable only from the web UI, so on a phone
  // the feature was invisible unless you already knew a handle by heart.
  async _cmdBots(chatId, userId, opts = {}) {
    const ctx = this._getContext(userId);
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };

    if (!this._getRoster) {
      await this._sendMessage(chatId, this._t('bots_unavailable'), navButtons);
      return;
    }
    const roster = this._getRoster(ctx.projectWorkdir, ctx.sessionId) || {};
    const bots = Array.isArray(roster.bots) ? roster.bots : [];
    if (!bots.length) {
      await this._sendMessage(chatId, this._t('bots_empty'), navButtons);
      return;
    }

    // Every field here is user-authored (label, description, and avatar, which is a free
    // text column rather than a picker) and the message goes out as HTML — so all three
    // are escaped, not just the obvious two.
    const lines = bots.map(b => {
      const avatar = this._escHtml(b.avatar || '🤖');
      const model = b.model ? ` · <i>${this._escHtml(b.model)}</i>` : '';
      const desc = b.description ? `\n      ${this._escHtml(b.description)}` : '';
      return `${avatar} <code>@@${this._escHtml(b.id)}</code> — ${this._escHtml(b.label)}${model}${desc}`;
    });

    // A full roster is 40 bots (ROSTER_MAX), which overruns Telegram's per-message cap
    // long before it runs out of bots — chunk instead of letting the API reject it.
    const warn = roster.available === false
      ? '\n\n' + this._t(roster.reason === 'ssh' ? 'bots_engine_ssh' : 'bots_engine_subscription')
      : '';
    // In a Forum, each bot also gets a button that opens a topic dedicated to it, so the
    // handle stops needing to be retyped on every message. Capped: one row per bot would
    // otherwise put 40 buttons under a single message. The cap is announced, never silent.
    let keyboard = null;
    if (opts.forum) {
      const BUTTON_CAP = 12;
      const rows = bots.slice(0, BUTTON_CAP).map(b => [{
        text: this._t('bots_btn_topic', { name: (b.label || b.id).slice(0, 24) }),
        callback_data: `fb:${b.id}`,
      }]);
      if (bots.length > BUTTON_CAP) {
        lines.push('\n' + this._t('bots_btn_capped', { shown: BUTTON_CAP, total: bots.length }));
      }
      keyboard = { reply_markup: JSON.stringify({ inline_keyboard: rows }) };
    }

    const body = this._t('bots_title', { count: bots.length }) + '\n\n'
      + lines.join('\n') + '\n\n' + this._t('bots_hint') + warn;
    const chunks = this._chunkForTelegram(body, MAX_MESSAGE_LENGTH - 100);
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      await this._sendMessage(chatId, chunks[i], last ? (keyboard || navButtons) : {});
    }
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

      // Chunk the RAW Markdown, not the HTML it converts to: _chunkForTelegram's
      // fence-awareness understands ``` markers, which only exist before conversion —
      // splitting the HTML risked cutting a message mid-<pre>/<code>/<a href="...">,
      // which Telegram then rejects outright.
      const chunks = this._chunkForTelegram(sanitized, MAX_MESSAGE_LENGTH - 100).map(c => this._mdToHtml(c));
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

    // resolve() normalizes baseDir (trailing slash / relative WORKDIR) so the
    // separator-suffixed comparison below can't false-negative on valid paths.
    const baseDir = pathMod.resolve(ctx.projectWorkdir || process.env.WORKDIR || pathMod.join(process.cwd(), 'workspace'));
    const filePath = pathMod.resolve(baseDir, args.join(' '));

    // Security: path traversal check. Must compare with a trailing separator —
    // a bare startsWith lets a sibling dir with a shared prefix slip through
    // (baseDir /srv/workspace would accept /srv/workspace-private/…).
    if (filePath !== baseDir && !filePath.startsWith(baseDir + pathMod.sep)) {
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
      await this._sendMessage(chatId, this._renderFileHtml(name, ext, sanitized, content.length), navButtons);
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

  // FSM state is already reset generically before the command switch (FSM-03) —
  // this only needs to clear pending attachments and land the user somewhere sane.
  async _cmdCancel(chatId, userId) {
    const ctx = this._getContext(userId);
    ctx.pendingAttachments = [];
    if (ctx.sessionId) return this._screenDialog(chatId, userId, { mode: 'overview' });
    return this._screenMainMenu(chatId, userId);
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
          const ok = await this._forum.notifyActivity(dev.forum_chat_id, text);
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
          const ok = await this._forum.notifyActivity(dev.forum_chat_id, text);
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
   * Ensure every connected forum has a topic for a newly registered project.
   * Called by server.js right after `POST /api/projects` adds one. Without this,
   * a project's topic list only refreshed on the initial /connect sweep, or
   * reactively when session activity happened to reference the workdir — a
   * project added afterward with no chat yet never got a topic at all.
   */
  async notifyProjectAdded(workdir, name) {
    if (!this.running || !workdir) return;
    const devices = this._stmts.getAllDevices.all();
    const seenChats = new Set();
    for (const dev of devices) {
      if (!dev.forum_chat_id || seenChats.has(dev.forum_chat_id)) continue;
      seenChats.add(dev.forum_chat_id);
      try {
        await this._forum.ensureProjectTopic(dev.forum_chat_id, workdir, name);
      } catch (err) {
        this.log.warn(`[telegram] Failed to sync project topic for ${workdir}: ${err.message}`);
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
      const sess = this.db.prepare('SELECT workdir, git_root FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (sess && sess.workdir && (sess.git_root || sess.workdir) !== ctx.projectWorkdir) {
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

    // Emit event for server.js to handle (send message to Claude).
    // threadId is passed explicitly: the whole run (thinking indicator, streaming,
    // final answer) is addressed from it, and leaving it undefined made the reply
    // fall back to whatever topic the bot happened to be processing at the time.
    this.emit('send_message', {
      sessionId: ctx.sessionId,
      text: msg.text,
      userId,
      chatId,
      threadId: msg.message_thread_id || null,
      attachments,
      callback: async (result) => {
        // Explicit thread on the error reply: this callback runs after the run has
        // started, by which point the bot's mutable `_currentThreadId` may point at
        // a different topic entirely.
        const cbOpts = msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};
        if (result.error) {
          await this._sendMessage(chatId, `❌ ${this._escHtml(result.error)}`, {
            ...cbOpts,
            reply_markup: JSON.stringify({ inline_keyboard: [
              [{ text: '🔄 ' + this._t('btn_refresh'), callback_data: 'cm:compose' },
               { text: this._t('btn_back_menu'), callback_data: 'm:menu' }]
            ]})
          });
        }
        // No success confirmation: the run itself already posts a visible
        // "🤔 Processing your request..." indicator (TelegramProxy.startThinking),
        // so an extra "⏳ Sent" made every single message cost two notifications
        // that say the same thing.
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

    // Save original ask message location before clearing stateData
    const origAskMsgId = ctx.stateData?.askMsgId;
    const origAskChatId = ctx.stateData?.askChatId;

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
      // Clean up original ask message if answered from a different context
      this._cleanupOtherAskMsg(chatId, msgId, origAskChatId, origAskMsgId, this._t('ask_skipped'));
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

    const resolvedText = this._t('ask_selected', { option: this._escHtml(answer) });

    // Edit the question message to show what was selected
    try {
      await this._callApi('editMessageText', {
        chat_id: chatId,
        message_id: msgId,
        text: resolvedText,
        parse_mode: 'HTML',
      });
    } catch {}
    // Clean up original ask message if answered from a different context
    this._cleanupOtherAskMsg(chatId, msgId, origAskChatId, origAskMsgId, resolvedText);
  }

  /**
   * Edit the original ask message when answered from a different context (notification).
   * Silently fails — cleanup is best-effort, never blocks the answer flow.
   */
  _cleanupOtherAskMsg(answeredChatId, answeredMsgId, origChatId, origMsgId, text) {
    if (!origMsgId || !origChatId) return;
    // Same message — already edited above
    if (String(answeredChatId) === String(origChatId) && answeredMsgId === origMsgId) return;
    this._callApi('editMessageText', {
      chat_id: origChatId,
      message_id: origMsgId,
      text,
      parse_mode: 'HTML',
    }).catch(() => {}); // Best-effort, fire-and-forget
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
      // Reset input states on any non-related navigation callback
      if ((ctx.state === FSM_STATES.AWAITING_TASK_TITLE ||
           ctx.state === FSM_STATES.AWAITING_TASK_DESCRIPTION) &&
          !data.startsWith('t:')) {
        ctx.state = FSM_STATES.IDLE;
        ctx.stateData = null;
      }
      // Reset COMPOSING state when user navigates away via inline button
      // (compose is only for free-text input; any callback means user changed intent)
      if (ctx.state === FSM_STATES.COMPOSING &&
          data !== 'cm:compose' && !data.startsWith('d:compose:') && !data.startsWith('ask:')) {
        ctx.state = FSM_STATES.IDLE;
      }

      // ask_user option selection
      if (data.startsWith('ask:')) return this._handleAskCallback(chatId, userId, msgId, data);

      // Forum project topic guard — prevent cross-project navigation
      const threadId = cbq.message?.message_thread_id || null;
      if (threadId) {
        const topicInfo = this._forum.getTopicInfo(chatId, threadId);
        if (topicInfo?.type === 'project') {
          // "Back to menu" goes to forum project info, not the global menu
          if (data === 'm:menu' || data === 'm:status')
            return this._forum.showInfo(chatId, userId, topicInfo.workdir, threadId);
          // Block global project navigation (p:list, p:sel:N) — redirect to project info instead of silent block
          if (data === 'p:list' || data.startsWith('p:list:') || data.startsWith('p:sel:'))
            return this._forum.showInfo(chatId, userId, topicInfo.workdir, threadId);
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
      if (data.startsWith('ft:') || data.startsWith('fo:') || data.startsWith('fs:') || data.startsWith('fm:') || data.startsWith('fa:')) {
        return this._forum.handleCallback(chatId, userId, data, threadId, msgId);
      }
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
          'SELECT id, title FROM sessions WHERE COALESCE(git_root, workdir) = ? ORDER BY updated_at DESC LIMIT 2'
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
        "SELECT COALESCE(git_root, workdir) AS workdir FROM sessions WHERE workdir IS NOT NULL AND workdir != '' GROUP BY COALESCE(git_root, workdir) ORDER BY MAX(updated_at) DESC LIMIT 2"
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
        SELECT COALESCE(git_root, workdir) AS workdir, COUNT(*) as chat_count, MAX(updated_at) as last_active
        FROM sessions WHERE workdir IS NOT NULL AND workdir != ''
        GROUP BY COALESCE(git_root, workdir) ORDER BY last_active DESC LIMIT 30
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
          WHERE COALESCE(s.git_root, s.workdir) = ? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 50
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

    await this._sendMessage(chatId, this._safeCut(formatted, 4096), {
      parse_mode: 'HTML',
      reply_markup: msgKeyboard ? JSON.stringify(msgKeyboard) : undefined,
    }).catch(() => {
      return this._sendMessage(chatId, this._safeCut(formatted.replace(/<[^>]+>/g, ''), 4096), {
        reply_markup: msgKeyboard ? JSON.stringify(msgKeyboard) : undefined,
      });
    });
  }

  async _showFullMessage(chatId, msgId) {
    const msg = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!msg) return this._sendMessage(chatId, this._t('chat_not_found'));

    const icon = msg.role === 'user' ? '👤' : '🤖';
    const sanitized = this._sanitize(msg.content || '');
    const header = `${icon} <b>${this._escHtml(msg.role)}</b>\n\n`;

    // Chunk the RAW Markdown (fence-aware), convert each piece to HTML afterward —
    // chunking the already-converted HTML risked splitting a message mid-<pre>/
    // <code>/<a href="...">, which Telegram then rejects outright. The header is
    // already-safe raw HTML, so only the first chunk gets it prepended. An empty
    // body still yields the header-only chunk instead of vanishing entirely.
    const bodyChunks = this._chunkForTelegram(sanitized, MAX_MESSAGE_LENGTH - 100 - header.length);
    const chunks = (bodyChunks.length ? bodyChunks : ['']).map((c, i) => (i === 0 ? header : '') + this._mdToHtml(c));
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

    // resolve() normalizes baseDir (trailing slash / relative WORKDIR) so the
    // separator-suffixed traversal check below can't false-negative on valid paths.
    const baseDir = pathMod.resolve(ctx.projectWorkdir || process.env.WORKDIR || pathMod.join(process.cwd(), 'workspace'));

    let subPath;
    if (data.startsWith('f:c:')) {
      // Cached path lookup for long paths
      const key = parseInt(data.split(':')[2], 10);
      subPath = ctx.filePathCache?.get(key) || '.';
    } else {
      subPath = data.substring(2) || '.'; // strip "f:" prefix
    }

    const targetDir = pathMod.resolve(baseDir, subPath);
    if (targetDir !== baseDir && !targetDir.startsWith(baseDir + pathMod.sep)) {
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
        await this._sendMessage(chatId, this._renderFileHtml(name, ext, sanitized, content.length));
        return; // Keep the file browser screen as is
      }

      // Directory listing
      const FILE_LIST_LIMIT = 20;
      const allEntries = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(d => !d.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      const items = allEntries.slice(0, FILE_LIST_LIMIT);
      const hiddenCount = allEntries.length - items.length;

      ctx.filePath = subPath;
      if (!ctx.filePathCache) ctx.filePathCache = new Map();
      // The cache maps short callback tokens to long paths. It only ever grew, so a
      // long browsing session leaked one entry per oversized path forever. Only the
      // CURRENT screen's buttons can be tapped, so anything older is dead weight —
      // drop it once it gets large rather than carrying it for the whole session.
      if (ctx.filePathCache.size > 500) ctx.filePathCache.clear();
      let cacheCounter = ctx.filePathCache.size;

      const keyboard = items.map(d => {
        const icon = d.isDirectory() ? '📁' : '📄';
        const rel = pathMod.join(subPath, d.name);
        let cbData;
        // Telegram's 64-byte callback_data limit is BYTES, not JS string length — a
        // non-ASCII path (Cyrillic, emoji in a filename) can be well under 61 chars
        // and still exceed 64 UTF-8 bytes, which Telegram then rejects outright
        // (BUTTON_DATA_INVALID), silently breaking the whole file listing screen.
        if (Buffer.byteLength(rel, 'utf8') <= 61) { // 64 - "f:" prefix - margin
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
        const parentCb = Buffer.byteLength(parent, 'utf8') <= 61 ? `f:${parent || '.'}` : (() => {
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
      // Say when the listing was cut. Silently showing 20 of 200 entries reads as
      // "this directory has 20 files", which is simply wrong information.
      const moreLine = hiddenCount > 0 ? `\n<i>+${hiddenCount} more not shown</i>` : '';
      const text = items.length > 0
        ? `${dirHeader}📂 <b>${this._escHtml(relDisplay)}</b>${moreLine}`
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
          SELECT title, status FROM tasks WHERE COALESCE(git_root, workdir) = ?
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
      // Guided forum onboarding flow (FORUM-05)
      return this._forum.startOnboarding(chatId, userId, editMsgId);

    } else if (data === 's:forum:off') {
      await this._forum.cmdForumDisconnect(chatId, userId);
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
    // A forum-topic message (message_thread_id set — never true for a private chat)
    // pending attachment belongs in the FORUM-scoped store, because that is what
    // _handleForumProjectMessage reads before sending the next text message. Storing
    // it on the direct-mode ctx instead — as this used to do unconditionally — meant
    // it was never picked up in the topic, and silently attached itself to whatever
    // the SAME user next typed in a private 1:1 chat with the bot instead.
    const threadId = msg.message_thread_id || null;
    const attachTarget = threadId != null ? this._forum._getForumContext(chatId, threadId, userId) : ctx;

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

      // If awaiting ask_user response, include attachment in the answer
      if (ctx.state === FSM_STATES.AWAITING_ASK_RESPONSE) {
        const requestId = ctx.stateData?.askRequestId;
        const origAskMsgId = ctx.stateData?.askMsgId;
        const origAskChatId = ctx.stateData?.askChatId;
        ctx.state = FSM_STATES.IDLE;
        ctx.stateData = null;

        // Save file to temp dir and include path in the answer text
        const _os = require('os');
        const _fs = require('fs');
        const _path = require('path');
        const tmpDir = _path.join(_os.tmpdir(), `claude-ask-${Date.now()}`);
        try { _fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = _path.join(tmpDir, safeName);
        try { _fs.writeFileSync(filePath, buffer); } catch {}

        const caption = msg.caption || '';
        const answerText = caption
          ? `${caption}\n\n[Attached file: ${fileName}]\nSaved at: ${filePath}\nRead this file to see its contents.`
          : `[Attached file: ${fileName}]\nSaved at: ${filePath}\nRead this file to see its contents.`;

        this.emit('ask_user_response', { requestId, answer: answerText });

        // Schedule temp dir cleanup (Claude needs time to read the file)
        setTimeout(() => {
          try { _fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        }, 120_000);

        await this._sendMessage(chatId, this._t('ask_answered'));

        if (origAskMsgId && origAskChatId) {
          this._callApi('editMessageText', {
            chat_id: origAskChatId,
            message_id: origAskMsgId,
            text: this._t('ask_answered'),
            parse_mode: 'HTML',
          }).catch(() => {});
        }
        return;
      }

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
          callback: (result) => {
            // server.js always resolves with { ok: true } on success and { error } on failure;
            // treating any truthy arg as an error made every successful upload show "❌".
            if (result?.error) this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(String(result.error)) }));
          }
        });
      } else if (ctx.state === FSM_STATES.COMPOSING && ctx.sessionId) {
        // In compose mode, attach to pending
        attachTarget.pendingAttachments = attachTarget.pendingAttachments || [];
        attachTarget.pendingAttachments.push(attachment);
        await this._sendMessage(chatId,
          this._t('attach_pending', { name: this._escHtml(fileName), size: Math.round(buffer.length / 1024) }),
          { parse_mode: 'HTML' }
        );
      } else if (ctx.sessionId) {
        // Has active session, store as pending
        attachTarget.pendingAttachments = attachTarget.pendingAttachments || [];
        attachTarget.pendingAttachments.push(attachment);
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
        attachTarget.pendingAttachments = attachTarget.pendingAttachments || [];
        attachTarget.pendingAttachments.push(attachment);
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

  async notifyTaskComplete({ sessionId, title, status, duration, error, botId }) {
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
        // Forum mode — a bot-owned task reports into that bot's own topic; everything
        // else goes to the shared Activity topic. Both fall back to the private chat.
        let forumOk = false;
        try {
          forumOk = await this._forum.notifyBotActivity(device.forum_chat_id, text, botId, sessionId);
        } catch (err) {
          this.log.warn(`[telegram] Forum bot-topic notify failed: ${err.message}`);
        }
        if (!forumOk) {
          try {
            forumOk = await this._forum.notifyActivity(device.forum_chat_id, text, sessionId);
          } catch (err) {
            this.log.warn(`[telegram] Forum activity notify failed: ${err.message}`);
          }
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
          // Forum Mode — send to Activity topic with project link. Skip when the ask
          // was ALREADY posted into a topic of this same forum: a second copy in the
          // Activity topic means two live keyboards for one requestId, and whichever
          // the user does not tap answers "no pending question" afterwards.
          if (String(device.forum_chat_id) === String(sourceChatId) && sourceThreadId) continue;
          const ok = await this._forum.notifyAskUser(device.forum_chat_id, text, session, rows);
          // The forum send can fail (topic deleted, bot demoted). Falling through to
          // the user's private chat keeps the question reachable — otherwise the run
          // just waits for an answer that can never arrive.
          if (ok === false && device.telegram_chat_id) {
            await this._sendMessage(device.telegram_chat_id, text, {
              parse_mode: 'HTML',
              reply_markup: JSON.stringify({ inline_keyboard: rows }),
            });
          }
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

  // ─── Stop / New Commands ────────────────────────────────────────────────

  async _cmdStop(chatId, userId) {
    const ctx = this._getContext(userId);
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };
    if (!ctx.sessionId) {
      return this._sendMessage(chatId, this._t('error_no_session'), navButtons);
    }

    this.emit('stop_task', { sessionId: ctx.sessionId, chatId, threadId: this._currentThreadId });
    await this._sendMessage(chatId, this._t('stop_sent'), navButtons);
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
              { text: this._t('fm_btn_full'), callback_data: 'cm:full' },
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

  /** HTML-escape for Telegram HTML parse mode */
  _escHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Cut a string to at most `limit` UTF-16 code units WITHOUT splitting a surrogate
  // pair. JS strings index by code unit, so a plain .slice/.substring can land
  // between the two halves of an astral character (emoji, many CJK extensions) and
  // emit a lone surrogate — which renders as "�" right at the seam of every
  // truncated message and chunk boundary.
  _safeCut(text, limit) {
    const s = String(text ?? '');
    if (s.length <= limit) return s;
    let end = limit;
    const code = s.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end--; // trailing high surrogate — drop it
    return s.substring(0, end);
  }

  // Repair improperly nested / unclosed inline tags so Telegram's parser accepts the
  // message. Markdown allows overlapping emphasis ("**bold _both** italic_"), which
  // converts to overlapping HTML (<b>..<i>..</b>..</i>) — Telegram rejects that
  // outright with "can't parse entities", and the send then retried with NO
  // parse_mode, dumping raw tags on screen. Re-nesting keeps the formatting intent:
  //   <b>a<i>b</b>c</i>  ->  <b>a<i>b</i></b><i>c</i>
  _balanceTags(html) {
    const s = String(html ?? '');
    if (!s.includes('<')) return s;
    const out = [];
    const stack = [];               // [{ name, open }] innermost last
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)>/g;
    let last = 0, m;
    while ((m = tagRe.exec(s)) !== null) {
      out.push(s.slice(last, m.index));
      last = tagRe.lastIndex;
      const [whole, closing, rawName] = m;
      const name = rawName.toLowerCase();
      if (!closing) {
        stack.push({ name, open: whole });
        out.push(whole);
        continue;
      }
      const at = stack.map(x => x.name).lastIndexOf(name);
      if (at === -1) continue;      // stray closer with no opener — drop it
      // Close everything opened after it, close it, then reopen those.
      const reopen = stack.splice(at + 1);
      for (let i = reopen.length - 1; i >= 0; i--) out.push(`</${reopen[i].name}>`);
      stack.pop();
      out.push(`</${name}>`);
      for (const t of reopen) { out.push(t.open); stack.push(t); }
    }
    out.push(s.slice(last));
    for (let i = stack.length - 1; i >= 0; i--) out.push(`</${stack[i].name}>`);
    return out.join('');
  }

  // Render a file as `📄 name` + a fenced <pre><code> block, truncating to fit
  // Telegram's message limit. Shared by /cat and the file-browser's "open file".
  // Two things a naive version gets wrong, both fixed here:
  //  - the truncation budget must be computed on the ESCAPED length, not the raw
  //    one — markup-heavy content ('<', '>', '&') expands 4-5x under HTML-escaping,
  //    so a raw-length gate routinely passed while the actual payload still
  //    exceeded the limit, causing a 400 and a fallback that showed literal tags;
  //  - the extension feeds a CSS/Prism class name, so it is restricted to
  //    [a-z0-9] rather than interpolated as-is from whatever the filename holds.
  _renderFileHtml(name, ext, sanitized, rawLength) {
    const safeExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'txt';
    const header = `📄 <b>${this._escHtml(name)}</b>\n\n`;
    const wrapperOverhead = `<pre><code class="language-${safeExt}"></code></pre>`.length;
    const escapedFull = this._escHtml(sanitized);
    const budget = MAX_MESSAGE_LENGTH - 200 - header.length - wrapperOverhead;

    if (escapedFull.length <= budget) {
      return `${header}<pre><code class="language-${safeExt}">${escapedFull}</code></pre>`;
    }
    // Binary-search the largest RAW prefix whose ESCAPED form still fits the
    // budget — escaping is not 1:1, so truncating the escaped string directly
    // risks cutting an entity like '&am' in half.
    let lo = 0, hi = sanitized.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._escHtml(sanitized.substring(0, mid)).length <= budget) lo = mid; else hi = mid - 1;
    }
    const truncated = this._escHtml(sanitized.substring(0, lo));
    return `${header}<pre><code class="language-${safeExt}">${truncated}</code></pre>\n\n${this._t('files_truncated', { len: rawLength })}`;
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
    // Function replacers, not string ones: agent-authored code content can itself
    // contain '$&', '$$', etc., which String.replace(needle, stringReplacement)
    // interprets as substitution patterns even for a plain-string needle — corrupting
    // the very code block it was meant to restore verbatim.
    for (let i = 0; i < codes.length; i++) {
      text = text.replace(`\x01C${i}\x01`, () => `<code>${codes[i]}</code>`);
    }

    // 5. Restore links
    for (let i = 0; i < links.length; i++) {
      const [lt, lu] = links[i];
      text = text.replace(`\x01L${i}\x01`, () => `<a href="${this._escHtml(lu)}">${this._escHtml(lt)}</a>`);
    }

    // 6. Restore header markers
    text = text.replace(/\x02B\x02/g, '<b>').replace(/\x02\/B\x02/g, '</b>');

    // 7. Repair overlapping/unclosed emphasis before it reaches Telegram's parser
    return this._balanceTags(text);
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
          // Code block too early — split at newline inside it. The chunk gets a
          // closing "\n```" appended, so the cut must leave room for it: appending
          // after cutting at the full limit produced a chunk of limit+4, i.e. the
          // function quietly broke its own contract (harmless only because callers
          // happen to pass limit = MAX_MESSAGE_LENGTH - 100).
          const FENCE_CLOSE = '\n```';
          const fenceWindow = str.slice(pos, pos + limit - FENCE_CLOSE.length);
          const nl = fenceWindow.lastIndexOf('\n');
          const langM = window.slice(lastOpen).match(/^```(\w*)/);
          const lang = langM ? langM[1] : '';

          if (nl > limit / 4) {
            let chunk = str.slice(pos, pos + nl).trimEnd();
            if (!chunk.endsWith('```')) chunk += FENCE_CLOSE;
            result.push(chunk);
            pos += nl + 1;
          } else {
            const cut = limit - FENCE_CLOSE.length;
            result.push(str.slice(pos, pos + cut).trimEnd() + FENCE_CLOSE);
            pos += cut;
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
    // Every caller passes text sliced to EXACTLY `limit` chars (a full window), so a
    // `<=` guard here made this an unconditional hard cut — the paragraph/sentence/
    // word-boundary search below never ran. `<` still short-circuits the case this
    // guard exists for (a genuinely shorter remainder needing no split at all).
    if (text.length < limit) return text.length;
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

    // Hard cut — but never between the halves of a surrogate pair, which would emit
    // a lone surrogate and render as "�" at the seam of the two chunks.
    const code = window.charCodeAt(limit - 1);
    if (code >= 0xD800 && code <= 0xDBFF) return limit - 1;
    return limit;
  }


  // ─── Public API (used by server.js) ──────────────────────────────────────

  createResponseHandler({ userId, chatId, sessionId, threadId, broadcastToSession }) {
    return new TelegramProxy(this, chatId, sessionId, userId, threadId, broadcastToSession);
  }

  sendMessage(chatId, text, options = {}) {
    return this._sendMessage(chatId, text, options);
  }

  getContext(userId) {
    return this._getContext(userId);
  }

  escHtml(text) {
    return this._escHtml(text);
  }

  t(key, params = {}) {
    return this._t(key, params);
  }
}

// ─── Telegram Proxy (duck-typed WsProxy for Telegram bot streaming) ──────────
class TelegramProxy {
  constructor(bot, chatId, sessionId, userId, threadId, broadcastToSession) {
    this._bot = bot;
    this._chatId = chatId;
    this._sessionId = sessionId;
    this._userId = userId;
    this._threadId = threadId || null;
    this._broadcastToSession = broadcastToSession || (() => {});
    this._buffer = '';
    this._lastAgent = null;   // who is currently speaking, for the per-bot header
    this._botsById = {};      // filled by the caller when a bot turn is dispatched
    this._progressMsgId = null;
    this._thinkingMsgId = null;
    this._updateTimer = null;
    this._lastEditAt = 0;
    this._toolsUsed = [];
    this._finished = false;
    this._sessionTitle = null; // cached session title for forum indicator
    this._draftId = (Date.now() % 2147483646) + 1; // non-zero int for sendMessageDraft
    this._usesDraftStreaming = true; // flips to false on first sendMessageDraft failure
    // Typing indicator — sends "typing..." action every 4s
    this._typingInterval = setInterval(() => {
      const params = { chat_id: this._chatId, action: 'typing' };
      if (this._threadId) params.message_thread_id = this._threadId;
      this._bot._callApi('sendChatAction', params).catch(() => {});
    }, 4000);
    // Safety net: auto-stop typing after 30 min to prevent interval leak if
    // neither _finalize nor _sendError are called (e.g. subprocess crash)
    this._typingSafetyTimer = setTimeout(() => this._stopTyping(), 30 * 60 * 1000);
    // Send initial typing action immediately
    const initParams = { chat_id: this._chatId, action: 'typing' };
    if (this._threadId) initParams.message_thread_id = this._threadId;
    this._bot._callApi('sendChatAction', initParams).catch(() => {});
  }

  _stopTyping() {
    if (this._typingInterval) {
      clearInterval(this._typingInterval);
      this._typingInterval = null;
    }
    if (this._typingSafetyTimer) {
      clearTimeout(this._typingSafetyTimer);
      this._typingSafetyTimer = null;
    }
  }

  /** Helper: send message with auto-injected thread_id for forum topics */
  async _tgSend(text, options = {}) {
    if (this._threadId && !options.message_thread_id) {
      options.message_thread_id = this._threadId;
    }
    try {
      return await this._bot._sendMessage(this._chatId, text, options);
    } catch (err) {
      // A forum topic can be deleted or closed while a run is still writing to it
      // (Telegram: "message thread not found" / topic-closed errors). Every send
      // used to retry into that SAME dead thread and fail again — the whole
      // response vanished, with "🤔 Processing…" left on screen forever and no
      // error shown, because the caller's OWN retry/fallback logic never got a
      // chance to run. Fall back once to the chat's main stream instead, so the
      // answer actually reaches the user.
      if (options.message_thread_id && /thread not found|topic_closed/i.test(err.message || '')) {
        this._bot._forum.forgetTopic(this._chatId, options.message_thread_id);
        const { message_thread_id, ...rest } = options;
        const note = rest.parse_mode === 'HTML'
          ? '⚠️ <i>(original topic is gone — sent here instead)</i>\n\n'
          : '⚠️ (original topic is gone — sent here instead)\n\n';
        return await this._bot._sendMessage(this._chatId, note + text, rest);
      }
      throw err;
    }
  }

  /** Send visible "Thinking..." indicator (both draft and legacy modes) */
  async startThinking() {
    try {
      const stopBtn = this._threadId
        ? [{ text: this._bot._t('fm_btn_stop') || '🛑 Stop', callback_data: 'cm:stop' }]
        : [
            { text: '🛑 Stop', callback_data: 'cm:stop' },
            { text: '🏠 Menu', callback_data: 'm:menu' },
          ];
      const thinkingMsg = await this._tgSend('🤔 <b>Processing your request...</b>', {
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({ inline_keyboard: [stopBtn] }),
      });
      if (thinkingMsg?.message_id) {
        this._thinkingMsgId = thinkingMsg.message_id;
        // In legacy (non-draft) mode, reuse as progress message
        if (!this._usesDraftStreaming) {
          this._progressMsgId = thinkingMsg.message_id;
        }
      }
    } catch {
      // Non-critical — don't block Claude processing if indicator fails
    }
  }

  send(raw) {
    try {
      const data = JSON.parse(raw);
      // Also broadcast to web UI watchers
      this._broadcastToSession(this._sessionId, data);

      if (data.type === 'text') {
        // Several bots can answer in one turn. Without a header their replies run
        // together into one wall of text and the reader cannot tell who said what —
        // the same problem the web chat had before each bot got its own bubble.
        // Telegram has no bubbles, so the boundary is a line of text.
        if (data.agent && data.agent !== this._lastAgent) {
          const b = this._botsById?.[data.agent];
          const name = b ? `${b.avatar || '🤖'} ${b.label}` : `🤖 @@${data.agent}`;
          this._buffer += `${this._buffer ? '\n\n' : ''}${name}:\n`;
          this._lastAgent = data.agent;
        }
        this._buffer += (data.text || '');
        this._scheduleUpdate();
      } else if (data.type === 'tool_use' || data.type === 'tool') {
        this._toolsUsed.push(data.tool || data.tool_name || 'tool');
      } else if (data.type === 'done') {
        // Not awaited (send() is synchronous), so attach a .catch — an unhandled
        // rejection here used to vanish into process.on('unhandledRejection')
        // (server.js) with nothing telling the user their answer never arrived.
        this._finalize(data).catch(err => this._bot.log.error(`[telegram] _finalize failed: ${err.message}`));
      } else if (data.type === 'error') {
        this._lastError = data.error || 'Unknown error';
        if (!this._buffer.trim()) {
          this._sendError(data).catch(err => this._bot.log.error(`[telegram] _sendError failed: ${err.message}`));
        } else {
          // Partial output was already streamed when the run errored. Previously ANY
          // buffered text suppressed _sendError entirely, and since nothing else marks
          // `_finished`, the run stayed "in progress" forever: the partial answer was
          // never sent, and the typing indicator kept spinning until the 30-minute
          // safety timer. Deliver what was produced, flagged as partial, instead.
          this._finalize(data, this._lastError).catch(err => this._bot.log.error(`[telegram] _finalize failed: ${err.message}`));
        }
      } else if (data.type === 'ask_user') {
        this._handleAskUser(data);
      } else if (data.type === 'ask_user_timeout') {
        this._handleAskUserDismiss(this._bot._t('ask_timeout'));
      } else if (data.type === 'notification') {
        this._handleNotification(data);
      }
    } catch (e) {
      console.error('[TelegramProxy] parse error:', e.message);
    }
  }

  // ─── ask_user: Forward Claude's question to Telegram user ────────────────
  async _handleAskUser(data) {
    // Pause progress updates while waiting for user input
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }
    this._stopTyping();

    const questions = (Array.isArray(data.questions) && data.questions.length) ? data.questions : [{ question: data.question || '?' }];
    const q = questions[0];
    const questionText = q.question || data.question || '?';

    // Store pending state on the bot's user context
    if (this._userId) {
      const ctx = this._bot._getContext(this._userId);
      ctx.state = 'AWAITING_ASK_RESPONSE';
      ctx.stateData = { askRequestId: data.requestId, askQuestions: questions };
    }

    // Build message text (i18n-aware)
    const t = (k, v) => this._bot._t(k, v);
    let text = `❓ <b>${t('ask_title')}</b>\n\n${this._bot._escHtml(questionText)}`;

    // Build inline keyboard
    const skipLabel = t('ask_skip_btn');
    let replyMarkup;
    if (q.options && q.options.length > 0) {
      // Options mode: show buttons (truncate label to 64 chars for Telegram display)
      const rows = q.options.map((opt, i) => ([{
        text: (typeof opt === 'string' ? opt : (opt.label || opt.value || `Option ${i + 1}`)).substring(0, 64),
        callback_data: `ask:${i}`
      }]));
      rows.push([{ text: skipLabel, callback_data: 'ask:skip' }]);
      replyMarkup = JSON.stringify({ inline_keyboard: rows });
      text += `\n\n<i>${t('ask_choose_hint')}</i>`;
    } else {
      // Free text mode: prompt user to type
      replyMarkup = JSON.stringify({
        inline_keyboard: [[{ text: skipLabel, callback_data: 'ask:skip' }]]
      });
      text += `\n\n<i>${t('ask_text_hint')}</i>`;
    }

    // Delete thinking/progress message if exists (show clean question)
    if (this._thinkingMsgId && this._thinkingMsgId !== this._progressMsgId) {
      try { await this._bot._callApi('deleteMessage', { chat_id: this._chatId, message_id: this._thinkingMsgId }); } catch {}
      this._thinkingMsgId = null;
    }
    if (this._progressMsgId) {
      try {
        await this._bot._callApi('deleteMessage', { chat_id: this._chatId, message_id: this._progressMsgId });
      } catch {}
      this._progressMsgId = null;
    }

    let askMsg;
    try {
      askMsg = await this._tgSend( text, { parse_mode: 'HTML', reply_markup: replyMarkup });
    } catch {
      // Fallback without HTML
      askMsg = await this._tgSend( text.replace(/<[^>]+>/g, ''), { reply_markup: replyMarkup }).catch(() => null);
    }

    // Store original ask message location for cross-context cleanup
    if (askMsg?.message_id && this._userId) {
      const ctx = this._bot._getContext(this._userId);
      if (ctx.stateData) {
        ctx.stateData.askMsgId = askMsg.message_id;
        ctx.stateData.askChatId = this._chatId;
        ctx.stateData.askThreadId = this._threadId || null;
      }
    }

    // Notify other devices/contexts about the pending question
    this._bot.notifyAskUser({
      userId: this._userId,
      sessionId: this._sessionId,
      sourceChatId: this._chatId,
      sourceThreadId: this._threadId,
      questionText,
      questions,
    }).catch(err => {
      this._bot.log.warn(`[telegram] Ask notification dispatch failed: ${err.message}`);
    });
  }

  // Dismiss ask_user UI (timeout or answered elsewhere)
  async _handleAskUserDismiss(reason) {
    if (this._userId) {
      const ctx = this._bot._getContext(this._userId);
      if (ctx.state === 'AWAITING_ASK_RESPONSE') {
        ctx.state = 'IDLE';
        ctx.stateData = null;
      }
    }
    await this._tgSend( reason).catch(() => {});
    // Resume typing indicator (guard against double-start)
    if (!this._finished && !this._typingInterval) {
      this._typingInterval = setInterval(() => {
        this._bot._callApi('sendChatAction', { chat_id: this._chatId, action: 'typing' }).catch(() => {});
      }, 4000);
    }
  }

  // ─── Notifications: Forward to Telegram ──────────────────────────────────
  async _handleNotification(data) {
    const icons = { info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅' };
    const icon = icons[data.level] || 'ℹ️';
    const detail = data.detail ? `\n${this._bot._escHtml(data.detail)}` : '';
    const progress = data.progress ? ` (${data.progress.current}/${data.progress.total})` : '';
    const text = `${icon} ${this._bot._escHtml(data.title)}${progress}${detail}`;
    await this._tgSend( text, { parse_mode: 'HTML' }).catch(() => {});
  }

  _scheduleUpdate() {
    if (this._finished) return;
    if (this._updateTimer) return;
    const elapsed = Date.now() - this._lastEditAt;
    const baseDelay = this._usesDraftStreaming ? 500 : 3000;
    const delay = Math.max(baseDelay - elapsed, 200);
    this._updateTimer = setTimeout(() => this._sendProgress(), delay);
  }

  async _sendProgress() {
    this._updateTimer = null;
    if (this._finished) return;
    this._lastEditAt = Date.now();

    // Delete "Thinking..." indicator on first actual content (draft streaming mode)
    if (this._thinkingMsgId && this._usesDraftStreaming && this._buffer.trim()) {
      try {
        await this._bot._callApi('deleteMessage', { chat_id: this._chatId, message_id: this._thinkingMsgId });
      } catch {}
      this._thinkingMsgId = null;
    }

    let preview = this._buffer;
    if (preview.length > 3500) {
      preview = '...\n' + preview.slice(-3500);
    }

    // ── Draft streaming path (sendMessageDraft — no rate limit) ──────────
    if (this._usesDraftStreaming) {
      try {
        const text = this._bot._safeCut(preview || ' ', 4096); // plain text only, no parse_mode
        const params = {
          chat_id: this._chatId,
          draft_id: this._draftId,
          text: text,
        };
        if (this._threadId) params.message_thread_id = this._threadId;
        await this._bot._callApi('sendMessageDraft', params);
        return;
      } catch (err) {
        // First failure: fall back permanently to editMessageText for this proxy instance
        this._usesDraftStreaming = false;
        this._bot.log.warn(`[TelegramProxy] sendMessageDraft failed, falling back to editMessageText: ${err.message}`);
        // Fall through to legacy path below
      }
    }

    // ── Legacy editMessageText path (fallback) ──────────────────────────
    preview = this._bot._escHtml(preview);

    const toolLine = this._toolsUsed.length
      ? `\n🔧 ${this._bot._escHtml(this._toolsUsed.slice(-3).join(', '))}`
      : '';

    // Session indicator — cache title on first use
    let sessionTag = '';
    if (this._sessionId) {
      if (this._sessionTitle === null) {
        try {
          const sess = this._bot.db.prepare('SELECT title FROM sessions WHERE id = ?').get(this._sessionId);
          this._sessionTitle = sess?.title || '';
        } catch { this._sessionTitle = ''; }
      }
      if (this._sessionTitle) {
        sessionTag = ` · <i>${this._bot._escHtml(this._sessionTitle.substring(0, 30))}</i>`;
      }
    }

    const text = `⏳ <b>Processing...</b>${sessionTag}${toolLine}\n\n${preview}`;

    // Inline stop button on progress messages so the user always has controls at the bottom
    const progressButtons = this._threadId
      ? [{ text: this._bot._t('fm_btn_stop'), callback_data: 'cm:stop' }]
      : [
          { text: '🛑 Stop', callback_data: 'cm:stop' },
          { text: '🏠 Menu', callback_data: 'm:menu' },
        ];
    const progressMarkup = JSON.stringify({ inline_keyboard: [progressButtons] });

    try {
      if (this._progressMsgId) {
        await this._bot._callApi('editMessageText', {
          chat_id: this._chatId,
          message_id: this._progressMsgId,
          text: this._bot._safeCut(text, 4096),
          parse_mode: 'HTML',
          reply_markup: progressMarkup,
        }).catch(() => {
          return this._bot._callApi('editMessageText', {
            chat_id: this._chatId,
            message_id: this._progressMsgId,
            text: this._bot._safeCut(text.replace(/<[^>]+>/g, ''), 4096),
            reply_markup: progressMarkup,
          });
        });
      } else {
        const result = await this._tgSend( this._bot._safeCut(text, 4096), { parse_mode: 'HTML', reply_markup: progressMarkup });
        if (result && result.message_id) {
          this._progressMsgId = result.message_id;
        }
      }
    } catch (e) {
      if (e.message && e.message.includes('429')) {
        this._updateTimer = setTimeout(() => this._sendProgress(), 6000);
      }
    }
  }

  async _finalize(data, errorMsg = null) {
    if (this._finished) return; // already finalized or errored
    this._finished = true;
    this._stopTyping();
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }

    // Delete thinking indicator if still visible (draft streaming mode)
    if (this._thinkingMsgId && this._thinkingMsgId !== this._progressMsgId) {
      try { await this._bot._callApi('deleteMessage', { chat_id: this._chatId, message_id: this._thinkingMsgId }); } catch {}
      this._thinkingMsgId = null;
    }
    // Delete progress message if exists (legacy mode sends a "Thinking..." message)
    if (this._progressMsgId) {
      try {
        await this._bot._callApi('deleteMessage', {
          chat_id: this._chatId,
          message_id: this._progressMsgId
        });
      } catch (e) { /* ignore */ }
      this._progressMsgId = null;
    }
    // Note: if using draft streaming, the draft auto-disappears when sendMessage is called below.
    // No explicit draft cleanup needed — sendMessageDraft drafts vanish on first sendMessage to the same chat.

    // Send final response — collapse large messages with preview + "Show full" button
    const rawLen = this._buffer.trim().length;
    const isLarge = rawLen > TG_COLLAPSE_THRESHOLD;

    if (rawLen > 0) {
      if (!isLarge) {
        // Short response — send in full. Chunk the RAW Markdown (fence-aware), then
        // convert each chunk to HTML — converting first and chunking the HTML risked
        // splitting mid-<pre>/<code>/<a href="...">, which Telegram rejects outright;
        // the fallback below then stripped ALL formatting instead of just fixing the
        // one broken chunk, so a code-bearing answer routinely arrived as literal tags.
        const chunks = this._bot._chunkForTelegram(this._buffer, MAX_MESSAGE_LENGTH - 100)
          .map(c => this._bot._mdToHtml(c));
        for (const chunk of chunks) {
          await this._tgSend(chunk, { parse_mode: 'HTML' }).catch(() => {
            return this._tgSend(chunk.replace(/<[^>]+>/g, ''));
          });
        }
      } else {
        // Large response — send preview only, full available via button
        const previewRaw = this._bot._safeCut(this._buffer, TG_PREVIEW_LENGTH);
        // Truncate at last newline to avoid broken lines/fences
        const lastNl = previewRaw.lastIndexOf('\n');
        const cleanPreview = lastNl > TG_PREVIEW_LENGTH / 2 ? previewRaw.substring(0, lastNl) : previewRaw;
        const previewHtml = this._bot._mdToHtml(cleanPreview);
        const totalChars = rawLen > 1000 ? `${Math.round(rawLen / 1000)}k` : rawLen;
        const moreIndicator = `\n\n<i>···  ${totalChars} chars — tap 📄 to expand  ···</i>`;
        await this._tgSend(previewHtml + moreIndicator, { parse_mode: 'HTML' }).catch(() => {
          return this._tgSend((cleanPreview + `\n\n···  ${totalChars} chars — tap 📄 to expand  ···`).replace(/<[^>]+>/g, ''));
        });
      }
    }

    // Send completion notification with buttons — an error note instead of the normal
    // "Done" summary when this finalize was triggered by a mid-run error with output
    // already buffered (see the `error` branch in send()).
    const duration = data.duration ? ` (${Math.round(data.duration / 1000)}s)` : '';
    const toolsSummary = this._toolsUsed.length ? `\n🔧 Tools: ${this._bot._escHtml([...new Set(this._toolsUsed)].join(', '))}` : '';

    // Session indicator
    let sessionLine = '';
    if (this._sessionId) {
      try {
        const sess = this._bot.db.prepare('SELECT title FROM sessions WHERE id = ?').get(this._sessionId);
        if (sess?.title) {
          sessionLine = `\n💬 ${this._bot._escHtml(sess.title.substring(0, 40))}`;
        }
      } catch {}
    }

    const doneButtons = this._threadId
      ? [
          // Row 1: primary actions — continue working, view full response
          [
            { text: this._bot._t('fm_btn_continue'), callback_data: 'fm:compose' },
            ...(isLarge ? [{ text: this._bot._t('fm_btn_full'), callback_data: 'cm:full' }] : []),
            { text: this._bot._t('fm_btn_diff'), callback_data: 'fm:diff' },
          ],
          // Row 2: navigation — files, history, new session
          [
            { text: this._bot._t('fm_btn_files'), callback_data: 'fm:files' },
            { text: this._bot._t('fm_btn_history'), callback_data: 'fm:history' },
            { text: this._bot._t('fm_btn_new'), callback_data: 'fm:new' },
          ],
        ]
      : [
          [
            { text: '💬 Continue', callback_data: 'cm:compose' },
            ...(isLarge ? [{ text: '📄 Full', callback_data: 'cm:full' }] : []),
            { text: '🏠 Menu', callback_data: 'm:menu' },
          ],
        ];
    const summary = errorMsg
      ? `⚠️ <b>Partial response — stopped on error:</b> ${this._bot._escHtml(errorMsg)}${sessionLine}${toolsSummary}`
      : `✅ <b>Done</b>${duration}${sessionLine}${toolsSummary}`;
    await this._tgSend(
      summary,
      {
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({ inline_keyboard: doneButtons })
      }
    );
  }

  async _sendError(data) {
    if (this._finished) return; // already finalized or errored
    this._finished = true;
    this._stopTyping();
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }

    // Delete thinking indicator if still visible
    if (this._thinkingMsgId && this._thinkingMsgId !== this._progressMsgId) {
      try { await this._bot._callApi('deleteMessage', { chat_id: this._chatId, message_id: this._thinkingMsgId }); } catch {}
      this._thinkingMsgId = null;
    }
    if (this._progressMsgId) {
      try {
        await this._bot._callApi('deleteMessage', {
          chat_id: this._chatId,
          message_id: this._progressMsgId
        });
      } catch (e) { /* ignore */ }
    }

    const errorButtons = this._threadId
      ? [
          [
            { text: this._bot._t('fm_btn_retry'), callback_data: 'fm:retry' },
            { text: this._bot._t('fm_btn_continue'), callback_data: 'fm:compose' },
          ],
          [
            { text: this._bot._t('fm_btn_history'), callback_data: 'fm:history' },
            { text: this._bot._t('fm_btn_help'), callback_data: 'fm:help' },
          ],
        ]
      : [
          [
            { text: '🔄 Retry', callback_data: 'cm:compose' },
            { text: '🏠 Menu', callback_data: 'm:menu' },
          ],
        ];
    await this._tgSend(
      `❌ <b>Error:</b> ${this._bot._escHtml(data.error || 'Unknown error')}`,
      {
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({ inline_keyboard: errorButtons })
      }
    );
  }

  get readyState() { return 1; } // WebSocket.OPEN
}

module.exports = TelegramBot;
module.exports.FSM_STATES = FSM_STATES;
module.exports.SCREENS = SCREENS;
module.exports.CALLBACK_TO_SCREEN = CALLBACK_TO_SCREEN;
