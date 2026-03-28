// ─── Telegram Bot Forum Module ───────────────────────────────────────────────
// Extracted from telegram-bot.js — handles all Forum Mode (supergroup) logic.
// Uses composition pattern: receives an API facade, NOT the bot instance.
// State scoped to (chatId, threadId, userId) — never touches Direct Mode context.
'use strict';

class TelegramBotForum {
  /**
   * @param {Object} api - Facade object from TelegramBot
   * @param {import('better-sqlite3').Database} api.db
   * @param {Object} api.log
   * @param {Function} api.callApi - Telegram API call
   * @param {Function} api.sendMessage - Send message with HTML, auto-retry
   * @param {Function} api.editScreen - Edit inline screen
   * @param {Function} api.showScreen - Send new screen
   * @param {Function} api.t - i18n translation
   * @param {Function} api.escHtml - HTML escape
   * @param {Function} api.sanitize - Content sanitization
   * @param {Function} api.mdToHtml - Markdown to HTML
   * @param {Function} api.chunkForTelegram - Message chunking
   * @param {Function} api.timeAgo - Time formatting
   * @param {Object} api.stmts - Prepared SQL statements
   * @param {Function} api.emit - EventEmitter emit (for send_message, stop_task)
   * @param {Function} api.getDirectContext - Get direct mode ctx (for shared commands)
   * @param {Function} api.saveDeviceContext - Persist ctx to SQLite
   * @param {Function} api.botId - Returns bot's own user ID
   * @param {Function} api.cmdStatus - Shared /status command
   * @param {Function} api.cmdFiles - Shared /files command
   * @param {Function} api.cmdCat - Shared /cat command
   * @param {Function} api.cmdLast - Shared /last command
   * @param {Function} api.cmdFull - Shared /full command
   * @param {Function} api.cmdDiff - Shared /diff command
   * @param {Function} api.cmdLog - Shared /log command
   * @param {Function} api.cmdStop - Shared /stop command
   * @param {Function} api.handleMediaMessage - Shared media handler
   */
  constructor(api) {
    this._api = api;
    this._forumTopics = new Map();   // chatId:threadId -> { type, workdir, chatId }
    this._forumContext = new Map();   // chatId:threadId:userId -> forum-scoped state
    this._loadTopicsFromDb();
  }

  // ─── Forum-Scoped State (FORUM-02 fix) ──────────────────────────────────

  /**
   * Get forum-scoped context for a specific topic + user.
   * Uses composite key chatId:threadId:userId to isolate state from Direct Mode.
   */
  _getForumContext(chatId, threadId, userId) {
    const key = `${chatId}:${threadId}:${userId}`;
    if (!this._forumContext.has(key)) {
      this._forumContext.set(key, {
        sessionId: null,
        projectWorkdir: null,
        pendingAttachments: [],
        isStreaming: false,
        streamMsgId: null,
      });
    }
    return this._forumContext.get(key);
  }

  // ─── Topic Cache ────────────────────────────────────────────────────────

  _loadTopicsFromDb() {
    try {
      const rows = this._api.stmts.getForumTopics
        ? this._api.db.prepare('SELECT * FROM forum_topics').all()
        : [];
      for (const row of rows) {
        const key = `${row.chat_id}:${row.thread_id}`;
        this._forumTopics.set(key, {
          type: row.type,
          workdir: row.workdir,
          chatId: row.chat_id,
        });
      }
    } catch (err) {
      this._api.log.warn(`[forum] Failed to load topics cache: ${err.message}`);
    }
  }

  /**
   * Get topic info by threadId (from cache or DB).
   * Public accessor — called by parent bot for topic guard.
   */
  getTopicInfo(chatId, threadId) {
    const key = `${chatId}:${threadId}`;
    if (this._forumTopics.has(key)) return this._forumTopics.get(key);

    const row = this._api.stmts.getForumTopic.get(threadId, chatId);
    if (row) {
      const info = { type: row.type, workdir: row.workdir, chatId };
      this._forumTopics.set(key, info);
      return info;
    }
    return null;
  }

  /**
   * Generate a deep link URL to a specific forum topic.
   * Format: https://t.me/c/{internal_id}/{thread_id}
   */
  _topicLink(chatId, threadId) {
    const idStr = String(chatId);
    const internalId = idStr.startsWith('-100') ? idStr.slice(4) : idStr.replace('-', '');
    return `https://t.me/c/${internalId}/${threadId}`;
  }

  // ─── Public Entry Points ───────────────────────────────────────────────

  /**
   * Main handler for messages in a forum supergroup.
   * Routes based on which topic the message is in.
   * Called from TelegramBot._handleUpdate.
   */
  async handleMessage(msg, threadId) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text || '').trim();

    // General topic (no thread_id) — handle basic commands
    if (!threadId) {
      if (text.startsWith('/')) return this._handleForumGeneralCommand(msg);
      return;
    }

    const topicInfo = this.getTopicInfo(chatId, threadId);
    if (!topicInfo) {
      // Unknown topic — either user-created or the General topic
      if (text.startsWith('/')) return this._handleForumGeneralCommand(msg);
      if (text) await this._api.sendMessage(chatId, this._api.t('forum_unknown_topic'));
      return;
    }

    switch (topicInfo.type) {
      case 'project':
        return this._handleForumProjectMessage(msg, topicInfo.workdir, threadId);
      case 'tasks':
        return this._handleForumTaskMessage(msg, threadId);
      case 'activity':
        if ((msg.text || '').trim()) {
          await this._api.sendMessage(chatId, this._api.t('forum_activity_readonly'));
        }
        return;
      default:
        return;
    }
  }

  /**
   * Callback entry point — routes fs:/fm:/fa: callbacks.
   * Called from TelegramBot._handleCallback.
   */
  async handleCallback(chatId, userId, data, threadId, msgId) {
    // Route by prefix — check ft: and fo: before f: to avoid prefix collision (Pitfall 3)
    if (data.startsWith('ft:')) return this.handleTaskCallback(chatId, userId, data, threadId);
    if (data.startsWith('fo:')) return this.handleOnboardingCallback(chatId, userId, data, msgId);
    if (data.startsWith('fs:')) return this.handleSessionCallback(chatId, userId, data, threadId);
    if (data.startsWith('fm:')) return this.handleActionCallback(chatId, userId, data, threadId);
    if (data.startsWith('fa:')) return this.handleActivityCallback(chatId, userId, data, threadId);
  }

  /**
   * /connect command in a supergroup — pair the forum group.
   */
  async handleConnect(msg) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    // Must be a supergroup with Topics enabled
    if (msg.chat.type !== 'supergroup' || !msg.chat.is_forum) {
      return this._api.sendMessage(chatId, this._api.t('forum_not_supergroup'));
    }

    // User must already be paired via private chat
    const device = this._api.stmts.getDevice.get(userId);
    if (!device) {
      return this._api.sendMessage(chatId, this._api.t('forum_not_paired'));
    }

    // Check bot has manage_topics permission
    try {
      const botMember = await this._api.callApi('getChatMember', { chat_id: chatId, user_id: this._api.botId() });
      const canManage = botMember?.can_manage_topics || botMember?.status === 'creator';
      if (!canManage) {
        return this._api.sendMessage(chatId, this._api.t('forum_not_admin'));
      }
    } catch {
      return this._api.sendMessage(chatId, this._api.t('forum_not_admin'));
    }

    // Save forum_chat_id (or keep existing)
    const alreadyConnected = device?.forum_chat_id === chatId;
    if (!alreadyConnected) {
      this._api.stmts.setForumChatId.run(chatId, userId);
    }

    // Send status message BEFORE the actual creation
    await this._api.sendMessage(chatId, this._api.t(alreadyConnected ? 'forum_syncing' : 'forum_connected'));

    try {
      await this._createForumStructure(chatId);
      // Set forum-scoped commands (FORUM-07) — show only relevant commands in supergroup
      await this._setForumCommands(chatId);
    } catch (err) {
      if (!alreadyConnected) {
        this._api.stmts.setForumChatId.run(null, userId);
      }
      this._api.log.error(`[forum] Connect failed: ${err.message}`);
      await this._api.sendMessage(chatId, this._api.t('forum_not_admin'));
    }
  }

  /**
   * /forum command in private chat — show setup instructions.
   */
  async cmdForum(chatId, userId) {
    const device = this._api.stmts.getDevice.get(userId);
    const navButtons = { reply_markup: JSON.stringify({ inline_keyboard: [
      [{ text: this._api.t('btn_back_menu'), callback_data: 'm:menu' }],
    ] }) };
    if (device?.forum_chat_id) {
      return this._api.sendMessage(chatId, this._api.t('forum_already'), navButtons);
    }
    await this._api.sendMessage(chatId, this._api.t('forum_instructions'), navButtons);
  }

  /**
   * Disconnect forum — remove pairing, clean up DB + cache.
   */
  async cmdForumDisconnect(chatId, userId) {
    const device = this._api.stmts.getDevice.get(userId);
    const forumChatId = device?.forum_chat_id;

    // Clear forum_chat_id from device
    this._api.stmts.setForumChatId.run(null, userId);

    // Clean up forum_topics in DB and _forumTopics cache
    if (forumChatId) {
      this._api.stmts.deleteForumTopicsByChatId.run(forumChatId);
      for (const key of this._forumTopics.keys()) {
        if (key.startsWith(`${forumChatId}:`)) this._forumTopics.delete(key);
      }
    }

    await this._api.sendMessage(chatId, this._api.t('forum_disconnected'));
  }

  /**
   * Create a single project topic in the forum.
   * Public — called by parent bot for auto-create from activity callback.
   */
  async createProjectTopic(chatId, workdir, displayName) {
    const name = displayName || workdir.split('/').filter(Boolean).pop() || workdir;
    try {
      const topic = await this._api.callApi('createForumTopic', {
        chat_id: chatId,
        name: `📁 ${name}`,
      });

      this._api.stmts.addForumTopic.run(topic.message_thread_id, chatId, 'project', workdir);
      this._forumTopics.set(`${chatId}:${topic.message_thread_id}`, { type: 'project', workdir, chatId });

      // Pin project info (pass thread_id explicitly)
      const pinMsg = await this._api.sendMessage(chatId, this._api.t('forum_topic_project', {
        name: this._api.escHtml(name),
        path: this._api.escHtml(workdir),
      }), {
        message_thread_id: topic.message_thread_id,
        reply_markup: JSON.stringify({ inline_keyboard: [[
          { text: this._api.t('fm_btn_history'), callback_data: 'fm:history' },
          { text: this._api.t('fm_btn_new'), callback_data: 'fm:new' },
          { text: this._api.t('fm_btn_info'), callback_data: 'fm:info' },
        ]] }),
      });
      if (pinMsg) {
        this._api.callApi('pinChatMessage', { chat_id: chatId, message_id: pinMsg.message_id, disable_notification: true }).catch(() => {});
      }

      return topic.message_thread_id;
    } catch (err) {
      this._api.log.error(`[forum] Failed to create project topic for ${name}: ${err.message}`);
      return null;
    }
  }

  /**
   * Send a notification to the Activity topic in the forum.
   */
  async notifyActivity(forumChatId, text, sessionId) {
    const topics = this._api.stmts.getForumTopics.all(forumChatId);
    const activityTopic = topics.find(t => t.type === 'activity');
    if (!activityTopic) return false;

    // Build action buttons — find project topic for this session
    const options = { message_thread_id: activityTopic.thread_id, parse_mode: 'HTML' };

    if (sessionId) {
      const session = this._api.db.prepare('SELECT workdir FROM sessions WHERE id = ?').get(sessionId);
      if (session?.workdir) {
        const projectTopic = topics.find(t => t.type === 'project' && t.workdir === session.workdir);
        const urlRow = [];

        // Use URL buttons for cross-topic navigation
        if (projectTopic) {
          const topicUrl = this._topicLink(forumChatId, projectTopic.thread_id);
          urlRow.push({ text: this._api.t('fm_btn_open_chat'), url: topicUrl });
        } else {
          // Fallback: callback button to auto-create project topic + show preview
          urlRow.push({ text: this._api.t('fm_btn_open_chat'), callback_data: `fa:open:${sessionId}` });
        }

        // Action buttons row — Continue session or start New session
        const actionRow = [
          { text: this._api.t('fm_btn_continue'), callback_data: `fa:continue:${sessionId}` },
          { text: this._api.t('fm_btn_new'), callback_data: `fa:new:${session.workdir}` },
        ];

        options.reply_markup = JSON.stringify({ inline_keyboard: [urlRow, actionRow] });
      }
    }

    await this._api.sendMessage(forumChatId, text, options);
    return true;
  }

  /**
   * Send ask_user notification to Forum Activity topic with project link.
   */
  async notifyAskUser(forumChatId, text, session, answerRows) {
    const topics = this._api.stmts.getForumTopics.all(forumChatId);
    const activityTopic = topics.find(t => t.type === 'activity');
    if (!activityTopic) return;

    // Clone rows and add "Go to chat" URL button if project topic exists
    const rows = answerRows.map(r => [...r]);
    if (session?.workdir) {
      const projectTopic = topics.find(t => t.type === 'project' && t.workdir === session.workdir);
      if (projectTopic) {
        const topicUrl = this._topicLink(forumChatId, projectTopic.thread_id);
        rows.push([{ text: this._api.t('ask_notify_go_to_chat'), url: topicUrl }]);
      }
    }

    await this._api.sendMessage(forumChatId, text, {
      message_thread_id: activityTopic.thread_id,
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({ inline_keyboard: rows }),
    });
  }

  // ─── Forum-Scoped Commands (FORUM-07) ──────────────────────────────────

  /**
   * Set forum-scoped bot commands via setMyCommands.
   * Shows only forum-relevant commands when in the supergroup.
   */
  async _setForumCommands(chatId) {
    try {
      await this._api.callApi('setMyCommands', {
        commands: JSON.stringify([
          { command: 'help', description: this._api.t('fm_cmd_help_desc') },
          { command: 'status', description: this._api.t('fm_cmd_status_desc') },
          { command: 'new', description: this._api.t('fm_cmd_new_desc') },
          { command: 'stop', description: this._api.t('fm_cmd_stop_desc') },
        ]),
        scope: JSON.stringify({ type: 'chat', chat_id: chatId }),
      });
    } catch (err) {
      this._api.log.warn(`[forum] Failed to set forum commands: ${err.message}`);
    }
  }

  // ─── Internal Methods ──────────────────────────────────────────────────

  /**
   * Create the initial forum structure: Tasks + Activity topics.
   * Project topics are created on demand.
   */
  async _createForumStructure(chatId) {
    try {
      // Check if topics already exist
      const existing = this._api.stmts.getForumTopics.all(chatId);
      const hasTasksTopic = existing.some(t => t.type === 'tasks');
      const hasActivityTopic = existing.some(t => t.type === 'activity');

      if (!hasTasksTopic) {
        this._api.log.info(`[forum] Creating Tasks topic in forum ${chatId}`);
        const tasksTopic = await this._api.callApi('createForumTopic', {
          chat_id: chatId,
          name: '📋 Tasks',
        });
        this._api.log.info(`[forum] Tasks topic created: thread_id=${tasksTopic.message_thread_id}`);
        this._api.stmts.addForumTopic.run(tasksTopic.message_thread_id, chatId, 'tasks', null);
        this._forumTopics.set(`${chatId}:${tasksTopic.message_thread_id}`, { type: 'tasks', workdir: null, chatId });

        // Pin instructions in Tasks topic
        const pinMsg = await this._api.sendMessage(chatId, this._api.t('forum_topic_tasks'), {
          message_thread_id: tasksTopic.message_thread_id,
        });
        if (pinMsg) {
          this._api.callApi('pinChatMessage', { chat_id: chatId, message_id: pinMsg.message_id, disable_notification: true }).catch(() => {});
        }
      }

      if (!hasActivityTopic) {
        this._api.log.info(`[forum] Creating Activity topic in forum ${chatId}`);
        const activityTopic = await this._api.callApi('createForumTopic', {
          chat_id: chatId,
          name: '🔔 Activity',
        });
        this._api.log.info(`[forum] Activity topic created: thread_id=${activityTopic.message_thread_id}`);
        this._api.stmts.addForumTopic.run(activityTopic.message_thread_id, chatId, 'activity', null);
        this._forumTopics.set(`${chatId}:${activityTopic.message_thread_id}`, { type: 'activity', workdir: null, chatId });

        // Pin instructions in Activity topic
        const pinMsg = await this._api.sendMessage(chatId, this._api.t('forum_topic_activity'), {
          message_thread_id: activityTopic.message_thread_id,
        });
        if (pinMsg) {
          this._api.callApi('pinChatMessage', { chat_id: chatId, message_id: pinMsg.message_id, disable_notification: true }).catch(() => {});
        }
      }

      // Notify in General topic (no thread_id — goes to General)
      this._api.log.info(`[forum] Forum structure created, sending confirmation`);
      await this._api.sendMessage(chatId, this._api.t('forum_created_topics'));

      // Create topics for existing projects
      await this._syncProjectTopics(chatId);
    } catch (err) {
      this._api.log.error(`[forum] Failed to create forum structure: ${err.message}`);
      throw err; // Re-throw so handleConnect can rollback
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

        const existing = this._api.stmts.getForumTopicByWorkdir.get(chatId, 'project', workdir);
        if (existing) continue;

        const name = (typeof project === 'object' && project?.name) || null;
        await this.createProjectTopic(chatId, workdir, name);
      }
    } catch {
      // projects.json may not exist — that's fine
    }
  }

  /**
   * Handle commands in the General topic or unknown topics.
   */
  async _handleForumGeneralCommand(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');

    if (cmd === '/status') return this._api.cmdStatus(chatId, msg.from.id);
    if (cmd === '/help') return this._api.sendMessage(chatId, this._api.t('forum_help_general'));

    // Unknown command feedback
    if (cmd.startsWith('/')) {
      return this._api.sendMessage(chatId, this._api.t('forum_unknown_cmd', { cmd: this._api.escHtml(cmd) }));
    }
  }

  /**
   * Handle messages in a Project topic — send to Claude.
   * threadId is passed explicitly (FORUM-03).
   */
  async _handleForumProjectMessage(msg, workdir, threadId) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text || '').trim();

    // Use direct mode context for shared commands + session persistence
    const ctx = this._api.getDirectContext(userId);

    // Set project context + validate session belongs to this project
    ctx.projectWorkdir = workdir;
    if (ctx.sessionId) {
      const sess = this._api.db.prepare('SELECT workdir FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (!sess || sess.workdir !== workdir) {
        // Session from different project — restore last session for this project, or clear
        const lastForProject = this._api.stmts.getSessionsByWorkdir.all(workdir);
        ctx.sessionId = lastForProject.length ? lastForProject[0].id : null;
        this._api.saveDeviceContext(userId);
      }
    }

    // Persistent keyboard buttons send their label text into the topic — intercept before Claude
    if (text === this._api.t('kb_menu'))   return this._forumShowInfo(chatId, userId, workdir, threadId);
    if (text === this._api.t('kb_status')) return this._api.cmdStatus(chatId, userId);
    if (text.startsWith(this._api.t('kb_write')))  return; // In forum mode, just type directly in the topic
    if (text.startsWith(this._api.t('kb_project_prefix'))) return; // Project button ignored in forum mode

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
          if (isNaN(idx) || idx < 0) return this._api.sendMessage(chatId, '💡 /session <i>N</i>');
          return this._forumSwitchSession(chatId, userId, workdir, idx);
        }
        case '/files':
          return this._api.cmdFiles(chatId, userId, argParts.length ? argParts : ['.']);
        case '/cat':
          return this._api.cmdCat(chatId, userId, argParts);
        case '/last':
          return this._api.cmdLast(chatId, userId, argParts);
        case '/full':
          return this._api.cmdFull(chatId, userId);
        case '/diff':
          return this._api.cmdDiff(chatId, userId);
        case '/log':
          return this._api.cmdLog(chatId, userId, argParts);
        case '/stop':
          return this._api.cmdStop(chatId, userId);
        case '/status':
          return this._api.cmdStatus(chatId, userId);
        case '/help':
          return this._api.sendMessage(chatId, this._api.t('forum_help_project'));
        case '/info':
          return this._forumShowInfo(chatId, userId, workdir, threadId);
        default:
          // Unknown command — treat as message to Claude
          break;
      }
    }

    if (!text) {
      if (msg.photo || msg.document) {
        return this._api.handleMediaMessage(msg);
      }
      return this._api.sendMessage(chatId, this._api.t('forum_no_text'));
    }

    // Ensure session exists for this project — show orientation on first interaction
    if (!ctx.sessionId) {
      const existing = this._api.stmts.getSessionsByWorkdir.all(workdir);
      if (existing.length > 0) {
        // Restore last session + show orientation
        ctx.sessionId = existing[0].id;
        this._api.saveDeviceContext(userId);
        const title = (existing[0].title || this._api.t('chat_untitled')).substring(0, 40);
        const buttons = [
          { text: this._api.t('fm_btn_history'), callback_data: 'fm:history' },
          { text: this._api.t('fm_btn_new'), callback_data: 'fm:new' },
        ];
        await this._api.sendMessage(chatId,
          `📌 ${this._api.escHtml(title)} (${existing[0].msg_count || 0} msg)\n` +
          (existing.length > 1 ? `📜 +${existing.length - 1} sessions\n` : ''),
          { reply_markup: JSON.stringify({ inline_keyboard: [buttons] }) }
        );
      } else {
        await this._forumNewSession(chatId, userId, workdir, true);
      }
    }

    // Collect attachments from forum-scoped context (not direct mode)
    const forumCtx = this._getForumContext(chatId, threadId, userId);
    const attachments = forumCtx.pendingAttachments || [];
    forumCtx.pendingAttachments = [];

    // Send to Claude
    this._api.emit('send_message', {
      sessionId: ctx.sessionId,
      text,
      userId,
      chatId,
      threadId,
      attachments,
      callback: async (result) => {
        if (result.error) {
          await this._api.sendMessage(chatId, `❌ ${this._api.escHtml(result.error)}`);
        }
      },
    });
  }

  /**
   * Create a new session in a forum project topic.
   */
  async _forumNewSession(chatId, userId, workdir, silent = false) {
    const ctx = this._api.getDirectContext(userId);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    this._api.stmts.insertSession.run(id, 'Telegram Session', workdir);

    ctx.sessionId = id;
    ctx.projectWorkdir = workdir;
    this._api.saveDeviceContext(userId);

    if (!silent) {
      const buttons = [
        { text: this._api.t('fm_btn_history'), callback_data: 'fm:history' },
      ];
      await this._api.sendMessage(chatId, this._api.t('forum_session_started'), {
        reply_markup: JSON.stringify({ inline_keyboard: [buttons] }),
      });
    }
  }

  /**
   * Show current session info and project state.
   * Public — also called from parent bot for forum topic guard redirect.
   */
  async showInfo(chatId, userId, workdir, threadId) {
    return this._forumShowInfo(chatId, userId, workdir, threadId);
  }

  async _forumShowInfo(chatId, userId, workdir, threadId) {
    const ctx = this._api.getDirectContext(userId);
    const projectName = workdir.split('/').filter(Boolean).pop() || workdir;
    const rows = this._api.stmts.getSessionsByWorkdir.all(workdir);

    let text = `📁 <b>${this._api.escHtml(projectName)}</b>\n📂 <code>${this._api.escHtml(workdir)}</code>\n`;

    if (ctx.sessionId) {
      const sess = this._api.db.prepare('SELECT title, updated_at FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (sess) {
        const title = (sess.title || this._api.t('chat_untitled')).substring(0, 45);
        const ago = this._api.timeAgo(sess.updated_at);
        const msgCount = this._api.db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(ctx.sessionId)?.c || 0;
        text += `\n💬 <b>${this._api.escHtml(title)}</b>\n📊 ${msgCount} msg · ${ago}`;
      }
    } else {
      text += `\n💬 <i>${this._api.t('error_no_session')}</i>`;
    }

    text += `\n📜 ${this._api.t('status_sessions', { count: rows.length })}`;

    const buttons = [
      { text: this._api.t('fm_btn_last5'), callback_data: 'fm:last' },
      { text: this._api.t('fm_btn_history'), callback_data: 'fm:history' },
      { text: this._api.t('fm_btn_new'), callback_data: 'fm:new' },
    ];
    await this._api.sendMessage(chatId, text, {
      reply_markup: JSON.stringify({ inline_keyboard: [buttons] }),
    });
  }

  /**
   * Show session history for a project in forum mode.
   */
  async _forumShowHistory(chatId, userId, workdir) {
    const ctx = this._api.getDirectContext(userId);
    const rows = this._api.stmts.getSessionsByWorkdir.all(workdir);

    if (rows.length === 0) {
      return this._api.sendMessage(chatId, this._api.t('forum_history_empty'));
    }

    let text = this._api.t('forum_history_title', { count: rows.length });
    const keyboard = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const active = r.id === ctx.sessionId ? ' ◀️' : '';
      const title = (r.title || this._api.t('chat_untitled')).substring(0, 40);
      const ago = this._api.timeAgo(r.updated_at);
      text += `\n${i + 1}. ${this._api.escHtml(title)}  ·  ${r.msg_count} msgs  ·  ${ago}${active}`;
      // Inline button for quick switching (2 buttons per row)
      const btn = { text: `${i + 1}. ${title.substring(0, 25)}${active}`, callback_data: `fs:${i}` };
      if (i % 2 === 0) keyboard.push([btn]); else keyboard[keyboard.length - 1].push(btn);
    }

    await this._api.sendMessage(chatId, text, {
      reply_markup: JSON.stringify({ inline_keyboard: keyboard }),
    });
  }

  /**
   * Handle forum session switch callback (fs:N).
   * threadId passed explicitly (FORUM-03).
   */
  async handleSessionCallback(chatId, userId, data, threadId) {
    const idx = parseInt(data.slice(3));
    if (isNaN(idx) || idx < 0) return;

    if (!threadId) return;
    const topicInfo = this.getTopicInfo(chatId, threadId);
    if (!topicInfo?.workdir) return;

    return this._forumSwitchSession(chatId, userId, topicInfo.workdir, idx);
  }

  /**
   * Handle forum action callbacks (fm:history, fm:new, fm:compose, fm:diff, fm:files, fm:stop, fm:retry, fm:last, fm:info).
   * threadId passed explicitly (FORUM-03).
   */
  async handleActionCallback(chatId, userId, data, threadId) {
    const action = data.slice(3);
    if (!threadId) return;
    const topicInfo = this.getTopicInfo(chatId, threadId);
    if (!topicInfo?.workdir) return;

    // Always sync user context to the topic we're acting in
    const ctx = this._api.getDirectContext(userId);
    ctx.projectWorkdir = topicInfo.workdir;
    if (ctx.sessionId) {
      const sess = this._api.db.prepare('SELECT workdir FROM sessions WHERE id = ?').get(ctx.sessionId);
      if (!sess || sess.workdir !== topicInfo.workdir) {
        const lastForProject = this._api.stmts.getSessionsByWorkdir.all(topicInfo.workdir);
        ctx.sessionId = lastForProject.length ? lastForProject[0].id : null;
      }
    }

    switch (action) {
      case 'history':
        return this._forumShowHistory(chatId, userId, topicInfo.workdir);
      case 'new':
        return this._forumNewSession(chatId, userId, topicInfo.workdir);
      case 'compose': {
        // Prompt user to type their message
        await this._api.sendMessage(chatId, this._api.t('compose_prompt'), {
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._api.t('btn_cancel'), callback_data: 'fm:info' }],
          ]}),
        });
        return;
      }
      case 'diff':
        return this._api.cmdDiff(chatId, userId);
      case 'files':
        return this._api.cmdFiles(chatId, userId, ['.']);
      case 'stop':
        return this._api.cmdStop(chatId, userId);
      case 'info':
        return this._forumShowInfo(chatId, userId, topicInfo.workdir, threadId);
      case 'last': {
        // Show last 5 messages of current session
        if (!ctx.sessionId) return this._api.sendMessage(chatId, this._api.t('forum_history_empty'));
        return this._api.cmdLast(chatId, userId, ['5']);
      }
      case 'retry': {
        // Resend the last user message
        if (!ctx.sessionId) return;
        const lastUserMsg = this._api.db.prepare(
          `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`
        ).get(ctx.sessionId);
        if (!lastUserMsg?.content) return;
        this._api.emit('send_message', {
          sessionId: ctx.sessionId,
          text: lastUserMsg.content,
          userId,
          chatId,
          threadId,
          attachments: [],
          callback: async (result) => {
            if (result.error) await this._api.sendMessage(chatId, `❌ ${this._api.escHtml(result.error)}`);
          },
        });
        return;
      }
      case 'help': {
        // Show context-appropriate help — determine topic type
        const helpTopicInfo = this.getTopicInfo(chatId, threadId);
        const helpKey = helpTopicInfo?.type === 'tasks' ? 'forum_help_tasks'
          : helpTopicInfo?.type === 'project' ? 'forum_help_project'
          : 'forum_help_general';
        return this._api.sendMessage(chatId, this._api.t(helpKey), {
          message_thread_id: threadId,
        });
      }
    }
  }

  /**
   * Handle activity notification callbacks (fa:open:sessionId, fa:project:threadId).
   * threadId passed explicitly (FORUM-03).
   */
  async handleActivityCallback(chatId, userId, data, threadId) {
    const parts = data.slice(3).split(':');
    const action = parts[0];
    const param = parts.slice(1).join(':');

    switch (action) {
      case 'open': {
        // Open chat — show last messages from this session
        const session = this._api.db.prepare('SELECT id, title, workdir FROM sessions WHERE id = ?').get(param);
        if (!session) return this._api.sendMessage(chatId, this._api.t('forum_task_not_found'));

        // Find project topic for this workdir and switch session there
        const topics = this._api.stmts.getForumTopics.all(chatId);
        let projectTopic = topics.find(t => t.type === 'project' && t.workdir === session.workdir);

        // Auto-create project topic if it doesn't exist yet
        if (!projectTopic) {
          const newThreadId = await this.createProjectTopic(chatId, session.workdir);
          if (!newThreadId) {
            return this._api.sendMessage(chatId, '❌ Failed to create project topic.');
          }
          projectTopic = { thread_id: newThreadId, type: 'project', workdir: session.workdir };
        }

        // Switch user's active session
        const ctx = this._api.getDirectContext(userId);
        ctx.projectWorkdir = session.workdir;
        ctx.sessionId = session.id;
        this._api.saveDeviceContext(userId);

        // Show last messages in the project topic
        const msgs = this._api.db.prepare(
          `SELECT role, type, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 5`
        ).all(session.id).reverse();

        let text = `💬 <b>${this._api.escHtml((session.title || this._api.t('chat_untitled')).substring(0, 50))}</b>\n`;
        for (const m of msgs) {
          const icon = m.role === 'user' ? '👤' : '🤖';
          const content = (m.content || '').substring(0, 150).replace(/\n/g, ' ');
          text += `\n${icon} ${this._api.escHtml(content)}`;
        }
        if (msgs.length === 0) text += `\n<i>${this._api.t('chat_no_messages')}</i>`;

        // Send message to project topic + provide direct link for navigation
        const topicUrl = this._topicLink(chatId, projectTopic.thread_id);
        text += `\n\n${this._api.t('fm_session_activated_hint')}`;

        const buttons = [
          [
            { text: this._api.t('fm_btn_continue'), callback_data: 'fm:compose' },
            { text: this._api.t('fm_btn_full'), callback_data: 'fm:last' },
          ],
          [
            { text: this._api.t('fm_btn_history'), callback_data: 'fm:history' },
            { text: this._api.t('fm_btn_new'), callback_data: 'fm:new' },
          ],
        ];

        await this._api.sendMessage(chatId, text, {
          message_thread_id: projectTopic.thread_id,
          parse_mode: 'HTML',
          reply_markup: JSON.stringify({ inline_keyboard: buttons }),
        });

        // Also send a navigation link in the Activity topic so user can jump there
        await this._api.sendMessage(chatId, this._api.t('fm_session_activated_short'), {
          message_thread_id: threadId,
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._api.t('fm_btn_go_project'), url: topicUrl }],
          ]}),
        });
        return;
      }

      case 'continue': {
        // Continue session from Activity topic — switch session and prompt in project topic
        const contSession = this._api.db.prepare('SELECT id, title, workdir FROM sessions WHERE id = ?').get(param);
        if (!contSession) return this._api.sendMessage(chatId, this._api.t('forum_task_not_found'));

        const ctx = this._api.getDirectContext(userId);
        ctx.projectWorkdir = contSession.workdir;
        ctx.sessionId = contSession.id;
        this._api.saveDeviceContext(userId);

        // Find project topic for navigation
        const contTopics = this._api.stmts.getForumTopics.all(chatId);
        const contProjectTopic = contTopics.find(t => t.type === 'project' && t.workdir === contSession.workdir);
        if (contProjectTopic) {
          // Send compose prompt in the project topic
          await this._api.sendMessage(chatId, this._api.t('compose_prompt'), {
            message_thread_id: contProjectTopic.thread_id,
            reply_markup: JSON.stringify({ inline_keyboard: [
              [{ text: this._api.t('btn_cancel'), callback_data: 'fm:info' }],
            ]}),
          });
          // Link back from activity topic
          const topicUrl = this._topicLink(chatId, contProjectTopic.thread_id);
          await this._api.sendMessage(chatId, this._api.t('fm_session_activated_short'), {
            message_thread_id: threadId,
            reply_markup: JSON.stringify({ inline_keyboard: [
              [{ text: this._api.t('fm_btn_go_project'), url: topicUrl }],
            ]}),
          });
        }
        return;
      }

      case 'new': {
        // Create new session from Activity topic — param is workdir
        const newWorkdir = param;
        if (!newWorkdir) return;

        const newTopics = this._api.stmts.getForumTopics.all(chatId);
        let newProjectTopic = newTopics.find(t => t.type === 'project' && t.workdir === newWorkdir);

        // Auto-create project topic if it doesn't exist yet
        if (!newProjectTopic) {
          const newThreadId = await this.createProjectTopic(chatId, newWorkdir);
          if (!newThreadId) return this._api.sendMessage(chatId, '❌ Failed to create project topic.');
          newProjectTopic = { thread_id: newThreadId, type: 'project', workdir: newWorkdir };
        }

        await this._forumNewSession(chatId, userId, newWorkdir);

        // Link to project topic from activity
        const topicUrl = this._topicLink(chatId, newProjectTopic.thread_id);
        await this._api.sendMessage(chatId, this._api.t('fm_session_activated_short'), {
          message_thread_id: threadId,
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._api.t('fm_btn_go_project'), url: topicUrl }],
          ]}),
        });
        return;
      }

      case 'project': {
        // Navigate to project topic — send URL link for direct navigation
        const targetThreadId = parseInt(param);
        if (isNaN(targetThreadId)) return;

        const topicUrl = this._topicLink(chatId, targetThreadId);
        await this._api.sendMessage(chatId, this._api.t('fm_write_in_topic'), {
          message_thread_id: threadId,
          parse_mode: 'HTML',
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: this._api.t('fm_btn_go_project'), url: topicUrl }],
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
    const rows = this._api.stmts.getSessionsByWorkdir.all(workdir);

    if (idx >= rows.length) {
      return this._api.sendMessage(chatId, this._api.t('forum_task_not_found'));
    }

    const ctx = this._api.getDirectContext(userId);
    ctx.sessionId = rows[idx].id;
    this._api.saveDeviceContext(userId);

    const title = (rows[idx].title || this._api.t('chat_untitled')).substring(0, 50);
    const msgCount = rows[idx].msg_count || 0;
    const text = this._api.t('fm_session_switched', {
      title: this._api.escHtml(title),
      count: msgCount,
    });

    const buttons = [
      [
        { text: this._api.t('fm_btn_last5'), callback_data: 'fm:last' },
        { text: this._api.t('fm_btn_continue'), callback_data: 'fm:compose' },
      ],
      [
        { text: this._api.t('fm_btn_history'), callback_data: 'fm:history' },
        { text: this._api.t('fm_btn_new'), callback_data: 'fm:new' },
      ],
    ];
    await this._api.sendMessage(chatId, text, {
      reply_markup: JSON.stringify({ inline_keyboard: buttons }),
    });
  }

  /**
   * Handle messages in the Tasks topic.
   * threadId passed explicitly (FORUM-03).
   */
  // ─── Guided Onboarding (FORUM-05) ─────────────────────────────────────

  /**
   * Start the guided forum onboarding flow (Step 0: intro screen).
   * Called from telegram-bot.js _routeSettings when user taps "Forum Mode".
   */
  async startOnboarding(chatId, userId, editMsgId) {
    const text = this._api.t('forum_setup_title') + '\n\n' + this._api.t('forum_setup_intro');
    const kb = [
      [{ text: this._api.t('forum_setup_btn_next'), callback_data: 'fo:step:1' }],
      [{ text: this._api.t('forum_setup_btn_cancel'), callback_data: 's:menu' }],
    ];
    if (editMsgId) {
      await this._api.editScreen(chatId, editMsgId, text, kb);
    } else {
      await this._api.showScreen(chatId, userId, text, kb);
    }
  }

  /**
   * Handle onboarding step callbacks (fo:step:1, fo:step:2, fo:step:3).
   * Each step is a stateless screen edit — no persistent state to clean up.
   */
  async handleOnboardingCallback(chatId, userId, data, msgId) {
    const step = data.split(':')[2];

    if (step === '1') {
      const text = this._api.t('forum_setup_step1_title') + '\n\n' + this._api.t('forum_setup_step1_text');
      const kb = [
        [{ text: this._api.t('forum_setup_btn_done'), callback_data: 'fo:step:2' }],
        [{ text: this._api.t('forum_setup_btn_cancel'), callback_data: 's:menu' }],
      ];
      return this._api.editScreen(chatId, msgId, text, kb);
    }

    if (step === '2') {
      const botUsername = this._api.botUsername();
      const text = this._api.t('forum_setup_step2_title') + '\n\n' +
        this._api.t('forum_setup_step2_text', { bot_username: botUsername });
      const kb = [
        [{ text: this._api.t('forum_setup_btn_done'), callback_data: 'fo:step:3' }],
        [{ text: this._api.t('forum_setup_btn_cancel'), callback_data: 's:menu' }],
      ];
      return this._api.editScreen(chatId, msgId, text, kb);
    }

    if (step === '3') {
      const text = this._api.t('forum_setup_step3_title') + '\n\n' + this._api.t('forum_setup_step3_text');
      const kb = [
        [{ text: this._api.t('forum_setup_btn_cancel'), callback_data: 's:menu' }],
      ];
      return this._api.editScreen(chatId, msgId, text, kb);
    }
  }

  // ─── Task Inline Buttons (FORUM-10) ──────────────────────────────────

  /**
   * Build inline keyboard buttons for a task based on its current status.
   * Returns an array of button objects for the next logical status transitions.
   */
  _buildTaskButtons(task) {
    const shortId = task.id.slice(-6);
    const statusActions = {
      backlog: [
        { text: this._api.t('ft_btn_todo'), callback_data: `ft:todo:${shortId}` },
        { text: this._api.t('ft_btn_start'), callback_data: `ft:start:${shortId}` },
      ],
      todo: [
        { text: this._api.t('ft_btn_start'), callback_data: `ft:start:${shortId}` },
        { text: this._api.t('ft_btn_done'), callback_data: `ft:done:${shortId}` },
      ],
      in_progress: [
        { text: this._api.t('ft_btn_done'), callback_data: `ft:done:${shortId}` },
        { text: this._api.t('ft_btn_block'), callback_data: `ft:block:${shortId}` },
      ],
      blocked: [
        { text: this._api.t('ft_btn_start'), callback_data: `ft:start:${shortId}` },
      ],
      done: [
        { text: this._api.t('ft_btn_reopen'), callback_data: `ft:todo:${shortId}` },
      ],
    };
    return statusActions[task.status] || statusActions.backlog;
  }

  /**
   * Handle task inline button callbacks (ft:start:, ft:done:, ft:todo:, ft:block:, ft:info:).
   */
  async handleTaskCallback(chatId, userId, data, threadId) {
    const parts = data.split(':');
    const action = parts[1]; // start, done, todo, block, info
    const shortId = parts[2];

    const task = this._api.stmts.findTaskByIdLike.get(`%${shortId}`);
    if (!task) {
      return this._api.sendMessage(chatId, this._api.t('forum_task_not_found'), {
        message_thread_id: threadId,
      });
    }

    if (action === 'info') {
      // Show task detail with all action buttons
      const icons = { backlog: '📋', todo: '📝', in_progress: '🔄', done: '✅', blocked: '🚫' };
      const text = `${icons[task.status] || '•'} <b>#${this._api.escHtml(task.id.slice(-4))}</b> ${this._api.escHtml((task.title || '').substring(0, 100))}\n📌 ${task.status}`;
      const buttons = this._buildTaskButtons(task);
      return this._api.sendMessage(chatId, text, {
        message_thread_id: threadId,
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({ inline_keyboard: [buttons] }),
      });
    }

    // Status change
    const statusMap = { start: 'in_progress', done: 'done', todo: 'todo', block: 'blocked', backlog: 'backlog' };
    const newStatus = statusMap[action];
    if (!newStatus) return;

    this._api.stmts.updateTaskStatus.run(newStatus, task.id);

    const icons = { done: '✅', in_progress: '🔄', todo: '📝', blocked: '🚫', backlog: '📋' };
    const text = this._api.t('forum_task_updated', {
      icon: icons[newStatus],
      id: this._api.escHtml(task.id.slice(-4)),
      title: this._api.escHtml((task.title || '').substring(0, 50)),
      status: newStatus,
    });

    // Show updated task with new action buttons
    const updatedTask = { ...task, status: newStatus };
    const buttons = this._buildTaskButtons(updatedTask);
    await this._api.sendMessage(chatId, text, {
      message_thread_id: threadId,
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({ inline_keyboard: [buttons] }),
    });
  }

  // ─── Tasks Topic Message Handler ─────────────────────────────────────

  async _handleForumTaskMessage(msg, threadId) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const ctx = this._api.getDirectContext(userId);
    const text = (msg.text || '').trim();

    if (!text.startsWith('/')) {
      // Plain text in tasks topic — create a task from it
      const title = text.substring(0, 200);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const workdir = ctx.projectWorkdir || null;

      this._api.stmts.insertTask.run(id, title, workdir);

      const workdirLine = workdir ? `\n📁 ${this._api.escHtml(workdir.split('/').filter(Boolean).pop())}` : '';
      const newTask = { id, title, status: 'backlog' };
      const buttons = this._buildTaskButtons(newTask);
      return this._api.sendMessage(chatId, this._api.t('forum_task_created', {
        id: this._api.escHtml(id),
        title: this._api.escHtml(title),
        workdir_line: workdirLine,
      }), {
        message_thread_id: threadId,
        reply_markup: JSON.stringify({ inline_keyboard: [buttons] }),
      });
    }

    const [rawCmd, ...argParts] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@\w+$/, '');
    const args = argParts.join(' ').trim();

    switch (cmd) {
      case '/new': {
        if (!args) return this._api.sendMessage(chatId, '💡 /new <i>task title</i>');
        const title = args.substring(0, 200);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const workdir = ctx.projectWorkdir || null;

        this._api.stmts.insertTask.run(id, title, workdir);

        const workdirLine = workdir ? `\n📁 ${this._api.escHtml(workdir.split('/').filter(Boolean).pop())}` : '';
        const newTask = { id, title, status: 'backlog' };
        const buttons = this._buildTaskButtons(newTask);
        return this._api.sendMessage(chatId, this._api.t('forum_task_created', {
          id: this._api.escHtml(id),
          title: this._api.escHtml(title),
          workdir_line: workdirLine,
        }), {
          message_thread_id: threadId,
          reply_markup: JSON.stringify({ inline_keyboard: [buttons] }),
        });
      }

      case '/list': {
        const rows = this._api.stmts.listTasksOrdered.all();

        if (rows.length === 0) return this._api.sendMessage(chatId, this._api.t('tasks_empty'));

        const icons = { backlog: '📋', todo: '📝', in_progress: '🔄', done: '✅', blocked: '🚫' };
        const grouped = {};
        for (const r of rows) {
          if (!grouped[r.status]) grouped[r.status] = [];
          grouped[r.status].push(r);
        }

        let listText = this._api.t('tasks_title', { count: rows.length }) + '\n\n';
        for (const [status, items] of Object.entries(grouped)) {
          listText += `${icons[status] || '•'} <b>${this._api.escHtml(status)}</b> (${items.length})\n`;
          listText += items.map(t => `  · <code>${t.id.slice(-4)}</code> ${this._api.escHtml((t.title || '').substring(0, 45))}`).join('\n') + '\n\n';
        }

        // Build inline keyboard with per-task buttons
        const keyboard = [];
        for (const task of rows) {
          if (task.status === 'done') continue; // Skip completed tasks in quick-action list
          const shortId = task.id.slice(-6);
          const titleBtn = { text: `${icons[task.status] || '•'} ${(task.title || '').substring(0, 30)}`, callback_data: `ft:info:${shortId}` };
          const nextBtn = this._buildTaskButtons(task)[0]; // first action = most common next status
          keyboard.push([titleBtn, nextBtn]);
        }

        const options = { message_thread_id: threadId };
        if (keyboard.length > 0) {
          options.reply_markup = JSON.stringify({ inline_keyboard: keyboard });
        }
        return this._api.sendMessage(chatId, listText, options);
      }

      case '/done':
      case '/start':
      case '/todo':
      case '/block':
      case '/backlog': {
        const taskIdSearch = args.replace('#', '').replace(/[%_]/g, '');
        if (!taskIdSearch) return this._api.sendMessage(chatId, `💡 ${cmd} <i>#id</i>`);

        const task = this._api.stmts.findTaskByIdLike.get(`%${taskIdSearch}`);
        if (!task) return this._api.sendMessage(chatId, this._api.t('forum_task_not_found'));

        const statusMap = { '/done': 'done', '/start': 'in_progress', '/todo': 'todo', '/block': 'blocked', '/backlog': 'backlog' };
        const iconMap = { done: '✅', in_progress: '🔄', todo: '📝', blocked: '🚫', backlog: '📋' };
        const newStatus = statusMap[cmd];
        this._api.stmts.updateTaskStatus.run(newStatus, task.id);

        const msgText = this._api.t('forum_task_updated', {
          icon: iconMap[newStatus],
          id: this._api.escHtml(task.id.slice(-4)),
          title: this._api.escHtml((task.title || '').substring(0, 50)),
          status: newStatus,
        });

        // Add "Go to project" button for actionable statuses if task has workdir
        const options = {};
        if (task.workdir && (newStatus === 'in_progress' || newStatus === 'todo')) {
          const device = this._api.stmts.getDevice.get(userId);
          if (device?.forum_chat_id) {
            const topics = this._api.stmts.getForumTopics.all(device.forum_chat_id);
            const projectTopic = topics.find(t => t.type === 'project' && t.workdir === task.workdir);
            if (projectTopic) {
              options.reply_markup = JSON.stringify({ inline_keyboard: [[
                { text: this._api.t('fm_btn_go_project_files'), callback_data: `fa:project:${projectTopic.thread_id}` },
              ]] });
            }
          }
        }

        return this._api.sendMessage(chatId, msgText, options);
      }

      case '/delete': {
        const taskIdSearch = args.replace('#', '').replace(/[%_]/g, '');
        if (!taskIdSearch) return this._api.sendMessage(chatId, '💡 /delete <i>#id</i>');

        const task = this._api.stmts.findTaskByIdLike.get(`%${taskIdSearch}`);
        if (!task) return this._api.sendMessage(chatId, this._api.t('forum_task_not_found'));

        this._api.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
        return this._api.sendMessage(chatId, `🗑 <b>#${this._api.escHtml(task.id.slice(-4))}</b> ${this._api.escHtml((task.title || '').substring(0, 50))} — deleted`);
      }

      case '/help':
        return this._api.sendMessage(chatId, this._api.t('forum_help_tasks'));

      default:
        return;
    }
  }
}

module.exports = TelegramBotForum;
