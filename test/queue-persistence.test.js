// Persisted chat queue — the row must die the moment the message leaves the queue.
//
// The invariant is stated in the schema itself (server.js, `queued_messages`):
//   "The row is written when the message is queued and deleted the moment it is
//    dequeued — BEFORE the run starts."
// Three of the four removal paths broke it, and the fourth corrupted the row:
//   _dequeue_next   dropped the message from ws._tabQueue only  → boot-restore re-ran
//                   that turn on EVERY later restart, forever;
//   stop            cleared ws._tabQueue[tab] only               → every message the user
//                   cancelled came back and ran after the next restart;
//   queue_remove    spliced the array only                      → the user got a
//                   `queue_removed` confirmation for a message that later executed;
//   queue_edit      rewrote the in-memory copy only              → the restart replayed
//                   the PRE-EDIT text the user had already corrected.
//
// This file drives the four REAL handler blocks — lifted verbatim out of server.js and
// run in a vm with stub sockets/maps — against a throwaway SQLite DB holding the real
// `queued_messages` table, then does what a restart does (`allQueuedMsgs`) and asserts
// what survives. Anchors are checked for existence and uniqueness, so a rename fails
// this suite instead of quietly making it assert nothing.
//
// Run: node test/queue-persistence.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const openDatabase = require('../db-adapter');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function uniqueAnchor(anchor, what) {
  const a = SRC.indexOf(anchor);
  assert.ok(a !== -1, `${what}: anchor not found — ${anchor}`);
  assert.strictEqual(SRC.indexOf(anchor, a + 1), -1, `${what}: anchor is not unique — ${anchor}`);
  return a;
}
// One brace-balanced block beginning at `anchor`.
function block(anchor, what) {
  const start = uniqueAnchor(anchor, what);
  let i = SRC.indexOf('{', start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`${what}: unbalanced block for ${anchor}`);
}
function between(startAnchor, endAnchor, what) {
  const a = uniqueAnchor(startAnchor, what);
  const b = SRC.indexOf(endAnchor, a);
  assert.ok(b !== -1, `${what}: end anchor not found — ${endAnchor}`);
  return SRC.slice(a, b);
}
function liftSql(name) {
  const m = SRC.match(new RegExp(`\\b${name}: db\\.prepare\\(\`([^\`]+)\`\\)`));
  assert.ok(m, `stmts.${name} not found in server.js`);
  return m[1];
}

// ─── the real table, the real statements ────────────────────────────────────
const DDL = (() => {
  const start = uniqueAnchor('CREATE TABLE IF NOT EXISTS queued_messages', 'queued_messages DDL');
  const end = SRC.indexOf(');', start);
  assert.ok(end !== -1, 'queued_messages DDL never closes');
  return SRC.slice(start, end + 2);
})();

const dbPath = path.join(os.tmpdir(), `ccs-queue-test-${process.pid}-${Date.now()}.db`);
const db = openDatabase(dbPath);
db.exec(DDL);
db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)`);
db.prepare(`INSERT INTO sessions (id,title) VALUES ('S1','s1'),('S2','s2')`).run();

const stmts = {
  addQueuedMsg:       db.prepare(liftSql('addQueuedMsg')),
  delQueuedMsg:       db.prepare(liftSql('delQueuedMsg')),
  delQueuedBySession: db.prepare(liftSql('delQueuedBySession')),
  updQueuedMsg:       db.prepare(liftSql('updQueuedMsg')),
  allQueuedMsgs:      db.prepare(liftSql('allQueuedMsgs')),
  getSession:         db.prepare(`SELECT * FROM sessions WHERE id=?`),
};

// What a restart actually does: re-read every surviving row and re-queue it
// (server.js "Restore queued chat messages left by a previous process").
function afterRestart() {
  return stmts.allQueuedMsgs.all().map(r => {
    const msg = JSON.parse(r.payload);
    msg._dbQueueId = Number(r.id);
    return msg;
  });
}
const restartTexts = () => afterRestart().map(m => m.text);

// Enqueue exactly the way the `chat` handler does: persist FIRST, then push, so a crash
// between the two cannot leave a message the user believes is waiting but which exists
// nowhere.
let queueIdCounter = 0;
function enqueue(ws, tabId, text) {
  const msg = { type: 'chat', text, tabId, sessionId: tabId, model: 'opus', queueId: ++queueIdCounter };
  msg._queueId = msg.queueId;
  const info = stmts.addQueuedMsg.run(tabId, JSON.stringify(msg));
  msg._dbQueueId = Number(info.lastInsertRowid);
  (ws._tabQueue[tabId] || (ws._tabQueue[tabId] = [])).push(msg);
  return msg;
}

// ─── a stub socket + the module-level maps the handlers close over ──────────
function makeWs() {
  return {
    readyState: 1, sent: [],
    send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); },
    _tabQueue: {}, _tabBusy: {}, _tabAbort: {}, _queue: [], _queueIdCounter: 0,
    emit() {},
  };
}
// Run one lifted handler block. Wrapped in a function so its bare `return`s are legal.
function runHandler(blockSrc, { msg, ws, activeChatSessions = new Set(), activeTasks = new Map(),
                                sessionQueues = new Map(), processChat = () => Promise.resolve(), extra = {} }) {
  const started = [];
  const sandbox = {
    msg, ws, stmts, JSON, Object, Array, Number, Set, Map, console,
    activeChatSessions, activeTasks, sessionQueues,
    // The real isSessionLive() also consults the tasks table — a Kanban worker holds a
    // session without appearing in either in-memory set, and the dequeue gate must see
    // that or it runs a queued message straight back into the task that queued it.
    // `hasRunningTask` here is whatever the caller stubbed via `extra`.
    isSessionLive: id => activeTasks.has(id) || activeChatSessions.has(id)
      || (extra.hasRunningTask ? extra.hasRunningTask(id) : false),
    processChat: m => { started.push(m); return Promise.resolve(processChat(m)); },
    queuePayload: tabId => JSON.stringify({ type: 'queue_update', tabId }),
    log: { info() {}, warn() {}, error() {} },
    setImmediate: () => {},
    sessionWatchers: new Map(),
    pendingInterrupts: new Map(), pendingAskUser: new Map(),
    cleanupInterruptAttachments: () => {},
    stoppingTasks: new Set(), runningTaskAborts: new Map(), killByPid: () => {},
    db: { prepare: () => ({ get: () => null, run: () => ({ changes: 0 }) }) },
    ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(`(function(){ ${blockSrc} })();`, sandbox);
  return { started, sandbox };
}

// ─── path 1: _dequeue_next ──────────────────────────────────────────────────
// The site that leaked hardest: a dequeued message kept its row, so boot-restore
// re-queued and re-ran it on EVERY later restart — forever, and unattended.
console.log('_dequeue_next — the row dies before the run starts:');
{
  const DEQUEUE = block("if (msg.type === '_dequeue_next') {", '_dequeue_next handler');
  const ws = makeWs();
  const a = enqueue(ws, 'S1', 'first');
  enqueue(ws, 'S1', 'second');
  check('both messages are persisted while they wait', restartTexts(), ['first', 'second']);

  const { started } = runHandler(DEQUEUE, { msg: { type: '_dequeue_next', tabId: 'S1' }, ws });
  check('the handler started exactly one turn', started.length, 1);
  check('...the head of the queue', started[0].text, 'first');
  check('the started message no longer survives a restart', restartTexts(), ['second']);
  check('and it is off the in-memory queue too', ws._tabQueue['S1'].map(m => m.text), ['second']);
  // The delete has to happen BEFORE the run, not in the run's finally: a crash mid-run
  // must lose that one message rather than replay a turn that already spent money.
  check('the row is deleted before processChat is called',
    DEQUEUE.includes('stmts.delQueuedMsg.run') &&
    DEQUEUE.indexOf('stmts.delQueuedMsg.run') < DEQUEUE.indexOf('processChat('), true);

  // A dequeue that is refused (session busy) must not delete anything.
  const busy = runHandler(DEQUEUE, { msg: { type: '_dequeue_next', tabId: 'S1' }, ws,
    activeChatSessions: new Set(['S1']) });
  check('a refused dequeue starts nothing', busy.started.length, 0);
  check('...and leaves the row alone', restartTexts(), ['second']);

  // A KANBAN TASK holding the session must refuse the dequeue too. This gate used to
  // test activeChatSessions/activeTasks directly, and a task worker registers in
  // NEITHER — its liveness lives only in tasks.status='in_progress'. So a message that
  // was queued BECAUSE a task held the session was dequeued and run straight back into
  // that task: two `claude --resume <same cid>` on one transcript.
  const taskBusy = runHandler(DEQUEUE, { msg: { type: '_dequeue_next', tabId: 'S1' }, ws,
    extra: { hasRunningTask: id => id === 'S1' } });
  check('a dequeue is refused while a Kanban task holds the session', taskBusy.started.length, 0);
  check('...and that row is untouched as well', restartTexts(), ['second']);
  check('the gate goes through isSessionLive, not the two in-memory sets',
    /!isSessionLive\(tabId\)/.test(DEQUEUE) && !/!activeTasks\.has\(tabId\)/.test(DEQUEUE), true);

  // A deleted session drops its queue entirely rather than leaving orphan rows behind.
  const gone = runHandler(DEQUEUE, { msg: { type: '_dequeue_next', tabId: 'NOPE' }, ws });
  check('a dequeue for a deleted session starts nothing', gone.started.length, 0);

  stmts.delQueuedBySession.run('S1'); stmts.delQueuedBySession.run('S2');
}

// ─── path 2: stop clears the queue ──────────────────────────────────────────
console.log('\nstop — cancelling the queue cancels it durably:');
{
  const STOP = block("if (msg.type==='stop') {", 'stop handler');
  const ws = makeWs();
  ws._tabAbort['S1'] = { abort() {} };
  enqueue(ws, 'S1', 'cancel-me-1');
  enqueue(ws, 'S1', 'cancel-me-2');
  enqueue(ws, 'S2', 'other-session');

  runHandler(STOP, { msg: { type: 'stop', tabId: 'S1' }, ws });
  check('the stopped session keeps nothing across a restart',
    afterRestart().filter(m => m.tabId === 'S1').length, 0);
  check('a different session is untouched (DELETE is scoped by session_id)',
    restartTexts(), ['other-session']);
  // (compared by length: the handler builds this array inside the vm realm, so
  // deepStrictEqual against a host [] would fail on the prototype, not the contents)
  check('and the in-memory queue is empty too', ws._tabQueue['S1'].length, 0);

  stmts.delQueuedBySession.run('S2');
}

// ─── path 3: queue_remove ───────────────────────────────────────────────────
console.log('\nqueue_remove — "deleted" has to mean deleted:');
{
  const REMOVE = block("if (msg.type === 'queue_remove') {", 'queue_remove handler');
  const ws = makeWs();
  enqueue(ws, 'S1', 'keep-1');
  const victim = enqueue(ws, 'S1', 'delete-me');
  enqueue(ws, 'S1', 'keep-2');

  const { sandbox } = runHandler(REMOVE, { msg: { type: 'queue_remove', queueId: victim.queueId, tabId: 'S1' }, ws });
  check('the client is told it was removed',
    ws.sent.some(f => f.type === 'queue_removed' && f.queueId === victim.queueId), true);
  check('...and it really is gone from the queue', ws._tabQueue['S1'].map(m => m.text), ['keep-1', 'keep-2']);
  // THE regression: the confirmation used to be a lie — the row survived and the message
  // the user explicitly deleted executed after the next restart.
  check('a restart does NOT bring the deleted message back', restartTexts(), ['keep-1', 'keep-2']);
  check('only the victim was deleted, not the whole session', restartTexts().length, 2);

  stmts.delQueuedBySession.run('S1');
}

// ─── path 4: queue_edit ─────────────────────────────────────────────────────
console.log('\nqueue_edit — the stored payload is rewritten, not just the RAM copy:');
{
  const EDIT = block("if (msg.type === 'queue_edit') {", 'queue_edit handler');
  const ws = makeWs();
  const item = enqueue(ws, 'S1', 'send teh wrong thing');
  check('the pre-edit text is what is stored', restartTexts(), ['send teh wrong thing']);

  runHandler(EDIT, { msg: { type: 'queue_edit', queueId: item.queueId, text: 'send the right thing' }, ws });
  check('the client is told it was edited',
    ws.sent.some(f => f.type === 'queue_edited' && f.queueId === item.queueId), true);
  check('the in-memory copy is updated', ws._tabQueue['S1'][0].text, 'send the right thing');
  // THE regression: only the RAM copy moved, so a restart replayed the text the user had
  // already corrected — the classic "it sent the typo anyway" report.
  check('a restart replays the EDITED text', restartTexts(), ['send the right thing']);
  check('the edit rewrote the row rather than inserting a second one',
    stmts.allQueuedMsgs.all().length, 1);
  // _dbQueueId is stripped on the way in: it is assigned AFTER the original INSERT and
  // boot-restore re-derives it from row.id. A stale one baked into the payload would make
  // a later delete target the wrong row.
  const stored = JSON.parse(stmts.allQueuedMsgs.all()[0].payload);
  check('the stored payload carries no baked-in _dbQueueId', '_dbQueueId' in stored, false);
  check('...but the restore re-derives it from the row id', afterRestart()[0]._dbQueueId, Number(stmts.allQueuedMsgs.all()[0].id));
  check('the rest of the payload survives the edit (model is not reset)', stored.model, 'opus');

  stmts.delQueuedBySession.run('S1');
}

// ─── path 5: the finally-drain, the other dequeue site ──────────────────────
// processChat's finally drains the next queued message directly instead of going through
// _dequeue_next. It is the same invariant and it needs the same delete.
console.log('\nthe finally-drain honours the same invariant:');
{
  const DRAIN = between('const tabQ = ws._tabQueue[effectiveTabId] || [];',
                        "processChat(next).catch(err => log.error('processChat tab-queue error'", 'finally drain');
  // The slice ENDS at the processChat call, so finding the delete inside it is itself the
  // proof of ordering — nothing here can pass by the delete simply being absent.
  check('it deletes the row it is about to run', /stmts\.delQueuedMsg\.run\(next\._dbQueueId\)/.test(DRAIN), true);
  check('the slice really is the short pre-run region, not half the file', DRAIN.length < 1200, true);
  check('...and it pops the message off the in-memory queue as well', /tabQ\.shift\(\)/.test(DRAIN), true);
}

// ─── the whole user story, end to end ───────────────────────────────────────
console.log('\nfull story — queue 3, edit one, delete one, run one, then restart:');
{
  const DEQUEUE = block("if (msg.type === '_dequeue_next') {", '_dequeue_next handler');
  const REMOVE  = block("if (msg.type === 'queue_remove') {", 'queue_remove handler');
  const EDIT    = block("if (msg.type === 'queue_edit') {", 'queue_edit handler');
  const ws = makeWs();
  const m1 = enqueue(ws, 'S1', 'msg-1-runs-now');
  const m2 = enqueue(ws, 'S1', 'msg-2-user-deletes');
  const m3 = enqueue(ws, 'S1', 'msg-3-typo');

  runHandler(EDIT,   { msg: { type: 'queue_edit', queueId: m3.queueId, text: 'msg-3-fixed' }, ws });
  runHandler(REMOVE, { msg: { type: 'queue_remove', queueId: m2.queueId, tabId: 'S1' }, ws });
  const run = runHandler(DEQUEUE, { msg: { type: '_dequeue_next', tabId: 'S1' }, ws });

  check('exactly one turn started', run.started.map(m => m.text), ['msg-1-runs-now']);
  // Old behaviour after a restart here: ['msg-1-runs-now', 'msg-2-user-deletes', 'msg-3-typo']
  // — a turn that already ran, a message the user deleted, and the uncorrected typo.
  check('the restart replays exactly the one message still legitimately waiting',
    restartTexts(), ['msg-3-fixed']);
  check('m1 is gone', restartTexts().includes('msg-1-runs-now'), false);
  check('m2 is gone', restartTexts().includes('msg-2-user-deletes'), false);
  check('the typo is gone', restartTexts().includes('msg-3-typo'), false);

  stmts.delQueuedBySession.run('S1');
}

// ─── call-site wiring ───────────────────────────────────────────────────────
// The behavioural checks above run lifted blocks; these assert those blocks are the ones
// the server actually reaches, and that the schema still states the invariant they encode.
console.log('\nwiring + the invariant the schema promises:');
{
  check('the schema still documents delete-on-dequeue',
    /deleted the moment it is\s*--\s*dequeued — BEFORE the run starts/.test(SRC), true);
  check('the chat handler persists BEFORE enqueuing',
    /stmts\.addQueuedMsg\.run\(tabId, JSON\.stringify\(msg\)\)/.test(SRC), true);
  check('boot-restore reads every surviving row', /stmts\.allQueuedMsgs\.all\(\)/.test(SRC), true);
  check('boot-restore re-derives _dbQueueId from the row id', /msg\._dbQueueId = row\.id/.test(SRC), true);
  check('boot-restore drops rows it cannot parse instead of re-queuing junk',
    /if \(!msg \|\| !row\.session_id\) \{ try \{ stmts\.delQueuedMsg\.run\(row\.id\)/.test(SRC), true);
  // Every statement that can remove a row must be used somewhere — an unused one means a
  // path went back to memory-only.
  // delQueuedBySession has THREE call sites: `stop` (tested above) and BOTH session-delete
  // paths. The single-session DELETE was missing it — queued_messages has no FK, so
  // boot-restore resurrected rows of a deleted chat on every restart, forever.
  check('deleting a session drops its queued rows', /deleteSession[\s\S]{0,4000}?stmts\.delQueuedBySession\.run\(id\)/.test(SRC), true);
  check('the single-session DELETE purges the queue too', /deleteSession\.run\(sid\)[\s\S]{0,600}?stmts\.delQueuedBySession\.run\(sid\)/.test(SRC), true);
  for (const [name, count] of [['delQueuedMsg', 4], ['delQueuedBySession', 3], ['updQueuedMsg', 1]]) {
    const uses = (SRC.match(new RegExp(`stmts\\.${name}\\.run\\(`, 'g')) || []).length;
    check(`stmts.${name} is used at ${count} call site(s)`, uses, count);
  }
}

try { db.close(); } catch {}
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
