// MAX_TASK_WORKERS is a GLOBAL cap — regression guard for issue #90.
//
// History: the cap guarded ONE of processQueue's two start branches. A task with no
// session_id went through `if (indepRunning < MAX_TASK_WORKERS)`; a task WITH a
// session_id — every chain member, and every task the create modal attached to an
// existing chat — went through the `else` and started with no cap at all, limited only
// by the per-session lock and the chain-only per-workdir lock. So `MAX_TASK_WORKERS=1`
// plus two chains ran two `claude` subprocesses, which is what was reported.
//
// This EXECUTES the real processQueue out of server.js rather than pattern-matching its
// source: a source regex would pass on a rewrite that reintroduced the same hole with
// different identifiers. The closure is supplied as parameters, so the logic under test
// is the shipped one.
//
// Run: node test/task-workers.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.error(`  FAIL ${label} — ${e.message}`); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ─── Extract processQueue as a callable ─────────────────────────────────────
function loadProcessQueue() {
  const at = SRC.indexOf('\nfunction processQueue() {');
  assert.notStrictEqual(at, -1, 'function processQueue() gone — update this test');
  let i = SRC.indexOf('{', at), depth = 0, end = -1;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  assert.notStrictEqual(end, -1, 'unbalanced processQueue body');
  const body = SRC.slice(at + 1, end);
  return new Function(
    'stmts', 'taskRunning', 'independentRunning', 'blockedOnBoardWarned',
    'MAX_TASK_WORKERS', 'startTask', 'isSessionLive', 'db', 'log',
    'broadcastToSession', 'getNotificationContext', 'console',
    `${body}\nreturn processQueue;`
  );
}

// A harness that mimics the parts of startTask() the cap depends on: the id lands in
// taskRunning SYNCHRONOUSLY on entry (the real one does the same on its first line) and
// stays there until the caller releases it.
function harness({ max, tasks, alreadyRunning = [], others = [] }) {
  const started = [];
  const taskRunning = new Set(alreadyRunning);
  const independentRunning = new Set();
  const inProgress = [];
  const stmts = {
    getTodoTasks: { all: () => tasks },
    getInProgressTasks: { all: () => inProgress },
    // getTask resolves depends_on ids, which may point at rows that are NOT in the
    // todo queue (a backlog card is exactly that case).
    getTask: { get: id => [...tasks, ...others].find(t => t.id === id) || null },
  };
  const startTask = async (task) => {
    if (taskRunning.has(task.id)) return;
    taskRunning.add(task.id);
    started.push(task.id);
  };
  const noopStmt = { run: () => {} };
  const q = loadProcessQueue()(
    stmts, taskRunning, independentRunning, new Set(),
    max, startTask, () => false,
    { prepare: () => noopStmt },
    { warn: () => {}, error: () => {}, info: () => {} },
    () => {}, () => ({}),
    { log: () => {}, error: () => {}, warn: () => {} }
  );
  return { q, started, taskRunning, independentRunning, inProgress };
}

const task = (id, over = {}) => ({
  id, title: `t${id}`, session_id: null, workdir: null, chain_id: null,
  depends_on: null, ...over,
});

console.log('processQueue — MAX_TASK_WORKERS is global:');

check('session-bound tasks on DISTINCT sessions obey the cap (the #90 report)', () => {
  const h = harness({
    max: 1,
    tasks: [task('a', { session_id: 's1' }), task('b', { session_id: 's2' }), task('c', { session_id: 's3' })],
  });
  h.q();
  assert.deepStrictEqual(h.started, ['a'],
    `MAX_TASK_WORKERS=1 must start exactly one task; started ${JSON.stringify(h.started)}`);
});

check('chain members in different chains obey the cap', () => {
  const h = harness({
    max: 2,
    tasks: [
      task('a', { session_id: 's1', chain_id: 'c1', workdir: '/w1' }),
      task('b', { session_id: 's2', chain_id: 'c2', workdir: '/w2' }),
      task('c', { session_id: 's3', chain_id: 'c3', workdir: '/w3' }),
      task('d', { session_id: 's4', chain_id: 'c4', workdir: '/w4' }),
    ],
  });
  h.q();
  assert.strictEqual(h.started.length, 2, `started ${JSON.stringify(h.started)}`);
});

check('a MIXED queue shares one budget, it is not one cap per branch', () => {
  // The pre-fix code started 1 independent + N session-bound. Two budgets is the bug.
  const h = harness({
    max: 2,
    tasks: [task('i1'), task('s1', { session_id: 'x' }), task('s2', { session_id: 'y' }), task('i2')],
  });
  h.q();
  assert.strictEqual(h.started.length, 2, `started ${JSON.stringify(h.started)}`);
});

check('workers already busy count against the cap', () => {
  const h = harness({
    max: 2,
    alreadyRunning: ['old1', 'old2'],
    tasks: [task('a', { session_id: 's1' }), task('b')],
  });
  h.q();
  assert.deepStrictEqual(h.started, [], `nothing may start; started ${JSON.stringify(h.started)}`);
});

check('the cap is a floor of 1, never 0 — a queue must always drain', () => {
  const h = harness({ max: 1, tasks: [task('a')] });
  h.q();
  assert.deepStrictEqual(h.started, ['a']);
});

check('below the cap, several tasks still start in one pass', () => {
  const h = harness({ max: 5, tasks: [task('a'), task('b', { session_id: 's' }), task('c')] });
  h.q();
  assert.deepStrictEqual(h.started, ['a', 'b', 'c']);
});

console.log('\nlocks that must survive the new gate:');

check('two todo tasks on the SAME session still serialise', () => {
  const h = harness({ max: 5, tasks: [task('a', { session_id: 's' }), task('b', { session_id: 's' })] });
  h.q();
  assert.deepStrictEqual(h.started, ['a']);
});

check('two chain tasks on the same workdir still serialise', () => {
  const h = harness({
    max: 5,
    tasks: [task('a', { chain_id: 'c1', workdir: '/w', session_id: 's1' }),
            task('b', { chain_id: 'c2', workdir: '/w', session_id: 's2' })],
  });
  h.q();
  assert.deepStrictEqual(h.started, ['a']);
});

check('independent tasks are still registered in independentRunning', () => {
  const h = harness({ max: 5, tasks: [task('a')] });
  h.q();
  assert.ok(h.independentRunning.has('a'), '/api/running-sessions reads this set');
});

console.log('\nthe cap must not eat the backlog-dependency warning latch (#83):');

check('a task parked behind a backlog dep is still latched when the cap is full', () => {
  const h = harness({
    max: 1,
    tasks: [
      task('runner'),
      task('blocked', { depends_on: JSON.stringify(['dep']) }),
    ],
    others: [task('dep', { status: 'backlog' })],
  });
  h.q();
  assert.deepStrictEqual(h.started, ['runner'],
    `only the first task fits the cap; started ${JSON.stringify(h.started)}`);
});

console.log('\nsource pins:');

check('the cap gate is NOT inside either start branch', () => {
  const at = SRC.indexOf('\nfunction processQueue() {');
  const body = SRC.slice(at, SRC.indexOf('\nsetInterval(processQueue', at));
  const gate = body.indexOf('running >= MAX_TASK_WORKERS');
  const branch = body.indexOf('if (task.session_id)');
  assert.notStrictEqual(gate, -1, 'the global cap gate is gone');
  assert.ok(gate < branch,
    'the cap must be checked BEFORE the session/independent split, or one branch escapes it again');
});

check('the resolved worker count is logged at startup', () => {
  assert.ok(/taskWorkers:\s*MAX_TASK_WORKERS/.test(SRC),
    'issue #90 asked for the resolved value to be observable at boot');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
