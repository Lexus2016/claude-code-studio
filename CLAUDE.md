# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Claude Code Studio** — lightweight web UI for Claude Code. Express.js backend + vanilla JS frontend, no build tools required. Chat with Claude via WebSocket, with multi-agent orchestration, MCP server support, skills, and SQLite history.

## Commands

```bash
# Development (auto-reload)
npm run dev        # node --watch server.js

# Production
npm start          # node server.js

# Docker
docker compose up -d
docker compose logs -f claude-chat
```

No linting, no tests, no build step configured.

## Architecture

**Single Node.js process** serves everything:

```
server.js          — Express HTTP + WebSocket server (main entry point)
auth.js            — Token/session auth (bcrypt, 30-day tokens, data/sessions-auth.json)
claude-cli.js      — Spawns `claude` CLI subprocess, parses newline-delimited JSON stream
public/index.html  — Single-file SPA (embedded CSS + JS, dark theme)
public/auth.html   — Login/setup page
config.json        — MCP server definitions + skills catalog
data/chats.db      — SQLite: sessions + messages tables
data/auth.json     — bcrypt password hash + display name
skills/*.md        — Skill files concatenated into Claude system prompts
workspace/         — Claude Code working directory (WORKDIR env var)
```

## Key Flows

**Chat request → response:**
1. Client sends WS message `{ type: 'chat', text, mode, model, mcpServers, skills }`
2. Server loads session from SQLite, builds system prompt from active skill `.md` files
3. Routes to `runCliSingle()` (spawns `claude` subprocess) or `runSshSingle()` (remote SSH)
4. Streams JSON chunks back to client via WebSocket as text blocks + tool_use blocks
5. Stores all messages in SQLite with `session_id`, `role`, `type`, `content`, `tool_name`, `agent_id`

**Multi-agent mode:**
- Orchestrator generates JSON plan (2-5 subtasks with `depends_on`)
- Each agent runs independently, results passed as context to dependents
- All messages tagged with `agent_id`

**Authentication (first-run setup):**
- `/api/auth/status` → redirects to `/setup` if `data/auth.json` absent
- Setup: bcrypt hash (12 rounds) saved to `data/auth.json`
- Login: 32-byte hex token, 30-day TTL, stored in `data/sessions-auth.json`
- Protected routes check cookie `httpOnly` or `x-auth-token` header

## SQLite Schema

```sql
sessions: id, title, created_at, updated_at, claude_session_id, active_mcp, active_skills, mode, agent_mode, model
messages: id, session_id, role, type, content, tool_name, agent_id, created_at
```

WAL mode enabled. `claude_session_id` enables Claude Code session resumption.

## Configuration

Environment (`.env`, see `.env.example`):
- `PORT` — default 3000
- `SESSION_SECRET` — auto-generated if empty
- `WORKDIR` — Claude working directory, default `./workspace`
- `TRUST_PROXY` — set `true` behind nginx/Caddy

**Models** (defined in `server.js`):
- `haiku` → `claude-haiku-4-5-20251001`
- `sonnet` → `claude-sonnet-4-5-20250929` (default)
- `opus` → `claude-opus-4-6`

## MCP & Skills

- MCP servers defined in `config.json`, instantiated per-request (not persistent processes)
- Skills are `.md` files in `skills/` — contents concatenated into system prompt
- Both configurable via API (`/api/config`, `/api/mcp/*`, `/api/skills/*`) or config editor UI

## Docker

Node 20 Bookworm image. Named volumes: `data`, `workspace`, `skills`, `claude-home`. Healthcheck: `GET /api/health` every 30s.

---

## Project Conventions

### No-Build Philosophy
This is intentional — do not introduce build tools.
- **No webpack, vite, esbuild, rollup** — zero build step, ever
- **`public/index.html` is a single file** — embedded CSS + JS, dark theme. Do not split it into components or separate files.
- **No TypeScript** — vanilla JS throughout
- **No CSS frameworks** — vanilla CSS only

### WebSocket Protocol — Do Not Break
The entire UI depends on this exact message contract:
- Client → Server: `{ type: 'chat', text, mode, model, mcpServers, skills }`
- Server → Client: `{ type: 'text' | 'tool_use' | 'done' | 'error', ... }`

Changing these shapes silently breaks streaming — test in browser after any WS-related change.

### SQLite Rules
- WAL mode is on — never change the journal mode
- Schema changes: `ALTER TABLE` to add columns, or full migration with data preservation
- Never `DROP TABLE` without a migration plan

### Security Rules
- `data/auth.json` — never expose contents via any API endpoint
- All file read operations must stay within `WORKDIR` — path traversal protection is already in place, don't bypass it
- Auth tokens: 32-byte hex, stored httpOnly; accept both cookie and `x-auth-token` header

---

## Known Gotchas

### claude-cli.js — Critical Requirements
These are non-obvious bugs that caused real failures:

| Issue | Correct approach |
|-------|-----------------|
| Claude hangs forever | `--dangerously-skip-permissions` is **required** — without it Claude waits for interactive stdin (which is a closed pipe) |
| Session resume broken | Use `--resume <sessionId>` as one arg, NOT `--session-id X --resume` |
| Tool allow-list broken | `--allowedTools Bash View GlobTool` — variadic args, **not** comma-joined in a single string |
| Subprocess crashes in dev | `delete env.CLAUDECODE` before spawning — the parent Claude Code session sets this env var which confuses the child |
| Streaming not working | `--output-format stream-json` + `--include-partial-messages` are both needed |

### Model IDs (exact strings)
```
claude-opus-4-6
claude-sonnet-4-6
claude-haiku-4-5
```
Use these in `claude-cli.js`. Do not use dated suffixes in CLI flags.

### Markdown Rendering in SPA
- During streaming: `renderStreaming()` handles unclosed code fences
- On `done` event: re-render with full `renderMd()` for proper final formatting
- Code blocks have copy button + language label — preserve this behavior

---

## How to Verify Changes

No automated tests exist. Verify manually:

```bash
# 1. Start server
npm run dev

# 2. Open browser → http://localhost:PORT
# - Send a chat message
# - Check streaming works (text appears progressively)
# - Check multi-agent mode produces multiple agents in sidebar

# 3. Check database state
sqlite3 data/chats.db "SELECT id, title FROM sessions ORDER BY id DESC LIMIT 5;"
sqlite3 data/chats.db "SELECT role, type, substr(content,1,80) FROM messages WHERE session_id=X;"

# 4. Auth flow
# - Visit /setup on fresh install
# - Login / logout cycle
# - Check token cookie is httpOnly
```

<!-- GSD:project-start source:PROJECT.md -->
## Project

**Claude Code Studio — Telegram Bot UX Redesign**

The Claude Code Studio Telegram bot is a remote control interface for the web-based Claude Code Studio (Express.js + WebSocket UI). It lets users send messages to Claude, browse sessions/chats, manage tasks, monitor system status, and control remote access — all from a Telegram private chat or Forum Mode supergroup.

The current bot (telegram-bot.js, ~4693 lines) works functionally but has severe UX and navigation problems that make it frustrating to use daily. This milestone is a full redesign of the user-facing navigation, interaction model, and code architecture.

**Core Value:** A user should be able to send a message to Claude in **2 taps or fewer** — from any state, without knowing any slash commands.

### Constraints

- **Tech stack**: Node.js 20, native fetch, no new npm dependencies — zero build step philosophy
- **Compatibility**: Existing paired devices must continue working after redesign (no re-pairing)
- **Data**: SQLite schema can add columns via ALTER TABLE, no DROP TABLE without migration
- **Single file**: public/index.html stays single file — same philosophy for telegram-bot.js is relaxed (can split into modules)
- **Backwards compat**: Forum Mode supergroups already set up must continue working
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Navigation Architecture
### Primary Rule: Inline Keyboards for Navigation, Reply Keyboard for Permanent Context
| Layer | Type | Purpose | Behavior |
|-------|------|---------|---------|
| Bottom bar | Reply keyboard (persistent) | Always-visible context + quick actions | Replaces device keyboard; stays visible |
| Screen content | Inline keyboard | Navigation, selections, settings | Attached to a specific message; editable in place |
### The "One Screen Message" Pattern
- Claude responses (these are content, not navigation)
- System alerts/notifications (real-time events from the server)
- Error messages that should persist in chat history
- Initial screen bootstrap (when no `screenMsgId` exists yet)
- Every navigation action (project list, chat list, settings, back)
- Status updates triggered by button press
- Pagination (prev/next page)
### Getting to First Message in 2 Taps
## Telegram API Features to Use
### 1. Reply Keyboard with `persistent: true` and `resize_keyboard: true`
### 2. Inline Keyboards with `editMessageText` / `editMessageReplyMarkup`
### 3. `sendMessageDraft` (Bot API 9.3 / 9.5)
### 4. `setMyCommands` with Scope
### 5. `answerCallbackQuery` (mandatory after every callback)
### 6. `KeyboardButton` with `style` field (Bot API 9.4+)
### 7. Deep Linking (`?start=param`)
## Telegram API Features to Avoid
### 1. Slash Commands for Navigation (`/project 2`, `/chat 5`, `/session old`)
### 2. Multiple Simultaneous `screenMsgId` values
### 3. Reply Keyboard for Multi-Level Navigation
### 4. Encoding Navigation State into `callback_data` Strings
### 5. `sendMessage` for Status Updates / Progress Polling
### 6. Telegram Mini Apps / Web Apps for Navigation
## State Machine Approach
### Recommended: Explicit Named States per User
- A `handler` function called when free-form text arrives
- A `screen` function that (re-)renders the current UI
- A `back` state to return to when the user taps Back
### Back Button Implementation
### State Persistence
- The bot serves a single authenticated user (or a small set of paired devices)
- The SQLite database is local; process restarts are infrequent
- Node.js long-polling process stays up continuously
### Fixing the `pendingInput` Interception Problem
### `pendingAskRequestId` Conflict
## Confidence Levels
| Recommendation | Confidence | Basis |
|----------------|------------|-------|
| Inline keyboard for navigation + reply keyboard for persistent bar | HIGH | Official Telegram docs, Bot API 2.0 introduction |
| Edit-in-place for all navigation (single `screenMsgId`) | HIGH | Official docs, documented pattern |
| `sendMessageDraft` for Claude response streaming | HIGH | Bot API 9.5 changelog (March 2026), universally available |
| `answerCallbackQuery` on every callback | HIGH | Official docs, documented requirement |
| Explicit named state machine replacing flag soup | HIGH | Established FSM pattern, directly addresses documented bugs |
| `navStack` array for back navigation | HIGH | Community consensus, no Telegram API dependencies |
| `callback_data` max 64 bytes — store state server-side | HIGH | Documented API limit |
| `setMyCommands` with minimal command set (3-5 cmds) | HIGH | Official docs |
| `KeyboardButton style` field for visual hierarchy | MEDIUM | Bot API 9.4 changelog, not yet production-validated here |
| Avoid Mini Apps for navigation screens | MEDIUM | Project constraints + UX judgment |
| `sendMessageDraft` draft_id reuse pattern | MEDIUM | Changelog + community issues, not yet implemented in this project |
## Sources
- [Telegram Bot Features — Official](https://core.telegram.org/bots/features)
- [Telegram Bot API Reference](https://core.telegram.org/bots/api)
- [Bot API Changelog (sendMessageDraft, button styles)](https://core.telegram.org/bots/api-changelog)
- [Introducing Bot API 2.0 (inline keyboards)](https://core.telegram.org/bots/2-0-intro)
- [Telegram Buttons Documentation](https://core.telegram.org/api/bots/buttons)
- [sendMessageDraft streaming — openclaw community issues](https://github.com/openclaw/openclaw/issues/31061)
- [Back button in ConversationHandler — python-telegram-bot discussion](https://github.com/python-telegram-bot/python-telegram-bot/discussions/2949)
- [callback_data 64-byte limit and workarounds](https://seroperson.me/2025/02/05/enhanced-telegram-callback-data/)
- [FSM Telegram Bot in Node.js](https://levelup.gitconnected.com/creating-a-conversational-telegram-bot-in-node-js-with-a-finite-state-machine-and-async-await-ca44f03874f9)
- [Bitders — Keyboard Types Guide](https://bitders.com/blog/telegram-bot-keyboard-types-a-complete-guide-to-commands-inline-keyboards-and-reply-keyboards)
- [grammY Keyboards Plugin (reference for patterns)](https://grammy.dev/plugins/keyboard)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
