---
phase: 02-ux-redesign
plan: 03
subsystem: ui
tags: [telegram-bot, navigation, back-button, context-header, i18n]

# Dependency graph
requires:
  - phase: 02-01
    provides: SCREENS registry, CALLBACK_TO_SCREEN map, _buildBackButton method, editMsgId parameter on all screen methods
provides:
  - SCREEN_TO_CALLBACK reverse map for reliable parent callback_data resolution
  - _buildContextHeader(ctx) method showing active project/chat at top of every screen
  - Auto-generated Back buttons on all non-MAIN screens via SCREENS parent chain
  - i18n keys for context header (header_project, header_chat, header_none, header_separator) in all 3 locales
affects: [02-04, 02-05]

# Tech tracking
tech-stack:
  added: []
  patterns: [context-header-injection, auto-back-button-generation, screen-to-callback-reverse-map]

key-files:
  created: []
  modified:
    - telegram-bot.js
    - telegram-bot-i18n.js

key-decisions:
  - "SCREEN_TO_CALLBACK maps screen keys to callback_data for back navigation instead of reverse-looking up CALLBACK_TO_SCREEN (avoids prefix ambiguity)"
  - "PROJECT parent maps to p:list (projects list) rather than p:sel:N (project detail needs index we don't have at back-render time)"
  - "Context header replaces per-screen inline project/chat display in _screenMainMenu for consistency"
  - "Context header uses trimEnd() in Dialog/DialogFull to avoid double spacing with existing header lines"

patterns-established:
  - "Context header injection: every screen prepends this._buildContextHeader(ctx) to its text body"
  - "Auto back button: every non-MAIN screen appends this._buildBackButton('SCREEN_KEY', ctx) to its keyboard"
  - "Error states use _buildBackButton with fallback: _buildBackButton('X', ctx) || [hardcoded fallback]"

requirements-completed: [NAV-02, NAV-04, NAV-06]

# Metrics
duration: 6min
completed: 2026-03-28
---

# Phase 02 Plan 03: Context Header + Back Button Summary

**SCREEN_TO_CALLBACK reverse map, _buildContextHeader utility, and auto-generated Back buttons on all 11 screen methods with i18n keys in 3 locales**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-28T19:53:18Z
- **Completed:** 2026-03-28T19:59:49Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Every screen now shows a context header with active project/chat (or "Nothing selected")
- Every non-MAIN screen has an auto-generated Back button from SCREENS parent chain
- MAIN screen has no Back button (correct -- it is the navigation root)
- New i18n keys (header_project, header_chat, header_none, header_separator) in uk, en, ru
- SCREEN_TO_CALLBACK constant provides reliable parent -> callback_data mapping

## Task Commits

Each task was committed atomically:

1. **Task 1: Add i18n keys and _buildContextHeader method** - `6d53590` (feat)
2. **Task 2: Inject context header and auto-generated Back button into every screen** - `a7b2671` (feat)

## Files Created/Modified
- `telegram-bot-i18n.js` - Added 12 new i18n keys (4 per locale x 3 locales) for context header
- `telegram-bot.js` - Added SCREEN_TO_CALLBACK constant, _buildContextHeader method, updated _buildBackButton, modified all 11 screen methods

## Decisions Made
- SCREEN_TO_CALLBACK reverse map used instead of reverse CALLBACK_TO_SCREEN lookup to avoid prefix-match ambiguity (e.g., 'p:sel:' has trailing colon making it unusable as callback_data)
- PROJECT back target maps to 'p:list' (projects list) because the project detail screen needs an index we don't have at back-render time -- user sees projects list highlighted
- Context header in _screenMainMenu replaces the old inline project/chat display lines for consistency
- Error and empty states use _buildBackButton with hardcoded fallback (`|| [...]`) for safety

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All screens now have consistent context headers and back buttons
- Ready for Plan 04 (persistent reply keyboard redesign) which builds on this context visibility
- Ready for Plan 05 (setMyCommands + slash command pruning)
- The back chain MAIN -> PROJECTS -> PROJECT -> CHATS -> DIALOG -> DIALOG_FULL is fully connected via SCREENS parent pointers

---
*Phase: 02-ux-redesign*
*Completed: 2026-03-28*
