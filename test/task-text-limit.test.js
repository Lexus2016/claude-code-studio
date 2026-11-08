// A task description is a prompt, and 2000 characters is shorter than a useful one —
// issue #129. The same number failed in two places at once:
//
//   1. every write path in server.js cut the text at 2000 characters (the four task
//      INSERTs, the UPDATE, the two plan importers and the task-manager endpoint) with
//      no error, so a long prompt reached the worker with its last lines missing;
//   2. public/schedule.html and public/kanban.html carried their own `maxlength="2000"`,
//      so a pasted prompt was cut in the browser before the server saw it, silently.
//
// What this file pins:
//   - the limit is ONE number (task-text-limit.js) that the server, the MCP schema and
//     both pages agree on, so the four places cannot drift apart again;
//   - a 5000-character description survives the round trip through the HTTP API, an
//     update, and the task-manager endpoint an agent posts to;
//   - 25000 is still capped at the limit rather than stored whole, and the counter the
//     pages show reaches the limit exactly where the text was cut;
//   - the schedule card shows three lines of a description instead of one, since a
//     longer field is only useful if some of it is visible on the board.
//
// Run: node test/task-text-limit.test.js   (TEST_PORT=<n> to move off the default)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { MAX_TASK_TEXT } = require('../task-text-limit');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = Number(process.env.TEST_PORT || 4553);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-task-manager-secret-0123456789ab';

const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-ttl-app-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-ttl-home-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
const WORKDIR = path.join(APP_DIR, 'workspace');
fs.mkdirSync(WORKDIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, 'config.json'), JSON.stringify({ mcpServers: {}, skills: {} }, null, 2));

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MCP_SRC = fs.readFileSync(path.join(ROOT, 'mcp-task-manager.js'), 'utf8');
const SCHED = fs.readFileSync(path.join(ROOT, 'public', 'schedule.html'), 'utf8');
const KANBAN = fs.readFileSync(path.join(ROOT, 'public', 'kanban.html'), 'utf8');

let srvLog = '';
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR, HOME: HOME_DIR,
    CCS_TASK_MANAGER_SECRET: SECRET,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
child.on('exit', () => { exited = true; });
child.stdout.on('data', d => { srvLog += d; });
child.stderr.on('data', d => { srvLog += d; });

let cleanedUp = false;
function cleanup() { if (cleanedUp) return; cleanedUp = true; if (!exited) { try { child.kill('SIGTERM'); } catch {} } }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// The shape mcp-task-manager.js posts: bearer token, {...args, action}.
async function tm(args) {
  const res = await fetch(BASE + '/api/internal/task-manager', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const NEVER = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
const LONG = 'x'.repeat(5000);
const TOO_LONG = 'y'.repeat(25000);

(async () => {
  // ── static: one number, one place ───────────────────────────────────────────────
  console.log('\n— one limit, stated once —');
  check('the shared limit is 20000', MAX_TASK_TEXT, 20000);
  check('server.js imports it instead of carrying its own copy',
    SRC.includes("require('./task-text-limit.js')"), true);
  check('no 2000-character truncation survives in server.js',
    (SRC.match(/substring\(0,\s*2000\)/g) || []).length, 0);
  check('all ten task-text writes use the shared constant',
    (SRC.match(/substring\(0,\s*MAX_TASK_TEXT\)/g) || []).length, 10);
  check('the MCP schema advertises the same number, not a smaller one',
    MCP_SRC.includes('max ${MAX_TASK_TEXT} chars') && !MCP_SRC.includes('max 2000 chars'), true);

  // Each page is a single static file with no build step, so it carries its own copy of
  // the literal; the test fails if a copy drifts from the module above.
  check('schedule.html defines the same number', /const MAX_TASK_TEXT = 20000;/.test(SCHED), true);
  check('kanban.html defines the same number', /const MAX_TASK_TEXT = 20000;/.test(KANBAN), true);
  check('schedule.html has no stale 2000 maxlength', SCHED.includes('maxlength="2000"'), false);
  check('kanban.html has no stale 2000 maxlength', KANBAN.includes('maxlength="2000"'), false);
  check('schedule.html puts the constant on its description field',
    (SCHED.match(/maxlength="\$\{MAX_TASK_TEXT\}"/g) || []).length, 1);
  check('kanban.html puts it on every task-text field',
    (KANBAN.match(/maxlength="\$\{MAX_TASK_TEXT\}"/g) || []).length, 7);
  check('the schedule card shows three lines of a description, not one',
    /\.agcard-desc\{[^}]*line-clamp:3/.test(SCHED), true);

  // The counter is the only warning a maxlength gives; wiring it to the wrong id would
  // leave the field counting nothing.
  check('the schedule counter is bound to its field',
    SCHED.includes("oninput=\"updTextCount('fDesc','fDescCount')\"") && SCHED.includes('id="fDescCount"'), true);
  check('the kanban description and notes counters are bound to their fields',
    KANBAN.includes("oninput=\"updTextCount('fDesc','fDescCount')\"") && KANBAN.includes('id="fDescCount"')
    && KANBAN.includes("oninput=\"updTextCount('fNotes','fNotesCount')\"") && KANBAN.includes('id="fNotesCount"'), true);

  // ── live: the text really survives the round trip ───────────────────────────────
  let up = false;
  for (let i = 0; i < 80 && !exited; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (exited) die(`server exited before it became ready — port ${PORT} collision or startup crash`);
  if (!up) die(`server on port ${PORT} did not start`);

  console.log('\n— a long prompt survives the HTTP API —');
  const parent = await api('POST', '/api/tasks', { title: 'parent', status: 'backlog' });
  if (parent.status !== 200 || !parent.json?.id) die(`could not create the parent task: ${parent.text}`);

  const long = await api('POST', '/api/tasks', { title: 'long prompt', description: LONG, status: 'backlog' });
  check('a 5000-character description is stored whole', long.json?.description?.length, 5000);
  check('...and is not altered', long.json?.description === LONG, true);

  const huge = await api('POST', '/api/tasks', { title: 'too long', description: TOO_LONG, status: 'backlog' });
  check('25000 characters are capped at the limit, not stored whole', huge.json?.description?.length, MAX_TASK_TEXT);
  check('the cap keeps the beginning of the text', huge.json?.description?.slice(0, 20), 'yyyyyyyyyyyyyyyyyyyy');

  console.log('\n— ...and an edit —');
  const upd = await api('PUT', `/api/tasks/${long.json.id}`, { notes: LONG });
  check('a 5000-character note is stored whole', upd.json?.notes?.length, 5000);

  console.log('\n— ...and the endpoint an agent posts to —');
  const mcp = await tm({ action: 'create_task', taskId: parent.json.id, title: 'from mcp', description: LONG, status: 'backlog', scheduled_at: NEVER });
  check('create_task accepts it', mcp.status, 200);
  const board = (await api('GET', '/api/tasks')).json;
  const row = (Array.isArray(board) ? board : board?.tasks || []).find(t => t.id === mcp.json?.task_id);
  check('the child task keeps the whole description', row?.description?.length, 5000);

  console.log('\n— nothing ran: every card above is on the board only —');
  const after = (await api('GET', '/api/tasks')).json;
  const list = Array.isArray(after) ? after : after?.tasks || [];
  check('no task was picked up by the queue', list.filter(t => t.status === 'in_progress').length, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => die(e.stack || String(e)));
