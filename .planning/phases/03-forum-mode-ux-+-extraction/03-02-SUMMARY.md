---
phase: 03-forum-mode-ux-+-extraction
plan: 02
subsystem: ui
tags: [telegram-bot, forum-mode, inline-keyboards, i18n, setMyCommands, UX]

# Dependency graph
requires:
  - phase: 03-forum-mode-ux-+-extraction/01
    provides: "TelegramBotForum class, composition facade, forum-scoped state"
provides:
  - "Inline action keyboards on all forum interaction points (done, error, activity, session switch)"
  - "Forum-scoped setMyCommands (help, status, new, stop)"
  - "i18n for all TelegramProxy forum button labels"
  - "fm:help, fa:continue, fa:new callback handlers"
  - "Richer session switch confirmation with session name + message count"
affects: [03-03, phase-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "i18n for inline keyboard buttons via this._bot._t() in TelegramProxy"
    - "Activity notification action buttons (fa:continue, fa:new) for cross-topic actions"
    - "Forum-scoped setMyCommands with BotCommandScopeChat"

key-files:
  created: []
  modified:
    - telegram-bot-forum.js
    - telegram-bot-i18n.js
    - server.js

key-decisions:
  - "Only forum-mode button labels in server.js TelegramProxy are i18n-ified; Direct Mode buttons left as-is (separate scope)"
  - "Error recovery layout changed from 1 row (3 buttons) to 2 rows (2+2 buttons) to accommodate Help button"
  - "fa:continue and fa:new handlers create project topics on demand if they don't exist"

patterns-established:
  - "Forum action callbacks from Activity topic: fa:continue:sessionId, fa:new:workdir"
  - "Context-aware fm:help determines topic type and shows appropriate help text"

requirements-completed: [FORUM-06, FORUM-07, FORUM-08, FORUM-09, FORUM-11]

# Metrics
duration: 3min
completed: 2026-03-28
---

# Phase 03 Plan 02: Forum UX Enhancements Summary

**Inline action keyboards on all forum interaction points with i18n, setMyCommands scoping, and activity notification action buttons**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-28T20:53:03Z
- **Completed:** 2026-03-28T20:56:30Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- All forum button labels in server.js TelegramProxy now use i18n (10 _t() calls replacing hardcoded English)
- Activity notifications have Continue/New session action buttons beyond the URL "Open chat" link (FORUM-08)
- Error messages include Help button alongside Retry/Continue/History with 2-row layout (FORUM-09)
- Session switch shows rich confirmation with session name + message count using fm_session_switched key (FORUM-11)
- setMyCommands called after /connect with forum-scoped commands: help, status, new, stop (FORUM-07)
- fm:help callback shows context-appropriate help based on topic type (project/tasks/general)
- fa:continue and fa:new callbacks handle cross-topic actions from Activity topic with auto-create support
- 10 new i18n keys added in all 3 locales (uk, en, ru)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add i18n keys and enhance forum inline keyboards** - `575ac52` (feat)
2. **Task 2: i18n-ify server.js TelegramProxy forum buttons** - `e15f1c4` (feat)

## Files Created/Modified
- `telegram-bot-i18n.js` - Added 10 new i18n keys (fm_btn_help, fm_btn_retry, fm_btn_stop, fm_btn_go_topic, fm_session_switched, fm_cmd_help_desc, fm_cmd_status_desc, fm_cmd_new_desc, fm_cmd_stop_desc) in uk, en, ru
- `telegram-bot-forum.js` - Added _setForumCommands method, fa:continue/fa:new handlers in handleActivityCallback, fm:help handler in handleActionCallback, enhanced notifyActivity with action buttons, richer session switch confirmation
- `server.js` - Replaced 10 hardcoded English button labels with this._bot._t() calls in TelegramProxy._finalize, _sendError, _sendProgress

## Decisions Made
- Only forum-mode button labels in server.js are i18n-ified; Direct Mode buttons (cm:compose, m:menu) left as-is since they have their own i18n scope
- Error recovery layout changed from 1 row to 2 rows to accommodate Help button without overcrowding
- fa:continue and fa:new handlers auto-create project topics if they don't exist, ensuring activity action buttons always work

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] i18n-ified forum progress Stop button**
- **Found during:** Task 2
- **Issue:** _sendProgress had a hardcoded '🛑 Stop' button for forum mode, not covered in the plan's explicit list
- **Fix:** Replaced with this._bot._t('fm_btn_stop') for forum-mode progress button
- **Files modified:** server.js
- **Verification:** grep confirms no hardcoded English in forum button paths
- **Committed in:** e15f1c4 (Task 2)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Minor addition for consistency. No scope creep.

## Issues Encountered
None

## Known Stubs
None -- all handlers are fully implemented with actual logic, no placeholder returns.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Forum UX is fully button-driven across all interaction points
- Ready for Phase 3 Plan 03 (guided onboarding, task inline buttons)
- All existing Forum Mode supergroups continue working without reconfiguration

---
*Phase: 03-forum-mode-ux-+-extraction*
*Completed: 2026-03-28*
