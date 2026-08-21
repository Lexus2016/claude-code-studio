# Token usage: why Studio can cost more than the bare CLI, and how to bring it down

Answers [#24](https://github.com/Lexus2016/claude-code-studio/issues/24). Every claim below is a
pointer into this repository — check it rather than trusting the prose.

## The short version

Studio does not run background analysis, indexing or scheduled summarisation. Nothing calls the
model unless you asked for something. The gap comes from **how many CLI invocations one of your
messages turns into**, and every multiplier is a setting you control.

One message in **Auto mode + Multi-agent** is not one `claude -p` run. It is:

| # | Invocation | Where | Model |
|---|---|---|---|
| 1 | Skill/title classifier | `classifyTask()`, `server.js:2707` | `haiku`, `maxTurns: 1`, all tools off |
| 2 | Orchestrator plan | `runMultiAgent()`, `server.js:3757`+ | your model, `maxTurns: 1`, all tools off |
| 3…N+2 | One run per planned agent | `server.js:3909` | your model, full tool budget |
| N+3 | Summariser synthesis | `server.js:3984`+ | your model |

A 4-agent plan is therefore **6 model invocations** for one message, four of them with a full tool
budget. The bare CLI would have been one. That is the bulk of the factor you measured — not a
hidden background job.

On top of that, two multipliers apply *inside* a single run:

- **Auto-continue.** When a run hits `--max-turns`, Studio resumes it automatically up to
  `MAX_AUTO_CONTINUES = 3` (`server.js:2873`). Each continue is another `maxTurns` window on top of
  the first, so the worst case is 4× the turn budget you set, not 1×.
- **System-prompt size.** Active skills are concatenated into the system prompt
  (`buildSystemPrompt`, cached at `server.js:2567`), and every enabled MCP server contributes its
  tool schemas to *every* request. Both are re-sent each turn.

## What is *not* happening

Verified, so you can stop looking for it:

- No periodic model calls. The only `setInterval` jobs in `server.js` are the message queue
  (`:1888`), stats/session bookkeeping (`:1892`, `:1960`), upload cleanup (`:6312`) and SQLite
  maintenance (`:6316`). None of them talks to Claude.
- No automatic context indexing or embedding of your workspace.
- Compaction is manual only — `POST /api/sessions/:id/compact` (`server.js:5850`), i.e. the
  **Compact** button. It never fires on its own.
- Agents are never spawned behind your back. Multi-agent runs only when the session's
  `agent_mode` is set to multi; `single` is the default (`server.js:458`).

## Low-consumption profile

Apply in this order — the first two are worth more than everything after them.

1. **Set `agent_mode` to `single`.** This removes the plan call, the summariser call, and the N−1
   extra agent runs. Largest single saving available.
2. **Turn off Auto mode.** Auto mode adds the Haiku classifier on every message
   (`CLASSIFY_TIMEOUT_MS`, `server.js:2705`). Haiku is cheap, but it is a whole extra CLI spawn per
   message. Pick skills manually instead.
3. **Lower `max_turns`.** Default is 30 (`server.js:495`, `:582`). For focused work 8–12 is
   usually plenty, and it caps the auto-continue blast radius too.
4. **Enable only the MCP servers you are actually using in this chat.** Every server's tool
   schemas ride along on every request of every turn.
5. **Keep the active skill set small.** Skills are `.md` files concatenated verbatim into the
   system prompt; three large skills are three large prompts, re-sent per turn.
6. **Use the effort dial.** `--effort low` (`claude-cli.js:170-176`) buys back a lot of thinking
   tokens on mechanical work.
7. **Pick the model per task.** `haiku` for triage and mechanical edits, `sonnet` as the default,
   `opus` only when it earns it.
8. **Compact long sessions manually** rather than letting a 200-message transcript get re-sent.

If you want the closest possible match to bare-CLI consumption: `single` agent mode, Auto mode off,
no MCP servers, no skills, `max_turns` at the CLI's own default. At that point Studio is a thin UI
over one `claude -p` invocation per message.

## Subscription engine

If you are on a Claude Max plan, the **Subscription** engine (`claude-interactive.js`) runs the CLI
as a persistent interactive process billed against the subscription instead of API credits. It is
not a token optimisation — it is a different billing path. On Claude **Pro**, the API-key engine is
what you have, so the settings above are the lever.

## Measuring it yourself

`--output-format stream-json` gives a `result` event carrying `total_cost_usd` and `usage` per run;
Studio already reads them (`server.js:3218-3219`, `:3447-3448`, `:1693`). The in-app usage dashboard
that surfaces this per session, per agent and per project is tracked separately — see the issue.

Until then, `claude` writes its own transcripts under `~/.claude/projects/<slug>/<session>.jsonl`;
the `usage` field on each assistant event is the ground truth for a given session.
