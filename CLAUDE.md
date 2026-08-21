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

No linting and no build step configured. `npm test` chains 42 test files under `test/`: 10 DOM-less render/UI-logic tests (`test/render/*.test.mjs`, run through `node --test`) plus 32 plain-`node` suites in `test/` covering the overload detector, env load order, multi-agent results, terminals, bots, telegram, updates, kanban scheduling, i18n completeness, the config precedence resolver plus its secret masking, usage-limit detection, the filesystem path guard plus the tunnel-blocks-terminal rule, WS session re-subscription, the SSH remote CLI-session import, the live engine pane / interactive-prompt watchdog, the cross-project global workspace aggregation, the rule that an SSH credential never leaves the server process, the Windows command-quoting oracle, the auth token lifecycle, the multi-agent dependency scheduler, the remote CLI-list framing parser and the one-time config/.env migration onto CCS_CONFIG_PATH. It runs serially and aborts on the first failing file. No CI is wired up yet.

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

**Interactive prompts (#20).** A subscription turn can stop on a blocking select
widget (permission question, plan approval, AskUserQuestion). `paneAwaitingInput()`
in `claude-interactive.js` recognises it structurally — ≥2 numbered option lines in
the last 24 pane rows AND a caret (`❯➤►▶›»>`) on one of them — checked only when the
spinner is stopped and no new transcript bytes arrived, confirmed over 2 polls (~3s).
The engine then emits `input_needed` / `input_resolved` on the chat socket (new
message types; the `chat`/`text`/`tool_use`/`done`/`error` shapes are untouched) and
widens its quiet-exit budget by `CLAUDE_PROMPT_GRACE_MS` (default 5 min) so the
watchdog stops declaring a blocked turn "done". The answer is typed through
`/ws/terminal?session=<id>&view=engine`, which ATTACHES a viewer to the engine's own
`ccs-<id>` pane — it never creates one, and ignores `resize`/`kill`.

**Why tmux (and not node-pty):** the engine needs a PTY that survives the Node process and is readable/writable from outside it. `tmux` delivers that as a plain binary — zero new npm deps, zero build step, matching the project philosophy. `node-pty` (the cross-platform alternative) is a native module requiring compilation — rejected for that reason.

**Dedicated tmux socket — do not move terminals back to the default one.** `terminal-bridge.js` runs every tmux command through `-L ccstudio` (`TMUX_SOCKET`). Reason, from a real failure: an agent working in this repo ran `tmux kill-server` before a test run and destroyed every live studio terminal mid-work. `kill-server` is server-wide (per socket) — the `ccsterm-` name prefix protects nothing. On its own socket, no tmux command typed in a shell can reach studio sessions. `claude-interactive.js` (`ccs-` prefix, subscription engine) imports the same `TMUX_SOCKET` and routes every invocation through its own `tmuxArgs()` — both modules share one tmux server, which is what lets a browser viewer attach to an engine pane at all. Sessions left on the default socket by older builds are reported by `listOrphanedDefaultSocketSessions()` at boot and never killed automatically.

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

`npm test` runs 42 test files under `test/` (10 `test/render/*.test.mjs` + 32 `test/*.test.js`). There is no CI yet, and nothing covers the live browser/WebSocket path, so also verify that manually:

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
