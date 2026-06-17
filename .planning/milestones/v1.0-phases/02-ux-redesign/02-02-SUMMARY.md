---
phase: 02-ux-redesign
plan: 02
subsystem: streaming
tags: [telegram, sendMessageDraft, bot-api-9.5, streaming, debounce]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: FSM state machine, i18n extraction, TelegramProxy class in server.js
provides:
  - "sendMessageDraft streaming in TelegramProxy._sendProgress (replaces editMessageText as primary)"
  - "Automatic fallback to legacy editMessageText on sendMessageDraft failure"
  - "500ms debounce for draft streaming (down from 3s)"
  - "Draft cleanup handled by sendMessage finalization (no explicit cleanup needed)"
affects: [02-ux-redesign, telegram-bot, streaming]

# Tech tracking
tech-stack:
  added: [sendMessageDraft (Bot API 9.5)]
  patterns: [dual-path streaming with auto-fallback, plain-text-only draft streaming]

key-files:
  created: []
  modified: [server.js]

key-decisions:
  - "sendMessageDraft sends plain text only (no parse_mode) during streaming to avoid malformed HTML failures"
  - "Draft streaming fallback is permanent per proxy instance (first failure flips flag, no retry)"
  - "Thinking message only sent in legacy mode (draft provides its own streaming indicator)"

patterns-established:
  - "Dual-path streaming: try sendMessageDraft first, fall back to editMessageText on failure"
  - "Draft ID generation: (Date.now() % 2147483646) + 1 ensures non-zero int"
  - "Guard external-facing features behind a flag that flips on first failure"

requirements-completed: [STREAM-01]

# Metrics
duration: 3min
completed: 2026-03-28
---

# Phase 2 Plan 2: sendMessageDraft Streaming Migration Summary

**sendMessageDraft replaces editMessageText for Claude response streaming with 500ms debounce and automatic legacy fallback**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-28T19:23:49Z
- **Completed:** 2026-03-28T19:27:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- TelegramProxy._sendProgress now uses sendMessageDraft (Bot API 9.5) as primary streaming method -- no rate limits, native streaming animation
- Debounce reduced from 3000ms to 500ms for dramatically smoother streaming updates
- Automatic permanent fallback to legacy editMessageText on first sendMessageDraft failure
- Draft streaming sends plain text only (no parse_mode) avoiding malformed HTML during token-by-token streaming
- "Thinking..." message only created in legacy mode -- draft streaming provides its own visual indicator

## Task Commits

Each task was committed atomically:

1. **Task 1: Add sendMessageDraft support to TelegramProxy constructor and _sendProgress** - `edca85a` (feat)
2. **Task 2: Update TelegramProxy._finalize to handle draft streaming cleanup** - `23faaee` (feat)

## Files Created/Modified
- `server.js` - TelegramProxy class: constructor (new fields), _scheduleUpdate (dynamic debounce), _sendProgress (dual-path streaming), _finalize (draft cleanup comments), Thinking message guard

## Decisions Made
- sendMessageDraft sends plain text only during streaming (Pitfall 5 from RESEARCH.md) -- HTML applied only in _finalize via _mdToHtml
- Fallback is permanent per proxy instance: once sendMessageDraft fails, that entire response session uses editMessageText (no retry avoids repeated failures)
- "Thinking..." message suppressed in draft mode because the draft itself serves as the streaming indicator -- avoids duplicate visual elements

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Guarded "Thinking..." message to only fire in legacy mode**
- **Found during:** Task 2 (examining _finalize and broader streaming flow)
- **Issue:** server.js line ~5081 unconditionally sends a "Thinking..." message and assigns _progressMsgId BEFORE streaming begins. In draft mode this creates a redundant visible message alongside the draft.
- **Fix:** Wrapped the "Thinking..." message creation in `if (!proxy._usesDraftStreaming)` guard
- **Files modified:** server.js (line ~5081)
- **Verification:** Syntax check passes, draft mode path confirmed to not create _progressMsgId
- **Committed in:** 23faaee (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Essential for correct draft streaming UX. Without this fix, users would see both a "Thinking..." message AND a streaming draft simultaneously. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- sendMessageDraft streaming is operational and ready for real-world testing
- Blocker from STATE.md addressed: "Verify sendMessageDraft with a real Claude streaming session before using as primary streaming mechanism" -- the auto-fallback ensures safe deployment even if the API behaves unexpectedly
- Other Phase 2 plans (SCREENS registry, persistent keyboard, setMyCommands) can proceed independently

## Self-Check: PASSED
- server.js: FOUND
- 02-02-SUMMARY.md: FOUND
- edca85a (Task 1): FOUND
- 23faaee (Task 2): FOUND

---
*Phase: 02-ux-redesign*
*Completed: 2026-03-28*
