# Claude Code Studio — Telegram Bot UX Redesign

## What This Is

The Claude Code Studio Telegram bot is a remote control interface for the web-based Claude Code Studio (Express.js + WebSocket UI). It lets users send messages to Claude, browse sessions/chats, manage tasks, monitor system status, and control remote access — all from a Telegram private chat or Forum Mode supergroup.

The current bot (telegram-bot.js, ~4693 lines) works functionally but has severe UX and navigation problems that make it frustrating to use daily. This milestone is a full redesign of the user-facing navigation, interaction model, and code architecture.

## Core Value

A user should be able to send a message to Claude in **2 taps or fewer** — from any state, without knowing any slash commands.

## Requirements

### Validated

- ✓ Telegram pairing via 6-digit code — existing
- ✓ Real-time Claude response streaming to Telegram — existing
- ✓ Multi-language support (uk/en) — existing
- ✓ Forum Mode (supergroup with per-project topics) — existing
- ✓ Task management (Kanban: backlog/todo/in-progress/done) — existing
- ✓ File browser + git diff/log via Telegram — existing
- ✓ Remote access (tunnel) control — existing
- ✓ Ask-user interactive questions answered via Telegram — existing
- ✓ Security: device whitelist, sensitive file blocking, rate limiting — existing

### Active

- [ ] New user reaches first Claude message in ≤2 taps (zero slash commands required)
- [ ] Persistent bottom keyboard always reflects current context (project/chat active or not)
- [ ] Single clear navigation hierarchy: Main → Project → Chat → Compose
- [ ] Back navigation always works predictably (one level up, no dead ends)
- [ ] State always visible: user knows what project/chat is active at a glance
- [ ] Forum Mode and Direct Mode are clearly separated (no command confusion)
- [ ] Common actions accessible from anywhere: new chat, status, back to main
- [ ] No redundant slash commands (remove /project <n>, /chat <n> in favor of inline buttons)
- [ ] Forum Mode extracted to a separate module (TelegramBotForum class)

### Validated in Phase 1: Foundation

- ✓ Pending input states (task creation) cannot accidentally intercept unrelated messages — FSM-01..03
- ✓ i18n extracted to a separate file for maintainability — ARCH-01
- ✓ Explicit state machine replaces ad-hoc boolean flags — FSM-01..05

### Out of Scope

- Greenfield rewrite in a different language/library — preserve Node.js + native fetch + no new deps
- Adding new features (new command types, new integrations) — redesign navigation only
- Webhook mode — long-polling stays
- Third language (ru) — keep existing ru strings, no new ru translations

## Context

### Current UX Problems (from audit)

**Critical:**
- 6 taps + 1 message to send first message (should be 1-2)
- Dual navigation systems (slash commands + inline buttons) that don't sync state correctly
- Forum Mode and Direct Mode share slash commands but have different semantics — causes confusion

**High:**
- `screenMsgId` single-slot system breaks when user taps old buttons or multiple messages appear
- `pendingInput` state (task creation) silently captures next text message even if user forgot
- `pendingAskRequestId` (Claude's ask_user) can intercept messages meant for task creation
- Silent context mutation: selecting a project resets active session without warning
- No "you can just type" affordance — users don't discover the zero-tap shortcut

**Medium:**
- Inconsistent: some actions edit a message, others send new ones (no clear rule)
- Compose mode flag (`ctx.composing`) is almost unused — its purpose overlaps with just-type-to-send
- Pagination limits (50 chats, 30 projects) not communicated to user
- Task creation flow creates task then asks for description — user thinks it's not saved yet

**Architecture:**
- God object: 4693 lines, ~80 methods, no separation of concerns
- i18n: 825 lines of translation data (18% of file) mixed into logic
- Forum logic: ~860 lines of forum-specific code mixed into the main class
- server.js accesses `bot._getContext()` breaking encapsulation
- Synchronous SQLite calls in async handlers

### Tech Stack
- Runtime: Node.js 20
- Framework: native fetch (no node-telegram-bot-api or grammy)
- Database: SQLite (better-sqlite3, WAL mode)
- Integration: EventEmitter IPC to server.js
- No build tools, no TypeScript

### Key Files
- `telegram-bot.js` — bot logic (~3960 lines after Phase 1), TelegramBot extends EventEmitter, FSM state machine
- `telegram-bot-i18n.js` — i18n data (790 lines), BOT_I18N with uk/en/ru locales
- `server.js` — main server, instantiates TelegramBot, routes events
- `data/chats.db` — SQLite: sessions, messages, telegram_devices tables

## Constraints

- **Tech stack**: Node.js 20, native fetch, no new npm dependencies — zero build step philosophy
- **Compatibility**: Existing paired devices must continue working after redesign (no re-pairing)
- **Data**: SQLite schema can add columns via ALTER TABLE, no DROP TABLE without migration
- **Single file**: public/index.html stays single file — same philosophy for telegram-bot.js is relaxed (can split into modules)
- **Backwards compat**: Forum Mode supergroups already set up must continue working

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep native fetch (no grammy/telegraf) | No new deps, already working | Confirmed |
| Split into 3 files: telegram-bot.js + telegram-bot-i18n.js + telegram-bot-forum.js | Reduces god-object, 18% of file is i18n, forum is 860 lines | Phase 1: i18n done |
| Formalize state machine with explicit states | Prevents pendingInput/pendingAsk conflicts | Phase 1: done |
| Replace slash-command navigation with inline-only | /project <n>, /chat <n> redundant; inline buttons are superior UX | — Pending |
| Smart persistent keyboard reflects context | Shows current project/chat name, adapts buttons | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-28 after Phase 1 completion*
