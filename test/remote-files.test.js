// Read-only remote file browser — issue #57.
//
// The interesting half of this feature is the path guard, and it is deliberately NOT
// the local one. Three layers, each pinned here:
//
//   1. resolveRemotePath() — POSIX-only resolution, whatever this server runs on.
//      path.resolve() on a Windows host turns '/home/u/p' into 'C:\home\u\p', which is
//      the #53 failure family; every assertion below would still pass on Windows.
//   2. remoteBrowseScript() — re-checks containment on the REMOTE against the physical
//      path (`pwd -P`). This process cannot lstat the remote tree, so a symlink out of
//      the project satisfies layer 1 by construction. The script is therefore run here
//      through a real /bin/sh against a real temp tree, including symlinks.
//   3. parseRemoteBrowse() — a third containment pass, because a FILENAME is
//      attacker-controlled and can carry a newline plus a forged control line.
//
// Run: node test/remote-files.test.js
'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Small caps make the TRUNC and TOOBIG paths reachable without writing 2 MB of test
// data. Set BEFORE the require — both are read at module load.
process.env.CCS_REMOTE_FILES_MAX_ENTRIES = '3';
process.env.CCS_REMOTE_FILES_MAX_BYTES = '64';
const rf = require('../remote-files');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ── 1. resolveRemotePath — the server-side guard ────────────────────────────
console.log('\n— path guard (server side) —');
const WD = '/home/user/project';
const R = (wd, rel) => rf.resolveRemotePath(wd, rel);

check('the project root itself resolves', R(WD, ''), { ok: true, base: WD, target: WD, homeRelative: false });
check('a subpath resolves', R(WD, 'src/index.js').target, '/home/user/project/src/index.js');
check('a trailing slash is normalised away', R(WD, 'src/').target, '/home/user/project/src');
check('an interior .. that stays inside is fine', R(WD, 'src/../lib').target, '/home/user/project/lib');

check('.. out of the project is denied', R(WD, '../../etc/passwd'), { ok: false, error: 'Denied' });
check('an absolute rel path is denied', R(WD, '/etc/passwd'), { ok: false, error: 'Denied' });
// The classic near-miss: a sibling directory whose name starts with the base.
check('a sibling sharing the base prefix is denied', R(WD, '../project-secrets'), { ok: false, error: 'Denied' });
check('a NUL in the rel path is denied', R(WD, 'src\u0000/../../etc'), { ok: false, error: 'Denied' });
check('a NUL in the workdir is denied', R('/home/u\u0000/p', 'x'), { ok: false, error: 'Denied' });

check('a relative workdir is refused', R('projects/x', '').ok, false);
check('a Windows workdir is refused rather than mangled', R('C:\\Users\\me\\proj', '').ok, false);
check('an empty workdir is refused', R('', '').error, 'No remote workdir');

// `~` never reaches the shell as a character — containment is checked against a
// sentinel root and only the tail is escaped, so $HOME expands remotely.
console.log('\n— a ~-relative workdir —');
check('bare ~ resolves to the sentinel', R('~', ''), { ok: true, base: rf.HOME_SENTINEL, target: rf.HOME_SENTINEL, homeRelative: true });
check('~/proj resolves under the sentinel', R('~/proj', 'src').target, rf.HOME_SENTINEL + '/proj/src');
check('~/proj is flagged home-relative', R('~/proj', '').homeRelative, true);
check('escaping the sentinel is denied', R('~/../etc', '').ok, false);
check('escaping from inside a ~ project is denied', R('~/proj', '../../etc'), { ok: false, error: 'Denied' });

// shellEscape leaves a shell-safe path bare and quotes everything else; both spellings
// are one word to the shell, which is the property that matters.
check('a shell-safe absolute path passes through', rf.shellPath('/home/u/p', false), '/home/u/p');
check('a path with a space is quoted into one word', rf.shellPath('/home/u/my proj', false), "'/home/u/my proj'");
check('a quote in the path is escaped, not closed', rf.shellPath("/home/u/it's", false), "'/home/u/it'\\''s'");
check('the sentinel root becomes "$h"', rf.shellPath(rf.HOME_SENTINEL, true), '"$h"');
check('a sentinel subpath keeps $h and drops the sentinel', rf.shellPath(rf.HOME_SENTINEL + '/proj/src', true), '"$h"/proj/src');
check('a sentinel subpath with a space is quoted', rf.shellPath(rf.HOME_SENTINEL + '/my proj', true), '"$h"/\'my proj\'');

// ── 2. the remote script, run through a real /bin/sh ────────────────────────
let HAVE_SH = true;
try { execFileSync('/bin/sh', ['-c', 'exit 0']); } catch { HAVE_SH = false; }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-remotefiles-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });
// macOS puts the temp dir behind /private, so the base itself is a symlink. That is
// not an inconvenience — it is the case that proves the script compares PHYSICAL
// paths on BOTH sides instead of the textual ones it was handed.
const PROJ = path.join(ROOT, 'project');
const OUTSIDE = path.join(ROOT, 'outside');
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'TOP SECRET\n');
fs.writeFileSync(path.join(PROJ, 'a.txt'), 'hello\n');
fs.writeFileSync(path.join(PROJ, 'a b.js'), 'const x = 1;\n');       // space in the name
fs.writeFileSync(path.join(PROJ, 'big.log'), 'x'.repeat(500));        // over the 64-byte cap
fs.writeFileSync(path.join(PROJ, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
fs.writeFileSync(path.join(PROJ, 'src', 'index.js'), 'export default 1;\n');
fs.symlinkSync(OUTSIDE, path.join(PROJ, 'escape-dir'));               // symlinked DIR out
fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(PROJ, 'escape-file'));

function run(rel, workdir) {
  const plan = rf.resolveRemotePath(workdir || PROJ, rel);
  if (!plan.ok) return { status: 'PLAN:' + plan.error };
  const nonce = 'CCS' + 'deadbeef';
  const out = execFileSync('/bin/sh', ['-c', rf.remoteBrowseScript(nonce, plan)], { encoding: 'utf-8' });
  return rf.parseRemoteBrowse(out, nonce);
}

if (!HAVE_SH) {
  console.log('\n— remote script — SKIPPED (no /bin/sh)');
} else {
  console.log('\n— the remote script, against a real tree —');
  const dir = run('');
  check('a directory lists', dir.status, 'DIR');
  // MAX_ENTRIES is 3 for this run, so the listing is capped — and must SAY so.
  check('an over-cap listing is truncated', dir.truncated, true);
  check('the cap is honoured exactly', dir.items.length, 3);

  const sub = run('src');
  check('a subdirectory lists', sub.items.map(i => i.name), ['index.js']);
  check('a listed file carries its size', sub.items[0].size, 'export default 1;\n'.length);
  check('a listed path is project-relative, not absolute', sub.items[0].rel, 'src/index.js');

  const f = run('a.txt');
  check('a file is read', f.status, 'FILE');
  check('the bytes arrive intact', f.raw, 'hello\n');
  const sp = run('a b.js');
  check('a filename with a space survives the read', sp.raw, 'const x = 1;\n');

  check('an oversized file is refused ON THE REMOTE', run('big.log').status, 'TOOBIG');
  check('the refusal reports the real size', run('big.log').size, 500);
  check('a binary file still arrives (the caller flags it)', run('bin.dat').status, 'FILE');
  check('a missing file is NOENT', run('nope.txt').status, 'NOENT');

  console.log('\n— symlinks: the layer the server cannot see —');
  // Both of these satisfy resolveRemotePath by construction: the string starts with
  // the project root. Only the remote knows they do not land there.
  check('a symlinked DIRECTORY out of the project is caught', run('escape-dir').status, 'ESCAPE');
  check('reading THROUGH a symlinked directory is caught', run('escape-dir/secret.txt').status, 'ESCAPE');
  check('a symlinked FILE is refused rather than followed', run('escape-file').status, 'SYMLINK');
  // The whole point: the secret must not be in the answer under any status.
  check('no route above leaked the file', ['escape-dir', 'escape-dir/secret.txt', 'escape-file']
    .some(r => JSON.stringify(run(r)).includes('TOP SECRET')), false);

  // The base is /var/... behind a symlink on macOS; every assertion above already ran
  // against it, so this pins the reason rather than a second behaviour.
  check('the echoed base is the PHYSICAL one', dir.base, fs.realpathSync(PROJ));
}

// ── 3. parseRemoteBrowse — a filename is attacker-controlled ────────────────
console.log('\n— parser —');
const N = 'CCSnonce';
const P = (s) => rf.parseRemoteBrowse(s, N);
const BASE = '/home/user/project';

check('a login banner before the control lines is ignored',
  P(`Welcome to Ubuntu 24.04\nLast login: Mon\n${N} BASE ${BASE}\n${N} DIR\n${N} E f 10 ${BASE}/a.txt\n${N} DONE 1`).items.map(i => i.name), ['a.txt']);

// The forgery. A file really can be named `x\nCCSnonce E d - /etc` inside a repo you
// cloned; the nonce is random per request, but the third containment pass is what
// makes a lucky guess useless.
check('a forged row pointing outside the project is dropped',
  P(`${N} BASE ${BASE}\n${N} DIR\n${N} E d - /etc\n${N} E f 10 ${BASE}/a.txt\n${N} DONE 1`).items.map(i => i.name), ['a.txt']);
check('a forged row whose path merely starts with the base string is dropped',
  P(`${N} BASE ${BASE}\n${N} DIR\n${N} E d - ${BASE}-evil/x\n${N} DONE 1`).items, []);
check('a row for a path that is not under the base at all is dropped',
  P(`${N} BASE ${BASE}\n${N} DIR\n${N} E f 3 /etc/passwd\n${N} DONE 1`).items, []);

check('a directory row has no size', P(`${N} BASE ${BASE}\n${N} DIR\n${N} E d - ${BASE}/src\n${N} DONE 1`).items[0],
  { name: 'src', type: 'dir', rel: 'src', size: null });
check('an unparseable row is skipped, not fatal',
  P(`${N} BASE ${BASE}\n${N} DIR\n${N} E ? ? ?\n${N} E f 1 ${BASE}/a.txt\n${N} DONE 1`).items.length, 1);
check('a listing with no DONE and no TRUNC is BAD, not silently short',
  P(`${N} BASE ${BASE}\n${N} DIR\n${N} E f 1 ${BASE}/a.txt`).status, 'BAD');
check('a DIR with no BASE is BAD', P(`${N} DIR\n${N} DONE 0`).status, 'BAD');
check('an empty directory is a DIR with no items', P(`${N} BASE ${BASE}\n${N} DIR\n${N} DONE 0`).items, []);

// A file that happens to contain the nonce must not truncate itself: everything after
// the FILE header is the file, scanned no further.
check('a file containing the nonce is not truncated by it',
  P(`${N} BASE ${BASE}\n${N} FILE 30\nline1\n${N} DONE 9\nline2`).raw, `line1\n${N} DONE 9\nline2`);
check('an empty file reads as an empty string', P(`${N} BASE ${BASE}\n${N} FILE 0\n`).raw, '');

check('no control line at all is BAD', P('permission denied\n').status, 'BAD');
check('empty stdout is BAD', P('').status, 'BAD');
check('undefined stdout is BAD', P(undefined).status, 'BAD');
check('ESCAPE wins over anything after it', P(`${N} ESCAPE\n${N} DIR\n${N} DONE 0`).status, 'ESCAPE');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
