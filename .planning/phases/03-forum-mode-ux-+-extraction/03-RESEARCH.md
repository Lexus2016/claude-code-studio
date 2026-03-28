# Phase 3: Forum Mode UX + Extraction - Research

**Researched:** 2026-03-28
**Domain:** Telegram Bot Forum Mode — module extraction, state scoping, inline keyboard UX
**Confidence:** HIGH

## Summary

Phase 3 extracts ~900 lines of forum-specific code from telegram-bot.js into a standalone `TelegramBotForum` class in `telegram-bot-forum.js`, while simultaneously upgrading the Forum Mode UX with guided onboarding, inline action keyboards in every topic type, and per-(chatId, threadId, userId) state scoping.

The extraction is structurally clean: all 21 forum-specific methods are already clustered in a single block (lines 3063-3962), use a consistent set of TelegramBot internals (34 unique `this._X` references), and have well-defined entry points (3 callback prefixes: `fs:`, `fm:`, `fa:` plus message routing via `_handleForumMessage`). The primary risk is state bleed — the current implementation shares `_userContext` (keyed by userId only) between Direct Mode and Forum Mode, meaning a session switch in a forum topic silently changes the active session in the private chat. This must be fixed as part of the extraction.

**Primary recommendation:** Extract via composition pattern — `TelegramBotForum` receives an API facade object `{ db, log, callApi, sendMessage, t, escHtml, stmts, ... }` from the parent bot, NOT via inheritance. Forum state uses a separate context map keyed by `chatId:threadId:userId`. The parent bot delegates forum routing to `this._forum.handleMessage()` / `this._forum.handleCallback()` at the existing routing points.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FORUM-01 | Forum mode logic extracted to TelegramBotForum in telegram-bot-forum.js (~860 lines) | 21 methods identified (lines 3063-3962, ~900 lines). Dependency inventory complete — 34 unique internal references. Composition pattern documented. |
| FORUM-02 | Forum and Direct mode never share ctx.state — forum state scoped to (chatId, threadId, userId) | Current bug confirmed: _userContext keyed by userId only. Solution: separate _forumContext map in TelegramBotForum keyed by composite key. |
| FORUM-03 | threadId always passed explicitly — no class-level this._currentThreadId | _currentThreadId used in 6 forum methods. Extraction removes it; every method receives threadId as parameter from the routing layer. |
| FORUM-04 | Existing Forum Mode supergroups work after extraction with zero reconfiguration | DB schema unchanged (forum_topics table, forum_chat_id column). Message routing unchanged (isForum check + device.forum_chat_id match). Only internal dispatch changes. |
| FORUM-05 | Forum setup uses guided onboarding with inline buttons | Current setup is a text wall (5-step instructions). Research provides step-by-step guided flow design with inline buttons per step. |
| FORUM-06 | Claude responses in project topics include inline keyboard with quick actions | TelegramProxy already generates forum-specific done/error buttons (server.js lines 1721-1785). These need i18n and enhancement. |
| FORUM-07 | /help in forum shows forum-specific commands only | setMyCommands cannot scope per-topic (only per-chat or per-member). Solution: application-level — /help handler checks topicInfo.type and returns context-specific help text. Already partially implemented. |
| FORUM-08 | Activity topic has actionable inline buttons on every notification | _notifyForumActivity already sends "Open chat" URL button. Needs expansion: view response preview, go to project, retry. |
| FORUM-09 | Error messages include recovery action buttons (Retry, Go to project, Help) | TelegramProxy._sendError already sends forum-specific buttons (fm:retry, fm:compose, fm:history). Needs Help button added. |
| FORUM-10 | Tasks topic uses inline buttons per task (no /start #id) | Current _handleForumTaskMessage uses slash commands. Must add inline keyboard per task message with status-change buttons. |
| FORUM-11 | Project topic shows active session name; switching is one tap | _forumShowInfo shows session info. Pinned message needs update mechanism. Session switcher inline keyboard already exists via fm:history. |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **No new npm dependencies** — zero build step philosophy
- **No TypeScript** — vanilla JS throughout
- **No build tools** — no webpack, vite, esbuild, rollup
- **SQLite rules** — WAL mode stays on; ALTER TABLE only for schema changes, no DROP TABLE
- **Existing Forum Mode supergroups** must continue working with zero reconfiguration
- **Security** — all file read ops within WORKDIR, no path traversal bypass
- **Model IDs** — use exact strings: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
- **No `as` typecasting** — never use `as`
- **Scope discipline** — touch only what's asked; no unsolicited cleanup or refactoring

## Standard Stack

### Core (existing — no changes)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js | 20.x | Runtime | Project constraint — no upgrades |
| better-sqlite3 | existing | SQLite access | Already used, WAL mode enabled |
| native fetch | built-in | Telegram Bot API calls | Project constraint — no HTTP libs |

### No New Libraries

This phase adds zero new dependencies. All functionality is built with existing primitives:
- Module extraction: Node.js `require()` / `module.exports`
- State management: in-memory Map (existing pattern)
- Inline keyboards: Telegram Bot API (existing)

## Architecture Patterns

### Module Extraction Pattern: Composition via Facade

TelegramBotForum receives an API facade object, NOT the full bot instance. This prevents circular dependencies and makes the interface explicit.

```javascript
// telegram-bot-forum.js
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
   * @param {Function} api.topicLink - Forum topic URL generator
   * @param {Object} api.stmts - Prepared SQL statements (forum-related subset)
   * @param {Function} api.emit - EventEmitter emit (for send_message, stop_task)
   * @param {Function} api.getDirectContext - Get direct mode ctx (for project list)
   * @param {Function} api.saveDeviceContext - Persist ctx to SQLite
   */
  constructor(api) {
    this._api = api;
    this._forumTopics = new Map(); // chatId:threadId → { type, workdir, chatId }
    this._forumContext = new Map(); // chatId:threadId:userId → forum-scoped state
  }
}
```

### Forum State Scoping Pattern (FORUM-02, FORUM-03)

**Current bug:** Forum and Direct mode share `_userContext` keyed by `userId` only. When a user sends a message in a forum project topic, `ctx.projectWorkdir` and `ctx.sessionId` get overwritten — affecting their Direct Mode state.

**Fix:** TelegramBotForum has its own `_forumContext` map with composite key:

```javascript
_getForumContext(chatId, threadId, userId) {
  const key = `${chatId}:${threadId}:${userId}`;
  if (!this._forumContext.has(key)) {
    this._forumContext.set(key, {
      sessionId: null,
      projectWorkdir: null,
      state: 'IDLE',
      stateData: null,
      pendingAttachments: [],
      isStreaming: false,
      streamMsgId: null,
    });
  }
  return this._forumContext.get(key);
}
```

**threadId elimination:** `this._currentThreadId` is NOT carried to the new class. Every forum method receives `threadId` as an explicit parameter. The routing layer in TelegramBot extracts `threadId` from `msg.message_thread_id` or `cbq.message.message_thread_id` and passes it through.

### Recommended Project Structure (after Phase 3)

```
telegram-bot.js            — Core: polling, routing, Direct Mode screens, FSM (~3500 lines)
telegram-bot-i18n.js       — Translation data (836 lines, pure data export)
telegram-bot-forum.js      — TelegramBotForum class (~900 lines, composition)
server.js                  — Express + TelegramProxy (unchanged API surface)
```

### Routing Integration Pattern

The parent bot delegates at two well-defined points:

```javascript
// In TelegramBot._handleUpdate() — message routing
if (isForum && this._isAuthorized(userId)) {
  const device = this._stmts.getDevice.get(userId);
  if (device?.forum_chat_id !== chatId) return;
  if (!this._checkRateLimit(userId)) return;
  this._stmts.updateLastActive.run(userId);
  const threadId = msg.message_thread_id || null;
  return await this._forum.handleMessage(msg, threadId);
}

// In TelegramBot._handleCallback() — callback routing
if (data.startsWith('fs:') || data.startsWith('fm:') || data.startsWith('fa:')) {
  const threadId = cbq.message?.message_thread_id || null;
  return this._forum.handleCallback(chatId, userId, data, threadId);
}
```

### Notification Bridge Pattern

Methods in the parent bot that send forum notifications (`notifyTunnelUrl`, `notifyCompletion`, `notifyAskUser`) call `this._forum.notifyActivity()` and `this._forum.notifyAskUser()` instead of inline implementations.

```javascript
// In TelegramBot.notifyTunnelUrl:
if (dev.forum_chat_id) {
  const ok = await this._forum.notifyActivity(dev.forum_chat_id, text);
  if (!ok) await this._sendMessage(dev.telegram_chat_id, text);
}
```

## Code Inventory: What Moves vs. What Stays

### Methods That Move to TelegramBotForum (21 methods, ~900 lines)

| Method | Lines | Purpose |
|--------|-------|---------|
| `_cmdForum` | 3105-3113 | /forum command (setup instructions) |
| `_handleForumConnect` | 3119-3168 | /connect pairing |
| `_createForumStructure` | 3175-3229 | Create Tasks + Activity topics |
| `_syncProjectTopics` | 3235-3256 | Sync project topics from projects.json |
| `_createProjectTopic` | 3261-3292 | Create single project topic |
| `_getTopicInfo` | 3298-3308 | Topic cache lookup |
| `_handleForumMessage` | 3315-3347 | Main forum message router |
| `_handleForumGeneralCommand` | 3353-3364 | General topic commands |
| `_handleForumProjectMessage` | 3370-3482 | Project topic message handler |
| `_forumNewSession` | 3488-3506 | Create new session in forum |
| `_forumShowInfo` | 3511-3539 | Show project info screen |
| `_forumShowHistory` | 3545-3568 | Show session history |
| `_handleForumSessionCallback` | 3574-3584 | fs: callback router |
| `_handleForumActionCallback` | 3590-3656 | fm: callback router |
| `_handleForumActivityCallback` | 3662-3751 | fa: callback router |
| `_forumSwitchSession` | 3757-3780 | Switch active session |
| `_handleForumTaskMessage` | 3786-3906 | Tasks topic handler |
| `_cmdForumDisconnect` | 3912-3927 | Disconnect forum |
| `_notifyForumActivity` | 3933-3961 | Send Activity topic notification |
| `_notifyForumAskUser` | 3063-3083 | Send ask_user to Activity topic |
| `_topicLink` | 4229-4233 | Generate topic deep link URL |

### Methods That Stay in TelegramBot (referenced by forum code)

| Method | Why It Stays |
|--------|-------------|
| `_callApi` | Core API call, used by all modules |
| `_sendMessage` | Core send with HTML retry + thread injection |
| `_editScreen` | Core screen editing |
| `_showScreen` | Core screen sending |
| `_t` | i18n lookup (shared) |
| `_escHtml` | HTML escaping (shared) |
| `_sanitize` | Content sanitization |
| `_getContext` | Direct mode context (forum gets separate map) |
| `_saveDeviceContext` | Persist session/workdir to DB |
| `_isAuthorized` | Auth check (stays in routing layer) |
| `_checkRateLimit` | Rate limiting (stays in routing layer) |
| `_cmdStatus` | Status command (shared between forum + direct) |
| `_cmdFiles` | File browser (shared) |
| `_cmdDiff` / `_cmdLog` | Git commands (shared) |
| `_cmdLast` / `_cmdFull` | Message history (shared) |
| `_cmdStop` | Stop task (shared) |
| `_cmdCat` | Cat file (shared) |
| `_handleMediaMessage` | Media handling (shared) |

### Code in TelegramBot That References Forum (stays, calls forum module)

| Location | Lines | What It Does |
|----------|-------|-------------|
| `_handleUpdate` message routing | 689-696 | Detects forum message, delegates |
| `_handleCallback` callback routing | 1624-1636, 1651-1653 | Forum topic guard + fs:/fm:/fa: delegation |
| `_screenSettings` | 2646-2652 | Forum status display + setup/disconnect buttons |
| `_routeSettings` | 2693-2708 | s:forum and s:forum:off routing |
| `notifyTunnelUrl` | 1280-1286 | Forum activity notification |
| `notifyTunnelClosed` | 1302-1308 | Forum activity notification |
| `notifyCompletion` | 2955-2963 | Forum activity notification |
| `notifyAskUser` | 3032-3045 | Forum ask_user notification |
| `_showMessages` | 4126-4137 | Forum-specific action buttons |
| `_showFullMessage` | 2206-2215, 2225-2227 | Forum-specific action buttons |
| `_cmdFull` | 1017-1025 | Forum-specific buttons |
| `_handleUpdate` /connect early | 680-686 | Forum connect in supergroup |

### Code in server.js That References Forum (stays, threadId-aware)

| Location | Lines | What It Does |
|----------|-------|-------------|
| `TelegramProxy` constructor | 1366-1393 | Accepts threadId, injects message_thread_id |
| `TelegramProxy._sendProgress` | 1583, 1618-1623 | Forum-specific progress buttons |
| `TelegramProxy._finalize` | 1721-1735 | Forum-specific done buttons |
| `TelegramProxy._sendError` | 1770-1775 | Forum-specific error buttons |
| `processTelegramChat` | 5015 | Passes threadId to TelegramProxy |
| `send_message` handler | 5199-5202 | Passes threadId through |

## Guided Onboarding Flow Design (FORUM-05)

### Current State (text wall)
The setup is a 5-line instruction text with no interactivity:
```
1. Create a new private group
2. Name it
3. Enable Topics
4. Add me as admin
5. Write /connect in the group
```

### Proposed Guided Flow (inline buttons)

**Step 1: Trigger** — User taps "Forum Mode" in Settings.
```
Screen: "Forum Mode Setup"
Text: "Forum Mode creates a supergroup with per-project topic threads.
       Each project gets its own topic. Tasks and Activity are separate topics."
Buttons: [Next: Create Group] [Cancel]
```

**Step 2: Instructions with verify** — After "Next: Create Group"
```
Screen: "Step 1 of 3: Create the Group"
Text: "1. Open Telegram → New Group
       2. Name it (e.g., 'Claude Studio')
       3. In group Settings → Enable Topics"
Buttons: [Done, next step] [Cancel]
```

**Step 3: Add bot** — After "Done, next step"
```
Screen: "Step 2 of 3: Add the Bot"
Text: "1. Open the group → Add Members
       2. Search for @{bot_username}
       3. Promote to Admin with 'Manage Topics' permission"
Buttons: [Done, next step] [Cancel]
```

**Step 4: Connect** — After "Done, next step"
```
Screen: "Step 3 of 3: Connect"
Text: "Send /connect in the group.
       The bot will create Tasks and Activity topics automatically."
Buttons: [Cancel]
```

This uses a simple `FORUM_SETUP_STEP` state in the forum context. Each step edits the same message in place (edit-in-place pattern from Phase 2).

## Task Topic Inline Buttons (FORUM-10)

### Current State
Tasks use slash commands: `/start #id`, `/done #id`, `/todo #id`, `/block #id`, `/backlog #id`. The user must manually type task IDs.

### Proposed Inline Button Pattern

When a task is created or `/list` is used, each task gets an inline keyboard row:

```javascript
// Task creation response
const taskButtons = [
  [
    { text: '▶ Start', callback_data: `ft:start:${shortId}` },
    { text: '✅ Done', callback_data: `ft:done:${shortId}` },
    { text: '🚫 Block', callback_data: `ft:block:${shortId}` },
  ],
];

// Task list — each task gets a row
for (const task of tasks) {
  const shortId = task.id.slice(-6);
  keyboard.push([
    { text: `${icon} ${title.substring(0, 30)}`, callback_data: `ft:info:${shortId}` },
    { text: statusBtn, callback_data: `ft:next:${shortId}` }, // cycles to next logical status
  ]);
}
```

**New callback prefix:** `ft:` (forum task) — routes to TelegramBotForum.handleTaskCallback().

**Status cycle logic:** Each status has a natural "next":
- backlog → todo (tap to start planning)
- todo → in_progress (tap to start working)
- in_progress → done (tap to complete)
- blocked → in_progress (tap to unblock)
- done → (no cycle, show "reopen" option)

## Activity Topic Enhancement (FORUM-08)

### Current State
Activity notifications send text + one "Open chat" URL button (when project topic exists). No other action buttons.

### Proposed Enhancement

Every activity notification includes context-appropriate buttons:

```javascript
// Task completion notification
const buttons = [
  [
    { text: '💬 Open Project', url: topicUrl },      // URL button — navigates to topic
    { text: '📄 View Response', callback_data: `fa:open:${sessionId}` },
  ],
  [
    { text: '💬 Continue', callback_data: `fa:continue:${sessionId}` },
    { text: '🆕 New Session', callback_data: `fa:new:${workdir}` },
  ],
];

// Error notification
const buttons = [
  [
    { text: '🔄 Retry', callback_data: `fa:retry:${sessionId}` },
    { text: '💬 Open Project', url: topicUrl },
  ],
];

// Ask_user notification (already good — has answer buttons + project link)
```

## Error Recovery Buttons (FORUM-09)

### Current State in TelegramProxy (server.js)
Error buttons for forum: `[Retry, Continue, History]`. These are already present but can be enhanced.

### Proposed Enhancement

```javascript
const errorButtons = [
  [
    { text: '🔄 Retry', callback_data: 'fm:retry' },
    { text: '💬 Continue', callback_data: 'fm:compose' },
  ],
  [
    { text: '📜 History', callback_data: 'fm:history' },
    { text: '❓ Help', callback_data: 'fm:help' },
  ],
];
```

Add `fm:help` callback that shows `forum_help_project` text — same as `/help` in the topic.

## Forum-Specific /help (FORUM-07)

### API Limitation
`setMyCommands` does NOT support per-topic scoping. The finest granularity is `BotCommandScopeChat` (per supergroup) or `BotCommandScopeChatMember`.

### Application-Level Solution
Already partially implemented: `_handleForumProjectMessage` handles `/help` and returns `forum_help_project`. `_handleForumGeneralCommand` handles `/help` and returns `forum_help_general`. `_handleForumTaskMessage` handles `/help` and returns `forum_help_tasks`.

**Enhancement needed:**
1. Set forum-scoped commands via `setMyCommands` with `BotCommandScopeChat` for the forum supergroup — show only: /help, /status, /new, /stop
2. Each /help response is already context-aware based on topic type
3. Remove direct-mode-only commands (/projects, /chats) from forum command scope

```javascript
// Called after forum connection
async _setForumCommands(chatId) {
  await this._api.callApi('setMyCommands', {
    commands: JSON.stringify([
      { command: 'help', description: this._api.t('cmd_help_desc') },
      { command: 'status', description: this._api.t('cmd_status_desc') },
      { command: 'new', description: 'New session / task' },
      { command: 'stop', description: 'Stop current task' },
    ]),
    scope: JSON.stringify({ type: 'chat', chat_id: chatId }),
  });
}
```

## Session Display in Project Topic (FORUM-11)

### Current State
`_forumShowInfo` shows session info when called explicitly. The pinned message is set once at topic creation and never updated.

### Proposed Solution

1. **On session switch** (via fm:history or auto-restore): update the info displayed to the user with current session name
2. **Session switcher:** Already exists as `_forumShowHistory` with inline keyboard. One-tap to switch.
3. **Pinned message:** Pinned message is static (project info). Dynamic session info goes in regular messages. Updating the pin on every session switch would generate excessive notifications.

The pattern: after every session switch, send a confirmation message with the session name and action buttons. The latest such message serves as the "active session indicator."

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Module import/export | Custom loader | Node.js require/module.exports | Already used for telegram-bot-i18n.js |
| State scoping | Complex proxy | Separate Map with composite key | Simple, debuggable, no magic |
| Inline keyboard building | Template system | Direct Telegram API objects | Keeps code explicit and auditible |
| Topic URL generation | URL construction | _topicLink helper (existing) | Already handles chatId → internal ID conversion |
| Message chunking | Custom splitter | _chunkForTelegram (existing) | Already handles code fences and paragraph boundaries |

## Common Pitfalls

### Pitfall 1: State Bleed Between Forum and Direct Mode
**What goes wrong:** User sends message in forum project topic, which sets ctx.projectWorkdir and ctx.sessionId. Then sends a message in private chat — it goes to the forum project's session.
**Why it happens:** Single _userContext map keyed by userId only.
**How to avoid:** TelegramBotForum has its own _forumContext map keyed by `chatId:threadId:userId`. Direct mode _userContext is never touched by forum code.
**Warning signs:** After sending in a forum topic, the persistent keyboard in private chat shows the wrong project/session.

### Pitfall 2: threadId Dropped During Extraction
**What goes wrong:** Forum messages land in General topic instead of the correct project topic.
**Why it happens:** After extraction, this._currentThreadId no longer exists on the new class. Any sendMessage call without explicit message_thread_id goes to General.
**How to avoid:** Every forum method receives threadId as a parameter. The sendMessage wrapper in the API facade does NOT auto-inject threadId — it must be passed explicitly. Add an assertion: if threadId is undefined in a forum context, throw.
**Warning signs:** Messages appearing in General topic or replies going to wrong topics.

### Pitfall 3: Callback Data Prefix Collision
**What goes wrong:** New `ft:` (forum task) callbacks conflict with `f:` (files) prefix matching.
**Why it happens:** The callback router in _handleCallback uses startsWith matching. `ft:` starts with `f:`.
**How to avoid:** Route `ft:` BEFORE `f:` in the callback router, or use the full-prefix-first pattern already in use (data.startsWith('fs:') before data.startsWith('f:')).
**Warning signs:** Task callback taps opening the file browser instead.

### Pitfall 4: Forum Onboarding State Left Dangling
**What goes wrong:** User starts guided onboarding (Step 1), then navigates away. Next time they open Settings, the onboarding state interferes.
**Why it happens:** Forum setup state stored in ctx but never cleaned up on navigation away.
**How to avoid:** Onboarding uses a simple step counter in the direct mode ctx (not forum ctx). Reset to null on any Settings re-entry or on /cancel.
**Warning signs:** Settings screen showing onboarding step instead of normal settings.

### Pitfall 5: Shared Commands (_cmdDiff, _cmdFiles, etc.) Break in Forum Context
**What goes wrong:** Shared commands like _cmdDiff assume Direct Mode context (ctx from _getContext(userId)). In forum mode, the project context comes from the topic's workdir, not from the user's global state.
**Why it happens:** Shared methods read ctx.projectWorkdir which is the direct mode value, not the forum topic's workdir.
**How to avoid:** Before calling shared commands from forum, explicitly set ctx.projectWorkdir to the topic's workdir. This is already done in _handleForumProjectMessage (line 3377). Ensure all callback paths do the same.
**Warning signs:** /files or /diff showing files from wrong project in a forum topic.

### Pitfall 6: TelegramProxy Forum Buttons Use Hardcoded English
**What goes wrong:** Done/error buttons in TelegramProxy (server.js) use hardcoded strings like "Continue", "Files", "History" instead of i18n.
**Why it happens:** TelegramProxy has access to bot._t() but the forum response buttons on lines 1721-1785 use plain strings.
**How to avoid:** TelegramProxy already has `this._bot._t()` access. Update the button labels to use i18n keys. Note: this is a server.js change, not a forum module change.
**Warning signs:** Forum buttons showing English text when bot is in Ukrainian mode.

## Code Examples

### TelegramBotForum Constructor (composition pattern)

```javascript
// telegram-bot-forum.js
'use strict';

class TelegramBotForum {
  constructor(api) {
    this._api = api;
    this._forumTopics = new Map();  // chatId:threadId → { type, workdir, chatId }
    this._forumContext = new Map();  // chatId:threadId:userId → forum state
    // Hydrate cache from DB
    this._loadTopicsFromDb();
  }

  _loadTopicsFromDb() {
    // Load all forum_topics into memory cache
    try {
      const rows = this._api.db.prepare('SELECT * FROM forum_topics').all();
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

  // Main entry point — called from TelegramBot._handleUpdate
  async handleMessage(msg, threadId) { /* ... */ }

  // Callback entry point — called from TelegramBot._handleCallback
  async handleCallback(chatId, userId, data, threadId) { /* ... */ }

  // Notification entry — called from TelegramBot.notifyCompletion etc.
  async notifyActivity(forumChatId, text, sessionId) { /* ... */ }
  async notifyAskUser(forumChatId, text, session, answerRows) { /* ... */ }
}

module.exports = TelegramBotForum;
```

### API Facade Creation in TelegramBot

```javascript
// In TelegramBot constructor, after _prepareStmts:
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
  stmts: this._stmts,     // forum reads prepared statements directly
  emit: this.emit.bind(this),
  getDirectContext: this._getContext.bind(this),
  saveDeviceContext: this._saveDeviceContext.bind(this),
  botId: () => this._botId,
});
```

### Forum Context Scoping (separate from Direct Mode)

```javascript
_getForumContext(chatId, threadId, userId) {
  // Composite key isolates forum state from direct mode
  const key = `${chatId}:${threadId}:${userId}`;
  if (!this._forumContext.has(key)) {
    this._forumContext.set(key, {
      sessionId: null,
      projectWorkdir: null,
      pendingAttachments: [],
    });
  }
  return this._forumContext.get(key);
}
```

### Task Inline Buttons (replacing /start #id)

```javascript
// In _handleForumTaskMessage when creating or listing tasks:
_buildTaskButtons(taskId) {
  const shortId = taskId.slice(-6);
  return [
    { text: '▶ Start', callback_data: `ft:start:${shortId}` },
    { text: '✅ Done', callback_data: `ft:done:${shortId}` },
    { text: '🚫 Block', callback_data: `ft:block:${shortId}` },
  ];
}
```

## State of the Art

| Old Approach (current) | New Approach (Phase 3) | Impact |
|------------------------|----------------------|--------|
| Forum code inline in telegram-bot.js (900 lines) | Extracted to telegram-bot-forum.js | 20% reduction in main file |
| Shared _userContext(userId) | Separate _forumContext(chatId:threadId:userId) | No state bleed |
| this._currentThreadId class property | threadId passed as explicit parameter | Thread-safe, no race conditions |
| Text wall setup instructions | Guided inline button onboarding | Better first-run experience |
| Slash commands for task status | Inline buttons per task | Zero typing required |
| Read-only Activity notifications | Actionable buttons on every notification | One-tap follow-up |
| Mixed forum/direct help | Topic-type-specific /help | No confusion |

## Open Questions

1. **Forum context persistence across restarts**
   - What we know: Direct mode uses _saveDeviceContext (last_session_id, last_workdir) in telegram_devices table
   - What's unclear: Should forum context also persist? Currently forum mode re-derives from topic → workdir → latest session on each message
   - Recommendation: Do NOT persist forum context. The topic's workdir is deterministic from the forum_topics table. Session auto-restores from getSessionsByWorkdir. This avoids needing a new DB table.

2. **Pinned message updates for session display (FORUM-11)**
   - What we know: Telegram allows editMessageText on pinned messages. Pinning is a separate API call.
   - What's unclear: Does editing a pinned message generate a notification? Does it re-pin?
   - Recommendation: Do NOT edit the original pinned message. Instead, session info is part of every response's completion message. The user always sees the current session name in the last "Done" notification.

3. **TelegramProxy forum buttons i18n (Pitfall 6)**
   - What we know: TelegramProxy in server.js has hardcoded English button labels for forum mode
   - What's unclear: Is this in scope for Phase 3 or Phase 4?
   - Recommendation: Fix in Phase 3 since it directly affects forum UX. The fix is small — replace string literals with bot._t() calls.

## Sources

### Primary (HIGH confidence)
- Direct code audit of telegram-bot.js (4464 lines) — all forum methods, routing, state management
- Direct code audit of server.js — TelegramProxy forum integration, processTelegramChat
- Direct code audit of telegram-bot-i18n.js (836 lines) — forum i18n keys
- [Telegram Bot API Reference](https://core.telegram.org/bots/api) — createForumTopic, message_thread_id, BotCommandScope
- [Telegram Forums API](https://core.telegram.org/api/forum) — forum topic management

### Secondary (MEDIUM confidence)
- [Bot API Changelog](https://core.telegram.org/bots/api-changelog) — 2026 updates: forum topics in private chats
- [BotCommandScope types](https://core.telegram.org/type/BotCommandScope) — confirmed no per-topic scope for setMyCommands

## Metadata

**Confidence breakdown:**
- Code extraction scope: HIGH — complete method inventory, line counts, dependency mapping from direct code audit
- State scoping solution: HIGH — well-understood pattern (composite key Map), directly addresses confirmed bug
- UX designs (onboarding, task buttons, activity buttons): HIGH — based on existing Telegram API capabilities and patterns already used in Phase 2
- setMyCommands limitation: HIGH — confirmed from official API docs (no per-topic scope)
- Pitfalls: HIGH — all derived from direct code analysis of existing bugs and structural risks

**Research date:** 2026-03-28
**Valid until:** 2026-04-28 (stable domain — Telegram Bot API changes infrequently)
