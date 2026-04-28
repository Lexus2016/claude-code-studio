![Claude Code Studio](public/screenshots/cover.png)

# Claude Code Studio

**The browser interface for Claude Code CLI.** Chat with AI, run tasks on autopilot, and manage your projects — all from one tab.

> [English](README.md) | [Українська](README_UA.md) | [Русский](README_RU.md)

> 📖 [From Terminal to Dashboard](https://www.notion.so/From-Terminal-to-Dashboard-How-Claude-Code-Studio-Changes-AI-Assisted-Development-329676bbc5b6809f9c63e29ca66d8135) | [Remote Access Revolution](https://www.notion.so/Claude-Code-Studio-The-Remote-Access-Revolution-for-AI-Assisted-Development-329676bbc5b68097a5aefac4db29a60d)

> Works on **Windows, macOS, and Linux** — zero platform-specific setup.

---

## Why Claude Code Studio?

Claude Code CLI is powerful — it writes code, runs tests, edits files, and ships features. But it lives in the terminal, and the terminal has limits: context gets lost between sessions, parallel work means juggling tabs, and there's no way to queue tasks and walk away.

Claude Code Studio fixes this:

- **Queue work and walk away** — Kanban board + Scheduler. Claude works while you sleep. Come back to everything done.
- **Control from anywhere** — Telegram bot + Remote Access. Check results from your phone at the gym.
- **Autonomous pipelines** — Tasks create child tasks during execution. One "check issues" task spawns fix tasks automatically.
- **Context never gets lost** — SQLite-backed sessions with self-healing replay. Resume days later, right where you left off.
- **True parallel execution** — Multiple tasks run simultaneously in the same project. No manual tab juggling.

---

## Get Started in 60 Seconds

**Prerequisites:** [Node.js 18+](https://nodejs.org) + [Claude Code CLI](https://docs.anthropic.com/en/claude-code) installed and logged in (Claude Pro or Max subscription)

> **Node.js 22.5+** — zero native compilation. Uses built-in `node:sqlite`, no C++ toolchain needed. Older Node.js versions fall back to `better-sqlite3` (requires build tools).

```bash
npx github:Lexus2016/claude-code-studio
```

Open `http://localhost:3000`, set a password, start chatting.

<details>
<summary><b>Other install methods</b></summary>

**Update:**
```bash
npx github:Lexus2016/claude-code-studio@latest
```

**Install globally:**
```bash
npm install -g github:Lexus2016/claude-code-studio
```

**Clone the repo:**
```bash
git clone https://github.com/Lexus2016/claude-code-studio.git
cd claude-code-studio
npm install && node server.js
```

**Docker:**
```bash
git clone https://github.com/Lexus2016/claude-code-studio.git
cd claude-code-studio
cp .env.example .env
docker compose up -d --build

# Enterprise: pull base image from a private registry (Artifactory, Nexus, Harbor)
MIRROR=my-registry.company.com docker compose up -d --build
```

</details>

<details>
<summary><b>Troubleshooting: npm install from GitHub fails</b></summary>

Some npm versions (especially 10.x) fail when installing git dependencies with this error:

```
npm error --prefer-online cannot be provided when using --prefer-offline
```

This is a known npm bug where conflicting flags are passed during git dependency preparation.

**Workaround — install manually:**
```bash
git clone https://github.com/Lexus2016/claude-code-studio.git
cd claude-code-studio
npm install
npm install -g .   # optional: register the `claude-code-studio` CLI command globally
```

**Or update npm:**
```bash
npm install -g npm@latest
```

</details>

---

![Chat Interface](public/screenshots/02-main-chat.png)

---

## Features

### 💬 Real-Time Chat

Not a chatbot. "Refactor this function and add tests" → Claude opens files, edits them, runs tests, fixes errors, reports back — in real time. Paste screenshots with Ctrl+V. When Claude asks a question mid-task, the card collapses into a compact pill after you answer. Hit **Compact & New** to summarize the conversation via Haiku and continue in a fresh session — all context preserved, zero token waste.

**Sidebar quick-filter** — every sidebar section (Projects, Chats, MCP servers, Skills, Commands) has a 🔽 filter button. Click it, type a few letters — the list narrows instantly. Press Esc to clear.

**Claude CLI session import** — import existing sessions from Claude Code CLI (`~/.claude/projects/`) directly into Studio. Click the ↓ button in the header, pick a project path, select sessions, import. Already-imported sessions are marked so you don't duplicate them. Works on Windows (`C:\...`), macOS, and Linux; supports `~` path expansion.

**Extended thinking** — when Claude uses extended thinking, each thinking block appears as a "Chain of thought" badge showing estimated word count. Click to open the full reasoning in a modal with a copy button. The CLI import modal and thinking modal are fully localized (EN/UA/RU) — all labels, status messages, and dates adapt to the selected interface language.

Thinking blocks are now **fully persistent**: switching tabs mid-generation no longer loses the chain of thought — it's saved to SQLite on completion. Live **thinking badges** appear in real time as Claude reasons, so you can watch the thought process unfold. Imported CLI sessions preserve thinking blocks too, so every past reasoning trace is available for review. Session recovery is also correct: thinking blocks are excluded from the context sent back to Claude on resume, so it never sees its own internal reasoning as a prior message. Press **ESC** to close the thinking modal from the keyboard.

Hit **Translate** inside the thinking modal to render the chain of thought in your interface language — powered by Claude haiku, response cached so re-translate is instant. The **Copy** button always copies whatever is currently displayed (original or translated).

**Mid-task interrupt** — send a clarification or new instruction *while Claude is actively working*, without stopping the current task. A compact `⚡ Clarify` pill appears in the input bar while Claude generates — click it to toggle between **Clarify** (inject into the running stream) and **Queue** (schedule after the current task finishes). Delivery is *guaranteed* via a `PreToolUse` hook: Studio intercepts every tool call and delivers your message before Claude's next action. The badge shows delivery status in real time — "Delivered" when Claude reads it, "Task ended" if the task completed before delivery. **Delivery status is now persisted in SQLite** — reload the page, revisit a session days later, and each interrupt in history correctly shows whether it reached Claude or expired. Badge state is reconciled from the server's authoritative count on task completion — correct in every scenario, including multi-tab and missed real-time events. The pill text updates instantly when you switch the UI language — no page refresh needed. The pill is **SSH-aware**: it stays hidden for remote SSH sessions (where the feature isn't applicable) and disappears immediately when switching from a local project to an SSH one — no stale controls left in the input bar.

**Interrupt attachments** — attach files, screenshots, or SSH configs to any mid-task clarification. Claude receives images as visual content (full multimodal MCP blocks), files as readable paths, and SSH configs with credentials pre-filled. No need to stop the task to share context — everything arrives in the same checkpoint delivery. Works from both the web UI and Telegram.

**Rate limit auto-wait** — when Claude's API responds with a rate limit or overload (429), Studio automatically waits for the reset window and retries — no manual refresh, no lost session. A live countdown appears in the chat: *"Rate limited — retrying in 4m 30s"*. Up to 3 automatic retries, max 30-minute wait, correctly handles stale reset timestamps with a safe minimum floor.

**Session fork** — hit the ↗ button next to any chat to create a full copy that shares the same Claude CLI session history. Branch your conversation at any point — explore alternative approaches without losing the original thread. Works on SSH hosts too.

**Session export / import** — take your chat history anywhere. Export any session as a portable JSON file with one click — full message history, tool calls, timestamps, and attachments included. Import it back into any Studio instance to resume where you left off. The Import button lives on the welcome screen so you can restore a session without having to create one first.

Use cases beyond backup:
- **Transfer between machines** — export on your desktop, import on your laptop or server. Same conversation, different computer.
- **Feed to any AI agent** — drop the exported JSON into ChatGPT, Gemini, or any other AI and say "review what we discussed and let's continue." The format is human-readable and self-contained.
- **Import from any AI** — had a productive session in another tool? Ask it to save the dialog as `{ "session": { "title": "..." }, "messages": [{ "role": "user"|"assistant", "type": "text", "content": "..." }] }` and import the result into Studio. Your conversations aren't locked to one platform.

### 📋 Kanban Board

Create a card, describe what you want, move to "To Do" — Claude picks it up automatically.

![Kanban workflow](public/screenshots/kanban-diagram.png)

Queue 10 tasks, walk away, come back to all done. Cards run **in parallel** (independent tasks) or **sequentially** (chained sessions — Claude remembers what the previous task built). **Cross-tab sync** updates every open browser tab instantly. True parallel execution — no artificial directory locks for independent tasks.

![Kanban Board](public/screenshots/03-kanban.png)

### 🕐 Scheduler — AI on Autopilot

Create a task, set a time — Claude runs it exactly when needed. No cron, no scripts, no babysitting.

- **One-time:** "Deploy to staging at 6am" — done at 6:00 sharp
- **Recurring:** hourly, daily, weekly, monthly — with optional end date
- **Up to 5 parallel workers** — missed times after restart are skipped gracefully

Recurring tasks are **re-armed in place** — the same task record resets to the next scheduled time after each run, instead of creating a new database row. Task IDs stay stable across recurrences, the database doesn't grow unbounded, and crash recovery correctly re-arms interrupted recurring tasks instead of marking them done.

A **60-second watchdog** scans for tasks stuck in `in_progress` with no live worker — if a worker crashed without cleanup, the watchdog recovers the task automatically (re-arms recurring, resets one-shot to `todo`). The task creation form pre-fills the date/time to **right now** — no blank picker to fill in before scheduling.

Color-coded agenda: overdue (red), today (orange), upcoming (blue), recurring (purple). **Run Now** button for instant testing.

### 🤖 Autonomous Task Manager

During task execution, Claude has access to a built-in MCP server for autonomous task management — turning single tasks into self-directing pipelines.

| Tool | What it does |
|------|-------------|
| `create_task` | Spawn a follow-up task. Found 5 bugs? Create 5 fix tasks automatically |
| `create_chain` | Create sequential pipelines (Build → Test → Deploy) in one call |
| `list_tasks` | Check existing tasks — avoid duplicates, monitor progress |
| `get_current_task` | Read your mission and context from the parent task |
| `report_result` | Store structured results for downstream tasks |
| `get_task_result` | Read output from completed dependency tasks |
| `cancel_task` | Cancel redundant tasks (bug already fixed, duplicate work) |

**Example:** Schedule a nightly "check GitHub issues" task. It reads open issues, creates a fix task for each bug, chains a verification task after each fix, and reports a summary. No human in the loop.

Tasks inherit the project directory. Context is passed explicitly — children know exactly what to do. Chain depth is limited to prevent runaway recursion.

### 📱 Telegram Bot — Control from Your Phone

Pair in 30 seconds (6-digit code from Settings). Your phone becomes a full remote control:

- **Queue & monitor:** `/projects`, `/chats`, `/tasks`, `/chat`, `/new`
- **See results:** `/last`, `/full` — plus push notifications when tasks finish or fail
- **Manage:** `/files`, `/cat`, `/diff`, `/log`, `/stop`, `/tunnel`, `/url`
- **Queue & interrupt while busy:** Send a message while Claude is working — it goes directly into the interrupt queue, not a dead-end "busy" reply. Claude picks it up at the next checkpoint. Attach files too.
- **Ask User forwarding:** Claude's mid-task questions appear as Telegram buttons — tap to answer, or send a file/image as your answer
- **Inline Stop:** 🛑 button on every progress message — one tap to cancel
- **Session bridge:** Messages sync to both phone and browser simultaneously
- **Multi-device:** Pair phone, tablet, laptop — all at once
- **✉ Write button:** Quick-compose shortcut in the persistent keyboard — start typing without navigating menus
- **File attachments:** Send photos/files directly in the bot — get size confirmation, then attach your question

**Forum Mode** — Telegram supergroup with Topics. Each project gets its own thread with deep-link navigation between topics. Rich inline action buttons on every message — fully localized in EN/UA/RU — Continue, Diff, Files, History, New session. Auto-creates project topics on demand. Tasks topic for Kanban management. Activity topic with direct URL buttons to jump into any project.

Forum Mode is now powered by a **dedicated standalone module** (`telegram-bot-forum.js`). Each project topic runs in fully isolated per-thread state — switching between projects in different threads never leaks context or session data. Rock-solid multi-project setup, even across a dozen simultaneous Forum topics. The **Open Chat** button always uses a callback so the bot properly switches session context and shows a live chat preview — not just a raw topic URL jump.

![Telegram Forum Mode](public/screenshots/tg_forum.jpg)

### 👥 Agent Modes

| | Single | Multi | Dispatch |
|---|---|---|---|
| Where | Chat | Chat | Kanban board |
| Agents | 1 | 2–5 parallel | 2–5 as task cards |
| Dependencies | — | Basic | Full DAG |
| Auto-retry | No | No | Yes (with backoff) |
| Survives restart | No | No | Yes (SQLite) |
| Best for | Focused work | Complex tasks to watch | Background batch work |

**Multi** — orchestrator decomposes into 2–5 subtasks with real-time streaming. The planning step uses `--json-schema` structured output — the plan JSON is guaranteed to parse without regex extraction, even with complex prompts. Send plan to Kanban with 📋 button.
**Dispatch** — subtasks go to Kanban as persistent cards with dependency graphs, auto-retry, and cascade cancellation. Effort level set in chat flows to all dispatched tasks automatically.

### ⇗ Cross-Agent Delegation

Send tasks to external AI CLIs — OpenAI Codex, Gemini CLI, opencode, Aider — directly from the chat interface. Two modes:

| | Handoff | Sync |
|---|---|---|
| Workflow | Fire-and-forget | Parallel collaboration |
| Communication | One-way context transfer | Bi-directional via DIALOG.md |
| Monitoring | Manual check | Auto-polling every 15s + fs.watch |
| Best for | Independent tasks | Tasks requiring back-and-forth |

How it works: click **Delegate** in the session bar, pick an agent and mode, describe the task. Studio generates a `CONTEXT.md` with conversation history and opens a terminal with the external agent. In Sync mode, both agents communicate through a shared `DIALOG.md` — responses appear directly in the main chat with real-time notifications.

**Agents sidebar** — managing external agents is now effortless. A dedicated **Agents** section in the sidebar lets you add, edit, and delete agents without touching `config.json`. Codex, Gemini CLI, and opencode come **pre-configured out of the box** — seeded automatically on first run. Hit the **Test** button next to any agent to verify connectivity before delegating. Agent IDs auto-generate from the label (with Cyrillic transliteration), and the full UI is localized in EN/UA/RU. Works on **Windows** too — delegation now routes through `cmd.exe` with proper shell escaping. Delegations survive server restarts via persistent state files.

### 🎛 Chat Modes

**Auto** — full tool access (default). **Plan** — read-only analysis; produces an **Execute Plan** button to switch to Auto and run it. Auto Plan Detection switches modes automatically when Claude signals completion. **Task** — explicit execution mode.

### 🧠 Skills & Auto-Skills

28 built-in specialist personas (frontend, security, devops, kubernetes, debugging, code-review...). **Auto mode (⚡)** classifies each message and activates 1–4 relevant skills automatically:

- "Fix this React bug" → `frontend` + `debugging-master`
- "Set up K8s deployment" → `devops` + `kubernetes` + `docker`

Plugin skills auto-discovered from installed Claude Code plugins. Add custom `.md` files to `skills/`.

### ⚡ Slash Commands

Type `/` — pick a saved prompt. 8 built-in:

| `/check` | `/review` | `/fix` | `/explain` |
|-----------|-----------|--------|------------|
| Syntax & bugs | Full code review | Find & fix bug | Explain with examples |
| **`/refactor`** | **`/test`** | **`/docs`** | **`/optimize`** |
| Clean up code | Write tests | Write docs | Find bottlenecks |

Add your own, edit them, delete them. As many as you want.

### ⚙️ Model & Turns

| Model | Context | Best for |
|-------|---------|----------|
| **Haiku** | Standard | Fast — simple questions, quick checks |
| **Sonnet** | **1M tokens** | Balanced (default) — most everyday tasks |
| **Opus** | **1M tokens** | Most capable — complex architecture, hard bugs |

Sonnet and Opus run with a **1 million token context window** — entire large codebases, long conversation histories, and massive file sets fit in a single session without hitting limits.

Turn budget: 1–200 (default 50). Auto-continues up to 3x — so 50 turns effectively means up to 200 steps.

**Thinking effort dial** — a new `Effort` dropdown in the chat toolbar (and task/chain forms) lets you tune how hard Claude thinks before responding: `Auto` (CLI default), `Low`, `Med`, `High`, `X-High`, or `Max`. Your selection persists across reloads via localStorage. The effort level flows automatically to every subtask and chain — set it once, runs everywhere.

### 🌐 Remote Access & SSH

**SSH** — add remote servers, create projects pointing to directories on them. Claude works there as if local. Type `#` in chat for quick multi-server attachment. Screenshots and files auto-upload via SFTP.

**Remote Access** — one click: cloudflared (no signup) or ngrok. Public HTTPS URL in seconds. Works behind NAT, firewalls, corporate VPNs. URL sent to Telegram automatically.

### 📊 Dashboard

![Dashboard](public/screenshots/dashboard.jpg)

Activity heatmap (90 days), tool usage breakdown, model distribution, Automation Index (0–100), peak hours, top sessions with one-click navigation. Every number links to real data.

### 📱 Mobile-Ready

Open the URL on your phone — native-feel interface. Mobile header with live status indicator, bottom sheet settings, scroll-snap Kanban columns, touch-optimized 44px targets, iOS-safe. Not a "mobile version" — the real interface, redesigned for touch.

---

## Who is it for?

**Developers** — Multiple projects, task queues, session continuity. Schedule nightly tests. Let Claude work the night shift.

**Teams** — Shared instance with project visibility, Kanban audit trail, recurring Monday code reviews.

**Sysadmins** — Server fleet management from one tab. Scheduled health checks, security scans, multi-server operations with Telegram alerts.

**ML/AI Engineers** — Remote GPU servers via SSH. Queued training jobs. Scheduled data pipelines. Phone monitoring via Telegram.

---

## What this is (and isn't)

- **Not a SaaS** — runs on your machine. No account, no telemetry, no vendor lock-in.
- **Not an IDE** — manages Claude sessions. Keep using VS Code, Cursor, or whatever you prefer.
- **Not a fork** — wraps the official CLI. Anthropic updates flow through automatically.

MIT licensed. Your infrastructure, your data.

---

## Using OpenRouter Models

Use **[Claude Flow](https://github.com/Lexus2016/claude-flow)** to route through [OpenRouter](https://openrouter.ai) — GPT-4o, Gemini, Llama, Mistral, and more:

```bash
npx github:Lexus2016/claude-flow          # one-time setup
npx github:Lexus2016/claude-code-studio    # launch as usual
```

---

## Feature Reference

| Category | Features |
|----------|----------|
| **Chat** | Real-time streaming, screenshot paste, file attach (`@file`), conversation fork, auto-continue (3x), session compact, sidebar quick-filter, CLI session import, extended thinking display, session export/import (JSON), mid-task interrupt (PreToolUse hook + attachments), session fork, rate limit auto-wait, effort dial, session name in `/resume` picker |
| **Kanban** | Task queue, parallel + sequential, cross-tab sync, drag-and-drop tabs, dependency graphs, effort dial per task/chain |
| **Scheduler** | One-time + recurring (hourly/daily/weekly/monthly), 5 parallel workers, Run Now, SQLite-persisted, effort dial per task, watchdog auto-recovery |
| **Task Manager** | Autonomous child tasks, chains, context passing, result reporting, cancellation (MCP) |
| **Telegram** | Bot control, push notifications, ask_user forwarding (+ file answers), session bridge, Forum Mode, inline stop, deep-link navigation, rich action buttons (localized EN/UA/RU), Write button, file attachments, interrupt queue while busy |
| **Delegation** | Cross-agent handoff/sync (Codex, Gemini, opencode), CONTEXT.md + DIALOG.md protocol, fs.watch + polling, persistent across restarts, Windows support, sidebar agents manager, auto-seeded defaults, test button |
| **Agents** | Single, Multi (2–5 in-chat, schema-validated planning), Dispatch (Kanban), auto-retry, cascade cancellation, effort propagation |
| **Modes** | Auto, Plan (read-only + Execute Plan), Task, auto mode switching |
| **Skills** | 28 built-in, auto-classification, plugin discovery, custom `.md` files |
| **Commands** | 8 built-in slash commands, custom commands |
| **Remote** | SSH servers, SFTP upload, `#` quick-attach, cloudflared/ngrok tunnels |
| **Mobile** | Native-feel UI, bottom sheet, scroll-snap Kanban, iOS-safe, touch-optimized |
| **Dashboard** | Activity heatmap, tool usage, model distribution, Automation Index, peak hours |
| **Reliability** | Self-healing sessions, crash protection, atomic writes, instant stop, rate limit auto-wait, concurrency safety (session lock + busy_timeout), orphaned session lock auto-cleanup |
| **Security** | bcrypt auth, AES-256-GCM SSH, Helmet.js, path traversal protection, XSS/SQLi prevention |
| **Platform** | Windows/macOS/Linux, Docker (non-root, registry mirror), LLM proxy/gateway, 3 languages (EN/UA/RU), OpenRouter support |

---

## Technical Details

**Architecture** — Single Node.js process. No build step. No TypeScript. No framework.

```
server.js              — Express HTTP + WebSocket
auth.js                — bcrypt passwords, 32-byte session tokens
claude-cli.js          — spawns `claude` subprocess, parses JSON stream
telegram-bot.js        — Telegram bot (Direct Mode)
telegram-bot-forum.js  — Forum Mode standalone module (composition pattern)
mcp-task-manager.js    — MCP server for autonomous task management
mcp-notify.js          — MCP server for non-blocking notifications
public/index.html      — entire frontend (HTML + CSS + JS)
config.json            — MCP servers + skills catalog
data/chats.db          — SQLite (WAL mode)
skills/                — .md skill files → system prompt
```

**Environment:**

```env
PORT=3000
WORKDIR=./workspace
MAX_TASK_WORKERS=5
CLAUDE_TIMEOUT_MS=1800000
TRUST_PROXY=false
LOG_LEVEL=info
ANTHROPIC_BASE_URL=       # LLM proxy/gateway (LiteLLM, Bifrost, OpenRouter)
```

**Security:** bcrypt (12 rounds), 32-byte tokens (30-day TTL), AES-256-GCM for SSH passwords, Helmet.js headers, path traversal protection, XSS filtering, parameterized SQL queries, 2MB buffer caps.

**Development:**

```bash
npm run dev   # auto-reload (node --watch)
npm start     # production
```

---

## License

MIT
