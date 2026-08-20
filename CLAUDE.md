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

No linting and no build step configured. A render + overload-detector test suite lives under `test/` (`test/render/*.test.mjs` + `test/overload-detector.test.js`) — run it with `npm test`. No CI is wired up yet.

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

**Models** — the UI exposes four choices: `haiku`, `sonnet` (default), `opus`, `fable`. The short aliases are mapped in `claude-cli.js` (`MODEL_MAP`, lines 81-89) and passed to the `claude` CLI **as-is** (`opus`→`opus`, `sonnet`→`sonnet`, `haiku`→`haiku`, `fable`→`fable`); the CLI resolves each alias internally. `server.js` defines no model map — it defers to `claude-cli.js`. Dated model IDs are kept commented out in `MODEL_MAP` and are not used.

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

### Engines
- `api` (default) — headless `claude -p` via `runCliSingle` in server.js
- `subscription` — persistent interactive tmux session (one per chat) via `claude-interactive.js`, billed on the Claude Max subscription (UI button "Subscription"). MCP servers passed via `--mcp-config` at spawn; systemPrompt via `--append-system-prompt` at spawn; config changes (skills/mode/MCP/model) auto-respawn the tmux session with `--resume` — verified to keep writing to the same transcript jsonl. Image attachments saved to temp files, paths appended to the prompt. maxTurns is not applicable. Choice persisted per session in `sessions.run_engine` (the `engine` column belongs to telegram-bot.js — do not reuse it).

**Why tmux (and not node-pty):** the engine needs a PTY that survives the Node process and is readable/writable from outside it. `tmux` delivers that as a plain binary — zero new npm deps, zero build step, matching the project philosophy. `node-pty` (the cross-platform alternative) is a native module requiring compilation — rejected for that reason.

**Platform support — capability-checked, not OS-sniffed.** `/api/version` returns `tmuxAvailable` (server runs `tmux -V` once at boot); the UI disables the "Subscription" button when false. Works on macOS / Linux / Docker (tmux in Dockerfile) / Windows-via-WSL or Git-Bash. Native Windows without tmux → button disabled, user stays on `api`. There is intentionally no Windows special-casing — the capability flag covers every case.

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

### Model aliases (exact strings)
```
opus
sonnet
haiku
fable
```
These short aliases are exactly what `claude-cli.js` (`MODEL_MAP`) passes to the CLI — pass them through **as-is**; the `claude` binary resolves each one internally. Do not use dated model-ID suffixes in CLI flags (the dated IDs are kept commented out in `MODEL_MAP`).

### Markdown Rendering in SPA
- During streaming: `renderStreaming()` handles unclosed code fences
- On `done` event: re-render with full `renderMd()` for proper final formatting
- Code blocks have copy button + language label — preserve this behavior

---

## How to Verify Changes

A render + overload-detector test suite exists under `test/` — run it with `npm test`. There is no CI yet, and it does not cover the UI/WebSocket paths, so also verify those manually:

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

---

## Planning Artifacts

Milestone plans, requirements and research live in `.planning/` (tracked in git):

- `.planning/PROJECT.md` — scope, core value, constraints, key decisions
- `.planning/ROADMAP.md`, `.planning/STATE.md` — phases and current status
- `.planning/research/*.md` — background research behind past decisions

These are internal planning documents, not build requirements. You do not need to
read them to build, run, test or contribute to this project.
