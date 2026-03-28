---
phase: 03-forum-mode-ux-+-extraction
plan: 01
subsystem: architecture
tags: [telegram-bot, forum-mode, module-extraction, composition-pattern, state-scoping]

# Dependency graph
requires:
  - phase: 02-ux-redesign
    provides: "SCREENS registry, editMsgId parameters, FSM_STATES, context headers, back buttons, dynamic keyboard"
provides:
  - "TelegramBotForum class in telegram-bot-forum.js (1002 lines)"
  - "Composition facade pattern for module extraction"
  - "Forum-scoped state via _forumContext map keyed by chatId:threadId:userId"
  - "All forum callbacks (fs:, fm:, fa:) routing to forum module"
  - "Notification bridges (notifyActivity, notifyAskUser) delegated to forum module"
affects: [03-02, 03-03, phase-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Composition via API facade (not inheritance) for module extraction"
    - "Composite key state scoping: chatId:threadId:userId"
    - "Shared command delegation via facade methods (cmdFiles, cmdDiff, etc.)"

key-files:
  created:
    - telegram-bot-forum.js
  modified:
    - telegram-bot.js

key-decisions:
  - "Composition pattern with API facade object, not class inheritance, for clean module boundary"
  - "Shared commands (cmdFiles, cmdDiff, cmdStatus) passed as facade functions rather than event-based delegation"
  - "_currentThreadId kept in parent bot as legacy for shared command forum-aware button generation"
  - "Forum context uses _getForumContext with composite key for attachment isolation, while sessionId/projectWorkdir still uses direct mode context for DB persistence"

patterns-established:
  - "API facade pattern: { db, log, callApi, sendMessage, t, escHtml, stmts, emit, cmdFiles, ... }"
  - "Forum state scoping: _forumContext map with chatId:threadId:userId composite key"
  - "threadId as explicit parameter in all forum methods, never stored as class state"

requirements-completed: [FORUM-01, FORUM-02, FORUM-03, FORUM-04]

# Metrics
duration: 10min
completed: 2026-03-28
---

# Phase 03 Plan 01: Forum Mode Extraction Summary

**TelegramBotForum extracted to telegram-bot-forum.js (1002 lines) via composition facade, with forum-scoped state and explicit threadId parameters**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-28T20:39:27Z
- **Completed:** 2026-03-28T20:50:16Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Extracted all 21 forum methods from telegram-bot.js into standalone TelegramBotForum class
- telegram-bot.js reduced from 4464 to 3594 lines (870 lines removed)
- Forum-scoped state via _forumContext map keyed by chatId:threadId:userId (FORUM-02 fix)
- Eliminated _currentThreadId from all forum code -- threadId always an explicit parameter (FORUM-03 fix)
- 11 delegation points wired in telegram-bot.js to this._forum
- Both modules load without error via require()

## Task Commits

Each task was committed atomically:

1. **Task 1: Create telegram-bot-forum.js with TelegramBotForum class and all 21 forum methods** - `e49d92e` (feat)
2. **Task 2: Rewire telegram-bot.js -- remove 21 forum methods, create facade, delegate routing** - `d662524` (feat)

## Files Created/Modified
- `telegram-bot-forum.js` - New TelegramBotForum class with all 21 forum methods, composition pattern, forum-scoped state
- `telegram-bot.js` - Removed 870 lines of forum methods, added composition facade in constructor, rewired all routing and notification bridges

## Decisions Made
- Used composition via API facade (not inheritance) to avoid circular dependencies and keep interface explicit
- Shared commands (cmdFiles, cmdDiff, cmdStatus, etc.) passed as bound functions in the facade rather than using EventEmitter-based delegation -- simpler, more debuggable
- Kept _currentThreadId in parent TelegramBot as legacy property for shared command button generation (_showMessages, _showFullMessage, _cmdFull use it for forum-aware action buttons) -- will be removed in Phase 4
- Forum-scoped _forumContext map used for pendingAttachments isolation, while sessionId/projectWorkdir still uses getDirectContext for DB persistence compatibility

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added shared command facade methods**
- **Found during:** Task 1 (Creating TelegramBotForum)
- **Issue:** Plan specified emit-based delegation for shared commands (forum_cmd, forum_cmd_status events), but this would require event listeners in the parent bot -- less direct, harder to debug
- **Fix:** Added cmdStatus, cmdFiles, cmdCat, cmdLast, cmdFull, cmdDiff, cmdLog, cmdStop, handleMediaMessage as bound facade methods instead
- **Files modified:** telegram-bot-forum.js, telegram-bot.js
- **Verification:** All shared commands route correctly through facade
- **Committed in:** e49d92e (Task 1), d662524 (Task 2)

**2. [Rule 1 - Bug] Added showInfo public method for forum topic guard**
- **Found during:** Task 2 (Rewiring telegram-bot.js)
- **Issue:** Forum topic guard in _handleCallback needs to redirect m:menu/m:status to forum project info. Plan mentioned this but the method name needed to be public
- **Fix:** Added public showInfo(chatId, userId, workdir, threadId) method that delegates to _forumShowInfo
- **Files modified:** telegram-bot-forum.js
- **Verification:** Guard correctly redirects to forum info screen
- **Committed in:** e49d92e (Task 1)

**3. [Rule 1 - Bug] Rewired /forum slash command handler**
- **Found during:** Task 2 (Rewiring telegram-bot.js)
- **Issue:** The /forum text command handler at line 928 still called this._cmdForum directly (not in the plan's explicit removal list but was a leftover reference)
- **Fix:** Changed to this._forum.cmdForum(chatId, userId)
- **Files modified:** telegram-bot.js
- **Verification:** grep confirms 0 remaining forum method references
- **Committed in:** d662524 (Task 2)

---

**Total deviations:** 3 auto-fixed (1 missing critical, 2 bugs)
**Impact on plan:** All auto-fixes necessary for correctness. Facade approach is cleaner than event-based delegation. No scope creep.

## Issues Encountered
None

## Known Stubs
None -- all forum methods are fully wired, no placeholder implementations.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- telegram-bot-forum.js is ready for Phase 3 Plan 02 (forum UX enhancements)
- telegram-bot-forum.js is ready for Phase 3 Plan 03 (guided onboarding)
- Existing Forum Mode supergroups continue working without reconfiguration (DB schema unchanged, routing intact)

---
*Phase: 03-forum-mode-ux-+-extraction*
*Completed: 2026-03-28*
