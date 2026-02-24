#!/usr/bin/env node
// ─── Internal MCP Server: notify_user ──────────────────────────────────────
// Raw JSON-RPC 2.0 over stdio (newline-delimited). Zero external dependencies.
// Provides a "notify_user" tool that sends non-blocking notifications to the UI.
// Unlike ask_user, this does NOT pause Claude — fire-and-forget.
//
// Environment variables (set by server.js at injection time):
//   NOTIFY_SERVER_URL   — e.g. http://127.0.0.1:3000
//   NOTIFY_SESSION_ID   — local session ID for routing to correct client
//   NOTIFY_SECRET       — per-process auth secret

const http = require('http');
const { StringDecoder } = require('string_decoder');

const SERVER_URL = process.env.NOTIFY_SERVER_URL || 'http://127.0.0.1:3000';
const SESSION_ID = process.env.NOTIFY_SESSION_ID || '';
const SECRET = process.env.NOTIFY_SECRET || '';

// ─── JSON-RPC helpers ────────────────────────────────────────────────────────

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

// ─── Tool definition ─────────────────────────────────────────────────────────

const NOTIFY_USER_TOOL = {
  name: 'notify_user',
  description: 'Send a non-blocking notification to the user. Use this to report progress, milestones, warnings, or errors WITHOUT pausing execution. You continue working immediately after calling this tool. Use sparingly — only for meaningful status changes, not every minor step.',
  inputSchema: {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        enum: ['info', 'warning', 'milestone', 'error', 'progress'],
        default: 'info',
        description: 'Notification level: info (general update), warning (potential issue), milestone (significant achievement), error (something failed), progress (task progress with numeric tracking)',
      },
      title: {
        type: 'string',
        description: 'Short notification title (max 120 chars)',
      },
      detail: {
        type: 'string',
        description: 'Optional longer description or context',
      },
      progress: {
        type: 'object',
        properties: {
          current: { type: 'number', description: 'Current step number' },
          total: { type: 'number', description: 'Total number of steps' },
        },
        required: ['current', 'total'],
        description: 'Progress tracking (used when level is "progress")',
      },
    },
    required: ['title'],
  },
};

// ─── HTTP POST to Express server (fire-and-forget) ──────────────────────────

function postToServer(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(SERVER_URL);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: '/api/internal/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${SECRET}`,
      },
      timeout: 5000, // short timeout — non-blocking, don't wait long
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(responseBody)); }
        catch { resolve({ ok: true }); }
      });
    });

    req.on('error', (err) => reject(new Error(`HTTP request failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); resolve({ ok: true }); });

    req.write(data);
    req.end();
  });
}

// ─── Handle JSON-RPC messages ────────────────────────────────────────────────

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — acknowledge silently
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '_ccs_notify', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      sendResponse(id, { tools: [NOTIFY_USER_TOOL] });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      if (toolName !== 'notify_user') {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      const args = params?.arguments || {};
      const level = args.level || 'info';
      const title = String(args.title || '').substring(0, 120);
      const detail = String(args.detail || '').substring(0, 500);
      const progress = args.progress || null;

      try {
        await postToServer({
          sessionId: SESSION_ID,
          level,
          title,
          detail,
          progress,
        });

        // NON-BLOCKING: return immediately — don't wait for user
        sendResponse(id, {
          content: [{ type: 'text', text: `Notification sent: [${level}] ${title}` }],
        });
      } catch (err) {
        // Still return success to Claude — notification failure should never block work
        sendResponse(id, {
          content: [{ type: 'text', text: `Notification delivery failed (${err.message}), continuing.` }],
        });
      }
      break;
    }

    default:
      // Unknown method — return method not found for requests, ignore notifications
      if (id !== undefined && id !== null) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ─── Stdin line reader ───────────────────────────────────────────────────────

const decoder = new StringDecoder('utf8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk);
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg).catch((err) => {
        process.stderr.write(`notify_user MCP error: ${err.message}\n`);
      });
    } catch {
      // Ignore unparseable lines
    }
  }
});

process.stdin.on('end', () => {
  // Flush remaining buffer
  const remaining = buffer + decoder.end();
  if (remaining.trim()) {
    try {
      const msg = JSON.parse(remaining);
      handleMessage(msg).catch(() => {});
    } catch {}
  }
  process.exit(0);
});

// Handle SIGTERM/SIGINT gracefully
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
