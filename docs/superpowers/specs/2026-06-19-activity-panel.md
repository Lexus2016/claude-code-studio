# Activity Panel / Mini-Navigator — As-Built Spec

> Status: **IMPLEMENTED (uncommitted)** 2026-06-19 · Web UI only (v1)
> Brainstormed + peer-reviewed (Gemini `agy` + Kimi `hermes`) before build.

## Goal
One place in the web UI to see **what is running right now** across all projects
(including scheduler-launched runs) and **switch to it in ≤2 clicks**. Plus the
upcoming schedule and recently-finished sessions.

## Decisions (locked with the user)
- **Surface:** Web UI first (`public/index.html`). Backend kept generic so a Telegram
  surface can reuse it later.
- **Depth:** LIVE (all active) + SCHEDULED (queue) + RECENT (≤20 finished).
- **Grouping:** toggle — group-by-project ↔ flat list (persisted in `localStorage`).
- **Approach A** (collapsible sidebar section) — both advisors picked it over a
  dedicated screen (B, breaks the ≤2-click flow) and the command palette (C, deferred
  to a possible phase 2).

## Architecture

### Backend (`server.js`)
- **`GET /api/activity`** → `{ live[], scheduled[], recent[] }`.
  - `live` = in-memory `activeTasks` (web/telegram chats) **UNION** DB
    `tasks.status='in_progress'` (scheduler/kanban). Precedence `activeTasks > task`.
    A task that is `in_progress` in the DB but has **no live worker**
    (`taskRunning`/`independentRunning`) is flagged **`status:'recovering'`** instead of
    being shown as a healthy run — this is the post-restart reconciliation both
    advisors flagged as pitfall #1.
  - `scheduled` = `tasks` with `status='todo' AND scheduled_at IS NOT NULL` (≤50).
  - `recent` = sessions by `updated_at DESC`, excluding anything currently live (≤20).
  - **Project resolved server-side** from `workdir` → `projects.json` (`project_id` /
    `project_name`). The client never parses paths (advisor pitfall: Windows/POSIX/SSH).
- **`markActivityDirty()`** — debounced ~400 ms; broadcasts a lightweight
  `{type:'activity_dirty'}` to **all** `wss.clients`. Hooked at 6 lifecycle points:
  web chat start/end, telegram chat start/end, task start/end. Cleanup/orphan delete
  sites are intentionally **not** hooked — the client reconciliation poll heals them.

### Frontend (`public/index.html`)
- Collapsible **"⚡ Активність"** section pinned at the **top of the left sidebar**
  (first `.sec` inside `.left-inner`), reusing the existing `toggleSec` / `.sec` pattern.
- Three sub-sections (🟢 Активні / ⏰ Заплановані / 🕘 Нещодавні), a group-mode toggle
  button, and a live-count badge.
- Data flow: `loadActivity()` on WS connect (`ws.onopen`) + on `activity_dirty` +
  a **visible-only reconciliation poll every 12 s** (backstop for missed signals).
  Concurrent fetches are coalesced (`_activityFetching` guard).
- Live elapsed timers tick client-side every 1 s without refetching.
- **Click → switch:** `activityOpen(sessionId, projectId)` calls `switchProject()` if
  the row belongs to another project, then `openTab()` (the same path history items use).
- Rendering only ever rewrites `#activityList` (diff-render of one section, per advisors).

## Verification
- `GET /api/activity` exercised against a live server (real data): correct shape, a live
  scheduler task detected, recent sessions with resolved project names + source labels.
- `node scripts/check-inline-scripts.mjs` — all inline `<script>` blocks parse.
- `node test/render/activity.test.mjs` — flat/grouped/empty render, html-escaping,
  clickability, `recovering` state, recurrence marker, badge count. Existing render
  suite still green (no regression).

## Known limitations / deferred
- Fully localized: `act.*` keys added to all 3 locales (uk/en/ru); static HTML via
  `data-i18n`/`data-i18n-title`, dynamic strings via `t()`; `setLang()` re-renders the
  panel so a language switch applies instantly (dates use the active locale too).
- Telegram surface, `Cmd/K` command palette: out of scope for v1.
- No DB schema change (all data already present).

## Files touched (this feature only)
- `server.js` — `/api/activity` route, `markActivityDirty()`, 6 lifecycle hooks.
- `public/index.html` — sidebar section + CSS + JS module + WS case + onopen call.
- `test/render/activity.test.mjs` (new), `scripts/check-inline-scripts.mjs` (new).

> NOTE: not committed — the working tree already contained unrelated in-progress edits
> (scheduler recurrence grammar; msg/status-pill tweaks) in `server.js`/`index.html`.
> Left for the user to review and commit so unrelated work isn't bundled in.

## Audit refinements (self-review rounds)
- **UTC fix:** `updated_at` is SQLite `datetime('now')` (UTC, space-form); the browser
  parsed it as local → tz-skewed "ago". Added `_actTs()` to force UTC; unit-tested
  tz-independently.
- **No-flicker poll:** dropped `ts` from the response and added an unchanged-payload
  guard in `loadActivity()` so the 12 s poll only re-renders on real change (live
  timers tick via a separate 1 s interval, unaffected).
- **localStorage hardened:** `actGroup` read/write wrapped in try/catch (matches
  `setEffort`), so the module can't fail init where storage is unavailable.
- **Live-browser render:** could NOT be verified in this environment — Playwright here
  blocks `file://` and cannot reach host `localhost`. Logic is covered by the render
  unit tests + a full inline-script syntax gate; final visual check is on the user.

