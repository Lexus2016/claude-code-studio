# Phase 2: UX Redesign - Research

**Researched:** 2026-03-28
**Domain:** Telegram Bot API navigation patterns, screen architecture, sendMessageDraft streaming
**Confidence:** HIGH

## Summary

Phase 2 is the core user-facing redesign of the Telegram bot. It transforms a 6-tap-to-message flow into a 2-tap flow by introducing a SCREENS registry with automatic back buttons, removing the fragile `ctx.screenMsgId/screenChatId` slot in favor of callback message anchors (`cbq.message.message_id`), updating the persistent reply keyboard to show active context, calling `setMyCommands` with only 3-5 commands, and replacing the `editMessageText` streaming loop with `sendMessageDraft` (Bot API 9.5).

Phase 1 is complete: the FSM (`ctx.state`, `ctx.stateData`) is the single source of truth, `answerCallbackQuery` lives in a `finally` block, and i18n is extracted to `telegram-bot-i18n.js`. The callback routing switch (`_handleCallback`) is a flat prefix-based dispatch today. Phase 2 replaces it with a SCREENS-based registry while keeping all 15 existing callback prefixes functional as fallbacks for old buttons in chat history.

**Primary recommendation:** Structure Phase 2 as four sequential waves: (1) SCREENS registry + callback router rewrite + screenMsgId removal, (2) persistent keyboard redesign + context header injection, (3) setMyCommands + slash command pruning, (4) sendMessageDraft streaming migration. Each wave is independently testable.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| NAV-01 | User can send a message to Claude in <=2 taps from any state | Write button in persistent keyboard + auto-session logic in _handleWriteButton already exists; SCREENS redesign + context header make it discoverable |
| NAV-02 | Every inline keyboard screen has a Back button one level up | SCREENS registry `parent` pointer generates Back row automatically |
| NAV-03 | All navigation actions edit existing screen message in place | Removing screenMsgId and using cbq.message.message_id as editMsgId makes this structural |
| NAV-04 | Every screen shows context header with active project/chat | _buildContextHeader() utility injected at start of every screen render |
| NAV-05 | Slash commands /project and /chat removed from menu | setMyCommands called at bot start + device pairing with minimal command list |
| NAV-06 | User can return to Main Menu from any screen in 1 tap | SCREENS parent chain always terminates at MAIN; persistent keyboard Menu button always routes to MAIN |
| KB-01 | Persistent keyboard shows active project/chat name | Reply keyboard rebuilt on project/chat change with dynamic button labels |
| KB-02 | Write button always visible and routes correctly | _handleWriteButton() already implements smart routing; just needs consistent keyboard resend |
| KB-03 | setMyCommands updated to 3-5 commands only | Call setMyCommands at bot start with /start, /help, /cancel, /status |
| ARCH-02 | SCREENS registry with handler + parent; Back auto-generated | Core architectural change: SCREENS object, renderScreen(), navigateTo() |
| ARCH-03 | screenMsgId/screenChatId removed; editMsgId from callback anchor | _handleCallback passes cbq.message.message_id to screen handlers |
| ARCH-04 | All legacy callback_data prefixes remain functional as fallback | Prefix-based routing kept as fallthrough after SCREENS lookup |
| STREAM-01 | sendMessageDraft replaces editMessageText for streaming | TelegramProxy._sendProgress() rewritten to use sendMessageDraft + sendMessage finalization |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **No new npm dependencies** -- zero build step philosophy
- **No TypeScript** -- vanilla JS throughout
- **No build tools** -- no webpack, vite, esbuild, rollup
- **telegram-bot.js can be split** -- the single-file constraint is relaxed for the bot
- **WebSocket protocol must not break** -- client/server message shapes are sacred
- **SQLite rules** -- WAL mode stays, ALTER TABLE only, no DROP TABLE
- **Backward compatibility** -- existing paired devices must work without re-pairing
- **Security** -- data/auth.json never exposed, WORKDIR path traversal protection stays
- **Never typecast. Never use `as`.**

## Architecture Patterns

### Current Screen Hierarchy (from code audit)

The current `_handleCallback` routes by prefix. Here is the complete screen tree with current callback_data:

```
MAIN MENU (m:menu)
  |-- Projects list (p:list, p:list:N)
  |     |-- Project detail (p:sel:N)
  |           |-- Chats for project (c:list:0)
  |           |-- Files browser (f:.)
  |           |-- Git log (pm:git)
  |           |-- Diff (pm:diff)
  |           |-- Tasks (t:list)
  |           |-- New chat (c:new)
  |           |-- New task (t:new)
  |-- Chats list (c:list:0)
  |     |-- Chat select (ch:N)
  |           |-- Dialog overview (d:overview)
  |                 |-- Full message list (d:all:N)
  |                 |-- Full single message (d:full:N)
  |                 |-- Compose (cm:compose)
  |-- Tasks (t:list, t:all)
  |     |-- New task (t:new -> AWAITING_TASK_TITLE)
  |     |-- Skip desc (t:skip)
  |-- Status (m:status)
  |-- Tunnel (tn:menu)
  |     |-- Start (tn:start), Stop (tn:stop), Status (tn:status)
  |-- Settings (s:menu)
        |-- Notify toggle (s:notify:on/off)
        |-- Unlink confirm (s:unlink, s:unlink:yes)
        |-- Forum setup (s:forum), disconnect (s:forum:off)
```

Forum-mode screens (separate tree, not touched in Phase 2):
```
fm:compose, fm:diff, fm:files, fm:history, fm:new, fm:info, fm:last
fs:N (forum session select)
fa:project:N, fa:open:N (forum activity)
```

### Proposed SCREENS Registry

```javascript
const SCREENS = {
  MAIN:         { handler: '_screenMainMenu',       parent: null },
  PROJECTS:     { handler: '_screenProjects',        parent: 'MAIN' },
  PROJECT:      { handler: '_screenProjectSelect',   parent: 'PROJECTS' },
  CHATS:        { handler: '_screenChats',           parent: null }, // parent is PROJECT if projectWorkdir, else MAIN
  DIALOG:       { handler: '_screenDialog',          parent: 'CHATS' },
  DIALOG_FULL:  { handler: '_screenDialogFull',      parent: 'DIALOG' },
  COMPOSE:      { handler: '_handleCompose',         parent: 'DIALOG' },
  FILES:        { handler: '_screenFiles',           parent: null }, // parent is PROJECT if projectWorkdir, else MAIN
  TASKS:        { handler: '_screenTasks',           parent: null }, // parent is PROJECT if projectWorkdir, else MAIN
  STATUS:       { handler: '_screenStatus',          parent: 'MAIN' },
  TUNNEL:       { handler: '_cmdTunnel',             parent: 'MAIN' },
  SETTINGS:     { handler: '_screenSettings',        parent: 'MAIN' },
};
```

Key design choice: some screens have **dynamic parents** (CHATS can be reached from PROJECT or MAIN). The `parent` field can be a string OR a function `(ctx) => screenName`. This handles the "back from chats goes to project detail, or to main if no project" case.

### Callback Data Format

**New format:** `scr:{SCREEN_NAME}:{optional_param}` for screen navigation, keep existing prefixes for actions.

But this exceeds 64 bytes for compound paths. Better approach -- keep the existing short prefixes, just add a lookup table:

```javascript
// callback_data -> SCREENS key mapping
const CALLBACK_TO_SCREEN = {
  'm:menu':     'MAIN',
  'p:list':     'PROJECTS',
  // p:sel:N stays as-is, parsed by handler
  'c:list:':    'CHATS',
  'd:overview': 'DIALOG',
  'd:all:':     'DIALOG_FULL',
  't:list':     'TASKS',
  'm:status':   'STATUS',
  'tn:menu':    'TUNNEL',
  's:menu':     'SETTINGS',
};
```

This preserves backward compatibility (old buttons still use old prefixes) while adding the SCREENS metadata layer on top. The `parent` chain is now a pure data lookup -- not encoded in callback_data at all.

### Back Button Generation

```javascript
_buildBackButton(screenKey, ctx) {
  let parentKey;
  const screen = SCREENS[screenKey];
  if (typeof screen.parent === 'function') {
    parentKey = screen.parent(ctx);
  } else {
    parentKey = screen.parent;
  }
  if (!parentKey) return null; // MAIN has no back
  // Find the callback_data that routes to parentKey
  const parentCb = Object.entries(CALLBACK_TO_SCREEN)
    .find(([, v]) => v === parentKey)?.[0] || 'm:menu';
  return { text: this._t('btn_back'), callback_data: parentCb };
}
```

Every screen handler appends the back button row automatically. The handler does NOT hard-code it.

### screenMsgId Removal Pattern

**Before (current):**
```javascript
// In _handleCallback:
ctx.screenMsgId = msgId;         // <-- global slot
ctx.screenChatId = chatId;

// In screen handler:
if (ctx.screenMsgId && ctx.screenChatId === chatId) {
  await this._editScreen(chatId, ctx.screenMsgId, text, keyboard);
} else {
  await this._showScreen(chatId, userId, text, keyboard);
}
```

**After (Phase 2):**
```javascript
// In _handleCallback:
// DO NOT set ctx.screenMsgId -- it no longer exists
const editMsgId = msgId;  // from cbq.message.message_id

// In screen handler (receives editMsgId parameter):
async _screenMainMenu(chatId, userId, { editMsgId } = {}) {
  // ...build text + keyboard...
  if (editMsgId) {
    await this._editScreen(chatId, editMsgId, text, keyboard);
  } else {
    await this._showScreen(chatId, userId, text, keyboard);
  }
}
```

This eliminates the stale-slot problem structurally. When called from a slash command, `editMsgId` is null/undefined, so a new message is sent. When called from a callback button tap, `editMsgId` is always the message the button belongs to.

**Migration note:** Remove `screenMsgId` and `screenChatId` from `_getContext()` defaults. All 20+ screen methods must accept `{ editMsgId }` parameter. The `_showScreen` and `_editScreen` methods remain, but `_showScreen` no longer writes to `ctx.screenMsgId`.

### Context Header

Every screen message starts with a context line:

```javascript
_buildContextHeader(ctx) {
  const parts = [];
  if (ctx.projectWorkdir) {
    const name = ctx.projectWorkdir.split('/').filter(Boolean).pop();
    parts.push(this._t('header_project', { name: this._escHtml(name) }));
  }
  if (ctx.sessionId) {
    const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
    if (sess?.title) {
      parts.push(this._t('header_chat', { title: this._escHtml(sess.title.substring(0, 30)) }));
    }
  }
  if (parts.length === 0) return this._t('header_none') + '\n';
  return parts.join(' / ') + '\n';
}
```

Injected at the start of every screen's text. New i18n keys: `header_project`, `header_chat`, `header_none` (e.g., "No project selected").

### Persistent Reply Keyboard

**Current (static, 3 buttons):**
```javascript
keyboard: [
  [{ text: this._t('kb_menu') }, { text: this._t('kb_write') }, { text: this._t('kb_status') }]
],
resize_keyboard: true,
is_persistent: true,
```

**Proposed (dynamic, context-aware):**
```javascript
_buildReplyKeyboard(ctx) {
  const row1 = [];
  // Write button -- always present
  if (ctx.sessionId) {
    const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
    const chatName = (sess?.title || this._t('chat_untitled')).substring(0, 20);
    row1.push({ text: `${this._t('kb_write')} ${chatName}` });
  } else {
    row1.push({ text: this._t('kb_write') });
  }
  row1.push({ text: this._t('kb_menu') });

  const row2 = [];
  if (ctx.projectWorkdir) {
    const pName = ctx.projectWorkdir.split('/').filter(Boolean).pop();
    row2.push({ text: `${this._t('kb_project_prefix')} ${pName}`.substring(0, 30) });
  }
  row2.push({ text: this._t('kb_status') });

  return {
    keyboard: row2.length > 1 ? [row1, row2] : [row1],
    resize_keyboard: true,
    is_persistent: true,
  };
}
```

**When to resend:** Only when project or chat changes (project select, chat select, new chat creation, session activation). NOT on every navigation step. The keyboard is sent as `reply_markup` on a `sendMessage` call -- it cannot be attached to `editMessageText`.

**Critical:** Because `editMessageText` does not accept `reply_markup: ReplyKeyboardMarkup`, the reply keyboard can only be updated when a NEW message is sent. Navigation edits do not change the keyboard. The keyboard updates happen on: (1) pairing, (2) project selection, (3) chat selection, (4) Claude response finalization (`sendMessage` at end of streaming), (5) `/start`.

**Persistent keyboard button matching:** The bot currently intercepts reply keyboard presses by comparing text: `if (text === this._t('kb_write'))`. With dynamic labels (including chat/project names), the matching must use prefix matching:
```javascript
if (text.startsWith(this._t('kb_write'))) { return this._handleWriteButton(chatId, userId); }
```

### 2-Tap Flow

**Returning user (has active project + session):**
1. User types anything (or taps Write button) -> sent directly to Claude (0-1 taps)

**Returning user (has project, no session):**
1. User taps Write -> `_handleWriteButton` shows chats list (1 tap)
2. User taps a chat -> compose mode, type message (2 taps)

**New user (nothing selected):**
1. `/start` or first message -> `_handleWriteButton` shows projects list (1 tap)
2. User taps project -> auto-shows chats (1 tap)
3. User taps chat -> compose ready (2 taps total after project/chat selection)

The key: `_handleWriteButton` already implements this smart routing. The improvement is making the Write button prominent in the persistent keyboard and adding the context header so users know what's active.

### setMyCommands

```javascript
async _setCommands() {
  await this._callApi('setMyCommands', {
    commands: [
      { command: 'start', description: this._t('cmd_start_desc') },
      { command: 'help', description: this._t('cmd_help_desc') },
      { command: 'cancel', description: this._t('cmd_cancel_desc') },
      { command: 'status', description: this._t('cmd_status_desc') },
    ],
  });
}
```

Called once at bot start (after `getMe`). The existing `/project`, `/chat`, `/projects`, `/chats`, `/compose` etc. still WORK as commands (the handler code stays), they just don't appear in the "/" menu. This is non-breaking.

## sendMessageDraft Integration

### API Signature (Bot API 9.5, verified)

```
POST https://api.telegram.org/bot{token}/sendMessageDraft

Parameters:
  chat_id:            int    (required) -- target chat
  draft_id:           int    (required) -- unique, non-zero; same ID = animated update
  text:               string (required) -- 1-4096 chars
  message_thread_id:  int    (optional) -- for forum topics
  parse_mode:         string (optional) -- HTML, Markdown, MarkdownV2
  entities:           array  (optional) -- message entities

Returns: boolean (true on success)
```

**Confidence: HIGH** -- verified via aiogram 3.26 docs, MTKruto docs, and Bot API 9.5 changelog.

### Availability

As of Bot API 9.5 (March 1, 2026): available to ALL bots, in ALL chat types (private chats, groups, supergroups, forum topics). Previous restriction (private chats with topics only) was lifted.

**Confidence: HIGH** -- Bot API 9.5 changelog + aibase news article confirming universal availability.

### Finalization Flow

The Telegram docs describe `sendMessageDraft` as streaming partial content. The draft is visible to the user as it updates. When generation completes:

1. Call `sendMessage` with the final complete text -- this creates a permanent message and the draft disappears.
2. Alternatively, if using `reply_markup` (inline buttons), `sendMessage` is the only option since `sendMessageDraft` does not have an `inline_keyboard` parameter in the standard API.

**Recommended flow for this project:**

```javascript
// In TelegramProxy:
async _sendProgress() {
  // Use sendMessageDraft instead of editMessageText
  await this._bot._callApi('sendMessageDraft', {
    chat_id: this._chatId,
    draft_id: this._draftId,  // assigned once per response, non-zero int
    text: preview.slice(0, 4096),
    parse_mode: 'HTML',
    ...(this._threadId ? { message_thread_id: this._threadId } : {}),
  });
}

async _finalize(data) {
  // Finalize by sending a real message (draft auto-disappears)
  const finalMsg = await this._tgSend(finalHtml, {
    parse_mode: 'HTML',
    reply_markup: JSON.stringify({ inline_keyboard: doneButtons }),
  });
}
```

**draft_id strategy:** Use `Date.now() % 2147483647` or an incrementing counter per chat. Must be non-zero. Reusing the same `draft_id` within a chat animates the transition.

**Confidence: MEDIUM** -- The finalization via `sendMessage` is the documented pattern from community implementations and the openclaw codebase. The exact "draft disappears when sendMessage is called" behavior is inferred from the streaming pattern, not explicitly documented in the official API.

### Migration from editMessageText

Current `TelegramProxy._sendProgress()` in server.js:
1. Sends "Thinking..." message, stores `_progressMsgId`
2. Periodically edits that message with growing content (debounced 3s)
3. On finalize: deletes progress message, sends final response as new message

New flow with `sendMessageDraft`:
1. Send initial "Thinking..." as a regular `sendMessage` with Stop/Menu buttons -- keep `_progressMsgId`
2. As tokens arrive, call `sendMessageDraft` (replaces `editMessageText` on progress msg)
3. On finalize: delete "Thinking..." message, then call `sendMessage` with final text + done buttons

**Key difference:** `sendMessageDraft` has no rate limit concern (unlike editMessageText at ~1 edit/sec). The debounce timer can be reduced from 3s to 200-500ms for much smoother streaming. But the draft itself cannot carry inline keyboard buttons, so the "Thinking..." message with Stop/Menu buttons should remain a separate real message that gets deleted on finalization.

**Alternative approach (simpler):** Use `sendMessageDraft` for the streaming content (no "Thinking" message at all), then finalize with `sendMessage` + buttons. This eliminates the progress message management entirely.

### Fallback

If `sendMessageDraft` fails (e.g., API version mismatch, unexpected error), fall back to the current `editMessageText` pattern. Wrap the call in try/catch with a `_usesDraftStreaming` flag that flips to false on first failure:

```javascript
if (this._usesDraftStreaming) {
  try {
    await this._bot._callApi('sendMessageDraft', { ... });
  } catch (err) {
    this._usesDraftStreaming = false;
    // Fall back to editMessageText
    await this._sendProgressLegacy();
  }
}
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Callback routing | Custom nested if/switch | SCREENS registry + CALLBACK_TO_SCREEN map | 15 prefixes today; adding more compounds the problem |
| Back button placement | Hard-coded per screen | Auto-generated from SCREENS[key].parent | Eliminates dead-end screens by construction |
| Context header | Copy-paste per screen | _buildContextHeader(ctx) utility | One place to update format, guaranteed consistency |
| Keyboard text matching | Exact string match | Prefix match on known keyboard labels | Dynamic button labels (with project/chat names) break exact match |
| Draft streaming debounce | Custom setTimeout chain | Rate-limited wrapper with auto-backoff | The current pattern already handles 429, just needs adaptation |

## Common Pitfalls

### Pitfall 1: editMessageText cannot set ReplyKeyboardMarkup
**What goes wrong:** Developer tries to update the persistent reply keyboard during a navigation edit. The API silently ignores `reply_markup: ReplyKeyboardMarkup` on `editMessageText`.
**Why it happens:** Only `sendMessage` can set/change/remove a ReplyKeyboardMarkup. `editMessageText` only accepts `InlineKeyboardMarkup`.
**How to avoid:** Track when the keyboard needs updating (project/chat change). On those specific actions, send a brief notification message with the new keyboard attached, or defer the keyboard update to the next `sendMessage` call.
**Warning signs:** Keyboard shows stale project/chat name after selection.

### Pitfall 2: Old callback_data in chat history
**What goes wrong:** User taps a button from a message sent days ago. If the new router doesn't handle old prefixes, `answerCallbackQuery` is never called -- permanent spinner.
**Why it happens:** Telegram buttons are permanent in chat history. There is no way to update buttons on old messages retroactively.
**How to avoid:** All 15 existing callback prefixes (`ask`, `c`, `ch`, `cm`, `d`, `f`, `fa`, `fm`, `fs`, `m`, `p`, `pm`, `s`, `t`, `tn`) remain in the router as fallthrough handlers. Add a catch-all at the end that calls `answerCallbackQuery` with "Please use the menu to continue."
**Warning signs:** Users report frozen buttons on old messages.

### Pitfall 3: Dynamic parent resolution failure
**What goes wrong:** CHATS screen's parent should be PROJECT when `ctx.projectWorkdir` is set, or MAIN when not. If the parent function reads stale context, back goes to the wrong place.
**Why it happens:** Navigation actions mutate `ctx.projectWorkdir` before the back chain is evaluated.
**How to avoid:** Back button is generated at RENDER TIME (when the screen is drawn), not at navigation time. The parent function reads current context state at render.
**Warning signs:** Back from chats goes to main menu even though a project is active.

### Pitfall 4: Reply keyboard persistence bugs across clients
**What goes wrong:** On some Telegram client versions, `is_persistent: true` does not keep the keyboard visible after the user sends a text message. The keyboard collapses.
**Why it happens:** Known client-side bug documented at bugs.telegram.org/c/25708.
**How to avoid:** Do not rely solely on keyboard visibility for state communication. The inline keyboard context header serves as the primary state indicator. The reply keyboard is a convenience, not the only way to know what's active.
**Warning signs:** Users on iOS report keyboard disappearing after sending a message.

### Pitfall 5: sendMessageDraft parse_mode failures
**What goes wrong:** `sendMessageDraft` with `parse_mode: 'HTML'` fails on malformed HTML in streaming content (unclosed tags, unescaped `<`).
**Why it happens:** Claude's response is being streamed token-by-token. Mid-stream, HTML is guaranteed to be malformed.
**How to avoid:** Do NOT use `parse_mode: 'HTML'` with `sendMessageDraft` during streaming. Send plain text only. Apply HTML formatting only in the final `sendMessage` call. This matches the current behavior where `_sendProgress` escapes HTML but `_finalize` applies `_mdToHtml`.
**Warning signs:** Draft streaming silently fails, user sees nothing, then gets the full response at once.

### Pitfall 6: screenMsgId removal breaks slash command screens
**What goes wrong:** Slash commands like `/start`, `/help`, `/status` currently call screen methods that check `ctx.screenMsgId`. After removal, these need to pass `editMsgId: null` to force a new message.
**Why it happens:** The screen handlers are shared between callback invocations (have editMsgId) and slash command invocations (no editMsgId).
**How to avoid:** All screen handlers must accept `{ editMsgId }` as an options parameter with a null default. Slash command callers pass nothing (or explicitly `{ editMsgId: null }`). Callback callers pass `{ editMsgId: cbq.message.message_id }`.
**Warning signs:** Slash commands try to edit a non-existent message and throw errors.

### Pitfall 7: Forum mode callback routing collision
**What goes wrong:** Phase 2 refactors the callback router, but forum mode callbacks (`fm:`, `fa:`, `fs:`) have a special guard that intercepts `m:menu` and `p:list` inside project topics. This guard must survive the refactor.
**Why it happens:** The forum topic guard (lines 1411-1423 in current code) runs before the main router and redirects certain global actions to forum-specific screens.
**How to avoid:** The forum guard block at the top of `_handleCallback` is NOT part of the SCREENS refactor. It stays as-is. Phase 3 (Forum extraction) will move it.
**Warning signs:** Tapping "Back to Menu" in a forum project topic opens the global main menu instead of the forum project info.

## Code Examples

### SCREENS Registry Definition

```javascript
// Source: designed for this project based on current screen hierarchy
const SCREENS = {
  MAIN: {
    parent: null,
    handler: '_screenMainMenu',
  },
  PROJECTS: {
    parent: 'MAIN',
    handler: '_screenProjects',
  },
  PROJECT: {
    parent: 'PROJECTS',
    handler: '_screenProjectSelect',
  },
  CHATS: {
    parent: (ctx) => ctx.projectWorkdir ? 'PROJECT' : 'MAIN',
    handler: '_screenChats',
  },
  DIALOG: {
    parent: 'CHATS',
    handler: '_screenDialog',
  },
  DIALOG_FULL: {
    parent: 'DIALOG',
    handler: '_screenDialogFull',
  },
  FILES: {
    parent: (ctx) => ctx.projectWorkdir ? 'PROJECT' : 'MAIN',
    handler: '_screenFiles',
  },
  TASKS: {
    parent: (ctx) => ctx.projectWorkdir ? 'PROJECT' : 'MAIN',
    handler: '_screenTasks',
  },
  STATUS: {
    parent: 'MAIN',
    handler: '_screenStatus',
  },
  TUNNEL: {
    parent: 'MAIN',
    handler: '_cmdTunnel',
  },
  SETTINGS: {
    parent: 'MAIN',
    handler: '_screenSettings',
  },
};
```

### Callback Router Rewrite

```javascript
// Source: designed for this project
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

  try {
    // Reset task input state on any non-task navigation
    if ((ctx.state === FSM_STATES.AWAITING_TASK_TITLE ||
         ctx.state === FSM_STATES.AWAITING_TASK_DESCRIPTION) &&
        !data.startsWith('t:')) {
      ctx.state = FSM_STATES.IDLE;
      ctx.stateData = null;
    }

    // Forum topic guard (stays as-is until Phase 3)
    if (this._currentThreadId) {
      // ... existing forum guard logic ...
    }

    // ask_user callbacks
    if (data.startsWith('ask:')) {
      return this._handleAskCallback(chatId, userId, msgId, data);
    }

    // Route by prefix (preserves all legacy callback_data)
    const opts = { editMsgId: msgId };
    if (data === 'm:menu')       return this._screenMainMenu(chatId, userId, opts);
    if (data === 'm:status')     return this._screenStatus(chatId, userId, opts);
    if (data === 'm:noop')       return;
    if (data === 'p:list' || data.startsWith('p:list:'))
      return this._screenProjects(chatId, userId, data, opts);
    if (data.startsWith('p:sel:'))
      return this._screenProjectSelect(chatId, userId, data, opts);
    // ... (all existing prefix routes, each passing opts) ...

    // Catch-all for unrecognized callbacks (from very old messages)
    // answerCallbackQuery in finally block handles the spinner
  } catch (err) {
    this.log.error(`[telegram] Callback error: ${err.message}`);
    await this._editScreen(chatId, msgId, this._t('error_prefix', { msg: this._escHtml(err.message) }),
      [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
  } finally {
    this._answerCallback(cbq.id);
  }
}
```

### sendMessageDraft Streaming (TelegramProxy in server.js)

```javascript
// Source: designed for this project based on Bot API 9.5 docs
class TelegramProxy {
  constructor(bot, chatId, sessionId, userId, threadId) {
    // ... existing constructor ...
    this._draftId = (Date.now() % 2147483646) + 1; // non-zero int
    this._usesDraftStreaming = true;
  }

  async _sendProgress() {
    this._updateTimer = null;
    if (this._finished) return;
    this._lastEditAt = Date.now();

    let preview = this._buffer;
    if (preview.length > 3500) {
      preview = '...\n' + preview.slice(-3500);
    }
    // Plain text only during streaming (no parse_mode -- avoids malformed HTML)
    const text = preview.slice(0, 4096);

    if (this._usesDraftStreaming) {
      try {
        const params = {
          chat_id: this._chatId,
          draft_id: this._draftId,
          text: text || ' ', // must be non-empty
        };
        if (this._threadId) params.message_thread_id = this._threadId;
        await this._bot._callApi('sendMessageDraft', params);
        return;
      } catch (err) {
        // Fallback to editMessageText on failure
        this._usesDraftStreaming = false;
        this._bot.log.warn(`[TelegramProxy] sendMessageDraft failed, falling back: ${err.message}`);
      }
    }

    // Legacy fallback: editMessageText
    // ... existing _sendProgress logic ...
  }

  async _finalize(data) {
    if (this._finished) return;
    this._finished = true;
    this._stopTyping();
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }

    // Delete "Thinking..." message (only if using legacy mode)
    if (!this._usesDraftStreaming && this._progressMsgId) {
      try {
        await this._bot._callApi('deleteMessage', {
          chat_id: this._chatId, message_id: this._progressMsgId
        });
      } catch {}
    }
    // If using draft streaming, delete the thinking message too
    if (this._progressMsgId) {
      try {
        await this._bot._callApi('deleteMessage', {
          chat_id: this._chatId, message_id: this._progressMsgId
        });
      } catch {}
      this._progressMsgId = null;
    }

    // Send final message (draft auto-resolves, permanent message appears)
    const finalHtml = this._bot._mdToHtml(this._buffer);
    // ... existing finalization with sendMessage + done buttons ...
  }
}
```

### Persistent Keyboard Rebuild

```javascript
// Source: designed for this project
_buildReplyKeyboard(ctx) {
  const row1 = [];
  // Write button always first
  if (ctx.sessionId) {
    const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
    const chatName = (sess?.title || this._t('chat_untitled')).substring(0, 18);
    row1.push({ text: `${this._t('kb_write')} · ${chatName}` });
  } else {
    row1.push({ text: this._t('kb_write') });
  }
  row1.push({ text: this._t('kb_menu') });

  const rows = [row1];
  // Second row: project context + status
  if (ctx.projectWorkdir) {
    const pName = ctx.projectWorkdir.split('/').filter(Boolean).pop();
    rows.push([
      { text: `📁 ${pName}`.substring(0, 28) },
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

// Called when context changes (project select, chat select, pairing, /start)
async _sendReplyKeyboard(chatId, ctx, message) {
  await this._sendMessage(chatId, message, {
    reply_markup: JSON.stringify(this._buildReplyKeyboard(ctx)),
  });
}
```

## Legacy Callback Prefix Inventory

All 15 prefixes that MUST remain functional in `_handleCallback`:

| Prefix | Routes to | Example | Count in code |
|--------|-----------|---------|---------------|
| `m:` | Main menu, status, noop | `m:menu`, `m:status`, `m:noop` | ~30 |
| `p:` | Project list, selection | `p:list`, `p:list:2`, `p:sel:0` | ~10 |
| `pm:` | Project actions | `pm:git`, `pm:diff`, `pm:back` | ~8 |
| `c:` | Chat list, new chat | `c:list:0`, `c:new` | ~12 |
| `ch:` | Chat selection | `ch:3` | ~2 |
| `cm:` | Chat menu, compose | `cm:compose`, `cm:more`, `cm:full`, `cm:stop`, `cm:cancel` | ~15 |
| `d:` | Dialog routes | `d:overview`, `d:all:0`, `d:full:42`, `d:view:id`, `d:compose:id`, `d:clear_attach` | ~10 |
| `f:` | File browser | `f:.`, `f:src`, `f:c:3` | ~6 |
| `t:` | Tasks | `t:list`, `t:all`, `t:new`, `t:skip` | ~8 |
| `s:` | Settings | `s:menu`, `s:notify:on`, `s:unlink`, `s:unlink:yes`, `s:forum`, `s:forum:off` | ~8 |
| `tn:` | Tunnel | `tn:menu`, `tn:start`, `tn:stop`, `tn:status` | ~5 |
| `ask:` | Ask-user options | `ask:0`, `ask:skip` | ~3 |
| `fm:` | Forum actions | `fm:compose`, `fm:diff`, `fm:files`, `fm:history`, `fm:new`, `fm:info`, `fm:last` | ~25 |
| `fs:` | Forum session select | `fs:0` | ~2 |
| `fa:` | Forum activity | `fa:project:123`, `fa:open:sid` | ~3 |

**Total: 15 distinct prefixes.** All must pass through to their existing handlers during and after migration.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `editMessageText` for streaming | `sendMessageDraft` | Bot API 9.3 (Dec 2025), universal in 9.5 (Mar 2026) | Eliminates rate-limit freezes, native streaming animation |
| `is_persistent` reply keyboard only | `is_persistent` + `KeyboardButton.style` | Bot API 9.4 (Feb 2026) | Visual hierarchy on reply keyboard buttons (primary/success/danger) |
| Topics required for draft streaming | Universal `sendMessageDraft` access | Bot API 9.5 (Mar 2026) | Works in private chats, groups, supergroups, and forum topics |

**Deprecated/outdated:**
- `editMessageText` polling for streaming: still works but `sendMessageDraft` is strictly superior (no rate limits, native animation)
- `KeyboardButton.style: primary` for Write button: available but MEDIUM confidence -- defer to v2 per REQUIREMENTS.md

## Open Questions

1. **sendMessageDraft with parse_mode during streaming**
   - What we know: The API accepts `parse_mode` parameter. Mid-stream HTML will be malformed.
   - What's unclear: Does Telegram gracefully handle malformed HTML in drafts (showing what it can), or does it reject the entire call?
   - Recommendation: Use plain text during streaming, HTML only on finalization. Test with a real streaming session to validate.

2. **sendMessageDraft finalization exact behavior**
   - What we know: Calling `sendMessage` after streaming creates the permanent message. Community implementations do this.
   - What's unclear: Does the draft disappear automatically when `sendMessage` is called, or does it linger? Is there a `deleteDraft` method needed?
   - Recommendation: Test empirically. If draft lingers, an explicit `sendMessageDraft` with empty text or a new `draft_id` may be needed.

3. **Reply keyboard update race condition**
   - What we know: `editMessageText` cannot set ReplyKeyboardMarkup. Keyboard updates require `sendMessage`.
   - What's unclear: If a project selection happens via inline button (edit-in-place), and the keyboard needs updating, do we send an extra message just for the keyboard?
   - Recommendation: Use `answerCallbackQuery` with toast for immediate feedback, then piggyback the keyboard update on the next `sendMessage` (e.g., the Claude response or a compose prompt). If needed, send a brief "Project changed to X" notification message with the new keyboard.

## Sources

### Primary (HIGH confidence)
- [Telegram Bot API Reference](https://core.telegram.org/bots/api) -- sendMessageDraft parameters, editMessageText, ReplyKeyboardMarkup constraints
- [Bot API 9.5 Changelog](https://core.telegram.org/bots/api-changelog) -- sendMessageDraft universal access, March 1 2026
- [aiogram 3.26 -- SendMessageDraft](https://docs.aiogram.dev/en/dev-3.x/api/methods/send_message_draft.html) -- full parameter list with types
- [MTKruto -- sendMessageDraft](https://mtkru.to/methods/sendmessagedraft/) -- parameter verification
- Direct code audit of `telegram-bot.js` (3962 lines) and `server.js` TelegramProxy class

### Secondary (MEDIUM confidence)
- [openclaw/openclaw#32469](https://github.com/openclaw/openclaw/issues/32469) -- sendMessageDraft 9.5 universal access confirmation
- [openclaw/openclaw#32180](https://github.com/openclaw/openclaw/issues/32180) -- sendMessageDraft streaming pattern
- [openclaw/openclaw#31061](https://github.com/openclaw/openclaw/issues/31061) -- sendMessageDraft community discussion and patterns
- [aibase news -- Bot API 9.5](https://news.aibase.com/news/25881) -- confirmation of universal availability including groups/supergroups
- [callback_data 64-byte limit](https://seroperson.me/2025/02/05/enhanced-telegram-callback-data/) -- server-side state pattern
- [ReplyKeyboardMarkup is_persistent bug](https://bugs.telegram.org/c/25708) -- client-side persistence issues

### Tertiary (LOW confidence)
- sendMessageDraft finalization behavior (draft auto-disappearing on sendMessage) -- inferred from community implementations, not explicitly documented

## Metadata

**Confidence breakdown:**
- SCREENS architecture: HIGH -- derived directly from code audit of all 15 callback prefixes and 12 screen methods
- screenMsgId removal: HIGH -- the pattern of passing editMsgId from cbq.message.message_id is well-established in the Telegram ecosystem
- Persistent keyboard redesign: MEDIUM -- the edit-message-cannot-set-reply-keyboard limitation is confirmed, but the UX flow for updating it needs empirical testing
- sendMessageDraft: HIGH for API availability, MEDIUM for finalization flow specifics
- Legacy callback backward compat: HIGH -- all 15 prefixes inventoried from code

**Research date:** 2026-03-28
**Valid until:** 2026-04-28 (stable -- Telegram Bot API changes are infrequent within minor versions)
