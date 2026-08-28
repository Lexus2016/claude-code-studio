// create_task can put a card on the board WITHOUT queueing a run — issue #83.
//
// Before this, `_ccs_task_manager.create_task` hardcoded status 'todo', so the only
// thing an agent could do with the Kanban board was START work on it. Turning an
// existing plan (a `tasks/` folder, a roadmap, a checklist) into cards therefore
// launched one unattended `claude` per card the moment the import ran — which is the
// opposite of an import.
//
// What this file is here to catch:
//
//   - a `status:'backlog'` card is stored as 'backlog' and stays there. If the literal
//     'todo' creeps back into the INSERT, every imported card fires.
//   - the DEFAULT is still 'todo'. Every existing caller omits the key; flipping the
//     default would silently stop spawning the follow-up work they asked for.
//   - status is whitelisted against two literals. 'in_progress' from a model would
//     hand the board a row no worker owns and no queue will ever pick up.
//   - the two child budgets are SEPARATE. A backlog card cannot recurse (processQueue
//     never selects it), so it must not eat the runnable budget — otherwise an import
//     of ten cards leaves the run unable to create the one follow-up task it needed.
//   - and the reverse: the runnable cap is still 10, counted over runnable children
//     only.
//
// The endpoint is driven exactly the way mcp-task-manager.js drives it (bearer +
// {action, taskId, ...args}), with CCS_TASK_MANAGER_SECRET pinned so the test knows
// the token. Every 'todo' child is created with a far-future scheduled_at:
// getTodoTasks filters on `scheduled_at <= unixepoch()`, so the queue never picks one
// up and this suite cannot spawn a real `claude`.
//
// Run: node test/task-backlog.test.js   (TEST_PORT=<n> to move off the default)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = Number(process.env.TEST_PORT || 4551);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-task-manager-secret';

const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-bl83-app-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-bl83-home-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
const WORKDIR = path.join(APP_DIR, 'workspace');
fs.mkdirSync(WORKDIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, 'config.json'), JSON.stringify({ mcpServers: {}, skills: {} }, null, 2));

let srvLog = '';
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
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

// Far enough out that getTodoTasks' `scheduled_at <= unixepoch()` never matches, so a
// 'todo' child created here is counted by the cap and started by nothing.
const NEVER = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();

(async () => {
  let up = false;
  for (let i = 0; i < 80 && !exited; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (exited) die(`server exited before it became ready — port ${PORT} collision or startup crash`);
  if (!up) die(`server on port ${PORT} did not start`);

  // The parent. No workdir on purpose: setupUnitWorktree returns null for that case,
  // so this suite mints no git worktrees.
  const p = await api('POST', '/api/tasks', { title: 'importer', status: 'backlog' });
  if (p.status !== 200 || !p.json?.id) die(`could not create the parent task: ${p.text}`);
  const P = p.json.id;

  console.log('\n— status on create_task —');

  const bl = await tm({ action: 'create_task', taskId: P, title: 'Login page', description: 'from tasks/auth/Login.md', status: 'backlog' });
  check('a backlog card is accepted', bl.status, 200);
  check('and is stored as backlog, not todo', bl.json?.status, 'backlog');

  const stored = (await api('GET', `/api/tasks`)).json;
  const row = (Array.isArray(stored) ? stored : stored?.tasks || []).find(t => t.id === bl.json.task_id);
  check('the row on the board really carries backlog', row?.status, 'backlog');

  const def = await tm({ action: 'create_task', taskId: P, title: 'follow-up', description: 'x', scheduled_at: NEVER });
  check('omitting status still queues the task — the pre-#83 default', def.json?.status, 'todo');

  const bad = await tm({ action: 'create_task', taskId: P, title: 'nope', description: 'x', status: 'in_progress' });
  check('a status outside {backlog,todo} is a 400, not a silently coerced row', bad.status, 400);
  const bad2 = await tm({ action: 'create_task', taskId: P, title: 'nope', description: 'x', status: 'done' });
  check('"done" is refused too', bad2.status, 400);

  console.log('\n— the two child budgets are separate —');

  // 9 more runnable children (one already exists from `def`) → exactly at the cap of 10.
  for (let i = 0; i < 9; i++) {
    const r = await tm({ action: 'create_task', taskId: P, title: `run-${i}`, description: 'x', scheduled_at: NEVER });
    if (r.status !== 200) die(`runnable child ${i} was refused before the cap: ${r.text}`);
  }
  const over = await tm({ action: 'create_task', taskId: P, title: 'run-10', description: 'x', scheduled_at: NEVER });
  check('the 11th RUNNABLE child is refused (cap 10)', over.status, 429);

  // The point of the split: the board import keeps working after the runnable
  // budget is spent, because a backlog card starts no process.
  const stillBl = await tm({ action: 'create_task', taskId: P, title: 'MFA support', description: 'x', status: 'backlog' });
  check('a backlog card is still accepted with the runnable budget exhausted', stillBl.status, 200);

  // And the reverse direction: 20 backlog cards (well past the runnable cap of 10)
  // all land, which is what "import a tasks/ folder" actually needs.
  let blOk = 0;
  for (let i = 0; i < 20; i++) {
    const r = await tm({ action: 'create_task', taskId: P, title: `card-${i}`, description: 'x', status: 'backlog' });
    if (r.status === 200 && r.json?.status === 'backlog') blOk++;
  }
  check('20 more backlog cards all land — a plan import is not bounded by 10', blOk, 20);

  // Nothing above may have been started: every runnable child is scheduled a year out.
  const after = (await api('GET', '/api/tasks')).json;
  const list = Array.isArray(after) ? after : after?.tasks || [];
  check('no card was picked up by the queue',
    list.filter(t => t.status === 'in_progress').length, 0);
  check('the board holds every backlog card that was created',
    list.filter(t => t.status === 'backlog' && t.id !== P).length, 22);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => die(e.stack || String(e)));
