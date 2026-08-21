#!/usr/bin/env node
// ─── Internal MCP Server: bots ───────────────────────────────────────────────
// Raw JSON-RPC 2.0 over stdio (newline-delimited). Zero external dependencies.
// Provides a "message_bot" tool that hands a task to another bot from the same
// roster. The dispatch is only recorded here — the callee runs after the caller's
// turn ends, so this tool never blocks and never returns the callee's answer.
//
// Environment variables (set by server.js at injection time):
//   BOTS_SERVER_URL  — e.g. http://127.0.0.1:3000
//   BOTS_SESSION_ID  — the chat session ID the hand-off belongs to
//   BOTS_CALLER      — handle of the bot this server instance was injected for
//   BOTS_TURN        — token identifying the specific turn; the server refuses a
//                      hand-off from a subprocess that outlived the turn it belongs to
//   BOTS_SECRET      — per-process auth secret

const http = require('http');
const { StringDecoder } = require('string_decoder');

const SERVER_URL = process.env.BOTS_SERVER_URL || 'http://127.0.0.1:3000';
const SESSION_ID = process.env.BOTS_SESSION_ID || '';
const CALLER = process.env.BOTS_CALLER || '';
const TURN = process.env.BOTS_TURN || '';
const SECRET = process.env.BOTS_SECRET || '';
const MAX_STDIN_BUFFER = 10 * 1024 * 1024; // 10 MB
// The task text becomes the callee's prompt. The existing sequential-context path
// already clips peer output at 4000 chars (server.js:3395) — reuse that number
// instead of inventing a second limit for the same kind of payload.
const MAX_TASK_CHARS = 4000;

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

const MESSAGE_BOT_TOOL = {
  name: 'message_bot',
  description: 'Hand a task to another bot from your roster. The bot runs AFTER you finish your turn, so you will NOT see its answer inside this turn — do not wait for it and do not build your reply around its output. Write "task" so it stands on its own: the callee does not share your context and sees nothing except that text. Each bot can be handed work at most once per user message, and the number of hand-offs per message is limited — spend them on work that genuinely needs someone else.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'The @handle of the bot to hand the work to, as listed in your roster',
      },
      task: {
        type: 'string',
        description: 'Self-contained description of what that bot should do, including any context it needs — it cannot see your conversation',
      },
    },
    required: ['handle', 'task'],
  },
};

// ─── HTTP POST to Express server ─────────────────────────────────────────────

function postToServer(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(SERVER_URL);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: '/api/internal/message-bot',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${SECRET}`,
      },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        // The server always answers 200 with { ok, accepted, reason? }. Anything
        // else means the dispatch was not recorded — surface it, don't guess.
        try { resolve(JSON.parse(responseBody)); }
        catch { reject(new Error('unparseable response from server')); }
      });
    });

    req.on('error', (err) => reject(new Error(`HTTP request failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });

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
        serverInfo: { name: '_ccs_bots', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      if (!_initialized) { sendError(id, -32002, 'Server not initialized'); return; }
      sendResponse(id, { tools: [MESSAGE_BOT_TOOL] });
      break;

    case 'tools/call': {
      if (!_initialized) { sendError(id, -32002, 'Server not initialized'); return; }
      const toolName = params?.name;
      if (toolName !== 'message_bot') {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      const args = params?.arguments || {};
      const rawHandle = typeof args.handle === 'string' ? args.handle.trim() : '';
      const rawTask = typeof args.task === 'string' ? args.task.trim() : '';

      // Bad arguments come back as content, not as a JSON-RPC error: a protocol
      // error is invisible to the model, a text block lets it fix the call itself.
      if (!rawHandle) {
        sendResponse(id, {
          content: [{ type: 'text', text: 'Not queued: "handle" is required and must be a non-empty string — pass the @handle of a bot from your roster.' }],
        });
        break;
      }
      if (!rawTask) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Not queued: "task" is required and must be a non-empty string — describe what @${rawHandle} should do, in full.` }],
        });
        break;
      }

      // Handles are stored without the '@' (see bots.js), so send the canonical form.
      const handle = rawHandle.replace(/^@+/, '');
      // Truncation is reported both ways on purpose. The callee is told its brief is cut
      // so it does not treat a sentence that stops mid-word as the whole spec, and the
      // caller is told too — otherwise it tells the user it handed over a full brief that
      // the peer never received.
      const clipped = rawTask.length > MAX_TASK_CHARS;
      const task = clipped
        ? rawTask.substring(0, MAX_TASK_CHARS) + '\n\n[This task was cut off at '
          + MAX_TASK_CHARS + ' characters — anything after this point is missing.]'
        : rawTask;

      try {
        const result = await postToServer({
          sessionId: SESSION_ID,
          from: CALLER,
          turn: TURN,
          handle,
          task,
        });

        if (result?.accepted) {
          sendResponse(id, {
            content: [{ type: 'text', text: `Queued: @${handle} will run after you finish this turn. You will not see the answer here.`
              + (clipped ? ` NOTE: your task was longer than ${MAX_TASK_CHARS} characters and was cut off at that point — @${handle} did NOT receive the rest. Do not tell the user it got the full brief.` : '') }],
          });
        } else {
          const reason = result?.reason || 'no reason given';
          sendResponse(id, {
            content: [{ type: 'text', text: `NOT queued: @${handle} was not scheduled. Reason: ${reason}` }],
          });
        }
      } catch (err) {
        // A failed hand-off is never fatal — the caller still owes the user an
        // answer, so report the miss and let it finish on its own.
        sendResponse(id, {
          content: [{ type: 'text', text: `Hand-off to @${handle} could not be recorded (${err.message}). Continue without it and do not retry.` }],
        });
      }
      break;
    }

    default:
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
        process.stderr.write(`bots MCP error: ${err.message}\n`);
      });
    } catch {
      // Ignore unparseable lines
    }
  }
});

process.stdin.on('end', () => {
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
