# Claude Code Studio

**A web interface for Claude Code** — chat with AI, manage tasks on a Kanban board, run multiple agents in parallel, and automate your entire development workflow. No coding skills required to get started.

> Available in: [English](README.md) | [Українська](README_UA.md) | [Русский](README_RU.md)

---

## What is this?

Claude Code Studio is a browser-based workspace that lets you work with [Claude Code](https://claude.ai/code) — Anthropic's AI coding assistant — without using a terminal. You open it in your browser, type what you want done, and Claude does it.

**Think of it as a control panel for your AI assistant:**
- 💬 Chat with Claude and see the work happen in real time
- 📋 Create task cards on a Kanban board — Claude picks them up and runs them automatically
- 👥 Run multiple agents working in parallel on different tasks
- 📁 Browse files, paste images, attach documents — all from the browser
- 🔌 Connect MCP servers and custom skill files to extend Claude's capabilities

---

## Demo Video

Watch how the Kanban board works: create a task card for a new release → Claude Code picks it up → runs the task → card moves to Done. At the end you can see the actual GitHub release before and after — the agent really did ship the new version.

![Demo GIF](public/videos/new_release_video.gif)

<video src="public/videos/new_release_video.mp4" controls width="100%"></video>

> **Can't see the video?** [Download and watch it directly](public/videos/new_release_video.mp4)

---

## Screenshots

### Login Screen
A clean, secure login page. On first launch you set your own password.

![Login Screen](public/screenshots/01-login.png)

### Chat Interface
Real-time conversation with Claude Code. Supports markdown, code blocks with syntax highlighting, MCP server toggles, skill presets, file browser, and model selector — all in one dark-themed page.

![Chat Interface](public/screenshots/02-main-chat.png)

### Kanban Board
Drag a card to "To Do" and Claude starts working on it automatically. See live output, retry on crash, link cards to chat sessions, and track everything in one place.

![Kanban Board](public/screenshots/03-kanban.png)

---

## Quick Start (3 steps)

**Requirements:** [Node.js 18+](https://nodejs.org) and the [`claude` CLI](https://docs.anthropic.com/en/claude-code) installed and logged in.

```bash
# 1. Run it instantly (no installation needed)
npx github:Lexus2016/claude-code-studio

# 2. Open your browser
# → http://localhost:3000

# 3. Set your password on first launch, then start chatting
```

That's it. To run it again later, just repeat step 1.

---

## Installation Methods

### Option A — Run with npx (easiest, no install)

```bash
npx github:Lexus2016/claude-code-studio
```

**Update to latest version:**
```bash
npx github:Lexus2016/claude-code-studio@latest
```

---

### Option B — Install globally (run anytime)

```bash
npm install -g github:Lexus2016/claude-code-studio
claude-code-studio
```

**Update:**
```bash
npm install -g github:Lexus2016/claude-code-studio@latest
```

---

### Option C — Clone the repo (for developers)

```bash
git clone https://github.com/Lexus2016/claude-code-studio.git
cd claude-code-studio
npm install
cp .env.example .env
node server.js
```

Open `http://localhost:3000` in your browser.

**Update:**
```bash
git pull && npm install && node server.js
```

---

### Option D — Docker

```bash
git clone https://github.com/Lexus2016/claude-code-studio.git
cd claude-code-studio
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:3000`. Logs: `docker compose logs -f claude-chat`

**Update:**
```bash
git pull && docker compose up -d --build
```

---

## What Can It Do?

| Feature | What it means for you |
|---------|----------------------|
| 💬 **Real-time Chat** | Talk to Claude, see responses stream in as it thinks and works |
| 📋 **Kanban Board** | Create task cards → Claude runs them automatically, one by one or in parallel |
| 👥 **Multi-Agent Mode** | Claude spawns a team of specialized agents and coordinates them for big tasks |
| 🚀 **Task Dispatch** | Decompose a plan into chained Kanban tasks with dependencies — auto-retry on failure |
| ↗️ **Fork Conversation** | Continue any message in a new chat with full context — perfect for multi-agent sessions |
| ⚡ **MCP Servers** | Connect external tools (databases, GitHub, Slack, etc.) so Claude can use them |
| 🧠 **Skills** | Upload `.md` files that tell Claude how to work in your specific domain |
| 📁 **File Browser** | Browse your project files, preview them, attach with `@filename` in chat |
| 🖼 **Vision** | Paste screenshots from clipboard — Claude can see and analyze images |
| 🗂 **Projects** | Separate projects with their own working directories and chat history |
| 🌐 **Remote SSH Projects** | Connect to remote servers, create projects there, run Claude commands on remote machines |
| 🔄 **Auto-Continue** | Agent hits the turn limit? It automatically resumes and keeps working (up to 3 times) |
| 💾 **History** | All sessions saved to SQLite — resume any conversation where you left off |
| 📊 **Rate Limit Alerts** | Toast warnings at 80/90/95%, blocking modal when exhausted, live countdown to reset |
| 🔒 **Auth** | Password login + 30-day session tokens. Your data stays on your machine |
| 🌍 **i18n** | Interface in English, Ukrainian, or Russian (auto-detected) |
| 🐳 **Docker** | Deploy anywhere with the included Dockerfile and docker-compose |

---

## Why Claude Code Studio?

You could use `claude` in a terminal. So why use this?

### 🖱️ Visual > Terminal

| Terminal | Claude Code Studio |
|----------|-------------------|
| Type long commands | Click buttons, drag cards |
| Scroll through text | See live progress in cards |
| No task management | Built-in Kanban board |
| One session at a time | Multiple parallel sessions |
| Copy-paste screenshots | Paste directly in chat |
| Remember context yourself | Sessions saved automatically |

### ⚡ Productivity Boost

- **Kanban board**: Queue 10 tasks, walk away, come back to all done
- **Multi-agent**: Big task? Claude spawns a team and coordinates them
- **Fork conversations**: Branch off from any point without losing context
- **Projects**: Switch between codebases without losing your place
- **Auto-continue**: Agent hits the turn limit mid-task? It resumes automatically — no manual intervention
- **Session persistence**: Come back tomorrow, continue exactly where you were

### 🎯 Built for Workflows

Terminal is great for quick questions. But when you have:
- Multiple tasks to track
- Long-running operations
- Screenshots to analyze
- Parallel work streams
- A team that needs visibility

...you need a **dashboard**, not a command line.

---

## Kanban Board — How It Works

Go to `/kanban` in your browser (or click the board icon in the sidebar).

### Basic flow
1. **Create a card** — give it a title and describe what Claude should do
2. **Move it to "To Do"** — Claude picks it up automatically and starts working
3. **Watch the progress** — click the card to see the live chat output
4. **Card moves to "Done"** — when the task is complete, the card advances on its own

### Parallel vs Sequential tasks

When creating a card you choose whether to link it to a **new session** or an **existing one**:

| | New session | Same session as another card |
|---|---|---|
| **Context** | Fresh start — Claude doesn't know about other tasks | Shared — Claude remembers what the previous card did |
| **Execution** | **Runs in parallel** with other new-session cards | **Runs after** the previous card in that session finishes |
| **Use when** | Tasks are independent | One task needs the result of another |

**Example — parallel (independent tasks):**
```
Card: "Add login page"          → New session
Card: "Redesign dashboard"      → New session
```
Both run at the same time in separate Claude processes.

**Example — sequential (dependent tasks):**
```
Card: "Create /users API"       → New session #14
Card: "Write tests for the API" → Existing session #14
```
Card 2 waits for Card 1 to finish, then runs with full context of what was built.

> **Rule of thumb:** if you'd ask these in one chat conversation, link them to the same session. If you'd open two separate chats, use new sessions.

---

## Remote Access: For Developers & Server Administrators

Claude Code Studio connects to remote servers over SSH and runs Claude Code there — as if it were local. **All commands execute on the remote machine.** This opens two distinct use cases:

### 👨‍💻 For Developers — Remote Projects

Work on code that lives on a powerful remote machine (staging server, GPU box, cloud VPS) without leaving your browser:

| Scenario | Benefit |
|----------|---------|
| **Powerful build machines** | Compile, train, test on GPU/high-RAM servers — your laptop stays fast |
| **Staging/production parity** | Run Claude Code in the same environment where code will actually run |
| **Always-on background agent** | Leave a task running on the server overnight — check results in the morning |
| **Team shared workspace** | One Claude Code Studio instance, multiple teammates, same project visibility |

### 🖥️ For Server Administrators — Remote Server Control

This is where Claude Code Studio becomes something no sysadmin tool has offered before: **a conversational interface to your entire server fleet.**

Install Claude Code on each server you manage. Add them as SSH hosts. Now, instead of SSH-ing into servers and running commands manually, you open a browser and **talk to Claude Code running directly on the server**.

| What you delegate to Claude | What Claude does on the server |
|-----------------------------|-------------------------------|
| "Update nginx to 1.27 and reload" | Checks current version, updates package, tests config, reloads service |
| "Check disk usage and clean old logs" | Runs `df`, finds large/old files, removes safely, reports freed space |
| "Deploy the new release and rollback if health check fails" | Pulls, builds, restarts, health-checks, auto-rolls back on failure |
| "What's consuming CPU right now?" | Runs `top`/`htop`, analyzes, explains, suggests fixes |
| "Rotate the API keys in all config files" | Finds all occurrences, updates atomically, restarts affected services |
| "Set up a cron job to backup the database nightly" | Writes script, sets up cron, verifies it's registered |

**The result:** You manage your entire server fleet from one browser tab. No terminal juggling. No SSH sessions. Just a conversation.

```
Traditional sysadmin session:         Claude Code Studio session:
────────────────────────────          ──────────────────────────────────
ssh user@prod-eu-01                   Open browser
sudo apt update && apt upgrade -y     Type: "Update all packages on prod-eu-01,
sudo systemctl restart nginx               check for errors, and send me a summary"
sudo journalctl -u nginx -n 50        Claude: runs it, shows output, flags issues
exit
ssh user@prod-eu-02                   Type: "Do the same on prod-eu-02 and prod-us-01"
... repeat for every server ...       Claude: runs in parallel on both servers
```

### Quick Setup

**Step 0 — Prepare the remote server (one-time):**

Use the bundled setup scripts to install and configure Claude Code on the remote machine:

```bash
# Ubuntu / Debian / RHEL / CentOS (run as root):
curl -fsSL https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-linux.sh | bash

# macOS:
curl -fsSL https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-macos.sh | bash

# Windows (PowerShell as Administrator):
irm https://raw.githubusercontent.com/Lexus2016/claude-code-studio/main/install/setup-windows.ps1 | iex
```

Each script installs Node.js, Claude Code CLI, configures authentication, and creates a workspace. See [`install/README.md`](install/README.md) for details.

**Steps:**

1. **Add the remote host** (one-time per server)
   - Left sidebar → ⚙️ Settings → **Remote Hosts**
   - Click **+ Add Host** → enter hostname, port, SSH key
   - Click **Test Connection** to verify

2. **Create a Remote Project**
   - Left sidebar → 🗂 Projects → **+ New Project**
   - Select **Remote** type → choose the SSH host
   - Enter the directory path on the remote server
   - Click **Create**

3. **Work normally**
   - Chat, Kanban board, file browser — all operations run on the remote machine
   - Sessions and history are stored locally in Claude Code Studio

### Example: Managing 5 Production Servers

```
Goal: update nginx on all 5 servers and verify.

1. Add 5 hosts: prod-eu-01 ... prod-eu-05 via Settings → Remote Hosts
2. Create a Remote Project for each server pointing to /etc/nginx
3. Open 5 Kanban cards in parallel:
   → "Update nginx to 1.27, test config, reload, run health check"
4. All 5 run simultaneously. Watch live output per server.
5. Any failure → card stays in "In Progress" with error details

Result: 5 servers updated and verified in ~3 minutes, zero manual SSH.
```

### Example: GPU Server for ML Tasks

```
You have a beefy ML server (GPU, 256GB RAM).
Claude Code Studio on your laptop can't handle training tasks locally.

→ Add remote host: ml-server.internal
→ Create Remote Project → /home/ml/projects
→ Chat: "Download the dataset, preprocess it, train the model"
→ Claude runs on ml-server: uses GPU, accesses data locally, completes fast
→ You see live output streaming in your browser — laptop runs normally
```

### SSH Security

- **Passwords encrypted at rest:** SSH passwords are stored using AES-256-GCM encryption — never in plain text. The encryption key lives in `data/hosts.key` (never committed to git)
- **SSH keys stored locally:** Key files stay on your disk; only used at connection time, never copied or stored elsewhere
- **No key forwarding:** Keys are used only for establishing the connection
- **Connection testing:** Always test your connection before creating projects

---

## Multi-Instance Safety (File Locks)

If you run multiple Claude Code processes on the same project at the same time, they might try to edit the same file simultaneously — which can cause data loss.

Claude Code Studio solves this automatically with **file-lock hooks**:

- Before Claude edits any file → it checks if another Claude process is already editing it
- If yes → it waits until the file is free (checks every 3 seconds)
- After editing → it releases the lock so the next process can continue
- Crashed processes → stale locks are detected and cleared automatically

```
Claude A (task 1)          Claude B (task 2)
──────────────────         ──────────────────────────
Edit server.js             Edit server.js  ← same time
→ acquires lock            → waits (lock is taken)
→ edits file ✓              ⏳ checking every 3s...
→ releases lock            → lock free! acquires it
                           → edits file ✓
```

Hooks are installed automatically on `npm install`. Works on macOS, Linux, and Docker.

---

## Configuration

### Environment variables (`.env`)

Copy `.env.example` to `.env` and adjust as needed:

```env
PORT=3000                    # Port to run on
WORKDIR=./workspace          # Where Claude works (your project files)
MAX_TASK_WORKERS=5           # Max parallel Claude processes for Kanban
CLAUDE_TIMEOUT_MS=1800000    # Max time per task in ms (default: 30 minutes)
TRUST_PROXY=false            # Set true if running behind nginx/Caddy
LOG_LEVEL=info               # Logging: error | warn | info | debug
```

For SDK engine (optional, if you want to use an API key instead of `claude` CLI):
```env
ANTHROPIC_API_KEY=sk-ant-...
```

### Adding MCP servers
Open the left panel → ⚡ MCP → **+ Add MCP**

### Adding Skills
Open the left panel → 🧠 Skills → **+ Upload .md**

Or drop `.md` files directly into the `skills/` folder and restart.

### Projects
Left panel → 🗂 Projects → **+ New Project**

Each project has its own working directory. Sessions are scoped to projects.

---

## Security

- Passwords are hashed with bcrypt (12 rounds) — never stored in plain text
- Auth tokens: 32-byte random hex, 30-day expiry, server-side storage
- WebSocket protected by `httpOnly` cookie
- API keys never sent to the browser
- **SSH passwords encrypted with AES-256-GCM** — key stored in `data/hosts.key`, never in the database
- Helmet.js security headers on all responses
- Rate limiting on login endpoints

---

## Development

```bash
npm run dev    # auto-reload on file changes (node --watch)
npm start      # production start
```

No build tools, no TypeScript, no linting config — vanilla JS frontend, plain Node.js backend. Open `public/index.html` to see the entire frontend.

---

## Project Structure

```
claude-code-studio/
├── server.js           ← main server (Express + WebSocket)
├── auth.js             ← login, password hashing, session tokens
├── claude-cli.js       ← spawns claude subprocess, parses output stream
├── claude-ssh.js       ← SSH remote execution (ssh2, password encrypted at rest)
├── config.json         ← MCP servers + skills catalog
├── public/
│   ├── index.html      ← entire frontend (single file: HTML + CSS + JS)
│   └── auth.html       ← login/setup page
├── skills/             ← .md skill files loaded into Claude's system prompt
├── data/               ← runtime data (gitignored)
│   ├── chats.db        ← SQLite database (sessions + messages)
│   └── auth.json       ← password hash
└── workspace/          ← default Claude working directory (gitignored)
```

---

## License

MIT
