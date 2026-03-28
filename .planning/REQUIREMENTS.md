# Requirements — Telegram Bot UX Redesign

**Generated:** 2026-03-28
**Source:** PROJECT.md + research synthesis (SUMMARY.md)
**Status:** v1 — ready for roadmap

---

## v1 Requirements

### Navigation (NAV)

- [ ] **NAV-01**: User can send a message to Claude in ≤2 taps from any state (zero slash commands required)
- [ ] **NAV-02**: Every inline keyboard screen has a functional Back button that takes the user one level up the navigation hierarchy
- [ ] **NAV-03**: All navigation actions edit the existing screen message in place (no new messages sent for navigation taps)
- [ ] **NAV-04**: Every screen message shows a context header: current active project and chat names (or "none selected")
- [ ] **NAV-05**: Slash commands `/project <n>` and `/chat <n>` are removed from the command menu; inline button selection is the only navigation method
- [ ] **NAV-06**: User can return to Main Menu from any screen with a single tap

### State Machine (FSM)

- [ ] **FSM-01**: User state is represented as a single explicit enum field (`ctx.state`) with values: IDLE, AWAITING_TASK_TITLE, AWAITING_TASK_DESCRIPTION, AWAITING_ASK_RESPONSE, COMPOSING
- [ ] **FSM-02**: No pending input state can silently intercept a text message that was intended for Claude — task creation and ask_user states are mutually exclusive, never overlap
- [ ] **FSM-03**: Any slash command resets `ctx.state` to IDLE before processing (cancels any pending input)
- [ ] **FSM-04**: `answerCallbackQuery` is called in a `finally` block on every inline button tap, unconditionally — no permanent spinner for the user
- [ ] **FSM-05**: Existing paired devices and in-flight sessions continue working after the state migration (zero re-pairing required)

### Persistent Keyboard (KB)

- [ ] **KB-01**: The persistent reply keyboard (bottom bar) shows the name of the active project/chat when one is selected
- [ ] **KB-02**: The Write button is always visible in the persistent keyboard and always routes correctly (to compose if session active, to project picker if not)
- [ ] **KB-03**: `setMyCommands` is updated to list only 3–5 commands: `/start`, `/help`, `/status`, `/cancel` — navigation commands removed

### Screen Architecture (ARCH)

- [ ] **ARCH-01**: i18n translation data is extracted to a separate file `telegram-bot-i18n.js` (removes ~825 lines from main bot file)
- [ ] **ARCH-02**: Screens are defined via a registry object (`SCREENS`) where each entry has `handler` and `parent` — back button is generated automatically from `parent` pointer
- [ ] **ARCH-03**: `ctx.screenMsgId` and `ctx.screenChatId` are removed; screen handlers receive `editMsgId` from the callback message anchor (`cbq.message.message_id`) instead
- [ ] **ARCH-04**: All legacy callback_data prefixes (`m:`, `p:`, `c:`, `ch:`, `cm:`, `d:`, `f:`, `t:`, `s:`, `tn:`, `ask:`) remain functional as fallback handlers during migration — old buttons in chat history never break

### Forum Mode (FORUM)

- [ ] **FORUM-01**: Forum mode logic is extracted to a separate class `TelegramBotForum` in `telegram-bot-forum.js` (~860 lines)
- [ ] **FORUM-02**: Forum mode and Direct mode never share `ctx.state` — forum state is scoped to `(chatId, threadId, userId)`, direct mode state is scoped to `userId`
- [ ] **FORUM-03**: `threadId` is always passed explicitly as a parameter to every forum API call (no class-level `this._currentThreadId`)
- [ ] **FORUM-04**: Existing Forum Mode supergroups continue working after extraction with zero reconfiguration

### Server Encapsulation (ENC)

- [ ] **ENC-01**: `TelegramBot` exposes a `createResponseHandler({ userId, chatId, threadId })` public factory method that server.js uses for all bot interactions
- [ ] **ENC-02**: `server.js` no longer calls any `bot._*` private methods directly (removes coupling to internal implementation)

### Streaming (STREAM)

- [ ] **STREAM-01**: Claude response streaming uses `sendMessageDraft` (Bot API 9.5) instead of `editMessageText` polling loop — eliminates rate-limit freezes and message flickering

---

## v2 Requirements (deferred)

- `KeyboardButton style: primary` on Write button (Bot API 9.4 — needs production validation before relying on it)
- Web App (Mini App) integration for richer task views
- `sendMessageDraft` draft_id reuse pattern validation for very long responses
- Formal test suite for state machine transitions
- Additional third language (ru) full audit for correctness

---

## Out of Scope

- **Greenfield rewrite in grammy/telegraf** — No new npm deps; vanilla Node.js + native fetch is the constraint
- **New features** (new command types, integrations, analytics) — This milestone is navigation/UX redesign only
- **Webhook mode** — Long-polling stays; no infrastructure changes
- **Backwards-incompatible data schema changes** — SQLite schema: ALTER TABLE only, no DROP TABLE
- **Breaking existing paired devices** — Zero re-pairing. All existing device tokens remain valid
- **ru (Russian) new translations** — Keep existing ru strings, no new ru-specific work

---

## Traceability

*(filled in by roadmapper)*

| REQ-ID | Phase |
|--------|-------|
| TBD    | TBD   |
