// The oracle needs an oracle.
//
// test/delegate-terminal.test.js asserts 24 Windows-quoting properties against the
// model in test/cmd-model.js rather than against literal expected strings — that is
// the right call (a literal-equality test is what let the `\"` bug ship). But it
// makes the model load-bearing: if batchPercent/cmdScan/parseArgv are wrong, those
// 24 assertions are wrong in the same direction and nothing notices.
//
// This file pins the model against documented Windows behaviour. Every case below
// is a rule from the MSVC CRT / CommandLineToArgvW spec and the cmd.exe parser, not
// a value copied out of the implementation.
//
// Run: node test/cmd-model.test.js
'use strict';
const assert = require('assert');
const { batchPercent, cmdScan, parseArgv, shimReparse, runBatchLine } = require('./cmd-model');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

console.log('\n— phase 1: batch percent expansion —');
check('%% collapses to one %', batchPercent('a%%b'), 'a%b');
check('%VAR% expands when defined', batchPercent('x%FOO%y', { FOO: 'BAR' }), 'xBARy');
check('an undefined %VAR% is left literal', batchPercent('x%FOO%y', {}), 'x%FOO%y');
check('%1 with no arguments expands to nothing', batchPercent('a%1b'), 'ab');
check('%* with no arguments expands to nothing', batchPercent('a%*b'), 'ab');
check('a lone trailing % is dropped', batchPercent('a%'), 'a');
// The reason %% matters at all: a payload containing a literal % must survive phase 1.
check('an expanded value is NOT re-scanned for percents',
  batchPercent('%A%', { A: '%B%', B: 'boom' }), '%B%');

console.log('\n— phase 2: cmd metacharacters —');
check('an unquoted & is an active operator and splits',
  cmdScan('echo a & echo b').commands, ['echo a', 'echo b']);
check('a quoted & is inert',
  cmdScan('echo "a & b"').active.length, 0);
check('a quoted & does not split',
  cmdScan('echo "a & b"').commands, ['echo "a & b"']);
check('^& is escaped and inert', cmdScan('echo a ^& b').active.length, 0);
check('^& leaves a literal &', cmdScan('echo a ^& b').commands, ['echo a & b']);
check('&& is reported as two active chars', cmdScan('a && b').active.length, 2);
check('redirection does not split the command',
  cmdScan('echo a > f').commands, ['echo a > f']);
check('but > is still reported as active',
  cmdScan('echo a > f').active.map(x => x.char), ['>']);
// A trailing caret is line continuation — a newline in an interpolated value would
// silently swallow the following line. delegate-terminal.test.js relies on this flag.
check('a trailing ^ is reported as a continuation', cmdScan('echo a ^').continued, true);
check('an even number of quotes leaves no open region', cmdScan('a "b" c').unbalancedQuote, false);
check('an odd number of quotes is reported', cmdScan('a "b c').unbalancedQuote, true);
// ^ inside quotes is NOT an escape — cmd only honours it outside a quoted region.
check('^ inside quotes is literal', cmdScan('echo "a^&b"').commands, ['echo "a^&b"']);

console.log('\n— argv reconstruction (MSVC CRT rules) —');
check('plain words split on spaces', parseArgv('a b c'), ['a', 'b', 'c']);
check('a quoted region keeps its spaces', parseArgv('"a b" c'), ['a b', 'c']);
check('2n backslashes + " -> n backslashes, and the quote closes the region',
  parseArgv('"a\\\\"'), ['a\\']);
// Same rule seen from the other side: the closed region means the following space
// really does split, which is the behaviour a naive escaper gets wrong.
check('...so text after that quote is a separate argument',
  parseArgv('"a\\\\"b c"'), ['a\\b', 'c']);
check('2n+1 backslashes + " -> n backslashes and a literal quote',
  parseArgv('"a\\\\\\"b"'), ['a\\"b']);
check('backslashes not followed by a quote are literal',
  parseArgv('a\\\\b'), ['a\\\\b']);
check('"" inside a quoted region is a literal quote',
  parseArgv('"a""b"'), ['a"b']);
check('an empty quoted argument survives', parseArgv('a "" b'), ['a', '', 'b']);
check('tabs separate arguments too', parseArgv('a\tb'), ['a', 'b']);

console.log('\n— the .cmd shim re-parse (BatBadBut, CVE-2024-1874) —');
// The point of modelling this at all: npm shims re-insert the argument text and cmd
// phase 2 runs a SECOND time, so escaping that is not idempotent breaks there.
const once = cmdScan('claude "a & b"');
check('one pass leaves the & inert', once.active.length, 0);
const twice = shimReparse('claude "a & b"');
check('and a second pass still leaves it inert', twice.scan.active.length, 0);
check('the payload reaches argv unchanged', twice.argv[twice.argv.length - 1], 'a & b');
// The counter-example: caret-escaping survives one pass and is consumed by the second,
// which is exactly why the delegate flow must quote rather than caret-escape.
// Feed the shim what the FIRST pass produced — cmd consumes the caret there, so the
// text handed on through %* is a bare `&` and the second pass treats it as an operator.
const firstPass = cmdScan('claude a^&b');
check('the first pass consumes the caret', firstPass.commands, ['claude a&b']);
const caret = shimReparse(firstPass.commands[0]);
check('so caret escaping does NOT survive the shim re-parse', caret.scan.active.length, 1);

console.log('\n— the three phases composed —');
const full = runBatchLine('claude "%MSG%"', { MSG: 'hello & goodbye' });
check('percent expansion happens before the metachar scan',
  full.afterPercent, 'claude "hello & goodbye"');
check('the expanded & is inert because it landed inside quotes', full.active.length, 0);
check('and argv carries the whole message as one argument',
  full.argvOf(0), ['claude', 'hello & goodbye']);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
