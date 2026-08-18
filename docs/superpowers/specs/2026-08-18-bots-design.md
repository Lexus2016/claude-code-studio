# Bots — Design Spec

**Date:** 2026-08-18
**Status:** revised after an independent review panel (codex + grok, 2026-08-18).
Their verdicts on the first draft: functionality ACCEPT WITH CHANGES from both,
specification REJECT (codex), usability REJECT (grok). The changes below are the
response; the UI section is new because the first draft had none.

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
system prompt carries a standing requirement: for **factual and technical** claims,
state the basis actually held — the file and line, the command and its output, the
source read — cite only what was genuinely accessed, and label inference as inference.

Scoped to factual claims deliberately: demanding a citation per sentence would turn an
editorial or conversational bot into noise. And a prompt line cannot make a model
truthful. What it can do is make the difference between a checked claim and a guess
visible to whoever reads the answer next — which is exactly what failed above.

## Session model

The **project chat is the primary surface**: one task, several participants. Hermes Bot
Mode gives every bot its own chat, which suits a desktop assistant; here it would split
one piece of work across N chats.

A bot chat exists but is secondary — for configuring and trying a bot on its own, and as
the destination for routine output.

## Each (chat, bot) pair needs its own CLI session — the blocker

A chat holds ONE `claude_session_id`. `claude-cli.js` passes the system prompt only
when there is no session to resume:

```js
if (systemPrompt && !sessionId) args.push('--system-prompt', systemPrompt);
```

(the guard exists because changing a system prompt mid-session invalidates the
signatures on thinking blocks and the API rejects the turn with a 400.)

So a bot answering inside an existing chat would get **no system prompt at all** — its
identity, the whole point of the feature, would silently not exist. This was found by
review, not by the original design.

Therefore each (chat, bot) pair carries its own CLI session:

```sql
CREATE TABLE IF NOT EXISTS bot_sessions (
  chat_session_id   TEXT NOT NULL,
  bot_id            TEXT NOT NULL,
  claude_session_id TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_session_id, bot_id)
);
```

First mention of a bot in a chat: a fresh CLI session, prompt applied. Later mentions:
resume that session. This also gives a bot memory of its own thread inside that chat,
which is what "work with it as an agent" means.

## Scope: global identity, per-project availability

Two questions that look like one. Separating them is the whole answer.

**Identity is global.** `messages.agent_id` stores the handle, so a handle owned by two
projects would mean two different people inside one stored history, and every later
cross-project feature would need a permanent (project, handle) map plus a backfill. Both
reviewers named per-project *identity* as the one choice with no migration path. So a
handle is unique across the installation, soft-delete reserves it forever, and the handle
IS the identity — no separate UUID is needed. Two specialists are two handles:
`@analyst-rust` and `@analyst-crypto`, never one handle meaning different things.

**Availability is per project.** The product owner's objection settled this: *"why do I
need a philosopher bot in a project about crypto research?"* A roster that shows every
bot everywhere becomes a junk drawer as soon as a user works across several projects, and
sorting by recency only pushes the irrelevant ones down the list — it never removes them.

```sql
CREATE TABLE IF NOT EXISTS project_bots (
  project_id TEXT NOT NULL,
  bot_id     TEXT NOT NULL,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, bot_id)
);
```

`GET /api/bots` is the library (the management screen); `GET /api/bots?project=<id>` is
what a project offers, and what its `@` palette lists. A bot created while a project is
open joins that project immediately, so creating is never followed by a separate "now add
it here" step. Removing a bot from a project deletes neither the bot nor its past
messages — it only stops offering it there.

**The failure mode this introduces, and its answer.** Mentioning a bot that exists but is
not in this project must not silently fall through to the file-attachment path. Mention
detection therefore resolves against ALL handles and then partitions: available bots are
dispatched, and a mention of a known-but-not-added bot answers *"@philosopher exists but
is not in this project"* with an **Add** action. A confusing failure becomes a one-click
affordance.

**Context comes for free.** A bot answers inside a chat that already carries the
project's workdir, so it works in that project's files with no extra plumbing.

## Storage## Storage

SQLite, not `config.json`. Config is rewritten wholesale on every settings change, and a
growing roster of multi-KB system prompts does not belong there; bots also need joins
against `messages` and `tasks`.

Deleting a bot is a **soft** delete. A handle that is freed and later reused would
make a new bot appear as the author of the old one's messages; the row stays with
`deleted_at` set, the handle stays reserved, and autocomplete hides it.

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
  updated_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT            -- soft delete: the handle stays reserved forever
);
```

`POST /api/bots` creates and returns 409 on an existing handle; `PUT /api/bots/:id`
updates. The first draft used one upsert endpoint, which let a create silently
overwrite an existing bot.

`active_skills` and `active_mcp` are stored but **not honoured in v1**, so they are not
shown in the form. A field that does nothing but looks like it does is worse than a
missing one.

Caps, and deliberately two different behaviours:

| field | cap | on excess |
|---|---|---|
| `system_prompt` | 8192 chars | **rejected with 400** |
| `label` | 100 chars | truncated |
| `description` | 500 chars | truncated |
| `avatar` | 8 codepoints | truncated (codepoint-wise, never mid-surrogate) |
| roster inside one bot's prompt | 40 other bots | truncated, with "and N more not listed here" |

A system prompt is authored deliberately and is re-sent on every turn, so silently
losing half of it would be a lasting, invisible cost — that one is refused outright. A
label or description over the cap is a slip, and truncating it is not destructive to
behaviour. The roster cap limits how many peers are listed inside one bot's prompt; it
is **not** a limit on how many bots may exist.

Non-`claude` `engine` values are rejected with 400 rather than accepted-and-ignored: a
bot that silently ran on a different engine than the user picked would be worse than one
that refuses to be created.

`engine` ships in v1 even though only `claude` is honoured, so adding Codex later is not
a migration.

## Mentions

`@` is **already** the file-attachment trigger in the composer (`'@ — files'` in the
input placeholder). Agent mentions therefore only resolve against **registered bot
handles**; anything else falls through to the existing file path untouched.

Parsing is a pure function over the message text plus the known-handle set, unit-tested
like `terminal-session.js` — no regex scattered through the request handler.

Three boundary rules, each from a real failure the reviewers pointed at:
- the `@` must follow start-of-string, whitespace, or an opening bracket or quote, so
  an address never reads as a mention while `(@bot)` still does;
- the character after the handle must not continue a path or domain, so `@bot1.dev`
  does not resolve to a registered `@bot1`;
- a handle may not end in `-` or `_`, or it could be created and then never matched.

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

## Several bots in one message

**v1** dispatches them sequentially in mention order, each seeing the previous ones'
output. This is a loop around the single-bot path, and it already delivers the owner's
example ("together do the analysis and make the report").

**v2** stops using mention order: word order is an accident of typing, not a decision
about who leads, and if the bot that should coordinate happens to be typed second the
work runs backwards. The existing planner already emits a `depends_on` DAG expressing
parallel and sequential work per subtask; it is repointed from inventing roles to
assigning work among the mentioned bots, with the roster (handle, description, and what
each bot did recently in this chat, via `messages.agent_id`) in its context.

Mention order therefore survives only as a v1 placeholder, and the UI's per-bot blocks
are built in dispatch order from the start so v2 changes the order, not the surface.

## The roster is data, not instructions

A bot's label and description are user-authored text that lands inside another bot's
system prompt. They are newline-stripped, length-capped, wrapped in an explicit fence
and introduced as reference material, so one bot's description cannot issue orders to
another.

## Usability

The first draft had no UI section at all, which is why the review rejected this axis.

**Where bots live.** A "Bots" section in the left panel, next to the existing ones —
not buried in global settings. Rows show avatar, `@handle`, label. The create form asks
for: label, auto-suggested handle, one-line purpose, model, system prompt. After saving,
the primary action is **Insert @handle**, which focuses the composer with the mention
already typed — the shortest path from "I made a bot" to "I used it".

**Discovering that `@` means a bot.** No second trigger and no "talking to X" mode. The
existing `@` palette gains two groups, bots first, files below, filtered by the same
query, with `+ New bot` always present. The composer placeholder changes from
`@ — files` to `@ — bot or file`. The first time a bot exists and has never been
mentioned, one dismissible line under the composer explains it.

A picked bot becomes a **chip** that deletes as one token; a picked file stays plain
path text. That is what keeps the two meanings apart after selection.

**Telling a bot's answer apart.** The default assistant keeps its current look with no
name — that contrast is the signal. A bot's message uses the same bubble and markdown
but carries a header: avatar, label, muted `@handle`, and the model actually used, plus
a stable left accent colour derived from the handle. A deleted bot's old messages read
`deleted bot · @handle` rather than borrowing a new bot's identity.

**While bots are working.** One block per bot, in dispatch order, each with its own
state: `queued` / `running` / `done` / `stopped` / `failed`. Only the running one
streams, into its own block — never an interleaved stream. A compact strip above the
composer lists the bots in this turn and their states. These components ship in v1 with
one bot so that v2 does not have to invent a new surface.

**Stopping.** The global Stop keeps its meaning: abort this turn. Each running block
also carries its own Stop, always visible, never behind a menu. A stopped block keeps
its partial text and says `stopped by you — answer incomplete`, which is consistent with
the rule that an incomplete answer is never passed onward.

## v1 scope

Define a bot → mention it in a project chat → it answers with its own prompt, its own
model and its own CLI session.

Several bots mentioned in one message run **sequentially**, each seeing the previous
ones' output — that is the owner's own example ("together do the analysis and make the
report"), and it is a loop around the single-bot path rather than new machinery. A bot
whose run is flagged incomplete does not pass its output on.

Deliberately excluded from v1: bot-to-bot dispatch via `message_bot()`, the planner DAG
(dispatch order is mention order until then), per-bot chats, routines, non-Claude
engines, skills/MCP per bot.
