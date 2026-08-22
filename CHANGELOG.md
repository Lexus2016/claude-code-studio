# Changelog

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
