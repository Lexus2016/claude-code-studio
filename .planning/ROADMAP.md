# Roadmap: Claude Code Studio

## Milestones

- ✅ **v1.0 Telegram UX Redesign** - Phases 1-4 (shipped 2026-06-17)
- 🚧 **v1.1 Electron Desktop** - Phases 5-8 (in progress)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.
Phase numbering is continuous across milestones — v1.1 starts at Phase 5.

<details>
<summary>✅ v1.0 Telegram UX Redesign (Phases 1-4) - SHIPPED 2026-06-17</summary>

### Phase 1: Foundation
**Goal**: The bot has a stable, explicit state machine and a separate i18n file — making it safe to build new UX on top
**Requirements**: ARCH-01, FSM-01, FSM-02, FSM-03, FSM-04, FSM-05
**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md — Extract BOT_I18N to telegram-bot-i18n.js (i18n separation)
- [x] 01-02-PLAN.md — Replace ad-hoc state flags with explicit FSM (ctx.state + ctx.stateData)

### Phase 2: UX Redesign
**Goal**: Users can reach Claude in 2 taps from any state, navigate without dead ends, and see their active context at all times
**Requirements**: NAV-01, NAV-02, NAV-03, NAV-04, NAV-05, NAV-06, KB-01, KB-02, KB-03, ARCH-02, ARCH-03, ARCH-04, STREAM-01
**Plans**: 5 plans

Plans:
- [x] 02-01-PLAN.md — SCREENS registry, callback router refactor, screenMsgId removal
- [x] 02-02-PLAN.md — sendMessageDraft streaming migration in TelegramProxy
- [x] 02-03-PLAN.md — Auto-generated Back buttons + context header on every screen
- [x] 02-04-PLAN.md — Dynamic persistent keyboard + setMyCommands with 4 commands
- [x] 02-05-PLAN.md — 2-tap flow validation, slash command pruning, verification checkpoint

### Phase 3: Forum Mode UX + Extraction
**Goal**: Forum Mode becomes a first-class UX within a clean TelegramBotForum module with isolated state
**Requirements**: FORUM-01, FORUM-02, FORUM-03, FORUM-04, FORUM-05, FORUM-06, FORUM-07, FORUM-08, FORUM-09, FORUM-10, FORUM-11
**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md — Extract 21 forum methods to TelegramBotForum class
- [x] 03-02-PLAN.md — Forum UX enhancements (inline keyboards, activity buttons, error recovery)
- [x] 03-03-PLAN.md — Guided onboarding flow + task inline buttons

### Phase 4: Server Encapsulation
**Goal**: server.js interacts with the bot only through a public API — no private method calls remain
**Requirements**: ENC-01, ENC-02
**Plans**: 1 plan

Plans:
- [x] 04-01-PLAN.md — Expose createResponseHandler factory, replace all bot._* calls

</details>

### 🚧 v1.1 Electron Desktop (In Progress)

**Milestone Goal:** Ship Claude Code Studio as a native desktop app (macOS, Linux, Windows) that runs the existing `server.js` unchanged — one codebase, two launchers — with in-app GUI updates. The web-server mode (`npm start` / Docker) stays byte-for-byte unchanged throughout.

**Authoritative design:** `docs/electron-desktop/DESIGN.md` (locked). GSD phases 5-8 map directly to DESIGN phases 0-3.

- [ ] **Phase 5: De-Risk Spikes** - Prove the two load-bearing assumptions (flag-free `node:sqlite` in packaged Electron 37; detached `brew upgrade --cask` + relaunch from a GUI app) before any build work
- [ ] **Phase 6: MVP Desktop Build** - Electron shell forks `server.js` and renders it natively; app launches and chat works on all 3 OSes; web mode unchanged
- [ ] **Phase 7: Desktop Hardening** - GUI PATH fix, `claude` detect + prompt, disable server-only features, ephemeral port, auto-session auth
- [ ] **Phase 8: Update & Distribution** - In-app GUI updates (banner + one-click + report + fallback + opt-in auto), Homebrew Cask / NSIS / AppImage+deb distribution, GitHub releases, CI cask bump, 3-OS CI

## Phase Details

### Phase 5: De-Risk Spikes
**Goal**: Prove the two assumptions the whole milestone rests on, so MVP work proceeds without rework risk. This is a pure de-risk gate — it owns no delivered requirement; instead it validates the foundations behind DESK-02/DESK-03 (`node:sqlite` under Electron) and UPD-02 (the macOS brew-upgrade flow).
**Depends on**: Phase 4
**Requirements**: none owned (de-risk gate — validates assumptions behind DESK-02, DESK-03, UPD-02)
**Success Criteria** (what must be TRUE):
  1. A packaged Electron 37 build runs `node:sqlite` (via the existing `db-adapter.js` path) with NO `--experimental-sqlite` flag — confirmed by a spike build that reads/writes a SQLite DB
  2. A detached `brew upgrade --cask` spawned from a GUI-launched (Dock/Finder) app successfully locates `brew` despite the GUI PATH, runs the upgrade, quits the running app, and relaunches it
  3. Findings (flag requirement, brew-path probe, quit/replace/relaunch timing) are documented in the design notes so Phase 6 and Phase 8 can build against confirmed behavior
**Plans**: TBD

### Phase 6: MVP Desktop Build
**Goal**: A native desktop app that boots the existing `server.js` via `utilityProcess.fork` and renders it in a window — launching and running a working Claude chat on macOS, Linux, and Windows — while the web build stays byte-for-byte unchanged.
**Depends on**: Phase 5
**Requirements**: DESK-01, DESK-02, DESK-03, DESK-04, BUILD-01, BUILD-02, BUILD-03
**Success Criteria** (what must be TRUE):
  1. The user launches the desktop app and can send a message to Claude and watch the response stream, on macOS, Linux, and Windows
  2. The app boots the unmodified `server.js` via `utilityProcess.fork`, waits for `GET /api/health`, then loads `http://127.0.0.1:<port>` in the window — `server.js` runtime behavior is identical to web mode
  3. All user data (DB, uploads, .env, workspace) is written under the OS userData dir via the `APP_DIR` override, and the server binds an ephemeral free port (never clashes with web mode's 3000)
  4. MCP helpers and node-based hooks run inside the packaged app — the interpreter resolver routes them through `process.execPath` + `ELECTRON_RUN_AS_NODE` in desktop and plain `node` in web, with the spawned scripts `asarUnpack`-ed so the child can read them
  5. Running `npm start` / Docker produces byte-for-byte the same web app — `electron`/`electron-builder`/`electron-updater` are devDependencies only and are never pulled by a web/Docker install
**Plans**: TBD
**UI hint**: yes

### Phase 7: Desktop Hardening
**Goal**: The desktop app behaves correctly under real-world launch conditions — finding its tools despite the GUI PATH, prompting helpfully when `claude` is missing, running as a frictionless single-user local app, and not exposing server-only features that don't belong on the desktop.
**Depends on**: Phase 6
**Requirements**: DESK-05, DEP-01, DEP-02
**Success Criteria** (what must be TRUE):
  1. On a Dock/Finder launch (where the GUI PATH lacks `claude`/`brew`/`node`/`tmux`), the app still locates and runs the `claude` CLI via explicit path probing
  2. When `claude` is not installed, the app opens a friendly window with install guidance/link instead of failing silently or crashing
  3. The user opens the desktop app and is taken straight into a working session with no login prompt (local single-user auto-session); web mode keeps its bcrypt auth unchanged
  4. Server-only features (Telegram bot, tunnel-manager, remote SSH) are off by default in desktop mode and do not appear or activate
**Plans**: TBD
**UI hint**: yes

### Phase 8: Update & Distribution
**Goal**: The desktop app is a fully distributable, self-updating product: users always see their version and a one-click in-app update (with a live report and a copy/open-terminal fallback), opt into auto-update if they choose, and install/upgrade through the right channel per OS — all published from CI with the Homebrew Cask auto-bumped.
**Depends on**: Phase 7
**Requirements**: UPD-01, UPD-02, UPD-03, UPD-04, DIST-01, DIST-02, DIST-03
**Success Criteria** (what must be TRUE):
  1. The app always shows the current version and surfaces an "Update available → vX.Y.Z" banner when a newer release exists (desktop-only UI; absent in web mode)
  2. Pressing [Update] performs a one-click update — Windows/Linux via `electron-updater` (native progress) and macOS via an app-triggered detached `brew upgrade --cask` with a live in-app report — then the app relaunches
  3. When one-click update can't run (no `brew` / not brew-managed / non-zero exit), the app shows the exact command with working [Copy] and [Open Terminal] buttons; and the user can opt into automatic updates (default OFF)
  4. The app installs and upgrades through the correct channel per OS: macOS via a Homebrew Cask (with `xattr -cr` postflight, the only supported macOS channel), Windows via NSIS, Linux via AppImage + deb
  5. A GitHub release publishes all artifacts from 3-OS CI, and the same CI auto-bumps the Homebrew Cask `version` + `sha256` so an in-app `brew upgrade` finds the new version
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 5 → 6 → 7 → 8

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 2/2 | Complete | 2026-03-28 |
| 2. UX Redesign | v1.0 | 5/5 | Complete | 2026-03-28 |
| 3. Forum Mode UX + Extraction | v1.0 | 3/3 | Complete | 2026-03-28 |
| 4. Server Encapsulation | v1.0 | 1/1 | Complete | 2026-03-28 |
| 5. De-Risk Spikes | v1.1 | 0/TBD | Not started | - |
| 6. MVP Desktop Build | v1.1 | 0/TBD | Not started | - |
| 7. Desktop Hardening | v1.1 | 0/TBD | Not started | - |
| 8. Update & Distribution | v1.1 | 0/TBD | Not started | - |
