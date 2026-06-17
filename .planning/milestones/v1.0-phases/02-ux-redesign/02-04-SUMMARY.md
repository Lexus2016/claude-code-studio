---
phase: 02-ux-redesign
plan: 04
subsystem: ui
tags: [telegram-bot, reply-keyboard, setMyCommands, i18n, prefix-matching]

# Dependency graph
requires:
  - phase: 02-01
    provides: "SCREENS registry, editMsgId refactor, _buildContextHeader, _buildBackButton"
provides:
  - "_buildReplyKeyboard: dynamic context-aware persistent keyboard"
  - "_sendReplyKeyboard: sends message with updated keyboard"
  - "_setCommands: minimal /start /help /cancel /status command menu"
  - "Prefix-based keyboard button matching for dynamic labels"
  - "Keyboard refresh on project/chat context changes"
affects: [02-05, server.js TelegramProxy finalization]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Prefix matching for dynamic reply keyboard button text", "Keyboard resend on context change via separate sendMessage"]

key-files:
  created: []
  modified:
    - telegram-bot.js
    - telegram-bot-i18n.js

key-decisions:
  - "Keyboard context update via separate sendMessage (editMessageText cannot set ReplyKeyboardMarkup)"
  - "Project button uses startsWith matching with kb_project_prefix emoji"
  - "setMyCommands called once at startup, not per-user"
  - "Forum mode keyboard interception updated for prefix matching"

patterns-established:
  - "Prefix matching: text.startsWith(this._t('kb_write')) for buttons with dynamic suffixes"
  - "Keyboard refresh pattern: _sendReplyKeyboard with brief confirmation message after context change"

requirements-completed: [KB-01, KB-02, KB-03, NAV-06]

# Metrics
duration: 4min
completed: 2026-03-28
---

# Phase 02 Plan 04: Persistent Reply Keyboard Summary

**Dynamic context-aware persistent keyboard with project/chat labels, prefix-based button matching, and minimal setMyCommands**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-28T20:02:40Z
- **Completed:** 2026-03-28T20:07:09Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Dynamic persistent keyboard shows active project name and chat title in button labels
- Write button always visible in first row, with chat name appended when session active
- Prefix-based button matching handles dynamic labels (e.g., "Write . MyChat" matches "Write")
- setMyCommands called at startup with only /start, /help, /cancel, /status (navigation commands removed)
- Keyboard automatically refreshes on project select, chat select, and new chat creation
- Forum mode keyboard interception updated for prefix-based matching

## Task Commits

Each task was committed atomically:

1. **Task 1: Add i18n keys, _buildReplyKeyboard, _sendReplyKeyboard, _setCommands** - `8a4700f` (feat)
2. **Task 2: Update keyboard matching to prefix-based, wire dynamic keyboard to context changes** - `a7d63ba` (feat)

## Files Created/Modified
- `telegram-bot-i18n.js` - Added kb_project_prefix, cmd_start_desc/help/cancel/status to uk/en/ru locales
- `telegram-bot.js` - Added _buildReplyKeyboard, _sendReplyKeyboard, _setCommands methods; prefix matching for keyboard buttons; dynamic keyboard on context changes

## Decisions Made
- Keyboard context update uses a separate sendMessage call with brief confirmation text, because editMessageText cannot set ReplyKeyboardMarkup (Telegram API limitation)
- setMyCommands called once at bot startup (not per-user), since the bot serves a single authenticated user set
- Forum mode keyboard interception updated with startsWith for Write and Project buttons to prevent them from being sent to Claude as text

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Updated forum mode keyboard interception for prefix matching**
- **Found during:** Task 2 (keyboard button matching update)
- **Issue:** Forum mode had exact-match checks for kb_write that would break with dynamic labels
- **Fix:** Updated forum mode keyboard interception (line 3307-3308) to use startsWith for kb_write and added kb_project_prefix handler
- **Files modified:** telegram-bot.js
- **Verification:** node -c passes, grep confirms prefix matching in forum code
- **Committed in:** a7d63ba (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Essential for consistency between direct mode and forum mode keyboard handling. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Persistent keyboard now reflects context dynamically
- Ready for Plan 05 (sendMessageDraft streaming migration)
- The _sendReplyKeyboard pattern is available for finalization in server.js TelegramProxy to refresh keyboard after Claude responses

## Self-Check: PASSED

---
*Phase: 02-ux-redesign*
*Completed: 2026-03-28*
