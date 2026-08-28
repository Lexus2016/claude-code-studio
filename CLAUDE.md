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

No linting and no build step configured. `npm test` chains 75 test files under `test/`: 19 DOM-less render/UI-logic tests (`test/render/*.test.mjs`, run through `node --test`) plus 56 plain-`node` suites in `test/` covering the overload detector, env load order, multi-agent results, terminals, bots, telegram, updates, kanban scheduling, the board-only `create_task` status (`task-backlog.test.js`), i18n completeness, the config precedence resolver plus its secret masking, usage-limit detection, the filesystem path guard (including the SVG sandbox header and the symlink rule on the `@`-mention search endpoints) plus the tunnel-blocks-terminal rule, WS session re-subscription, the SSH remote CLI-session import, the live engine pane / interactive-prompt watchdog, the cross-project global workspace aggregation, the rule that an SSH credential never leaves the server process, the Windows command-quoting oracle, the auth token lifecycle, the multi-agent dependency scheduler (waves, plan sanitising, and the rule that a failure warning must survive dep-context truncation), the SSH stream parser's three guards, the SSH run's termination guarantee (`ssh-termination.test.js` drives `ClaudeSSH.send()` through a fake ssh2 `Client` in `require.cache` and asserts `onDone` fires EXACTLY once on every ending — a missed one hangs the chat forever, a doubled one re-emits stderr) and the recovery contract of "Restart Session" (`session-restart.test.js` boots a real server against a fake `claude` that never exits, then pins that a restart ABORTS that turn and releases the session instead of refusing), the remote non-interactive shell environment (`remote-env.test.js`, which runs the generated prelude through real `bash -lc`: it must parse, print nothing on stdout, and never end on a false test — the caller chains `&& claude …` behind it), the remote CLI-list framing parser, the bot inbox's SQL seam (`bot-inbox.test.js` pins that `from_bot AS "from"` keeps the exact key `planInboxDelivery` reads — rename one without the other and every letter is silently retired as malformed), the one-time config/.env migration onto CCS_CONFIG_PATH and the mid-task clarification delivery contract on the subscription engine (`interrupt-delivery.test.js` — pins that the tmux injection block sits BEFORE the poll loop's completion `break`, that draining does not imply delivery, that a failed paste is re-queued and warns non-terminally, and that the task runner passes the same callbacks the chat path does), the CLAUDE.md / AGENTS.md discovery rules (`agents-md.test.js`, which also pins that AGENTS.md reaches the subprocess as `--append-system-prompt` and never as `--system-prompt`), and the remote file browser's three guard layers (`remote-files.test.js` runs the generated POSIX script through a real `/bin/sh` against a temp tree that contains symlinks OUT of the project; `remote-files-api.test.js` boots a server against a fake remote via `CCS_REMOTE_EXEC_HOOK` and drives `/api/files` the way the SPA does), the editor deep links (`editor-links.test.js` pins the two URI shapes literally — the browser link puts `vscode-remote` in the AUTHORITY and the CLI argument puts it in the SCHEME, and collapsing the two silently breaks one path; `editor-open-api.test.js` boots a real server with `PATH` pointed at an EMPTY directory, which both makes the `opened:'client'` fallback deterministic and guarantees the suite never launches an editor window on a developer's desktop), and the new-chat defaults chain (`chat-defaults.test.js` pins the pure resolver — the built-ins are asserted to be exactly what the SPA hardcoded before #58, and the choice lists to be exactly the toolbar's `data-v` sets and `MODEL_MAP`'s aliases; `chat-defaults-api.test.js` boots a real server in a throwaway `APP_DIR` and pins that a project writes back a SPARSE override object — a five-key snapshot passes every other assertion in that file and still breaks the feature). On the render side, `tables.test.mjs` also pins the ReDoS bound in renderMd step 3.4, `xss.test.mjs` runs 24 adversarial payloads end-to-end, and `forged-tokens.test.mjs` covers the case where user text contains the renderer's own placeholder control bytes, and `pane-font.test.mjs` pins the clamp DIRECTION of `_fitEnginePaneFont` (a wide engine pane may only shrink; a narrow split pane must be allowed to grow). `script-scope.test.mjs` pins which `<script>` block a helper is declared in — declarations hoist only within their own block, so a helper used by `loadSess()` must not live in the terminal block at the bottom of the file. Note the glob: a file under `test/render/` whose name does not end in `.test.mjs` is NEVER run — `_load.selftest.mjs` sat there unexecuted until it was renamed to `loader.test.mjs`. It runs serially and aborts on the first failing file. `.github/workflows/ci.yml` runs it on every push and PR to `main` (tmux installed, so the five tmux-dependent suites do not self-skip).

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
- `MULTI_AGENT_MAX_PLAN` — max agents in one chat multi-agent plan, default 8. Also the
  schema's `maxItems`; the plan is re-capped after parsing because the regex-recovery path
  bypasses the schema.
- `MULTI_AGENT_CONCURRENCY` — max `claude` subprocesses alive at once inside one wave,
  default 3. A wave still runs every member; this only bounds how many at a time.

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

### Agent modes

`sessions.agent_mode`: `single` (default), `multi`, `dispatch`, `conversation`.

**`conversation` — a room of bots.** 2-6 of the project's bots take SERIAL turns on one
user message, for at most 3 rounds / 10 messages, then the room closes with ONE artifact.
`runConversationRoom` in server.js; the decision logic (`planRoom`, `parseRoomReply`,
`roomShouldContinue`) is pure and lives in `bots.js`, pinned by `test/bots.test.js`.

Three invariants — breaking any of them is what the design was built to prevent:
- **The room is the only dispatcher.** `_ccs_bots` is deliberately NOT injected, so no bot
  can call `message_bot` inside a room. Two dispatchers would give one bot two owners in
  one turn, and the UI's turn state is keyed by handle (one slot per bot) — the second run
  would overwrite the first's chip.
- **Serial, never parallel.** Two bots writing at once interleave into an unreadable
  transcript, and the room's value is that it reads as a conversation.
- **Never nested inside a multi/DAG wave.** It is a leaf that emits one artifact; that is
  what keeps "exactly one budget object per turn" true.

A `PASS` must OPEN a reply ("the tests pass now" is a contribution, not a decline).
`@user` escalates only as a standalone token — `@@handle` addresses a peer, and neither
`superuser` nor an email address reaches the human. Escalation outranks every other stop
condition: once a bot has asked the human something, more bot turns only bury the question.

Each round runs a FRESH CLI session per bot rather than resuming that bot's long-lived
chat session — a room turn carries its whole transcript in the prompt, and resuming would
splice the room's rounds into the thread the bot uses when mentioned normally.

Not built: the room's artifact is not yet consumed by a DAG node (roadmap item 6b).

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

**A SPLIT window is composited, not sampled (`tmux-composite.js`).** Claude Code's
agent-teams splits whatever tmux window it runs in, one pane per teammate. Measured on
a live studio session: window 155x39, the user's own `claude` squeezed into 46x38 on
the left, four teammates at 108x9 stacked down the right, `pane-border-status top`, each
teammate named by `#{pane_title}`. Control mode is not a renderer — it hands the client
`%output %<pane-id> <bytes>` per pane and leaves composition to whoever is drawing — so
the viewer used to pick ONE pane, drop every other pane's bytes, and tell the browser to
shrink its xterm to that pane. The user saw a 46-column strip and nothing else.

- **The raw streams cannot be merged, and that is why this is not three lines.** Every
  pane addresses cursor positions LOCAL to itself; four TUIs writing into one screen
  buffer scribble over each other, which is the bug the pick-one-pane filter was
  introduced to stop. Re-addressing a live stream needs a terminal emulator per pane.
  `buildFrame()` composes from `capture-pane` snapshots instead, which are positionable.
- **The captures ride the CONTROL CLIENT, not `spawnSync`.** A control client answers
  every command with a `%begin`/`%end` block, so the compositor asks the client it
  already has. A `spawnSync capture-pane` per pane per frame is ~15 ms of BLOCKED event
  loop — the whole server, not just this viewer.
- **A reply closes on the `%end` carrying its own command NUMBER.** Pane content sits
  inside the block, and a pane showing the literal text `%end 1 2 3` — which this
  repository's own test output prints — would otherwise truncate the capture and blank
  half the screen. For the FIFO to line up, EVERY write goes through `sendCmd`,
  `send-keys` included.
- **Only changed rows are sent.** A Claude TUI repaints for every spinner tick; measured
  on a live four-pane session, the row diff holds a working window at ~1 fps and
  2.2 KiB/s. `capture-pane -N` is NOT the way to pad a row to the pane width (measured on
  tmux 3.7c: a 2-character row in a 60-column pane comes back padded to 15), and `\x1b[K`
  would erase every pane to the right — so a row is blanked with its own width of spaces
  and then rewritten.
- **`geometry` now carries the WINDOW, and the browser must size its xterm to that.**
  The composed frame is addressed in window coordinates. Reporting the mirrored pane's
  width is exactly what produced the strip. A split window is still never resized from
  the browser — tmux redistributes panes on the way down AND up and never restores the
  layout.
- **The primary pane is `pane_index` 0, never the ACTIVE pane.** Splitting makes the NEW
  pane active, so a viewer that re-derived its pane on attach re-pinned itself to
  whichever teammate agent-teams had spawned last. Every reconnect took that path — a
  server restart, an idle proxy timeout, a laptop waking — and the user's own agent
  vanished from a terminal that had been showing it a second earlier.
- **Borders are drawn here because tmux draws them client-side.** Control mode carries
  not one byte of them, and without the T-junction cells a seam has a one-cell hole
  wherever a horizontal border meets the vertical one.
- **`p.stdin` needs an `'error'` listener.** The compositor writes a command per frame,
  so a session dying mid-repaint lands a write on a pipe that has gone. EPIPE arrives as
  an `'error'` EVENT, not as a throw from `write()` — a try/catch does not see it and an
  unhandled one takes down the whole studio process. Observed; the sibling guard
  (`sendCmd` settling its waiter instead of hanging) is what `tmux-composite.test.js`
  can pin deterministically.


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

### Remote shell environment (issue #59)

`bash -lc` is a **login** shell, not an **interactive** one. Every version manager —
mise, asdf, nvm, pyenv, rbenv, nodenv, fnm, sdkman — publishes its binaries from
`~/.bashrc`, and the stock Debian/Ubuntu `~/.bashrc` opens with
`case $- in *i*) ;; *) return;; esac`, so none of it runs for us. The symptom was a
SessionEnd hook dying with `/bin/sh: 1: node: not found` on a host where `which node`
answers instantly.

`remote-env.js` builds the prelude every remote run prepends. Three rules it exists to
keep:

- **PATH, never `. ~/.bashrc`.** That stdout is a stream-json pipe — one MOTD banner
  derails the parse — and the rc file that would need sourcing is exactly the one the
  `return` guards, so it would contribute nothing anyway.
- **Chain-safe.** The caller joins with ` && `, so a prelude ending on a false
  `[ -d … ]` test silently cancels the `claude` invocation behind it. Everything is one
  group ending in `|| true`, and the user's `$CCS_REMOTE_INIT` runs under `eval` so a
  syntax error in it stays a runtime failure instead of a parse error that takes the
  whole remote command down.
- **After the `cd`, not before.** mise and asdf pin a version per directory
  (`mise.toml`, `.tool-versions`); running from `$HOME` reports the global one.

`testSshConnection()` runs the same prelude and reports whether `node` and `claude`
resolve, so a broken PATH is visible on the host's Test button instead of surfacing
mid-turn as a hook failure that names the wrong problem.

### Remote file browser (issue #57)

`/api/files` answered `{type:'remote'}` for a remote SSH project and the UI said "file
browser not available". That refusal was correct while there was no remote read path —
the browser reads the LOCAL disk, so pointing it at `/home/user/project` from a Windows
client resolves to `C:\home\user\project`, the #53 failure family. `remote-files.js`
adds the read path.

**Read-only, deliberately.** List a directory, read a file. `/api/files/download` and
`/api/files/raw` still answer 400 for a remote project, so the SPA hides the download,
share, copy-image and image/PDF-preview affordances behind `_filesRemote` (set from the
`remote:true` flag on the response, never inferred from the project type) instead of
leaving them to fail under the user's finger. `closeFpv()` restores them — miss that and
one remote file hides the download button for every local file opened afterwards.

**The path guard is three layers, and it is not the local one.**

1. `resolveRemotePath()` resolves with `path.posix` whatever this server runs on.
   `path.resolve()` is exactly what produced `C:\home\user\project`.
2. The remote script re-checks containment against the **physical** path (`cd … &&
   pwd -P`), not the textual one. This process cannot `lstat` the remote tree, so a
   symlink at `<project>/node_modules/x -> /etc` satisfies layer 1 by construction —
   the string still starts with the project root. A symlink whose FINAL component is a
   file is refused outright (`SYMLINK` → 403) rather than followed: resolving one
   portably needs `readlink -f`, which macOS did not ship before 12.3.
3. `parseRemoteBrowse()` drops any row whose path is not under the base the remote
   echoed back. A FILENAME is attacker-controlled in the way that matters — `touch
   $'x\nCCS… E d - /etc'` inside a repo you cloned — which is also why every control
   line is framed by a per-request random nonce.

Everything after the `FILE` header is the file, scanned no further: a file that happens
to contain the nonce must not truncate itself.

**Caps are announced, never silent.** `CCS_REMOTE_FILES_MAX_ENTRIES` (2000) sets
`truncated` on the response and the tree renders a line saying so; `CCS_REMOTE_FILES_MAX_BYTES`
(2 MB) is enforced ON THE REMOTE, before `cat`, so an 8 GB log never crosses the link.

### AGENTS.md (issue #54)

The `claude` CLI discovers `CLAUDE.md` but **not** `AGENTS.md` — measured against
2.1.231: a directory holding only `AGENTS.md` gets no project instructions at all,
while the byte-identical file renamed `CLAUDE.md` loads. A project standardised on
`AGENTS.md` therefore ran with none of its conventions, silently. `agents-md.js`
closes that gap for **local** runs.

- **Precedence is `CLAUDE.md` → `AGENTS.md`, and it is exclusive.** When a
  `CLAUDE.md` exists, `agentsMdPreamble()` returns `''` and `AGENTS.md` is not read
  at all — the CLI already loaded `CLAUDE.md`, and appending the other on top would
  hand the model two sets of conventions to reconcile.
- **It is passed as `--append-system-prompt`, never `--system-prompt`.** The latter
  *replaces* the CLI's default prompt, and several callers (the task runner without
  a bot) pass no `systemPrompt` at all — switching it on for them would drop every
  default instruction. Same `!sessionId` guard as `--system-prompt`, for the same
  reason: changing the system prompt on `--resume` invalidates thinking-block
  signatures (API 400).
- **Remote SSH runs are not covered.** The file is on the other machine and the
  server cannot read it, so `claude-ssh.js` deliberately calls none of this.
- The instruction-file editor (`/api/claude-md`) uses the same discovery, so it
  edits the file the run actually uses instead of always opening `CLAUDE.md` and
  creating a duplicate next to a real `AGENTS.md`. `POST` accepts an optional
  `file` pin, whitelisted against the two literal names — never joined from free
  text, or the endpoint becomes an arbitrary-write primitive.
- `/api/config-files` still exposes a fixed `CLAUDE.md` key. That entry is dead in
  the current UI (the config editor reads `/api/claude-md`); its key name is part of
  the endpoint's allowlist contract, so it was left alone.

### New-chat defaults (issue #58)

Every new chat used to open on literals: `newTab()` assigned `curMode='auto'` /
`curAgent='single'`, the model carried over from whichever tab was open last, and
`#maxTurns` shipped `value="50"` in the markup. `chat-defaults.js` replaces that with a
two-link chain, and it is pure (no `fs`, no `require('./server.js')`) so the precedence
is testable without booting anything:

    project override  >  global default (config.json)  >  BUILTIN

- **The project link is SPARSE, and that is the feature.** A project stores only the
  dials it pinned. Store a full five-key snapshot instead and every project silently
  freezes at whatever the global happened to be the day it was created — the opposite
  of what was asked for. `test/chat-defaults-api.test.js` asserts the object written to
  `data/projects.json`, because a snapshot satisfies every other assertion in that file.
- **`BUILTIN` is the pre-#58 behaviour, not a fresh opinion.** Changing one of the five
  changes how every install that never opened the settings form behaves.
- **`effort: 'auto'` is a spelled-out sentinel** for "pass no `--effort` flag", which the
  SPA's `<select>` and the CLI both spell `''`. It has to be a real word: `loadMergedConfig()`
  resolves with `||`, so an empty string in a config file is indistinguishable from an
  unset key. `effortToFlag()` is the single translation point.
- **`loadMergedConfig()` sanitises each LAYER, then spreads — never the reverse.**
  Spreading `~/.claude/config.json` and `config.json` raw lets a local `model:""`
  mask a valid global `model:"opus"`; the merged empty string is then dropped and the
  answer falls all the way to `BUILTIN`, while the settings catalog — which walks the
  two files separately under `falsyFallsThrough` — keeps reporting `opus` as effective.
  Two answers for one key. Per-layer sanitising IS the `||` semantics the flag claims.
- **`sanitize()` is lenient on read, strict on write.** A typo in a hand-edited
  `config.json` drops that one key and leaves the other four alone; the same typo arriving
  at `PUT /api/projects/:id/defaults` is a 400 that names the key — silently dropping a dial
  the user just clicked reads as a save that worked.
- **The global half is a settings-catalog entry, not a bespoke form.** Five rows in
  `config-resolve.js` (`section: 'defaults'`) give the Settings UI its section, its source
  badges and its per-row Reset for free. `coerceValue()` gained optional `min`/`max` for
  `chatDefaults.turns` so the form cannot store a value its own `<input>` refuses to show,
  plus an opt-in `int: true` that parses with `Number` (so `'12px'` is refused rather than
  read as `12`) and truncates AFTER the range check — the same order `chat-defaults.coerce`
  uses. Settings and the toolbar must coerce one dial identically; without `int` the older
  `parseInt` behaviour of every pre-existing number row is untouched.
- **The `falsyFallsThrough` guard is behavioural for nested keys.** `test/config-resolve.test.js`
  reads the `||` / `??` operator straight out of `loadMergedConfig()` for FLAT keys; a key
  whose `path` contains a dot has no such line, so it is checked by running the resolver
  instead. Do not weaken the flat check to make a nested key pass.
- **Membership before the unpin sentinel.** `sanitize()` rejects an unknown key whatever
  its value, so `{notADial: null}` is a typo that 400s instead of an unpin that reports
  success. `PUT /api/projects/:id/defaults` likewise refuses a non-object body — a 200 on
  `{defaults: null}` reads exactly like the reset that DELETE actually performs. A wrong
  `projectId` is 404 on all three endpoints; only *no* id means "just the global row".
- **Only a chat with no session of its own is seeded.** `applyChatDefaults()` runs from
  `newTab()`, from `switchProject()` and at boot — always behind `if (!currentSessionId)`.
  An existing chat carries its own mode/model in SQLite and `loadSess()` must keep winning.
- **The chain governs chat CREATION; execution channels keep their own budget.**
  Both server-side doors to a new interactive chat resolve it via
  `chatDefaultsForWorkdir()` (sessions have no `project_id` column, so the project is
  matched by workdir the way `/api/activity` does): the WS `chat` frame and
  `POST /api/sessions`. Both used to carry a private literal set — `sonnet`/`auto`/
  `single`/`30` — so an API client or an older cached SPA created a chat on values
  nobody had configured while the browser's toolbar showed the resolved ones. `_cd` is
  hoisted ABOVE the `createSession` INSERT so the stored row and the run cannot disagree.
  `chatDefaultsForWorkdir()` returns the FLAT `.effective` row, not the
  `{effective, global, overridden}` envelope the REST endpoints hand the browser.
- **Telegram and the scheduler deliberately do NOT inherit it** — `UNATTENDED_MAX_TURNS`
  (30, declared once next to the `chat-defaults` require). A scheduled job that silently
  inherited someone's `turns: 200` would burn a budget nobody was watching, and every
  existing install would have jumped 30 → 50 on upgrade without being asked. The same
  constant names every task/chain creation default (REST, MCP `create_task`/`create_chain`,
  Kanban dispatch), so a bare `30` reappearing next to a runner is a review signal. If
  per-channel budgets are ever wanted they belong in their own setting, not in the chat
  dials. The `maxTurns || 30` floors inside the shared runners are left alone on purpose:
  they fire only when a caller passes nothing at all, which is a different concern from
  a channel policy. Pinned by `test/chat-defaults-api.test.js`.

### A chat's own dials (issue #81)

`sessions` persisted `mode`/`agent_mode`/`model` and **not** `max_turns`/`effort`, so
`loadSess()` had nothing to restore for those two: the turn budget fell back to the
markup's `value="50"` and effort carried over from the previously open tab. Reported as
"Kanban chats ignore the default" — incidental: a task's chat is an ordinary chat.
Two columns (`ALTER TABLE`), with the #58 chain as the fallback when a chat stored none.

- **The stored value and the CLI flag are different things.** `effort: 'auto'` means
  "pass no `--effort`" and must survive a round trip through SQLite as the literal word;
  `_effortFlag = chatDefaults.effortToFlag(effort) || null` is the single translation
  point into the run options. Store the flag instead and Auto becomes indistinguishable
  from unset, which is also what the client did until it started sending the sentinel.
- **Every door that creates or copies a chat carries both.** New chat, fork, compact,
  JSON import — plus the two REPLAY paths (idle-interrupt, `resume_interrupted`), which
  rebuild run options from scratch and clobbered the dials the chat had just stored.
- **Import sanitises; the others do not need to.** That JSON is a file the user picks,
  so `max_turns: 900` arrives as easily as a real export and would reach the engine
  verbatim. `chatDefaults.sanitize()`, lenient: a bad dial falls back to the default and
  the rest of the import still lands.
- **`loadSess()` has a safe zone, and it ends at the streaming-proxy reset.** The
  function copies a background tab's accumulated stream into locals and *then* wipes the
  proxy-backed state; only the restore block at the end puts it back. So an `await` added
  past that point turns a tab switch into data loss — the early return drops the locals
  on the floor. Both awaits (`_projectsReady`, `loadChatDefaults`) sit above it, each with
  its own `if (id !== activeTabId) return`, next to the two original guards.
- **An empty `projects` array is not "no project".** The boot fetch is fired without
  await, so the first `loadSess()` after a hard refresh could `find` nothing, resolve
  `_sessProj` to `null` and take the GLOBAL defaults row for a project-pinned chat —
  the reported symptom, once per page load. `_projectsReady` holds that promise.
- **One defaults cache, several callers → last caller wins.** `loadSess`,
  `switchProject`, `newTab` and boot all write `_chatDefaults`. Without `_cdSeq` a slow
  earlier response overwrites a newer one and tags the cache with a project that is no
  longer open — self-consistent and wrong, and it repaints the badges to match.

Pinned by `test/chat-defaults-api.test.js`. Two of those pins first passed **on a
comment**: a needle like `streaming.txt = ''` matched the prose explaining the rule
before it reached the statement. Structural pins there compare indices of the real
statement, and the comments no longer spell it.

### Populating the board without running it (issue #83)

`_ccs_task_manager.create_task` hardcoded `status:'todo'`, so the only thing an agent
could do to the Kanban board was START work on it. Turning an existing plan — a
`tasks/` folder, `.planning/`, a roadmap, a checklist — into cards therefore launched
one unattended `claude` per card at the moment of import, which is the opposite of an
import. `create_task` now takes an optional `status` of `todo`, `backlog` or `done`.

- **`todo` stays the default.** Every existing caller omits the key and expects the
  follow-up work it asked for to actually start; flipping the default would silence
  all of them.
- **`done` is in the list because `- [x]` is.** Half of "preserve the status from the
  checkboxes" is items the plan already marks finished; without it an import has to
  either lie about them (`backlog`) or RUN them (`todo`). A `done` row satisfies a
  `depends_on`, which is not an escalation: the run that creates the dependency also
  creates the dependant.
- **`in_progress` is the one deliberately missing.** It would put a row on the board
  that no worker owns and `getTodoTasks` will never select — a card that looks live
  and is not. A run that wants work started asks for `todo` and lets the queue own it.
- **The two child budgets are separate, and that is the point.**
  `MAX_TASK_CHILDREN_PER_RUN` (10) bounds RUNAWAY EXECUTION: a child that runs can
  create children of its own. A board row runs nothing, so it cannot recurse, and
  counting it against that budget is what made a ten-card import consume the run's
  entire ability to create real follow-up work. `MAX_BOARD_CHILDREN_PER_RUN` (100)
  bounds the rows instead. `countChildTasksRunnable` / `countChildTasksBoard` are two
  statements for that reason; the old catch-all `countChildTasks` is gone rather than
  left as a third answer to the same question. Both predicates read a status AFTER the
  fact, so a real child that COMPLETED moves between them and frees a runnable slot —
  a known, bounded leak, not worth a column: the child has to finish while its parent
  is still running and the parent's own `max_turns` is the backstop.
- **A board card does not wake `processQueue`.** The queue selects only `todo`, so the
  `setImmediate` would walk it for nothing — eighty times for an eighty-card import.
  The UI toast needed the SAME guard and did not have it: an import stacked one
  notification per card. Board rows are coalesced through `queueBoardCardNotice()`
  instead — one debounced notice per CALLER task carrying the total, timer `unref`'d so
  a pending notice cannot hold the process open. A queued task is still announced
  immediately: it is an event, where a board row is an artifact.
- **A `backlog` dependency BLOCKS, and blocking silently was the defect.**
  `processQueue`'s gate releases a task only when every dep is `done`, and
  cascade-cancels only on `cancelled` — a `backlog` dep is neither, so the dependent was
  `continue`d on every tick forever with no log and no notification. Cancelling it would
  be wrong (the card may be triaged tomorrow) and auto-promoting the dep to `todo` would
  run work the import deliberately did not start, so the fix is observability only: one
  `log.warn` + one UI notice per task, latched in `blockedOnBoardWarned`. That latch is
  RECONCILED from the queue on every pass, never deleted from at each exit: a point
  delete would have to be repeated at cancel, cascade-cancel, task delete, session
  delete, chain delete and a `PUT` that rewrites `depends_on`, and each site missed
  leaks an id AND silences the next warning for that task, which would find its own id
  already latched. `processQueue` is the one place that knows what is blocked right now,
  so the pass that decides it owns the set. The shape predates #83 through the REST/Kanban door; what
  #83 changed is that one `create_task` call now reaches it, because an imported plan
  lands as backlog cards already carrying `depends_on`.
- **The `CCS_TASK_MANAGER_SECRET` strength floor is conditional on the POSTURE.** The
  endpoint sits ABOVE `auth.authMiddleware` and mints tasks that run `claude` with an
  arbitrary prompt, so a short value there is an unauthenticated execution primitive on
  any host whose port is *reachable* — and that qualifier is the whole rule. This app is
  a local desktop tool first and a server second, and the two deserve different answers:
  a value under 32 chars is honoured when the studio is purely local, and refused
  otherwise. A 32-char-or-longer value is unaffected by all of it; it is guessed, not
  reached.
- **"Local" is four conditions, because a loopback BIND is not unreachability.** The
  first is decided at boot, the other three PER REQUEST — the posture changes while the
  process runs:
  - **HOST is a numeric loopback LITERAL** (`/^127\.\d+\.\d+\.\d+$/` or `::1`), NOT
    `auth.isLoopbackAddress(HOST)`. That helper classifies a REQUEST's remote address,
    which is always an IP; `HOST` is a config string `server.listen()` will resolve, so
    its `/^127\./` accepts `127.attacker.example` and its `localhost` accepts whatever
    the resolver says today. A carve-out may not rest on a name someone else controls.
    Refusal warns and falls back to the random per-process default, so the MCP child
    still gets a working secret.
  - **No public tunnel is running.** `tunnel-manager.js` starts cloudflared against
    `http://localhost:PORT` — the studio publishes its own loopback port to the internet
    on a button press, long after the secret constant was computed. This is why the
    check is per-request and not a boot-time constant.
  - **`TRUST_PROXY` is unset.** It is an operator saying they put something in front on
    purpose; remote traffic then arrives from `127.0.0.1` like everything else.
  - **The request carries no `Origin`, or a loopback one.** A page on the internet
    reaches a loopback port through DNS rebinding, and `isCrossOrigin()` compares Origin
    against the request's own Host — after a rebind both are the attacker's name, so it
    passes BY CONSTRUCTION. A browser always sends `Origin` on a JSON POST, so requiring
    its absence makes a weak secret spendable by a CLI, a test or the MCP child and by
    nothing that renders HTML. `test/task-backlog.test.js` drives that case through
    `http.request` rather than `fetch`, with Host and Origin set to the SAME attacker
    name; set them differently and the cross-origin guard 403s first and the gate under
    test never runs.
  Refusing on loopback bought no security and cost the feature: a developer exporting a
  short secret to drive the endpoint from a test got a silent 401, on a machine where an
  attacker who could reach the port already had everything the endpoint would give them
  — the product's own job is to spawn `claude --dangerously-skip-permissions`.
  The header comparison goes through `timingSafeStrEq`, which already existed in the
  same file for `/api/internal/ask-user`. **The floor is not an entropy check and the
  comment says so**: `'a'.repeat(32)` passes, and no cheap test distinguishes a weak
  32-char string from a strong one. It closes the plausible-typo case (`secret`,
  `test123`); the supported configuration is still to leave the var unset. The refusal
  branch is tested by booting with `HOST=localhost` — loopback in fact, so the suite
  opens no port on any interface, and not a literal, so the boot check refuses.
- **`list_tasks` caps at `MAX_BOARD_CHILDREN_PER_RUN`, not at 50.** One run may write
  100 board rows; a 50-row answer hides the older half from exactly the dedup check
  `create_task`'s description tells an agent to run first. The cap is TWO statements of
  one number — the server's `Math.min` and the `limit` description in
  `mcp-task-manager.js`, which is the only one the agent ever reads. Raising the server
  alone leaves an agent obeying its own tool docs and never asking for the rows the fix
  exists to expose; `task-backlog.test.js` pins both. And `Math.min` alone is not a
  maximum: SQLite reads a NEGATIVE `LIMIT` as unbounded, so `limit: -1` walked the whole
  table through a cap that looked applied. The value is clamped into `[1, MAX]`, and a
  non-number falls back to the documented default instead of reaching the driver as NaN
  — it arrives from a model filling in a JSON schema, where a nonsense value is ordinary
  input rather than an attack.
- **`CCS_TASK_MANAGER_SECRET` exists so the internal endpoint is drivable from a
  test** — same class of hook as `CCS_REMOTE_EXEC_HOOK`. Opt-in; the default is still
  a fresh 16-byte random per process. `test/task-backlog.test.js` schedules every
  `todo` child a year out (`getTodoTasks` filters on `scheduled_at <= unixepoch()`) so
  the suite cannot spawn a real `claude`.
- **The deterministic folder→board importer in that issue was deliberately NOT
  built.** The parent link exists in the DATA — `tasks.parent_task_id`, written by
  this very endpoint and walked to `MAX_CHAIN_DEPTH` — but nothing DRAWS it:
  `public/kanban.html` never reads the field, the board is columns-by-status, and
  `list_tasks` returns the id without grouping on it. So the epic → subtask tree the
  issue asks for is a Kanban-UI change, not an import feature, and it would also have
  to answer to that depth cap. `POST /api/tasks` mints a git worktree per card
  (`setupUnitWorktree`), so bulk import through the REST door would be N
  `git worktree add` calls; and a regex over "common markdown formats" is wrong more
  often than an agent reading the same files is. The agent path covers it, and this
  status flag is the one thing it was missing.

### Open in VS Code (issue #63)

`editor-links.js` builds the links; `POST /api/editor/open` decides which of the two
ways to launch is right for THIS deployment. Both exist because the studio is not
always running on the machine the browser is on.

- **The two URI shapes are not the same string.** The browser deep link is
  `vscode://vscode-remote/ssh-remote+user@host/srv/app` — the editor's scheme, with
  `vscode-remote` as the URI AUTHORITY, which is how the desktop URL handler routes
  it. The CLI argument is `--folder-uri vscode-remote://ssh-remote+user@host/srv/app`
  — there `vscode-remote` IS the scheme, because the editor is already running.
  Collapse the two and one path silently stops working.
- **The server prefers its own CLI, and falls back to the deep link.** A resolvable
  `code` binary means the server is a workstation, so it opens the window itself and
  can report failure honestly. No binary means Docker, a headless host or Windows —
  and there the browser follows `vscode://`, which lands on the machine with the
  screen. That is one rule, no `process.platform` test, correct in every deployment.
- **Nothing about the deep-link outcome is detectable.** No browser reports whether a
  protocol handler exists or ran. So the SPA states the condition every time it takes
  that path ("if nothing opened, …") instead of claiming an error it cannot observe.
- **`$PATH` is walked in-process, never through `which`/`where`.** A subprocess would
  need a shell on Windows, and the value being launched is a user-chosen filesystem
  path — the BatBadBut re-parse `delegate-terminal.js` already had to work around.
  `_EXEC_EXTS` therefore excludes `.CMD`: VS Code puts `code.cmd` on PATH and Node
  refuses to spawn one without `shell: true`, so accepting it would turn every Windows
  launch into a throw instead of the deep-link fallback that works there.
- **Authorisation is the file browser's resolver, not a second guard.**
  `resolveFilesWorkdir()` gives "you may open in an editor whatever you may browse",
  plus the default-`WORKDIR` fallback and — critically — `isRemote` from the PROJECT
  RECORD. Inferring remoteness from the path would hand a local POSIX-looking workdir
  to Remote-SSH.
- **A `~/project` remote workdir is refused by name.** It is legal everywhere else in
  this app because the remote *shell* expands it; a URI has no shell, and Remote-SSH
  would look for a directory literally called `~`. Resolving it would need an SSH
  round trip, which is not something a link builder should do.
- **Per-FILE open is local-only, and not for the #57 reason.** The remote folder link
  works; VS Code's URL handler opens a remote FILE uri as a folder
  (microsoft/vscode-remote-release#4333). So `fpvEditorBtn` hides for a remote file
  while the project row keeps opening the remote workspace.
- **The editor is a fixed catalog, not a binary name field.** The value becomes both a
  URI scheme and an `argv[0]`. `EDITORS` covers VS Code, Insiders, VSCodium, Cursor and
  Windsurf — all VS Code forks, so `vscode-remote://` means the same thing in each —
  and the settings row (`config-resolve.js`, `section: 'ui'`) reads its choices from
  there rather than restating them.

### A run that strands a background task (run-continuation.js)

`subtype:'success'` is the ONE rung the auto-continue ladder does not cover, and that
is where turns were being lost. A run that started something with `run_in_background`
and then ended saying it would wait and continue reports a clean `end_turn` — so the
ladder, which fires only on NON-success, never saw it. Nothing else resumes a headless
`claude -p`: the process exits and takes the background shell with it. The chat printed
`✅ Done` over work that had not happened.

- **Detection is structural, never textual.** `isBackgroundLaunch()` matches a `Bash`
  call whose input carries `run_in_background: true` — the same JSON on every install.
  User-facing prose is written in the UI language (`buildSystemPrompt` pins that
  explicitly), so a regex over English phrases like "I'll check back" is dead on a
  French or Ukrainian install.
- **The flag is read off a PARSED object, not matched as a substring.** `grep -rn
  '"run_in_background": true' *.js` is a real command to run in this repo, and an
  unanchored regex counted it as a launch. The regex survives only as a fallback for
  input that does not parse at all (a truncated object), because a missed launch
  strands the task, which is the failure the module exists to stop.
- **The debt is INCREMENTAL and TURN-level, and the whole rule lives in the module.**
  Four earlier shapes were wrong, which is why the current one looks over-built — every
  one of them shipped green:
  a one-way `bgLaunched` latch charged an extra run to every agent that OBEYED
  `BACKGROUND_TASK_INSTRUCTION`; PER-RUN counters made the rescue run start from zero,
  so a second walk-away that touched no tool reported nothing owed and the turn said
  "Done" one run later — the same bug the bound existed to close; raw CALL counts let
  two polls of one job cancel a second, genuinely abandoned launch; and a BATCH total
  (`max(0, launches - harvests)`) BANKED a harvest with no launch behind it, so reading
  a leftover `tasks/<id>.output` from an earlier turn — often the first thing a resumed
  session does — paid for a launch that came afterwards. `applyBackgroundTool()` folds
  each tool call into `{debt, seen}`: a harvest decrements only an EXISTING debt, once
  per shell id, and a surplus is dropped rather than banked. The loops call that one
  function instead of open-coding it, because an open-coded copy is how the local and
  remote paths drift apart. Verified live on all four shapes.
- **The harvest side cannot key on `BashOutput` alone.** Measured on CLI 2.1.231, a
  background launch answers `Output is being written to: <hash>/<uuid>/tasks/<id>.output`
  and the agent collects by READING that file — `BashOutput` is never called.
  `backgroundHarvestId()` therefore also matches a `Read`/`View` of a
  `/tasks/<id>.output` path and returns the id out of it (`BG_OUTPUT_PATH_RE`), which is
  what makes repeated polling safe. A harvest whose id cannot be read returns `null` and
  does NOT pay the debt: `bash_id` is a required parameter, so that only happens on a
  malformed payload, and crediting it would let two such calls cancel a real launch —
  one extra rescue run is the cheaper mistake. Verified live: an obedient agent ends at
  `debt=0` and is not nudged; one that launches two and collects one ends at `debt=1`
  and is.
- **The detector sits ABOVE the MCP early-return in `onTool`.** A background launch is a
  fact about the run, not about how one tool is rendered.
- **`MAX_BACKGROUND_NUDGES` is 1**, so a false positive costs one short run.
- **A bounded nudge needs an honest ending.** When the harvest run ALSO walks away,
  `describeStrandedBackgroundTask()` says what was left running. The notice is written
  as a real status line (`\n\n---\n⚠️ …`) because `statusLineKind()`
  (public/index.html:7215) requires the `---` fence — without it the SPA stamps its own
  `✅ Done` badge on top of the warning.
- **It does NOT flip the returned `completed` flag, and that was tried.** `completed`
  has no consumer that would do the right thing with it: the chat path discards it, and
  the only reader (server.js:1865) is the SUBSCRIPTION branch consuming
  `runInteractiveSingle`. The API Kanban worker has its own `while (true)` that breaks
  on `subtype === 'success'` and never calls these functions at all. Worse, that one
  reader turns `completed:false` into `{subtype:'error'}` → `taskStatusForStop` →
  `'failed'`, which auto-retries a chain and re-runs every side effect. "Not marked
  done" is not "failed, retry the chain".
- **Coverage is uneven, and each path takes the channel that actually reaches it.**
  The harvest rescue lives in `runCliSingle`/`runSshSingle` only — the chat and Telegram
  paths. `taskWorker` (Kanban/scheduled, API engine), the multi-agent DAG members and
  the bots/dispatch path each run their own `cli.send` loop and build their own system
  prompt, so they got neither half; duplicating the debt accounting into a third and
  fourth loop is exactly how the local and remote paths would drift apart, so they get
  the instruction only. An UNATTENDED task walking away from a background job is the
  worst version of this bug — nobody is reading that chat — which is why it was worth
  wiring even where the rescue is not.
  **Which channel matters, and appending to the system prompt is usually the wrong
  one.** `claude-cli.js:252` drops `--system-prompt` whenever there is a session to
  resume. A multi-agent worker starts from the orchestrator's session id, and a bot
  keeps a persistent session per chat — so for those two the system prompt is dead on
  arrival, and the instruction rides the USER turn instead (`agentPrompt`, and the
  `standing` block the bots path already re-sends its roster in). `taskWorker` is the
  same story for two reasons at once — `taskBotSp` is `undefined` for a task with no
  bot, and dropped outright when the task resumes a session — so there too it rides the
  task prompt, next to `TASK_VERIFICATION_SUFFIX`, which sits in that channel for
  exactly the same reason. Chat and Telegram get it as a system prompt through
  `buildSystemPrompt`; a bot on a FRESH session gets it that way too, via `botSp`, and
  falls back to the `standing` user block once it has a session to resume.
  Putting it in the task prompt also covers a Kanban task on the `subscription`
  engine for free: that path passes `systemPrompt: ''` (server.js:1829) but
  `runInteractiveSingle` types the prompt itself into the tmux pane
  (claude-interactive.js:441), so the user-turn channel reaches it like every other.
- **The system prompt is the first line of defence, the harvest run the second.**
  `BACKGROUND_TASK_INSTRUCTION` says plainly that the turn does not resume, and is
  phrased as "anything that keeps running after the call returns" rather than one tool
  field — which is what covers the two KNOWN LIMITS, both stated in the module header.
  A process backgrounded with shell syntax (`cmd &`, `nohup`, `tmux new -d`) inside a
  FOREGROUND `Bash` call is not detected: telling `a && b`, `2>&1` and a trailing `&`
  apart needs a shell parser, and the false positives would land on ordinary commands.
  And a harvest is not PAIRED to a launch — the shell id exists only in the tool
  RESULT, while `onTool` sees tool_use blocks — so a read of some OTHER
  `tasks/<id>.output` after a launch pays that launch's debt. The mirror case, a
  leftover read BEFORE the launch, is closed by the no-banking rule; closing this one
  means threading tool_result through both transports and changing the stream contract.
- **`test/ask-user-question.test.js` extracts that `onTool` handler as source text** and
  runs it through `new Function`, so its parameter list must carry every closure the
  handler touches — `runContinuation` and `bgState` are passed in there deliberately
  rather than stubbed, to keep the real module in the path.

**`describeTurnBudgetAnomaly()` — when "raise Max turns" is the wrong advice.** Measured
against CLI 2.1.231, a run capped at N reports `num_turns === N + 1`, so a genuine
exhaustion lands AT the cap. `error_max_turns` after 3 turns against a 50-turn dial means
the cap came from somewhere else — a different CLI version, a `settings.json`, a hook on
the machine the agent runs on. Half the budget is the threshold, not "anything below the
cap": a run can stop one or two turns short for ordinary reasons, and warning on those
would be noise on every long chat. It is applied to the FIRST retry notice as well as the
exhausted one — `hit the 50-turn limit (used 3)` contradicts itself, and a user who stops
reading after the first retry never reaches the corrected sentence.

### Composer geometry and terminal-pane control

Four reports that all reduce to "the UI moved or stopped listening". Pinned by
`test/composer-terminal.test.js`.

- **The interrupt pill lives DOWNSTREAM of the textarea.** `.iw` is a flex row, so
  every earlier sibling owns the text's left edge. Upstream, the pill shoved the
  placeholder ~70px right the instant a turn started and narrowed the box enough to
  re-wrap the hint — one report, two symptoms.
- **`autosizeInput()` is the only place that reads `inEl.scrollHeight`.** The height
  of a `rows="1"` textarea is JS-owned and has to be recomputed whenever the WRAPPED
  LINE COUNT can change, which is not only when the value changes: boot, `setLang()`
  (a longer translation wraps differently), a sidebar toggle, a window resize, fonts
  landing after first paint, and the pill entering the row. The earlier fix was
  correct and ran from `restoreComposerState()` alone, so every one of those paths
  left the second line of the hint clipped. Open-coding the two lines again is the
  regression; the test counts the reads.
- **Focus, not the socket, is why a pane "needs a tab switch".** xterm routes
  keystrokes through a hidden textarea. A reconnect swaps `entry.ws` but leaves focus
  wherever it drifted while the socket died, so the pane looks live and swallows every
  key; switching tabs away and back works only because `showTerminalView()` ends on
  `term.focus()`. `ws.onopen` and a `mouseup` on the host now do the same — the latter
  skipped while a selection is being dragged out. The server-side heartbeat (v7.6.0)
  is the other half and only the other half: it reaps a dead TCP path within ~60s.
- **A stale `onclose` may not repaint the live pane.** The staleness test
  (`_terms.get(sessionId) === entry && entry.ws === ws`) used to guard only the
  reconnect, while the "disconnected" paint above it ran unconditionally. Since
  `refreshTerminalSession()` deliberately detaches before it closes, the old socket's
  close event lands *after* the new one is ready and marked a working pane dead, with
  nothing to repaint it until the next state change. The guard is now the first line
  of the handler.
- **The composer is watched by a `ResizeObserver`, not only by `toggle()`.** Both
  panels animate `width .25s`, so measuring from the click measures the box the user
  is leaving. The observer compares `clientWidth` before re-measuring — the callback
  sets the height, so an unguarded one re-enters forever.
- **Touching a pane is itself a reconnect trigger (`_reviveTerminal`).** Every
  automatic path is conditional on a state a half-dead socket does not report, so all
  three interaction paths used to give up instead: `term.onData` dropped the keystroke
  SILENTLY (the pane renders locally, so it looks alive — this is the "terminal froze
  until I reloaded the page" report), while paste and the send line toasted "not
  connected" and returned, naming the problem on the very controls that exist because
  a pane went unresponsive. They now revive and carry the frame. Only the LAST frame
  is queued — a queue of stale keystrokes replayed into a TUI is worse than a dropped
  one — a socket already CONNECTING is not raced with a second one, and `_pending` is
  cleared BEFORE the send so a failure cannot replay it on the next open too.
- **A close code is the only evidence of WHY a pane died.** `ws.onclose` took no
  argument and there was no `onerror` at all, so a terminal socket failure left no
  trace on either end — which is why "it freezes sometimes" stayed unexplained. Both
  exist now; the log sits AFTER the staleness guard, because a superseded socket
  closing is routine and would bury the closes that mean something. 1006 is an
  abnormal close with no FIN, 1009 a frame over `maxPayload`, 1011 a server error.
- **`sendToTerminal()` has no emptiness guard, on purpose.** A bare Return is the most
  useful thing this line can send: it accepts a prompt's default (`[Y/n]`, "press enter
  to continue"). `showTerminalView()` clears the box, because one send line serves every
  pane and a draft must not follow the user to a different terminal.
- **`refreshTerminalSession()` reconnects unconditionally.** Every automatic path is
  conditional on a state a half-dead socket does not report. It clears the latched
  `exited` flag first, then nulls `entry.ws` BEFORE closing the old socket — `onclose`
  compares `entry.ws === ws`, so detaching first is what stops the dying socket from
  racing a second reconnect against the new one.
- **The `.term-send` line exists because the composer is hidden.**
  `.center.term-mode > .ia` is `display: none`, so a terminal tab had no input surface
  except the pane itself — precisely what a stale socket takes away. It writes the same
  `{type:'input'}` frame `term.onData()` writes, which is why it also works on the
  subscription engine's pane (a `view=engine` viewer may only send `input`) and is a
  way to answer a blocking permission prompt. `\r`, never `\n`: a PTY needs the Return
  key, and the text and the CR go in ONE frame so a prompt that echoes and submits on
  the same tick cannot split them.

### A remote run must always end (issue #67)

`runSshSingle()` awaits a promise that resolves **only** from `onDone`. `ClaudeSSH.send()`
therefore has one hard rule: every way a run can end goes through `finish()`. Four paths
did not, and each one hung the caller forever.

The consequence is out of proportion to the cause, which is why this is written down.
A pending await keeps the session's `activeTasks` entry alive, and **nothing reaps that
entry** — the 15s orphan sweeper opens with `if (activeTasks.has(sid)) continue`. So one
missed `onDone` means: the chat refuses every new message, the spinner never stops, and
"Restart Session" answers *"Task is still running"*. Only a server restart clears it.

- **`conn.on('close')` is the backstop, and it is not redundant.** A cleanly closed socket
  emits **no** `'error'`: sshd's `ClientAliveCountMax`/`LoginGraceTime` drop, a NAT idle-reap
  and our own `conn.end()` from the watchdogs all land there only. With a channel open ssh2
  closes it too and `stream 'close'` calls `finish()` first — on the nextTick queue, so it
  wins the `setImmediate` and the run still reports its real exit code. With no channel open
  (still handshaking, or between `'ready'` and `exec`) this is the only thing left.
- **`conn.end()` is not a way to end a run.** It settles one only when a channel exists for
  ssh2 to tear down with it. Both watchdogs call `finish()` after it, for that reason.
- **The abort listener is registered at `send()` entry, not inside the `conn.exec` callback.**
  There, a Stop pressed during the handshake had no listener at all — it neither stopped the
  run nor settled the promise. `sshStream` is handed to it once the channel opens.
- **`conn.on('error')` goes through `finish()` too.** A bare `h.onDone()` left `finished`
  false, so the socket close behind the error re-emitted the stderr block and fired `onDone`
  a second time.

**"Restart Session" is a recovery action, so it aborts rather than refuses.** It used to
open by returning *"Task is still running"* whenever the session had an `activeTasks`
entry — useless in the one situation the button exists for. It now aborts the turn (the
same signal Stop sends), waits up to 5s for that turn's own `finally` to release the
session (that path also flushes partial output to SQLite, which a forced delete skips),
identity-compares before reaping so a NEW turn's entry is never the one removed, and drops
`activeChatSessions` + every socket's `_tabBusy` with it — otherwise the next message is
queued instead of run and the chat still looks dead after a restart that worked.

**The button has to be reachable without a working turn.** The in-message restart button
only renders when the server got a `session_restart_available` frame out, and the run that
needs recovering is precisely the one that never sends one. Hence `#sessBarRestartBtn` in
the session bar, shown whenever the session has a `claude_session_id`. Clearing that id is
the whole fix: `shouldReplaySessionHistory` is `!!existSess && !localClaudeId`, so the next
message replays the chat's history into a fresh Claude session rather than losing it.

### Markdown Rendering in SPA
- During streaming: `renderStreaming()` handles unclosed code fences
- On `done` event: re-render with full `renderMd()` for proper final formatting
- Code blocks have copy button + language label — preserve this behavior

---

## How to Verify Changes

`npm test` runs 75 test files under `test/` (19 `test/render/*.test.mjs` + 56 `test/*.test.js`), and `.github/workflows/ci.yml` runs the same command on every push and PR to `main`. Nothing covers the live browser/WebSocket path, so also verify that manually:

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
