# Adversarial Audit — Verified Remediation Plan

**Companion to:** `docs/adversarial-audit-2026-07-18.md`
**Date:** 2026-07-18
**Codebase state at the time of the audit:** v5.70.1 (identical to the version the auditor examined — nothing had landed in between).
**Staleness note:** this is a historical snapshot, not a live checklist. The codebase has moved on (v7.2.x); re-verify any item against current code before acting on it — some, such as the `test` script, are already done.
**Verification method:** every CRITICAL, every HIGH, and every material MEDIUM re-checked against live code by 6 independent read-only passes (security, integration/MCP, dependencies/packaging, backend correctness, frontend, docs). Empirical claims reproduced: `npm audit`, `npm pack --dry-run`, `asar list`, red-test run, on-disk `stat`, git archaeology, runtime `TypeError`.
**Plan validated by:** Consilium blind-spot panel — 3 independent non-Claude advisors (codex/OpenAI, agy/Gemini, grok/xAI), each reviewing the plan without seeing the others.

---

## 1. Verdict on the audit

**The audit is accurate and actionable.** All 4 CRITICAL and all 9 HIGH reproduce against the code. The auditor correctly self-flagged "suspected, unverified" items. Five formulation-level corrections (below) do not change any severity.

### Corrections to the auditor (for an honest reply to the client)
1. **`depends_on` (Backend MEDIUM):** not "task skipped forever every 15s". Reality: the `catch` logs and **falls through → the task RUNS with its dependency gate silently bypassed** — a different, arguably worse failure.
2. **O(n²) streaming (Frontend MEDIUM):** behaviour real, citation wrong. Lines `6574`/`5697` are finalize-once; the per-chunk full-buffer re-render is **`public/index.html:5573`** via `renderStreaming`.
3. **multer (H4):** EOL/deprecated, **not** an `npm audit`-scored CVE. It was listed alongside scored CVEs.
4. **CLAUDE.md "model self-contradiction" (docs):** more precisely **stale docs** — the two sections scope different files; `server.js` has no dated model map at all.
5. **`.env.example` timeout (docs):** auditor understated — both the "global" semantics and the "30-min" default are wrong (real: **idle, 10 min**).

Minor citation drift (non-substantive): express is `4.22.1` (not 4.21, still bundles vulnerable path-to-regexp 0.1.12); lockfile is stuck at **5.58.0** (worse drift than implied); the ws advisory title differs from the two cited GHSA IDs; "orphaned endpoints" were checked only against `public/*.html` (⇒ "no UI caller", `telegram-bot.js` not in scope).

### Severity depends on deployment surface (do not flat-rate it)
Most MEDIUM security holes sit **behind `authMiddleware` in web mode** (require a valid session). The force-multiplier is **C1**: desktop mode drops auth entirely and the WS upgrade does no Origin check, so any web page reaches every "authenticated" endpoint via `localhost`.

| Surface | What jumps in urgency |
|---|---|
| **Desktop (Electron)** | C1 + C3 co-equal top; unauth drive-by RCE |
| **Web + auth (LAN)** | C2, C4 (if SSH used), H2, H5 |
| **Tunnel / public-exposed** | **H2, H6/H9, H7, H1(if SSH), setup-token** rise to CRITICAL-class; the app is *RCE-as-the-user by design* — needs reverse-proxy SSO in front |

---

## 2. Remediation plan (revised after Consilium)

Changes forced by the panel are marked **[C]**. The single biggest one: **H2 and the release/packaging gate move into Wave 1** — leaving inherited-env secret exposure or a broken release script in place makes the CRITICAL fixes leaky.

### 🔴 Wave 0 — operational, before any code (owner action)
- [ ] **Rotate** the API tokens present in the shipped `config.json` (2× `Authorization`, `GITHUB_TOKEN`).
- [ ] **Determine whether the 5.59.0 desktop installers were ever published** (Homebrew tap, GitHub Releases, mirrors, forks). If yes → the secrets in that `asar` are burned: rotate, publish an advisory, and force a desktop update. **[C]**
- [ ] **Freeze all publishing** (npm + desktop) until C3 + H8 + the release gate are in place.
- [ ] **Write one operator note** into README: this product executes arbitrary code as the OS user; never expose it on the public internet without a reverse proxy enforcing SSO and rate limits. **[C]**

### 🔴 Wave 1 — CRITICAL + credential-exposure multipliers (this week)
Recommended order (credential-exposure first, then the RCE gate, then correctness):

1. **C3 packaging** — `!.env*`, `!config.json`, `!tasks/**`, `!test-snapshot*` in `electron-builder.yml`; **prefer a positive include-allowlist**. Smoke step must **scan artifact CONTENT for secret-shaped strings across the whole bundle** (app/dmg/zip), not just assert listed paths. **[C]**
2. **H8 packaging twin** — `files` allowlist in `package.json` (server.js, public/, skills/, bin/, scripts/install-hooks.js, hooks/, telegram/claude/mcp modules, config.example.json, .env.example, README, LICENSE). Fixes the 1.3 GB tarball; belongs in the same release train as C3. **[C]**
3. **Release gate** — switch `scripts/release.js` to `npm version` (syncs lockfile), run `npm ci` + the packaging smoke in CI **before** any tag. Moved out of Wave 4 so C3/H4 cannot regress on the next release. **[C]**
4. **H2 child-env allowlist** — build the `claude` child env from an explicit allowlist (`PATH`, `HOME`, `LANG`, needed `ANTHROPIC_*`) + `extraEnv`; explicit denylist of `*TOKEN*`/`*SECRET*`/`*PASSWORD*`/`CCS_*`/Telegram/webhook. Apply on **all** run engines via one wrapper (see driver note). Test that Claude/MCP still start (over-tight env silently breaks tools). **[C]**
5. **C1 desktop auth** — capability model, not a patch:
   - **Delete** the `if (CCS_DESKTOP) return next()` / `validateWsToken → true` bypass entirely; the server must *always* require auth. Desktop only changes *how the client proves identity*. **[C]**
   - **Ephemeral random port per launch** (drop the stable persisted port). **[C]**
   - **High-entropy per-launch token**, delivered via **preload/IPC or `Sec-WebSocket-Protocol` header — never in the WS URL query string**. Required on every HTTP request and WS upgrade. **[C]**
   - **Origin allowlist, Electron-aware:** reject `http(s)://` origins and **never allow `Origin: null`**; allow only the app's own protocol origin. **[C]**
   - **Strict Host allowlist** (`127.0.0.1`/`localhost`/`[::1]` + exact port; compare to the bound address, not a permissive regex).
   - *Ideal-if-affordable:* a Unix-domain-socket / named-pipe transport removes browser reachability by construction (weigh against the Windows named-pipe cost + zero-build philosophy). **[C]**
6. **C2 SSH password out of LLM context** — reference host by name only; resolve credentials server-side. **Also:** audit every path that stringifies SSH config / connection errors / stderr for re-injection; **redact or quarantine historical transcripts** that already contain plaintext; advise rotating any SSH creds used in affected sessions. **[C]**
7. **H3 MCP temp-file `0600`** — trivial, protects live bearer secrets in shared `/tmp` (`claude-cli.js:105`; sister module already does it right). Promoted into Wave 1 because it is cheap credential protection. **[C]**
8. **C4 SSH builder** — add `onUsage(fn)` + mirror usage capture. The contract smoke test must assert **all three engines expose the same lifecycle-hook surface** (onText/onTool/onDone/onError/onSessionId/onThinking/onRateLimit/onResult/onUsage), so triplication cannot silently drop a method again. **[C]**

### 🟠 Wave 2 — HIGH
- **H4 deps — controlled, not blind.** Pin `ws ≥ 8.20.1`, fix `path-to-regexp`/`qs` via express bump; do **multer@2 as its own PR with an upload smoke test** (API-breaking). Add WS `maxPayload`. Do **not** run a bulk `npm audit fix`. **[C]**
- **H5** — `ws.on('error', …)` + 30s ping/pong heartbeat; tie liveness to socket health and **pause idle eviction while a run is in flight** (don't kill long generations). **[C]**
- **H7** — terminal JSON error middleware after all routes; stop leaking HTML stack traces.
- **H1 SSH host-key TOFU** — pin fingerprint on first connect into `remote-hosts.json`; **ship a UI "reset/trust changed key" path** so users don't revert to `hostVerifier=()=>true`. **[C]**
- **H6 content** — serve SVG/HTML/XML as `attachment` + `nosniff` (stops the inline-execution chain now).
- **H9 CSP — phased, explicitly NOT "done" from a route-level header.** Start `object-src 'none'; base-uri 'none'; frame-ancestors 'none'`; refactor the ~300 inline handlers → `addEventListener` and the 147 `innerHTML` sinks before any strict `script-src`. A route-level CSP on `/api/files/raw` is containment, not global XSS remediation. **[C]**
- **Prompt via stdin** (from Wave 3) — promote here: after C2, secrets can still ride argv visible in `ps`. **[C]**

### 🟡 Wave 3 — MEDIUM
Security: `fs.realpathSync` symlink containment; `0600` on `auth.json`/`sessions-auth.json`/`chats.db` + `chmod 700 data/` *(note residual risk §4)*; `tabId` validation `/^[A-Za-z0-9-]+$/`; setup-token or loopback-only first-run; `ID_VALID` on `/api/mcp/add`; containment on `/api/claude-md`; drop `.env` from preview/search.
Backend: kill kanban workers on session delete; validate `depends_on` on write *(per correction #1)*; abort `classifyTask` subprocess on timeout; **session isolation for parallel agents built on the shared driver, not three times**; async fs instead of `readFileSync`; cmdline check before `killByPid`; enum/size validation on API bodies; exclude `attachments` from `getTasks`.
Integration: process-group kill on Unix; `0700`/cleanup temp files; route SSH error path through `finish()`; add `fable` to SSH `MODEL_MAP`; disclose the SSH MCP-parity gap in the UI.

### ⚙️ Wave 4 — systemic (prevents the next audit)
- **Shared agent-run driver — start early.** Consilium consensus: any second touch to `runCliSingle`/`runSshSingle`/taskWorker should already go through one wrapper applying env-allowlist, no-secrets-in-prompt, usage hooks, session isolation. This is the real fix behind C4/H2/H3. **[C]**
- Versioned migration runner (`PRAGMA user_version`) replacing `try{ALTER}catch{}`.
- ~~CI: add `test` script~~ (done — `npm test` runs the `test/` suite), fix the red `integration.test.mjs` (`<h1 dir="auto">`), run on push/PR.
- Dockerfile `npm ci --omit=dev` + `COPY package-lock.json`; extend `.dockerignore`.
- Frontend: shared `apiFetch` with `401→/login`; delete `test-ask-tool.html` + `public/.omc/`; key the chat draft per session; rAF-throttle streaming (line **5573**).
- Docs: `.planning/STATE.md` (desktop → shipped), CLAUDE.md model/arch sections, `.env.example` timeout, README claims; build the **change-password UI** (`/api/auth/change-password` is a real gap, not dead code).

---

## 3. Consilium — what changed and where I disagreed
- **Adopted (3/3 consensus):** promote H2 to Wave 1; C1 = capability token via IPC (never URL) + ephemeral port + Electron-aware Origin + delete the bypass; phased CSP; controlled dep upgrades (multer as its own PR); content-scanning C3 smoke; early release/CI gate; C2 transcript cleanup; C4 cross-engine contract test; H1 reset UX; shared driver earlier.
- **Disagreed on the merits:** agy called multer 2.x "alpha/RC, unstable" and recommended staying on 1.x or moving to busboy. That is outdated — multer 2.x is stable and is the officially recommended upgrade. I kept **multer@2 (as its own tested PR)**; busboy is a fallback only if the migration surfaces real breakage.
- **Logged as residual risk, not scheduled:** see §4.

## 4. Known residual risks (document honestly; out of immediate scope)
- **Same-user agent can read secret files regardless of `0600`.** The `claude` child runs as the same OS user as the server, so its shell/file tools can `cat` `auth.json`/`hosts.key`/`.env` even after Wave 3 permission fixes. True containment needs a tool-layer path allowlist or an OS sandbox / low-privilege user / container. (agy)
- **Authenticated user == full RCE by design.** No in-app fix changes this; it is the product's purpose. Mitigation is deployment posture (reverse-proxy SSO, network isolation), captured in the Wave 0 operator note. (grok, codex)

## 5. Execution note
Code changes (Waves 1–4) run through the maintainer's GSD workflow (`/gsd-execute-phase` for a wave, `/gsd-quick` for a one-off) where GSD is installed; GSD is not required to contribute. This document + the audit are the planning inputs. Wave 0 is the owner's operational action and blocks everything downstream.

## 6. Execution log
**Landed (committed locally, not pushed — publishing frozen):**
- C4 — `onUsage` added to SSH builder; SSH chat un-broken (`2d238f5`).
- H3 — MCP temp config `0600` (chmod after write; caught by Consilium) (`fcce494`).
- C3 (partial) — `.env`/`config.json`/`tasks`/`test-*` excluded from the desktop bundle (`73a06b7`). *Still open: package.json `files` allowlist (H8) + content-scanning packaging smoke.*
- MEDIUM — `auth.json`/`sessions-auth.json` written `0600` (`077e326`).
- LOW — `fable` added to SSH `MODEL_MAP` (`2440161`).
- H5 (partial) — `ws.on('error')` crash guard; H7 — terminal JSON error middleware; MEDIUM — `/api/mcp/add` id validation + client align (`a4dd11d`). *Still open: WS ping/pong heartbeat (H5).*
- Test — `npm test` wired, stale render assertion fixed; 8 render + 20 overload cases green (`230bd0b`).
- Docs — README×3 / CLAUDE.md drift (`1e90f30`); `.planning/*` marked desktop shipped (`5c8470e`).

**Owner actions still open:** Wave 0 secret rotation + publish-check; `.env.example` timeout wording (blocked by a `.env*` tool-permission guard — apply manually); delete untracked `public/test-ask-tool.html`.

**Approved to proceed (per owner decision):** Wave 1 crit-security (C1/C2/H1/H2) via GSD with tests; deps — safe drop-in only (ws + express-family, defer multer/files-allowlist/Docker); backend validation — carefully after verifying real formats; frontend — safe subset only (apiFetch 401, phased CSP `object-src`, `.svg` as attachment).
