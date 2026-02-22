# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Claude Code Chat v4.0** — lightweight web UI for Claude Code. Express.js backend + vanilla JS frontend, no build tools required. Chat with Claude via WebSocket, with multi-agent orchestration, MCP server support, skills, and SQLite history.

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
1. Client sends WS message `{ type: 'chat', text, mode, model, engine, mcpServers, skills }`
2. Server loads session from SQLite, builds system prompt from active skill `.md` files
3. Routes to engine: `runCliSingle()` (spawns `claude` subprocess) or `runSdkSingle()` (SDK)
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
sessions: id, title, created_at, updated_at, claude_session_id, active_mcp, active_skills, mode, agent_mode, model, engine
messages: id, session_id, role, type, content, tool_name, agent_id, created_at
```

WAL mode enabled. `claude_session_id` enables Claude Code session resumption.

## Configuration

Environment (`.env`, see `.env.example`):
- `ANTHROPIC_API_KEY` — needed for SDK engine only; CLI engine uses Max subscription
- `PORT` — default 3000
- `SESSION_SECRET` — auto-generated if empty
- `WORKDIR` — Claude working directory, default `./workspace`
- `TRUST_PROXY` — set `true` behind nginx/Caddy

**Engines:**
- **CLI** — spawns `claude` subprocess (requires Claude Max subscription, no API key needed)
- **SDK** — uses `@anthropic-ai/claude-code` SDK (requires `ANTHROPIC_API_KEY`)

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
- Client → Server: `{ type: 'chat', text, mode, model, engine, mcpServers, skills }`
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
Use these in both `server.js` (SDK) and `claude-cli.js` (CLI). Do not use dated suffixes in CLI flags.

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
# - Send a chat message (CLI engine)
# - Send a chat message (SDK engine if API key set)
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

---

## Agent Working Guidelines

These rules apply to anyone (human or AI) making changes to this codebase.

### Before Making Changes
- **Read the file first** — never modify code you haven't read
- **State assumptions** before implementing anything non-trivial
- **Plan for 3+ step tasks** — write the plan before touching code
- **Stop and ask** when something is unclear — don't guess and push forward

### Scope Discipline
- Touch only what was asked — no unsolicited cleanup, refactoring, or "improvements"
- A bug fix does not need surrounding code polished
- No new abstractions for one-off operations — three similar lines beat a premature helper

### After Every Change
Report in this format:
```
CHANGES MADE:
- [file:line]: [what changed and why]

THINGS I DIDN'T TOUCH:
- [file]: [intentionally left alone because...]

POTENTIAL CONCERNS:
- [any risks or things to verify]
```

### Verification Before Done
- Never call a task complete without proving it works
- Run the server, test the relevant flow in the browser
- If behavior changed — describe the before/after difference

### Elegance Check (non-trivial changes only)
Before finishing, ask: "Would a senior engineer approve this PR?"
If a fix feels hacky, ask yourself: "Knowing what I know now, what's the elegant version?"
