'use strict';

// Exercise the real Schedule handlers without a browser or live task execution.
// Run: node test/schedule-actions.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const schedule = fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function lift(src, name) {
  let at = src.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} must exist`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, `${name} must have a top-level closing brace`);
  return src.slice(at, end + 2);
}

function harness({ orig = null, workdir = null } = {}) {
  const fields = {
    fTitle: { value: 'Edited title' }, fDesc: { value: 'Description' },
    fScheduledAt: { value: '' }, fEndDate: { value: '' },
    fMaxTurns: { value: '30' }, fSession: { value: orig?.session_id || '' },
    fRecurUnit: { value: '' }, fRecurN: { value: '1' },
  };
  const calls = [];
  const notices = [];
  const ctx = {
    $i: id => fields[id] || null,
    tasks: orig ? [orig] : [], editingId: orig?.id || null, curWorkdir: workdir,
    getScVal: (_, fallback) => fallback,
    _schedDefaultEngine: 'api', _schedTmuxAvailable: true,
    apiFetch: async (url, options) => calls.push({ url, method: options.method, body: JSON.parse(options.body) }),
    toast: (...args) => notices.push(args), t: x => x,
    closeModal() {}, async refresh() {},
  };
  vm.createContext(ctx);
  vm.runInContext(['toLocalDatetimeStr', 'buildRecurToken', 'runNow', 'runChainNow', 'saveTask']
    .map(name => lift(schedule, name)).join('\n'), ctx);
  if (orig?.scheduled_at) fields.fScheduledAt.value = ctx.toLocalDatetimeStr(orig.scheduled_at);
  return { ctx, fields, calls, notices };
}

const original = {
  id: 'task-a', title: 'Original', status: 'todo', sort_order: 2000,
  workdir: '/projects/important/.worktrees/task-a', session_id: 'session-a',
  scheduled_at: Math.floor(new Date(2030, 5, 15, 12, 34, 57).getTime() / 1000),
};

test('all inline Schedule scripts parse', () => {
  for (const [i, match] of [...schedule.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
    new vm.Script(match[1], { filename: `schedule.html#script${i}` });
  }
});

test('Run now clears the due-date gate without replacing recurrence settings', async () => {
  const { ctx, calls } = harness({ orig: original });
  await ctx.runNow(original.id);
  assert.deepEqual(calls, [{
    url: '/api/tasks/task-a', method: 'PUT', body: { status: 'todo', scheduled_at: null },
  }]);
});

test('chain Run now explicitly overrides scheduled activation', async () => {
  const { ctx, calls } = harness();
  await ctx.runChainNow('chain-a');
  assert.deepEqual(calls, [{
    url: '/api/task-chains/chain-a/activate', method: 'POST', body: { run_now: true },
  }]);
});

function activationHarness() {
  const db = require('../db-adapter')(':memory:');
  db.exec(`
    CREATE TABLE task_chains (id TEXT, scheduled_at INTEGER, updated_at TEXT);
    CREATE TABLE tasks (id TEXT, chain_id TEXT, status TEXT, depends_on TEXT, sort_order INTEGER, scheduled_at INTEGER, updated_at TEXT);
    INSERT INTO task_chains VALUES ('chain-a',2000000000,'original');
    INSERT INTO tasks VALUES ('first','chain-a','backlog',NULL,0,2000000000,'original');
    INSERT INTO tasks VALUES ('second','chain-a','backlog',NULL,1000,2000000000,'original');
  `);
  let handler;
  const stmts = {
    getChain: db.prepare('SELECT * FROM task_chains WHERE id=?'),
    getChainTasksList: db.prepare('SELECT * FROM tasks WHERE chain_id=? ORDER BY sort_order'),
  };
  const ctx = {
    db, stmts, app: { post: (_, fn) => { handler = fn; } },
    chainWithSummary: x => x, setImmediate() {}, processQueue() {},
  };
  const start = server.indexOf("app.post('/api/task-chains/:id/activate'");
  assert.notEqual(start, -1);
  const end = server.indexOf('\n});', start);
  assert.notEqual(end, -1);
  vm.runInNewContext(server.slice(start, end + 4), ctx);
  return { db, stmts, activate(body) {
    let response;
    handler({ params: { id: 'chain-a' }, body }, { json(value) { response = value; } });
    return response;
  } };
}

test('ordinary chain activation preserves the chain and member schedules', () => {
  const { db, stmts, activate } = activationHarness();
  try {
    activate();
    assert.equal(stmts.getChain.get('chain-a').scheduled_at, 2000000000);
    const members = stmts.getChainTasksList.all('chain-a');
    assert.ok(members.every(task => task.status === 'todo' && task.scheduled_at === 2000000000));
  } finally { db.close(); }
});

test('explicit Run now clears both chain and member due-date gates', () => {
  const { db, stmts, activate } = activationHarness();
  try {
    const response = activate({ run_now: true });
    assert.equal(response.scheduled_at, null);
    assert.equal(stmts.getChain.get('chain-a').scheduled_at, null);
    const members = stmts.getChainTasksList.all('chain-a');
    assert.ok(members.every(task => task.status === 'todo' && task.scheduled_at === null));
    assert.equal(members[0].depends_on, null);
    assert.equal(members[1].depends_on, '["first"]');
  } finally { db.close(); }
});

test('Run now schedule updates roll back together if a member update fails', () => {
  const { db, stmts, activate } = activationHarness();
  try {
    db.exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON tasks WHEN OLD.id='second'
      BEGIN SELECT RAISE(ABORT,'test failure'); END`);
    assert.throws(() => activate({ run_now: true }), /test failure/);
    assert.equal(stmts.getChain.get('chain-a').scheduled_at, 2000000000);
    assert.ok(stmts.getChainTasksList.all('chain-a').every(task => task.status === 'backlog' && task.scheduled_at === 2000000000));
  } finally { db.close(); }
});

test('editing in All projects preserves the original project and session', async () => {
  const { ctx, calls } = harness({ orig: original });
  await ctx.saveTask();
  assert.equal(calls[0].body.workdir, original.workdir);
  assert.equal(calls[0].body.session_id, original.session_id);
  assert.equal(calls[0].body.sort_order, original.sort_order);
});

test('editing in a project view preserves the exact worktree instead of the filter root', async () => {
  const { ctx, calls } = harness({ orig: original, workdir: '/projects/important' });
  await ctx.saveTask();
  assert.equal(calls[0].body.workdir, original.workdir);
});

test('editing an unassigned task does not silently assign the filter project', async () => {
  const { ctx, calls } = harness({ orig: { ...original, workdir: null }, workdir: '/projects/other' });
  await ctx.saveTask();
  assert.equal(calls[0].body.workdir, null);
});

test('new tasks still use the selected project', async () => {
  const { ctx, calls } = harness({ workdir: '/projects/new' });
  await ctx.saveTask();
  assert.equal(calls[0].url, '/api/tasks');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.workdir, '/projects/new');
});

test('a title-only edit preserves the scheduled seconds', async () => {
  const { ctx, calls } = harness({ orig: original });
  await ctx.saveTask();
  assert.equal(calls[0].body.scheduled_at, original.scheduled_at);
});

test('changing the date commits the newly selected local minute', async () => {
  const { ctx, fields, calls } = harness({ orig: original });
  fields.fScheduledAt.value = '2030-06-16T13:45';
  await ctx.saveTask();
  assert.equal(calls[0].body.scheduled_at, Math.floor(new Date(2030, 5, 16, 13, 45).getTime() / 1000));
});

test('clearing the date sends explicit null', async () => {
  const { ctx, fields, calls } = harness({ orig: original });
  fields.fScheduledAt.value = '';
  await ctx.saveTask();
  assert.equal(calls[0].body.scheduled_at, null);
});

test('unrelated edits preserve a running task status', async () => {
  const { ctx, calls } = harness({ orig: { ...original, status: 'in_progress' } });
  await ctx.saveTask();
  assert.equal(calls[0].body.status, 'in_progress');
});

test('manual recurring runs re-arm from completion under the real server scheduler', () => {
  const now = new Date(2030, 5, 15, 10, 30, 17).getTime();
  class FixedDate extends Date { static now() { return now; } }
  const writes = [];
  const ctx = {
    Date: FixedDate,
    db: { prepare: () => ({ run: (...args) => writes.push(args) }) },
    log: { info() {}, warn() {} },
  };
  vm.createContext(ctx);
  const aliases = server.match(/^const RECUR_ALIASES = .*;$/m);
  assert.ok(aliases, 'server recurrence aliases must exist');
  vm.runInContext([aliases[0], lift(server, 'calcNextRun'), lift(server, 'scheduleNextRun')].join('\n'), ctx);
  assert.equal(ctx.scheduleNextRun({ id: 'recurring', title: 'Daily job', scheduled_at: null, recurrence: 'daily' }), true);
  const next = new Date(now); next.setDate(next.getDate() + 1);
  assert.deepEqual(writes, [[Math.floor(next.getTime() / 1000), 'recurring']]);
});
