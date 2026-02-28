# Claude Code Studio

**The browser interface for Claude Code.** Chat with AI, run tasks automatically, and manage your work — all from one tab, without touching the terminal.

> Available in: [English](README.md) | [Українська](README_UA.md) | [Русский](README_RU.md)

---

## What is Claude Code Studio?

Claude Code is Anthropic's AI that can actually write code, run commands, edit files, and ship features — not just talk about them.

The problem: it lives in your terminal. For a lot of people, that's a barrier. And even for developers, the terminal has limits — no task board, no parallel sessions, no visual file browser, no way to paste a screenshot.

**Claude Code Studio is the missing UI.** You open it in your browser, and your AI starts working.

---

## What does it actually do?

### 💬 Chat that does things

Not a chatbot. When you type "refactor this function and add tests", Claude opens files, edits them, runs the tests, fixes errors, and reports back — in real time, right in the chat.

### 📋 Kanban board for your tasks

Create a card. Describe what you want. Move it to "To Do". Claude picks it up automatically and starts working. You can queue 10 tasks, walk away, come back to all of them done.

![Demo GIF](public/videos/new_release_video.gif)

> **Can't see the video?** [Download it directly](public/videos/new_release_video.mp4)

### ⚡ Slash commands — your personal shortcuts

Type `/` in the chat input and a menu appears with your saved prompts. Pick one, hit Enter — done.

Instead of typing "Do a thorough code review: readability, performance, security, and adherence to best practices. Point out issues with severity levels" every time, you just type `/review`.

**8 commands ready to use out of the box:**

| Command | What it does |
|---------|-------------|
| `/check` | Check syntax, logic, edge cases, and bugs step by step |
| `/review` | Full code review with severity levels (critical / warning / suggestion) |
| `/fix` | Find the bug, fix it, explain what changed |
| `/explain` | Explain the code clearly with examples |
| `/refactor` | Clean up the code, keep the same behavior |
| `/test` | Write tests: happy path, edge cases, error scenarios |
| `/docs` | Write documentation with examples and gotchas |
| `/optimize` | Find bottlenecks, propose improvements, estimate gains |

You can edit these, delete them, and add your own. As many as you want.

### 👥 Multiple agents working at once

Big task? Claude doesn't work alone. It creates a team of specialized agents, assigns subtasks, and coordinates the work — like a project manager with infinite interns.

### 🖼 Paste a screenshot, get an answer

Press Ctrl+V in the chat. Claude sees the image and responds. Useful for UI feedback, error screenshots, diagrams — anything visual.

### 🌐 Remote servers over SSH

Add a remote server, create a project pointing to a directory on that server, and Claude works there — as if it were local. Useful for GPU machines, staging servers, or server administration without SSH sessions.

### 💾 Everything is saved

Sessions, chats, task history — all stored locally in SQLite. Come back tomorrow, continue exactly where you left off.

---

## Screenshots

### Chat
![Chat Interface](public/screenshots/02-main-chat.png)

### Kanban Board
![Kanban Board](public/screenshots/03-kanban.png)

---

## Get started in 60 seconds

You need [Node.js 18+](https://nodejs.org) and the [`claude` CLI](https://docs.anthropic.com/en/claude-code) installed and logged in.

```bash
npx github:Lexus2016/claude-code-studio
```

Open `http://localhost:3000`, set your password on first launch, start chatting.

**To update:**
```bash
npx github:Lexus2016/claude-code-studio@latest
```

---

## Other ways to install

**Install globally** — run `claude-code-studio` from anywhere:
```bash
npm install -g github:Lexus2016/claude-code-studio
```

**Clone the repo** — for developers who want to dig in:
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
```

---

## Full feature list

| Feature | What it means |
|---------|--------------|
| 💬 Real-time chat | Responses stream in as Claude thinks and works |
| 📋 Kanban board | Queue tasks → Claude runs them automatically |
| ⚡ Slash commands | Saved prompt shortcuts with `/` autocomplete |
| 👥 Multi-agent mode | Claude spawns a team for complex tasks |
| 🔄 Auto-continue | Hits turn limit mid-task? Resumes automatically |
| ↗️ Fork conversation | Continue from any message in a new chat |
| 🔌 MCP servers | Connect GitHub, Slack, databases, and more |
| 🧠 Skills | `.md` files that tell Claude how to work in your domain |
| 📁 File browser | Browse, preview, and attach files with `@filename` |
| 🖼 Vision | Paste screenshots — Claude sees and analyzes them |
| 🗂 Projects | Separate workspaces with their own file directories |
| 🌐 Remote SSH | Work on remote servers as if they were local |
| 💾 History | Everything saved to SQLite, resume anytime |
| 📊 Rate limit alerts | Warnings at 80/90/95%, live countdown to reset |
| 🔒 Auth | Password login, 30-day tokens, data stays on your machine |
| 🌍 3 languages | English, Ukrainian, Russian (auto-detected) |
| 🐳 Docker | Deploy anywhere with Dockerfile + compose |

---

## Technical details

For developers who want to understand or modify how it works.

### Architecture

Single Node.js process. No build step. No TypeScript. No framework.

```
server.js        — Express HTTP + WebSocket
auth.js          — bcrypt passwords, 32-byte session tokens
claude-cli.js    — spawns `claude` subprocess, parses JSON stream
public/index.html — entire frontend (HTML + CSS + JS in one file)
config.json      — MCP server definitions + skills catalog
data/chats.db    — SQLite: sessions + messages
skills/          — .md skill files loaded into system prompt
workspace/       — Claude's working directory
```

### Environment variables

```env
PORT=3000
WORKDIR=./workspace
MAX_TASK_WORKERS=5
CLAUDE_TIMEOUT_MS=1800000
TRUST_PROXY=false
LOG_LEVEL=info
ANTHROPIC_API_KEY=sk-ant-...   # SDK engine only, optional
```

### Two engines

- **CLI engine** — spawns `claude` subprocess. Uses your Claude Max subscription. No API key needed.
- **SDK engine** — calls `@anthropic-ai/claude-code` SDK directly. Requires `ANTHROPIC_API_KEY`.

### Security

- Passwords: bcrypt, 12 rounds
- Tokens: 32-byte random hex, 30-day TTL, server-side storage
- SSH passwords: AES-256-GCM encrypted at rest
- API keys: never sent to the browser
- Headers: Helmet.js on all responses
- File access: path traversal protection on all file operations

### Development

```bash
npm run dev   # auto-reload (node --watch)
npm start     # production
```

---

## License

MIT
