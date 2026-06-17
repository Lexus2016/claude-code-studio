---
phase: 03-forum-mode-ux-+-extraction
plan: 03
subsystem: telegram-bot
tags: [telegram, inline-keyboard, onboarding, task-management, i18n]

# Dependency graph
requires:
  - phase: 03-forum-mode-ux-+-extraction/03-01
    provides: TelegramBotForum class with composition pattern and API facade
provides:
  - Guided 3-step forum onboarding flow (fo: callback prefix)
  - Task inline buttons with status-cycle actions (ft: callback prefix)
  - i18n keys for onboarding steps and task button labels (uk/en/ru)
affects: [forum-mode, settings-screen, task-management]

# Tech tracking
tech-stack:
  added: []
  patterns: [stateless-onboarding-flow, status-cycle-buttons, prefix-collision-avoidance]

key-files:
  created: []
  modified:
    - telegram-bot-forum.js
    - telegram-bot-i18n.js
    - telegram-bot.js

key-decisions:
  - "Onboarding is stateless — each step is a screen edit, no persistent state to clean up on navigation away (Pitfall 4 avoidance)"
  - "ft: and fo: prefixes routed BEFORE f: in both telegram-bot.js and handleCallback to prevent prefix collision (Pitfall 3)"
  - "Task list skips done tasks in inline keyboard to reduce button clutter"
  - "botUsername() added to API facade for onboarding step 2 bot mention"

patterns-established:
  - "fo: prefix for forum onboarding callbacks"
  - "ft: prefix for forum task callbacks"
  - "Stateless guided flow via inline keyboard edit-in-place (no server-side step tracking)"

requirements-completed: [FORUM-05, FORUM-10]

# Metrics
duration: 3min
completed: 2026-03-28
---

# Phase 03 Plan 03: Forum Onboarding + Task Buttons Summary

**Guided 3-step forum setup replacing text wall, plus per-task inline buttons replacing /start #id and /done #id slash commands**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-28T21:00:19Z
- **Completed:** 2026-03-28T21:03:36Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments
- Replaced text-wall forum setup instructions with guided 3-step inline-button onboarding (intro -> Create Group -> Add Bot -> Connect)
- Added inline task buttons (Start, Done, Block, Todo, Reopen) on task creation and task list
- Added handleTaskCallback for ft: prefix with status change + task info display
- Routed ft: and fo: before f: in both telegram-bot.js and forum module to prevent prefix collision
- Added 36 new i18n keys across uk/en/ru (12 per locale: 8 onboarding + 5 task buttons)

## Task Commits

Each task was committed atomically:

1. **Task 1: Guided forum onboarding + task inline buttons** - `bc30310` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `telegram-bot-forum.js` - Added startOnboarding(), handleOnboardingCallback(), _buildTaskButtons(), handleTaskCallback(); updated handleCallback routing for fo:/ft:; added inline buttons to task creation and /list
- `telegram-bot-i18n.js` - Added forum_setup_* keys (title, intro, step1-3, buttons), ft_btn_* keys (start, done, block, todo, reopen); removed /start #id /done #id from forum_task_created
- `telegram-bot.js` - Replaced s:forum text-wall with startOnboarding() call; added ft:/fo: to forum callback delegation; added botUsername() to API facade

## Decisions Made
- Onboarding is fully stateless: each step edits the same message in place, no server-side step counter needed. Cancel simply returns to Settings menu via s:menu callback.
- Task list inline buttons skip "done" status tasks to reduce visual clutter — users can still /list to see them in the text.
- botUsername() added as a lazy getter (`this._botInfo?.username || 'your_bot'`) since bot info may not be available at construction time.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added botUsername to API facade**
- **Found during:** Task 1, Part A (onboarding step 2 needs @bot_username)
- **Issue:** The API facade didn't include bot username, but onboarding step 2 needs it for "Search for @bot_username"
- **Fix:** Added `botUsername: () => this._botInfo?.username || 'your_bot'` to API facade in telegram-bot.js
- **Files modified:** telegram-bot.js
- **Verification:** node -c passes, method accessible from forum module
- **Committed in:** bc30310

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Essential for onboarding step 2 to display correct bot username. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 3 complete: all 3 plans executed (extraction, UX enhancements, onboarding + task buttons)
- Forum module fully functional with guided onboarding, inline action buttons, and task management
- Ready for Phase 4 or any follow-up work

---
## Self-Check: PASSED

- telegram-bot-forum.js: FOUND
- telegram-bot-i18n.js: FOUND
- telegram-bot.js: FOUND
- Commit bc30310: FOUND
- 03-03-SUMMARY.md: FOUND

---
*Phase: 03-forum-mode-ux-+-extraction*
*Completed: 2026-03-28*
