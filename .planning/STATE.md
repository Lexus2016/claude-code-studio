---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Electron Desktop
status: planning
last_updated: "2026-06-17T08:23:51.642Z"
last_activity: 2026-06-17
progress:
  total_phases: 4
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-17)

**Core value:** A user should be able to send a message to Claude in 2 taps or fewer — from any state, without knowing any slash commands
**Current milestone:** v1.1 Electron Desktop — ship a native desktop app (macOS, Linux, Windows) running the existing server.js unchanged, with in-app GUI updates
**Current focus:** Phase 05 — De-Risk Spikes (roadmap created, ready to plan)

## Current Position

Phase: 05 — De-Risk Spikes (not started)
Plan: —
Status: Roadmap created — ready to plan Phase 05
Last activity: 2026-06-17 — v1.1 roadmap created (Phases 5-8 mapped to DESIGN.md phases 0-3)

## v1.1 Phase Map

| GSD Phase | DESIGN Phase | Goal | Requirements |
|-----------|--------------|------|--------------|
| 05 — De-Risk Spikes | Phase 0 | Prove node:sqlite flag-free + brew-upgrade-from-GUI | none (de-risk gate) |
| 06 — MVP Desktop Build | Phase 1 | Electron shell forks server.js, chat works on 3 OSes | DESK-01..04, BUILD-01..03 |
| 07 — Desktop Hardening | Phase 2 | GUI PATH, claude detect, disable server-only, ephemeral port, auto-session | DESK-05, DEP-01, DEP-02 |
| 08 — Update & Distribution | Phase 3 | In-app updates, Cask/NSIS/AppImage+deb, GitHub + CI cask bump | UPD-01..04, DIST-01..03 |

## Performance Metrics

**Velocity:**

- Total plans completed (v1.1): 0
- Average duration: -
- Total execution time: 0 hours

**By Phase (v1.1):**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: none yet for v1.1
- Trend: -

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table and DESIGN.md §7 (locked).
Recent decisions affecting current work:

- [v1.1 Design]: Electron (not Tauri) — backend is a multi-process Node app that spawns child node helpers; Tauri would force single-binary packaging + a build step (violates no-build-step rule)
- [v1.1 Design]: One codebase, two launchers — server.js stays the single source of truth; Electron is a thin shell that forks it; web mode stays byte-for-byte unchanged
- [v1.1 Design]: utilityProcess.fork(server.js) (not in-process require, not a separate Electron fork of the app)
- [v1.1 Design]: APP_DIR = app.getPath('userData') for desktop data; ephemeral free port (web keeps 3000); local single-user auto-session (web keeps bcrypt)
- [v1.1 Design]: Unsigned on all 3 OSes; tiered update — Win/Linux electron-updater, macOS app-triggered detached brew upgrade --cask + relaunch; no custom crypto
- [v1.1 Design]: Homebrew Cask is the only supported macOS channel (xattr -cr postflight, auto_updates false); dmg/zip is the cask's source artifact only
- [v1.1 Roadmap]: Phase 05 is a pure de-risk gate owning no delivered REQ — its criteria are the two load-bearing assumptions (node:sqlite flag-free; brew-upgrade-from-GUI)
- [v1.1 Roadmap]: DESK-04 (ephemeral port) delivered in Phase 06 (part of launching); DESK-05 (auto-session) in Phase 07 (hardening) per DESIGN phasing

### Pending Todos

None yet for v1.1.

### Blockers/Concerns

- Phase 05: node:sqlite must work flag-free in packaged Electron 37 (Node 22.18) — if it needs --experimental-sqlite, MVP packaging strategy changes
- Phase 05: detached brew upgrade --cask + relaunch from a GUI-launched app is the riskiest macOS flow (brew-path detection under GUI PATH, quit/replace/relaunch timing) — prove before Phase 08
- Phase 07: GUI-launch PATH problem (macOS/Linux) — claude/tmux/brew/node not on Dock-launch PATH; mitigate via explicit path probing in electron/main.js
- Hard constraint (all phases): web-server mode (npm start / Docker) must remain byte-for-byte unchanged; verify after every shared-code change (interpreter resolver is the only shared-runtime change)

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260329-fr1 | implement chat export/import feature: export session+messages as JSON, import creates new session with same messages as context | 2026-03-29 | 45ffdb1 | [260329-fr1-implement-chat-export-import-feature-exp](.planning/quick/260329-fr1-implement-chat-export-import-feature-exp/) |
| 260404-qlq | hide interrupt pill for SSH project sessions | 2026-04-04 | 4e78d0d | [260404-qlq-hide-interrupt-pill-for-ssh-project-sess](.planning/quick/260404-qlq-hide-interrupt-pill-for-ssh-project-sess/) |
| 260612-efs | add fable model to picker + subscription (Max) engine via interactive tmux sessions | 2026-06-12 | 0bd851b | [260612-efs-add-fable-model-to-model-picker-interact](.planning/quick/260612-efs-add-fable-model-to-model-picker-interact/) |
| 260617-tw0 | fix macOS "two Terminal windows" on launch — run AppleScript `do script` before `activate` at both terminal-open call sites | 2026-06-17 | d298c40 | [260617-tw0-fix-macos-two-terminal-windows](.planning/quick/260617-tw0-fix-macos-two-terminal-windows/) |
| 260617-ulp | fix macOS in-app update loop — `brew update` before `brew upgrade` (drop HOMEBREW_NO_AUTO_UPDATE) + desktop-gate the version badge | 2026-06-17 | dff14d1 | [260617-ulp-fix-macos-update-loop](.planning/quick/260617-ulp-fix-macos-update-loop/) |
| 260617-d62 | desktop: stable loopback port (localStorage persists), telegram bot resumes on restart, Engine switcher hidden + chat forced to API (claude -p) | 2026-06-17 | 34f8c77 | [260617-d62-desktop-port-telegram-engine](.planning/quick/260617-d62-desktop-port-telegram-engine/) |
| 260617-qcu | catch-up button — pull conversation from an opened `claude --resume` terminal into the web chat (pull-on-demand transcript sync, engine-agnostic) | 2026-06-17 | f79843e | [260617-qcu-add-catch-up-from-console-session-button](.planning/quick/260617-qcu-add-catch-up-from-console-session-button/) |

## Session Continuity

Last activity: 2026-06-17 — quick task 260617-qcu: catch-up button (pull `claude --resume` terminal conversation into web chat)

Last session: 2026-06-17
Stopped at: Roadmap + traceability written; ready to plan Phase 05
Resume file: None

## Operator Next Steps

- Plan the first v1.1 phase with /gsd-plan-phase 5
