# Adversarial Security & Quality Audit — Claude Code Studio v5.70.1

**Date:** 2026-07-18
**Method:** "Consilium" — six independent read-only auditors (security, backend correctness, frontend/UI-UX, architecture, docs-vs-reality, Claude-integration), each verifying findings directly against the code. Every finding cites `file:line` and was confirmed by reading the source. Items marked *suspected, unverified* were not reproducible at audit time.
**Scope:** full repository at `/Users/admin/_Projects/claude-code-studio` (server.js 7,915 lines; public/index.html 14,066 lines; electron/; claude-*.js engines; mcp-*.js; packaging, Docker, release plumbing; docs).

---

## Стислий підсумок (для команди розробки)

Аудит виявив **4 критичні** проблеми, які треба виправити негайно:

1. **Десктопний режим (Electron) — неавтентифікований RCE-сервер.** У режимі `CCS_DESKTOP=1` автентифікація вимкнена повністю (`auth.js:175`, `auth.js:189`), WebSocket не перевіряє `Origin` (`server.js:6688-6695`). Будь-яка відкрита у браузері сторінка може підключитися до `ws://127.0.0.1:<port>` і запустити `claude --dangerously-skip-permissions` — довільне виконання коду. **Фікс:** одноразовий токен на запуск + перевірка `Origin`/`Host`.
2. **SSH-пароль свідомо потрапляє в контекст LLM** (`mcp-user-interrupt.js:142-146` + `server.js:6801`) — і далі в API Anthropic та в транскрипти на диску. Шифрування at-rest зведене нанівець. **Фікс:** передавати лише ім'я хоста, креденшели резолвити на сервері.
3. **Зібраний десктопний бандл містить реальні `.env` та `config.json` розробника.** Перевірено через `asar list` на збірці 5.59.0. Якщо артефакт публікувався — **негайно ротувати секрети**. **Фікс:** виключити `!.env*`, `!config.json` в `electron-builder.yml`.
4. **SSH-рушій чату повністю зламаний:** `server.js:2837` викликає `.onUsage()`, якого не існує в `claude-ssh.js:332-341`. Кожне повідомлення в SSH-проєкті падає з `onUsage is not a function`. Жоден тест це не спіймав.

Далі — кластер HIGH: вимкнена перевірка SSH host key (`claude-ssh.js:73`), витік усього `process.env` у дочірній процес агента (`claude-cli.js:267`), bearer-секрети у world-readable файлі в `/tmp` (`claude-cli.js:105`), вразливі залежності (`ws`, `multer 1.x EOL`, `express-rate-limit` з відомим bypass), відсутність `ws.on('error')` (падіння всього сервера), CSP вимкнений при 146 `innerHTML`-синках, SVG-XSS ланцюжок, npm-пакет вагою 1.3 ГБ.

Системні причини: **триплікація** коду (три розбіжні цикли запуску агента — звідси і баг №4), **два моноліти** (server.js + index.html), **відсутність quality gates** (немає CI, `npm test` не існує, єдиний тест — червоний, release-скрипт не оновлює lockfile вже 12 релізів).

Повні звіти всіх шести аудиторів — нижче, з цитатами `файл:рядок` для кожного знахідки.

---

# Consolidated Findings (priority-ordered)

## CRITICAL

### C1. Desktop mode: unauthenticated loopback server with no Origin/Host validation → drive-by RCE
- `auth.js:175` — `if (process.env.CCS_DESKTOP === '1') return next();` (all HTTP APIs open)
- `auth.js:189` — `validateWsToken()` returns `true` unconditionally in desktop mode
- `electron/main.js:137` — forked server gets `CCS_DESKTOP: '1'`; port persisted/stable (`electron/main.js:98-106`)
- `server.js:6688-6695` — WS upgrade checks **no Origin header**; no Host validation anywhere

WebSocket is not subject to same-origin policy: any web page can `new WebSocket('ws://127.0.0.1:<port>')`, send `{type:'chat', ...}` (handler `server.js:6718`), and the server spawns `claude … --dangerously-skip-permissions` (`claude-cli.js:217`) — arbitrary command execution as the user. DNS rebinding gives the same for plain HTTP (read `~/.claude/settings.json`, chat DB via `/api/config-files`, `server.js:5280-5287`).
**Fix:** per-launch random token injected via preload, required on HTTP + WS; reject foreign `Origin` and non-loopback `Host` (rebinding defense).

### C2. SSH password injected into LLM context (→ Anthropic API + on-disk transcripts)
- `mcp-user-interrupt.js:142-146` — `sshText += \nPassword: ${att.password}`
- `server.js:6801` — attachments built with `password: decryptPassword(rh.password)`

Plaintext password embedded in `check_user_messages` tool results → sent to the API, stored in `~/.claude/projects/*/<cid>.jsonl` transcripts, potentially echoed into model output. Defeats the AES-256-GCM at-rest encryption (`server.js:2407-2413`).
**Fix:** never include `password`/`sshKeyPath` in tool-result text; reference host by name, resolve credentials server-side.

### C3. Shipped desktop bundle embeds developer's real `.env` and `config.json`
- `electron-builder.yml:26-42` — excludes `data/` but not `.env`/`config.json`
- **Verified:** `asar list dist-desktop/mac-arm64/Claude Code Studio.app/Contents/Resources/app.asar` → `/.env`, `/.env.example`, `/config.json`, `/tasks/telegram-ui-spec.md`, `/test-snapshot-1.md`
- Local `config.json` contains real `Authorization` (×2) and `GITHUB_TOKEN` values

If the 5.59.0 artifacts were published, **rotate those credentials and audit past published asars**. CI-built releases are clean only by accident.
**Fix:** add `!.env*`, `!config.json`, `!tasks/**`, `!test-snapshot*` etc. to `electron-builder.yml`; packaging smoke step asserting no secrets in the asar.

### C4. SSH chat engine 100% broken — `.onUsage is not a function`
- `server.js:2837` — `runSshSingle` chains `.onUsage(...)` on the builder
- `claude-ssh.js:332-341` — builder has only `onText, onTool, onDone, onError, onSessionId, onThinking, onRateLimit, onResult`
- Commit `2946cd7` added `onUsage()` to claude-cli.js only; `git log -S "onUsage" -- claude-ssh.js` → nothing. Verified at runtime: the chain throws.

Every SSH-project chat message fails instantly. No test covers this path.
**Fix:** add `onUsage(fn)` to the builder in `claude-ssh.js:332`, mirror usage capture from `claude-cli.js:527-530`; add a contract smoke test.

## HIGH

### H1. SSH host key verification unconditionally disabled
- `claude-ssh.js:73` — `cfg.hostVerifier = () => true;` (comment falsely claims "StrictHostKeyChecking equivalent" — it accepts *changed* keys too)
- `claude-ssh.js:389` — same in `testSshConnection`

Any on-path attacker can harvest the SSH password and inject fake output. No known-hosts pinning in `data/remote-hosts.json`.
**Fix:** TOFU — record fingerprint on first successful test, store, enforce in `_connConfig()`.

### H2. Entire server environment leaked into the permissionless `claude` child
- `claude-cli.js:267` — `const env = { ...process.env, ...(extraEnv || {}) };` only `CLAUDECODE` and conditionally `ANTHROPIC_API_KEY` stripped

`SESSION_SECRET`, Telegram tokens, `ANTHROPIC_AUTH_TOKEN`, any `.env` credentials — all inherited by a child running `--dangerously-skip-permissions` (`claude-cli.js:217`); one prompt-injected `env` call exfiltrates everything. The SSH path builds env fresh (`claude-ssh.js:222-230`) — proof the authors knew better.
**Fix:** explicit env allowlist (`PATH`, `HOME`, `LANG`, needed `ANTHROPIC_*`) + `extraEnv`.

### H3. MCP config temp file with bearer secrets world-readable in shared /tmp
- `claude-cli.js:105-106` — `fs.writeFileSync(filePath, json)` no mode → 0644; contains `ASK_USER_SECRET`, `NOTIFY_SECRET`, `SET_UI_STATE_SECRET`, `INTERRUPT_SECRET` (`server.js:5824-5859`) and user MCP API keys
- `claude-interactive.js:137` does it correctly with `{ mode: 0o600 }` — a regression, not ignorance

With those secrets any local user can POST to `/api/internal/task-manager` (`server.js:3316`) → arbitrary prompt execution as the server user.
**Fix:** `{ mode: 0o600 }`, consider `fs.mkdtemp` private dir.

### H4. Vulnerable dependencies in production (npm-audit verified)
- `ws` 8.x < 8.20.1 — uninitialized memory disclosure (GHSA-58qx-3vcg-4xpx) + memory-exhaustion DoS (GHSA-96hv-2xvq-fx4p); `new WebSocketServer({ noServer: true })` with no `maxPayload` (`server.js:71`)
- `path-to-regexp` < 0.1.13 via express 4.21 — ReDoS
- `qs` 6.11.1–6.15.1 — remote DoS
- **multer 1.x EOL** — lockfile itself carries the deprecation warning (`package-lock.json:3456`); used at `server.js:5166`, `server.js:5228`
- `express-rate-limit@8.2.1` — GHSA-46wh-pxpv-q5gq: IPv4-mapped IPv6 bypasses per-client rate limiting; the only brute-force protection (`server.js:88-94`) on tunnel-exposed instances

**Fix:** `npm audit fix`; `npm install multer@^2`; consider account-level lockout.

### H5. No `ws.on('error')` handler and no heartbeat — crash vector + phantom-connection leaks
- `server.js:6697` — connection handler registers only `message` (7167) and `close` (7780); grep for `ping(|isAlive|pong` → zero

A socket-level error with no listener → uncaughtException → process crash. Half-open connections (laptop sleep, NAT drop) never detected: they stay in `wss.clients`, `sessionWatchers` (822), keep session locks alive, and `broadcastToSession` (920) keeps sending into a black hole.
**Fix:** `ws.on('error', ...)`; 30s `ws.ping()` interval + pong liveness, terminate non-responders.

### H6. Stored-XSS chain via `/api/files/raw` serving SVG inline + CSP disabled
- `server.js:5408-5417` — `.svg` served as `image/svg+xml`, `Content-Disposition: inline`
- `server.js:3156-3157` — `helmet({ contentSecurityPolicy: false })`
- `public/index.html:4971-4979` — `isSafeHref` allows `/`-relative links

Prompt-injection chain: agent writes `evil.svg`, model emits `[click](/api/files/raw?path=evil.svg)`, one click → script in app origin with full API/WS access.
**Fix:** serve SVG/active content as `text/plain` or `attachment`, or `Content-Security-Policy: sandbox` on raw responses; re-enable CSP app-wide.

### H7. Malformed JSON body → HTML stack-trace leak; no terminal error middleware
- Only error middleware is multer-only (`server.js:5273-5277`). Verified empirically: `POST` body `{bad` → 400 with full body-parser stack + filesystem paths in HTML. `NODE_ENV` defaults to development (`server.js:7858`).

**Fix:** final `app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: ... }))`.

### H8. `.npmignore` fails its purpose — `npm pack` produces a 1.3 GB tarball
- `npm pack --dry-run`: 1.3 GB packed, 1.6 GB unpacked, 943 files — includes 774 `dist-desktop/` entries (160 MB DMG, 136 MB deb, 165 MB AppImage). No `files` allowlist in `package.json`.

**Fix:** replace denylist with a `files` allowlist (server.js, public/, skills/, bin/, scripts/install-hooks.js, hooks/, telegram/claude/mcp modules, config.example.json, .env.example, README.md, LICENSE).

### H9. CSP deliberately disabled on a 14k-line client with 349 inline handlers and 146 innerHTML sinks
- `server.js:3156-3157`; no CSP `<meta>` fallback anywhere in `public/` (0 hits). kanban/schedule/dashboard add ~120 more inline handlers.

Zero defense-in-depth: a single escaping miss in 9,000 lines of inline JS is a working script-injection in an app that spawns shells.
**Fix:** extract JS/CSS to static files, enable CSP (nonce/hash), convert inline handlers to `addEventListener`.

## MEDIUM

### Security
- **Symlink escape in file browser/download/raw endpoints** — `server.js:5357-5358`, `5384-5385`, `5402-5403`: `path.resolve()`+`startsWith()` but never `fs.realpathSync()`. Symlink to `~/.ssh/id_rsa` passes; the agent itself can plant it. **Fix:** realpath both workdir and target.
- **Session tokens and password hash world-readable (0644)** — `auth.js:21-25` `atomicWrite` default mode; verified on disk: `data/auth.json`, `data/sessions-auth.json`, `chats.db` all `-rw-r--r--` while `hosts.key` is 0600 (`server.js:2402`). **Fix:** `{ mode: 0o600 }`, chmod 700 on `data/`.
- **Path traversal via client-controlled `tabId`** — `server.js:856` tmp dir from `sessionId=tabId` verbatim from WS message (`server.js:7238`); `tabId="../../x"` escapes `os.tmpdir()`. Unauthenticated in desktop mode — compounds C1. **Fix:** validate `/^[A-Za-z0-9-]+$/` at the WS boundary.
- **First-run setup is first-comer-wins on 0.0.0.0** — `auth.js:168-171` public `/api/auth/setup`; web mode binds all interfaces (`server.js:7852`), docker-compose publishes 3000 on all interfaces. Whoever reaches the port first sets the admin password. **Fix:** one-time setup token printed to console, or loopback-only setup.
- **`/api/mcp/add` accepts arbitrary IDs → stored JS injection** — `server.js:5086-5095` no ID validation; ID lands unescaped in inline `onclick` (`public/index.html:10211-10212`, `10845`). `escArg()` (`index.html:4909`) exists for exactly this and is used in 1 of ~20 sites; `escH` misused in JS-string context at `index.html:7878`, `13166` (the file's own comment at `4904-4908` documents this pitfall). **Fix:** server-side `ID_VALID` on add; `escArg`/`data-*`+delegated listeners everywhere.
- **Prompt passed on command line — visible in `ps`** — `claude-cli.js:264` (`-p finalPrompt`), `claude-ssh.js:229`. **Fix:** pipe via stdin (stdin already opened and `end()`ed at `claude-cli.js:289`).
- **Orphaned processes / incomplete kill semantics** — `gracefulShutdown` (`server.js:7872-7914`) handles only SIGTERM/SIGINT; on crash children are reparented and run to completion. `killProc` (`claude-cli.js:11-17`) kills the tree only on Windows. SSH abort (`claude-ssh.js:242-248`) doesn't kill the remote process (no pty → no SIGHUP). tmux survivors run `--dangerously-skip-permissions` indefinitely (`claude-interactive.js:220`). **Fix:** `detached: true` + process-group kill on Unix; remote PID + cleanup exec channel or pty.
- **Predictable temp paths in shared /tmp** — `claude-cli.js:238` `claude-att-${Date.now()}` (predictable, 0644, same-ms collisions); empty-config MCP filename is a fixed publicly-computable hash → symlink clobber attack (`server.js:2323`, `4863`). `claude-interactive.js:268` attachments never deleted. **Fix:** `mkdtempSync` 0700; `O_EXCL` writes.
- **SSH connection-error path can fire callbacks twice** — `claude-ssh.js:294-304` never sets `finished` nor routes through `finish()` (`claude-ssh.js:145`); duplicate error/done WS events possible.
- **`/api/claude-md` arbitrary-location write** — `server.js:5321-5335`: client `dir` resolved with no containment check; authenticated user can plant a `CLAUDE.md` (prompt-injection payload) anywhere writable.
- **Secrets-in-context surface** — `/api/files` preview treats `.env` as previewable text (`server.js:5367`); project-file search includes `.env` (`server.js:5423`). One click pipes host secrets into the LLM context.

### Backend correctness
- **Deleting a session never stops kanban workers** — `server.js:4902-4922` aborts `activeTasks` but never `runningTaskAborts` (953); orphaned `claude` processes burn API quota; compare `DELETE /api/tasks/:id` (4154-4164) which does abort.
- **Unvalidated `depends_on` wedges tasks permanently** — `POST /api/tasks` (4104-4113) stores verbatim; `processQueue` (1459-1490) `JSON.parse` throws → caught, logged, task skipped every 15s forever. Unguarded `JSON.parse` at `server.js:3554`. **Fix:** validate on write (400); mark unparseable `cancelled`.
- **`classifyTask` timeout doesn't kill the subprocess** — `server.js:2309-2359`: 45s fallback resolves but the haiku process runs to its 10-min watchdog; caller's AbortController never passed in (6842).
- **Three diverging copies of the agent-run loop** — `runCliSingle` (2461-2780), `runSshSingle` (2783-3009), taskWorker (1095-1208): already diverged (taskWorker lacks rate_limit_event wait and session-reset handling; runSshSingle lacks thinking extraction and usage capture). `claude-ssh.js:253` drops complete lines on buffer overflow where `claude-cli.js:358-362` processes them. **This is how C4 happened.**
- **Parallel multi-agent resumes the SAME Claude session concurrently** — `server.js:3095-3114`: `Promise.all` over agents sharing one `--resume` session id → interleaved/corrupted transcripts; next agent inherits whichever sid "won".
- **Blocking sync fs reads of unbounded size in request paths** — `/api/sessions/cli-list` (`server.js:4546`) reads every `.jsonl` (tens of MB) with `readFileSync`; same at 4594, 4679; `/api/upload` (5257) sync-reads up to 20 MB then base64s. Stalls the event loop for all WS streaming.
- **Interactive-engine resource leaks** — `claude-interactive.js:268-269` `ccs-att-*` temp files never deleted; tmux sessions killed only on session delete or 30-day TTL; `gracefulShutdown` never kills them.
- **PID-reuse kills** — `server.js:1551-1553`, `1594` SIGTERM any integer PID after downtime; a recycled PID = unrelated process killed. **Fix:** verify cmdline matches `claude` first.
- **Essentially no input validation on API bodies** — `POST /api/tasks` (4104) accepts arbitrary `status`/`recurrence`/numerics (invalid status = task invisible to all queries); WS `chat` (7202) unbounded text/attachments (ws default maxPayload 100 MiB); `PUT /api/config-files` (5298) accepts a scalar → breaks `loadConfig()` (1862-1873) until hand-fixed.
- **`/api/tasks` ships full base64 attachments on every poll** — `stmts.getTasks` (`server.js:534-540`) `SELECT t.*` includes `attachments`; kanban polls this endpoint.

### Frontend / UX
- **Main SPA never handles 401** — session expiry = infinite "Перепідключення…" WS reconnect loop (`index.html:5433-5444`); `kanban.html:686`/`schedule.html:683` do it right — pattern never ported; `dashboard.html:334-339` renders 401 as terminal text. **Fix:** shared `apiFetch` wrapper with 401→`/login`.
- **Streaming re-render is O(n²)** — `index.html:6574`, `5697`: every WS chunk re-parses and re-injects the full accumulated markdown (~20 regex passes each time); resets selection and scroll. **Fix:** rAF throttle / append-only rendering.
- **Single global chat draft shared across all sessions/projects** — `localStorage['ccs:draft']` (`index.html:3709`, `9143`) leaks text across projects. **Fix:** key by session/tab id.
- **Dead test page shipped and served in production** — `public/test-ask-tool.html` posts to `/api/test/ask-user`, which does not exist (0 hits in server.js). Delete or gate behind dev flag.
- **Dev state files in static web root** — `public/.omc/` (sessions, checkpoints) served by `express.static` and packaged into Electron. Delete + exclude from packaging.

### Architecture / process
- **Release script desynchronizes the lockfile and ships untested code** — `scripts/release.js:84-97` rewrites and commits only `package.json`; lockfile stuck at `"version": "5.58.0"` (12 releases of drift). No tests/lint/build before tagging.
- **"Migrations" are ~40 lines of `try { ALTER TABLE } catch {}`** — `server.js:350-448`: empty catches swallow disk-full/corruption/typos; no `PRAGMA user_version`, no ordering, no rollback. **Fix:** versioned migration runner.
- **Docker build non-reproducible + gigabyte context** — `Dockerfile:13-15` never copies `package-lock.json` (`npm install` resolves whatever's current); `.dockerignore` omits `dist-desktop/` (1.5 GB), `.claude/`, `.playwright-mcp/` etc. — baked into the image. **Fix:** `npm ci --omit=dev`; extend `.dockerignore`.
- **`server.js` god-file** — 7,915 lines, 115 route registrations, zero `express.Router`. Owns HTTP, WS hub, kanban worker (950), scheduler (1350), skill discovery (1937-2136), SSH crypto (2393), Telegram (5711, 6076-7870), analytics, file search. Telegram logic smeared across server.js and telegram-bot.js (4,163 lines).
- **postinstall installs hooks pointing at scripts that don't exist in the repo** — `scripts/install-hooks.js:30,36` writes hooks running `node .claude/scripts/file-lock.js`, but `.claude/` is fully gitignored (`git ls-files .claude` → 0). Fresh clones get hooks that fail on every Edit/Write. Also: product postinstall shouldn't manage dev-workflow tooling.
- **No CI, no test script, and the one existing suite is red** — `.github/workflows/` has only release workflows; `package.json` has no `test`; `node test/render/integration.test.mjs` fails right now (`<h1 dir="auto">` mismatch). 12 test files exist that nothing runs. `CLAUDE.md:23` still claims "no tests configured."
- **Config sprawl — no single source of truth** — four parallel mechanisms (.env, config.json, DB rows, sidecar JSONs); nothing documents precedence. `config.example.json:90` hardcodes Docker path `/app/workspace` shipped to non-Docker users; seeded config.json never merged with upstream additions.
- **`better-sqlite3` as optionalDependency contradicts `engines: node >=18`** — `db-adapter.js:28` uses `node:sqlite` only on Node ≥ 22.13 (comment says 22.5.0 — internally inconsistent); on Node 18–22.12 falls back to an *optional* native dep that npm may silently skip → crash at boot. Dockerfile pins node:20 = the fragile path.
- **Six orphaned endpoints** — `POST /api/auth/change-password` (`server.js:3906`, **no UI exists — real functionality gap**), `GET /api/stats` (3837), `GET /api/sessions/interrupted` (4460), `POST /api/sessions/enrich-thinking` (4653), `POST /api/project/init` (5647), `GET /api/delegate/:id/dialog` (6629).

### Documentation drift
- **`.planning/` presents the shipped desktop app as "0% planned, not started"** — `STATE.md:3-14`, `ROADMAP.md:6`, `REQUIREMENTS.md:9-26` all unchecked; reality: fully shipped (electron/main.js, dist-desktop installers, live Homebrew tap). Hazardous for anyone resuming from STATE.md.
- **CLAUDE.md model section stale and self-contradictory** — `:79-83` lists dated model IDs "defined in server.js" (actually aliases in `claude-cli.js:81-89`); `:147-153` says the opposite ("do not use dated suffixes").
- **Architecture docs omit most of the codebase** — README.md:420-432 / CLAUDE.md:29-40 miss `claude-interactive.js`, `claude-ssh.js`, `tunnel-manager.js`, `db-adapter.js`, `rate-limit-utils.js`, four mcp-*.js, the entire electron/ shell.
- **`.env.example` timeout doc contradicts the code** — `:15-17` claims 30-min global timeout; reality: 10-min *idle* timeout (`claude-cli.js:69-70`). `bin/cli.js` seeds `.env` from it → every npx install silently overrides the README-documented default.
- **README claims vs reality** — "Fable *(temporarily hidden in the model picker)*" — it is not hidden (`index.html:2836`, `2697`); "8 built-in slash commands" — actually 10 (`server.js:1846-1857`); "EN/UA/RU" — actually 5 locales; "1M token context" presented as a Studio capability with no implementing mechanism in this repo (*suspected overclaim*); "Aider" listed among delegation targets but not seeded (`server.js:1840-1844`); version banner says 5.70.0 vs package 5.70.1.
- **Repo-root junk shipped to users** — `test-snapshot-1.md` (71 KB, verified inside the 5.59.0 asar), `test-ask-*.sh`, `indicator-*.png` (~380 KB), `README_RU.html` (dead artifact), `tasks/` is a graveyard of completed specs.
- **`bin/cli.js`** — prints old product name "Claude Code Chat" (`:51`); `APP_DIR = process.cwd()` (`:11-13`) silently boots a fresh empty studio when run from another directory, scattering seeded config into random cwds.
- **Install scripts** — all three install "Node.js 20 LTS" (EOL April 2026; Node 22 is active LTS and what the project itself recommends); `setup-linux.sh:123` verifies only that `node -v` runs; next-steps text Ukrainian-only while UI defaults to English.

## LOW (selection; full detail in domain reports below)

- `ALLOWED_BROWSE_ROOTS` defined (`server.js:98-103`) never referenced; `/api/browse-dirs` (`server.js:5617`, comment: "no restriction to WORKDIR") lists any host directory.
- `SESSION_SECRET` documented in `.env.example:7`, stored in auth.json (`auth.js:95`), never read anywhere — dead config misleading operators.
- SSH password "encryption at rest" is obfuscation-adjacent: key `data/hosts.key` sits next to the data file; both travel together in backups. Document the limitation.
- Telegram bot token in plaintext `config.json` (0644) (`server.js:6096-6101`).
- Non-constant-time secret comparison on internal MCP endpoints (`server.js:3180`, `3645`); secrets are per-process 128-bit random — negligible practical risk, use `timingSafeEqual`.
- Electron window lacks `will-navigate` guard (`electron/main.js:157-190`); webPreferences otherwise locked down correctly.
- Session delete leaves `pendingInterrupts`/`sessionWatchers` entries behind (`server.js:4902-4922`) — unbounded map growth.
- `GET /api/sessions/:id` loads entire history with no LIMIT (`server.js:4782`) despite a paginated endpoint existing (5055).
- Abort listeners accumulate in `claude-ssh.js:242-248` per auto-continue iteration (claude-cli.js removes them at 405-408/450-453).
- Inconsistent error responses; `PUT /api/sessions/:id` (4797) returns `{ok:true}` for nonexistent sessions.
- Telegram notify calls missing `.catch()` (`server.js:7041-7047`, `7054-7063`).
- etag granularity 1-second (`server.js:548`) — same-second edits can fail to invalidate cache.
- 19 raw `console.*` calls bypass the structured logger (`server.js:966`, `1005`, `1147`, `1553`…).
- Dispatch endpoints build session+chain outside a transaction (`server.js:7659-7670`, `4380-4392`, `3451-3458`) — mid-sequence throw leaves a headless chain row.
- MCP `create_task` inherits caller's session for chain tasks (`server.js:3377`) instead of `chain.session_id` — *suspected, unverified at runtime*.
- `SESSION_TTL_DAYS` default 30 (`server.js:219`) — data-loss-by-default for a chat tool.
- SSH engine silently lacks all internal MCP tools (`mcp___ccs_*` whitelisted at `server.js:2788-2791` but `ClaudeSSH.send` accepts no `mcpServers`) — feature-parity gap undisclosed in UI.
- Model map drift: `claude-ssh.js:16` missing `'fable'` present in `claude-cli.js:88`.
- i18n: `t()` returns raw key on miss (`index.html:4766-4768`); 45 defensive `|| 'fallback'` sites incl. hardcoded Ukrainian fallback shown in all languages (`11708`); `<html lang="uk">` while default is `'en'` (`13744`).
- External Google Fonts request from a local-first app (`index.html:8-10`) — privacy + offline delay.
- File-preview iframe lacks `sandbox` (`index.html:11419`).
- `dashboard.html:339` unescaped `e.message` into innerHTML (not currently exploitable; same sink shape that bites elsewhere).
- `check-inline-scripts.mjs` checks syntax of index.html only, wired into no CI gate — a band-aid for the monolith, not a solution.
- `docker-compose.yml:1` obsolete `version: '3.8'`; `electron/preload.js:6-7` stale comment; `app.isQuiting` typo throughout `electron/main.js`; `telegram-bot-i18n.js` 1,561 lines of string tables as JS (should be per-locale JSON); no lint/format config anywhere; `docs/electron-desktop/DESIGN.md` cites Electron 37 vs actual ^42; `docs/superpowers` spec status stale.

## Verified clean (auditors checked these explicitly)

- bcrypt cost 12, 72-byte truncation guard, constant-time compare, generic login error, setup race guarded (`auth.js:64-101`).
- Session tokens: 256-bit CSPRNG, server-side store, 30-day TTL, LRU cap, rotation on login/password change (no fixation). Cookie `httpOnly; sameSite=lax`, `secure` gated on `TRUST_PROXY`.
- No SQL injection — all dynamic queries use bound parameters; `sqlVal`/`wrapStmt` layer sane (`server.js:454-500`).
- No command injection — array-form `spawn` with `shell:false` on Unix (`claude-cli.js:281-286`), UUID regex on sessionId (`claude-cli.js:155`), POSIX single-quote escaping on tmux (`claude-interactive.js:56-58`) and SSH (`claude-ssh.js:19-24`) paths, `open-terminal` filters metachars (`server.js:4963-4986`).
- Passwords at rest properly encrypted (AES-256-GCM, random per-install key at 0600, `server.js:2393-2424`).
- File upload: random server-side filename, 20 MB cap, never executed/served back (`server.js:5219-5270`).
- Hand-rolled markdown renderer is escape-first (`index.html:5202`), scheme allowlist (`4971-4981`), tool-call details via `textContent` (`6993-6994`) — no live model-content XSS found.
- `hooks/check-interrupt.js` is NOT installed into `~/.claude`; injected per-invocation via `--settings` (`server.js:2500-2506`), no-ops outside CCS env — no tampering with user's own Claude Code setup.
- Electron webPreferences correct (`contextIsolation: true, nodeIntegration: false, sandbox: true`, `electron/main.js:164-169`); `window.open` denied + `openExternal`.
- `db-adapter.js` backend shims correct; `rate-limit-utils.js` tight and tested; `mcp-task-manager.js` validates initialization order, tool names, enums, has stdin cap and 15s timeout.
- No secrets in git history (`git log -S` clean; `config.json` untracked since `35c6d54`; `.env`, `data/`, `hosts.key` ignored; workflows use `secrets.*`). Local untracked `config.json` holds two live-looking keys — rotate if this machine/image was ever shared.
- CLI process lifecycle in claude-cli.js (idle watchdog, SIGKILL escalation, abort-listener removal, temp cleanup on close and error) carefully done.
- Concurrent sessions isolated per sessionId (separate child processes, envs, buffers); internal endpoints require random 128-bit per-process bearers.
- Telegram pairing requires a code from the authenticated UI; token not exposed via status API (`server.js:6086` returns `hasToken` only).
- 14 Telegram slash commands exist; 5-locale bot i18n with exact key parity (246×5); 28 skills catalogued correctly; scheduler/rate-limit/watchdog constants match README.

## Systemic diagnosis

1. **Triplication without abstraction** — three diverging agent-run loops, two CLI wrappers, four copies of `escH`, three READMEs, two telegram bots. C4 is literally a divergence bug.
2. **Two monoliths** — server.js (7,915 lines, 115 routes, zero routers) and index.html (14,066 lines inline). Forced CSP off, blocks linting, required inventing a syntax-only band-aid checker.
3. **No quality gates** — no CI, no test script, no lint config, release script skips the lockfile, packaging configs never audited with `npm pack --dry-run` or `asar list`. C3 and H8 were each one command away from being caught.

## Recommended fix order

1. Desktop-mode pairing token + Origin/Host checks (C1)
2. Pull SSH passwords out of LLM context (C2)
3. Rotate any secrets from published builds; fix `electron-builder.yml` / npm `files` (C3, H8)
4. Add `onUsage` to the SSH builder (C4)
5. `npm audit fix`, multer 2.x, WS error handler + heartbeat, terminal error middleware (H4, H5, H7)
6. SSH host-key pinning (H1), child-env allowlist (H2), 0600 on secret files (H3, MEDIUM perms)
7. Then: shared agent-run driver (kills the triplication), versioned migrations, CI with the existing tests, module extraction from the two monoliths.

---

# Appendix A — Security Audit (full report)

## CRITICAL

### [CRITICAL] Desktop mode: unauthenticated loopback server with no Origin/Host validation → drive-by RCE from any website
In Electron/desktop mode the entire auth wall is disabled:
- `auth.js:175` — `if (process.env.CCS_DESKTOP === '1') return next();` (all HTTP APIs open)
- `auth.js:189` — `validateWsToken()` returns `true` unconditionally in desktop mode
- `electron/main.js:137` — forked server gets `CCS_DESKTOP: '1'`
- `server.js:7852` — binds `127.0.0.1` (good) but nothing else protects it

The WebSocket upgrade handler (`server.js:6688-6695`) checks **no Origin header**, and no middleware anywhere validates the `Host` header. WebSocket is not subject to same-origin policy: any web page the user visits can run `new WebSocket('ws://127.0.0.1:<port>')`, send `{type:'chat', text:'…', workdir:'/'}` (handler at `server.js:6718`), and the server spawns `claude … --dangerously-skip-permissions` (`claude-cli.js:217`) — full arbitrary command execution as the user. The port is even persisted/stable across launches (`electron/main.js:98-106`), and is trivially scannable. DNS rebinding gives the same result for the plain HTTP API (read `~/.claude/settings.json`, `.env`, chat DB contents via `/api/config-files`, `server.js:5280-5287`).

**Fix:** in desktop mode generate a per-launch random token, inject it into the renderer (preload), require it on HTTP + WS; also reject WS upgrades with a foreign `Origin` and requests with a non-`127.0.0.1`/`localhost` `Host` header (rebinding defense).

## HIGH

### [HIGH] SSH host key verification unconditionally disabled
- `claude-ssh.js:73` — `cfg.hostVerifier = () => true;` (comment claims "StrictHostKeyChecking equivalent: accept new hosts automatically" — it is not equivalent; it accepts *changed* keys too)
- `claude-ssh.js:389` — same in `testSshConnection`

Combined with password auth (`claude-ssh.js:65-66`), any on-path attacker (or a malicious/DNS-spoofed host) can harvest the SSH password and inject fake output into agent sessions. The saved-hosts model (`data/remote-hosts.json`) has no known-hosts pinning at all.

**Fix:** record the host key fingerprint on first successful test (`testSshConnection` already exists as the TOFU point), store it in `remote-hosts.json`, and enforce it in `_connConfig()`.

### [HIGH] Brute-force rate limiting bypassable (vulnerable express-rate-limit)
`server.js:88-94` — the only brute-force protection (`authLimiter`, 10 req/15 min on `/api/auth/login` + `/api/auth/setup`) relies on express-rate-limit **8.2.1**. `npm audit` confirms the installed version is in the vulnerable range of GHSA-46wh-pxpv-q5gq: *"IPv4-mapped IPv6 addresses bypass per-client rate limiting on dual-stack servers."* An attacker rotating `::ffff:a.b.c.d` representations gets unlimited password attempts against an internet/tunnel-exposed instance (the app ships one-click cloudflared/ngrok exposure).

**Fix:** `npm audit fix` (express-rate-limit ≥ fixed version — verify), and consider an account-level lockout, not just per-IP.

### [HIGH] Stored-XSS chain via `/api/files/raw` serving SVG inline + CSP disabled
- `server.js:5408-5417` — `.svg` is served as `image/svg+xml` with `Content-Disposition: inline`; SVG scripts execute when the URL is opened top-level, in the app's own origin.
- `server.js:3156-3157` — `helmet({ contentSecurityPolicy: false })` removes the last safety net.
- `public/index.html:4971-4979` — `isSafeHref` allows `/`-relative links, so model output can render a clickable link straight to the malicious SVG.

Attack chain (prompt injection): a malicious repo/webpage instructs Claude to write `evil.svg` into the project, then emit `[click here](/api/files/raw?path=evil.svg)`. One user click → script running in the app origin with full API/WS access.

**Fix:** serve SVG (and any active content) as `text/plain` or `attachment`, or add a `Content-Security-Policy: sandbox` header on `/api/files/raw` responses; ideally re-enable a CSP for the whole app.

### [HIGH] Vulnerable dependencies in production (`npm audit` verified)
- `ws` 8.x < 8.20.1 — uninitialized memory disclosure (GHSA-58qx-3vcg-4xpx) + memory-exhaustion DoS (GHSA-96hv-2xvq-fx4p). The server creates `new WebSocketServer({ noServer: true })` with no `maxPayload` (`server.js:71`).
- `path-to-regexp` < 0.1.13 via express 4.21 — ReDoS.
- `qs` 6.11.1–6.15.1 via express/body-parser — remote DoS.

**Fix:** `npm audit fix`; pin updated versions.

## MEDIUM

### [MEDIUM] Symlink escape in file browser/download/raw endpoints
`server.js:5357-5358`, `5384-5385`, `5402-5403` — containment is checked with `path.resolve()` + `startsWith()` but never `fs.realpathSync()`. A symlink inside a registered project pointing at `~/.ssh/id_rsa` or `/etc/passwd` passes the check and its content is returned/streamed. The Claude agent itself (running with `--dangerously-skip-permissions` in that workdir) can create such a symlink — another prompt-injection-to-secret-exfiltration chain.

**Fix:** resolve realpath of both the workdir and the target and re-check containment.

### [MEDIUM] Session tokens and password hash stored world-readable (0644)
`auth.js:21-25` — `atomicWrite()` uses `fs.writeFileSync` with no mode → 0644 under a typical umask. Verified on disk: `-rw-r--r-- data/sessions-auth.json`, `-rw-r--r-- data/auth.json` (while `data/hosts.key` is correctly 0600, `server.js:2402` — inconsistent). `sessions-auth.json` contains live bearer tokens equal to full account access; on any multi-user host (the Linux-server install is a documented use case) any local user can steal a session. `chats.db` is also 0644.

**Fix:** `fs.writeFileSync(tmp, content, { mode: 0o600 })` for `auth.json`, `sessions-auth.json`, and chmod 700 on `data/`; same for `projects.json`/`remote-hosts.json`.

### [MEDIUM] Path traversal in interrupt-attachment temp dir via client-controlled `tabId`/`sessionId`
`server.js:856` — `const tmpDir = path.join(os.tmpdir(), \`claude-int-${sessionId}-${interruptId}\`)`; called at `server.js:7266` with `sessionId = tabId` taken verbatim from the WS message (`server.js:7238`). `tabId = "../../x"` makes `path.join` escape `os.tmpdir()`, creating a directory and writing attacker-chosen file content (attachment name itself is sanitized at `server.js:875`, the directory is not). Authenticated in web mode, but **unauthenticated in desktop mode**, where it compounds the CRITICAL above.

**Fix:** sanitize/validate `tabId` (e.g. `/^[A-Za-z0-9-]+$/`) at the WS boundary.

### [MEDIUM] First-run setup is unauthenticated first-comer-wins on a 0.0.0.0 listener
`auth.js:168-171` — `/api/auth/setup` is public; `auth.js:83-84` only checks `isSetupDone()`. Web mode binds all interfaces (`server.js:7852`), and `docker-compose.yml` publishes `3000` on all interfaces. Anyone who reaches the port before the legitimate owner (port scan, tunnel URL guess during first run) sets the admin password and owns an agent host with shell access.

**Fix:** print a one-time setup token to the server console/log and require it for `/api/auth/setup`, or restrict setup to loopback.

### [MEDIUM] CSP entirely disabled on a 14k-line client with 148 `innerHTML` sinks
`server.js:3156-3157`. The custom markdown renderer escapes HTML (`public/index.html:5202`) and allowlists link schemes (`:4971`), which is good, but one miss in 148 sinks is game over with no CSP backstop (see the SVG finding).

## LOW

- **[LOW] `ALLOWED_BROWSE_ROOTS` is dead code** — defined at `server.js:98-103`, never referenced again. Meanwhile `/api/browse-dirs` (`server.js:5617`, comment: *"no restriction to WORKDIR"*) lets any authenticated client list any directory on the host. The unused constant suggests an intended restriction that was never wired up.
- **[LOW] `SESSION_SECRET` is a broken promise** — `.env.example:7` documents it as "Session encryption secret", `auth.js:95` stores a `sessionSecret` in auth.json, but nothing in server.js ever reads either (grep: zero matches). Dead config that misleads operators about how sessions are protected.
- **[LOW] SSH password "encryption at rest" is obfuscation** — AES-256-GCM key stored at `data/hosts.key` right next to `data/remote-hosts.json` (`server.js:2393-2424`); both in the same backup/export. Only protects against copying one file without the other.
- **[LOW] `/api/claude-md` arbitrary-location write** — `server.js:5321-5335`: client-supplied `dir` is `path.resolve`d with no containment check; an authenticated user can plant a `CLAUDE.md` into any directory the server user can write.
- **[LOW] Secrets-in-context surface** — `/api/files` preview treats `.env` as previewable text (`server.js:5367`) and project-file search includes `.env` (`server.js:5423`); one click pipes host secrets into the LLM context window.
- **[LOW] Telegram bot token in plaintext config** — `server.js:6096-6101` saves `botToken` into `config.json` (0644), which the Electron "Import data" feature then copies around (`electron/main.js:370`).
- **[LOW] Non-constant-time secret comparison on internal MCP endpoints** — e.g. `server.js:3180`, `3645`: plain `!==` string compare. Secrets are per-process 128-bit random (`server.js:834-847`), so practical risk is negligible; `crypto.timingSafeEqual` is the tidy fix.
- **[LOW] Electron window lacks a `will-navigate` guard** — `electron/main.js:157-190` handles `window.open` correctly (deny + `openExternal`) and webPreferences are locked down (`contextIsolation: true, nodeIntegration: false, sandbox: true`), but a same-origin `location.href` navigation to an external URL would load it in the app window.
- **[LOW] postinstall script** — `scripts/install-hooks.js` runs on every `npm install` and writes `.claude/settings.json` + directories. Scope-checked: it only writes inside the package's own root, merges rather than clobbers, executes nothing downloaded. Acceptable, but install-time code execution is the kind of hook a supply-chain attacker would target; keep it minimal.

## Verified clean
- bcrypt: cost 12, 72-byte truncation guard, constant-time compare via bcryptjs, generic login error, setup race guarded (`auth.js:64-101`) — solid.
- Session tokens: 256-bit CSPRNG, server-side store, 30-day TTL, cap with LRU eviction, new token on login/password change (no fixation) — solid.
- Cookie flags: `httpOnly, sameSite:'lax'`, `secure` gated on `TRUST_PROXY` — reasonable.
- Command construction: claude-cli uses `spawn` with arg arrays, `shell:false` on Unix; SSH path shell-escapes every interpolated value (`claude-ssh.js:19-24`); `open-terminal` filters shell metachars and escapes quotes (`server.js:4963-4986`); `/api/external-agents/:id/test` validates the command name before `execSync` (`server.js:6514`) — no injection found.
- File upload: random server-side filename, 20 MB cap, extension from client name but never executed or served back as files (`server.js:5219-5270`) — OK.
- `renderMd` escapes HTML before transformation and allowlists href schemes; `auth.html` uses `textContent` only — no DOM-XSS found in those paths.
- Internal MCP endpoints use per-process random 128-bit bearer secrets (`server.js:834-847`) — OK.
- No secrets in git: `config.json` untracked since `35c6d54`; live keys in working-tree `config.json` never committed (`git log -S` clean); `.env`, `data/`, `hosts.key` all ignored; `.github/` workflows use `secrets.*` properly. The local untracked `config.json` contains two live-looking API keys — rotate if this machine/image was ever shared.
- Telegram pairing requires a code generated from the authenticated web UI; token not exposed via status API (`server.js:6086` returns `hasToken` only) — OK.

**Domain verdict:** The web-mode authentication core is genuinely well-built, and the developers clearly thought about injection in the CLI/SSH spawn paths. The two structural holes are: (1) the Electron desktop mode runs a completely unauthenticated agent-control server on loopback with no Origin/Host checks — drive-by RCE; (2) the SSH layer has no host-key verification, making its password auth MITM-harvestable. Around those sit defense-in-depth failures that become exploitable precisely through the product's own agent: symlink-unaware path checks, inline-served SVG with CSP disabled, `.env` happily previewed into LLM context. Fix desktop auth, pin SSH host keys, `npm audit fix`, chmod 600 the data/ secrets — that collapses most of the real risk.


---

# Appendix B — Backend Correctness & Code Quality (full report)

*Method: all 7,915 lines of server.js plus db-adapter.js, auth.js, rate-limit-utils.js, mcp-task-manager.js, claude-cli.js, claude-ssh.js, claude-interactive.js read in full; three hypotheses verified empirically with node/git.*

## CRITICAL

### [CRITICAL] SSH chat engine is 100% broken — `.onUsage is not a function`
- **Evidence:** `server.js:2837` — inside `runSshSingle` (spans 2783–3009): `ssh.send({...}).onText(...).onThinking(...).onTool(...).onSessionId(...).onRateLimit(...).onResult(...).onUsage(u => { ... })`. But `claude-ssh.js:332-341` — the builder object returned by `send()` has only `onText, onTool, onDone, onError, onSessionId, onThinking, onRateLimit, onResult`. No `onUsage`.
- **Verified:** `git show 2946cd7` ("fix(ctx): show real context-window occupancy") added `onUsage()` to **claude-cli.js only** yet wired it into **runSshSingle** too; `git log -S "onUsage" -- claude-ssh.js` → nothing. Running the actual chain throws `TypeError: stream.onText(...)...onUsage is not a function` inside the `runOnce` Promise executor → rejects → propagates out of `runSshSingle` → every SSH-project chat message fails instantly. No test covers this path.
- **Fix:** Add `onUsage(fn)` to the returned builder in `claude-ssh.js:332`, initialize `h.onUsage`, and mirror claude-cli.js:527-530 (capture `data.message?.usage` in `_handle`). Add a smoke test for the chain contract.

## HIGH

### [HIGH] No `ws.on('error')` handler and no heartbeat — crash vector + phantom-connection leaks
- **Evidence:** `server.js:6697` — `wss.on('connection', ...)` registers only `ws.on('message')` (7167) and `ws.on('close')` (7780). An 'error' event on a WebSocket with no listener is thrown by EventEmitter → uncaughtException → process crash. Separately, grep for `.ping(|isAlive|pong` → zero matches: no ping/pong heartbeat exists.
- **Why it's wrong:** (1) A socket-level error (corrupt frame, deflate error) can take down the whole server. (2) Half-open TCP connections (laptop sleep, NAT drop without FIN) are never detected: they stay in `wss.clients`, in `sessionWatchers` (server.js:822), keep `activeChatSessions` locks alive (the 30s orphan sweeper at 1520 checks `_tabBusy` flags on these zombie sockets), and `broadcastToSession` (920) keeps "successfully" sending into a black hole since `readyState` stays 1.
- **Fix:** Register `ws.on('error', () => {})` in the connection handler; add a 30s `ws.ping()` interval + `ws.on('pong')` liveness flag, terminating non-responders.

### [HIGH] Malformed JSON body → HTML stack-trace leak; no terminal error middleware
- **Evidence:** The only error middleware is `server.js:5273-5277` (multer-only, and registered mid-file). Verified empirically against this exact stack: `POST` with `Content-Type: application/json` and body `{bad` → `400` with `<!DOCTYPE html>...<pre>SyntaxError: Expected property name... at JSON.parse ... at parse (body-parser/lib/types/json.js:92:19)...</pre>` — full filesystem paths and stack, in HTML, on an API route. `NODE_ENV` is not set to production by default (server.js:7858 logs it as 'development').
- **Fix:** Append a final `app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type === 'entity.parse.failed' ? 'invalid_json' : 'internal_error' }))` after all routes.

## MEDIUM

### [MEDIUM] Deleting a session never stops kanban workers bound to it — orphaned `claude` processes keep burning API quota
- **Evidence:** `server.js:4902-4922` (`DELETE /api/sessions/:id`) and `4923-4949` (bulk-delete) abort `activeTasks` (web/telegram chats) but never consult `runningTaskAborts` (953) or kill `worker_pid` before `stmts.deleteTasksBySession.run(sid)`. Compare with `DELETE /api/tasks/:id` (4154-4164), which does abort. Result: the task row vanishes while its `startTask` loop and `claude` subprocess run to completion; the post-loop `UPDATE tasks SET status=...` then silently no-ops on a deleted row.
- **Fix:** Before deleting, look up in-progress tasks for the session, add to `stoppingTasks`, abort via `runningTaskAborts`/`killByPid` (mirror 4156-4164).

### [MEDIUM] Unvalidated `depends_on` wedges tasks permanently; `JSON.parse` without guard in MCP endpoint
- **Evidence:** `POST /api/tasks` (4104-4113) stores `depends_on` verbatim (`sqlVal(depends_on)` — no JSON validation). In `processQueue` (1459-1490) a malformed value throws in `JSON.parse`, is caught and merely logged — the task is skipped every 15s tick forever, staying `todo` with no failure state. Separately, `server.js:3554`: `depends_on: task.depends_on ? JSON.parse(task.depends_on) : []` in `/api/internal/task-manager` has no try/catch (outer catch converts to a 500).
- **Fix:** Validate JSON + array-of-strings on write (400 on invalid); in `processQueue`, mark unparseable `depends_on` tasks `cancelled` with `failure_reason='invalid_depends_on'`.

### [MEDIUM] `classifyTask` timeout doesn't kill the subprocess; ignores caller abort
- **Evidence:** `server.js:2309-2359` — the 45s `CLASSIFY_TIMEOUT_MS` timer resolves with a fallback but the spawned `claude` (haiku) process is never aborted (`cli.send` is called with no `abortController`); it lives until its own 10-min idle watchdog. `processChat` passes its `abortController` nowhere into `classifyTask` (6842), so pressing Stop during classification leaves the classifier running too.
- **Fix:** Pass an AbortController into `classifyTask`, abort it on timeout and wire it to the caller's controller.

### [MEDIUM] Three diverging copies of the agent-run loop
- **Evidence:** `runCliSingle` (2461-2780), `runSshSingle` (2783-3009), and the taskWorker loop (1095-1208) are near-identical overload/rate-limit/auto-continue implementations — and have already diverged: the taskWorker has **no** `rate_limit_event` reset-based wait (only overload retry + a post-hoc `isTransientOverload(fullText)` classification at 1218), and no broken-session reset (`isResettableClaudeSessionError` handling exists only in the chat loops); `runSshSingle` lacks the JSONL thinking extraction (2751-2761) and usage capture. `claude-ssh.js:253` also drops *complete* lines on buffer overflow where `claude-cli.js:358-362` processes them first.
- **Fix:** Extract the retry/backoff/classification loop into one shared driver (rate-limit-utils.js is already the seed of this).

### [MEDIUM] Parallel multi-agent execution resumes the SAME Claude session concurrently
- **Evidence:** `server.js:3095-3114` — `Promise.all(runnable.map(...))` spawns concurrent `cli.send({ sessionId: currentSessionId ... })` calls; all parallel agents `--resume` one identical claude session id and race on `currentSessionId` via `onSessionId` (3111). Concurrent writers to a single CLI session transcript produce interleaved/corrupted context and the next agent inherits whichever sid "won".
- **Fix:** Run each parallel agent with its own (forked or fresh) session id, or serialize agents that share a session.

### [MEDIUM] Blocking sync fs reads of unbounded size in request paths
- **Evidence:** `/api/sessions/cli-list` (`server.js:4546`) — `fs.readFileSync(filePath, 'utf8')` on **every** `.jsonl` in the project dir (these files reach tens of MB); `/api/sessions/cli-import` (4594) and `/api/sessions/enrich-thinking` (4679) same pattern; `/api/upload` (5257) sync-reads up to 20 MB into memory then base64s it. Each call stalls the single event loop for seconds and blocks all WS streaming.
- **Fix:** Use `fs.promises`/streams; for cli-list, read only the head/tail like `extractThinkingFromJsonl` (4487-4501) already does.

### [MEDIUM] Interactive-engine resource leaks: tmux sessions and image temp files
- **Evidence:** `claude-interactive.js:268-269` — `ccs-att-<rand>.<ext>` files written to `os.tmpdir()` are never deleted (only the `ccs-msg-*` prompt file is, at 287). Tmux sessions are killed only on session delete (`killInteractiveTmux` at 4915/4939) or the 30-day TTL cleanup; `gracefulShutdown` (7872-7912) never kills them. An abandoned subscription session leaves a live `claude` TUI (RAM + tmux) indefinitely.
- **Fix:** Delete attachment temp files after the turn completes (or on transcript EOF); add tmux cleanup to gracefulShutdown for sessions with no recent activity (or an idle reaper).

### [MEDIUM] PID-reuse kills: startup recovery and watchdog SIGTERM arbitrary recycled PIDs
- **Evidence:** `server.js:1551-1553` and `1594` call `killByPid(task.worker_pid)`; `killByPid` (187-197) sends SIGTERM (or `taskkill /F` on Windows) to any integer. If the server was down long enough for the OS to recycle the PID, an unrelated process is killed.
- **Fix:** Verify the PID's command line matches `claude` before killing (`/proc/<pid>/cmdline` on Linux, `ps -p` elsewhere), or record a start-time token.

### [MEDIUM] Essentially no input validation on API bodies
- **Evidence:** `POST /api/tasks` (4104): `status`, `recurrence`, `sort_order`, `max_turns`, `scheduled_at` accepted unchecked (only string-length caps on title/description) — an arbitrary `status` string makes a task invisible to every queue/status query. `PUT /api/tasks/:id` (4115) same. WS `chat` messages (7202): `text` and `attachments[].base64` unbounded — the ws default `maxPayload` is 100 MiB, and `noServer` mode sets no tighter limit — so a single WS frame can push ~100 MB into SQLite and temp files. `PUT /api/config-files` (5298) accepts any *syntactically* valid JSON for config.json — a scalar (`"5"`) then breaks `loadConfig()` (1862-1873: `c.slashCommands.map` on undefined) until the file is hand-fixed.
- **Fix:** Whitelist enums (status, mode, agent_mode, model, recurrence pattern), bound numeric fields, cap WS message/attachment sizes, and require config.json payloads to be plain objects.

### [MEDIUM] `/api/tasks` ships full base64 attachments on every poll
- **Evidence:** `stmts.getTasks` (`server.js:534-540`) is `SELECT t.* ...` — includes the `attachments` TEXT column (base64 blobs written by 985-1005). The kanban UI polls this endpoint (with an etag that any task update busts), so a few image-attached tasks turn every refresh into a multi-MB payload.
- **Fix:** Exclude `attachments` from the list query (fetch per-task on demand).

## LOW

- **[LOW] Secret files written world-readable:** `auth.js:21-25` `atomicWrite` uses default mode → `data/auth.json` and `data/sessions-auth.json` are `-rw-r--r--`, while `hosts.key` is correctly `0600` (`server.js:2402`). Verified with `stat`. Fix: `{ mode: 0o600 }` on auth/session writes (and chmod on read of existing files).
- **[LOW] Session delete leaves `pendingInterrupts` and `sessionWatchers` entries behind** (`server.js:4902-4922` cleans `activeTasks`, `chatBuffers`, `sessionQueues` only) — small unbounded map growth across many deleted sessions.
- **[LOW] `GET /api/sessions/:id` loads the entire message history** (`server.js:4782`, `getMsgsLite` has no LIMIT) even though a paginated endpoint exists (5055). Long sessions → multi-MB JSON per tab switch.
- **[LOW] Missing `onUsage` capture in `claude-ssh.js:_handle` (344-375)** — even after adding the builder method, usage is never extracted there (claude-cli.js:527-530 shows the pattern).
- **[LOW] Abort listeners accumulate in claude-ssh.js:** shared `abortController` gets a new `addEventListener('abort', ...)` per auto-continue iteration (`claude-ssh.js:242-248`) and it's never removed (claude-cli.js removes it at 405-408/450-453).
- **[LOW] Inconsistent error responses / missing existence checks:** `PUT /api/sessions/:id` (4797) returns `{ok:true}` for nonexistent sessions; `DELETE /api/mcp/:id` (5115) silently ok's non-custom/missing ids; many 500s return raw `e.message` (e.g., 4647, 4774) while others use fixed strings. No shared error envelope.
- **[LOW] Dead artifacts:** orphaned comment `server.js:3835` ("Test endpoint to simulate Ask tool") — the endpoint is gone; `public/test-ask-tool.html` is referenced nowhere. `CLAUDE_MAX_LIMITS` (211-214) hardcodes "~45 messages/day" plan quotas that are fiction-prone.
- **[LOW] Telegram notify calls missing `.catch()`:** `server.js:7041-7047` and `7054-7063` call `telegramBot.notifyTaskComplete(...)` bare (taskWorker uses `.catch(() => {})` at 1257/1303) — rejections hit the global `unhandledRejection` net.
- **[LOW] etag granularity:** `getTasksEtag` (548) uses `MAX(updated_at)` at 1-second resolution — two edits in the same second can fail to invalidate the client cache.
- **[LOW] Mixed logging:** 19 raw `console.*` calls (e.g., 966, 1005, 1147, 1553) bypass the structured logger introduced at 48-66, so production JSON logs are interleaved with free-form lines.
- **[LOW] MCP `create_task` inherits the caller's session for chain tasks** (`server.js:3377`) instead of the target chain's own `session_id` (the UI route 4265 uses `chain.session_id`) — child task joins the wrong shared session. **Suspected, unverified at runtime.**
- **[LOW] `SESSION_TTL_DAYS` defaults to 30** (`server.js:219`) — sessions are hard-deleted by default with only stats archived; data-loss-by-default for a chat tool.
- **[LOW] Dispatch endpoints build session+chain outside a transaction** (`server.js:7659-7670` WS dispatch, 4380-4392 REST dispatch, 3451-3458 MCP create_chain) — a mid-sequence throw leaves a headless chain row. The task inserts themselves are transactional (7680).

## Explicitly checked and found OK
- **SQL injection:** none — all dynamic queries use bound parameters (`list_tasks` builder at 3514-3531 included); the `sqlVal`/`wrapStmt` layer (454-500) is a sane guard.
- **JSON.parse of external input** is almost universally try/catch-wrapped; the one miss is 3554 above.
- **auth.js** is genuinely solid: setup race guarded (`_setupInProgress` + post-await re-check), constant-shape login errors, session cap + TTL, throttled lastUsed flush, in-memory session cache eliminating the stale-read window.
- **db-adapter.js** — clean; the `BEGIN IMMEDIATE` shim and pragma shim are correct for both backends.
- **rate-limit-utils.js** — tight, correct, tested (`test/overload-detector.test.js`).
- **mcp-task-manager.js** — stdin cap, parse guards, action-override protection (229), 15s HTTP timeout: all fine.
- **No TODO/FIXME/HACK comments exist** in the backend files (grep hits are a Ukrainian word containing the pattern and a literal pairing-code format example).
- Process lifecycle in claude-cli.js (idle watchdog, SIGKILL escalation, abort-listener removal, temp-file cleanup on close **and** error) is carefully done; `proc.stdin.end()` after failed spawn does **not** crash (verified).

**Domain verdict:** The backend's skeleton is better than its 7,915-line-monolith reputation suggests: SQL is parameterized, the CLI subprocess wrapper is defensive, and the auth module is genuinely careful. But it ships one show-stopper — the SSH engine has been dead on arrival since commit 2946cd7 because `.onUsage()` was wired into `runSshSingle` without ever existing in `claude-ssh.js`, and no test caught it — plus a process-crash vector (no WS error handler/heartbeat) and an HTML stack-trace leak on every malformed JSON body. The systemic disease is triplication: three agent-run loops and two CLI wrappers that have already drifted apart (that's exactly how the SSH bug happened), compounded by near-zero input validation, sync multi-MB fs reads in request paths, and lifecycle gaps. Fix the CRITICAL first, then WS hardening; the duplication is the refactor that prevents the next one.

---

# Appendix C — Frontend & UI/UX Audit (full report)

*Scope: `public/index.html` (14,066 lines, 789 KB — all 146 innerHTML sinks triaged), dashboard.html, kanban.html, schedule.html, auth.html, test-ask-tool.html, scripts/check-inline-scripts.mjs, plus server-side touchpoints needed to judge exploitability.*

### [HIGH] CSP deliberately disabled while the app depends on 349 inline handlers and 146 innerHTML sinks
`server.js:3156-3157` — `app.use(helmet({ contentSecurityPolicy: false }))`. `public/index.html` alone has 349 inline `on*=` attributes and 146 `innerHTML` assignments; kanban/schedule/dashboard add ~120 more inline handlers. There is no CSP `<meta>` fallback in any page (grep across `public/` = 0 hits). Zero defense-in-depth: a single escaping miss anywhere in the 9,000 lines of inline JS is immediately a working script-injection, in an app whose backend can spawn shells. Fix: extract JS/CSS to static files, then enable CSP with a nonce or hash; at minimum `script-src 'self'` and drop inline handlers for `addEventListener`.

### [HIGH] 14,066-line monolithic inline script — the core maintainability defect driving everything else
`public/index.html` is 789 KB of inline `<style>` + two inline `<script>` blocks containing the entire SPA: markdown renderer, WS client, i18n dicts for 5 languages, file manager, MCP/skill config UI, tabs, kanban glue. No module boundaries, no linting, no bundler, no source maps. The same `escH` helper is copy-pasted into 4 files (`public/index.html:4895`, `kanban.html:602`, `schedule.html:643`, `dashboard.html`), so any security fix must be applied 4 times. Fix: split into `public/js/*.js` modules; this also unblocks the CSP fix above.

### [MEDIUM] Server-validated-in-one-place ID injection into inline `onclick` JS strings
Multiple renderers interpolate raw IDs into single-quoted JS strings inside inline handlers:
- `public/index.html:10211-10212` — `onclick="event.stopPropagation();openMcpModal('edit','${id}')"` and `rMcp('${id}')` — `id` is the MCP server config key, **not escaped at all**.
- `public/index.html:10845` — `rSkill('${id}')`, same pattern.
- `public/index.html:9354, 9368` — `activityOpen('${it.session_id}','${it.project_id||''}')`, raw.
- `public/index.html:9431` (`toggleSessCheck('${s.id}')`), `11658-11659` (`renameProject('${p.id}'...)`), `12126-12128` (`testRemoteHost('${h.id}')`).

The MCP *import* endpoint validates IDs (`server.js:5127` `ID_VALID = /^[a-zA-Z0-9_-]{1,64}$/`), but `/api/mcp/add` (`server.js:5086-5095`) does **no** ID validation — `c.mcpServers[id]=entry` with any string. The UI-side add form validates (`index.html:10458`), but a direct authenticated POST stores an ID like `x');alert(1);//` which then renders into the MCP list of every client — stored JS injection in handler context. The codebase even has the correct tool: `escArg()` (`index.html:4909`, with a comment describing exactly this hazard) — it is used in exactly **one** of ~20 such sites (`index.html:11368`). Fix: validate `id` server-side in `/api/mcp/add` (reuse `ID_VALID`), and use `escArg` (or `data-*` attributes + delegated listeners) everywhere.

### [MEDIUM] `escH` misused in JS-string context — the exact bug `escArg` was written to prevent
`public/index.html:7878` — `ondblclick="...startRenameTab(event,'${escH(tab.id)}')"` and `onclick="...closeTab('${escH(tab.id)}')"`; same at `public/index.html:13166`. `escH` turns `'` into `&#39;`, but HTML attribute decoding happens **before** JS parsing, so `&#39;` becomes a literal `'` again and breaks out of the JS string. Currently the IDs are app-generated (no apostrophes), so it's latent, not live — but the file's own comment at `index.html:4904-4908` documents this pitfall and the code then commits it. Fix: `escArg` here; enforce via the inline-script check.

### [MEDIUM] Main SPA never handles 401 — session expiry = silent failure + infinite reconnect loop
`public/index.html` has no `401` check anywhere (only `/login` redirects at load time, 4790-4798). Every `fetch` failure is swallowed into `console.error`/`toast` (e.g. `9443`, `9976`, `11561`), and the WS layer (`5433-5444`) reconnects forever with capped 30 s backoff regardless of close reason — a cookie expiry or server restart leaves the user staring at "Перепідключення…" indefinitely instead of being sent to `/login`. Contrast: `kanban.html:686` and `schedule.html:683` do it right; the pattern just wasn't ported to the main page. `dashboard.html` is worse — it renders "Failed to load analytics / HTTP 401" as a terminal state (`dashboard.html:334-339`). Fix: a shared `apiFetch` wrapper with a 401→`/login` redirect, and check `ev.code`/auth failure in `ws.onclose`.

### [MEDIUM] Dead test page shipped and served in production
`public/test-ask-tool.html` (403 lines) is served from the static root (`server.js:3689`). It posts to `/api/test/ask-user` (`test-ask-tool.html:292, 312`) — **that endpoint no longer exists** in `server.js` (grep: 0 hits). Both dead UI and a dev tool left in the release. Fix: delete the file or gate it behind a dev flag.

### [MEDIUM] Streaming re-render is O(n²) per response
`public/index.html:6574` and `5697` — on *every* WS stream chunk, the entire accumulated markdown is re-parsed and re-injected: `streaming.el.querySelector('.msg').innerHTML = renderMd(streaming.txt)`. `renderMd` (`5183-5327`) runs ~20 regex passes plus list/table/admonition parsers over the full text each time. A 50 KB answer with hundreds of chunks means tens of thousands of full re-parses plus full DOM replacement (which also resets user text selection and scroll-in-message state). Fix: throttle renders (rAF), or append-only rendering for completed blocks.

### [LOW] Unescaped `e.message` into innerHTML in dashboard
`public/dashboard.html:339` — `content.innerHTML = \`...<small>${e.message}</small>...\``. Today `e.message` is only `HTTP ${res.status}` (334), so not exploitable, but it's the same sink shape that bites elsewhere, and a future `throw new Error(await res.text())` (the pattern used in `kanban.html:687`) would make it server-text injection. Fix: `textContent`.

### [LOW] Single global chat draft shared across all sessions/projects
`public/index.html:3709` restores `localStorage['ccs:draft']` on every page load; `9143` writes it on tab switch. One key for the whole app: type a draft in project A, switch to project B, and the text appears in B's composer. Fix: key drafts by session/tab id (they already key UI state per project, e.g. `PROJ_TABS_KEY(pid)` at 11761).

### [LOW] Dev state files shipped inside the static web root
`public/.omc/sessions/…json` and `public/.omc/state/checkpoints/…json` — leftover tool state in the directory served by `express.static`. Harmless content (verified: counters only) and behind `authMiddleware` (`server.js:3678`), but shipped to every install and packaged into the Electron app. Fix: delete and add `.omc` to the packaging exclude list.

### [LOW] i18n inconsistencies
- `t()` returns the raw key on a miss (`index.html:4766-4768`), so gaps surface as literal `queue.edit.title`-style strings; 45 call sites defensively append `|| 'English fallback'` (e.g. `5837`, `8980`, `12875`) — including a hardcoded Ukrainian fallback `t('search.empty') || 'Не знайдено'` at `11708` shown in all languages.
- Hardcoded untranslated strings mixed in: `13157` `"No open sessions"`; `index.html` ships `<html lang="uk">` while `setLang` defaults to `'en'` (`13744`).
- `t()` re-reads `localStorage` on every call inside render loops (4767) — minor perf, wrong layering.

### [LOW] `check-inline-scripts.mjs` — the band-aid, and it only half-holds
The script exists because the entire app logic lives in inline `<script>` blocks that no linter/bundler ever sees; a single syntax error silently kills the whole SPA at load. It was added in commit `c2862b3` after exactly that class of breakage. What it does: `new Function(code)` on each inline block of **index.html only**. What it doesn't do: check `kanban.html`/`schedule.html`/`dashboard.html`, catch undefined references, bad escaping, or runtime errors — and it's not wired into a visible CI gate. It holds for its narrow purpose (all 155 inline `on*=` handler names in index.html resolve to defined functions — no dead buttons), but it's a symptom of the monolith, not a solution.

### [LOW] External Google Fonts request from a local-first app
`public/index.html:8-10` — `fonts.googleapis.com` preconnect + stylesheet. Every app start phones home to Google (privacy), and offline/LAN-only deployments get a render delay. Fix: bundle the font or drop it.

### [LOW] File-preview iframe lacks `sandbox`
`public/index.html:11419` — `<iframe src="/api/files/raw?...">` for PDFs. The server sends a correct `application/pdf` MIME with nosniff (`server.js:5408-5417`), so current risk is low, but one `sandbox` attribute would make previewing files from untrusted cloned repos robust against future MIME changes.

## Verified clean
- The custom markdown renderer is genuinely careful: full `escH` pass before markup injection (`5202`), scheme allowlist for links (`4971-4981`), code blocks re-escaped (`5319`), tool-call details via `textContent` (`6993-6994`), ask-user cards escaped (`7140-7142`), reply quotes escaped (`6608`, `9578`) — no live model-content XSS found.
- `auth.html` is small, uses `textContent` for errors, cookie is `httpOnly; sameSite=lax` (`server.js:3891`) — clean.
- No tokens/passwords in localStorage (only prefs/drafts); no `console.log` spam; no hardcoded localhost URLs; WS URL derived from `location` (`5410-5411`).
- Modal stack has a real focus trap + Escape handling + focus restore (`3791-3817`); switches get `role="switch"`/`aria-checked` (`10197-10199`); main input has `aria-label` (`2993`).
- WS reconnect has backoff+jitter, duplicate-socket guard, and re-subscription (`5398-5457`) — reasonable apart from the missing 401 exit.
- `kanban.html`/`schedule.html` escape consistently and handle 401 — the best-shaped pages in the set.

**Domain verdict:** The frontend is a single 789 KB HTML file that contains the entire application, and that one decision poisons everything downstream: CSP had to be switched off, linting is impossible, a syntax-only "checker" script had to be invented as a band-aid, and escaping helpers are copy-pasted across four files. The hand-rolled markdown renderer is escape-first and no live XSS was found in the model-content path — but the security posture rests entirely on every one of 146 innerHTML sites remembering to call `escH`, and they demonstrably don't (`escArg` used once in ~20 handler-interpolation sites; `/api/mcp/add` accepting arbitrary IDs that land unescaped in inline `onclick`). The most user-visible defects are operational: the main SPA never reacts to session expiry, drafts leak across projects, a dead test page ships in the release, and streaming re-renders quadratically. Priorities: (1) extract inline JS to files and turn CSP on, (2) server-side ID validation on `/api/mcp/add` + systematic `escArg`, (3) shared fetch wrapper with 401 handling, (4) delete `test-ask-tool.html` and `public/.omc/`.


---

# Appendix D — Architecture & Design Review (full report)

## CRITICAL

### 1. Desktop build leaks the developer's real `.env` and `config.json` into the shipped app
`electron-builder.yml:26-42` sets `files: ["**/*", ...]` and excludes `data/`, `workspace/`, `README*`, `dist-desktop/` — but **not** `.env` or `config.json`. electron-builder matches dotfiles (`minimatchOptions = { dot: true }`) and its default `excludedNames` contain no `.env`/`config.json` entries. The local `config.json` contains **zero** `YOUR_` placeholders and real `Authorization` (×2) and `GITHUB_TOKEN` values.

**Smoking gun, verified:** `asar list dist-desktop/mac-arm64/Claude Code Studio.app/Contents/Resources/app.asar` returns:
```
/.env
/.env.example
/config.json
/tasks/telegram-ui-spec.md
/test-snapshot-1.md
```
So the locally-built v5.59.0 bundle embeds the author's live secrets. If those artifacts were published, the secrets are in the wild — **rotate them and check published asars for past releases**. CI-built releases are clean only by accident (gitignored files absent from checkout).
Fix: add `!.env*`, `!config.json`, `!tasks/**`, `!test-snapshot*`, `!test-*.sh`, `!.crosswork/**`, `!.superpowers/**`, `!.planning/**` to `electron-builder.yml`; add a packaging smoke step asserting no secrets in the asar.

### 2. `.npmignore` fails its stated purpose — `npm pack` produces a 1.3 GB tarball
`.npmignore` excludes `*.png`, `data/`, `.env`, `config.json` but forgets `dist-desktop/`, `docs/`, `build/`, `homebrew-tap/`, `test-snapshot-1.md`, `*.jpg`, `test-ask-tool.html`. `npm pack --dry-run` result: **package size 1.3 GB, unpacked 1.6 GB, 943 files**, including 774 `dist-desktop/` entries (`dist-desktop/claude-code-studio-5.59.0-arm64.dmg` 159.6 MB, `.deb` 136.8 MB, `.AppImage` 164.8 MB…). `package.json` has no `files` allowlist.
Fix: replace the denylist with a `files` allowlist in `package.json` (server.js, public/, skills/, bin/, scripts/install-hooks.js, hooks/, the telegram/claude/mcp modules, config.example.json, .env.example, README.md, LICENSE).

## HIGH

### 3. multer 1.x — EOL and vulnerable, and the lockfile says so itself
`package-lock.json:3456`: `"deprecated": "Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x. You should upgrade to the latest 2.x version."` (resolved 1.4.5-lts.2; package.json:42 pins `^1.4.5-lts.1`). Used for uploads at `server.js:5166` and `server.js:5228`.
Fix: `npm install multer@^2` (API-compatible for this usage).

### 4. Docker build is non-reproducible and the context bakes in gigabytes of junk
- `Dockerfile:13-15`: `COPY package.json ./` then `npm install --production` — **package-lock.json is never copied**, so the image gets whatever versions resolve that day.
- `.dockerignore` omits `dist-desktop/` (1.5 GB on the author's machine), `.claude/`, `.playwright-mcp/`, `.serena/`, `.superpowers/`, `.planning/`, `docs/`. `Dockerfile:17` `COPY . .` then bakes them into the image — including the author's `.claude/settings.local.json`, `.claude/pending/`, `.claude/worktrees/` on local builds.
- `Dockerfile` postinstall runs `scripts/install-hooks.js`, which creates `/app/.claude/settings.json` with hooks pointing at `.claude/scripts/file-lock.js` — scripts that don't exist in the image (see finding 9).
Fix: `COPY package.json package-lock.json ./` + `npm ci --omit=dev`; add the missing dirs to `.dockerignore`.

### 5. Release script desynchronizes the lockfile and ships untested code
`scripts/release.js:84-97` rewrites `package.json`, commits **only that file**, tags, and pushes straight to `main`. Verified result: `package-lock.json:3` still says `"version": "5.58.0"` while `package.json:3` is `5.70.1` — twelve releases of lockfile drift. No tests, lint, or build are run before the tag; the only "gate" is a clean-tree check (release.js:72-82) that explicitly ignores everything except package.json.
Fix: use `npm version <part>` (updates lockfile, commits, tags in one step) or add `npm install --package-lock-only`; run the test suite before pushing.

### 6. "Migrations" are ~40 lines of `try { ALTER TABLE } catch {}`
`server.js:350-448`, e.g. `server.js:350`: `try { db.exec(\`ALTER TABLE sessions ADD COLUMN workdir TEXT\`); } catch {}`. Empty catches swallow *every* error — disk-full, corruption, syntax typos — not just "column exists". There is no `PRAGMA user_version`, no migration table, no ordering, no rollback story. A silently-failed column add surfaces later as a crash at statement-prepare time, far from the cause.
Fix: a minimal versioned migration runner (`user_version` + ordered `migrations/NNN.sql`), keep idempotent `ADD COLUMN` only behind a version check.

## MEDIUM

### 7. `server.js` is a god-file: 7,915 lines, 115 route registrations, zero routers
Verified: 115 `app.get/post/put/delete` calls, no `express.Router` anywhere. The same file owns: HTTP routes, WebSocket hub, Kanban queue worker (`server.js:950`), recurring scheduler (`server.js:1350`), skill discovery/caching (`server.js:1937-2136`), SSH key crypto (`server.js:2393`), Telegram message processing *and* Telegram API endpoints (`server.js:5711`, `server.js:6076-7870`), session import/export/compact, analytics, file search. Telegram logic is smeared across `server.js` **and** `telegram-bot.js` (4,163 lines) with no clear boundary.
Fix: split along the existing comment banners — `routes/`, `db/` (+migrations), `scheduler.js`, `kanban-worker.js`, `ws-hub.js`, `skills.js`, `config.js`; move all Telegram endpoints into the telegram module.

### 8. `public/index.html` is the frontend monolith twin: 14,066 lines / 790 KB, no build step
The entire SPA (markup, CSS, JS) lives inline in one HTML file. The repo even ships `scripts/check-inline-scripts.mjs` — evidence the authors know inline scripts are a problem — yet the architecture guarantees they stay inline. The test suite has to *regex-extract functions out of the HTML* and eval them with `new Function` (`test/render/_load.mjs:14-26`, with a comment admitting the "column-0 closing brace" heuristic is the only thing keeping it working).
Fix: extract JS to `public/js/*.js` modules served statically; then the render tests can import real modules.

### 9. postinstall installs hooks pointing at scripts that don't exist in the repo
`scripts/install-hooks.js:30,36` writes `.claude/settings.json` hooks running `node .claude/scripts/file-lock.js`, but `.claude/` is fully gitignored (`git ls-files .claude` → 0 files) and no tracked code ever creates `file-lock.js`. A fresh clone gets hook config whose commands fail on every Edit/Write in Claude Code. Bonus smell: this runs as `postinstall` of the *product* (`package.json:11`) — dev-workflow tooling firing on every `npm install`, including Docker image builds.
Fix: either track `.claude/scripts/*.js` (and stop ignoring them), or have install-hooks.js write the script bodies too; move it out of `postinstall` into an explicit `npm run setup`.

### 10. No CI, no test script, and the one existing suite is red
`.github/workflows/` contains only `release.yml` and `release-desktop.yml` (both tag-triggered) plus `FUNDING.yml`. `package.json` has no `test` script. Verified locally:
- `node --test test/` **fails** (runner chokes on the mixed-style directory: the CJS test calls `process.exit`, helpers aren't node:test).
- `node test/render/integration.test.mjs` **fails right now**: expects `<h1>Audit complete</h1>` but the renderer emits `<h1 dir="auto">` — a red test nobody runs.
- `CLAUDE.md:23` still claims "No linting, no tests, no build step configured" — doc drift.
Fix: convert tests to `node:test` style, add `"test": "node --test test/render/*.test.mjs && node test/overload-detector.test.js"`, fix the `dir="auto"` assertion, add a CI workflow on push/PR.

### 11. Config sprawl — no single source of truth
Four parallel mechanisms: `.env` (12 vars, `.env.example:1-28`), `config.json` (MCP servers + skills, seeded by `bin/cli.js:22-33` from `config.example.json`), rows in `data/chats.db`, and sidecar JSON (`data/projects.json` via `server.js:2365-2366`, `remote-hosts.json`, `auth.json`). Nothing documents precedence. Concrete drift:
- `config.example.json:90` hardcodes the Docker path `/app/workspace` in the bundled `filesystem` MCP server — shipped to every non-Docker user.
- `skills/` has 30 `.md` files but the example config registers only 27 (`interview`, `plan-execute`, `qa-verification` missing) — rescued only by runtime auto-discovery (`server.js:2036-2079`) with a hardcoded category map (`server.js:111`).
- A user's seeded `config.json` is never merged with upstream example additions after first run.
Fix: declare env > config.json > defaults precedence in one loader module; regenerate the example from the skills directory.

### 12. `better-sqlite3` as optionalDependency contradicts `engines: node >=18`
`db-adapter.js:28` uses built-in `node:sqlite` only on Node ≥ 22.13 (the comment at line 6 and the error at line 105 both say 22.5.0 — internal inconsistency). On Node 18–22.12 it falls back to `require('better-sqlite3')`, which is an *optional* dep (`package.json:46-48`) — npm may silently skip it when native compilation fails, and then the server crashes at boot with an advisory error. `package.json:32-34` claims `node >=18` support anyway; the Dockerfile pins node:20, i.e. the fragile path.
Fix: either raise `engines` to `>=22.13` (and the Docker base to node:22), or make better-sqlite3 a hard dependency. Unify the 22.5/22.13 messaging.

## LOW

- **README quadruplication & drift.** `README.md` (34 KB) / `README_RU.md` (58 KB) / `README_UA.md` (56 KB) are hand-maintained translations; all three still say `5.70.0` (package is 5.70.1). `README_RU.html` (53 KB rendered export with embedded base64 fonts, last touched 21 March) is a dead artifact — delete it. Deeper content drift between languages: suspected, unverified beyond version strings.
- **`docker-compose.yml:1`**: `version: '3.8'` — obsolete key, Compose v2 warns. Harmless.
- **Stale comment** `electron/preload.js:6-7`: says the update API "will be added … in the Update & Distribution phase" — it is implemented directly below at lines 15-19.
- **Repo-root junk** shipped to users: `test-snapshot-1.md` (71 KB), `test-ask-tool.sh`, `test-ask-user.sh`, `indicator-*.png` (~380 KB of screenshots) sit in root, land in the npm tarball and (some) in the asar (verified: `test-snapshot-1.md` is in the 5.59.0 bundle).
- **`bin/cli.js:11-13`**: `APP_DIR = process.cwd()` means running the binary from a different directory silently boots a *fresh, empty* studio with its own DB/config — confusing failure mode; it also scatters seeded `config.json`/`.env` into whatever directory the user happened to be in.
- **`app.isQuiting`** typo throughout `electron/main.js` (e.g. lines 71, 337) — consistent so harmless, but sloppy in a flagship file.
- **Telegram i18n as code**: `telegram-bot-i18n.js` is 1,561 lines of string tables in JS; should be per-locale JSON. (Key parity is exact — 246 keys × 5 languages, verified — so this is maintainability, not a bug.)
- **No lint/format config anywhere** — no eslint/prettier/biome config, none in devDependencies. For a 25k-line hand-maintained codebase that's how `isQuiting` and stale comments survive.

**Genuinely fine (one line each):** the forum/i18n split out of `telegram-bot.js` uses a clean facade-composition pattern with no helper duplication (`telegram-bot-forum.js:6-30`); `db-adapter.js`'s backend shims are well-documented and scoped; Electron window hardening (`contextIsolation`, `sandbox`, `nodeIntegration: false`, `electron/main.js:164-169`) is correct; release-desktop.yml's cask-bump dependency design is thoughtfully documented.

**Domain verdict:** The architecture is a two-monolith system (7.9k-line `server.js` + 14k-line `index.html`) held together by section-banner comments, with zero module boundaries where it matters (115 routes, no routers), try/catch-swallow "migrations," and no CI to catch the one red test it has. The process failures are worse than the code shape: the release script doesn't touch the lockfile (12 releases of drift), the npm packaging denylist leaks 1.3 GB of build artifacts, and — most seriously — the electron-builder config bakes the author's real `.env` and `config.json` into distributable app bundles, **verified present in the local 5.59.0 build**; if that build was published, credential rotation is required. Priorities: (1) rotate secrets and fix `electron-builder.yml`/`files` allowlists, (2) upgrade multer, (3) wire the existing tests into CI and fix the red one, (4) version the DB migrations, (5) then start carving routes and the scheduler out of `server.js`.

---

# Appendix E — Functionality Gaps & Documented-vs-Actual Drift (full report)

*Method: extracted concrete claims from README.md, CLAUDE.md, tasks/, .planning/, docs/, install/, homebrew-tap/ and verified each against server.js routes (enumerated at server.js:3178–6674), claude-cli.js, auth.js, public/*.html (all fetch() URLs and WS message types cross-checked), electron/main.js, bin/cli.js, package.json, docker-compose.yml, Dockerfile, .env.example.*

### [HIGH] `.planning/` claims the shipped Electron Desktop milestone is "0% planning, not started"
- `.planning/STATE.md:3-14` — `milestone: v1.1 Electron Desktop`, `status: planning`, `percent: 0`, "Phase: 05 — De-Risk Spikes (not started)".
- `.planning/ROADMAP.md:6` — "🚧 **v1.1 Electron Desktop** - Phases 5-8 (in progress)".
- `.planning/REQUIREMENTS.md:9-26` — every requirement (`DESK-01`…`UPD-02`) unchecked `[ ]`.

Reality: the desktop app is fully shipped. `electron/main.js` implements exactly these requirements (fork at `electron/main.js:128-137`, `APP_DIR=userData`, `127.0.0.1` bind at `:78`, ephemeral port at `:89`, claude CLI detection at `:44-64`, Import-data menu at `:449`); `dist-desktop/` contains released 5.59.0 installers; the Homebrew tap is live. Anyone (human or agent) resuming from `.planning/STATE.md` would "plan Phase 05" for a feature that shipped months ago. Fix: mark v1.1 shipped in STATE.md/ROADMAP.md and check off REQUIREMENTS.md (or delete the stale planning set).

### [MEDIUM] Broken debug page shipped in production: `public/test-ask-tool.html`
`public/test-ask-tool.html:292,312` fetches `/api/test/ask-user` — grep confirms **zero** occurrences of that route in `server.js`. The page is publicly served (`server.js:3689`) and bundled into the Electron app. It is linked from nowhere (orphaned). Fix: delete the page.

### [MEDIUM] Six orphaned server endpoints with no caller anywhere
Cross-checked all `fetch()` URLs in `public/*.html` plus electron/telegram/bin/scripts against the route table — these have zero callers:
- `server.js:3906` `POST /api/auth/change-password` — **no UI exists to change your password**, despite auth being a headline security feature. A genuine functionality gap, not just dead code.
- `server.js:3837` `GET /api/stats` — multi-agent stats endpoint, no consumer.
- `server.js:4460` `GET /api/sessions/interrupted` — no consumer.
- `server.js:4653` `POST /api/sessions/enrich-thinking` — no consumer (CLI-import flow uses `/api/sessions/cli-import` instead).
- `server.js:5647` `POST /api/project/init` — superseded by git-init logic inside `POST /api/projects` (`server.js:5520`); frontend uses the latter (`public/index.html:12054`).
- `server.js:6629` `GET /api/delegate/:id/dialog` — the dialog view is fed by `/check` polling + optimistic local updates (`public/index.html:13622-13661`), never this route.

Fix: wire a change-password UI into Settings (real gap), delete or document the rest as internal API.

### [MEDIUM] README: "Fable … *(temporarily hidden in the model picker)*" — it is not hidden
README.md:322. Reality: Fable buttons are live in both pickers — `public/index.html:2836` (desktop toolbar) and `public/index.html:2697` (mobile chips); no CSS rule or JS hides `[data-v="fable"]`. Fix: either hide it as documented or drop the parenthetical from README.

### [MEDIUM] `.env.example` timeout doc contradicts the code and changes behavior for every npx install
`.env.example:15-17` — "Claude subprocess **global timeout** … (default **30 minutes**) `CLAUDE_TIMEOUT_MS=1800000`". Reality (`claude-cli.js:69-70`): it's an **idle** timeout, default **600000 (10 min)**, with `CLAUDE_TIMEOUT_MS` only a legacy alias. Since `bin/cli.js` seeds `.env` from `.env.example` on first run, every npx/global install silently overrides the README-documented 10-minute default (`README.md:440`) to 30 minutes. Fix: update `.env.example` to describe `CLAUDE_IDLE_TIMEOUT_MS` and either comment it out or set 600000.

### [MEDIUM] CLAUDE.md model section is stale and self-contradictory
- `CLAUDE.md:79-83` — "Models (defined in `server.js`): haiku → `claude-haiku-4-5-20251001`, sonnet → `claude-sonnet-4-5-20250929`, opus → `claude-opus-4-6`". Reality: the map lives in `claude-cli.js:81-89` and maps everything to bare short aliases (`'opus': 'opus'`, etc.); the dated IDs are commented out.
- `CLAUDE.md:147-153` ("Model IDs (exact strings)") then says the opposite: "Do not use dated suffixes in CLI flags." Two sections of the same file give conflicting instructions. Since CLAUDE.md steers future code edits, this invites regressions. Fix: delete the dated-ID table, keep only the alias guidance.

### [MEDIUM] `npm test` does not exist; tests are orphaned; CLAUDE.md "no tests" is stale
- `package.json:8-19` — scripts block has **no `test`** entry; `npm test` errors. No CI workflow runs tests either (`.github/workflows/` contains only `release.yml` and `release-desktop.yml`).
- Yet `test/` contains 12 test files: `test/overload-detector.test.js` (valid standalone script testing `rate-limit-utils.js` overload detection — module exists and exports the tested functions) and `test/render/*.mjs` (10 plain-assert render regression scripts).
- `CLAUDE.md:23` "No linting, no tests, no build step configured" and `CLAUDE.md:164` "No automated tests exist" are now false. Fix: add a `test` script and correct CLAUDE.md.

### [MEDIUM] Architecture docs omit most of the actual codebase
`README.md:420-432` and `CLAUDE.md:29-40` list 7–9 files. Missing from both: `claude-interactive.js` (the Subscription/tmux engine — a *headline* README feature), `claude-ssh.js`, `tunnel-manager.js`, `db-adapter.js` (node:sqlite fallback — also a README feature), `rate-limit-utils.js`, `mcp-ask-user.js`, `mcp-set-ui-state.js`, `mcp-user-interrupt.js`, `telegram-bot-i18n.js`, and the entire `electron/` shell. CLAUDE.md does describe the subscription engine in prose (`:106-112`) but the architecture map pretends it doesn't exist. Fix: regenerate both file maps.

### [LOW] README: "8 built-in" slash commands — actually 10
`README.md:305` and `:406`. `server.js:1846-1857` `DEFAULT_SLASH_COMMANDS` has 10 entries (sc1–sc10); `/compact` and `/init` were added later and the docs never updated.

### [LOW] `tasks/telegram-ui-spec.md` status header is stale
`tasks/telegram-ui-spec.md:2` — "Status: Ready for Implementation". The redesign it specifies shipped 2026-06-17 (`.planning/MILESTONES.md:3-18`), and the shipped version deviates from the spec (spec mandates "Three buttons only: Home, Status, Notify toggle", `:44`; shipped keyboard is "dynamic context-aware with project/chat labels"). Fix: mark the spec "Implemented (with deviations)" or archive it.

### [LOW] `tasks/todo.md` — mostly accurate, one stale detail
The doc claims `mcp_set_ui_state` was added to planning-mode tools — verified true (`server.js:2466-2468`). But "How to Test" says `http://localhost:3333` (`tasks/todo.md:32`) vs the default port 3000. Also: this completed-task file plus `tasks/telegram-ui-spec.md` are the only contents of `tasks/` — a graveyard directory.

### [LOW] Repeated stale "EN/UA/RU" localization claims in README feature paragraphs
README.md:153, :255, :288, :401 all say features are "localized in EN/UA/RU", contradicting the v5.70.0 banner (`:13`) that correctly states five languages. Verified the code has 5 locales (`public/index.html:3821-4658` `TRANSLATIONS = { uk, en, ru, fr, he }`; `telegram-bot-i18n.js`).

### [LOW] README "1M token context" claim has no mechanism in this repo
`README.md:320-324` presents 1M-token context as a Studio capability, but no code here sets any context-size beta header (grep for `context-1m`/beta flags across `server.js`, `claude-cli.js`, `claude-interactive.js`: zero hits). Models are passed as bare aliases (`claude-cli.js:161`), so the 1M window depends entirely on the installed `claude` CLI version and the user's account. **Suspected overclaim, unverified externally** — mark in README as CLI/account-dependent.

### [LOW] README version banner lags; minor numeric drift
- `README.md:13` says "**v5.70.0**" while `package.json:3` is 5.70.1 (patch lag, trivial).
- `README.md:185` "Nine steps from 11px to 22px" — `public/index.html:13981` `SIZES` has **10** entries.
- `README.md:277` lists "Aider" among delegation targets; only Codex/Antigravity/opencode are seeded (`server.js:1840-1844`) — Aider is possible only as a manual custom agent.

### [LOW] `bin/cli.js` prints a stale product name
`bin/cli.js:51` — `console.log('🚀 Claude Code Chat v…')`. The product is "Claude Code Studio"; first-run UX shows the old name.

### [LOW] Install scripts: EOL Node + Ukrainian-only next-steps
- `install/setup-linux.sh:82`, `setup-macos.sh:69`, `setup-windows.ps1:84` all install "Node.js 20 LTS" — Node 20 went EOL April 2026. Node 22 is the active LTS and is what the main project recommends for `node:sqlite` (`README.md:74`).
- `install/setup-linux.sh:123` — post-install verification only checks `node -v` runs, not that the version is ≥18; if the NodeSource pipe fails silently (piped with `2>/dev/null`, `:85`), an ancient distro `nodejs` can be installed and the script still reports "ready".
- `install/README.md:62-65` and both shell scripts' summaries give next-steps in Ukrainian only, while the UI defaults to English (`public/index.html:4767`).

### [LOW] `docs/electron-desktop/DESIGN.md` — point-in-time doc, but two claims now wrong
- `:55,85` cites Electron 37 / Node 22.18 — `package.json:51` now uses `electron ^42.4.1`.
- `:89` lists `homebrew-tap/Casks/claude-code-studio.rb` as a project file — it doesn't exist; `homebrew-tap/README.md:21-22` explicitly says the cask lives only in the tap repo. Acceptable for a dated design doc; flagged because `.planning/` still points to it as "source of truth for scope" (`.planning/REQUIREMENTS.md:4`).

### [LOW] `docs/superpowers/specs/2026-06-19-activity-panel.md` stale status
Header says "IMPLEMENTED (**uncommitted**)" — the feature is committed and live (`server.js:4018` `/api/activity`, sidebar section in `public/index.html`). Trivial.

## Verified-accurate claims (spot-checked, no drift)
- Rate-limit auto-wait: 3 retries / 30-min cap — `server.js:2435-2436` matches README exactly.
- Scheduler: 5 workers default (`server.js:951`), 60s watchdog (`server.js:1602`) — match.
- All 14 Telegram slash commands exist (`telegram-bot.js:922-945`); 5-locale bot i18n confirmed.
- 28 skills in catalog (config.json = 28 keys; README's "28 built-in" correct; the 2 extra `.md` files `interview.md`/`plan-execute.md` simply uncatalogued — minor).
- Keyboard shortcuts G/T/I/N/?/=/-/0, Ctrl+F search, draft autosave, BroadcastChannel cross-tab sync, Kanban drag-drop, effort dial values, 8→10-command seeding, homebrew-tap bump-cask job + token-skip logic (`.github/workflows/release-desktop.yml:61-71`), Docker non-root + MIRROR, bcrypt 12 rounds / 30-day tokens / AES-256-GCM / Helmet / 2MB caps — all as documented.
- `docker compose logs -f claude-chat` (CLAUDE.md:20) — correct service name.
- WS protocol contract in CLAUDE.md matches the actual `chat`/`text`/`tool_use`/`done`/`error` handlers.

**Domain verdict:** The user-facing README is largely honest about *behavior* — nearly every feature claim traced exists and works as described; the exceptions are the false "Fable hidden" claim, the "8 slash commands" undercount, and the mechanism-less 1M-context boast. The real rot is in the *secondary* documentation layer: `.planning/` presents a shipped, released desktop app as unplanned 0% work (a genuine hazard for anyone resuming from STATE.md), CLAUDE.md's model/architecture sections are one or two major versions behind the code and internally contradictory, and `.env.example` silently overrides the documented timeout default for every npx install. On the code side: a broken debug page served in production, six dead endpoints (one of which — change-password — represents a real missing UI rather than harmless cruft), and 12 test files that no script or CI will ever run.


---

# Appendix F — Claude-Code Integration & MCP Tools Audit (full report)

### [CRITICAL] SSH password is injected into the LLM context (and thus sent to Anthropic / stored in transcripts)
`mcp-user-interrupt.js:142-146`:
```js
if (att.sshKeyPath) sshText += `\nSSH Key: ${att.sshKeyPath}`;
else if (att.password) sshText += `\nPassword: ${att.password}`;
```
`server.js:6801` builds these attachments with the *decrypted* password (`password: decryptPassword(rh.password) || ''`). When a user sends an SSH host as a mid-task clarification, the plaintext password is embedded in the `check_user_messages` tool result. That text goes (a) to the Anthropic API as model context, (b) into the on-disk session transcript (`~/.claude/projects/*/<cid>.jsonl`, which `claude-interactive.js:111-121` itself reads), and (c) potentially into model output echoed back to the chat. The whole point of the AES-256-GCM at-rest encryption (`server.js:2407-2413`) is defeated by deliberately piping the cleartext into the least-controlled sink in the system.
**Fix:** never include `password`/`sshKeyPath` in the tool-result text; reference the host by name and let the server-side `ClaudeSSH` resolve credentials.

### [HIGH] SSH host key verification disabled — full MITM exposure
`claude-ssh.js:73` — `cfg.hostVerifier = () => true;` (comment even claims this is the "StrictHostKeyChecking equivalent", which is false: it accepts *every* key on *every* connection, not just new hosts). Same in `testSshConnection` at `claude-ssh.js:389`. A network attacker can intercept the SSH session, harvest the password/private-key auth, read every prompt and attachment, and inject arbitrary "model output" (which the UI renders and the user may act on). There is no known_hosts storage or fingerprint pinning anywhere. (Note: `data/hosts.key` is the *password-encryption* key, not host keys — the naming invites exactly this confusion.)
**Fix:** record host fingerprints on first connect (TOFU) into `data/remote-hosts.json`, verify on subsequent connects, surface mismatch errors in the UI.

### [HIGH] MCP config temp file with bearer secrets written world-readable in shared /tmp
`claude-cli.js:105-106` — `fs.writeFileSync(filePath, json)` with no mode → `0666 & ~umask` (typically `0644`) in `os.tmpdir()`. The JSON contains the internal MCP env including `ASK_USER_SECRET`, `NOTIFY_SECRET`, `SET_UI_STATE_SECRET`, `INTERRUPT_SECRET` (injected at `server.js:5824-5859`) and any user-configured MCP server API keys. The sister module does it correctly: `claude-interactive.js:137` writes `{ mode: 0o600 }` with the comment *"the config embeds internal MCP secrets (ASK_USER_SECRET etc.)"* — so the authors knew, and the non-interactive path regressed. With those secrets, any local user can POST to `/api/internal/task-manager` (`server.js:3316`) and create tasks — i.e. arbitrary prompt execution as the server user.
**Fix:** write with `{ mode: 0o600 }`, and consider `fs.mkdtemp` for a private directory.

### [HIGH] Entire server environment leaked into the permissionless `claude` child
`claude-cli.js:267` — `const env = { ...process.env, ...(extraEnv || {}) };` Only `CLAUDECODE` and (conditionally) `ANTHROPIC_API_KEY` are stripped. Everything else — `SESSION_SECRET`, Telegram bot tokens, proxy master keys (`ANTHROPIC_AUTH_TOKEN`), any DB/API credentials in `.env` — is inherited by a child that runs with `--dangerously-skip-permissions` (`claude-cli.js:217`) and can execute `env` via its Bash tool. A prompt-injected agent can exfiltrate all server secrets in one tool call. The SSH path does not do this (remote env is constructed fresh, `claude-ssh.js:222-230`), proving a minimal env is workable.
**Fix:** build the child env from an explicit allowlist (`PATH`, `HOME`, `LANG`, `ANTHROPIC_*` as needed) plus `extraEnv`, instead of copying `process.env`.

### [MEDIUM] User prompt passed on the command line — visible to all local users via `ps`
`claude-cli.js:264` — `args.push('-p', finalPrompt);` The full prompt (which may contain secrets, code, personal data, and — per the finding above — SSH passwords in attachments text) sits in the process argv for the lifetime of the run. Same for `claude-ssh.js:229` (visible on the remote host).
**Fix:** pipe the prompt via stdin instead of `-p` argv (stdin is already opened and immediately `end()`ed at `claude-cli.js:289`, so the plumbing exists).

### [MEDIUM] Orphaned processes on server crash; Unix kill doesn't reach the process tree
- `gracefulShutdown` (`server.js:7872-7914`) only handles SIGTERM/SIGINT; on SIGKILL/crash every running `claude -p` child is reparented and keeps running to completion (stdin was already closed, so nothing stops it), with its MCP children hanging on HTTP calls to a dead server until their timeouts.
- `killProc` (`claude-cli.js:11-17`) force-kills the tree only on Windows; on Unix it SIGTERMs the direct child and relies on MCP servers exiting on stdin EOF (`mcp-ask-user.js:238-248`) — works for the bundled MCPs, but any user-configured MCP server that doesn't exit on EOF is orphaned.
- Interactive engine: tmux sessions are *deliberately* persistent (`claude-interactive.js:144` "survives studio server restarts"), but a crash leaves a `claude --dangerously-skip-permissions` TUI running indefinitely in the user's workdir (`claude-interactive.js:220`), attachable by anyone with the user's tmux socket.

**Fix:** on Unix, spawn with `detached: true` and kill the process group (`process.kill(-pid)`); document/cap the tmux survivor behavior.

### [MEDIUM] SSH abort doesn't kill the remote process
`claude-ssh.js:242-248` — on abort it calls `stream.close()` and `conn.end()`; nothing sends a signal to the remote `claude` process, and with `pty: false` there is no SIGHUP. The remote process keeps running until it writes to a dead stdout (SIGPIPE) or finishes — burning API quota and holding the `trap ... EXIT` cleanup (`claude-ssh.js:228`) hostage. Same on idle timeout (`claude-ssh.js:315`). *Severity caveat: partially inferred — ssh2 channel close behavior means the remote death is timing-dependent, not guaranteed.*
**Fix:** wrap the remote command to record its PID and issue a `kill` on a cleanup exec channel, or request a pty so channel close delivers SIGHUP.

### [MEDIUM] Predictable temp paths in shared /tmp (attachments + empty-config hash)
- `claude-cli.js:238` — `claude-att-${Date.now()}`: predictable dir, files written with default (0644) perms — local users can read user attachments while they exist; two sends in the same millisecond collide. `claude-interactive.js:268` (`ccs-att-<rand>.<ext>`) uses random names but still default perms and never deletes the files (unlike `claude-cli.js:429-431` which cleans up).
- The MCP config filename is `mcp-<sha256(content).slice(16)>.json`; for the empty-config callers (`server.js:2323`, `server.js:4863` pass `mcpServers: {}`) the hash is a fixed, publicly computable value → a local attacker can pre-create `/tmp/mcp-<fixed>.json` as a symlink and get the server to clobber any file it can write with `{"mcpServers":{}}`.

**Fix:** `fs.mkdtempSync` for attachments with `0700`; write config files with `O_EXCL`/`0600` and retry on collision.

### [MEDIUM] SSH connection-error path can fire callbacks twice
`claude-ssh.js:294-304` — `conn.on('error')` calls `h.onError` + `h.onDone` but never sets `finished = true` nor ends the connection; if a stream `close`/`error` follows, `finish()` (`claude-ssh.js:145`) fires `h.onDone` and the stderr error block a second time. The promise-level `_done` guard in `runSshSingle` (`server.js:2810`) prevents double-resolve, but duplicate `error`/`done` WS events can reach the client.
**Fix:** route the connection-error path through `finish()`.

### [LOW] SSH engine silently lacks all internal MCP tools and interrupt hooks
`ClaudeSSH.send` (`claude-ssh.js:108`) accepts no `mcpServers`, `extraEnv`, or `extraSettings`, yet `runSshSingle` still whitelists `mcp___ccs_*` tools in `allowedTools` (`server.js:2788-2791`). Over SSH, `ask_user`, `notify_user`, `set_ui_state`, `check_user_messages` and the mid-task interrupt hook are all silently unavailable — a feature-parity gap the UI doesn't disclose.

### [LOW] Model map drift between engines
`claude-ssh.js:16` — `MODEL_MAP = { opus, sonnet, haiku }` is missing `'fable'` present in `claude-cli.js:88`, and `claude-interactive.js:197` accepts any `/^[a-zA-Z0-9._-]+$/` alias. Selecting the `fable` model on a remote host passes a raw unknown alias to the CLI.

### [LOW] Internal API uses non-constant-time secret comparison; one global secret for all sessions
`server.js:3180, 3243, 3280, 3318, 3645` — `authHeader !== \`Bearer ${SECRET}\`` is a plain string compare (timing oracle, low practical risk on localhost). More relevant: the four secrets are per-*process*, not per-session — any single leaked MCP config file (see HIGH #3) compromises every session's internal channel.

### [LOW] `bin/cli.js` — stale product name; silent writes to cwd before any disclosure
`bin/cli.js:41` prints `🚀 Claude Code Chat` (package is `claude-code-studio` v5.70.1 — rebrand missed the binary). It creates `data/`, `skills/`, `config.json`, `.env` in the user's *current working directory* (`bin/cli.js:16-33`) before printing anything; the writes are only disclosed by the banner after the fact. No destructive behavior (all guarded by `existsSync`), but surprising. Also note the server then binds `0.0.0.0` by default (`server.js:7852` — only `CCS_DESKTOP=1` pins `127.0.0.1`), which an npx user may not expect, though auth is enforced (`auth.js:173-187`).

### [LOW] postinstall hook behavior and packaging
`scripts/install-hooks.js` modifies only the *project-local* `.claude/settings.json` (not `~/.claude` — good), and the target scripts exist locally (`.claude/scripts/file-lock.js`, `file-unlock.js`) but are gitignored — see Appendix D finding 9. Two nits: (a) package.json has no `files` whitelist, so the npm tarball ships `.claude/`, `hooks/`, `skills/` etc., and `postinstall` writes a `.claude/settings.json` inside `node_modules/claude-code-studio/` — harmless litter, but undisclosed; (b) the hook command `node .claude/scripts/file-lock.js` is cwd-relative, so it only works when Claude Code is launched from the package root.

### [LOW] Documentation/behavior mismatch on idle timeout
`.env.example:16-18` claims the `CLAUDE_TIMEOUT_MS` default is 30 minutes; all three engines default to 10 minutes (`claude-cli.js:70`, `claude-interactive.js:35`, `claude-ssh.js:12`). Users following the doc will mis-set expectations for long silent runs.

## Verified clean
- Argument construction is injection-safe: array-form `spawn` with `shell:false` on Unix (`claude-cli.js:281-286`), UUID regex on `sessionId` (`claude-cli.js:155`), correct POSIX single-quote escaping on both the tmux path (`claude-interactive.js:56-58,217-222`) and the SSH path (`claude-ssh.js:19-24,229-230`).
- Passwords at rest are properly encrypted (AES-256-GCM, random per-install key at `0600`, `server.js:2393-2424`).
- `hooks/check-interrupt.js` is **not** installed into the user's `~/.claude`; it's injected per-invocation via `--settings` (`server.js:2500-2506`) and no-ops with `approve` outside the CCS env (`hooks/check-interrupt.js:17`). No tampering with the user's own Claude Code setup.
- Session resume logic (reset-on-invalid-session with replay, `server.js:2682-2703`) and stdio line parsing (StringDecoder + idle watchdogs + abort-listener cleanup) are sound; MCP stdio servers validate initialization order, tool names, and enum inputs.
- Concurrent sessions are isolated per `sessionId` (separate child processes, envs, chat buffers); internal endpoints sit before `authMiddleware` but require random 128-bit bearers, and the web UI itself is auth-gated when exposed on `0.0.0.0`.

**Domain verdict:** The integration layer is mechanically competent — escaping, stream parsing, resume handling, and the MCP JSON-RPC servers are careful work — but it has a serious secrets-hygiene problem at every boundary: the user's SSH password is deliberately fed into model context (CRITICAL), internal bearer secrets and user MCP keys sit in a world-readable `/tmp` file on the headless path, the full server environment is handed to a permissionless agent, and prompts ride in `ps`-visible argv. The SSH transport is unauthenticated (`hostVerifier: () => true`), which turns all of the above into a network-exploitable MITM rather than just a local one. The at-rest encryption of host passwords is good but currently cosmetic, since the cleartext is deliberately piped into transcripts. Priorities: fix the password-in-context leak, the tmp-file mode, and host key verification; then adopt a child-env allowlist and stdin-delivered prompts.

---

*End of audit. Generated by a six-agent consilium (security, backend, frontend, architecture, docs-drift, integration) on 2026-07-18 against claude-code-studio v5.70.1. Findings marked "suspected, unverified" should be confirmed before being treated as defects; everything else was verified by direct code reading or empirical reproduction (npm audit, asar list, npm pack --dry-run, runtime TypeError reproduction, stat permission checks, git archaeology).*
