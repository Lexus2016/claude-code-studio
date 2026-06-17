---
phase: 01-foundation
plan: 02
subsystem: state-management
tags: [fsm, state-machine, telegram-bot, refactor, migration]

# Dependency graph
requires:
  - "01-01: telegram-bot-i18n.js extraction (slimmer telegram-bot.js)"
provides:
  - "FSM_STATES constant exported from telegram-bot.js"
  - "ctx.state/ctx.stateData as single source of truth for pending input state"
  - "_migrateContextToFSM auto-migration for old context objects"
  - "answerCallbackQuery in finally block (guaranteed execution)"
  - "Slash command state reset to IDLE (FSM-03)"
affects: [phase-02, phase-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Explicit FSM enum (string constants) replacing boolean/string flag soup"
    - "Auto-migration pattern in _getContext for backward-compatible context upgrades"
    - "finally block for Telegram answerCallbackQuery guarantee"
    - "String literals in server.js for cross-module state values (avoids circular deps)"

key-files:
  created: []
  modified:
    - telegram-bot.js
    - server.js

key-decisions:
  - "server.js uses string literals ('AWAITING_ASK_RESPONSE', 'IDLE') instead of importing FSM_STATES to avoid circular dependency risk"
  - "COMPOSING resets to IDLE on send (one-shot affordance, not persistent mode)"
  - "FSM_STATES exported via module.exports.FSM_STATES for future consumers"

patterns-established:
  - "FSM state transitions always set both ctx.state and ctx.stateData together"
  - "Clearing state = ctx.state = FSM_STATES.IDLE + ctx.stateData = null (never partial)"
  - "Guarded state clears in server.js: check state === 'AWAITING_ASK_RESPONSE' before resetting"

requirements-completed: [FSM-01, FSM-02, FSM-03, FSM-04, FSM-05]

# Metrics
duration: 5min
completed: 2026-03-28
---

# Phase 01 Plan 02: FSM State Migration Summary

**Replaced 3 ad-hoc state flags (pendingInput, pendingAskRequestId, composing) with explicit FSM enum (ctx.state + ctx.stateData) across telegram-bot.js and server.js, with auto-migration and answerCallbackQuery in finally block**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-28T18:43:45Z
- **Completed:** 2026-03-28T18:49:29Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Eliminated entire class of "silent message capture" bugs where conflicting state flags route text to wrong handler
- Added FSM_STATES constant with 5 mutually exclusive states (IDLE, COMPOSING, AWAITING_TASK_TITLE, AWAITING_TASK_DESCRIPTION, AWAITING_ASK_RESPONSE)
- Updated 25+ mutation sites in telegram-bot.js and 4 locations in server.js atomically
- Added _migrateContextToFSM for zero-downtime migration of existing user contexts
- Moved answerCallbackQuery to finally block -- spinner always clears even on handler errors
- Added slash command state reset (FSM-03) -- `/status` while in task creation no longer captures as task title

## Task Commits

Each task was committed atomically:

1. **Task 1: Add FSM_STATES, rewrite _getContext with auto-migration, update all state flag locations in telegram-bot.js** - `44c30b9` (feat)
2. **Task 2: Update server.js -- replace all 4 pendingAskRequestId write locations with FSM state fields** - `7c580a5` (feat)

## Files Created/Modified
- `telegram-bot.js` - FSM_STATES constant, rewritten _getContext with auto-migration, _migrateContextToFSM method, updated _handleCallback with finally block, state reset in _handleCommand, all text/callback/ask handlers use ctx.state/ctx.stateData
- `server.js` - 4 locations updated: TelegramProxy._handleAskUser, _handleAskUserDismiss, _clearTelegramAskState, processTelegramChat finally block

## Decisions Made
- Used string literals in server.js rather than importing FSM_STATES to avoid circular dependency risk. The coupling already exists (server.js calls bot._getContext()), but making it import-based adds unnecessary tight coupling for only 4 locations.
- COMPOSING auto-resets to IDLE after sending text. It's a one-shot "next text goes to Claude" affordance, not a persistent mode.
- Exported FSM_STATES via `module.exports.FSM_STATES` for potential future consumers (Phase 2 modules).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all state transitions are fully wired and functional.

## Next Phase Readiness
- Phase 1 Foundation complete: i18n extracted (Plan 01) + FSM migrated (Plan 02)
- telegram-bot.js is now structurally clean for Phase 2 screen redesign work
- ctx.state provides the foundation for Phase 2's navigation state machine
- All paired devices continue working without re-pairing (auto-migration handles old contexts)

## Self-Check: PASSED

- telegram-bot.js: FOUND
- server.js: FOUND
- 01-02-SUMMARY.md: FOUND
- Commit 44c30b9: FOUND
- Commit 7c580a5: FOUND

---
*Phase: 01-foundation*
*Completed: 2026-03-28*
