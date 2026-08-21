# Fix queue — consolidated from QA / Security / Product research (2026-08-20)

Sources: @taras-qa (test-suite recon), @sofiya-security (threat model + code audit),
@vira-product (spec / acceptance criteria). Duplicates merged, every item carries the
evidence it came from. `.planning/ISSUES-3680ad6.md` items are referenced as I-1…I-9,
not copied.

Priority key:
- **P0** — blocks any release. Do not ship with these open.
- **P1** — next batch, ships after P0.
- **P2** — backlog, do when touching the area.
- **P3** — explicitly not doing now (recorded so it is not re-discovered).

---

## P0 — blocks release

### FIX-01 — Server binds 0.0.0.0; first-run setup is unauthenticated
**Severity:** HIGH (security) · **Source:** sofiya F1 → vira AC-1, AC-2
**Where:** `server.js:9383`, `auth.js` `PUBLIC_PATHS`, `server.js:4692`

```js
server.listen(...(process.env.CCS_DESKTOP === '1' ? [PORT, '127.0.0.1'] : [PORT]), ...)
```

Outside Electron no host is passed → Node listens on every interface. `grep process.env.HOST`
returns nothing — the variable does not exist in the codebase. While `data/auth.json` is absent,
`authMiddleware` lets `/api/auth/setup` through, so one unauthenticated `POST` from anyone on the
same LAN sets *their* bcrypt hash. The rate limit (10/15min) does not help — one request suffices.
The prize is a UI that runs `claude --dangerously-skip-permissions` with `Bash` in `$HOME`
(`ALLOWED_BROWSE_ROOTS` includes `os.homedir()`, `server.js:120-125`; `botTools` always contains
`Bash`, `server.js:3372`) → RCE as the user, plus `~/.ssh`, `~/.aws`, `data/remote-hosts.json`.

**Acceptance (vira AC-1/AC-2):**
1. On a fresh install, a password-creation request from a non-local device is rejected, and the
   server console prints how the owner completes setup.
2. LAN access is possible only via an explicit opt-in at startup, and the console then warns that
   the password is the only remaining boundary.

**Decision still open — escalated to @artem-architect:** loopback bind + explicit `HOST` opt-in,
*or* a one-time setup token printed to the console. Pick one, not both. Must not break
`CCS_DESKTOP=1`, where a local auto-session is intentional.

**Cost:** 1–20 lines depending on the option. **Breaking:** yes, for users who currently browse to
`http://192.168.x.x:3000` from a phone. Needs a migration note in the release. The share of such
users is unknown — no telemetry in the project, do not invent a number.

---

### FIX-02 — Secret-bearing files are 0644, and the 0600 fix is not retroactive
**Severity:** MEDIUM (security) · **Source:** sofiya F2 → vira AC-3
**Where:** `server.js:2386` (`atomicWriteJSON`, no `mode`) vs `auth.js:25` (has `mode: 0o600`)

Verified on this machine, today:

```
-rw-r--r--  data/auth.json          bcrypt hash + sessionSecret   (dated Feb 20 — still 0644)
-rw-r--r--  data/chats.db  18 MB    full chat history
-rw-r--r--  data/remote-hosts.json  SSH hosts + usernames
-rw-r--r--  data/projects.json
-rw-r--r--  config.json             ngrokAuthtoken, Telegram bot token, MCP API keys
-rw-------  data/hosts.key          correct
-rw-------  data/sessions-auth.json correct
```

Two distinct defects:
1. `atomicWriteJSON` sets no mode at all → under umask 022 `config.json` lands 0644.
   `/api/tunnel/start` (`server.js:7243`) writes `ngrokAuthtoken` there in cleartext.
2. The `auth.js` 0600 fix (its comment cites an earlier "audit MEDIUM") only covers *new* writes.
   `auth.json` is rewritten only on password change, so existing installs stay 0644 forever.

Attack is local-privilege, not remote: any other process/user (or anything in group `staff` on
macOS, or a shared Docker volume) reads `config.json` → gets the Telegram bot token → that bot is
a full remote control over Claude sessions via `_handleTextMessage`.

**Acceptance (vira AC-3):** on startup, permissions on `auth.json`, `config.json`, `chats.db`,
`remote-hosts.json`, `projects.json` are brought to owner-only, idempotently, without asking.

**Fix:** add `{ mode: 0o600 }` to `atomicWriteJSON`; one-shot `chmodSync(0o600)` at boot.
**Cost:** ~10 lines, zero perf impact.

---

### FIX-03 — I-1: background-tab spinner never clears (`done` is unicast, never broadcast)
**Severity:** critical, marked blocks-release · **Source:** `.planning/ISSUES-3680ad6.md` #1
Carried over from the previous verification pass, filed as GitHub #28. Repro, suggested fix and
acceptance criteria are already written there — do not re-derive them.
**Action before anything else:** confirm the issue is still open (`gh issue view 28`) — the report
that produced it predates the current working tree.

---

### FIX-04 — I-2: `running-sessions` test silently PASSES against a foreign server on a busy port
**Severity:** critical, marked blocks-release · **Source:** `.planning/ISSUES-3680ad6.md` #2
A green suite is not evidence until this is fixed. Same note as FIX-03: verify GitHub #29 is still
open before treating the branch as ready.

---

## P1 — next batch

### FIX-05 — tmux integration tests are flaky (timing races, not broken code)
**Source:** taras · **Where:** `test/terminal-session.test.js`, `test/terminal-bridge.integration.test.js`

Evidence — three runs, unchanged code, three different failure sets:

| Run | Result |
|---|---|
| `npm test` #1 | 6 failed: resize `100x30`→`80x24`, session-alive, dead-pane ×2, respawn→attach, revived-pane |
| `npm test` #2 (after `tmux kill-server`) | 6 failed, **different set**: attach client count, input delivery, UTF-8 input, resize, client drop, dead pane |
| `terminal-bridge.integration.test.js` alone ×2 | run 1: 1 failed (instant-death agent); run 2: 6 failed |
| `terminal-session.test.js` alone ×3 | 50/50 PASS every time |

Races against real tmux pane state (respawn/attach, pane liveness reads). This is a harness design
defect — the classic "green CI that lies". Replace sleeps with state-polling waits; do not just
raise timeouts.

**Not a blocker for the `message_bot` spec** (vira): none of AC-1…AC-8 exercise tmux. It *is* a
blocker for trusting CI generally, hence P1 not P2.

---

### FIX-06 — Tunnel can be enabled while `TRUST_PROXY=false`
**Severity:** MEDIUM (security) · **Source:** sofiya F3
**Where:** `server.js:107`, `server.js:118`, `server.js:7226`

The tunnel is a UI button; `TRUST_PROXY` is an env var read once at load and requiring a restart.
Nothing links them, so "tunnel on, TRUST_PROXY false" is the default outcome.

Provable consequence: `authLimiter` (`server.js:110`) has no `keyGenerator`, so it keys on `req.ip`.
Without `trust proxy`, cloudflared arrives as 127.0.0.1 and **every** tunnel visitor shares one
10-attempts/15-min bucket. Anyone who knows the URL spends 10 requests and locks the owner out of
their own login for 15 minutes. Cheap DoS.

The missing `Secure` cookie flag is deliberately *not* counted as a separate finding — the tunnel is
HTTPS anyway, and leaking the token needs the same browser to also hit `http://<lan-ip>:3000` with
someone on the wire. Chain too long.

**Fix:** set `app.set('trust proxy', 1)` and recompute secure-cookie policy when
`tunnelManager.start()` runs, instead of reading env once at boot. Requires turning `SECURE_COOKIES`
from a const into a function — touches 3 `res.cookie` call sites (`server.js:4696,4704,4714`).
Minimum viable alternative: warn in the UI.

---

### FIX-07 — `message_bot` dispatch has no written acceptance criteria
**Source:** vira AC-4…AC-8 · **Where:** uncommitted `mcp-bots.js`, `bots.js:196` `planDispatch()`,
`server.js:4408`

The feature is in the tree, unmerged, and users pay per dispatched run. Criteria to encode as tests
in `test/bots.test.js` (currently 85/85 PASS, so the harness is trustworthy here):

- **AC-4** ≥2 bots, one user message → at most 3 dispatched tasks total; each `@handle` at most once.
  (`BOT_DISPATCH_BUDGET = 3`, `server.js:1056`.)
- **AC-5** A dispatching bot's own answer is complete and self-contained; the handoff is one line,
  never the spine of the reply.
- **AC-6** A rejected dispatch (budget exhausted, handle already queued, malformed request) is
  visible to the user with its reason. Silent swallowing fails.
- **AC-7** The callee sees only the task text, not the rest of the conversation; tasks over 4000
  chars are truncated visibly.
- **AC-8** Each bot occupies exactly one slot in the bot strip; no launch overwrites another's state.

**Out of scope, recorded:** recursive dispatch beyond the shared budget of 3; synchronous
"ask a colleague and wait"; multi-user roles/audit.

**Security review of this feature returned no findings** (sofiya): the pre-auth
`/api/internal/message-bot` endpoint is guarded by a 128-bit per-process secret
(`crypto.randomBytes(16)`, `server.js:1051`); budget is debited and never refunded; `planDispatch`
fails closed on non-integer budget; the queue is flat with `queued.has(handle)` dedup, so recursion
is impossible. Cross-bot prompt injection exists but does not cross a trust boundary — both bots
already have `Bash` as the same user.

---

### FIX-08 — Docs describe a 2-file test suite; there are 16
**Source:** taras · **Where:** root `CLAUDE.md`, "How to Verify Changes"

`package.json:8` chains 16 files (render, overload-detector, env-load-order, multi-agent-result,
terminal-session, terminal-schema, bots, bots-api, running-sessions, terminal-bridge, telegram-format,
telegram-behaviour, ask-user-question, delegate-terminal, update-flow, i18n-completeness).
`CLAUDE.md` still says "a render + overload-detector test suite". Wrong docs are worse than none.

---

### FIX-09 — `PROJECT.md` documents a finished milestone; current work has no recorded goal
**Source:** vira · **Where:** `.planning/PROJECT.md` (last touched 2026-06-17),
`.planning/STATE.md:6-8` (v1.1 Electron Desktop — shipped, 100%), `.planning/ROADMAP.md` (ends at
phase 8)

Two months of work — character bots, kanban planner, bot-to-bot dispatch — sit outside any written
goal. This is the *root cause* of the other gaps: QA had no acceptance criteria to test against, and
security had to invent its own threat model.

**Escalation, not a task:** what gets built after Electron Desktop is the owner's call, not the
agents'. Needs a human decision before a next milestone can be written.

---

## P2 — backlog

| # | Item | Evidence | Note |
|---|---|---|---|
| FIX-10 | No security tests at all | `ls test/` — 16 files, none covering auth, tunnel, or `isPathAllowed` | The "terminal blocked while tunnel active" guard (`server.js:7911`) has zero coverage. Combined with FIX-05, a regression there would go unnoticed. |
| FIX-11 | `from` field trusted in `/api/internal/message-bot`; `BOTS_SECRET` shared across all bots in the process | `server.js:4410` | Bot A can sign as B. Effect is a wrong attribution line in the feed — cannot bypass the self-check (`already-queued` fires). Cosmetic. |
| FIX-12 | Non-constant-time secret comparison (`!==`) across all six `/api/internal/*` endpoints | `server.js:4410` | Not an attack path for a 128-bit per-process secret over JS string compare on the network. Becomes relevant only if the secret shrinks or becomes long-lived. |
| FIX-13 | `multer ^1.4.5-lts.1` — support status unverified | `npm audit` clean (0 vulns, 418 deps) | **UNVERIFIED** recollection that 1.x is EOL in favour of 2.x. Do not plan against this until @hanna-researcher confirms against npm/GitHub. |
| FIX-14 | I-3 … I-9 from `.planning/ISSUES-3680ad6.md` | GitHub #30–#36 | Separate queue with its own priorities. Not folded into the dispatch feature. |

---

## P3 — explicitly not doing

**CSP disabled** — `helmet({ contentSecurityPolicy: false })`, `server.js:3876`. Deliberate: the SPA
uses inline scripts and `onclick` handlers, a direct consequence of the no-build philosophy. Turning
CSP on means rewriting `public/index.html`. Not worth it while model output is escaped
(`escH(text)`, `public/index.html:5846`). Revisit if the UI starts rendering external content that
bypasses `renderMd`.

---

## Status pass — 2026-08-21

Every item re-checked against the tree at `29bbfb9`. Nothing below is a status I took on
trust: each FIXED line names the commit, and each still-open line names what is missing.

| Item | Status | Evidence |
|---|---|---|
| FIX-01 | **FIXED** | `8466c41` — binds `127.0.0.1` unless `HOST` says otherwise; first-run setup from a non-loopback `req.ip` needs a one-time code printed to the server console (`crypto.timingSafeEqual`). Docker sets `HOST=0.0.0.0` explicitly, so AC-1 is held by the setup gate there, not by the bind. |
| FIX-02 | **FIXED** | `30d2b8a` — secret-bearing files created 0600 and existing ones hardened at boot. |
| FIX-03 | **FIXED** | `ce78760` (broadcast `done` to every watcher) + `5faf387` (regression test). GitHub #28 closed. |
| FIX-04 | **FIXED** | `7507b73` (`TEST_PORT`, `net` preflight, child-exit bail, server-identity check) + `3c60580` (the root cause: `server.listen()` had no `'error'` handler). GitHub #29 closed. |
| FIX-05 | **PARTLY FIXED** | `1588b4b` + `5962d87` closed `terminal-session.test.js`. `terminal-bridge.integration.test.js` is green on an idle machine (40/40) but still loses its races under CPU load — two independent observations. Split out as GitHub **#39**. |
| FIX-06 | **FIXED** | `6637146` — `trust proxy` is recomputed when the tunnel opens and closes, instead of one env read at boot. `SECURE_COOKIES` deliberately left env-only: flipping it mid-session would invalidate the cookies of anyone already signed in over plain http. |
| FIX-07 | **PARTLY FIXED** | See the per-AC table below. |
| FIX-08 | **FIXED** | `741ed67`. **Correction to this document:** the heading says 16 files; the real number is **26** (10 `test/render/*.test.mjs` via `node --test` + 16 `test/*.test.js`), which is what `CLAUDE.md` now states. |
| FIX-09 | **OPEN — owner's call** | Unchanged. `.planning/PROJECT.md` still ends at the Electron milestone. This is an escalation, not a task an agent can close. |
| FIX-10 | **PARTLY FIXED** | `test/setup-gate.test.js` (28 assertions) now covers the bind, the setup gate and the trust-proxy default. Still zero coverage for `isPathAllowed` and for the "terminal blocked while tunnel active" guard — `grep -rl "isPathAllowed\|tunnel" test/` returns nothing. |
| FIX-11 | **OPEN** | Unchanged and still cosmetic: `server.js:4551` authenticates with `Bearer ${BOTS_SECRET}`, one secret for every bot in the process, so `from` is self-asserted. Cannot bypass the self-check — `planDispatch` rejects a self-dispatch across case (`test/bots.test.js`). |
| FIX-12 | **PARTLY ADDRESSED** | The new setup-code check uses `crypto.timingSafeEqual` with a length guard. The internal endpoints still use `!==` (`server.js:4551`) — unchanged, and unchanged in severity: a 128-bit per-process secret over a JS string compare on the network is not an attack path. |
| FIX-13 | **VERIFIED, then FIXED** | The recollection was right. `npm view multer@1.4.5-lts.2 deprecated` returns: *"Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x."* `npm audit` was clean on both versions, so the audit would never have surfaced it. Upgraded to `2.2.0` in `29bbfb9`, with the upload paths proven live (200 / 415 / 413). |
| FIX-14 | **FIXED** | All of I-3…I-9 (GitHub #30–#36) closed. Two findings were split out rather than folded in: **#38** (`noCatchUp` never cancels `TASK_DISCONNECT_TIMEOUT_MS`) and **#39** (above). |
| P3 CSP | **unchanged** | Still deliberately off. No new reason to revisit. |

### FIX-07 per acceptance criterion

The feature is merged (`ec0951b`), so this is no longer a pre-merge gate. `test/bots.test.js`
is 122 assertions, of which the `planDispatch` block is the relevant part.

| AC | Status | Evidence |
|---|---|---|
| AC-4 — budget of 3, each `@handle` at most once | **covered** | `BOT_DISPATCH_BUDGET = 3` (`server.js:1139`); asserted for budget exhaustion, already-queued dedup, self-dispatch across case, and that a rejected `from` does not consume budget. |
| AC-5 — the dispatcher's own answer stays self-contained, the handoff is one line | **partly covered** | `test/bots.test.js:143` asserts one bot is exactly one line inside the fence. The "own answer is complete" half is a prompt property, not a testable invariant — it is a review item, not an assertion. |
| AC-6 — a rejected dispatch is visible with its reason | **covered at the API boundary** | `server.js:4596` returns `DISPATCH_REASONS[rejected[0].reason]`; `planDispatch` tags every rejection (`self`, `invalid`, already-queued, budget). Whether the calling bot then relays it to the user is not asserted end-to-end. |
| AC-7 — callee sees only the task; >4000 chars truncated visibly | **implemented, not tested** | `mcp-bots.js:28,160-178` clips at `MAX_TASK_CHARS = 4000` and tells *both* sides it was cut. No test references `MAX_TASK_CHARS`. This is the one genuine gap. |
| AC-8 — each bot occupies exactly one strip slot | **covered indirectly** | The self-dispatch rejection exists precisely to keep `_turnStates[botId]` single-valued, and it is asserted. No UI-level assertion. |

**Remaining work for FIX-07:** one test for the 4000-char clip. Everything else is either
asserted or is a prompt-quality property that a unit test cannot hold.

### Corrections to this document

- The FIX-08 heading and the FIX-10 evidence both say the suite is 16 files. It is 26.
- FIX-13 was marked **UNVERIFIED** with an instruction not to plan against it. It has now
  been verified against the npm registry and acted on.
- The "Working-tree state" section below describes an uncommitted dispatch feature. That
  work is committed (`ec0951b`); the tree is clean apart from planning documents.

### Coverage gaps — still true

Everything in the "Coverage gaps" section still stands, with one change: the claim that
"nothing was exercised dynamically" no longer holds. The bind/setup gate, the graceful
shutdown path, the `EADDRINUSE` path and all three upload paths were exercised against a
running server this pass. The unread bulk of `server.js` and `telegram-bot.js` is unchanged.


---

## Coverage gaps — what nobody has actually checked

Recorded so the fix list is not mistaken for an all-clear.

- **`server.js` is 486 KB; roughly 2% was read.** Audited: auth, `/api/internal/*`, tunnel, WS
  upgrade, path guard, the new dispatch feature. Unaudited for object-level authorization: projects,
  kanban, schedule, dashboard, skills, MCP CRUD, multer uploads. Single-user auth makes IDOR
  structurally unlikely — but that was not proven.
- **`telegram-bot.js` is 185 KB; only the gatekeeper was checked** (6-hex pairing, 5-min TTL, 3
  attempts, 15-min lock per `userId` — brute force does not close). The entire post-auth command
  router is unreviewed, and it is a second full perimeter to the same `Bash` capability.
- **`claude-ssh.js`** — confirmed 0600 key and AES-256-GCM, did not read `encryptPassword`.
- **XSS** — `escH` confirmed on the `renderMd` input path; 158 `innerHTML` sites were not checked
  individually. Paths that bypass `renderMd` (file names, session titles, bot labels) need a pass.
- **Nothing was exercised dynamically.** All of the above is code reading plus `ls -l` and
  `npm audit`. No requests were made against a running server; the browser/WebSocket/auth flows were
  not manually verified.

---

## Working-tree state (as of writing)

```
 M bots.js
 M public/index.html
 M server.js
 M test/bots.test.js
?? mcp-bots.js
?? .planning/ISSUES-3680ad6.md
```

Correction to the earlier QA report: `public/kanban.html` is **not** modified. The uncommitted work
is the bot-to-bot dispatch feature (+377/−30) plus the new internal MCP server — never run on a
clean tree or in CI, and entangled with test files that are already unstable (FIX-05).
