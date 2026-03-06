/**
 * openclaw-bridge.js — OpenClaw Integration Bridge
 * Task 17: Routes task events to OpenClaw and provides REST API for external card creation.
 *
 * Configuration (environment variables):
 *   OPENCLAW_API_URL  — Base URL of the OpenClaw API (e.g., https://openclaw.example.com/api)
 *   OPENCLAW_API_KEY  — API key for authentication
 *   OPENCLAW_TIMEOUT  — HTTP timeout in ms (default: 10000)
 *   OPENCLAW_EVENTS   — Comma-separated event types to forward (default: task_complete,task_failed)
 *
 * Usage in server.js:
 *   const bridge = require('./openclaw-bridge');
 *   bridge.configure({ apiUrl, apiKey });
 *   await bridge.emitEvent({ type: 'task_complete', taskId, title, result, duration });
 *
 * OpenClaw Cron Integration (Task 19):
 *   External cron jobs can create cards via:
 *   POST http://localhost:3000/api/tasks  { title, description, status: 'todo' }
 *   Or trigger an existing task via:
 *   POST http://localhost:3000/api/tasks/:id/run
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ── Configuration ──────────────────────────────────────────────────────────
let _config = {
  apiUrl: process.env.OPENCLAW_API_URL || null,
  apiKey: process.env.OPENCLAW_API_KEY || null,
  timeout: parseInt(process.env.OPENCLAW_TIMEOUT || '10000', 10),
  // Events to forward — default: task lifecycle events
  enabledEvents: (process.env.OPENCLAW_EVENTS || 'task_complete,task_failed,task_started,task_cancelled').split(',').map(s => s.trim()),
};

let _pendingQueue = [];
let _isProcessing = false;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Configure the bridge at runtime (overrides env vars).
 * Call this from server.js after loading config.
 */
function configure(opts = {}) {
  if (opts.apiUrl !== undefined) _config.apiUrl = opts.apiUrl;
  if (opts.apiKey !== undefined) _config.apiKey = opts.apiKey;
  if (opts.timeout !== undefined) _config.timeout = opts.timeout;
  if (opts.enabledEvents !== undefined) _config.enabledEvents = opts.enabledEvents;
}

/**
 * Returns true if the bridge is configured and ready to forward events.
 */
function isConfigured() {
  return !!(_config.apiUrl && _config.apiKey);
}

/**
 * Emit a task lifecycle event to OpenClaw.
 * Non-blocking: events are queued and sent asynchronously with retry.
 *
 * @param {Object} event
 * @param {string} event.type      — Event type: task_complete | task_failed | task_started | task_cancelled
 * @param {string} event.taskId    — Internal task ID
 * @param {string} event.title     — Task title
 * @param {string} [event.result]  — Result text (task_complete only)
 * @param {string} [event.error]   — Error reason (task_failed only)
 * @param {number} [event.duration]— Execution time in ms
 * @param {string} [event.workdir] — Project workdir
 * @param {string} [event.skill]   — BMAD skill used
 */
function emitEvent(event) {
  if (!isConfigured()) return;
  if (!_config.enabledEvents.includes(event.type)) return;

  const payload = {
    ...event,
    source: 'claude-code-studio',
    timestamp: new Date().toISOString(),
  };

  _pendingQueue.push({ payload, attempts: 0 });
  if (!_isProcessing) _processQueue();
}

/**
 * Health check — verify OpenClaw API is reachable.
 * Returns { ok: true } or { ok: false, error: '...' }.
 */
async function healthCheck() {
  if (!isConfigured()) return { ok: false, error: 'Not configured (OPENCLAW_API_URL not set)' };
  try {
    await _post('/health', { ping: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Internal: Event Queue Processing ──────────────────────────────────────
async function _processQueue() {
  if (_isProcessing) return;
  _isProcessing = true;

  while (_pendingQueue.length > 0) {
    const item = _pendingQueue.shift();
    try {
      await _post('/webhooks/ccs', item.payload);
    } catch (err) {
      item.attempts++;
      if (item.attempts < MAX_RETRY_ATTEMPTS) {
        // Retry with backoff
        await _sleep(RETRY_BACKOFF_MS * item.attempts);
        _pendingQueue.unshift(item); // re-add to front of queue
      } else {
        // Max retries exceeded — drop the event and log
        console.error(`[openclaw-bridge] Event dropped after ${MAX_RETRY_ATTEMPTS} attempts: ${item.payload.type} / task "${item.payload.title}". Error: ${err.message}`);
      }
    }
  }

  _isProcessing = false;
}

// ── Internal: HTTP POST helper ─────────────────────────────────────────────
function _post(path, body) {
  return new Promise((resolve, reject) => {
    if (!_config.apiUrl) { reject(new Error('OPENCLAW_API_URL not configured')); return; }

    let baseUrl;
    try { baseUrl = new URL(_config.apiUrl); }
    catch { reject(new Error(`Invalid OPENCLAW_API_URL: ${_config.apiUrl}`)); return; }

    const fullPath = baseUrl.pathname.replace(/\/$/, '') + path;
    const json = JSON.stringify(body);
    const options = {
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      path: fullPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
        'Authorization': `Bearer ${_config.apiKey || ''}`,
        'X-Source': 'claude-code-studio',
      },
    };

    const transport = baseUrl.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(_config.timeout, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(json);
    req.end();
  });
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Task 19: OpenClaw Cron Integration Templates ────────────────────────────
/**
 * Pre-built cron task templates for OpenClaw integration.
 * External systems can use the /api/tasks REST API to create cards from cron jobs.
 *
 * Example: Trigger nightly tests via cron
 *   0 2 * * * curl -s -X POST http://localhost:3000/api/tasks \
 *     -H "Cookie: auth=<token>" -H "Content-Type: application/json" \
 *     -d '{"title":"Nightly Test Suite","description":"<!-- bmad-skills: [\"qa-engineer\"] -->\nRun full test suite and report results.","status":"todo","model":"sonnet","mode":"auto"}'
 *
 * Example: Trigger a specific task from OpenClaw
 *   POST http://localhost:3000/api/tasks/:taskId/run
 *
 * Example: Create a task with BMAD skill injection
 *   POST http://localhost:3000/api/tasks
 *   { "title": "Security Audit", "description": "<!-- bmad-skills: [\"security\"] -->\nRun OWASP dependency check...", "status": "todo", "model": "sonnet" }
 */
const CRON_TEMPLATES = [
  {
    id: 'nightly-tests',
    name: 'Nightly Test Suite',
    cron: '0 2 * * *',
    payload: { title: 'Nightly Test Suite', description: '<!-- bmad-skills: ["qa-engineer"] -->\nRun the full test suite. Report failures with file:line references.', status: 'todo', model: 'sonnet', mode: 'auto' },
  },
  {
    id: 'weekly-audit',
    name: 'Weekly Dependency Audit',
    cron: '0 3 * * 1',
    payload: { title: 'Weekly Dependency Audit', description: '<!-- bmad-skills: ["security","devops"] -->\nAudit dependencies for CVEs. Produce prioritized security report.', status: 'todo', model: 'sonnet', mode: 'auto' },
  },
  {
    id: 'weekly-review',
    name: 'Weekly Code Review',
    cron: '0 9 * * 1',
    payload: { title: 'Weekly Code Review', description: '<!-- bmad-skills: ["code-review","analyst"] -->\nReview git changes from last 7 days. Report issues with severity levels.', status: 'todo', model: 'sonnet', mode: 'auto' },
  },
  {
    id: 'daily-standup',
    name: 'Daily Git Standup',
    cron: '0 8 * * 1-5',
    payload: { title: 'Daily Git Standup', description: '<!-- bmad-skills: ["developer"] -->\nGenerate daily standup from git activity (last 24h). Include: commits, files changed, summary.', status: 'todo', model: 'haiku', mode: 'auto' },
  },
];

module.exports = {
  configure,
  isConfigured,
  emitEvent,
  healthCheck,
  CRON_TEMPLATES,
};
