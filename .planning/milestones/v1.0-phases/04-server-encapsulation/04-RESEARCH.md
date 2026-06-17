# Phase 4: Server Encapsulation - Research

**Researched:** 2026-03-28
**Domain:** Node.js module encapsulation / public API design for TelegramBot + TelegramProxy
**Confidence:** HIGH

## Summary

Phase 4 eliminates all `bot._*` private method calls from `server.js` by exposing a `createResponseHandler({ userId, chatId, threadId })` factory method on `TelegramBot`. The core problem is that `TelegramProxy` (a class defined inside `server.js` at line 1365) directly calls 8 distinct private methods on the bot instance (`_callApi`, `_sendMessage`, `_getContext`, `_t`, `_escHtml`, `_mdToHtml`, `_chunkForTelegram`). Additionally, `processTelegramChat()` and `_attachTelegramListeners()` make 4 more direct private calls (`_getContext`, `_sendMessage`, `_escHtml`, `_t`).

The solution is straightforward: (1) move `TelegramProxy` from `server.js` into `telegram-bot.js` where it legitimately needs access to bot internals, (2) expose `createResponseHandler()` as a factory that returns a proxy object with a `send(raw)` duck-typed interface identical to the current `TelegramProxy`, and (3) replace the handful of remaining `telegramBot._sendMessage` / `telegramBot._getContext` / `telegramBot._escHtml` / `telegramBot._t` calls in `server.js` with new public methods: `sendMessage()`, `getContext()`, `escHtml()`, `t()`.

**Primary recommendation:** Move TelegramProxy into telegram-bot.js. Expose `createResponseHandler()` as the only new public API. Add thin public wrappers for `sendMessage`, `getContext`, `escHtml`, and `t` to cover the remaining server.js usages.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ENC-01 | TelegramBot exposes `createResponseHandler({ userId, chatId, threadId })` public factory method that server.js uses for all bot interactions | Move TelegramProxy into telegram-bot.js, export factory method that returns proxy with `send(raw)` + `readyState` interface |
| ENC-02 | server.js no longer calls any `bot._*` private methods directly | Identified 8 distinct private methods called across 50+ call sites; all solvable via TelegramProxy relocation + 4 thin public wrappers |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **No TypeScript** -- vanilla JS throughout
- **No new npm dependencies** -- zero build step philosophy
- **No build tools** -- no webpack, vite, etc.
- **WebSocket Protocol** -- do not break `{ type: 'chat'|'text'|'tool_use'|'done'|'error' }` contract
- **SQLite WAL mode** -- never change journal mode
- **Security** -- auth tokens httpOnly, no path traversal bypass
- **Never typecast, never use `as`** (global CLAUDE.md)

## Architecture Patterns

### Current Coupling Map

**TelegramProxy (server.js lines 1365-1797)** accesses these private bot methods:

| Private Method | Call Count | Purpose |
|----------------|-----------|---------|
| `_callApi()` | 9 | sendChatAction, sendMessageDraft, editMessageText, deleteMessage |
| `_sendMessage()` | 1 (via `_tgSend`) | Send messages with HTML + retry |
| `_getContext()` | 3 | Read/write FSM state (ask_user flow) |
| `_t()` | 14 | i18n translations for button labels |
| `_escHtml()` | 11 | HTML entity escaping |
| `_mdToHtml()` | 3 | Convert markdown buffer to HTML |
| `_chunkForTelegram()` | 1 | Split large HTML into message-safe chunks |

Also accesses public: `notifyAskUser()` (1 call), `log` property (2 calls).

**processTelegramChat() (server.js lines 5006-5181)** accesses:

| Private Method | Call Count | Purpose |
|----------------|-----------|---------|
| `_sendMessage()` | 3 | "Session busy", "Session not found", "Thinking..." messages |
| `_getContext()` | 2 | Read/clear ask_user FSM state |

**_clearTelegramAskState() (server.js line 4992)** accesses:

| Private Method | Call Count | Purpose |
|----------------|-----------|---------|
| `_getContext()` | 1 | Clear ask_user state when answered from web UI |

**_attachTelegramListeners() tunnel handlers (server.js lines 5239-5293)** accesses:

| Private Method | Call Count | Purpose |
|----------------|-----------|---------|
| `_sendMessage()` | 11 | All tunnel start/stop/status response messages |
| `_escHtml()` | 6 | Escape URLs and error messages |
| `_t()` | 3 | i18n for "not running" / "stopped" labels |

### Target Architecture

```
server.js                         telegram-bot.js
---------                         ---------------
                                  class TelegramProxy { ... }
                                    (moved here, uses this._bot._* legitimately)

createResponseHandler({           createResponseHandler({ userId, chatId, threadId })
  userId, chatId, threadId          -> returns new TelegramProxy(this, chatId, sessionId, userId, threadId)
}) -> proxy with:                   -> proxy.send(raw), proxy.readyState
  .send(raw)
  .readyState                    Public wrappers:
                                    sendMessage(chatId, text, opts) -> this._sendMessage(...)
sendMessage(chatId, text, opts)     getContext(userId) -> this._getContext(...)
getContext(userId)                   escHtml(text) -> this._escHtml(...)
escHtml(text)                       t(key, params) -> this._t(...)
t(key, params)
```

### Pattern: Move TelegramProxy Into telegram-bot.js

**What:** Relocate the entire `TelegramProxy` class (lines 1365-1797, ~430 lines) from `server.js` into `telegram-bot.js`. This is the correct home because TelegramProxy is fundamentally a bot-internal concern -- it formats messages using bot utilities (`_escHtml`, `_mdToHtml`, `_t`), manages bot user state (`_getContext`), and calls the Telegram API through the bot's auth token (`_callApi`).

**Why this works:** Inside `telegram-bot.js`, TelegramProxy's calls to `this._bot._callApi()` etc. are internal implementation -- they don't cross module boundaries. The only thing `server.js` needs is a factory method that returns an object with `send(raw)` and `readyState`.

**What moves:**
- `class TelegramProxy` (lines 1365-1797)
- Constants: `MAX_MESSAGE_LENGTH` (line 1800), `TG_COLLAPSE_THRESHOLD` (line 1802), `TG_PREVIEW_LENGTH` (line 1804)
- The `broadcastToSession` dependency: TelegramProxy calls `broadcastToSession(this._sessionId, data)` on line 1419 -- this must be injected via the factory method since it belongs to server.js

**What stays in server.js:**
- `processTelegramChat()` -- but it no longer creates `new TelegramProxy()` directly; it calls `telegramBot.createResponseHandler()` instead
- `_attachTelegramListeners()` -- but tunnel handlers use new public methods instead of `bot._sendMessage`
- `_clearTelegramAskState()` -- uses new `telegramBot.getContext()` instead of `telegramBot._getContext()`

### Factory Method Signature

```javascript
// In telegram-bot.js
createResponseHandler({ userId, chatId, sessionId, threadId, broadcastToSession }) {
  return new TelegramProxy(this, chatId, sessionId, userId, threadId, broadcastToSession);
}
```

The `broadcastToSession` callback is the one dependency TelegramProxy has on server.js -- it broadcasts streaming data to web UI watchers. Injecting it as a callback keeps the dependency inverted.

### New Public Wrappers on TelegramBot

```javascript
// Thin public wrappers -- no logic, just forwarding
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
```

### Anti-Patterns to Avoid

- **Passing the entire bot instance to server.js functions:** That just moves the coupling without fixing it. The goal is that server.js only calls public methods.
- **Making all private methods public:** Defeats the purpose. Only expose what server.js actually needs (4 methods + 1 factory).
- **Creating an intermediate "BotAPI" adapter object:** Over-engineering. Direct public methods on the same class are simpler and sufficient.
- **Keeping TelegramProxy in server.js and passing a facade:** This was the approach for TelegramBotForum (it made sense because forum logic is conceptually separate). TelegramProxy is conceptually part of the bot's streaming infrastructure -- it belongs in telegram-bot.js.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Message formatting | Custom HTML formatter | Existing `_mdToHtml`, `_escHtml`, `_chunkForTelegram` | Already tested and handles edge cases (code fences, entities, 4096 char limit) |
| Rate limiting for sendMessageDraft | Custom throttle | Existing `_scheduleUpdate` in TelegramProxy | Already handles draft vs legacy timing, 429 backoff |

## Common Pitfalls

### Pitfall 1: broadcastToSession Dependency
**What goes wrong:** TelegramProxy calls `broadcastToSession(this._sessionId, data)` on every `send()` to relay streaming data to web UI watchers. When moving TelegramProxy into telegram-bot.js, this function is no longer in scope.
**Why it happens:** `broadcastToSession` is defined in server.js and iterates over WebSocket clients.
**How to avoid:** Inject it as a callback parameter in `createResponseHandler()`. The proxy stores it and calls it. If not provided (e.g., tests), no-op.
**Warning signs:** Web UI stops showing real-time updates for Telegram-initiated chats.

### Pitfall 2: db Reference in TelegramProxy
**What goes wrong:** TelegramProxy directly queries the database on lines 1606 and 1714 (`db.prepare('SELECT title FROM sessions WHERE id = ?').get(...)`) using the module-level `db` variable from server.js.
**Why it happens:** The `db` variable is in server.js module scope, not on the bot instance.
**How to avoid:** After moving to telegram-bot.js, use `this._bot.db` (which is already a public property set in the constructor: `this.db = db`).
**Warning signs:** Session title missing from progress/done messages in Telegram.

### Pitfall 3: Proxy Internal State Accessed from server.js
**What goes wrong:** `processTelegramChat()` reads `proxy._usesDraftStreaming` (line 5111) and writes `proxy._progressMsgId` (line 5120) -- these are TelegramProxy internal fields.
**Why it happens:** The "thinking" message logic in `processTelegramChat` was a quick patch that pokes into proxy internals.
**How to avoid:** Move the "thinking" message logic into TelegramProxy itself. Add a `sendThinking()` method that TelegramProxy exposes, or handle it internally in the constructor/first-send. Alternatively, since draft streaming is now the primary path and the thinking message is suppressed in draft mode, the legacy thinking path can be moved into the proxy's `_sendProgress` logic.
**Warning signs:** Thinking message appears in draft mode (regression), or doesn't appear in legacy mode.

### Pitfall 4: _clearTelegramAskState Accesses proxy._userId
**What goes wrong:** `_clearTelegramAskState()` (line 4995) reads `task.proxy._userId` to find the user context. After encapsulation, proxy internals should not be accessed.
**Why it happens:** The function was written before the encapsulation effort.
**How to avoid:** The `activeTasks` map already stores `userId` at the top level (line 5029: `userId`). Use `task.userId` instead of `task.proxy._userId`.
**Warning signs:** Ask state not cleared when web UI answers a question during a Telegram-initiated session.

### Pitfall 5: Constants Used by Both server.js and TelegramProxy
**What goes wrong:** `MAX_MESSAGE_LENGTH`, `TG_COLLAPSE_THRESHOLD`, `TG_PREVIEW_LENGTH` are defined right after TelegramProxy in server.js. They need to move with TelegramProxy.
**Why it happens:** They were co-located with TelegramProxy for convenience.
**How to avoid:** Move them into telegram-bot.js. server.js does not reference them anywhere else.
**Warning signs:** Lint-style issues only; no runtime impact if forgotten since they'd remain as dead code.

## Detailed Inventory of All bot._ Calls to Eliminate

### Category A: Inside TelegramProxy (solved by relocation)

These 50+ call sites disappear automatically when TelegramProxy moves into telegram-bot.js:

| Method | Lines | Notes |
|--------|-------|-------|
| `this._bot._callApi()` | 1385, 1393, 1492, 1540, 1584, 1628, 1635, 1667, 1763 | All Telegram API calls |
| `this._bot._sendMessage()` | 1412 | Via `_tgSend` helper |
| `this._bot._getContext()` | 1460, 1507, 1530 | FSM state for ask_user |
| `this._bot._t()` | 1436, 1466, 1619, 1725-1733, 1773-1778 | i18n button labels |
| `this._bot._escHtml()` | 1467, 1549, 1551, 1595, 1598, 1611, 1708, 1716, 1788 | HTML escaping |
| `this._bot._mdToHtml()` | 1684, 1697 | Markdown conversion |
| `this._bot._chunkForTelegram()` | 1685 | Message splitting |
| `this._bot.notifyAskUser()` | 1515 | Already public (no change) |
| `this._bot.log` | 1523, 1589 | Already public property (no change) |

### Category B: In processTelegramChat() (need public wrappers)

| Call | Line | Replacement |
|------|------|-------------|
| `telegramBot._sendMessage(chatId, '...')` | 5011 | `telegramBot.sendMessage(chatId, '...')` |
| `telegramBot._sendMessage(chatId, '...')` | 5018 | `telegramBot.sendMessage(chatId, '...')` |
| `telegramBot._sendMessage(chatId, '...')` | 5112 | Move into proxy (see Pitfall 3) or `telegramBot.sendMessage()` |
| `telegramBot._getContext(userId)` | 5173 | `telegramBot.getContext(userId)` |

### Category C: In _clearTelegramAskState() (need public wrapper)

| Call | Line | Replacement |
|------|------|-------------|
| `telegramBot._getContext(task.proxy._userId)` | 4996 | `telegramBot.getContext(task.userId)` |

### Category D: In _attachTelegramListeners() tunnel handlers (need public wrappers)

| Call | Lines | Replacement |
|------|-------|-------------|
| `bot._sendMessage(chatId, ...)` | 5244, 5250, 5252, 5254, 5261, 5265, 5267, 5275, 5277, 5280, 5289, 5291 | `bot.sendMessage(chatId, ...)` |
| `bot._escHtml(...)` | 5244, 5250, 5252, 5254, 5267, 5275, 5280 | `bot.escHtml(...)` |
| `bot._t(...)` | 5261, 5265, 5277 | `bot.t(...)` |

## Code Examples

### createResponseHandler factory method

```javascript
// telegram-bot.js — new public method
createResponseHandler({ userId, chatId, sessionId, threadId, broadcastToSession }) {
  return new TelegramProxy(this, chatId, sessionId, userId, threadId, broadcastToSession);
}
```

### server.js usage after encapsulation

```javascript
// processTelegramChat() — before:
const proxy = new TelegramProxy(telegramBot, chatId, sessionId, userId, threadId);

// After:
const proxy = telegramBot.createResponseHandler({
  userId, chatId, sessionId, threadId,
  broadcastToSession,
});
```

### Public wrappers

```javascript
// telegram-bot.js — thin public wrappers
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
```

### Tunnel handler — before and after

```javascript
// Before (private call):
bot.on('tunnel_start', async ({ chatId }) => {
  await bot._sendMessage(chatId, `Starting ${bot._escHtml(provider)}...`);
});

// After (public call):
bot.on('tunnel_start', async ({ chatId }) => {
  await bot.sendMessage(chatId, `Starting ${bot.escHtml(provider)}...`);
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| TelegramProxy in server.js with direct `bot._*` calls | TelegramProxy inside telegram-bot.js behind `createResponseHandler()` factory | Phase 4 (this phase) | Zero `bot._*` calls in server.js |
| Forum module received full bot instance | Forum module receives API facade object (composition) | Phase 3 | Established the pattern this phase follows |

## Open Questions

1. **Should `sendThinking()` move into TelegramProxy?**
   - What we know: Lines 5111-5122 in `processTelegramChat()` send a "Thinking..." message only in legacy (non-draft) mode, then poke `proxy._progressMsgId` to set it. This is a proxy-internal concern.
   - What's unclear: Whether to add a `startThinking()` method to the proxy or simply let the proxy handle it on first `_sendProgress` call.
   - Recommendation: Move into TelegramProxy constructor or a `start()` method. Simplest: check `_usesDraftStreaming` inside the proxy and auto-send thinking message if in legacy mode. This eliminates both the `proxy._usesDraftStreaming` read and `proxy._progressMsgId` write from server.js.

2. **Should `_clearTelegramAskState` become a public method on TelegramBot?**
   - What we know: It reads context + resets FSM state. It's called from 2 places in server.js (web UI ask_user answer + cancel).
   - What's unclear: Whether to keep it as a server.js helper using `telegramBot.getContext()`, or make it a `bot.clearAskState(userId)` method.
   - Recommendation: Keep as server.js helper using the new public `getContext()` -- the function only reads/writes standard FSM fields (`state`, `stateData`) which are part of the context object's public contract.

## Sources

### Primary (HIGH confidence)
- `server.js` lines 1365-1797 -- TelegramProxy class (full source audit)
- `server.js` lines 4986-5294 -- processTelegramChat + _attachTelegramListeners (full source audit)
- `telegram-bot.js` lines 107-163 -- constructor + forum facade pattern (established composition approach)
- `telegram-bot.js` lines 3293-3310 -- _getContext implementation

### Secondary (MEDIUM confidence)
- Phase 3 research/plan -- established the composition facade pattern for TelegramBotForum extraction

## Metadata

**Confidence breakdown:**
- Architecture: HIGH -- complete source audit of all `bot._*` calls, exact line numbers, clear solution
- Pitfalls: HIGH -- identified all non-obvious dependencies (broadcastToSession, db, proxy internal state access)
- Implementation approach: HIGH -- follows established pattern from Phase 3 (composition/facade), minimal API surface

**Research date:** 2026-03-28
**Valid until:** No expiry (internal codebase analysis, no external dependencies)
