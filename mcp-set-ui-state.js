#!/usr/bin/env node
// ─── Internal MCP Server: set_ui_state ────────────────────────────────────────
// Raw JSON-RPC 2.0 over stdio (newline-delimited). Zero external dependencies.
// Provides a "set_ui_state" tool that updates the UI toolbar state (mode, model, agent).
// Fire-and-forget — does NOT pause Claude.
//
// Environment variables (set by server.js at injection time):
//   SET_UI_STATE_SERVER_URL   — e.g. http://127.0.0.1:3000
//   SET_UI_STATE_SESSION_ID   — local session ID for routing to correct client
//   SET_UI_STATE_SECRET       — per-process auth secret

const http = require('http');
const { StringDecoder } = require('string_decoder');

const SERVER_URL = process.env.SET_UI_STATE_SERVER_URL || 'http://127.0.0.1:3000';
const SESSION_ID = process.env.SET_UI_STATE_SESSION_ID || '';
const SECRET = process.env.SET_UI_STATE_SECRET || '';
const MAX_STDIN_BUFFER = 10 * 1024 * 1024; // 10 MB

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

const SET_UI_STATE_TOOL = {
  name: 'set_ui_state',
  description: 'Update the UI state (mode, model, agent). Use this when you transition between phases (e.g., from planning to execution) so the UI reflects your current state. This is fire-and-forget — execution continues immediately.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['auto', 'planning', 'task'],
        description: 'Execution mode: "planning" (analyze only, no modifications), "task" (execution mode), "auto" (default balanced mode)',
      },
      model: {
        type: 'string',
        enum: ['haiku', 'sonnet', 'opus'],
        description: 'Model to switch to in the UI',
      },
      agent: {
        type: 'string',
        enum: ['single', 'multi'],
        description: 'Agent mode: "single" or "multi"',
      },
    },
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
      path: '/api/internal/set-ui-state',
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

let _initialized = false;

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — acknowledge silently
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      _initialized = true;
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '_ccs_set_ui_state', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      if (!_initialized) { sendError(id, -32002, 'Server not initialized'); return; }
      sendResponse(id, { tools: [SET_UI_STATE_TOOL] });
      break;

    case 'tools/call': {
      if (!_initialized) { sendError(id, -32002, 'Server not initialized'); return; }
      const toolName = params?.name;
      if (toolName !== 'set_ui_state') {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      const args = params?.arguments || {};
      const { mode, model, agent } = args;

      // Validate at least one parameter provided
      if (!mode && !model && !agent) {
        sendError(id, -32602, 'At least one of mode, model, or agent must be provided');
        return;
      }

      // Validate enum values
      const validModes = ['auto', 'planning', 'task'];
      const validModels = ['haiku', 'sonnet', 'opus'];
      const validAgents = ['single', 'multi'];

      if (mode && !validModes.includes(mode)) {
        sendError(id, -32602, `Invalid mode: ${mode}. Valid values: ${validModes.join(', ')}`);
        return;
      }
      if (model && !validModels.includes(model)) {
        sendError(id, -32602, `Invalid model: ${model}. Valid values: ${validModels.join(', ')}`);
        return;
      }
      if (agent && !validAgents.includes(agent)) {
        sendError(id, -32602, `Invalid agent: ${agent}. Valid values: ${validAgents.join(', ')}`);
        return;
      }

      try {
        await postToServer({
          sessionId: SESSION_ID,
          mode,
          model,
          agent,
        });
        sendResponse(id, {
          content: [{ type: 'text', text: `UI state updated: ${mode ? `mode=${mode}` : ''}${model ? ` model=${model}` : ''}${agent ? ` agent=${agent}` : ''}`.trim() }],
        });
      } catch (err) {
        // Still return success to Claude — UI state update failure should never block work
        sendResponse(id, {
          content: [{ type: 'text', text: `UI state update failed (${err.message}), continuing.` }],
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
  if (buffer.length > MAX_STDIN_BUFFER) {
    process.stderr.write('[mcp] stdin buffer overflow, resetting\n');
    buffer = '';
    return;
  }
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg).catch((err) => {
        process.stderr.write(`set_ui_state MCP error: ${err.message}\n`);
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
