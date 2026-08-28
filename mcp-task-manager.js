#!/usr/bin/env node
// ─── Internal MCP Server: task_manager ───────────────────────────────────────
// Raw JSON-RPC 2.0 over stdio (newline-delimited). Zero external dependencies.
// Provides tools for autonomous task creation, chaining, and result reporting
// during scheduled task execution. Claude can create child tasks, read its own
// context, and report structured results for dependent tasks.
//
// Environment variables (set by server.js at injection time):
//   TASK_MANAGER_SERVER_URL  — e.g. http://127.0.0.1:3000
//   TASK_MANAGER_TASK_ID     — current task ID (for self-awareness)
//   TASK_MANAGER_SESSION_ID  — local session ID for routing
//   TASK_MANAGER_SECRET      — per-process auth secret

const http = require('http');
const { StringDecoder } = require('string_decoder');

const SERVER_URL = process.env.TASK_MANAGER_SERVER_URL || 'http://127.0.0.1:3000';
const TASK_ID = process.env.TASK_MANAGER_TASK_ID || '';
const SESSION_ID = process.env.TASK_MANAGER_SESSION_ID || '';
const SECRET = process.env.TASK_MANAGER_SECRET || '';
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

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'create_task',
    description: 'Create a new task in the system. By default the task is queued for execution; pass status="backlog" to add it to the Kanban board WITHOUT running it (use that when importing an existing plan, roadmap or tasks/ folder into the board). The workdir is automatically inherited from your current task — you cannot change it. Use this to spawn follow-up work, bug fixes, or any action that should run as a separate task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title (max 200 chars)' },
        description: { type: 'string', description: 'Detailed task description (max 2000 chars)' },
        status: { type: 'string', enum: ['backlog', 'todo'], description: 'backlog = add to the board only, nothing runs. todo = queue it for execution now (default).' },
        context: {
          description: 'Curated context to pass to the child task. Include ONLY what the child needs — issue details, code snippets, error messages, etc. Can be a string or a JSON object. The child reads this via get_current_task.',
        },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus', 'fable'], description: 'AI model for the task (default: inherit from current task)' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must complete before this task starts' },
        chain_id: { type: 'string', description: 'Add this task to an existing chain' },
        scheduled_at: { type: 'string', description: 'ISO 8601 datetime for delayed execution' },
        max_turns: { type: 'number', description: 'Max Claude turns (default: 30)' },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'create_chain',
    description: 'Create a chain of sequential tasks in one call. Tasks run in order by default (each depends on the previous). All tasks share a session for context continuity. Use depends_on_index to create custom dependency graphs within the chain.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Chain title' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              context: { description: 'Context for this specific task' },
              model: { type: 'string', enum: ['haiku', 'sonnet', 'opus', 'fable'] },
              max_turns: { type: 'number' },
              depends_on_index: { type: 'array', items: { type: 'number' }, description: 'Indices (0-based) of tasks in this chain that must complete first. If omitted, depends on previous task.' },
            },
            required: ['title'],
          },
          description: 'Array of task definitions (max 10)',
        },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus', 'fable'], description: 'Default model for all tasks' },
        scheduled_at: { type: 'string', description: 'ISO 8601 datetime for delayed execution' },
        recurrence: { type: 'string', pattern: '^(hourly|daily|weekly|monthly|every:[1-9][0-9]*:(hour|day|week|month)|times:[1-9][0-9]*:month)$', description: 'Repeat schedule. A preset (hourly|daily|weekly|monthly), or "every:N:unit" where unit = hour|day|week|month (e.g. "every:2:hour", "every:10:day", "every:6:month"), or "times:N:month" = N runs per calendar month (e.g. "times:3:month").' },
        recurrence_end_at: { type: 'string', description: 'ISO 8601 datetime to stop recurring' },
      },
      required: ['title', 'tasks'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks in your project. Useful for checking existing tasks, avoiding duplicates, or monitoring progress of child tasks you created.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'done', 'cancelled'], description: 'Filter by status' },
        chain_id: { type: 'string', description: 'Filter by chain ID' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
      },
    },
  },
  {
    name: 'get_current_task',
    description: 'Get details about your current task, including the context passed by the parent task. Call this first to understand your mission and any context provided.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report_result',
    description: 'Store a structured result for this task. Other tasks that depend on you can read this via get_task_result. Use this to pass data to downstream tasks — issue lists, PR URLs, analysis results, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { description: 'Structured result data (string or JSON object). This is what dependent tasks will receive.' },
      },
      required: ['data'],
    },
  },
  {
    name: 'get_task_result',
    description: 'Read the structured result of a completed task. Use this to get output from tasks you depend on or from child tasks you created.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task whose result you want to read' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a pending or running task. Use when you determine a task is no longer needed (e.g., the issue was already fixed, or a sibling task made it redundant).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to cancel' },
        reason: { type: 'string', description: 'Why this task is being cancelled' },
      },
      required: ['task_id'],
    },
  },
];

// ─── HTTP POST to Express server ─────────────────────────────────────────────

function postToServer(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      ...body,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
    });
    const serverUrl = new URL(SERVER_URL);

    const options = {
      hostname: serverUrl.hostname,
      port: serverUrl.port || 80,
      path: '/api/internal/task-manager',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${SECRET}`,
      },
      timeout: 15000,
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve({ ok: true });
        }
      });
    });

    req.on('error', (err) => reject(new Error(`HTTP request failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

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
        serverInfo: { name: '_ccs_task_manager', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      if (!_initialized) { sendError(id, -32002, 'Server not initialized'); return; }
      sendResponse(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      if (!_initialized) { sendError(id, -32002, 'Server not initialized'); return; }
      const toolName = params?.name;
      const tool = TOOLS.find(t => t.name === toolName);
      if (!tool) {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      const args = params?.arguments || {};

      try {
        const result = await postToServer({ ...args, action: toolName }); // action AFTER spread — prevents override

        // Format response based on tool
        let text;
        switch (toolName) {
          case 'create_task':
            text = `Task created: "${result.title}" (ID: ${result.task_id}, status: ${result.status})`;
            break;
          case 'create_chain':
            text = `Chain created (ID: ${result.chain_id}) with ${result.task_ids.length} tasks:\n${result.task_ids.map((id, i) => `  ${i + 1}. ${id}`).join('\n')}`;
            break;
          case 'list_tasks':
            if (!result.tasks?.length) {
              text = 'No tasks found matching the criteria.';
            } else {
              text = `Found ${result.tasks.length} tasks:\n${result.tasks.map(t => `  - [${t.status}] "${t.title}" (ID: ${t.id})`).join('\n')}`;
            }
            break;
          case 'get_current_task':
            text = JSON.stringify(result, null, 2);
            break;
          case 'report_result':
            text = 'Result stored successfully. Dependent tasks will be able to read it.';
            break;
          case 'get_task_result':
            text = JSON.stringify(result, null, 2);
            break;
          case 'cancel_task':
            text = `Task ${result.task_id} cancelled.`;
            break;
          default:
            text = JSON.stringify(result);
        }

        sendResponse(id, {
          content: [{ type: 'text', text }],
        });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
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
        process.stderr.write(`task_manager MCP error: ${err.message}\n`);
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
