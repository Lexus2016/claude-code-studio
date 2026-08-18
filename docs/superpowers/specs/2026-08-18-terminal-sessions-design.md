# Terminal Sessions — Design Spec

**Date:** 2026-08-18
**Status:** approved for implementation
**Plan:** `docs/superpowers/plans/2026-08-18-terminal-sessions.md`

## Goal

A studio session can be a **terminal session** instead of a chat session: the browser
shows the live TUI of an agent CLI (Claude Code, codex, agy, opencode) running on the
server, and the user works in it directly.

## Session model — typed, not switchable

A session is `kind = 'chat'` or `kind = 'terminal'`, decided at creation, never changed.

This is the load-bearing decision. The rejected alternative — one session that can
*switch* between chat and terminal — puts two drivers on one tmux session: the
`subscription` engine (which types into the pane with `paste-buffer` + `send-keys`) and
a human. That breaks concretely, not theoretically:

- `paneBusy()` (`claude-interactive.js`, `function paneBusy`) treats **any** pane change
  between polls as "agent is busy". A human typing keeps it permanently true.
- The turn's watchdog cursor (`lastActivityAt`) only advances on new transcript bytes,
  so a turn held "busy" by human typing runs until `IDLE_TIMEOUT_MS` (default 10 min).
- The engine's `paste-buffer` lands in the same input box where the human may have
  half-typed text; the two mix.

Typed sessions remove the state by construction: nothing but the human ever drives a
terminal session, and the engine never sees one.

**Consequence:** terminal sessions need no `messages` rows, no `catch-up` sync, and no
busy-detection for *correctness* — only for safe reaping (see below).

## Restore — three states

tmux survives a studio restart (separate process); it does not survive a host reboot or
`tmux kill-server`. The agent's own resume covers what tmux cannot. On opening a session
from history, exactly one of three paths applies, distinguished by `tmux has-session`
plus `#{pane_dead}`:

| State | Condition | Action |
|---|---|---|
| `attach` | session exists, pane alive | attach a client |
| `respawn` | session exists, pane dead (`remain-on-exit on`) | `respawn-pane -k` with the resume command |
| `cold` | no tmux session | `new-session -d` with the resume command |

## Agent command matrix — verified on 2026-08-18

Every supported agent can both start interactively and resume. The delegation
`template` field is **not** reusable for terminal sessions: it encodes a one-shot
invocation with an embedded prompt, and for opencode `run` is explicitly
non-interactive. Hence new config fields.

| Agent | `interactive` | `newIdFlag` | `resume` | `resumeLast` |
|---|---|---|---|---|
| claude | `claude` | `--session-id {sid}` | `claude --resume {sid}` | `claude --continue` |
| codex | `codex` | — | `codex resume {sid}` | `codex resume --last` |
| agy | `agy` | — | `agy --conversation {sid}` | `agy --continue` |
| opencode | `opencode` | — | `opencode -s {sid}` | `opencode -c` |

`newIdFlag` is what makes a restore deterministic: for Claude we generate the UUID
ourselves and pass `--session-id <uuid>` at first start, so `--resume <uuid>` later
targets exactly this conversation. Agents without it fall back to `resumeLast`, which
means "the agent's most recent conversation" — for codex this is most-recent
**globally**, so a conversation started elsewhere in between wins. The UI must label a
`resumeLast` restore as "restored the last conversation", not as this one.

## Reaper — verified signals

Agents are expensive; tmux is not. Measured RSS on the dev machine (2026-08-18):

```
opencode   1835 MB      claude   997 / 627 / 619 MB
claude helpers ~350 MB each      tmux server  3.7 MB
```

So the reaper targets the agent process; tmux overhead is irrelevant (~250x smaller).

**Rejected signal: `#{session_activity}`.** It does not move when the pane produces
output. Measured with no client attached, 6 s apart:

```
A (agent printing output): delta = 0 s, attached=0
B (agent silent):          delta = 0 s, attached=0
```

A reaper built on it would kill agents mid-task.

**Accepted signals:**

- `#{session_attached}` — client count. Killing the `script` process drops it to 0 and
  leaves the tmux session alive (verified), which is exactly "browser tab closed".
- `#{window_activity}` — does move with output (verified: 948 → 952 → 955 while
  `session_activity` stayed 948). Used as a cheap first filter only: Claude's TUI has a
  self-refreshing statusline clock, so a fresh `window_activity` does not prove work.
- **Pane-hash comparison**, two `capture-pane` hashes 3 s apart — the decisive check.
  Verified to discriminate: agent producing output → hashes differ; agent silent →
  hashes identical. This is the same technique `paneBusy()` already uses in this repo.

**Reap order** (per session, once a minute): `attached == 0` → session older than
`minAgeSec` → `window_activity` older than the idle threshold → pane hashes equal →
kill. Anything short-circuits to "keep".

**Why the busy check is mandatory:** resume restores the conversation, but not a file
the agent was halfway through writing. A wrong reap can corrupt work on disk.

**Orphaned clients.** `script` processes are children of the studio's Node process. If
the studio restarts, they survive, stay attached, and pin `session_attached` above zero
forever — the reaper would never fire. The studio must `detach-client` on every terminal
tmux session at startup.

## PTY transport — verified

No `node-pty` (native module, rejected by the project's zero-build rule). tmux already
owns the PTY for the agent; the tmux *client* gets its own PTY from the system `script`:

- macOS: `script -q /dev/null tmux attach-session -t NAME`
- Linux: `script -qfc "tmux attach-session -t NAME" /dev/null`

Three non-obvious requirements, all verified:

1. **`TERM` must be set explicitly.** Without it: `open terminal failed: terminal does
   not support clear`. A studio started by systemd/launchd/Docker has no `TERM`.
2. **`window-size manual` + `resize-window`** for sizing — SIGWINCH cannot be delivered
   through `script`. tmux's default is `window-size latest`, which lets any client
   resize the window out from under the others.
3. **`remain-on-exit on`** so an exited agent leaves a dead pane (scrollback preserved,
   `respawn-pane` revives it in place) instead of destroying the session silently.

## Security

A browser terminal is remote code execution by design. Two amplifiers already in the
codebase: `POST /api/external-agents` validates only `id` (regex) and stores `template`
verbatim for shell execution; the studio can be published through `tunnel-manager.js`.

Requirements:

- Off by default: `config.terminal.enabled === false` unless explicitly turned on.
- Refuse to open a terminal WS while a tunnel is active, regardless of the flag.
- Reuse the existing WS upgrade auth — no separate token path.
- tmux runs the agent binary directly (not a shell), with `remain-on-exit on`.

## Platform support

Determined by the **server** host, not the browser. Capability-checked, never
OS-sniffed — the same pattern as the existing `tmuxAvailable` flag.

| Server host | Support |
|---|---|
| macOS / Linux / Docker / WSL | full |
| native Windows | unavailable — no tmux, no `script`, and Node has no ConPTY API without a native module |

Native Windows keeps the existing native-console path (`/api/sessions/:id/open-terminal`).

## Non-goals

- Importing terminal-session history into the chat view. Feasible for every agent
  (claude/codex/opencode all persist transcripts) but a separate adapter per format.
- Mobile. xterm on a phone lacks Esc/arrows/Ctrl; terminal sessions stay desktop-only.
- Touching the `subscription` engine. It keeps its own `ccs-<id>` tmux sessions;
  terminal sessions use the `ccsterm-<id>` prefix and never collide.
