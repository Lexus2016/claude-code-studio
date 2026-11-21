#!/usr/bin/env node
// ─── External MCP server: ccs ────────────────────────────────────────────────
// Drive Claude Code Studio from an OUTSIDE agent (issue #150, stage 1): any MCP
// client — another Claude Code session, MCPHub, a monitoring script — can list
// projects, create tasks, follow them and read results without opening the web UI.
//
// Raw JSON-RPC 2.0 over stdio, newline delimited, zero external dependencies, and
// deliberately SELF-CONTAINED: it is meant to be copied into another image (or run
// with `npx`) and kept in sync with CCS releases, so it must not require a sibling
// file. The only place that would have pulled one in is the task text limit; the
// literal below is pinned to task-text-limit.js by test/task-text-limit.test.js.
//
// Usage (client config `env`):
//   CCS_URL    base URL of the server, http or https, no trailing /api.
//              Default http://127.0.0.1:3000. Set it to the container/reverse-proxy
//              address when this process does not run next to the server.
//   CCS_TOKEN  a token created with scripts/api-token.js (or POST /api/api-tokens).
//              scope "read" = list/read only; "full" = also create and cancel.
//
// Nothing is inherited from a parent task: `project` is required on create_task,
// because this client has no workdir of its own. create_task defaults to
// status "backlog" so a card lands on the board without starting a run; pass
// status "todo" to queue it now.

const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');

// Same limit the HTTP API enforces. Kept as a literal on purpose — see the header.
const MAX_TASK_TEXT = 20000;
const MAX_STDIN_BUFFER = 10 * 1024 * 1024; // 10 MB

const CCS_URL = (process.env.CCS_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const CCS_TOKEN = process.env.CCS_TOKEN || '';

// ─── JSON-RPC helpers ────────────────────────────────────────────────────────

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function toolText(id, text, isError) {
  sendResponse(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
}

// ─── HTTP to the CCS external API ────────────────────────────────────────────

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(CCS_URL); }
    catch { return reject(new Error(`CCS_URL is not a valid URL: ${CCS_URL}`)); }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      return reject(new Error(`CCS_URL must be http or https, got ${base.protocol}`));
    }
    const mod = base.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const prefix = base.pathname.replace(/\/+$/, '');
    const options = {
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path: prefix + apiPath,
      method,
      headers: {
        Authorization: `Bearer ${CCS_TOKEN}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 20000,
    };

    const req = mod.request(options, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(responseBody); } catch { /* non-JSON body below */ }
        if (res.statusCode >= 400) {
          const detail = (parsed && parsed.error) || responseBody.slice(0, 300) || `HTTP ${res.statusCode}`;
          let hint = '';
          if (res.statusCode === 401) hint = ' — check CCS_TOKEN (scripts/api-token.js creates one)';
          if (res.statusCode === 403 && /read-only/.test(String(detail))) hint = ' — this token has scope "read"; create a "full" token to change anything';
          return reject(new Error(`${detail} (HTTP ${res.statusCode})${hint}`));
        }
        if (parsed === null) return reject(new Error(`expected JSON from ${apiPath}, got: ${responseBody.slice(0, 200)}`));
        resolve(parsed);
      });
    });
    req.on('error', (err) => reject(new Error(`cannot reach ${CCS_URL}: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error(`request to ${CCS_URL} timed out`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List the projects registered in Claude Code Studio. Pass a returned `id` (or its exact name) as `project` to any tool that needs one.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_task',
    description: 'Create a Kanban card in a project. `project` is required — this client has no workdir to inherit, so the task is placed in the named project. Default status "backlog" adds a card WITHOUT starting a run; pass status "todo" to queue it for an unattended run now (that runs claude with the description as the prompt).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id or exact name (see list_projects)' },
        title: { type: 'string', description: 'Short task title (max 200 chars)' },
        description: { type: 'string', description: `Task prompt/description (max ${MAX_TASK_TEXT} chars)` },
        status: { type: 'string', enum: ['backlog', 'todo'], description: 'backlog = card only, nothing runs (default). todo = queue an unattended run now.' },
        model: { type: 'string', description: 'Model for the run (default "sonnet")' },
        max_turns: { type: 'number', description: 'Max turns for the run (default 30)' },
        scheduled_at: { type: 'string', description: 'ISO 8601 datetime — a "todo" task waits until then' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish first' },
      },
      required: ['project', 'title'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks, newest first. Filter by project, status, or both. Use this to follow work created here or in the UI.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id or exact name; omit for all projects' },
        status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'done', 'cancelled'], description: 'Filter by status' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Read one task: title, description, status, project, timestamps, failure reason.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task id' } },
      required: ['task_id'],
    },
  },
  {
    name: 'get_task_result',
    description: 'Read the structured result a finished run reported (the data a dependent task would receive). Empty until the run stores one.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task id' } },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a pending or running task. Needed a token with scope "full".',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id' },
        reason: { type: 'string', description: 'Why it is being cancelled' },
      },
      required: ['task_id'],
    },
  },
];

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatTask(t) {
  const proj = t.project_name ? ` [${t.project_name}]` : '';
  return `  - [${t.status}] "${t.title}" (ID: ${t.id})${proj}`;
}

function formatProjects(projects) {
  if (!projects.length) return 'No projects are registered.';
  return `Projects (${projects.length}):\n` + projects.map(p =>
    `  - ${p.name} (id: ${p.id})${p.isRemote ? ' — remote' : ''} — ${p.workdir}`).join('\n');
}

// ─── Message handling ────────────────────────────────────────────────────────

let _initialized = false;

async function handleMessage(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) are acknowledged silently.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      _initialized = true;
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ccs', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      if (!_initialized) { sendError(id, -32002, 'Server not initialized'); return; }
      sendResponse(id, { tools: TOOLS });
      break;

    case 'ping':
      sendResponse(id, {});
      break;

    case 'tools/call': {
      if (!_initialized) { sendError(id, -32002, 'Server not initialized'); return; }
      const name = params?.name;
      const args = params?.arguments || {};
      if (!TOOLS.some(t => t.name === name)) { sendError(id, -32602, `Unknown tool: ${name}`); return; }
      if (!CCS_TOKEN) {
        toolText(id, 'CCS_TOKEN is not set. Create a token with `node scripts/api-token.js create --name <client> --scope read` and put it in this server\'s env as CCS_TOKEN.', true);
        return;
      }

      try {
        switch (name) {
          case 'list_projects': {
            const projects = await request('GET', '/api/external/v1/projects');
            toolText(id, formatProjects(projects));
            break;
          }
          case 'create_task': {
            if (!args.project) throw new Error('project is required — call list_projects and pass an id or exact name');
            if (!args.title) throw new Error('title is required');
            const body = {
              project: args.project,
              title: args.title,
              description: args.description || '',
              status: args.status === 'todo' ? 'todo' : 'backlog',
            };
            if (args.model) body.model = args.model;
            if (args.max_turns) body.max_turns = Number(args.max_turns);
            if (args.scheduled_at) body.scheduled_at = args.scheduled_at;
            if (Array.isArray(args.depends_on) && args.depends_on.length) body.depends_on = args.depends_on;
            const task = await request('POST', '/api/external/v1/tasks', body);
            const what = task.status === 'todo'
              ? 'queued for an unattended run'
              : 'added to the board (backlog — nothing runs until it is set to todo)';
            toolText(id, `Task created: "${task.title}" (ID: ${task.id}) in ${task.project_name || task.project_id}, status ${task.status} — ${what}.`);
            break;
          }
          case 'list_tasks': {
            const q = new URLSearchParams();
            if (args.project) q.set('project', String(args.project));
            if (args.status) q.set('status', String(args.status));
            if (args.limit) q.set('limit', String(args.limit));
            const qs = q.toString();
            const tasks = await request('GET', '/api/external/v1/tasks' + (qs ? `?${qs}` : ''));
            toolText(id, tasks.length ? `Tasks (${tasks.length}):\n${tasks.map(formatTask).join('\n')}` : 'No tasks matched.');
            break;
          }
          case 'get_task': {
            if (!args.task_id) throw new Error('task_id is required');
            const t = await request('GET', `/api/external/v1/tasks/${encodeURIComponent(args.task_id)}`);
            toolText(id, [
              `ID: ${t.id}`,
              `Title: ${t.title}`,
              `Project: ${t.project_name || t.project_id || '(none)'}`,
              `Status: ${t.status}`,
              t.failure_reason ? `Failure: ${t.failure_reason}` : null,
              `Model: ${t.model} · max turns: ${t.max_turns}`,
              `Created: ${t.created_at} · Updated: ${t.updated_at}`,
              t.depends_on && t.depends_on.length ? `Depends on: ${t.depends_on.join(', ')}` : null,
              '',
              t.description || '(no description)',
            ].filter(l => l !== null).join('\n'));
            break;
          }
          case 'get_task_result': {
            if (!args.task_id) throw new Error('task_id is required');
            const r = await request('GET', `/api/external/v1/tasks/${encodeURIComponent(args.task_id)}/result`);
            const output = r.output === null || r.output === undefined ? '(no result stored yet)' : (typeof r.output === 'string' ? r.output : JSON.stringify(r.output, null, 2));
            toolText(id, `"${r.title}" (ID: ${r.task_id}) — status ${r.status}${r.completed_at ? `, completed ${r.completed_at}` : ''}\n${output}`);
            break;
          }
          case 'cancel_task': {
            if (!args.task_id) throw new Error('task_id is required');
            const body = args.reason ? { reason: String(args.reason) } : {};
            const r = await request('POST', `/api/external/v1/tasks/${encodeURIComponent(args.task_id)}/cancel`, body);
            toolText(id, `Task ${r.task_id} is ${r.status}.`);
            break;
          }
          default:
            sendError(id, -32602, `Unknown tool: ${name}`);
        }
      } catch (err) {
        toolText(id, `Error: ${err.message}`, true);
      }
      break;
    }

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Stdin line reader ───────────────────────────────────────────────────────

const decoder = new StringDecoder('utf8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk);
  if (buffer.length > MAX_STDIN_BUFFER) {
    process.stderr.write('[mcp-ccs] stdin buffer overflow, resetting\n');
    buffer = '';
    return;
  }
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg).catch((err) => process.stderr.write(`mcp-ccs error: ${err.message}\n`));
    } catch { /* ignore unparseable lines */ }
  }
});

process.stdin.on('end', () => {
  const remaining = buffer + decoder.end();
  if (remaining.trim()) {
    try { handleMessage(JSON.parse(remaining)).catch(() => {}); } catch {}
  }
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
