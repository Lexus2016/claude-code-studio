---
phase: 04-server-encapsulation
plan: 01
subsystem: architecture
tags: [encapsulation, telegram-bot, refactoring, public-api, factory-pattern]

# Dependency graph
requires:
  - phase: 03-forum-ux-extraction
    provides: TelegramBotForum extraction established composition facade pattern
provides:
  - TelegramProxy class relocated to telegram-bot.js (module-internal)
  - createResponseHandler() factory method on TelegramBot
  - Public wrappers sendMessage(), getContext(), escHtml(), t()
  - startThinking() method on TelegramProxy
  - Zero bot._* private method calls in server.js
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Factory method pattern for TelegramProxy creation (createResponseHandler)"
    - "Dependency injection of broadcastToSession callback into proxy"
    - "Public wrapper methods as module boundary API"

key-files:
  created: []
  modified:
    - telegram-bot.js
    - server.js

key-decisions:
  - "TelegramProxy moved inside telegram-bot.js rather than kept in server.js with facade — proxy is fundamentally bot-internal streaming infrastructure"
  - "broadcastToSession injected as callback parameter to maintain dependency inversion (server.js owns WebSocket broadcast)"
  - "startThinking() encapsulates thinking message logic inside proxy — eliminates proxy._usesDraftStreaming and proxy._progressMsgId access from server.js"
  - "task.userId used instead of task.proxy._userId — userId already stored at top level in activeTasks map"

patterns-established:
  - "Public API pattern: server.js interacts with TelegramBot only through public methods (createResponseHandler, sendMessage, getContext, escHtml, t)"
  - "db access in TelegramProxy via this._bot.db (public property) rather than bare module-scope variable"

requirements-completed: [ENC-01, ENC-02]

# Metrics
duration: 7min
completed: 2026-03-28
---

# Phase 4 Plan 1: Server Encapsulation Summary

**TelegramProxy relocated to telegram-bot.js with createResponseHandler() factory, 4 public wrappers, and zero bot._* calls remaining in server.js**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-28T21:23:17Z
- **Completed:** 2026-03-28T21:30:55Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Moved TelegramProxy class (~430 lines) from server.js into telegram-bot.js where it legitimately needs access to bot internals
- Exposed 5 public methods on TelegramBot: createResponseHandler(), sendMessage(), getContext(), escHtml(), t()
- Eliminated all 50+ bot._* private method calls from server.js (across processTelegramChat, _clearTelegramAskState, _attachTelegramListeners)
- Encapsulated thinking message logic into TelegramProxy.startThinking() method

## Task Commits

Each task was committed atomically:

1. **Task 1: Move TelegramProxy into telegram-bot.js and add public API** - `fec43ad` (feat)
2. **Task 2: Replace all bot._* calls in server.js with public API** - `b4e24d4` (refactor)

## Files Created/Modified
- `telegram-bot.js` - Added TelegramProxy class (relocated), createResponseHandler factory, sendMessage/getContext/escHtml/t public wrappers, startThinking method
- `server.js` - Removed TelegramProxy class + 3 orphaned constants, replaced all bot._*/telegramBot._* calls with public methods

## Decisions Made
- TelegramProxy moved inside telegram-bot.js rather than kept with facade -- proxy is bot-internal streaming infrastructure, not a server concern
- broadcastToSession injected as callback to maintain dependency inversion (server.js owns WS broadcast)
- startThinking() encapsulates thinking message logic inside proxy to eliminate proxy._usesDraftStreaming and proxy._progressMsgId access from server.js
- task.userId used instead of task.proxy._userId in _clearTelegramAskState -- userId already stored at top level in activeTasks

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Server encapsulation complete -- server.js has clean module boundary with telegram-bot.js
- All interactions go through 5 public methods (createResponseHandler, sendMessage, getContext, escHtml, t)
- No further phases planned in this milestone

---
*Phase: 04-server-encapsulation*
*Completed: 2026-03-28*
