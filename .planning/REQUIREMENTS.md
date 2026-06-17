# Requirements — v1.1 Electron Desktop

> Milestone: v1.1 Electron Desktop
> Source of truth for scope: `docs/electron-desktop/DESIGN.md` (locked design)
> Core constraint: the existing web-server mode (`npm start` / Docker) must keep working **byte-for-byte unchanged**.

## v1.1 Requirements

### Desktop Shell (DESK)

- [ ] **DESK-01**: User can launch Claude Code Studio as a native desktop app on macOS, Linux, and Windows.
- [ ] **DESK-02**: Desktop app runs the existing `server.js` via `utilityProcess.fork`, unmodified; web mode behavior is unchanged.
- [ ] **DESK-03**: Desktop app stores all user data in the OS userData directory via the `APP_DIR` override (DB, uploads, .env, workspace).
- [ ] **DESK-04**: Desktop app binds the server to an ephemeral free port (no clash with the web mode's default 3000).
- [ ] **DESK-05**: Desktop app creates a local single-user session automatically (no login prompt); web mode keeps bcrypt auth.

### Prerequisites & Desktop Behavior (DEP)

- [ ] **DEP-01**: On startup the app detects the `claude` CLI (handling the GUI-launch PATH); if missing, it shows a friendly window with install guidance.
- [ ] **DEP-02**: Server-only features (Telegram bot, tunnel-manager, remote SSH) are disabled by default in desktop mode.

### Updates (UPD)

- [ ] **UPD-01**: The app always shows the current version and indicates when a newer release exists (version banner).
- [ ] **UPD-02**: User can update with one click — Windows/Linux via `electron-updater`; macOS via app-triggered `brew upgrade --cask` with a live in-app report — then the app relaunches.
- [ ] **UPD-03**: If one-click update cannot run (no `brew` / not brew-managed / non-zero exit), the app shows the exact command with Copy and Open-Terminal buttons.
- [ ] **UPD-04**: User can opt into automatic updates (default OFF).

### Distribution (DIST)

- [ ] **DIST-01**: macOS is distributed via a Homebrew Cask (the only supported macOS channel), with an `xattr -cr` postflight; dmg/zip is only the cask's source artifact.
- [ ] **DIST-02**: Windows is distributed as an NSIS installer; Linux as AppImage + deb.
- [ ] **DIST-03**: Releases are published to GitHub; the Homebrew Cask `version`+`sha256` are auto-bumped from release CI.

### Build & Packaging (BUILD)

- [ ] **BUILD-01**: An interpreter resolver replaces the 9 hardcoded `command:'node'` spawns (+ the node-based hook) so MCP helpers/hooks run in both web (`node`) and desktop (`process.execPath` + `ELECTRON_RUN_AS_NODE`) modes.
- [ ] **BUILD-02**: Spawned helper scripts (`mcp-*.js`, `hooks/check-interrupt.js`) are `asarUnpack`-ed so the child interpreter can read them from disk.
- [ ] **BUILD-03**: `electron` / `electron-builder` / `electron-updater` live in `devDependencies` only — web/Docker installs never pull them.

## Out of Scope

- Switching the desktop build to Tauri — our backend is a multi-process Node app (spawns child `node` helpers), not a single binary; Electron fits, Tauri would force single-binary packaging + a build step (violates no-build-step philosophy).
- Apple code signing / notarization — unsigned by design; revisit only if first-launch friction proves unacceptable.
- A custom in-app macOS self-updater with own-key signing — replaced by the simpler brew-triggered upgrade.
- A supported direct-`.dmg` install/update channel on macOS — Homebrew-only.
- Bundling the `claude` CLI inside the app.
- Rewriting backend logic; splitting `public/index.html` (stays single-file).
- Windows/Linux package-manager channels (winget/scoop).

## Traceability

> Phase 5 (De-Risk Spikes) owns no delivered requirement — it is a pure de-risk gate that validates
> the assumptions behind DESK-02/DESK-03 (`node:sqlite` flag-free under Electron) and UPD-02 (the
> macOS detached `brew upgrade --cask` + relaunch flow) before MVP work begins.

| REQ-ID | Phase | Status |
|--------|-------|--------|
| DESK-01 | Phase 6 — MVP Desktop Build | Done |
| DESK-02 | Phase 6 — MVP Desktop Build | Done |
| DESK-03 | Phase 6 — MVP Desktop Build | Done |
| DESK-04 | Phase 6 — MVP Desktop Build | Done |
| DESK-05 | Phase 7 — Desktop Hardening | Done |
| DEP-01 | Phase 7 — Desktop Hardening | Done |
| DEP-02 | Phase 7 — Desktop Hardening | Done |
| UPD-01 | Phase 8 — Update & Distribution | Done |
| UPD-02 | Phase 8 — Update & Distribution | Done |
| UPD-03 | Phase 8 — Update & Distribution | Done |
| UPD-04 | Phase 8 — Update & Distribution | Done |
| DIST-01 | Phase 8 — Update & Distribution | Done |
| DIST-02 | Phase 8 — Update & Distribution | Done |
| DIST-03 | Phase 8 — Update & Distribution | Done |
| BUILD-01 | Phase 6 — MVP Desktop Build | Done |
| BUILD-02 | Phase 6 — MVP Desktop Build | Done |
| BUILD-03 | Phase 6 — MVP Desktop Build | Done |

**Coverage:** 17/17 v1.1 requirements mapped to exactly one delivering phase. No orphans, no duplicates.
