'use strict';
// Delegate → "open a terminal" argument construction (issue #22).
// Pure-function tests: nothing is spawned, so the Windows paths are covered on any host.
const assert = require('assert');
const { shellEscape, buildTerminalCommand, winTerminalArgs } = require('../delegate-terminal');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('winTerminalArgs');

check('window title is quoted — bare `start Delegate` is what broke Windows 11', () => {
  const args = winTerminalArgs('C:\\Temp\\ccs-delegate-1.bat');
  const start = args.indexOf('start');
  assert.notStrictEqual(start, -1, 'no `start` in argv');
  assert.strictEqual(args[start + 1], '"Delegate"',
    'title must be quoted, otherwise `start` treats it as the program name');
});

check('batch path is quoted (os.tmpdir() may contain a space)', () => {
  const args = winTerminalArgs('C:\\Users\\John Doe\\AppData\\Local\\Temp\\ccs.bat');
  assert.strictEqual(args[args.length - 1], '"C:\\Users\\John Doe\\AppData\\Local\\Temp\\ccs.bat"');
});

check('full argv shape', () => {
  assert.deepStrictEqual(
    winTerminalArgs('C:\\Temp\\x.bat'),
    ['/c', 'start', '"Delegate"', 'cmd.exe', '/k', '"C:\\Temp\\x.bat"']
  );
});

console.log('shellEscape (win32)');

check('double quotes are escaped for the argv parser, not prefixed with ^', () => {
  const out = shellEscape('use the tag "| answer" after your name', 'win32');
  assert.strictEqual(out, '"use the tag \\"| answer\\" after your name"');
  assert.ok(!out.includes('^'), 'a ^ inside double quotes is literal and corrupts the prompt');
});

check('percent is doubled for the batch parser', () => {
  assert.strictEqual(shellEscape('100% done', 'win32'), '"100%% done"');
});

check('& | < > are left alone — literal inside double quotes', () => {
  assert.strictEqual(shellEscape('a & b | c < d > e', 'win32'), '"a & b | c < d > e"');
});

console.log('shellEscape (unix)');

check('single quotes wrapped and internal quotes broken out', () => {
  assert.strictEqual(shellEscape("it's", 'darwin'), "'it'\\''s'");
});

check('unix escaping is untouched by the win32 rules', () => {
  assert.strictEqual(shellEscape('100% "quoted" & piped', 'linux'), `'100% "quoted" & piped'`);
});

console.log('buildTerminalCommand');

check('cd + template with the prompt substituted (win32)', () => {
  const cmd = buildTerminalCommand({ template: 'claude {prompt}' }, 'C:\\proj', 'do "x"', 'win32');
  assert.strictEqual(cmd, 'cd "C:\\proj" && claude "do \\"x\\""');
});

check('cd + template with the prompt substituted (unix)', () => {
  const cmd = buildTerminalCommand({ template: 'claude {prompt}' }, '/proj', "do 'x'", 'darwin');
  assert.strictEqual(cmd, `cd '/proj' && claude 'do '\\''x'\\'''`);
});

check('missing template degrades to a bare cd', () => {
  assert.strictEqual(buildTerminalCommand({}, '/proj', 'p', 'darwin'), `cd '/proj' && `);
});

if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nAll delegate-terminal tests passed');
