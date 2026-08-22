'use strict';
// Delegate → "open a terminal" argument construction (issue #22).
// Pure-function tests: nothing is spawned, so the Windows paths are covered on any host.
//
// The Windows escaping is asserted as PROPERTIES against the cmd/argv parser model
// in test/cmd-model.js, never as a literal expected string. A literal-equality test
// is exactly what let the `\"` bug ship: `\` is not an escape character for cmd, so
// `\"` closed the quoted region and the `|` in the real sync prompt ("| answer") was
// parsed as a pipe — while the test asserting that broken string stayed green.
const assert = require('assert');
const { shellEscape, buildTerminalCommand, winTerminalArgs } = require('../delegate-terminal');
const { cmdScan, runBatchLine } = require('./cmd-model');

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

// The prompt server.js builds for sync-mode delegation. It contains `"| answer"`,
// i.e. both a quote and a pipe — the combination the old escaping broke on.
const SYNC_PROMPT = 'Read .crosswork/ab12/CONTEXT.md for full context of the delegated task, then start working. '
  + 'Follow the protocol described in that file for communicating through .crosswork/ab12/DIALOG.md. '
  + 'IMPORTANT: When you have a final answer for the user, write it to DIALOG.md using the tag "| answer" '
  + 'after your agent name, like: ## [timestamp] your-name | answer.';

const ADVERSARIAL = [
  ['real sync prompt',   SYNC_PROMPT],
  ['percent expansion',  'compare %PATH% with %USERPROFILE% and report'],
  ['&& del injection',   'x && del /q C:\\Windows\\System32 && echo pwned'],
  ['unbalanced quote',   'he said "hi and never closed it'],
  ['trailing backslash', 'look in C:\\projects\\build\\'],
  ['newlines',           'first line\nsecond line\r\nthird line'],
  ['non-ASCII',          'Привіт! Опиши «модуль» — детально, ще й 100% точно'],
  ['every metachar',     'a & b | c < d > e ( f ) g ^ h % i " j \\ k'],
];

// A raw newline cannot be represented on a cmd command line at all (`^` + newline is
// a line continuation), so win32 folds newlines to spaces — that is the only lossy step.
const winExpected = (s) => s.replace(/\r\n|\r|\n/g, ' ');

console.log('shellEscape (win32) — property: no cmd metacharacter is ever active');

for (const [name, prompt] of ADVERSARIAL) {
  check(`${name}: & | < > ( ) ^ all stay inside a quoted region`, () => {
    const out = shellEscape(prompt, 'win32');
    const scan = cmdScan(out);
    assert.deepStrictEqual(scan.active, [],
      `these characters act as cmd operators instead of text: ${JSON.stringify(scan.active)}\n    escaped: ${out}`);
    assert.strictEqual(scan.unbalancedQuote, false,
      'the quoted region is left open — everything after it is parsed as bare shell text');
    assert.strictEqual(scan.continued, false, 'trailing ^ would swallow the next .bat line');
    assert.ok(!/[\r\n]/.test(out), 'a raw newline ends the .bat line');
  });
}

console.log('buildTerminalCommand (win32) — property: the full .bat line round-trips');

for (const [name, prompt] of ADVERSARIAL) {
  check(`${name}: cmd splits on the intended && only, and argv survives`, () => {
    const line = buildTerminalCommand({ template: 'claude -p {prompt}' }, 'C:\\proj dir', prompt, 'win32');
    const run = runBatchLine(line, { PATH: 'C:\\WINDOWS', USERPROFILE: 'C:\\Users\\a' });
    assert.strictEqual(run.commands.length, 2,
      `expected exactly \`cd …\` + \`claude …\`, got ${run.commands.length}: ${JSON.stringify(run.commands)}`);
    assert.ok(run.commands[0].startsWith('cd '), `first command is not the cd: ${run.commands[0]}`);

    const argv = run.argvOf(1);
    assert.deepStrictEqual(argv.slice(0, 2), ['claude', '-p'], `argv head mangled: ${JSON.stringify(argv)}`);
    assert.strictEqual(argv.length, 3, `prompt was split into extra arguments: ${JSON.stringify(argv)}`);
    assert.strictEqual(argv[2], winExpected(prompt), 'prompt did not survive the argv parser');
  });
}

console.log('buildTerminalCommand (win32) — property: survives an npm .cmd shim re-parse');

for (const [name, prompt] of ADVERSARIAL) {
  // `claude`, `codex` and `opencode` are .cmd shims on Windows: they re-insert the raw
  // argument text via %*, so cmd phase 2 runs a second time over it (CVE-2024-1874).
  check(`${name}: %* re-insertion does not re-activate anything`, () => {
    const line = buildTerminalCommand({ template: 'claude -p {prompt}' }, 'C:\\proj dir', prompt, 'win32');
    const run = runBatchLine(line, {});
    const shim = run.shimOf(1);
    assert.deepStrictEqual(shim.scan.active, [],
      `the shim's second parse activates ${JSON.stringify(shim.scan.active)}`);
    assert.strictEqual(shim.argv[3], winExpected(prompt), 'prompt did not survive the shim');
  });
}

console.log('shellEscape (win32) — batch layer');

check('percent is doubled — batch phase 1 eats a single %', () => {
  const out = shellEscape('100% done', 'win32');
  const { batchPercent } = require('./cmd-model');
  assert.ok(batchPercent(out, {}).includes('100% done'), `phase 1 mangled it: ${batchPercent(out, {})}`);
});

check('a defined %VAR% is NOT expanded by the batch parser', () => {
  const out = shellEscape('token %SECRET% here', 'win32');
  const { batchPercent } = require('./cmd-model');
  assert.ok(batchPercent(out, { SECRET: 'hunter2' }).includes('%SECRET%'), 'the variable leaked into the prompt');
});

check('a plain workdir is quoted and otherwise untouched', () => {
  assert.strictEqual(shellEscape('C:\\Users\\a\\proj', 'win32'), '"C:\\Users\\a\\proj"');
});

console.log('shellEscape (unix)');

check('single quotes wrapped and internal quotes broken out', () => {
  assert.strictEqual(shellEscape("it's", 'darwin'), "'it'\\''s'");
});

check('unix escaping is untouched by the win32 rules', () => {
  assert.strictEqual(shellEscape('100% "quoted" & piped', 'linux'), `'100% "quoted" & piped'`);
});

check('unix keeps newlines verbatim (single quotes carry them)', () => {
  assert.strictEqual(shellEscape('a\nb', 'linux'), "'a\nb'");
});

console.log('buildTerminalCommand');

check('cd + template with the prompt substituted (unix)', () => {
  const cmd = buildTerminalCommand({ template: 'claude {prompt}' }, '/proj', "do 'x'", 'darwin');
  assert.strictEqual(cmd, `cd '/proj' && claude 'do '\\''x'\\'''`);
});

check('missing template degrades to a bare cd', () => {
  assert.strictEqual(buildTerminalCommand({}, '/proj', 'p', 'darwin'), `cd '/proj' && `);
});

// ─── Remote SSH projects are refused (issue #55) ──────────────────────────────
// Delegation is local-only in every step: it mkdirs .crosswork on THIS disk, writes
// CONTEXT.md/DIALOG.md there, opens a terminal here, and polls that local path for the
// agent's reply. Given a remote project's workdir — a path on the other machine — all
// four silently target the wrong host. On Windows it is worse than wrong: Node resolves
// a POSIX-absolute path against the current drive, so the agent starts in
// C:\home\user\project. That is the reporter's exact symptom, "Delegate opens a local
// folder", and it is the same class of bug as issue #53.
//
// Refusing is the right outcome while there is no remote path. An external agent started
// in the wrong tree, holding a prompt that tells it to work, is a far worse failure than
// a message saying no. Pinned by reading the source: the guard lives in the /api/delegate
// handler, which cannot be imported without starting a server.
{
  const fs = require('fs');
  const path = require('path');
  const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const handler = SRV.slice(SRV.indexOf("app.post('/api/delegate'"));
  const body = handler.slice(0, handler.indexOf('\napp.'));

  check('the delegate handler refuses a remote SSH project', () => {
    assert.ok(/findRemoteProject\(workdir\)/.test(body),
      'no findRemoteProject(workdir) check in the /api/delegate handler');
  });
  check('it refuses before creating anything on disk', () => {
    const guardAt = body.indexOf('findRemoteProject(workdir)');
    // The CALL, not the word: the guard's own comment explains what
    // ensureDelegationDir would do, and matching that mention instead put the
    // "mkdir" earlier than the guard and failed a correctly-ordered handler.
    const mkdirAt = body.indexOf('= ensureDelegationDir(');
    assert.ok(guardAt !== -1 && mkdirAt !== -1 && guardAt < mkdirAt,
      'the remote guard must run before ensureDelegationDir, or a .crosswork dir is left behind on the wrong machine');
  });
  check('the refusal is a 4xx the UI can show, not a 500', () => {
    const seg = body.slice(body.indexOf('findRemoteProject(workdir)'));
    assert.ok(/res\.status\(400\)/.test(seg.slice(0, 600)),
      'the remote refusal should be a 400 with an explanation');
  });
  check('the message names the host so the user can tell which project', () => {
    const seg = body.slice(body.indexOf('findRemoteProject(workdir)'), body.indexOf('= ensureDelegationDir('));
    assert.ok(/remoteHost/.test(seg), 'the refusal should name the remote host');
  });
}

if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nAll delegate-terminal tests passed');
