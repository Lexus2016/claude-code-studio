# Changelog

## 7.11.0

Desktop builds get their MCP helpers back — every `_ccs_*` tool was silently
missing from every desktop turn in 7.10.0 — and worktree isolation ships, giving
each session and task its own git worktree and branch.

### Desktop: every `_ccs_*` MCP helper was missing (affects 7.10.0)

- In an Electron build the helper scripts resolve inside `app.asar`, which cannot
  be read as a directory, so `ask_user`, `notify_user`, `set_ui_state` and
  `check_user_messages` failed to spawn — **silently**, on every desktop turn.
  `helperPath()` redirects to the `app.asar.unpacked` copy that electron-builder
  already writes. A no-op in web and Docker mode, where no path contains
  `app.asar`. Anything a helper `require`s has to be unpacked too, or it fails one
  level deeper.

### Worktree isolation

- Each session and task gets its own git worktree and branch, so two units of
  work in one project no longer share a working copy. New endpoints:
  `/api/sessions/:id/git-status`, `/git-commit`, `/git-merge`.
- **It bootstraps on a machine with no git identity.** `git` only invents a
  `user@host` author when the hostname allows it; a container or a CI runner
  refuses with *"Author identity unknown"*, and because the bootstrap runs inside
  `POST /api/tasks` that failure took the whole request down with it. The project's
  own Docker image is such a machine. A fallback author is supplied — and only
  when there is nothing to override, so a commit in your own project stays yours.
  This covers `commitAll()` and the `--no-ff` merge as well, both of which write
  commits, and treats an explicitly empty `user.email` as absent rather than as an
  identity.
- Four defects found in review before release: the chat started a new session on
  the second message (the reuse check compared the worktree path instead of the
  project root, losing history and `--resume`); the file browser answered 403 for
  an isolated session, which also unset the project highlight, its bots and its
  chat defaults; a fork pointed two conversations at one directory and one branch;
  and MCP `create_task` / `create_chain` handed the caller's own worktree down to
  the child.
- **Known limit:** isolation reaches the chat, `POST /api/tasks`,
  `POST /api/sessions` and fork. Telegram, the scheduler, the chain runner and the
  MCP creators still create rows without a worktree, so a project can hold both
  isolated and non-isolated units at once.
- A worktree failure now logs its reason, including git's own stderr, before it
  propagates — the absence of that is what made the first attempt at this feature
  look like an unknown regression.

## 7.10.0

A turn that walked away from a background job now finishes the work instead of
printing "Done" over it; a terminal pane that loses its socket reconnects when you
touch it instead of staying dead until a page reload; and an `error_max_turns` that
did not come from this chat's budget is named as such rather than sending the user to
the wrong dial. Plus a split tmux window that is composited rather than cropped, a
paste button that stopped pasting twice, corrected toolbar tooltips, an Electron
popup that no longer escapes the window-open policy.

### A turn that strands a background task is not a finished turn

- **The gap: `subtype:'success'` is the one rung the auto-continue ladder does not
  cover.** A run that started something with `run_in_background` and then ended its
  turn saying it would wait and continue reports a clean `end_turn`. Nothing resumes
  a headless `claude -p` — the process exits and takes the background shell with it —
  so the chat printed `✅ Done` over work that had not happened, and the promised
  continuation could never arrive.
- **Detection is structural, never textual.** A `Bash` call carrying
  `run_in_background` is the same JSON on every install; user-facing prose is written
  in the UI language, so a regex over English phrases like "I'll check back" is dead
  on a French or Ukrainian one. The flag is read off a parsed object, so a foreground
  `grep '"run_in_background": true'` is not mistaken for a launch.
- **The debt is incremental and counted across the whole turn.** An agent that starts a
  background job and collects it inside the same turn — exactly what the new
  system-prompt rule asks for — is not charged a rescue run. The harvest side matches a
  `Read`/`View` of the `tasks/<id>.output` file the CLI actually writes, not just a
  `BashOutput` call: measured on 2.1.231, `BashOutput` is never called. A harvest pays
  down only a debt that already exists, once per shell id — so reading a leftover log
  from an earlier turn cannot pay for a launch that comes afterwards, and polling one
  job twice cannot cancel a second job that really was abandoned.
- **One harvest run, and an honest ending if it is not enough.** When even the rescue
  run walks away, the turn says how many tasks were left running, as a real `---` status
  line so the SPA does not stamp its own "Done" badge over the warning.
- **The system prompt states the constraint up front** — collect a background job's
  result inside the same turn, because there is no later moment in which to get it.
  The rescue is the second line of defence, not the first.
- **Kanban/scheduled tasks, multi-agent members and bots get that instruction too**,
  each through the channel that actually reaches it. `--system-prompt` is dropped
  whenever there is a session to resume, and is absent entirely for a task with no bot —
  so for a multi-agent worker, a bot with a live session, and every Kanban task, the
  instruction rides the user turn instead. An unattended task that walks away from a
  background job is the worst version of this bug — nobody is reading that chat to
  notice. Riding the user turn also covers a Kanban task on the `subscription` engine
  for free: it passes no system prompt at all, but its prompt is typed into the tmux
  pane like any other.
- **Known limit:** a process backgrounded with shell syntax (`cmd &`, `nohup`) inside a
  foreground `Bash` call is not detected — separating that from `a && b` and `2>&1`
  needs a shell parser. The system-prompt rule covers it in words.

### An `error_max_turns` that is not ours says so (#67 follow-up)

- **"Raise Max turns" is wrong advice when that is not the cap being hit.** Measured
  against CLI 2.1.231, a run capped at N reports `num_turns === N + 1`, so a genuine
  exhaustion lands AT the cap. A stop at 3 turns against a 50-turn dial is a limit
  imposed somewhere else — a different CLI version, a `settings.json`, a hook on the
  machine the agent runs on — and the message now says that instead, on the FIRST
  retry notice rather than only after all three are spent.
- **The remote auto-continue notice names the budget and what was spent.** The local
  CLI loop has done this since it was written; the SSH one said only "resuming on
  remote", which is why diagnosing the report needed a round trip.
- **The SSH auto-continue path logs.** It previously logged nothing at all, on either
  the max-turns or the non-success branch.

### A terminal pane that loses its socket now reconnects when you touch it

- **Typing into a dead pane was a silent drain.** `term.onData` guarded on
  `readyState === 1` and did nothing else, so every keystroke vanished with no
  reconnect and no sign anything was wrong. xterm renders locally, so the pane looked
  alive — that is the "terminal freezes until I reload the browser" report.
- **Paste and the send line named the problem and did nothing about it.** Both toasted
  "Terminal is not connected" and returned, on the two controls that exist precisely
  because a pane has gone unresponsive. All three paths now revive the socket and
  carry the frame through, so the first thing you type is not the thing that is lost.
- **A terminal socket failure used to leave no trace.** `ws.onclose` took no argument
  (the close code was discarded) and there was no `onerror` at all. Both exist now, so
  the next occurrence says whether it was an abnormal close, an oversized frame or a
  server error instead of looking identical to every other cause.

Note: this fixes what the UI does about a dropped terminal socket. What drops it in
the first place is not yet identified — the close code added here is what will name it.


### A split tmux window is composited, not cropped

- Claude Code's agent-teams splits whatever tmux window it runs in, one pane per
  teammate. Measured on a live session: a 155x39 window with the user's own `claude`
  squeezed into 46x38 on the left and four teammates stacked 108x9 down the right —
  and the viewer showed the 46-column strip and nothing else. The window is now
  composited whole.

### The ›_ paste button no longer pastes again on every Enter

- Click ›_ beside a saved command or skill, press Enter to submit, and the same text
  was pasted a second time — and a third. The button kept focus, so Enter kept
  re-triggering it; it only stopped once focus moved elsewhere.

### Terminal tooltips, and three of them were wrong

- The mode, agent and model toolbar buttons and the max-turns input gained tooltips,
  following the pattern the Room button already used.
- `turns.tip` claimed Claude "stops automatically" at the limit. It does not: it
  auto-continues up to three more times before surfacing an incomplete-run notice, so
  real usage can reach roughly four times the number shown. Corrected in all five
  locales, along with two other inaccurate tips.

### A popup window no longer escapes the window-open policy

- `setWindowOpenHandler` was applied only to the top-level Electron window, so a
  same-origin link opened inside a popup fell back to Electron's allow-anything
  default instead of the app's own same-origin/external policy. The policy is now
  re-attached to every window it creates.
- Kanban: a stale response from a previously opened task could be appended to
  whatever modal happened to be open by the time it arrived.

### Bot bubbles no longer flicker on reload

- A full browser reload mid bot-turn lost `streaming.agent` (in-memory only), so the
  next live chunk looked like a genuinely new speaker and opened a second bubble.

### Room mode and the mid-turn bot hand-off are documented

- Both shipped as user-facing features with no mention anywhere in the README. Added
  in all three translations (EN/RU/UA).

## 7.9.0

A remote chat can no longer get stuck for good, a broken local Claude CLI install
is caught before a chat send fails on it, and two small Telegram gaps are closed.

### A remote SSH chat must never become permanently unusable (#67)

- **Root cause: a missed termination, not the auto-continue budget.**
  `runSshSingle()` awaits a promise that only resolves from `onDone`, and four paths
  in `ClaudeSSH.send()` could end a run without ever reaching it — a socket closing
  with no error and no channel open (an idle-timeout drop), the idle watchdog and
  hard cap calling `conn.end()` alone, an abort arriving before `conn.exec`, and
  `conn.on('error')` double-firing `onDone`. A pending await keeps the session's
  `activeTasks` entry alive forever, and the 15s orphan sweeper explicitly skips any
  session that has one — so the chat refused every new message **and** "Restart
  Session" answered "Task is still running." No way out but a server restart.
- **Every ending now goes through one `finish()`,** and the abort listener is
  registered at `send()` entry instead of inside the exec callback.
- **Restart Session is now a recovery action, not a refusal.** It aborts the live
  turn, waits up to 5s for that turn's own cleanup to release the session, and
  reaps it as a backstop if the run is wedged below the abort signal — then starts
  fresh with the chat's history replayed.

### See a broken local Claude CLI before it breaks a chat

- **`/api/version` now reports `{ available, authenticated }`** for the local
  `claude` binary — the same capability-check pattern already used for tmux and
  SSH. Without it, a missing or broken local install was only discovered when a
  chat's `spawn()` failed mid-turn.
- **The UI shows a persistent warning** the moment the check comes back negative,
  translated in every locale, instead of surfacing the problem as a failed send.

### Telegram: two gaps closed

- **`/cancel` now works.** It was advertised in the bot's own command menu but had
  no handler in the private-chat switch, so it silently fell through to "unknown
  command." It now clears pending attachments and returns to the dialog overview.
- **A project added after the initial `/connect` sweep now gets its forum topic
  immediately**, instead of only on the next session activity that happened to
  reference its workdir.

## 7.8.0

The editor you actually use is one click away, the composer stops moving under the
cursor, and a terminal pane you can no longer type into has two ways back.

### Open the workspace in VS Code

- **One button, local or remote.** A project row and the file viewer now hand the
  workspace to your desktop editor. A remote SSH project opens through **VS Code
  Remote-SSH**, already at the right path — no reconnecting by hand, no hunting for
  the folder.

- **It opens on the machine you are sitting at.** The studio launches the editor
  itself when it can find a `code` binary on the host; when it cannot — inside
  Docker, on a headless server, on Windows — it hands your browser a `vscode://`
  link instead, and the desktop handler takes it from there. One rule, no
  platform-sniffing, and it lands correctly whether the studio runs on your laptop
  or three time zones away.

- **Not only VS Code.** Insiders, VSCodium, Cursor and Windsurf are selectable in
  Settings → *UI*. All four are VS Code forks, so the remote-SSH link means the same
  thing in each; only the scheme and the binary change.

- **A remote workspace on a non-standard port carries it.** Omitting the port would
  not be the cautious choice — the connection would simply be attempted against 22
  and fail.

- **Refusals say what is wrong.** A remote project recorded with a `~/project`
  workdir cannot be expressed as a URI (Remote-SSH would look for a directory
  literally named `~`), so it is refused by name rather than opening the wrong
  folder. Per-file opening stays local-only on purpose: VS Code's own URL handler
  opens a remote *file* link as a folder, so the button comes off rather than doing
  the wrong thing — the project row still opens the remote workspace.

### The composer stopped moving under the cursor

Four defects reported against the shipped build, none of them a regression: each was
work that never reached a commit. Two of them are the composer, two the terminal pane.

- **The interrupt pill no longer shoves the placeholder.** It sat upstream of the
  textarea in a flex row, so every earlier sibling owned the text's left edge: the
  moment a turn started, the hint jumped ~70px to the right and the narrower box
  re-wrapped it. The pill now lives downstream of the textarea, where it appears and
  disappears without moving a glyph.

- **One place computes the composer's height.** The formula was already right; it
  simply ran from one function. Boot (the markup ships `rows="1"`), a language switch
  (a longer translation wraps differently), a sidebar toggle, a window resize and the
  pill entering the row all changed the wrap without re-measuring, which is what left
  the second line of the hint clipped. `autosizeInput()` now owns the cap and is
  called from all seven paths.

An adversarial review of the diff (an independent non-Claude reviewer, run before the
merge) turned up four more, all fixed here: the composer was measured at the *start* of
the 250ms sidebar animation, a superseded socket's `close` event could mark a working
terminal "disconnected", a bare Return — the one key you most need at a `[Y/n]` prompt —
was the one key the send line refused to send, and a draft left in that line followed the
user to whichever terminal they opened next.

### Terminal sessions

- **A pane no longer goes deaf until you switch tabs and back.** xterm routes
  keystrokes through a hidden textarea; a reconnect swapped the socket but left focus
  wherever it had drifted, so the pane looked live and swallowed every key. The tab
  switch "fixed" it only because `showTerminalView()` ends on `term.focus()`. A
  reconnect and a click on the pane now do the same -- and a click is ignored while a
  selection is being dragged out.

- **A reconnect button in the terminal header.** Every automatic path is conditional:
  the visibility handler and the tab switch only act on a socket that already reports
  closing, and `onclose` only fires if a close event ever arrives. A socket whose TCP
  path died without a FIN reports OPEN on both ends -- the server heartbeat kills those
  within ~60s, but that is a timeout, not an answer to "it is stuck now".

- **A send line under the pane.** The composer is `display: none` in terminal mode, so
  the only way to send a line to a terminal session was to type into the pane -- exactly
  what a stale socket takes away. The new input writes the same `{type:'input'}` frame
  the pane writes, so it works on an agent tab and on the subscription engine's pane,
  where it is how a blocking permission prompt gets answered. It refuses to send on a
  socket that is not OPEN rather than dropping the line silently.

## 7.7.0

Three things that were true only in one place become true everywhere: the file
browser now works on remote projects, a remote run finds the same `node` an
interactive shell would, and the dials a new chat opens on are yours to set.

### New-chat defaults

- **Five dials, set once.** Mode, agent mode, model, thinking effort and turn
  budget now have a configured default instead of a literal buried in the markup.
  Settings owns the global half; a project can override any subset of the five.
  The chain is **project override → global default → built-in**, every row shows
  which of the three answered, and each has a one-click Reset.

- **A project stores only the dials it pinned.** Storing all five instead would
  freeze each project at whatever the global happened to be the day it was
  created — the opposite of what a default is for. Pin the model, change the
  global turn budget next month, and the project follows.

- **The chain reaches the server, not just the toolbar.** Both doors to a new
  interactive chat — the WebSocket `chat` frame and `POST /api/sessions` — used
  to carry their own literal set (`sonnet` / `auto` / `single` / 30 turns). An
  API client or a browser running a cached older build therefore created chats on
  values nobody had configured, while the toolbar on screen showed the resolved
  ones. Both now resolve the same chain, and the resolved row is computed before
  the session is inserted so the stored row and the run cannot disagree.

- **Telegram and the scheduler deliberately do not inherit it.** They keep their
  own 30-turn budget, now under a name (`UNATTENDED_MAX_TURNS`) rather than
  copy-pasted at eleven call sites. A scheduled job that silently inherited
  someone's `turns: 200` would spend a budget nobody was watching, and every
  existing install would have jumped from 30 to 50 on upgrade without being
  asked. Per-channel budgets, if they are ever wanted, belong in their own
  setting — not in the dials that describe a chat window.

- **An empty turn-budget box no longer means 30.** The value the browser actually
  put on the wire fell back to a literal that matched neither the box's own
  placeholder nor the server's built-in. It now falls back to your configured
  default.

### Remote projects get a file browser

- **List a directory, open a file — over SSH.** The file tree, the file viewer
  and `@`-mention search work on remote projects, which previously answered
  "file browser not available". That refusal was correct while there was no
  remote read path: the browser reads the local disk, so pointing it at
  `/home/user/project` from a Windows client resolved to `C:\home\user\project`.

- **Read-only by design.** Download, share, copy-image and image/PDF preview stay
  hidden for a remote file rather than failing under your finger, and come back
  the moment you open a local one.

- **Caps are announced, never silent.** Listings stop at 2000 entries and files
  at 2 MB, both enforced on the remote host — an 8 GB log never crosses the link
  — and both stated in the UI instead of quietly truncating.

- **Three guard layers, none of them the local one.** Paths resolve with POSIX
  semantics whatever this server runs on; the remote script re-checks containment
  against the physical path (`pwd -P`), because a symlink inside the project
  satisfies a textual check by construction; and every row whose path escapes the
  base the remote echoed back is dropped. A symlink whose final component is a
  file is refused rather than followed. Filenames are attacker-controlled in the
  way that matters — a repo you cloned can contain one with a newline in it — so
  every control line is framed by a per-request random nonce.

### Remote runs find the tools that are actually installed

- **`bash -lc` is a login shell, not an interactive one.** Every version manager
  — mise, asdf, nvm, pyenv, rbenv, nodenv, fnm, sdkman — publishes its binaries
  from `~/.bashrc`, and the stock Debian/Ubuntu `~/.bashrc` returns immediately
  when not interactive. The symptom was a SessionEnd hook dying with
  `node: not found` on a host where `which node` answers instantly. Remote runs
  now build the PATH those managers would have set, after the `cd` rather than
  before it, since mise and asdf pin a version per directory.

- **It cannot take the run down with it.** The prelude is chain-safe: the caller
  joins it to the `claude` invocation with `&&`, so it never ends on a failed
  test, and a user's own `$CCS_REMOTE_INIT` runs under `eval` so a syntax error
  there stays a runtime failure instead of a parse error that swallows everything
  behind it. It sources no rc file — that output is a stream-json pipe, and one
  MOTD banner derails the parse.

- **The Test button reports it.** A connection test runs the same prelude and
  says whether `node` and `claude` resolve, so a broken PATH shows up on the host
  form instead of surfacing mid-turn as a hook failure that names the wrong
  problem.

### Fixes

- The MCP task manager offered `haiku` / `sonnet` / `opus` in its model enum, so
  an agent creating a task could not pick **Fable** — the fourth model the UI has
  exposed since 7.4.

## 7.6.0

Bots stop being a web-only feature, and gain a mode where several of them talk to
each other. Plus four fixes to paths where a message could vanish without a trace.

### Bots reach Telegram

- **`/bots` lists the project's roster**, with each `@@handle`, model and description.
  Mentions from Telegram had worked for a while — the parser, the dispatch and the
  per-bot sessions are the same ones the web chat uses — but nothing ever said WHICH
  handles exist, so on a phone the feature was invisible unless you already knew a
  handle by heart. Works in a direct chat and in a Forum project topic.

- **A Forum topic can belong to one bot.** Everything typed there goes to that bot;
  the handle stops being retyped on every message. It is not a second execution path —
  the topic prefixes `@@handle` and hands the message to the ordinary project flow, so
  the same parser and dispatch serve both. Commands, media, and text already naming
  that bot are left alone.

- **A bot-owned task reports into that bot's own topic.** Assigning a task to a bot
  has been possible from the Kanban and Schedule editors for a while, and the task
  already ran under that bot's prompt and model — but its result went to the shared
  Activity topic like everyone else's, so a bot's routine work was indistinguishable
  from anything else running. Failures are routed the same way, deliberately: someone
  watching a bot's topic is watching that bot, and a silent failure there is worse
  than a noisy one.

### A room of bots

- **New `conversation` agent mode.** Two to six of the project's bots take SERIAL
  turns on one message, for at most three rounds or ten messages, then the room closes
  with a single artifact. A bot with nothing to add replies `PASS`; a bot that needs a
  human decision writes `@user` and the room stops there.

  Three invariants hold it together. The room is the ONLY dispatcher — `message_bot`
  is deliberately not available inside it, because two dispatchers would give one bot
  two owners in one turn. It is serial and never parallel, since two bots writing at
  once interleave into a transcript nobody can follow. And it never nests inside a
  multi-agent wave: it is a leaf that emits one artifact.

  Not yet built: a DAG node that consumes that artifact.

### Messages that used to vanish

- **A hand-off written after a turn ended is no longer lost.** `message_bot` refuses
  once the turn owning the session is over, so a peer named late was discarded outright
  along with the task text the calling bot had already written. Those now wait in the
  recipient's inbox and are delivered on its next run in the same conversation —
  scoped to that conversation, never global, or a letter from one project would arrive
  inside another. It is not a live interrupt: nothing touches a running engine.

- **Mid-task clarifications reach the subscription (tmux) engine.** A clarification
  typed into a working chat has to survive a path with no return channel — queue,
  drain, tmux paste, Enter, the agent's TUI — and every failure along it was invisible:
  the message simply disappeared and its row was marked delivered anyway. The paste is
  now gated on the pane actually listening, a failed paste is re-queued instead of
  being marked delivered, and whatever is still queued when a turn ends runs as a
  follow-up turn rather than being discarded with its attachments. The same now holds
  on the task path, bounded by `CCS_MAX_CLARIFY_TURNS` (default 3), and on the
  Telegram path, which had the original defect intact: it retired a clarification
  the instant it was picked up off the queue, so a paste that never landed left the
  sender looking at a delivered badge on text the agent had not seen.

- **A file attached to a clarification survives the follow-up turn.** Only IMAGES are
  stored with a body; a text or binary attachment is kept as a path. The turn that
  re-sends an undelivered clarification builds its content blocks from that body and
  never from the path, so every non-image attachment arrived empty and was dropped
  without an error or a log line. The body is now read back before the hand-off — on
  the Telegram path as it already was on the web one. An SSH entry is still passed as
  host and key path only: it carries a credential, and that block is written to the
  transcript on disk.

- **Terminal and chat WebSockets are heartbeated.** Without an active ping/pong a
  connection whose TCP path died silently — proxy idle timeout, laptop sleep, NAT drop
  — sits "open" on both ends forever. No close event fires, so the socket just freezes
  with nothing telling the client to reconnect.

### Delegate on a remote SSH project (#55)

Delegate now **refuses** a remote project with an explanation naming the host, instead
of starting an external agent in the wrong place. Delegation is local-only in every
step: it creates `.crosswork` on the machine running the studio, writes `CONTEXT.md`
there, and opens a local terminal. Given a remote workdir all three targeted the wrong
host — and on Windows, Node resolves a POSIX-absolute path against the current drive,
so the agent started in `C:\home\user\project`. Same class as #53.

This does not close #55. Full remote delegation is accepted and planned; it needs
remote writes, a remote poll loop, and somewhere for the agent's terminal to live.

### Also

- `bot_id` is validated on both task endpoints. It decides whose prompt and model a
  task runs under, and an unchecked value cost a whole run before surfacing as "task
  bot not found" in a log nobody watches.
- The Activity panel shows which bots are taking part in a live chat, a running task
  and a QUEUED one — the last being where you find out a recurring routine exists, and
  whose it is, before it runs.
- A bot's spawned subtask keeps its owner. Every other field was inherited from the
  caller; `bot_id` alone was hardcoded null, so a bot's own subtask ran as a nameless
  agent with none of its prompt or model.
- The `/` command popup clamps each preview to two lines. A command's prompt can run to
  thousands of characters, and one entry unrolled over the whole list.
- `AGENTS.md` is read when a project has no `CLAUDE.md`. The `claude` CLI discovers only
  the latter, so a project standardised on `AGENTS.md` ran with none of its conventions,
  silently. Precedence is exclusive — when a `CLAUDE.md` exists the other is not read at
  all — and the instruction-file editor opens whichever one the run actually uses.

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
