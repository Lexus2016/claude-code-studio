---
phase: 02-ux-redesign
plan: 01
subsystem: navigation
tags: [telegram-bot, screens-registry, callback-routing, editMsgId, inline-keyboard]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: FSM state machine (ctx.state, FSM_STATES), i18n extraction (telegram-bot-i18n.js)
provides:
  - SCREENS registry with 11 entries and parent chain for navigation hierarchy
  - CALLBACK_TO_SCREEN mapping (12 entries) for callback-to-screen routing
  - _buildBackButton method for automatic back button generation
  - editMsgId-based screen handler pattern (all screens accept { editMsgId })
  - Elimination of ctx.screenMsgId/ctx.screenChatId global slot
affects: [02-03, 02-04, 02-05, 03-forum-extraction]

# Tech tracking
tech-stack:
  added: []
  patterns: [editMsgId-from-callback-anchor, SCREENS-registry-parent-chain, edit-or-send-pattern]

key-files:
  created: []
  modified: [telegram-bot.js]

key-decisions:
  - "SCREENS registry uses function parents for dynamic resolution (CHATS, FILES, TASKS depend on ctx.projectWorkdir)"
  - "CALLBACK_TO_SCREEN keeps existing short prefixes rather than introducing new scr: format"
  - "_buildBackButton resolves parent at render time, not navigation time (avoids stale context)"
  - "Forum callbacks (fs:, fm:, fa:) excluded from opts propagation per Phase 3 boundary"

patterns-established:
  - "editMsgId pattern: all screen methods accept { editMsgId } = {} as last parameter; if editMsgId truthy, edit; else send new"
  - "opts propagation: route methods accept opts = {} and pass through to screen calls"
  - "SCREENS registry: navigation hierarchy defined as data, not encoded in callback_data"

requirements-completed: [ARCH-02, ARCH-03, ARCH-04, NAV-03]

# Metrics
duration: 9min
completed: 2026-03-28
---

# Phase 2 Plan 1: SCREENS Registry + editMsgId Refactor Summary

**SCREENS registry with 11 entries and parent chain, CALLBACK_TO_SCREEN map with 12 prefix mappings, editMsgId-based screen handlers replacing ctx.screenMsgId global slot**

## Performance

- **Duration:** 9 min
- **Started:** 2026-03-28T19:28:57Z
- **Completed:** 2026-03-28T19:38:34Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- SCREENS registry defines 11 screens (MAIN, PROJECTS, PROJECT, CHATS, DIALOG, DIALOG_FULL, FILES, TASKS, STATUS, TUNNEL, SETTINGS) with handler methods and parent chain for back navigation
- CALLBACK_TO_SCREEN maps 12 callback_data prefixes to screen keys, preserving backward compatibility
- _buildBackButton method generates back buttons from SCREENS parent chain (supports dynamic parents via function)
- All 12+ screen methods refactored to accept { editMsgId } parameter -- ctx.screenMsgId and ctx.screenChatId completely eliminated (0 occurrences remaining)
- _handleCallback passes editMsgId from cbq.message.message_id to all screen routes
- All 15 legacy callback prefixes remain functional; forum callbacks untouched

## Task Commits

Each task was committed atomically:

1. **Task 1: Add SCREENS registry, CALLBACK_TO_SCREEN map, and _buildBackButton** - `f2424e1` (feat)
2. **Task 2: Refactor _handleCallback and ALL screen methods to use editMsgId** - `d9cbd1e` (feat)

## Files Created/Modified
- `telegram-bot.js` - Added SCREENS/CALLBACK_TO_SCREEN constants, _buildBackButton method; refactored all screen methods to accept { editMsgId }; removed ctx.screenMsgId/ctx.screenChatId from _getContext, _showScreen, and _handleCallback

## Decisions Made
- SCREENS registry uses function-based parents for CHATS, FILES, and TASKS (dynamic resolution based on ctx.projectWorkdir) -- this avoids hard-coding and makes back navigation context-aware
- Kept existing callback_data short prefixes (m:, p:, c:, etc.) rather than introducing new scr: format -- preserves backward compatibility with old buttons in chat history
- _buildBackButton resolves parent at render time, ensuring back button always reflects current context state
- Forum callbacks (fs:, fm:, fa:) explicitly excluded from opts propagation per Phase 3 boundary -- these manage their own message IDs

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all functionality is fully wired.

## Next Phase Readiness
- SCREENS registry and editMsgId pattern are the foundation for Plan 02-03 (back buttons + context headers)
- Plan 02-04 (persistent keyboard redesign) can now use _buildBackButton for automated back row injection
- Plan 02-05 (setMyCommands) is independent but benefits from the clean screen hierarchy

---
*Phase: 02-ux-redesign*
*Completed: 2026-03-28*
