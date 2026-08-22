# Changelog

## 7.5.4

**Tasks now run on remote SSH projects** (#53). `runSshSingle()` was reachable from the
chat and Telegram paths only, so a task on a remote project fell through to the local
CLI with a working directory that lives on another machine — on Windows, Node resolves
a POSIX-absolute cwd against the current drive and the agent started in `C:\home\...`.
That is the whole of the reporter's original symptom: a run sent to the wrong machine,
not a path mangled by one function.

`ClaudeSSH` exposes the same `send()` surface as `ClaudeCLI`, so the task loop is
unchanged. One entry point covers everything: `startTask()` is called only from
`processQueue()`, which drives the Kanban board, scheduled tasks, recurring tasks and
chains alike.

Three things do not cross the wire, and each degrades rather than breaks:

- `mcpServers` — the remote `claude` uses whatever MCP config it has of its own;
- the interrupt hook, whose callback is `127.0.0.1` and unreachable from the remote
  host, so a mid-run clarification arrives after the turn instead of during it. The SSH
  **chat** path has always had this same limitation;
- `worker_pid` — there is no local process to record, so restart-recovery cannot reap an
  orphan. The abort controller still stops the run in-process.

7.5.2's blanket refusal of such tasks is removed; it was a stopgap to stop the studio
running an agent in the wrong tree, and is no longer needed.


## 7.5.3

Four fixes, each proved by reverting it and watching a new test fail.

- **A session sometimes failed to finish restoring, and the composer was left
  unusable.** One cause, two symptoms. Function declarations hoist only within their
  own `<script>` block; `isEnginePaneId()` lived in the terminal block at the bottom of
  the file while `loadSess()` — which calls it on every session open — is reached from
  `ws.onopen`. A WebSocket opens in milliseconds; parsing several thousand more lines
  does not. Losing that race threw `ReferenceError: isEnginePaneId is not defined` and
  aborted `loadSess` mid-way, which also left the composer at `height: 0px` so its
  placeholder rendered a line below the box until the first keystroke.
- **The cursor landed a line low after switching projects.** Switching re-attaches, and
  every re-attach repaints from a `capture-pane` snapshot — which emits every row
  terminated by a newline, including the last. One newline too many pushed the cursor
  past the final row and scrolled the view. The snapshot also carried no cursor
  information at all; it now ends with an explicit CUP built from tmux's own
  `#{cursor_y}`/`#{cursor_x}`.
- **A split terminal still looked collapsed.** 7.5.0 stopped the real corruption — a
  control client receives output for every pane, so a split window had several TUIs
  writing into one buffer — but the visible symptom survived, because the font helper
  clamped with `Math.min(base, …)` and could only ever shrink. Right for the engine
  pane, which is spawned at 220 columns; useless for a pane measured live at 41 columns
  beside five agent-team panes. Growth is now opt-in per caller and bounded.
- **A task on a remote SSH project is refused instead of run locally.** `runSshSingle()`
  is wired into the chat and Telegram paths only; the task runner has no SSH branch, so
  it spawned the local agent with a path that lives on another machine. Deliberately a
  refusal, not an implementation: `ClaudeSSH` supports neither `mcpServers` nor
  `extraEnv`/`extraSettings`, all of which that loop passes.


## 7.5.2

Follow-up to #53. The 7.5.0 fix stopped the *guard* from mangling a remote workdir;
it did not stop a run from being routed **locally** with that workdir, which is the
same `C:` prefix arriving by a different road — and by making the guard accept the
path, 7.5.0 turned a loud refusal into a quieter misroute.

- **One lookup for "is this workdir a remote project".** It was written out three
  times with exact string equality — the workdir guard, the chat router and the
  Telegram router — and all three had to agree or a run the guard accepted could
  still be sent to the local CLI. A trailing slash is now normalised away, since it
  is the one difference a UI can introduce without the user ever seeing it.
- **A POSIX-absolute cwd is refused on Windows.** Node resolves such a cwd against
  the current drive, so `/home/user/project` starts the child process in
  `C:\home\user\project` — a directory unrelated to the user's project, silently.
  The router decides local vs SSH; this is the backstop for when it gets that wrong,
  because failing loudly beats running an agent in the wrong tree.


## 7.5.1

- **The updater no longer offers an update it cannot install.** `brew` owns
  `/Applications` and nothing else, so a build running from anywhere else — a
  `dist-desktop/` artefact left by `npm run dist`, an .app copied to Downloads —
  could never be upgraded by `brew upgrade --cask`. It read the tap cask, offered the
  newer version, ran brew (which correctly upgraded the bundle in `/Applications`),
  relaunched *itself* at its own old version, saw the cask was newer again, and
  repeated. Observed as a 7.1.1 build offering 7.5.0 on a loop while `/Applications`
  was already 7.5.0 and `update.log` showed a single clean `OK 7.4.0 -> 7.5.0`.
  Such a build is now reported as unmanaged instead of being sent round the loop.


## 7.5.0

A verification release. A static audit of the chat, agent-data-flow and
agent-control subsystems was checked claim by claim against the code; four of its
findings did not survive, and six defects it never mentioned did. An adversarial
two-model review of the resulting commit then found five more. Every fix below
was proved by reverting it and watching a new test fail.

53 test files, 1535 assertions.

### Fixed — data loss and wrong results

- **A dispatched plan lost its dependencies.** `depends_on` was stripped from the
  `agent_plan` payload, and the "Kanban" button echoes that exact payload back.
  Every planned chain dispatched as independent tasks running concurrently: a plan
  of "migrate the schema, then backfill it" ran both at once.
- **A failed agent's warning never reached the agent that depended on it.** The
  "did not finish" notice was appended to text that dependents read through a
  2000-character head. Any agent over that cap handed downstream truncated work
  with no sign it was truncated, and the summary reported success.
- **A Kanban task and a chat could hold one session at once** — two
  `claude --resume <same id>` appending to one transcript, or two pastes into one
  tmux pane. Task liveness lives only in the database, which the session gate did
  not consult. Neither did the queue-dequeue path.
- **Remote SSH sessions were unusable from Windows** (#53). A remote workdir went
  through the local path module: `path.resolve('/home/user/project')` prepends the
  drive, so the guard saw `C:\home\user\project`, refused every remote session, and
  the mangled path reached the remote shell as `cd C:/home/user/project`.
- **A remote stream that closed mid-line wrote raw JSON into the chat history**, and
  a buffer overflow discarded the completed events queued in front of the oversized
  line. Both guards existed in the local CLI path and had never been ported.

### Fixed — the terminal

- **A split window no longer collapses into a strip.** A tmux control client receives
  output for *every* pane in its session; the bridge stripped the pane id and merged
  them all into one browser terminal. Once Claude Code's agent-teams split the window,
  four TUIs were writing into one screen buffer, each addressing its own pane's
  coordinates. A viewer is now pinned to the pane it opened — splitting makes the new
  pane active, so following the active pane would have moved the user onto a teammate —
  and the browser is told the pane geometry so it scales its font instead of proposing
  a resize tmux must refuse.

### Fixed — the renderer

- **Any output containing raw control bytes killed the whole message list.** A `cat` of
  a binary file or a hexdump in a tool result could forge the renderer's internal
  placeholder token, throwing an uncaught `TypeError` out of `renderMd`; every call
  site is a bare `innerHTML = renderMd(...)`, so the history loop aborted.
- **A 168 KB pipe-heavy line froze the UI for 7.4 seconds**, re-run every 100 ms while
  the message streamed. An unanchored nested quantifier was quadratic. Now 29 ms.
  Note the trade: an inline table header of 41+ columns is no longer split out of its
  sentence.
- **Two tables separated by a blank line merged into one**, rendering the second one's
  header and separator as data cells; and `\|` — the ordinary way to write `string \| null`
  in a docs table — tore the cell in two.

### Changed

- Multi-agent plans are capped (`MULTI_AGENT_MAX_PLAN`, default 8) and waves run through
  a semaphore (`MULTI_AGENT_CONCURRENCY`, default 3). Previously a 20-agent plan spawned
  20 concurrent `claude` subprocesses. Plans are sanitised on both the chat and dispatch
  paths: duplicate ids are dropped (they masked self-cycles), and self- and ghost
  dependencies are removed rather than stalling the entire plan as "circular".
- `dispatch_plan` uses the same scheduler as the chat path. Its private cycle check
  disagreed on exactly one input — a dependency naming an id not in the plan — letting
  through a plan the chat path refuses.
- A subscription turn arms its transcript cursor *before* the turn, so a crash on a
  session's first subscription turn is recoverable instead of silently discarded.
- Shutdown aborts Kanban workers and waits out the SIGTERM→SIGKILL escalation instead
  of exiting into it.
- `taskkill` moves off `execSync` (from #52; the other two hunks in that PR were declined —
  the hash is hex by construction and stripping it invites collisions in a file holding
  secrets, and replacing `path.join` with concatenation loses normalisation).

### Not fixed, on purpose

The audit also reported that a crash mid-turn loses streamed text, and that the
interactive engine's MCP config write is unsafe. Neither reproduced: `partial_text` is
written every five chunks and rendered with an "interrupted" badge, and the config
filename is a content hash containing per-process secrets, which makes a stale or
squatted file impossible.

Seeing every agent-team pane at once — rather than the one you opened — remains open.
