// The termination guarantee of ClaudeSSH.send() — issue #67.
//
// runSshSingle() in server.js awaits a promise that resolves ONLY from onDone. A path
// that ends the run without reaching onDone therefore leaves that await pending forever,
// and the session's activeTasks entry with it. Nothing reaps that entry — the 15s orphan
// sweeper explicitly skips any session that has one — so the chat refuses every new
// message and "Restart Session" answers "Task is still running". That is the reported
// symptom: after a remote run breaks, the conversation is permanently stuck.
//
// Four paths used to end a run without calling onDone:
//   1. a socket that closes with no 'error' and no channel open (sshd's ClientAlive /
//      LoginGraceTime drop, a NAT idle-reap) — there was no conn.on('close') at all
//   2. the idle watchdog and the hard cap, which called conn.end() and nothing else
//   3. an abort arriving before conn.exec ran — the listener was registered INSIDE the
//      exec callback, so a Stop during the handshake was silently ignored
//   4. conn.on('error') called h.onDone directly, bypassing the `finished` guard, so the
//      socket close behind it re-emitted the stderr block and fired onDone a second time
//
// Every scenario below asserts onDone fired EXACTLY once. Driven through a fake ssh2
// Client injected into require.cache, so no network and no remote host is involved.
//
// Run: node test/ssh-termination.test.js
'use strict';

// Read at module load in claude-ssh.js — must be set before the require below. Low
// enough that the watchdog scenario finishes fast, high enough that the other
// scenarios (all sub-millisecond) never trip it.
process.env.CLAUDE_IDLE_TIMEOUT_MS = '400';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ── fake ssh2 ────────────────────────────────────────────────────────────────
// Only the surface claude-ssh.js touches: connect/end/exec, plus an exec stream with
// stdout/stderr/stdin. The test drives every event by hand.
class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { end() {} };
    this.closed = false;
  }
  close() { this.closed = true; }
}

let lastClient = null;
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.ended = false;
    this.execCalls = 0;
    this.stream = null;
    this._execMode = 'ok'; // 'ok' | 'error' | 'never'
    lastClient = this;
  }
  connect() { /* the test emits 'ready'/'error'/'close' itself */ }
  end() {
    if (this.ended) return;
    this.ended = true;
    // A real ssh2 Client emits 'close' after end(); that is exactly the event the fix
    // hangs the last-resort finish() on, so the fake has to produce it too.
    setImmediate(() => this.emit('close'));
  }
  exec(cmd, opts, cb) {
    this.execCalls++;
    if (this._execMode === 'never') return;
    if (this._execMode === 'error') return void setImmediate(() => cb(new Error('open failed')));
    this.stream = new FakeStream();
    setImmediate(() => cb(null, this.stream));
  }
}

const ssh2Path = require.resolve('ssh2');
require.cache[ssh2Path] = { id: ssh2Path, filename: ssh2Path, loaded: true, exports: { Client: FakeClient } };

const ClaudeSSH = require('../claude-ssh');

// ── harness ──────────────────────────────────────────────────────────────────
// Returns { doneCount, sid, errors } once onDone has fired, or rejects on timeout —
// a timeout here IS the bug this file exists to catch.
function runScenario(drive, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const ssh = new ClaudeSSH({ host: 'user@example.invalid', workdir: '/srv/app', password: 'x' });
    const state = { doneCount: 0, sid: undefined, errors: [], text: '' };
    const ac = new AbortController();
    const timer = setTimeout(
      () => reject(new Error('onDone never fired — the run would hang the chat forever')),
      timeoutMs);

    ssh.send({ prompt: 'hi', sessionId: null, model: 'sonnet', maxTurns: 5, abortController: ac })
      .onText(t => { state.text += t; })
      // onDone only carries a sid the OUTER scope detected (the stderr regex fallbacks);
      // a session_id read out of a stream-json frame arrives here instead, which is why
      // server.js wires both. Mirror that so this measures the real contract.
      .onSessionId(sid => { state.sid = sid; })
      .onError(e => { state.errors.push(e); })
      .onDone(sid => {
        state.doneCount++;
        if (sid) state.sid = sid;
        // Do NOT resolve immediately: a second onDone is the regression in path 4, and
        // it can only be observed by waiting past the first.
        setTimeout(() => { clearTimeout(timer); resolve(state); }, 120);
      });

    // The chained handlers above are attached synchronously; the connection is only
    // driven after that, the same order the real event loop produces.
    setImmediate(() => { try { drive(lastClient, ac); } catch (e) { reject(e); } });
  });
}

(async () => {
  console.log('\n— a socket that closes with no error and no channel open must still finish —');
  {
    // The #67 hang, exactly: sshd drops the connection during/just after the handshake.
    // ssh2 emits 'close' and nothing else. Before the fix there was no listener for it.
    const r = await runScenario(conn => { conn.emit('close'); });
    check('onDone fired exactly once', r.doneCount, 1);
  }

  console.log('\n— a connection error must finish once, not twice —');
  {
    const r = await runScenario(conn => {
      const err = new Error('All configured authentication methods failed');
      err.level = 'client-authentication';
      conn.emit('error', err);
      // The socket close that always follows an ssh2 error. Before the fix conn.on('error')
      // called h.onDone directly, leaving `finished` false, so this re-fired it.
      setImmediate(() => conn.emit('close'));
    });
    check('onDone fired exactly once', r.doneCount, 1);
    check('the auth failure was reported to the caller',
      r.errors.some(e => /SSH auth failed/.test(e)), true);
  }

  console.log('\n— Stop pressed before the channel exists must finish —');
  {
    // The abort listener used to live inside the conn.exec callback. Abort here reached
    // nothing at all: the run neither stopped nor settled.
    const r = await runScenario((conn, ac) => {
      conn._execMode = 'never';
      conn.emit('ready');
      setTimeout(() => ac.abort(), 30);
    });
    check('onDone fired exactly once', r.doneCount, 1);
  }

  console.log('\n— Stop pressed with a live channel must close it and finish —');
  {
    let streamClosed = null;
    const r = await runScenario((conn, ac) => {
      conn.emit('ready');
      setTimeout(() => { ac.abort(); streamClosed = conn.stream?.closed ?? null; }, 60);
    });
    check('onDone fired exactly once', r.doneCount, 1);
    check('the exec channel was closed', streamClosed, true);
  }

  console.log('\n— a failed channel open must finish —');
  {
    const r = await runScenario(conn => { conn._execMode = 'error'; conn.emit('ready'); });
    check('onDone fired exactly once', r.doneCount, 1);
    check('the exec failure was reported', r.errors.some(e => /SSH exec failed/.test(e)), true);
  }

  console.log('\n— the idle watchdog must finish even with no channel to close —');
  {
    // conn.end() alone settles the run only when there is an open channel for ssh2 to
    // tear down with it. Firing between 'ready' and exec, there is none.
    const r = await runScenario(conn => { conn._execMode = 'never'; conn.emit('ready'); },
      { timeoutMs: 3000 });
    check('onDone fired exactly once', r.doneCount, 1);
    check('the timeout was reported to the caller',
      r.errors.some(e => /no output for .* min \(idle\)/.test(e)), true);
  }

  console.log('\n— a normal run still reports its own result, unchanged —');
  {
    const r = await runScenario(conn => {
      conn.emit('ready');
      setTimeout(() => {
        const s = conn.stream;
        s.stdout.emit('data', Buffer.from(
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }) + '\n' +
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n'));
        // The channel's own close wins the race against the socket close behind it, so
        // the real exit code is what reaches finish().
        s.emit('close', 0);
      }, 40);
    });
    check('onDone fired exactly once', r.doneCount, 1);
    check('the remote session id came back', r.sid, 'abc-123');
    check('the assistant text came back', r.text, 'hello');
    check('a clean run reports no error', r.errors, []);
  }

  console.log('\n— stderr noise is not reported as a failure on abort —');
  {
    const r = await runScenario((conn, ac) => {
      conn.emit('ready');
      setTimeout(() => {
        conn.stream.stderr.emit('data', Buffer.from('some teardown noise\n'));
        ac.abort();
      }, 40);
    });
    check('onDone fired exactly once', r.doneCount, 1);
    check('no stderr block was pushed into the chat', r.errors, []);
  }

  // ── source-shape guards, so the paths cannot silently regress ──────────────
  console.log('\n— the shape of the guarantee —');
  const src = fs.readFileSync(path.join(__dirname, '..', 'claude-ssh.js'), 'utf8');
  check("send() listens for the connection's own close", /conn\.on\('close',[\s\S]{0,80}finish\(/.test(src), true);
  check('no path ends the run on a bare h.onDone any more',
    /if \(h\.onDone\) h\.onDone\(detectedSid\);/g.test(src) &&
      (src.match(/if \(h\.onDone\) h\.onDone\(detectedSid\);/g) || []).length, 1); // the one inside finish()
  // `conn.exec(remoteCmd` and not `conn.exec(` — _execText() has its own exec call
  // earlier in the file, and matching that one makes this assertion meaningless.
  check('the abort listener is registered before send() opens its channel',
    src.indexOf("addEventListener('abort', onAbort") < src.indexOf('conn.exec(remoteCmd'), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
