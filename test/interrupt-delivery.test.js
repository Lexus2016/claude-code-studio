// Mid-task clarification delivery on the subscription (tmux) engine.
//
// A clarification typed into a working chat has to survive a path with no return
// channel: server queue -> drain -> tmux paste -> Enter -> the agent's TUI. Three
// independent review rounds killed this feature in three different places, and every
// one of them was invisible at runtime — the message just vanished. The contracts
// below are what each fix rests on; none of them is expressible as a unit call
// (the logic lives inside runInteractiveSingle's poll loop and processChat's finally
// block, neither of which is importable without spawning tmux or an HTTP server), so
// they are pinned against the source the same way test/script-scope.test.mjs pins
// declaration placement.
//
// Run: node test/interrupt-delivery.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CI = fs.readFileSync(path.join(__dirname, '..', 'claude-interactive.js'), 'utf8');
const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.message); }
}

console.log('interrupt delivery — subscription engine');

// ── 1. Ordering: injection before the completion break ────────────────────────
// The original fix shipped with the injection block placed AFTER the poll loop's
// completion check, so on a normal turn the loop broke out before injection ever
// ran. Dead code that passed every test and delivered nothing.
t('injection block runs before the completion break', () => {
  const inject = CI.indexOf('drainInterrupts()');
  const brk = CI.indexOf('if (endTurnSeen && !busy && !gotNewBytes) break;');
  assert.ok(inject > 0, 'drainInterrupts() call not found');
  assert.ok(brk > 0, 'completion break not found');
  assert.ok(inject < brk, 'drainInterrupts() must be reached before the loop can break out');
});

// ── 2. The gate reads the pane, not the stale `awaiting` variable ─────────────
// `awaiting` is forced false whenever gotNewBytes is true this tick, so a blocking
// permission/plan widget arriving with trailing transcript bytes would pass the gate
// and get a clarification pasted into its option list.
t('injection gate calls paneAwaitingInput directly', () => {
  const gate = CI.split('\n').find(l => l.includes('injectFails < INJECT_MAX_FAILS'));
  assert.ok(gate, 'injection gate line not found');
  assert.ok(gate.includes('!paneAwaitingInput(pane)'), 'gate must re-check the pane itself');
  assert.ok(!/[^a-zA-Z]awaiting[^A-Za-z]/.test(gate.replace('paneAwaitingInput', '')),
    'gate must not depend on the precomputed `awaiting` variable');
});

// ── 3. Draining is not delivering ────────────────────────────────────────────
// drainInterrupts used to mark the rows delivered on the way out. A paste that then
// failed left the user with a false "will be retried" and no message anywhere.
t('WS drainInterrupts does not mark delivered', () => {
  // Anchored on the interactive call: the Telegram path (server.js ~8572) has its own
  // structurally identical drain that still marks delivered eagerly. Matching the first
  // occurrence in the file would silently test that one instead.
  const anchor = SRV.indexOf('requeueInterrupts: (msgs) => {\n            if (!msgs?.length) return;\n            if (!pendingInterrupts.has(localSessionId))');
  assert.ok(anchor > 0, 'WS-path requeueInterrupts not found');
  const i = SRV.lastIndexOf('drainInterrupts: () => {', anchor);
  assert.ok(i > 0);
  const body = SRV.slice(i, SRV.indexOf('},', i));
  assert.ok(!body.includes('markInterruptDelivered'), 'drain must not touch the DB delivery flag');
  assert.ok(SRV.includes('requeueInterrupts:'), 'a requeue channel must exist for failed pastes');
});

// ── 4. Delivery notifies the client, not only SQLite ─────────────────────────
// The done handler reconciles badges against proxy._deliveredInterruptCount; a
// delivery that skips the counter shows up in the UI as "Task ended" on a
// clarification the agent actually received.
t('markInterruptsDelivered emits interrupt_delivered and bumps the counter', () => {
  // Three call sites pass these callbacks now; only the WS chat path has a proxy to
  // count against, so anchor on its localSessionId rather than the first match.
  const i = SRV.indexOf("markInterruptsDelivered: (msgs) => {\n            // Mirrors the MCP delivery path");
  assert.ok(i > 0, 'WS-path markInterruptsDelivered not found');
  const body = SRV.slice(i, i + 1400);
  assert.ok(body.includes('markInterruptDelivered.run'), 'DB row must still be marked');
  assert.ok(body.includes("type: 'interrupt_delivered'"), 'socket frame missing');
  assert.ok(body.includes('_deliveredInterruptCount'), 'done-reconciliation counter not incremented');
});

// The subscription engine has no check-interrupt hook, so a task running on it gets
// its clarifications only through these callbacks. Passing none is what made the
// message sit "pending" in the UI forever.
t('the task runner passes the drain callbacks to the subscription engine', () => {
  const i = SRV.indexOf("if (_taskEngine === 'subscription') {");
  assert.ok(i > 0, 'task-runner subscription branch not found');
  const body = SRV.slice(i, SRV.indexOf('for (const ev of (r.toolEvents || []))', i));
  for (const cb of ['drainInterrupts:', 'markInterruptsDelivered:', 'requeueInterrupts:']) {
    assert.ok(body.includes(cb), `task runner does not pass ${cb}`);
  }
});

// ── 5. Retry is bounded ──────────────────────────────────────────────────────
// A dead pane fails every poll. Unbounded, that is three tmux processes and one
// error frame per 1.5s tick for the rest of the turn.
t('paste retries are bounded by INJECT_MAX_FAILS', () => {
  assert.ok(/const INJECT_MAX_FAILS = \d+;/.test(CI), 'INJECT_MAX_FAILS constant missing');
  assert.ok(CI.includes('injectFails = 0'), 'counter must reset after a successful paste');
  assert.ok(CI.includes('injectFails >= INJECT_MAX_FAILS'), 'only the final attempt may warn the user');
});

// ── 6. The give-up warning is not a turn-ending error ────────────────────────
// The turn is still polling when this fires. The client's `error` case clears isGen,
// the Stop button and tab.generating — reaching it would tell the user the task ended.
t('clarification failure frames are marked nonTerminal', () => {
  const frames = CI.split('\n').filter(l => l.includes('clarification could not be typed'));
  assert.ok(frames.length >= 2, `expected both failure frames, found ${frames.length}`);
  for (const f of frames) assert.ok(f.includes('nonTerminal: true'), `frame missing nonTerminal: ${f.trim()}`);
});

t('client bails out of the error case before any teardown', () => {
  const i = HTML.indexOf("case 'error':");
  assert.ok(i > 0);
  const guard = HTML.indexOf('d.nonTerminal', i);
  const teardown = HTML.indexOf('_curSessionTaskRunning = false', i);
  assert.ok(guard > 0 && guard < teardown, 'the nonTerminal guard must precede the teardown');
  assert.ok(HTML.slice(guard, teardown).includes('break;'), 'the guard must break out, not fall through');
});

// ── 7. Attachments survive both delivery paths ───────────────────────────────
// Mid-turn the pane gets a path to read. On the deferred follow-up the temp dir is
// already gone, so the bytes must be rehydrated and the engine must understand the
// resulting `file` block — it used to flatten only text and image.
t('interactive flatten handles file blocks', () => {
  assert.ok(CI.includes("block.type === 'file'"), 'file blocks are dropped on the way into the pane');
  assert.ok(CI.includes('[Attached file saved at:'), 'no path is handed to the agent for a file block');
});

t('follow-up rehydrates base64 before cleanup deletes the temp dir', () => {
  const hydrate = SRV.indexOf('const _followAttachments = _drainedInterrupts');
  const cleanup = SRV.indexOf('cleanupInterruptAttachments(_drainedInterrupts)');
  assert.ok(hydrate > 0 && cleanup > 0);
  assert.ok(hydrate < cleanup, 'hydration must happen before the temp dir is removed');
  const body = SRV.slice(hydrate, hydrate + 400);
  assert.ok(body.includes("att.type === 'ssh'"), 'an SSH entry has no file to read and must be skipped');
});

// ── 8. Concurrency: the follow-up joins the queue, it does not race it ───────
// A direct processChat call here would run in parallel with the drain a few lines
// below — two concurrent turns on one chat.
t('follow-up is unshifted onto the tab queue, never dispatched directly', () => {
  const i = SRV.indexOf('const _followMsg =');
  assert.ok(i > 0);
  const body = SRV.slice(i, i + 900);
  assert.ok(/unshift\(_followMsg\)/.test(body), 'follow-up must go through the serialised queue');
  assert.ok(!body.includes('processChat(_followMsg'), 'direct dispatch races the existing drain');
  assert.ok(body.includes('delete _followMsg._dbQueueId'), 'stale queue-row id must not be inherited');
});

// ── 9. The credential never reaches the pane ─────────────────────────────────
t('SSH clarifications carry host info but no password', () => {
  const i = CI.indexOf("att.type === 'ssh'");
  assert.ok(i > 0, 'SSH attachments contribute nothing to the pasted note');
  const body = CI.slice(i, i + 700);
  assert.ok(body.includes('att.sshKeyPath'), 'key path should be passed through');
  assert.ok(!/att\.password/.test(body), 'the credential must never be typed into the pane');
});

// ── 10. The one-shot task path has to deliver, not just re-queue ────────────
// The subscription branch of taskWorker breaks out after a single run. Passing it
// requeueInterrupts was therefore only half a fix: a paste that failed came back
// into pendingInterrupts and stayed there, with no next turn to collect it, while
// the final `done` repainted the badge as a finished task.
t('task runner delivers a leftover clarification as a follow-up turn', () => {
  const i = SRV.indexOf('const leftover = pendingInterrupts.get(sessionId)');
  assert.ok(i > 0, 'the subscription task branch does not look at leftovers at all');
  const brk = SRV.indexOf('break; // one-shot', i);
  assert.ok(brk > i, 'one-shot break not found after the leftover block');
  const body = SRV.slice(i, brk);
  assert.ok(body.includes('pendingInterrupts.delete(sessionId)'), 'leftovers must leave the map');
  assert.ok(body.includes('currentTaskPrompt = interruptFollowUpPrompt(leftover)'),
    'a leftover must become the prompt of one more turn');
  assert.ok(body.includes('continue;'), 'the follow-up turn must re-enter the loop, not fall through to break');
});

t('the follow-up turn budget is bounded', () => {
  assert.ok(/const MAX_CLARIFY_TURNS = /.test(SRV), 'no cap on clarification follow-up turns');
  const i = SRV.indexOf('const leftover = pendingInterrupts.get(sessionId)');
  const body = SRV.slice(i, SRV.indexOf('break; // one-shot', i));
  assert.ok(body.includes('clarifyTurns < MAX_CLARIFY_TURNS'), 'a pane rejecting every paste would loop forever');
  assert.ok(body.includes('clarifyTurns++'), 'the counter must advance or the bound never bites');
});

t('an undeliverable clarification is re-queued with a warning, never dropped', () => {
  const i = SRV.indexOf('const leftover = pendingInterrupts.get(sessionId)');
  const body = SRV.slice(i, SRV.indexOf('break; // one-shot', i));
  assert.ok(body.includes('unshift(...leftover)'), 'budget spent must not mean discarded');
  assert.ok(body.includes("level: 'warn'"), 'silence here is the original bug');
  const marked = body.indexOf('markInterruptDelivered');
  const requeued = body.indexOf('unshift(...leftover)');
  assert.ok(marked > 0 && marked < requeued, 'only the delivered branch may mark rows delivered');
});

t('the task follow-up prompt hands over paths, with a delayed cleanup and no credential', () => {
  const i = SRV.indexOf('function interruptFollowUpPrompt(');
  assert.ok(i > 0, 'follow-up prompt builder not found');
  const body = SRV.slice(i, i + 1200);
  assert.ok(body.includes('att.sshKeyPath'), 'key path should be passed through');
  assert.ok(!/att\.password/.test(body), 'the credential must never reach a prompt or a transcript');
  assert.ok(body.includes('Saved at:'), 'an attachment must reach the agent as a readable path');
  const j = SRV.indexOf('const leftover = pendingInterrupts.get(sessionId)');
  const branch = SRV.slice(j, SRV.indexOf('break; // one-shot', j));
  assert.ok(branch.includes('cleanupInterruptAttachments(leftover, INTERRUPT_FILE_TTL_MS)'),
    'immediate cleanup would delete the files the prompt points at');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
