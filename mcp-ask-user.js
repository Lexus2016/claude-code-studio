#!/usr/bin/env node
// ─── Internal MCP Server: ask_user ──────────────────────────────────────────
// Raw JSON-RPC 2.0 over stdio (newline-delimited). Zero external dependencies.
// Provides an "ask_user" tool that pauses Claude execution and waits for user input.
//
// Environment variables (set by server.js at injection time):
//   ASK_USER_SERVER_URL  — e.g. http://127.0.0.1:3000
//   ASK_USER_SESSION_ID  — local session ID for routing to correct client
//   ASK_USER_SECRET      — per-process auth secret

const http = require('http');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const SERVER_URL = process.env.ASK_USER_SERVER_URL || 'http://127.0.0.1:3000';
const SESSION_ID = process.env.ASK_USER_SESSION_ID || '';
const SECRET = process.env.ASK_USER_SECRET || '';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

const ASK_USER_TOOL = {
  name: 'ask_user',
  description: 'Ask the user a question and wait for their response. Use this when you need clarification, a choice, or any input from the user before proceeding. Execution pauses until the user responds. Supports multiple questions (paginated), rich options with descriptions, and an "Other" free-text fallback on every choice question.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Single question to ask (use "questions" array for multiple)' },
      options: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string' },
            { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] },
          ],
        },
        description: 'Predefined options — strings or {label,description} objects. An "Other" free-text input is always shown.',
      },
      inputType: { type: 'string', enum: ['free_text', 'single_choice', 'multi_choice'], default: 'free_text', description: 'Type of input expected' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question text' },
            header: { type: 'string', description: 'Short label (max 12 chars) shown as a badge' },
            options: {
              type: 'array',
              items: {
                oneOf: [
                  { type: 'string' },
                  { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] },
                ],
              },
            },
            multiSelect: { type: 'boolean', default: false, description: 'Allow selecting multiple options' },
          },
          required: ['question'],
        },
        description: 'Multiple questions shown with pagination. Each supports options with "Other" fallback. Takes priority over single question/options/inputType.',
      },
    },
    required: ['question'],
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
      path: '/api/internal/ask-user',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${SECRET}`,
      },
      timeout: TIMEOUT_MS + 5000, // slightly longer than server timeout
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          resolve({ answer: responseBody || '[No response]' });
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`HTTP request failed: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ answer: '[No response — request timed out. Proceed with your best judgment.]' });
    });

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
        serverInfo: { name: '_ccs_ask_user', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      sendResponse(id, { tools: [ASK_USER_TOOL] });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      if (toolName !== 'ask_user') {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      const args = params?.arguments || {};
      const requestId = crypto.randomUUID();

      // Normalize into a questions array for uniform handling
      let questions;
      if (Array.isArray(args.questions) && args.questions.length) {
        // Validate: keep only well-formed question objects
        questions = args.questions.filter(q => q && typeof q === 'object' && q.question);
      }
      if (!questions?.length) {
        // Single-question legacy format → wrap into array
        const q = args.question || 'No question provided';
        const opts = Array.isArray(args.options) ? args.options : undefined;
        const iType = args.inputType || (opts?.length ? 'single_choice' : 'free_text');
        questions = [{
          question: q,
          options: opts,
          multiSelect: iType === 'multi_choice',
        }];
      }

      // Always send top-level question for backward compat with older server.js
      const question = questions[0]?.question || args.question || 'No question provided';

      try {
        const result = await postToServer({
          requestId,
          sessionId: SESSION_ID,
          question,
          questions,
        });

        sendResponse(id, {
          content: [{ type: 'text', text: result.answer || '[No response]' }],
        });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: 'text', text: `[Error getting user response: ${err.message}. Proceed with your best judgment.]` }],
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
        process.stderr.write(`ask_user MCP error: ${err.message}\n`);
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
