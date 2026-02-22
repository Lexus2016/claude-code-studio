# Claude Code Chat

**Lightweight web UI for [Claude Code](https://claude.ai/code)** — chat with Claude directly in the browser, with multi-agent orchestration, MCP servers, skill files, and persistent SQLite history. No build step required.

> Available in: [English](README.md) | [Українська](README_UA.md) | [Русский](README_RU.md)

---

## Features

| Feature | Description |
|---------|-------------|
| 🖥 CLI Mode | Works via `claude` CLI with Max subscription (no API costs) |
| 🔌 SDK Mode | Works via Anthropic API key (pay-per-token) |
| 💬 Real-time Chat | WebSocket streaming with markdown rendering |
| 👥 Multi-Agent | Orchestrate a team of agents with dependency graph |
| ⚡ MCP Servers | Connect any MCP server — presets + custom |
| 🧠 Skills | Load `.md` skill files into Claude's system prompt |
| 🔄 Modes | Auto / Planning / Task execution modes |
| 💎 Models | Opus 4.6 / Sonnet 4.6 / Haiku 4.5 |
| 📁 File Browser | Browse workspace, preview files, attach via `@mention` |
| 🖼 Vision | Paste images from clipboard, send as vision blocks |
| 📋 History | Persistent sessions in SQLite, resumable |
| ⚙️ Config Editor | Edit `config.json`, `CLAUDE.md`, `.env` in the UI |
| 🔒 Auth | bcrypt password + 30-day session tokens |
| 🐳 Docker | Dockerfile + docker-compose included |

---

## Installation & Running

### Method 1 — Run instantly with npx (no install)

The easiest way. Downloads and runs the latest release directly:

```bash
npx github:Lexus2016/claude-code-chat
# Open http://localhost:3000
```

Or install globally and run any time:

```bash
npm install -g github:Lexus2016/claude-code-chat
claude-code-chat
# Open http://localhost:3000
```

**How to update:**
```bash
npm install -g github:Lexus2016/claude-code-chat@latest
```

---

### Method 2 — git clone (full control)

**Prerequisites:**
- Node.js 18+
- [`claude` CLI](https://docs.anthropic.com/en/claude-code) installed and authenticated (for CLI mode)
- OR an `ANTHROPIC_API_KEY` in `.env` (for SDK mode)

```bash
git clone https://github.com/Lexus2016/claude-code-chat.git
cd claude-code-chat
npm install

# CLI mode (Max subscription, no API key needed):
claude --version    # confirm claude CLI is authenticated
node server.js

# SDK mode (API key required):
cp .env.example .env
# Edit .env → set ANTHROPIC_API_KEY=sk-ant-...
node server.js

# Open http://localhost:3000
# First launch: create a password
```

**How to update:**
```bash
git pull
npm install
node server.js
```

---

### Method 3 — Docker

```bash
git clone https://github.com/Lexus2016/claude-code-chat.git
cd claude-code-chat

cp .env.example .env
# Edit .env as needed

docker compose up -d --build
docker compose logs -f claude-chat
# Open http://localhost:3000
```

**How to update:**
```bash
git pull
docker compose up -d --build
```

---

## Project Structure

```
claude-code-chat/
├── server.js           # Express + WebSocket server (main entry point)
├── auth.js             # bcrypt auth, 30-day token sessions
├── claude-cli.js       # Spawns claude CLI subprocess, parses JSON stream
├── config.json         # MCP server definitions + skills catalog
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example        # Environment variable template
├── public/
│   ├── index.html      # Single-file SPA (embedded CSS + JS)
│   └── auth.html       # Login / Setup page
├── skills/             # Skill .md files (loaded into system prompt)
├── data/               # Runtime data (gitignored)
│   ├── chats.db        # SQLite database
│   ├── auth.json       # bcrypt password hash
│   └── sessions-auth.json
└── workspace/          # Claude Code working directory (gitignored)
```

---

## Configuration

### Environment Variables (`.env`)

```env
PORT=3000
SESSION_SECRET=           # Auto-generated if empty
WORKDIR=./workspace       # Claude's working directory
TRUST_PROXY=false         # Set true behind nginx/Caddy
```

### CLI vs SDK

| | CLI (Max) | SDK (API Key) |
|---|---|---|
| Cost | Max subscription | Per-token billing |
| Session resumption | `--resume <id>` | SDK session |
| Streaming | stdout JSON parsing | Native |
| Stability | CLI version dependent | Stable |
| Multi-Agent | ✅ | ✅ |

### Adding MCP Servers
1. Left panel → ⚡ MCP → "+ Add MCP"
2. Or edit `config.json` directly via ⚙️ Config Editor

### Adding Skills
1. Left panel → 🧠 Skills → "+ Upload .md"
2. Or drop `.md` files in `skills/` and update `config.json`

---

## Architecture

```
Client (browser) ──WS──► server.js ──► claude-cli.js ──► claude (subprocess)
                                   └──► SDK query()    ──► Anthropic API
                    HTTP ◄──────────────────────────────────────────────────
```

- Single Node.js process, no build tools
- WebSocket for bidirectional streaming
- SQLite (WAL mode) for sessions and messages
- Multi-agent: orchestrator generates JSON plan → parallel agent execution

---

## Security

- Passwords hashed with bcrypt (12 rounds)
- Auth tokens: 32-byte hex, 30-day TTL, server-side storage
- WebSocket protected by `httpOnly` cookie
- API keys never sent to the frontend
- Helmet.js security headers
- Rate limiting on auth endpoints

---

## Development

```bash
npm run dev    # node --watch server.js (auto-reload)
npm start      # node server.js (production)
```

No linter, no test suite, no build step — vanilla JS frontend, plain Node.js backend.

---

## License

MIT
