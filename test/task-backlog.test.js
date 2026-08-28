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
//   - `status:'done'` round-trips, because "- [x]" is half of what "preserve status
//     from the checkboxes" means and the alternative is running a finished item.
//   - the DEFAULT is still 'todo'. Every existing caller omits the key; flipping the
//     default would silently stop spawning the follow-up work they asked for.
//   - status is whitelisted against three literals. 'in_progress' from a model would
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
// >= 32 chars: server.js refuses a shorter CCS_TASK_MANAGER_SECRET override and
// falls back to a random per-process secret, which would 401 every call below.
const SECRET = 'test-task-manager-secret-0123456789ab';

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

  const bl = await tm({ action: 'create_task', taskId: P, title: 'Login page', description: 'from tasks/auth/Login.md', status: 'backlog', scheduled_at: NEVER });
  check('a backlog card is accepted', bl.status, 200);
  check('and is stored as backlog, not todo', bl.json?.status, 'backlog');

  const stored = (await api('GET', `/api/tasks`)).json;
  const row = (Array.isArray(stored) ? stored : stored?.tasks || []).find(t => t.id === bl.json.task_id);
  check('the row on the board really carries backlog', row?.status, 'backlog');

  const def = await tm({ action: 'create_task', taskId: P, title: 'follow-up', description: 'x', scheduled_at: NEVER });
  check('omitting status still queues the task — the pre-#83 default', def.json?.status, 'todo');

  // "- [x] Task C" in an imported plan is a finished item. Without this the import
  // has to lie about it (backlog) or run it (todo).
  const dn = await tm({ action: 'create_task', taskId: P, title: 'Logout flow', description: 'from tasks/auth/Logout.md', status: 'done', scheduled_at: NEVER });
  check('an already-finished checklist item can be imported as done', dn.json?.status, 'done');

  const bad = await tm({ action: 'create_task', taskId: P, title: 'nope', description: 'x', status: 'in_progress' });
  check('in_progress is a 400 — it would be a row no worker owns', bad.status, 400);
  const bad2 = await tm({ action: 'create_task', taskId: P, title: 'nope', description: 'x', status: 'cancelled' });
  check('a status outside the three literals is refused, not silently coerced', bad2.status, 400);

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
  const stillBl = await tm({ action: 'create_task', taskId: P, title: 'MFA support', description: 'x', status: 'backlog', scheduled_at: NEVER });
  check('a backlog card is still accepted with the runnable budget exhausted', stillBl.status, 200);
  const stillDn = await tm({ action: 'create_task', taskId: P, title: 'Payment', description: 'x', status: 'done', scheduled_at: NEVER });
  check('...and so is a done card — neither spends the runnable budget', stillDn.status, 200);

  // And the reverse direction: 20 backlog cards (well past the runnable cap of 10)
  // all land, which is what "import a tasks/ folder" actually needs.
  let blOk = 0;
  for (let i = 0; i < 20; i++) {
    const r = await tm({ action: 'create_task', taskId: P, title: `card-${i}`, description: 'x', status: 'backlog', scheduled_at: NEVER });
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
  check('and the imported done items, which nothing ran',
    list.filter(t => t.status === 'done').length, 2);

  // ── Hardening that shipped with this feature ──────────────────────────────
  // Structural pins, in the style of the render suite: each one compares the INDEX of
  // a real statement, so a needle cannot pass on the comment that explains the rule.
  console.log('\n— hardening —');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // A short CCS_TASK_MANAGER_SECRET must be refused, not honoured: this endpoint is
  // registered before auth.authMiddleware and creates tasks that run `claude` with an
  // arbitrary prompt, so a guessable value is an unauthenticated execution primitive.
  const iEnv  = SRC.indexOf("const _tmSecretEnv = process.env.CCS_TASK_MANAGER_SECRET");
  const iLen  = SRC.indexOf("_tmSecretEnv.length >= 32", iEnv);
  const iRand = SRC.indexOf("randomBytes(16).toString('hex')", iLen);
  check('the secret override is length-checked before it is used', iEnv >= 0 && iLen > iEnv && iRand > iLen, true);
  check('the bearer comparison goes through timingSafeStrEq',
    /if \(!timingSafeStrEq\(authHeader, `Bearer \$\{TASK_MANAGER_SECRET\}`\)\)/.test(SRC), true);

  // …and behaviourally: a second server booted with a 12-char override must NOT accept
  // it — it falls back to a random per-process secret, so the short one 401s.
  const PORT2 = PORT + 1;
  const APP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-bl83-weak-'));
  fs.mkdirSync(path.join(APP2, 'data'), { recursive: true });
  fs.writeFileSync(path.join(APP2, 'config.json'), JSON.stringify({ mcpServers: {}, skills: {} }, null, 2));
  const weak = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT2), CCS_DESKTOP: '1', APP_DIR: APP2,
           WORKDIR, HOME: HOME_DIR, CCS_TASK_MANAGER_SECRET: 'short-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let weakLog = '';
  weak.stdout.on('data', d => { weakLog += d; });
  weak.stderr.on('data', d => { weakLog += d; });
  process.on('exit', () => { try { weak.kill('SIGTERM'); } catch {} try { fs.rmSync(APP2, { recursive: true, force: true }); } catch {} });
  let weakUp = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT2}/api/health`); if (r.ok) { weakUp = true; break; } } catch {}
    await sleep(250);
  }
  if (!weakUp) die(`the weak-secret server on port ${PORT2} did not start`);
  const weakRes = await fetch(`http://127.0.0.1:${PORT2}/api/internal/task-manager`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer short-secret' },
    body: JSON.stringify({ action: 'list_tasks' }),
  });
  check('a 12-char CCS_TASK_MANAGER_SECRET is ignored, so it cannot authorise', weakRes.status, 401);
  check('...and the operator is told, rather than left thinking it took', /shorter than 32 chars/.test(weakLog), true);
  try { weak.kill('SIGTERM'); } catch {}

  // The queue wake was guarded for a board row; the UI toast was not, so an 80-card
  // import stacked 80 notifications. Both halves must sit inside the willRun branch.
  const iWake   = SRC.indexOf('if (willRun) setImmediate(processQueue);');
  const iIfRun  = SRC.indexOf('if (willRun) {', iWake);
  const iCast   = SRC.indexOf('New task created:', iIfRun);
  const iCoal   = SRC.indexOf('queueBoardCardNotice(callerTask', iCast);
  check('the immediate toast is inside the willRun branch', iWake >= 0 && iIfRun > iWake && iCast > iIfRun, true);
  check('a board row is coalesced instead of announced per card', iCoal > iCast, true);
  check('the coalescer unrefs its timer so a pending notice cannot hold the process open',
    /n\.timer\.unref\(\)/.test(SRC), true);

  // A 'backlog' dependency is neither 'done' nor 'cancelled', so the dependent is
  // skipped on every tick. Waiting is correct; doing it SILENTLY was the defect.
  const iAllDone = SRC.indexOf("return !dep || dep.status === 'done'; // deleted dep = satisfied");
  const iParked  = SRC.indexOf("const parked = deps.filter(", iAllDone);
  const iWarn    = SRC.indexOf("log.warn('Task blocked by a dependency parked on the board'", iParked);
  const iCont    = SRC.indexOf('continue; // deps not ready yet', iWarn);
  check('the blocked-by-board diagnostic sits between the gate and its continue',
    iAllDone >= 0 && iParked > iAllDone && iWarn > iParked && iCont > iWarn, true);
  // The latch is RECONCILED from the queue on every pass, never deleted from at each
  // exit. A point-delete would have to be repeated at cancel, cascade-cancel, task
  // delete, session delete, chain delete and a PUT that rewrites depends_on — and each
  // one missed leaks an id AND silences the next warning for that task, because it would
  // find its own id already latched. Three structural pins, because getting any one of
  // them wrong restores exactly that bug:
  const iFillSet = SRC.indexOf('blockedStillParked.add(task.id)', iParked);
  check('the gate records into the per-pass set, not straight into the latch',
    iFillSet > iParked && iFillSet < iCont, true);
  check('no point-delete survives — the latch is not maintained at exit sites',
    SRC.includes('blockedOnBoardWarned.delete('), false);
  const iSwap = SRC.indexOf('for (const id of blockedStillParked) blockedOnBoardWarned.add(id);');
  check('the latch is reconciled AFTER the loop, so a task that stops being blocked drops out',
    iSwap > iCont && SRC.lastIndexOf('blockedOnBoardWarned.clear()', iSwap) < iSwap, true);
  // An empty queue means nothing is blocked on anything — the early return must clear it
  // too, or the last blocked set outlives the queue that produced it.
  check('the empty-queue early return clears the latch',
    /if \(!todo\.length\) \{ blockedOnBoardWarned\.clear\(\); return; \}/.test(SRC), true);

  // One run may write MAX_BOARD_CHILDREN_PER_RUN rows; a 50-row answer hid the older
  // half from the dedup check create_task's own description tells an agent to make.
  check('list_tasks caps at the board budget, not below it',
    /Math\.min\(Math\.trunc\(_lim\), MAX_BOARD_CHILDREN_PER_RUN\)/.test(SRC), true);
  // Math.min alone is not a maximum: SQLite reads a negative LIMIT as UNBOUNDED, so
  // `limit: -1` would have walked the whole table through a cap that looked applied.
  check('the limit is clamped from below too, or a negative one means "no limit" in SQLite',
    /Math\.max\(1, Math\.min\(/.test(SRC), true);
  check('a non-numeric limit falls back to the documented default instead of reaching the driver',
    /Number\.isFinite\(_lim\)/.test(SRC), true);

  // The server cap and the schema the AGENT reads are two statements of one number.
  // The server was raised to 100 while the tool description still said 50, so an agent
  // following its own tool docs would never ask for the rows the fix exists to expose.
  const MCP_SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp-task-manager.js'), 'utf8');
  check('the list_tasks schema advertises the same cap the server enforces',
    /max 100/.test(MCP_SRC) && !/max 50/.test(MCP_SRC), true);

  // A length floor is not an entropy check, and the comment must not claim it is —
  // 'a'.repeat(32) passes. The honest statement is what stops the next reader from
  // treating this var as a supported way to configure a credential.
  check('the secret floor does not overstate itself as an entropy check',
    /not an entropy check/.test(SRC), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => die(e.stack || String(e)));
