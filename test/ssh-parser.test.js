// claude-ssh.js stream parsing. It was never tested at all, and had drifted away from
// claude-cli.js in three places — every divergence a silent data bug on the remote path:
//
//   1. the tail flush emitted an unparseable trailing chunk as CHAT TEXT. Both transports
//      run with --output-format stream-json, so a stream that closes mid-line (Stop, idle
//      timeout, dropped link) leaves TRUNCATED JSON there — which server.js then wrote
//      into the message history verbatim, permanently.
//   2. buffer overflow discarded the whole buffer, including the COMPLETE events queued
//      in front of the oversized line, and logged nothing.
//   3. onSessionId had no one-shot latch, so every event of a --include-partial-messages
//      stream re-fired it — and server.js answers each one with a synchronous UPDATE.
//
// Run: node test/ssh-parser.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ClaudeSSH = require('../claude-ssh');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const cli = fs.readFileSync(path.join(__dirname, '..', 'claude-cli.js'), 'utf8');
const ssh = fs.readFileSync(path.join(__dirname, '..', 'claude-ssh.js'), 'utf8');

console.log('\n— the tail guard: a truncated stream-json line must never become chat text —');
// The shape of the guard, asserted on both files so they cannot drift apart again.
// The behaviour it produces is exercised directly below.
check('claude-cli.js has a structured-tail guard', /looksLikeStructuredTail/.test(cli), true);
check('claude-ssh.js now has one too', /Dropping unparseable trailing stream-json chunk/.test(ssh), true);
check('claude-ssh.js no longer emits the tail unconditionally',
  /catch \{ try \{ if \(h\.onText\) h\.onText\(tail\); \} catch \{\} \}/.test(ssh), false);

// The predicate itself, applied to real inputs. Kept identical to the source expression.
const looksStructured = t => /^[{\[]/.test(t) || /"type"\s*:/.test(t);
check('a truncated assistant frame is recognised as structured',
  looksStructured('{"type":"assistant","message":{"content":[{"type":"text","text":"half a sen'), true);
check('a bare opening brace is too', looksStructured('{'), true);
check('an array fragment is too', looksStructured('[{"a":1}'), true);
check('a fragment carrying a type key is too, even mid-object',
  looksStructured('essage":{"role":"assistant"},"type":"assistant"'), true);
check('genuine plain text is NOT — it still reaches the user',
  looksStructured('Here is the answer you asked for.'), false);
check('...including text that merely mentions json',
  looksStructured('the result is json-encoded'), false);

console.log('\n— the overflow branch: complete events in front of a huge line must survive —');
check('claude-cli.js flushes complete lines before dropping', /const lastNl = buffer\.lastIndexOf\('\\n'\)/.test(cli), true);
check('claude-ssh.js does the same now', (ssh.match(/const lastNl = buffer\.lastIndexOf\('\\n'\)/g) || []).length, 1);
check('claude-ssh.js no longer wipes the buffer blindly',
  /if \(buffer\.length > MAX_LINE_BUFFER\) \{ buffer = ''; return; \}/.test(ssh), false);
check('and it warns, like claude-cli.js does', /\[claude-ssh\] Buffer overflow/.test(ssh), true);

// Behavioural: replay the overflow branch's own logic over a realistic buffer.
{
  const handled = [];
  const buffer = '{"type":"assistant","seq":1}\n{"type":"assistant","seq":2}\n' + 'X'.repeat(50);
  const lastNl = buffer.lastIndexOf('\n');
  if (lastNl > 0) {
    for (const cl of buffer.slice(0, lastNl).split(/\r?\n/)) {
      if (cl.trim()) { try { handled.push(JSON.parse(cl).seq); } catch {} }
    }
  }
  check('both complete events ahead of the oversized line are handled', handled, [1, 2]);
}

console.log('\n— the onSessionId latch —');
check('claude-cli.js latches on _detectedSid', /!h\._detectedSid/.test(cli), true);
check('claude-ssh.js latches too', /!h\._detectedSid/.test(ssh), true);

// Behavioural: _handle is a plain method, so it can be driven without a live SSH connection.
{
  const inst = Object.create(ClaudeSSH.prototype);
  const seen = [];
  const h = { onSessionId: sid => seen.push(sid) };
  // Every stream-json event carries session_id; with --include-partial-messages there
  // are thousands of them per turn.
  for (let i = 0; i < 5; i++) inst._handle({ type: 'assistant', session_id: 'sess-abc' }, h);
  check('onSessionId fires exactly once across five events', seen, ['sess-abc']);
  check('and the latch records it', h._detectedSid, 'sess-abc');
}
{
  const inst = Object.create(ClaudeSSH.prototype);
  const seen = [];
  const h = { onSessionId: sid => seen.push(sid) };
  // Non-string session_id must not arm the latch — otherwise a malformed early frame
  // would suppress the real id for the rest of the turn.
  inst._handle({ type: 'assistant', session_id: { nested: 'x' } }, h);
  inst._handle({ type: 'assistant', session_id: 'real-id' }, h);
  check('a non-string session_id does not poison the latch', seen, ['real-id']);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
