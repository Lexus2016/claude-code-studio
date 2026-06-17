# Phase 1: Foundation - Research

**Researched:** 2026-03-28
**Domain:** Telegram bot refactoring -- i18n extraction + finite state machine migration
**Confidence:** HIGH

## Summary

Phase 1 is a purely structural refactoring of `telegram-bot.js` (4693 lines) that delivers two changes: (1) extract the `BOT_I18N` object (lines 42-825, three language dictionaries totaling ~273 keys each) into a separate `telegram-bot-i18n.js` module, and (2) replace the three ad-hoc state flags (`ctx.pendingInput`, `ctx.pendingAskRequestId`, `ctx.composing`) with a single explicit `ctx.state` enum field and a `ctx.stateData` companion object.

The i18n extraction is mechanical -- move a `const` object to a new file, export it, import it in the bot. The FSM migration is the critical task: every code path that reads or writes these three flags must be updated atomically, including `server.js` which directly accesses `bot._getContext(userId)` and writes `ctx.pendingAskRequestId` in three locations (lines 4938-4939, 1458-1459, 5111-5112). Additionally, `answerCallbackQuery` must be moved from its current fire-and-forget position (line 2153, before the try block) into a `finally` block so it is guaranteed to execute even when callback handlers throw.

**Primary recommendation:** Ship i18n extraction and FSM migration as one atomic commit. The FSM migration touches `server.js` coordination anyway; splitting creates a window where half-migrated state fields coexist, which is the exact bug class Phase 1 eliminates.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ARCH-01 | i18n translation data extracted to separate file `telegram-bot-i18n.js` (removes ~825 lines from main bot file) | BOT_I18N is a pure data object (lines 42-825) with no logic dependencies. `_t()` method (line 861) is the single consumer. Extraction is a mechanical move + require/import. |
| FSM-01 | User state represented as single explicit enum field (`ctx.state`) with values: IDLE, AWAITING_TASK_TITLE, AWAITING_TASK_DESCRIPTION, AWAITING_ASK_RESPONSE, COMPOSING | Currently three separate fields: `pendingInput` (string/null), `pendingAskRequestId` (string/null), `composing` (boolean). All set/read scattered across 25+ locations. Mapped exhaustively below. |
| FSM-02 | No pending input state can silently intercept text meant for Claude -- task creation and ask_user states are mutually exclusive | Current bug: `pendingAskRequestId` check (line 1344) runs before `pendingInput` check (line 1904). If both are set simultaneously (e.g., ask_user arrives while user is mid-task-creation), ask_user wins silently. FSM makes this impossible: single enum = only one active state. |
| FSM-03 | Any slash command resets `ctx.state` to IDLE before processing (cancels pending input) | Currently slash commands (`_handleCommand`, line 1451) do NOT reset `pendingInput` or `composing`. A user in AWAITING_TASK_TITLE who types `/status` gets a task titled "/status". Fix: add `ctx.state = 'IDLE'` at _handleCommand entry. |
| FSM-04 | `answerCallbackQuery` called in `finally` block unconditionally | Currently called at line 2153, BEFORE the try block. If `_answerCallback` itself succeeds but a handler inside the try block throws, the callback IS answered (current code is fire-and-forget async). However, moving it to finally is still correct: (a) it guarantees execution even if early-return paths are added, (b) it matches the documented requirement. |
| FSM-05 | Existing paired devices and in-flight sessions continue working after migration (zero re-pairing) | `_getContext()` (line 4419) creates new context objects lazily. Old contexts in `_userContext` Map have old field names. Migration: `_getContext()` must auto-migrate: if old fields exist, map them to new `ctx.state` + `ctx.stateData`, delete old fields. `_restoreDeviceContext` (line 4343) only restores `sessionId` and `projectWorkdir` from DB -- these are unchanged. |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

These directives from CLAUDE.md constrain all implementation decisions:

- **No build tools** -- zero webpack/vite/esbuild/rollup, ever
- **No TypeScript** -- vanilla JS throughout
- **No new npm dependencies** -- zero new packages
- **No CSS frameworks** -- vanilla CSS only (less relevant for this phase)
- **public/index.html stays single file** -- not relevant to Phase 1
- **telegram-bot.js can be split into modules** -- explicitly relaxed for the bot
- **SQLite WAL mode** -- never change journal mode
- **Schema changes via ALTER TABLE only** -- no DROP TABLE
- **Never expose data/auth.json** -- security invariant
- **WebSocket protocol shapes must not change** -- `{ type: 'chat' | 'text' | 'tool_use' | 'done' | 'error' }`
- **No `as` typecasts** -- not applicable (vanilla JS)
- **Verify manually** -- no automated test suite exists

## Architecture Patterns

### Target File Structure After Phase 1

```
telegram-bot-i18n.js   -- NEW: Pure data export, ~825 lines (BOT_I18N object)
telegram-bot.js        -- MODIFIED: ~3868 lines (minus i18n, plus FSM logic)
server.js              -- MODIFIED: 3 locations where pendingAskRequestId is written
```

### Pattern 1: i18n Module as CommonJS Export

**What:** Move `BOT_I18N` object to its own file with `module.exports`.
**When to use:** Now (Phase 1).
**Why CommonJS:** The entire project uses `require()` -- no ESM.

```javascript
// telegram-bot-i18n.js
'use strict';

const BOT_I18N = {
  uk: { /* ... 273 keys ... */ },
  en: { /* ... 273 keys ... */ },
  ru: { /* ... 273 keys ... */ },
};

module.exports = BOT_I18N;
```

```javascript
// telegram-bot.js (top, replacing lines 42-825)
const BOT_I18N = require('./telegram-bot-i18n');
```

**Critical detail:** The `_t()` method (line 861) reads `this.lang` to pick the dictionary. `this.lang` is set in the constructor (line 843, default `'uk'`). The `_t()` method does NOT need to change -- it already takes `key` and `params`, looks up from `BOT_I18N[this.lang]` with fallback to `BOT_I18N.uk`. This stays identical after extraction.

### Pattern 2: Explicit State Enum (FSM)

**What:** Replace three boolean/string flags with a single string enum field.
**States:**

| State | Replaces | Text handler behavior |
|-------|----------|----------------------|
| `IDLE` | `composing=false, pendingInput=null, pendingAskRequestId=null` | Free text goes to Claude (auto-session) |
| `COMPOSING` | `composing=true` | Free text goes to Claude (explicit compose mode) |
| `AWAITING_TASK_TITLE` | `pendingInput='task_title'` | Next text becomes task title |
| `AWAITING_TASK_DESCRIPTION` | `pendingInput='task_description'` | Next text becomes task description |
| `AWAITING_ASK_RESPONSE` | `pendingAskRequestId !== null` | Next text answers Claude's ask_user question |

```javascript
// State constants (top of telegram-bot.js, after requires)
const FSM_STATES = {
  IDLE: 'IDLE',
  COMPOSING: 'COMPOSING',
  AWAITING_TASK_TITLE: 'AWAITING_TASK_TITLE',
  AWAITING_TASK_DESCRIPTION: 'AWAITING_TASK_DESCRIPTION',
  AWAITING_ASK_RESPONSE: 'AWAITING_ASK_RESPONSE',
};
```

```javascript
// Updated _getContext (replaces lines 4419-4445)
_getContext(userId) {
  if (!this._userContext.has(userId)) {
    this._userContext.set(userId, {
      sessionId: null,
      projectWorkdir: null,
      projectList: null,
      chatList: null,
      screenMsgId: null,
      screenChatId: null,
      chatPage: 0,
      filePath: null,
      filePathCache: new Map(),
      // FSM: single state field replaces composing + pendingInput + pendingAskRequestId
      state: FSM_STATES.IDLE,
      stateData: null,  // carries context: { taskId, title, workdir } or { askRequestId, askQuestions }
      // Unchanged fields
      dialogPage: 0,
      pendingAttachments: [],
      isStreaming: false,
      streamMsgId: null,
      lastNotifiedAt: 0,
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
  // Remove old fields
  delete ctx.composing;
  delete ctx.pendingInput;
  delete ctx.pendingAskRequestId;
  delete ctx.pendingAskQuestions;
  delete ctx.pendingTaskData;
}
```

### Pattern 3: answerCallbackQuery in finally Block

**What:** Move `_answerCallback` from line 2153 (before try) into the finally block.

```javascript
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
  ctx.screenMsgId = msgId;
  ctx.screenChatId = chatId;

  try {
    // ... routing logic ...
  } catch (err) {
    this.log.error(`[telegram] Callback error: ${err.message}`);
    await this._editScreen(chatId, msgId,
      this._t('error_prefix', { msg: this._escHtml(err.message) }),
      [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
  } finally {
    this._answerCallback(cbq.id);
  }
}
```

**Note:** The early returns for unauthorized/rate-limited users must also call `_answerCallback` before returning (as shown above), since the finally block only covers the try/catch.

### Pattern 4: server.js Coordination

**What:** Update all three `server.js` locations that write `ctx.pendingAskRequestId` to use the new FSM fields.

**Location 1: `_clearTelegramAskState` (server.js line 4934-4941)**
```javascript
// Before
function _clearTelegramAskState(sessionId) {
  if (!telegramBot) return;
  const task = activeTasks.get(sessionId);
  if (task?.proxy?._userId) {
    const ctx = telegramBot._getContext(task.proxy._userId);
    ctx.pendingAskRequestId = null;
    ctx.pendingAskQuestions = null;
  }
}

// After
function _clearTelegramAskState(sessionId) {
  if (!telegramBot) return;
  const task = activeTasks.get(sessionId);
  if (task?.proxy?._userId) {
    const ctx = telegramBot._getContext(task.proxy._userId);
    if (ctx.state === 'AWAITING_ASK_RESPONSE') {
      ctx.state = 'IDLE';
      ctx.stateData = null;
    }
  }
}
```

**Location 2: TelegramProxy._handleAskUser (server.js line 1456-1461)**
```javascript
// Before
if (this._userId) {
  const ctx = this._bot._getContext(this._userId);
  ctx.pendingAskRequestId = data.requestId;
  ctx.pendingAskQuestions = questions;
}

// After
if (this._userId) {
  const ctx = this._bot._getContext(this._userId);
  ctx.state = 'AWAITING_ASK_RESPONSE';
  ctx.stateData = { askRequestId: data.requestId, askQuestions: questions };
}
```

**Location 3: TelegramProxy._handleAskUserDismiss (server.js line 1505-1508)**
```javascript
// Before
if (this._userId) {
  const ctx = this._bot._getContext(this._userId);
  ctx.pendingAskRequestId = null;
  ctx.pendingAskQuestions = null;
}

// After
if (this._userId) {
  const ctx = this._bot._getContext(this._userId);
  if (ctx.state === 'AWAITING_ASK_RESPONSE') {
    ctx.state = 'IDLE';
    ctx.stateData = null;
  }
}
```

**Location 4: processTelegramChat finally block (server.js line 5110-5113)**
```javascript
// Before
if (userId && telegramBot) {
  const ctx = telegramBot._getContext(userId);
  ctx.pendingAskRequestId = null;
  ctx.pendingAskQuestions = null;
}

// After
if (userId && telegramBot) {
  const ctx = telegramBot._getContext(userId);
  if (ctx.state === 'AWAITING_ASK_RESPONSE') {
    ctx.state = 'IDLE';
    ctx.stateData = null;
  }
}
```

### Anti-Patterns to Avoid

- **Partial migration:** Never leave both old flags AND new `ctx.state` being checked in the same code path. This creates the exact "two sources of truth" bug the FSM eliminates.
- **Forgetting auto-migration:** Old contexts already in `_userContext` Map (from users who interacted before the deploy) will have the old field names. `_getContext()` must detect and migrate these.
- **State transition without clearing stateData:** When moving to IDLE, always set `ctx.stateData = null`. Stale stateData from a previous state leaking into a new state is a new class of bug.
- **Importing FSM_STATES in server.js:** server.js should use string literals (`'AWAITING_ASK_RESPONSE'`, `'IDLE'`) to avoid adding a dependency on the bot's internal constants. The bot exports the class, not the FSM states. Alternatively, if cleaner, export `FSM_STATES` from telegram-bot.js.

## Exhaustive State Flag Audit

Every location in both files where the three flags are read or written:

### `ctx.pendingAskRequestId` (7 locations)

| File | Line | Operation | New Code |
|------|------|-----------|----------|
| telegram-bot.js | 1344 | READ (if truthy) | `ctx.state === FSM_STATES.AWAITING_ASK_RESPONSE` |
| telegram-bot.js | 1345 | READ (get value) | `ctx.stateData.askRequestId` |
| telegram-bot.js | 1346 | WRITE null | `ctx.state = FSM_STATES.IDLE; ctx.stateData = null;` |
| telegram-bot.js | 2037 | READ (get value) | `ctx.stateData?.askRequestId` |
| telegram-bot.js | 2048 | WRITE null | `ctx.state = FSM_STATES.IDLE; ctx.stateData = null;` |
| telegram-bot.js | 2075 | WRITE null | `ctx.state = FSM_STATES.IDLE; ctx.stateData = null;` |
| telegram-bot.js | 4440 | INIT null | Removed (replaced by `state: FSM_STATES.IDLE`) |
| server.js | 1458-1459 | WRITE requestId | `ctx.state = 'AWAITING_ASK_RESPONSE'; ctx.stateData = {...}` |
| server.js | 1506-1507 | WRITE null | `ctx.state = 'IDLE'; ctx.stateData = null;` |
| server.js | 4938-4939 | WRITE null | `if (ctx.state === 'AWAITING_ASK_RESPONSE') { ctx.state = 'IDLE'; ctx.stateData = null; }` |
| server.js | 5111-5112 | WRITE null | Same pattern as above |

### `ctx.pendingInput` (8 locations)

| File | Line | Operation | New Code |
|------|------|-----------|----------|
| telegram-bot.js | 1904 | READ `=== 'task_title'` | `ctx.state === FSM_STATES.AWAITING_TASK_TITLE` |
| telegram-bot.js | 1916 | WRITE `'task_description'` | `ctx.state = FSM_STATES.AWAITING_TASK_DESCRIPTION; ctx.stateData = {...}` |
| telegram-bot.js | 1930 | READ `=== 'task_description'` | `ctx.state === FSM_STATES.AWAITING_TASK_DESCRIPTION` |
| telegram-bot.js | 1940 | WRITE null | `ctx.state = FSM_STATES.IDLE; ctx.stateData = null;` |
| telegram-bot.js | 2166 | READ truthy + WRITE null | `if (ctx.state.startsWith('AWAITING_TASK') && !data.startsWith('t:'))` then reset |
| telegram-bot.js | 4245 | WRITE null | `ctx.state = FSM_STATES.COMPOSING` (context: after new chat, transitioning from task to compose) |
| telegram-bot.js | 4257 | WRITE `'task_title'` | `ctx.state = FSM_STATES.AWAITING_TASK_TITLE; ctx.stateData = { workdir: ... }` |
| telegram-bot.js | 4269 | WRITE null | `ctx.state = FSM_STATES.IDLE; ctx.stateData = null;` |
| telegram-bot.js | 4432 | INIT null | Removed (replaced by `state: FSM_STATES.IDLE`) |

### `ctx.composing` (8 locations)

| File | Line | Operation | New Code |
|------|------|-----------|----------|
| telegram-bot.js | 1957-1958 | READ truthy + WRITE false | No longer needed -- text handler resets COMPOSING on send automatically |
| telegram-bot.js | 2265 | WRITE true | `ctx.state = FSM_STATES.COMPOSING` |
| telegram-bot.js | 2736 | WRITE true | `ctx.state = FSM_STATES.COMPOSING` |
| telegram-bot.js | 2783 | WRITE true | `ctx.state = FSM_STATES.COMPOSING` |
| telegram-bot.js | 2800 | WRITE false | `ctx.state = FSM_STATES.IDLE` |
| telegram-bot.js | 3167 | READ truthy | `ctx.state === FSM_STATES.COMPOSING` |
| telegram-bot.js | 4244 | WRITE true | `ctx.state = FSM_STATES.COMPOSING` |
| telegram-bot.js | 4259 | WRITE false | `ctx.state = FSM_STATES.AWAITING_TASK_TITLE` (transition, not just false) |
| telegram-bot.js | 4322 | WRITE true | `ctx.state = FSM_STATES.COMPOSING` |
| telegram-bot.js | 4431 | INIT false | Removed (replaced by `state: FSM_STATES.IDLE`) |

### `ctx.pendingTaskData` (6 locations)

| File | Line | Operation | New Code |
|------|------|-----------|----------|
| telegram-bot.js | 1909 | READ | `ctx.stateData?.workdir` |
| telegram-bot.js | 1917 | WRITE | `ctx.stateData = { ...ctx.stateData, taskId: id, title }` |
| telegram-bot.js | 1932-1933 | READ | `ctx.stateData?.taskId`, `ctx.stateData?.title` |
| telegram-bot.js | 1941 | WRITE null | Part of `ctx.stateData = null` when transitioning to IDLE |
| telegram-bot.js | 2167-2168 | WRITE null | Part of reset when navigating away from task flow |
| telegram-bot.js | 4258 | WRITE | `ctx.stateData = { workdir: ctx.projectWorkdir }` |
| telegram-bot.js | 4270 | WRITE null | Part of `ctx.stateData = null` |
| telegram-bot.js | 4433 | INIT null | Removed (replaced by `stateData: null`) |

### `ctx.pendingAskQuestions` (4 locations)

| File | Line | Operation | New Code |
|------|------|-----------|----------|
| telegram-bot.js | 1347 | WRITE null | Part of reset to IDLE |
| telegram-bot.js | 2049 | WRITE null | Part of reset to IDLE |
| telegram-bot.js | 2069 | READ | `ctx.stateData?.askQuestions` |
| telegram-bot.js | 2076 | WRITE null | Part of reset to IDLE |
| telegram-bot.js | 4441 | INIT null | Removed |
| server.js | 1460 | WRITE | Part of `ctx.stateData = { askRequestId, askQuestions }` |
| server.js | 1507 | WRITE null | Part of `ctx.stateData = null` |
| server.js | 4940 | WRITE null | Part of state reset |
| server.js | 5113 | WRITE null | Part of state reset |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| State machine library | npm package (xstate, machina) | Plain object + string enum | Zero new deps constraint. 5 states is trivial -- a library adds complexity with no benefit |
| i18n framework | npm i18n package | `BOT_I18N` object + `_t()` method | Already works, already has fallback chain. Just needs file extraction. |
| Module bundler for split files | webpack/rollup | `require()` / `module.exports` | No build tools constraint. CommonJS is the project standard. |

**Key insight:** Phase 1 is a pure refactoring. No new functionality. Every tool and pattern already exists in the codebase -- the work is reorganization, not invention.

## Common Pitfalls

### Pitfall 1: Dual-Field Corruption During Migration
**What goes wrong:** Code checks both `ctx.pendingInput` AND `ctx.state` in different places. User gets stuck because one field says "waiting for input" while the other says "idle."
**Why it happens:** Incremental migration where some methods are updated and others are not.
**How to avoid:** The migration MUST be atomic. Every read/write of the three old flags must be updated in a single commit. Use the audit table above as a checklist.
**Warning signs:** Any code path that reads `ctx.pendingInput`, `ctx.composing`, or `ctx.pendingAskRequestId` after migration is a bug.

### Pitfall 2: _t() Locale Corruption After i18n Extraction
**What goes wrong:** `_t()` reads `this.lang` (a class property set in constructor). If the extraction changes how the dictionary is accessed, locale fallback breaks.
**Why it happens:** Temptation to refactor `_t()` while extracting -- e.g., making it accept `lang` as parameter.
**How to avoid:** Phase 1 should NOT change the `_t()` method signature. Move the data, not the logic. `_t()` stays as a method on TelegramBot, reading `this.lang` exactly as before.
**Warning signs:** Any change to lines 861-868 is a red flag in Phase 1.

### Pitfall 3: server.js Writes to Old Field Names
**What goes wrong:** server.js `TelegramProxy._handleAskUser` still writes `ctx.pendingAskRequestId = data.requestId`. The bot reads `ctx.state` which is still IDLE. User's text goes to Claude instead of answering the ask_user question.
**Why it happens:** Forgetting that server.js directly mutates bot context in 4 locations.
**How to avoid:** The audit table above lists all 4 server.js locations. All must be updated in the same commit as the bot changes.
**Warning signs:** `grep -n pendingAskRequestId server.js` returning any results after migration.

### Pitfall 4: Auto-Migration Not Triggered for Existing Users
**What goes wrong:** Bot restarts. User who was mid-task-creation before restart has old-format context in `_userContext` Map. Actually, `_userContext` is in-memory and cleared on restart, so this specific case is fine. BUT: if a user is mid-interaction when new code deploys (e.g., they tapped "New Task", then the process restarts with new code), their context is gone regardless.
**Why it happens:** `_userContext` is a `Map()` in memory, not persisted. `_restoreDeviceContext` only restores `sessionId` and `projectWorkdir`.
**How to avoid:** The auto-migration in `_getContext()` handles contexts that exist in the Map. For process restarts, state flags are always lost (old and new) -- this is existing behavior. The migration code handles the hot-reload case where old contexts coexist with new code.
**Warning signs:** None -- this is acceptable behavior that already exists.

### Pitfall 5: Slash Commands Not Resetting State (FSM-03)
**What goes wrong:** User in AWAITING_TASK_TITLE types `/status`. Without FSM-03, the command handler never resets state. When the user next types free text, it gets captured as a task title.
**Why it happens:** `_handleCommand` (line 1451) currently has no state reset. The old flags are also not reset here.
**How to avoid:** Add `ctx.state = FSM_STATES.IDLE; ctx.stateData = null;` as the first line of `_handleCommand` after getting `ctx`.
**Warning signs:** This is a NEW behavior that FSM-03 requires. It does NOT exist today. It is a bug fix, not a regression risk.

### Pitfall 6: answerCallbackQuery Called Twice
**What goes wrong:** Moving `_answerCallback` to `finally` means it could be called twice if any handler also calls it explicitly.
**Why it happens:** If old code paths (like `_handleAskCallback`) already call `_answerCallback`, the finally block calls it again.
**How to avoid:** Audit all callback handlers for explicit `_answerCallback` calls. Currently NONE of them call it -- only `_handleCallback` (line 2153) does. But the audit must verify this.
**Warning signs:** `grep _answerCallback telegram-bot.js` -- should only find the method definition and the single call in `_handleCallback`.

## Code Examples

### Text Message Routing After FSM Migration

```javascript
// _handleTextMessage (replaces lines 1898-2031)
async _handleTextMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const ctx = this._getContext(userId);

  switch (ctx.state) {
    case FSM_STATES.AWAITING_TASK_TITLE: {
      const title = (msg.text || '').trim().substring(0, 200);
      if (!title) return;
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const workdir = ctx.stateData?.workdir || null;
      this.db.prepare(
        "INSERT INTO tasks (id, title, description, notes, status, sort_order, workdir) VALUES (?, ?, '', '', 'backlog', 0, ?)"
      ).run(id, title, workdir);
      ctx.state = FSM_STATES.AWAITING_TASK_DESCRIPTION;
      ctx.stateData = { ...ctx.stateData, taskId: id, title };
      await this._sendMessage(chatId,
        this._t('new_task_created', { title: this._escHtml(title) }) + '\n\n' + this._t('new_task_with_desc'),
        { reply_markup: JSON.stringify({ inline_keyboard: [
          [{ text: this._t('btn_skip'), callback_data: 't:skip' }],
        ]}) }
      );
      return;
    }

    case FSM_STATES.AWAITING_TASK_DESCRIPTION: {
      const description = (msg.text || '').trim().substring(0, 2000);
      const taskId = ctx.stateData?.taskId;
      const title = ctx.stateData?.title || '';
      if (taskId && description) {
        this.db.prepare("UPDATE tasks SET description = ?, updated_at = datetime('now') WHERE id = ?")
          .run(description, taskId);
      }
      ctx.state = FSM_STATES.IDLE;
      ctx.stateData = null;
      await this._sendMessage(chatId, /* ... task confirmation ... */);
      return;
    }

    case FSM_STATES.COMPOSING:
      // Reset to IDLE after sending (compose is one-shot)
      ctx.state = FSM_STATES.IDLE;
      ctx.stateData = null;
      break; // fall through to send-to-Claude logic

    case FSM_STATES.IDLE:
    default:
      break; // fall through to send-to-Claude logic
  }

  // ... existing send-to-Claude logic (auto-session, project safety, emit) ...
}
```

### Ask-User Interception After FSM Migration

```javascript
// In the main message handler (replaces lines 1342-1351)
const ctx = this._getContext(userId);
if (ctx.state === FSM_STATES.AWAITING_ASK_RESPONSE) {
  const requestId = ctx.stateData?.askRequestId;
  ctx.state = FSM_STATES.IDLE;
  ctx.stateData = null;
  this.emit('ask_user_response', { requestId, answer: text });
  await this._sendMessage(chatId, this._t('ask_answered'));
  return;
}
```

### Callback Handler State Reset (FSM-03 via callbacks)

```javascript
// In _handleCallback try block (replaces lines 2165-2168)
// Reset task input state on any non-task navigation
if ((ctx.state === FSM_STATES.AWAITING_TASK_TITLE ||
     ctx.state === FSM_STATES.AWAITING_TASK_DESCRIPTION) &&
    !data.startsWith('t:')) {
  ctx.state = FSM_STATES.IDLE;
  ctx.stateData = null;
}
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None -- project has no automated tests |
| Config file | none -- see Wave 0 |
| Quick run command | `node -e "require('./telegram-bot-i18n')"` (smoke test: module loads) |
| Full suite command | Manual verification (see below) |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ARCH-01 | i18n file loads and contains all 3 locales with correct key counts | smoke | `node -e "const i=require('./telegram-bot-i18n'); console.assert(Object.keys(i.uk).length > 250); console.assert(Object.keys(i.en).length > 250); console.assert(Object.keys(i.ru).length > 250); console.log('OK')"` | Wave 0 |
| FSM-01 | ctx.state is the only state field; old fields do not exist on new contexts | smoke | `node -e "const B=require('./telegram-bot'); /* cannot instantiate without DB */"` -- manual only | manual-only (requires DB + bot token) |
| FSM-02 | Setting ask_user state prevents task state and vice versa | manual-only | Start task creation, trigger ask_user mid-flow, verify no double-state | manual-only |
| FSM-03 | Slash command resets state to IDLE | manual-only | Enter AWAITING_TASK_TITLE, type /status, verify next text is not captured as task title | manual-only |
| FSM-04 | Spinner clears on error | manual-only | Tap a button that triggers an error handler, verify no permanent spinner | manual-only |
| FSM-05 | Existing device works after deploy | manual-only | Deploy new code, verify existing paired Telegram device can still chat | manual-only |

### Sampling Rate
- **Per task commit:** `node -e "require('./telegram-bot-i18n')"` + `node -c telegram-bot.js` (syntax check)
- **Per wave merge:** Full manual Telegram test (send message, task creation, ask_user)
- **Phase gate:** All 5 manual scenarios pass before marking phase complete

### Wave 0 Gaps
- [ ] No test framework installed -- all validation is manual or one-liner smoke tests
- [ ] `node -c telegram-bot.js` and `node -c server.js` for syntax validation after each edit
- [ ] `node -e "require('./telegram-bot-i18n')"` to verify i18n module loads

*(Given project constraints of "no tests, no build step", Wave 0 is limited to syntax checks and module load verification. Full validation requires running the bot with a Telegram token.)*

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Multiple boolean flags for bot state | Single enum FSM field | Standard pattern since FSM formalization | Eliminates entire class of state-overlap bugs |
| Monolithic translation strings in main file | Separate i18n data file | Standard since any i18n-aware project | Reduces main file by 18%, cleaner diffs |

**Deprecated/outdated:**
- Nothing in this phase uses deprecated APIs. All changes are pure internal refactoring.

## Open Questions

1. **Should FSM_STATES be exported from telegram-bot.js for server.js to import?**
   - What we know: server.js currently writes `ctx.pendingAskRequestId` using string values, not imported constants.
   - What's unclear: Whether to use `require('./telegram-bot').FSM_STATES.AWAITING_ASK_RESPONSE` or literal strings in server.js.
   - Recommendation: Export FSM_STATES from telegram-bot.js and import in server.js. String literals are error-prone and won't be caught if a state name changes. The coupling already exists (server.js accesses `bot._getContext()`); making it explicit is better than hiding it behind strings.

2. **Should composing-to-idle reset happen in `_handleTextMessage` or before it?**
   - What we know: Current code resets `ctx.composing = false` at line 1957 inside `_handleTextMessage`. The text still goes to Claude -- composing is a UX hint, not a functional gate.
   - What's unclear: Whether COMPOSING should auto-reset to IDLE when text is sent, or stay in COMPOSING until explicitly cancelled.
   - Recommendation: Reset to IDLE on send. COMPOSING is a "next text goes to Claude" affordance. After sending, the affordance is fulfilled. User can always tap Write again.

## Sources

### Primary (HIGH confidence)
- Direct code audit of `telegram-bot.js` (4693 lines) -- all line references verified
- Direct code audit of `server.js` (6475 lines) -- all 4 `pendingAskRequestId` write locations verified
- .planning/REQUIREMENTS.md -- Phase 1 requirement IDs and descriptions
- .planning/research/SUMMARY.md -- FSM design, pitfall analysis, phase ordering rationale

### Secondary (MEDIUM confidence)
- [FSM Telegram Bot in Node.js -- Level Up Coding](https://levelup.gitconnected.com/creating-a-conversational-telegram-bot-in-node-js-with-a-finite-state-machine-and-async-await-ca44f03874f9) -- confirms FSM pattern for Telegram bots
- [answerCallbackQuery 15-second timeout](https://gist.github.com/d-Rickyy-b/f789c75228bf00f572eec4450ed0d7c9) -- confirms spinner behavior on missed callback answers

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new libraries, pure refactoring of existing code
- Architecture: HIGH -- every line reference verified against source, all mutation sites audited
- Pitfalls: HIGH -- drawn from direct code audit and confirmed bug patterns in the existing codebase

**Research date:** 2026-03-28
**Valid until:** Indefinite (internal refactoring research; no external API dependencies that could change)
