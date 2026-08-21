// Interrupted-turn recovery — regression guard for the P0 "silent auto-restart of a
// finished session".
//
// The bug: sessions.last_user_msg is armed just before a turn runs and cleared in that
// turn's finally. The clear used to sit behind `isStale`, which is SOCKET-scoped
// (ws._tabAbort[tab] !== myAbortController) — and ws.on('close') wipes ws._tabAbort
// wholesale. Closing the tab mid-turn therefore made isStale true for a turn that still
// owned the session and then finished SUCCESSFULLY: the flag survived the success, and
// the next subscribe_session offered to re-run a prompt that had already run Bash,
// pushed to git and spent money. No crash was needed — closing a tab was enough.
//
// The fix moves the clear onto SESSION ownership (the activeTasks entry), adds
// offerInterruptedRecovery() with a server-side retry cap, an ATOMIC claim so two tabs
// racing on one offer produce exactly one run, and a boot sweep for flags left by a
// process that died.
//
// server.js exports nothing and starting it is expensive (and runs a real cleanup), so
// this file tests the real code three ways — all of them fail against the old shape:
//   1. the decision expressions (_ownTask/_ownsSession, isStale) are LIFTED VERBATIM out
//      of server.js and evaluated in a vm against the exact post-tab-close state;
//   2. offerInterruptedRecovery() is lifted whole and driven with a stub socket;
//   3. the SQL statements are lifted verbatim and run against a throwaway SQLite DB.
// Every lift is anchored on source text and asserts the anchor exists, so a rename
// fails this suite loudly instead of letting it assert against nothing — the same idiom
// test/kanban-schedule.test.js uses on public/kanban.html.
//
// Run: node test/interrupted-recovery.test.js
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
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ─── source lifting helpers ──────────────────────────────────────────────────
// Text between two anchors. Both must exist exactly once: an anchor that silently
// matched nothing would turn every assertion below into a tautology.
function between(src, startAnchor, endAnchor, what) {
  const a = src.indexOf(startAnchor);
  assert.ok(a !== -1, `${what}: start anchor not found — ${startAnchor}`);
  assert.strictEqual(src.indexOf(startAnchor, a + 1), -1, `${what}: start anchor is not unique — ${startAnchor}`);
  const b = src.indexOf(endAnchor, a);
  assert.ok(b !== -1, `${what}: end anchor not found after start — ${endAnchor}`);
  return src.slice(a, b);
}
// One brace-balanced block beginning at `anchor`.
function block(src, anchor, what) {
  const start = src.indexOf(anchor);
  assert.ok(start !== -1, `${what}: anchor not found — ${anchor}`);
  let i = src.indexOf('{', start), depth = 0;
  assert.ok(i !== -1, `${what}: no block after anchor — ${anchor}`);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${what}: unbalanced block for ${anchor}`);
}
// A single-line prepared statement, taken from server.js so the SQL under test and the
// SQL the server runs can never drift apart.
function liftSql(name) {
  const m = SRC.match(new RegExp(`\\b${name}: db\\.prepare\\(\`([^\`]+)\`\\)`));
  assert.ok(m, `stmts.${name} not found in server.js`);
  return m[1];
}
function pick(re, what) {
  const m = SRC.match(re);
  assert.ok(m, `${what}: not found in server.js`);
  return m[0];
}

// ─── 1. ownership vs staleness — the actual P0 ───────────────────────────────
// The two expressions verbatim from processChat's finally.
const OWN_TASK_SRC    = pick(/const _ownTask = activeTasks\.get\(localSessionId\);/, '_ownTask');
const OWNS_SESSION_SRC = pick(/const _ownsSession = [^;]+;/, '_ownsSession');
const IS_STALE_SRC    = pick(/const isStale = myAbortController !== null && \(effectiveTabId[\s\S]*?\);/, 'isStale');

function ownsSession({ entry, mine }) {
  const sandbox = { activeTasks: new Map(), localSessionId: 'S1', myAbortController: mine, __out: null };
  if (entry !== undefined) sandbox.activeTasks.set('S1', entry);
  vm.createContext(sandbox);
  vm.runInContext(`${OWN_TASK_SRC}\n${OWNS_SESSION_SRC}\n__out = _ownsSession;`, sandbox);
  return sandbox.__out;
}
function isStale({ ws, effectiveTabId, mine }) {
  const sandbox = { ws, effectiveTabId, myAbortController: mine, __out: null };
  vm.createContext(sandbox);
  vm.runInContext(`${IS_STALE_SRC}\n__out = isStale;`, sandbox);
  return sandbox.__out;
}

console.log('P0 — the clear is gated on SESSION ownership, not on the socket:');
{
  const mine = new AbortController();
  const theirs = new AbortController();

  // THE bug scenario. The user closed the tab; ws.on('close') wiped ws._tabAbort. The
  // turn kept running on its own AbortController, owned the activeTasks entry, and
  // finished successfully.
  const closedWs = { _tabAbort: {}, _abort: null };
  check('after the tab closed, the socket-scoped test reports STALE',
    isStale({ ws: closedWs, effectiveTabId: 'S1', mine }), true);
  check('...while the turn still OWNS the session (this is why the gate had to move)',
    ownsSession({ entry: { abortController: mine }, mine }), true);

  // The disconnect cleanupTimer calls abort() AND activeTasks.delete(), so a turn killed
  // that way reaches the finally with no entry at all. The gate is permissive on purpose:
  // no entry means nobody else claimed the session, so the flag is still ours to clear.
  check('no activeTasks entry at all still counts as owning the session',
    ownsSession({ entry: undefined, mine }), true);
  // stop + new chat: a NEWER processChat already claimed the session. Clearing then would
  // disarm a turn that is genuinely in flight.
  check('an entry belonging to a newer turn does NOT count as ours',
    ownsSession({ entry: { abortController: theirs }, mine }), false);

  // Structural: the clear must live in the _ownsSession region, ABOVE the isStale
  // declaration. Moving it back below (where it used to be) fails here.
  const GATE = between(SRC, 'const _ownTask = activeTasks.get(localSessionId);', 'const isStale =', 'finally gate');
  check('clearLastUserMsg runs before the isStale gate',
    /stmts\.clearLastUserMsg\.run\(localSessionId\)/.test(GATE), true);
  check('...inside an if (_ownsSession) block',
    /if \(_ownsSession\) \{[\s\S]*?clearLastUserMsg/.test(GATE), true);
  // Behavioural, not just structural: run the REAL finally region (down to the
  // socket-scoped cleanup) in a vm and watch whether the clear actually fires. Moving the
  // clear back under `if (!isStale)` — the old code — makes the first case below go red,
  // which is exactly the P0: a successful turn on a closed tab left the session armed.
  const FINALLY = between(SRC, 'const _ownTask = activeTasks.get(localSessionId);',
                          'if (!isStale && effectiveTabId) {', 'finally region');
  function runFinally({ ws, entry, mine }) {
    const cleared = [];
    const sandbox = {
      activeTasks: new Map(), chatBuffers: new Map(), localSessionId: 'S1',
      myAbortController: mine, effectiveTabId: 'S1', ws,
      markActivityDirty() {}, clearTimeout() {},
      pendingInterrupts: new Map(), pendingAskUser: new Map(),
      cleanupInterruptAttachments() {},
      stmts: { clearLastUserMsg: { run: id => cleared.push(id) } },
    };
    if (entry !== undefined) sandbox.activeTasks.set('S1', entry);
    vm.createContext(sandbox);
    vm.runInContext(FINALLY, sandbox);
    return { cleared, stillActive: sandbox.activeTasks.has('S1') };
  }
  check('THE P0: a turn that finished after its tab closed still clears the flag',
    runFinally({ ws: closedWs, entry: { abortController: mine }, mine }).cleared, ['S1']);
  check('...and releases the session', runFinally({ ws: closedWs, entry: { abortController: mine }, mine }).stillActive, false);
  check('a turn whose socket is still healthy clears it too',
    runFinally({ ws: { _tabAbort: { S1: mine }, _abort: null }, entry: { abortController: mine }, mine }).cleared, ['S1']);
  check('a turn superseded by a newer one clears NOTHING (would disarm a live turn)',
    runFinally({ ws: { _tabAbort: { S1: theirs }, _abort: null }, entry: { abortController: theirs }, mine }).cleared, []);
  check('...and leaves the newer turn\'s activeTasks entry alone',
    runFinally({ ws: { _tabAbort: { S1: theirs }, _abort: null }, entry: { abortController: theirs }, mine }).stillActive, true);
  check('a turn killed by the disconnect cleanupTimer (no entry left) still clears',
    runFinally({ ws: closedWs, entry: undefined, mine }).cleared, ['S1']);

  // Positive control: the isStale gate itself still exists and still guards something
  // else, so the assertion above is about placement, not about isStale being deleted.
  check('positive control: isStale is still used to guard the socket-scoped cleanup',
    /if \(!isStale\) \{/.test(SRC), true);

  // Arming order: activeTasks.set() must happen BEFORE setLastUserMsg, or a flag armed
  // while the entry still belonged to the previous turn gets wiped by that turn's finally.
  const ARM = between(SRC, 'chatBuffers.set(localSessionId, \'\');', 'markActivityDirty();', 'arming order');
  check('activeTasks.set comes before setLastUserMsg',
    ARM.indexOf('activeTasks.set(localSessionId') < ARM.indexOf('stmts.setLastUserMsg.run'), true);
}

// ─── 2. offerInterruptedRecovery — the retry cap, enforced server-side ───────
console.log('\nofferInterruptedRecovery — offer, cap, reap:');
const MAX_SRC = pick(/const INTERRUPT_MAX_RETRIES = \d+;/, 'INTERRUPT_MAX_RETRIES');
const OFFER_SRC = block(SRC, 'function offerInterruptedRecovery(', 'offerInterruptedRecovery');
const MAX = Number(MAX_SRC.match(/\d+/)[0]);
check('the cap is 3', MAX, 3);

function runOffer({ readyState = 1, row }) {
  const cleared = [];
  const ws = { readyState, sent: [], send(s) { this.sent.push(JSON.parse(s)); } };
  const sandbox = {
    ws, __out: null, JSON,
    stmts: {
      getSession: { get: () => row },
      clearLastUserMsg: { run: id => { cleared.push(id); if (row) row.last_user_msg = null; } },
    },
    log: { info() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${MAX_SRC}\n${OFFER_SRC}\n__out = offerInterruptedRecovery(ws, 'S1', 'S1', null);`, sandbox);
  return { handled: sandbox.__out, sent: ws.sent, cleared };
}

{
  const dead = runOffer({ readyState: 3, row: { last_user_msg: 'rm -rf', retry_count: 0 } });
  check('a closed socket is not "handled" (the caller keeps its own fallback)', dead.handled, false);
  check('and nothing is sent to it', dead.sent.length, 0);

  const nothing = runOffer({ row: { last_user_msg: null, retry_count: 0 } });
  check('an unarmed session is not handled, so the caller can still send task_lost', nothing.handled, false);
  check('and no task_interrupted is invented for it', nothing.sent.length, 0);

  const fresh = runOffer({ row: { last_user_msg: 'deploy to prod', retry_count: 0 } });
  check('an armed session is handled', fresh.handled, true);
  check('exactly one frame', fresh.sent.length, 1);
  check('the frame is task_interrupted', fresh.sent[0].type, 'task_interrupted');
  // `prompt` + `recoverable` are what make the client render the ask-card. Their ABSENCE
  // is what tells it to stop spinning — the two cases must stay distinguishable.
  check('it carries the prompt', fresh.sent[0].prompt, 'deploy to prod');
  check('it is marked recoverable', fresh.sent[0].recoverable, true);
  check('it reports the attempt count', fresh.sent[0].retryCount, 0);
  check('the flag is NOT cleared by merely offering', fresh.cleared.length, 0);

  const last = runOffer({ row: { last_user_msg: 'deploy to prod', retry_count: MAX - 1 } });
  check(`retry_count ${MAX - 1} is still under the cap and is offered`, last.sent[0].recoverable, true);

  const capped = runOffer({ row: { last_user_msg: 'deploy to prod', retry_count: MAX } });
  check('at the cap the socket is still handled', capped.handled, true);
  check('the flag is REAPED at the cap', capped.cleared, ['S1']);
  check('and the frame carries no prompt', capped.sent[0].prompt, undefined);
  check('nor recoverable — the client must not render an ask-card it would be refused',
    capped.sent[0].recoverable, undefined);

  const over = runOffer({ row: { last_user_msg: 'deploy to prod', retry_count: MAX + 5 } });
  check('a row already over the cap is reaped too, not offered', over.sent[0].prompt, undefined);
}

// ─── 3. resume_interrupted — claim before spawn, cap on the server ──────────
console.log('\nresume_interrupted — the only path that re-runs a turn:');
{
  const RESUME = block(SRC, "if (msg.type === 'resume_interrupted') {", 'resume_interrupted handler');
  check('the cap is checked server-side', /\(sess\.retry_count \|\| 0\) >= INTERRUPT_MAX_RETRIES/.test(RESUME), true);
  check('the claim is atomic — changes === 1 is the mutex',
    /stmts\.claimLastUserMsg\.run\(sessionId\)\.changes === 1/.test(RESUME), true);
  check('the claim happens BEFORE anything is spawned',
    RESUME.indexOf('claimLastUserMsg') < RESUME.indexOf('processChat('), true);
  check('a lost claim answers with a promptless task_interrupted instead of running',
    /if \(!_claimed\) \{[\s\S]*?task_interrupted[\s\S]*?return;/.test(RESUME), true);
  // The old auto-retry re-sent with whatever the toolbar currently held, so an opus
  // planning turn came back as haiku in auto. The turn is rebuilt from the session row.
  for (const field of ['model: sess.model', 'mode: sess.mode', 'agentMode: sess.agent_mode',
                       'workdir: sess.workdir']) {
    check(`the re-run reads ${field.split(':')[0]} from the session row`, RESUME.includes(field), true);
  }
  // engine is the ONE field deliberately NOT replayed from the row. The client sends
  // `engine: 'api'` on every chat (Subscription is paused per-turn in the UI), so replaying a
  // stored 'subscription' would route the turn through the tmux engine for a message the UI
  // considers API-only. Accepted trade-off: an idle interrupt on a subscription session
  // resets run_engine to api. Flip this assertion if the row should be preserved instead.
  check('engine is deliberately NOT replayed from the row', /engine: sess\.run_engine/.test(RESUME), false);
  check('skills come from the row, not the frame', /_rskills = JSON\.parse\(sess\.active_skills/.test(RESUME), true);
  check('MCP servers come from the row, not the frame', /_rmcp\s*= JSON\.parse\(sess\.active_mcp/.test(RESUME), true);
  check('retry:true, so processChat does the incrementRetry and skips a duplicate user bubble',
    /retry: true/.test(RESUME), true);

  const DISMISS = block(SRC, "if (msg.type === 'dismiss_interrupted') {", 'dismiss_interrupted handler');
  check('dismiss clears the flag for good', /stmts\.clearLastUserMsg\.run\(sessionId\)/.test(DISMISS), true);
}

// ─── 4. the client never auto-resends ───────────────────────────────────────
console.log('\nclient — task_interrupted is an OFFER, never a resend:');
{
  const CASE = between(CLIENT, "case 'task_interrupted': {", "case 'telegram_device_paired':", 'client handler');
  check("the handler sends no frame of its own", /ws\.send\(/.test(CASE), false);
  check('it renders the ask-card instead', /renderInterruptedCard\(/.test(CASE), true);
  check('a promptless frame clears the card rather than offering', /if \(!d\.prompt\) \{/.test(CASE), true);
  // Positive control: the resend now exists only behind the button's onclick.
  check('positive control: resume_interrupted is sent from a click handler',
    /\.ni-open'\)\.onclick[\s\S]{0,600}type: 'resume_interrupted'/.test(CLIENT), true);
  check('positive control: dismiss_interrupted is sent from a click handler',
    /\.ni-dismiss'\)\.onclick[\s\S]{0,400}type: 'dismiss_interrupted'/.test(CLIENT), true);
}

// ─── 5. the SQL, against a throwaway DB ─────────────────────────────────────
console.log('\nthe statements themselves (temp DB, real SQL lifted from server.js):');
const dbPath = path.join(os.tmpdir(), `ccs-interrupted-test-${process.pid}-${Date.now()}.db`);
const db = openDatabase(dbPath);
// The columns these statements touch, with server.js's defaults.
db.exec(`CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New session',
  last_user_msg TEXT,
  retry_count INTEGER DEFAULT 0
)`);
const S = {
  setLastUserMsg:     db.prepare(liftSql('setLastUserMsg')),
  clearLastUserMsg:   db.prepare(liftSql('clearLastUserMsg')),
  claimLastUserMsg:   db.prepare(liftSql('claimLastUserMsg')),
  clearAllLastUserMsg: db.prepare(liftSql('clearAllLastUserMsg')),
  getInterrupted:     db.prepare(liftSql('getInterrupted')),
  incrementRetry:     db.prepare(liftSql('incrementRetry')),
};
const changes = info => Number(info.changes);
const row = id => db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id);
const arm = (id, text, retries = 0) => {
  db.prepare(`INSERT OR REPLACE INTO sessions (id,title,last_user_msg,retry_count) VALUES (?,?,?,?)`)
    .run(id, id, text, retries);
};

// The atomic claim: exactly ONE of two concurrent callers may win. better-sqlite3 /
// node:sqlite are synchronous and there is one server process, so `changes === 1` is a
// real mutex against a second tab or a second device pressing Resume a millisecond later.
arm('race', 'npm publish', 1);
const first = changes(S.claimLastUserMsg.run('race'));
const second = changes(S.claimLastUserMsg.run('race'));
check('the first claim wins', first, 1);
check('the second claim loses — one offer can never produce two runs', second, 0);
check('the flag is gone after the claim', row('race').last_user_msg, null);
// retry_count must NOT be reset by the claim, or the cap could never be reached: every
// resume would re-arm from zero and the "3 strikes" ceiling would be unreachable.
check('the claim leaves retry_count alone, so the cap survives it', row('race').retry_count, 1);

// clearLastUserMsg is the "this turn is over / user said no" path and DOES reset the
// counter — a fresh turn on the same session starts from zero strikes.
arm('done', 'build', 2);
check('clearLastUserMsg drops the flag', changes(S.clearLastUserMsg.run('done')), 1);
check('...and resets retry_count', row('done').retry_count, 0);
check('...and is idempotent', changes(S.clearLastUserMsg.run('done')), 1);

check('incrementRetry counts strikes', (() => {
  arm('strikes', 'x', 0);
  S.incrementRetry.run('strikes'); S.incrementRetry.run('strikes');
  return row('strikes').retry_count;
})(), 2);
// COALESCE, because rows written before the retry_count migration have NULL there and
// NULL + 1 is NULL — the counter would stay stuck and the cap would never bite.
db.prepare(`INSERT INTO sessions (id,title,last_user_msg,retry_count) VALUES ('legacy','legacy','x',NULL)`).run();
S.incrementRetry.run('legacy');
check('a legacy NULL retry_count still increments (COALESCE)', row('legacy').retry_count, 1);

// The boot sweep. A flag alive at boot belongs to the process that just died: its
// WsProxy, AbortController and chatBuffer died with it, so nothing is resumable and the
// row is garbage that used to make the SPA silently re-run the prompt on next open.
db.prepare(`DELETE FROM sessions`).run();
arm('a', 'prompt-a', 2);
arm('b', 'prompt-b', 0);
db.prepare(`INSERT INTO sessions (id,title,last_user_msg,retry_count) VALUES ('c','c',NULL,0)`).run();
check('getInterrupted lists exactly the armed rows',
  S.getInterrupted.all().map(r => r.id).sort(), ['a', 'b']);
check('the boot sweep clears every armed row', changes(S.clearAllLastUserMsg.run()), 2);
check('nothing is left armed', S.getInterrupted.all().length, 0);
check('and the strike counters are reset with them', row('a').retry_count, 0);
check('a second sweep is a no-op (WHERE last_user_msg IS NOT NULL)',
  changes(S.clearAllLastUserMsg.run()), 0);

// The sweep only means anything if the server actually runs it at startup.
check('server.js runs the sweep on the startup path',
  /\[startup\][\s\S]{0,200}clearAllLastUserMsg\.run\(\)|clearAllLastUserMsg\.run\(\);[\s\S]{0,200}\[startup\]/.test(SRC), true);
check('setLastUserMsg is armed from processChat', /stmts\.setLastUserMsg\.run\(userMessage, localSessionId\)/.test(SRC), true);

try { db.close(); } catch {}
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
