# Fix queue — verification of 3680ad6 (`fix: restore busy spinners on background tabs after reload`)

Source: full pre-release verification of `3680ad6` (v7.2.3-1-g3680ad6). Verdict was NOT READY.

**Published to GitHub:** tracker [#37](https://github.com/Lexus2016/claude-code-studio/issues/37) · local #1 → [#28](https://github.com/Lexus2016/claude-code-studio/issues/28) · local #2 → [#29](https://github.com/Lexus2016/claude-code-studio/issues/29) · local #3 → [#30](https://github.com/Lexus2016/claude-code-studio/issues/30) · local #4 → [#31](https://github.com/Lexus2016/claude-code-studio/issues/31) · local #5 → [#32](https://github.com/Lexus2016/claude-code-studio/issues/32) · local #6 → [#33](https://github.com/Lexus2016/claude-code-studio/issues/33) · local #7 → [#34](https://github.com/Lexus2016/claude-code-studio/issues/34) · local #8 → [#35](https://github.com/Lexus2016/claude-code-studio/issues/35) · local #9 → [#36](https://github.com/Lexus2016/claude-code-studio/issues/36)

Blockers are #1 and #2. #3 and #4 should ship in the same release as #1.

| # | Title | Severity | Blocks release | Depends on |
|---|---|---|---|---|
| 1 | Background tab spinner never clears — `done` is unicast, never broadcast | critical | yes | — |
| 2 | `running-sessions` test silently PASSES against a foreign server on a busy port | critical | yes | — |
| 3 | `isChatRunning` disagrees with `/api/tasks/running-sessions` for ~10-20s | warning | ship with #1 | — |
| 4 | `running-sessions` test only catches a full revert of the union | warning | ship with #1 | #1, #3 |
| 5 | `server.js:4620` comment states a false invariant about `isChatRunning` | warning | no | #3 |
| 6 | One failed fetch in `subscribeAllTabs` cancels every background subscription | warning | no | — |
| 7 | Test cleanup does not run on SIGTERM — orphan server poisons later runs | warning | no | #2 |
| 8 | Endpoint can emit temporary tab ids that are not sessions | info | no | — |
| 9 | Chore batch: dedupe live-set logic, drop tautological assertion, doc drift | info | no | #3 |

---

## 1. Background tab spinner never clears — `done` is unicast, never broadcast

**Severity:** critical — blocks release
**Labels:** bug, websocket, ui, regression
**Introduced by:** 3680ad6

### Problem
`3680ad6` made `GET /api/tasks/running-sessions` report in-flight plain chats, so `subscribeAllTabs()`
now switches a background tab's busy dot ON. Nothing switches it OFF.

- `done`/`error` for a plain web chat are delivered only through the per-socket `WsProxy`
  (`server.js:8239`, `server.js:8257`; `WsProxy` at `server.js:1861`). There is no
  `broadcastToSession` on this path — unlike DB tasks (`server.js:1579`, `1596`, `1857`)
  and Telegram (`telegram-bot.js:3978`).
- Background tabs subscribe with `noCatchUp: true` (`public/index.html:6019`), and
  `activeTask.proxy.attach(ws)` sits inside `if (!noCatchUp)` (`server.js:8735`), so the
  new socket is never reattached.
- `subscribeAllTabs` only ever sets `tab.generating = true` (`public/index.html:6022`);
  there is no `else` branch, so the `visibilitychange` re-run (`public/index.html:6119`)
  cannot heal it either.

Net effect of the commit: "background tab under-reports work" was traded for
"background tab claims work is still running".

### Reproduction (verified)
Start a chat in tab A, switch to tab B, reload the page while A is mid-turn.
A's dot lights up correctly; the turn finishes; the dot keeps spinning for the whole page
lifetime. It clears only on clicking tab A (`loadSess` reconcile,
`public/index.html:11062-11067`) or on another reload (`restoreTab` hardcodes
`generating: false`, `public/index.html:14290`).

Harness output from the verification run:
```
in flight, running-sessions= [ 'mt1tvud50d4l8s' ]
after reload running-sessions= [ 'mt1tvud50d4l8s' ] -> client sets tab.generating=true: true
server says running-sessions= []                     <- turn finished
events received by the reloaded page: ["activity_dirty:"]
GOT done FOR BACKGROUND TAB? false
```
Also reproduces with **no reload at all**, from a second browser window.

### Suggested fix
Fan terminal events out to watchers next to the existing `proxy.send`, excluding the
originating socket so the owner does not get a duplicate `done` (which would double-fire
`_bgNotify` and `loadHist`):

```js
// server.js, next to :8239 and :8257
proxy.send({ type: 'done', ... });
broadcastToSessionExcept(effectiveTabId, proxy._ws, { type: 'done', tabId: effectiveTabId, ... });
```

Do **not** fix this by calling `proxy.attach(ws)` in the `noCatchUp` branch — `attach`
(`server.js:1875-1878`) flushes `_buffer` and would defeat the entire purpose of
`noCatchUp` (`public/index.html:5997`). If rebinding instead, rebind `_ws` and cancel
`cleanupTimer` **without** replaying the buffer. Do not fix it by polling
`/api/tasks/running-sessions` on an interval.

### Acceptance criteria
- [ ] A socket subscribed with `noCatchUp: true` receives exactly one `done` when a plain
      chat turn it watches finishes.
- [ ] The originating socket still receives exactly one `done` (no duplicate).
- [ ] Same for the `error` / AbortError path (`server.js:8257`).
- [ ] Integration test: two sockets, second subscribed with `noCatchUp:true`, asserts one
      `done` each and that the session disappears from `/api/tasks/running-sessions`.

### Note on disagreement
Two independent non-Claude advisors split on blocking-ness: one called it a release
blocker, the other called it cosmetic-and-recoverable-by-click and would ship the union
first with this as follow-up. Both agree on the mechanism and on the shape of the fix.

---

## 2. `running-sessions` test silently PASSES against a foreign server on a busy port

**Severity:** critical — blocks release (a green suite is not evidence until this is fixed)
**Labels:** bug, test-infra
**Introduced by:** 3680ad6

### Problem
`test/running-sessions.test.js:24` hardcodes `const PORT = 3995` with no env override and no
occupancy check. The readiness loop (`test/running-sessions.test.js:65-70`) only polls
`GET /api/health`, which is in `PUBLIC_PATHS` (`auth.js:172`) — so it cannot tell its own
server from somebody else's. The test's own server dies with `EADDRINUSE` (`server.listen`
at `server.js:9201` has no `'error'` handler), and `srvLog` is printed only in the `!up`
branch, so the stack trace is swallowed.

Result: the whole test runs against the foreign server and prints
```
5 passed, 0 failed
```
in 0.37s. The throwaway `APP_DIR` / `HOME` isolation is bypassed entirely.

Worst case, confirmed against a decoy instance: the occupying server resolved the **real**
`/opt/homebrew/bin/claude` (its own `HOME`) and wrote an assistant turn into its own
`chats.db`. On a logged-in machine that is a billed turn written into the developer's real
database.

### Suggested fix
Any one of, preferably the first two together:
- `const PORT = Number(process.env.TEST_PORT || 3995)`.
- Preflight bail-out: `net.createServer().listen(PORT)` and abort with an actionable
  message if the port is taken.
- Or: bind port 0 in the child and read the actual port from the server's stdout banner.
- Or: have `/api/health` echo a per-process nonce (`process.env.CCS_HEALTH_NONCE`) and make
  the readiness loop verify it.

Consider adding an `'error'` handler to `server.listen` (`server.js:9201`) so `EADDRINUSE`
prints one clear line instead of an unhandled `'error'` event.

### Acceptance criteria
- [ ] With another CCS instance already on the port, the test fails with a message that
      names the port collision — it never reports PASS.
- [ ] The test never creates a session in a database it did not create.

---

## 3. `isChatRunning` disagrees with `/api/tasks/running-sessions` for ~10-20s

**Severity:** warning — should ship in the same release as #1
**Labels:** bug, api-consistency, regression
**Introduced by:** 3680ad6 (made the divergent branch reachable)

### Problem
`server.js:5468` is `s.isChatRunning = activeTasks.has(req.params.id)` — `activeTasks` only.
The new endpoint additionally unions `activeChatSessions` (`server.js:4626`). Between
`activeChatSessions.add` (`server.js:7861`, migrated at `7959`) and `activeTasks.set`
(`server.js:8138`) sits `await classifyTask(...)` (`server.js:8026`, in-code comment:
"~10-15s via CLI", only when `autoSkill && !localClaudeId`).

Measured window with a fake `claude` (`sleep 20`) and `autoSkill:true`:
```
t+3.0s  runningSessions=true isChatRunning=false hasRunningTask=false activityLive=false
t+18.0s runningSessions=true isChatRunning=false hasRunningTask=false activityLive=false
t+20.0s runningSessions=true isChatRunning=true  hasRunningTask=false activityLive=true
```

Effect: `subscribeAllTabs` lights the dot; if the user opens that tab inside the window,
`loadSess` sees `isChatRunning:false, hasRunningTask:false` and runs
`public/index.html:11064-11067` → `generating=false; done=true; setSendStop(false)`.
The UI shows a done-checkmark and swaps Stop back to Send while the turn is live.
Unreachable before `3680ad6`, because `tab.generating` was never true for a background tab.

`GET /api/sessions/:id` is the only outlier in the file: `/api/sessions/:id/catch-up`
(`server.js:5706`) and `processTelegramChat` (`server.js:6441`) already use the union, and
the latter's comment literally documents why ("activeChatSessions covers the early phase of
web processChat before activeTasks.set() is called").

### Suggested fix
Widen, do not narrow. Both advisors agreed independently:

```js
// server.js:5468
s.isChatRunning = isSessionLive(req.params.id);
// helper used by 4623-4629, 5468, 5706, 6441
const isSessionLive = id => activeTasks.has(id) || activeChatSessions.has(id);
```

Stronger alternative (one advisor's preference): register in `activeTasks` right after the
`AbortController` is created, **before** `await classifyTask()`, so reattach, Stop and
`isChatRunning` all share one source of truth. If taking the minimal path instead, also
make sure `subscribe_session` does not emit `task_interrupted` when the session is in
`activeChatSessions` (`server.js:8692-8708`).

### Consumers verified — widening only makes each more conservative
`public/index.html:9159` (hide compact button), `11062` (the reconcile in question),
`11156` (suppress done checkmark), `11165` (suppress "Execute Plan"), `11176` (suppress
"Restart Session"), `11219` (build the streaming bubble), `11277` (skip a spurious
`resume_task`). No server-side consumer of the `isChatRunning` JSON field exists.

### Acceptance criteria
- [ ] `GET /api/sessions/:id` reports `isChatRunning: true` during the classification window.
- [ ] Regression test with `autoSkill:true` and a slow classifier asserts
      `running-sessions` and `isChatRunning` agree at every sampled point of a turn.

---

## 4. `running-sessions` test only catches a full revert of the union

**Severity:** warning — should ship with #1
**Labels:** test-coverage
**Depends on:** #1, #3

### Problem
The commit message claims "Verified by mutation — dropping the union fails the test".
That is true only for the union as a whole. Measured mutation matrix (real runs, three
independent verifications agreeing):

| mutation | result |
|---|---|
| drop the DB query (`server.js:4625`) | 5 passed — not caught |
| drop `activeChatSessions` (`server.js:4626`) | 5 passed — not caught |
| drop `activeTasks` (`server.js:4627`) | 5 passed — not caught |
| full revert to the DB-only body | 4 passed, **1 failed** — caught |

The cause is structural: the assertion is gated on `/api/activity` reporting the session
live (`test/running-sessions.test.js:91-97`), and `/api/activity` derives `live` from
`activeTasks` only (`server.js:4658`) — i.e. the gate deliberately waits past the exact
window `activeChatSessions` exists to cover.

### Suggested fix — add these cases
- [ ] Insert a `tasks` row with `status='in_progress'` and assert its `session_id` is still
      reported (guards the DB term; today its removal silently breaks kanban/scheduler
      spinner restore).
- [ ] Send with `autoSkill:true` against a slow classifier and assert the session is
      reported **before** `/api/activity` goes live (guards the `activeChatSessions` term).
- [ ] Assert the id **disappears** from `running-sessions` after the turn ends —
      this assertion is what would naturally have surfaced issue #1.
- [ ] A Telegram-origin turn is reported (guards the `activeTasks` term, whose sole
      non-redundant producer is `server.js:6494`).

### Acceptance criteria
- [ ] Each of the three union terms, removed individually, fails at least one assertion.

---

## 5. `server.js:4620` comment states a false invariant

**Severity:** warning
**Labels:** docs
**Depends on:** #3 (fix the code first, then the comment describes reality)

`server.js:4620` reads:
```
// The union must match isChatRunning (activeChatSessions || activeTasks) plus the DB:
```
`isChatRunning` (`server.js:5468`) is `activeTasks` only. The `activeChatSessions || activeTasks`
pattern lives at `server.js:5706` and `server.js:6441`, not there. The same wording is
repeated in the commit message and in `test/running-sessions.test.js:7`.

If #3 is accepted the comment becomes true as written once `5468` is widened — otherwise it
must be reworded to say the endpoint is a deliberate **superset** of `isChatRunning`.

- [ ] Comment matches the code after #3 lands.
- [ ] `test/running-sessions.test.js:7` header updated to match.

Related nit, same commit: the header says "Returns session IDs", but the set can transiently
hold a temp tab id — see #8.

---

## 6. One failed fetch in `subscribeAllTabs` cancels every background subscription

**Severity:** warning
**Labels:** bug, ui, resilience
**Pre-existing**, but `3680ad6` makes this path load-bearing.

`public/index.html:6006` is the first statement inside the `try`. If the endpoint 500s
(e.g. `db.prepare` throwing during shutdown — Express 4 turns it into an HTML 500 at
`server.js:9097`, so `.json()` rejects), or the token expired (401), or the network blips,
the `catch` at `public/index.html:6030` skips the entire loop below it — **no
`subscribe_session` is sent for any tab**, and the page receives zero background events
until the next `visibilitychange`.

### Suggested fix
```js
let runningSet = new Set();
try { runningSet = new Set(await (await fetch('/api/tasks/running-sessions')).json()); }
catch (e) { console.error('running-sessions:', e); }
// subscribe loop runs unconditionally below
```

- [ ] With the endpoint returning 500, every open tab still gets its `subscribe_session`.

---

## 7. Test cleanup does not run on SIGTERM — orphan server poisons later runs

**Severity:** warning
**Labels:** test-infra
**Related:** #2 (together these form a self-sustaining trap)

`test/running-sessions.test.js:52` registers `process.on('exit', cleanup)`. That handler does
not fire on SIGTERM. Verified: on SIGTERM to the parent, the spawned server survives.
So `kill <testpid>`, a cancelled CI job, or a `timeout` wrapper leaves an orphaned
`node server.js` on port 3995 plus two temp directories — and per #2 every later run then
silently "passes" against that orphan.

Ctrl-C is not affected (SIGINT goes to the whole foreground process group, so the child
reaches `gracefulShutdown` at `server.js:9264`). The thrown-assertion path is covered by the
trailing `.catch`.

### Suggested fix
```js
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => { cleanup(); process.exit(1); });
```

- [ ] `kill <testpid>` leaves no `node server.js` process and no temp directory behind.

Minor, same file: `cleanup()` removes `APP_DIR` immediately after SIGTERM while the server
is still in `db.pragma('optimize'); db.close()` (`server.js:9256-9257`, not wrapped in
try/catch). Harmless on POSIX; a short `await` before `rmSync` would be tidier.

---

## 8. Endpoint can emit temporary tab ids that are not sessions

**Severity:** info
**Labels:** api-contract

`server.js:7861` puts the raw client-supplied `msg.tabId` (format `new-<Date.now()>`,
`public/index.html:9397`) into `activeChatSessions`; it is migrated to the real session id at
`server.js:7959`. Between those points `/api/tasks/running-sessions` can return a string that
is not in `sessions`. Harmless today only because `subscribeAllTabs` skips `tab.isNew`
(`public/index.html:6017`) — an accidental invariant. Any future consumer joining the result
against `sessions.id` will silently miss.

### Options
- Filter with `stmts.getSession.get(id)` before emitting, or
- add to `activeChatSessions` only post-migration, or
- document the contract explicitly as "session ids, plus transient tab ids".

- [ ] Contract is either enforced or documented; no silent third state.

---

## 9. Chore batch

**Severity:** info
**Labels:** chore, tech-debt
**Depends on:** #3

- [ ] Dedupe the live-set logic — it now exists in three places: `server.js:4625-4627`
      (this commit), `server.js:4658` (`/api/activity`), `server.js:5706` (catch-up).
      Fold into the `isSessionLive(id)` helper from #3.
- [ ] Drop the tautological assertion `test/running-sessions.test.js:100-101`
      (`arr.length === new Set(arr).size`) — the handler builds a `Set`, so it cannot fail
      under any implementation, old or new. Replace with a real invariant.
- [ ] `server.js:4625` inlines `db.prepare(...)` per request while the rest of the file uses
      cached `stmts.*`. Negligible at this call rate, but inconsistent.

### Out of scope of `3680ad6` — found during verification, file separately if wanted
- `test/update-flow.test.js:86` — the only test with no cleanup; leaks ~2 empty temp dirs
  per run.
- `CLAUDE.md` describes the suite as "a render + overload-detector test suite" while
  `npm test` now chains 15 entries.
- `test/bots-api.test.js:4` says "Not part of `npm test`" — it is part of `npm test`.
- `.claude/pending/ee2c19d0….json` — stale editor blob containing a stub of this route.
- `noCatchUp` skipping `proxy.attach` means a background plain chat never cancels
  `TASK_DISCONNECT_TIMEOUT_MS` (`server.js:9025-9030`); at the 30-min default the server
  aborts a turn the spinner still shows as live. Pre-existing; #1 fixes the visible half.
