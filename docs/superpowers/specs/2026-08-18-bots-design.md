# Bots — Design Spec

**Date:** 2026-08-18
**Status:** approved, v1 in progress

## Goal

A user defines a **bot**: handle, label, description, engine, model, system prompt. Then
they `@handle` it inside a normal project chat and it answers as itself. Later, several
bots collaborate in one chat, and bots can hand work to each other.

## Why a subsystem, not an extension of multi-agent mode

`runMultiAgent` (server.js, `function runMultiAgent`) already decomposes a task across
several concurrently-running agents, tags their output with `messages.agent_id`, and
renders per-agent badges in the UI. What it does **not** have is identity: its agents are
LLM-invented roles (`agent-1`, `agent-2`) that exist for one turn and vanish.

Bots are the identity layer that was missing. The subsystem mirrors the kanban one,
which is this project's proven pattern for exactly this shape:

| kanban | bots |
|---|---|
| `tasks` + `task_chains` tables | `bots` table |
| 7 `/api/tasks*` routes | `/api/bots*` routes |
| `mcp-task-manager.js` gives agents a tool surface | `mcp-bots.js` for bot-to-bot |
| own UI pane, reuses sessions for execution | same |

Three capabilities come almost free from what exists: `messages.agent_id` is already
threaded end to end (WS → SQLite → UI badges); `tasks.recurrence` + `scheduled_at`
already implement routines; `skills/*.md` already shows the "markdown file becomes part
of a system prompt" pattern.

## The decision that separates a tool from a demo

A bot's contribution is only useful if the next participant — human or bot — can build
on it. Measured on this project on 2026-08-18, across three agent runs:

- A scoped audit that cited `file:line` for every finding: all spot-checked claims held.
- An unscoped verification run: reported a critical finding that was an artifact of its
  own test environment, and later retracted it.
- An external review: 2 of 7 findings were out of scope because it lacked context on
  what was already built.

Agents are reliable in proportion to how checkable their claims are. So every bot's
system prompt carries a standing requirement: **state what a claim rests on** — the
file, the command output, the source — and say plainly when something is unverified.
This is a prompt convention, not machinery, and it is the highest-value line in the
feature.

## Session model

The **project chat is the primary surface**: one task, several participants. Hermes Bot
Mode gives every bot its own chat, which suits a desktop assistant; here it would split
one piece of work across N chats.

A bot chat exists but is secondary — for configuring and trying a bot on its own, and as
the destination for routine output.

## Storage

SQLite, not `config.json`. Config is rewritten wholesale on every settings change, and a
growing roster of multi-KB system prompts does not belong there; bots also need joins
against `messages` and `tasks`.

```sql
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,          -- @handle; [a-z0-9_-]+, lowercase, mention-safe
  label TEXT NOT NULL,
  description TEXT DEFAULT '',  -- what this bot is for; shown to other bots in the roster
  engine TEXT DEFAULT 'claude', -- reserved; only 'claude' is wired in v1
  model TEXT,                   -- NULL = session default
  system_prompt TEXT DEFAULT '',
  active_skills TEXT DEFAULT '[]',
  active_mcp TEXT DEFAULT '[]',
  avatar TEXT DEFAULT '',       -- one emoji
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

`engine` ships in v1 even though only `claude` is honoured, so adding Codex later is not
a migration.

## Mentions

`@` is **already** the file-attachment trigger in the composer (`'@ — files'` in the
input placeholder). Agent mentions therefore only resolve against **registered bot
handles**; anything else falls through to the existing file path untouched.

Parsing is a pure function over the message text plus the known-handle set, unit-tested
like `terminal-session.js` — no regex scattered through the request handler.

## Bot-to-bot (v2)

Not regex-scanning a bot's output for `@handle`: prose contains at-signs, and false
positives would dispatch work nobody asked for. Instead `mcp-bots.js` exposes
`message_bot(handle, text)` as a tool, mirroring `mcp-task-manager.js`, which is already
injected into agent runs. A tool call is explicit, structured, and gives a natural place
to account for hops and to check the abort signal.

Termination: one shared budget per user message (not per bot), a used (from → to) edge
cannot fire twice in the same chain, and a round that dispatches nobody new ends it.
Output from a run flagged incomplete by `multi-agent-result.js` never dispatches
anything — a truncated answer must not summon more work.

## Several bots in one message (v2)

Mention order is **not** the execution order: word order is an accident of typing, not a
decision about who leads. The existing planner produces a `depends_on` DAG, which
already expresses both parallel and sequential work per subtask; it is repointed from
inventing roles to assigning work among the mentioned bots, with the roster (handle,
description, and what each bot did recently in this chat, via `messages.agent_id`) in
its context.

## v1 scope

Define a bot → mention it in a project chat → it answers with its own prompt and model.
One bot per message.

Deliberately excluded from v1: bot-to-bot, multi-bot planning, per-bot chats, routines,
non-Claude engines, avatars beyond a single emoji.
