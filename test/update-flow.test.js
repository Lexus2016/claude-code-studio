// Regression guard for the macOS in-app update (electron/main.js).
//
// History: on 2026-08-20 v7.2.2 shipped and the desktop app went into an update loop —
// it announced 7.2.2, quit, relaunched at 7.2.1 and announced 7.2.2 again. update.log
// recorded four attempts (15:50–15:53) all ending in "Not upgrading …, the latest
// version is already installed" followed by OK. Two independent defects:
//
//   1. checkUpdate() read the GitHub release, which is published the moment the tag
//      lands; the Homebrew cask — the only macOS install path — is bumped ~8 minutes
//      later, when the mac build finishes. The app offered what brew could not install.
//   2. The upgrade shell decided success from `brew upgrade`'s exit code, but brew
//      exits 0 when it has nothing to do. A no-op was reported as OK, so the failure
//      notification never fired and the app silently reopened at the same version.
//
// This test EXECUTES the real shell that main.js builds, against a fake brew, rather
// than pattern-matching its source — so it also catches a rewritten condition, a
// dropped notification or a lost relaunch, not just a literal restore of the old line.
//
// Run: node test/update-flow.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.error(`  FAIL ${label} — ${e.message}`); }
}

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

// ─── Extract a top-level function by name and make it callable ──────────────
// A guard that cannot find its target must fail loudly, never quietly pass.
function extract(name) {
  const at = MAIN.indexOf(`function ${name}(`);
  assert.notStrictEqual(at, -1, `function ${name} is gone — update this test`);
  // Skip the parameter list first: buildUpgradeShell destructures its argument, so
  // the first `{` after the name opens the parameters, not the body.
  let i = MAIN.indexOf('(', at), paren = 0;
  for (; i < MAIN.length; i++) {
    if (MAIN[i] === '(') paren++;
    else if (MAIN[i] === ')' && --paren === 0) break;
  }
  const open = MAIN.indexOf('{', i);
  let depth = 0, end = -1;
  for (let j = open; j < MAIN.length; j++) {
    if (MAIN[j] === '{') depth++;
    else if (MAIN[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  assert.notStrictEqual(end, -1, `unbalanced braces in ${name}`);
  // CASK_NAME is the only module constant these two functions close over.
  return new Function('CASK_NAME', `${MAIN.slice(at, end)}; return ${name};`)('claude-code-studio');
}

const parseCaskVersion = extract('parseCaskVersion');
const buildUpgradeShell = extract('buildUpgradeShell');

console.log('\ncask version parsing:');
check('reads the version out of a real cask body', () => {
  const rb = 'cask "claude-code-studio" do\n  version "7.2.2"\n  sha256 arm: "dead"\nend\n';
  assert.strictEqual(parseCaskVersion(rb), '7.2.2');
});
check('returns null when there is no version field', () => {
  assert.strictEqual(parseCaskVersion('cask "x" do\nend'), null);
});
check('returns null on empty input instead of throwing', () => {
  assert.strictEqual(parseCaskVersion(''), null);
  assert.strictEqual(parseCaskVersion(null), null);
});

console.log('\nthe darwin check asks the cask, not the GitHub release:');
check('no /releases/latest call is left in main.js', () => {
  assert.ok(!MAIN.includes('releases/latest'),
    'the release API is back — it is ~8 min ahead of the cask and reopens the update loop');
});
check('checkUpdate awaits the cask version on darwin', () => {
  const at = MAIN.indexOf("if (process.platform === 'darwin')", MAIN.indexOf('async function checkUpdate'));
  assert.notStrictEqual(at, -1, 'darwin branch of checkUpdate not found');
  // Window widened from 300: the brewManagedPath guard now runs first (a build outside
  // /Applications cannot be upgraded by brew and must not be offered a cask update).
  // The invariant this test exists for — cask, never the release API — is asserted
  // independently above and is unaffected.
  assert.ok(MAIN.slice(at, at + 900).includes('fetchTapCaskVersion'), 'darwin branch no longer reads the cask');
});

// ─── Run the generated shell against a fake brew ────────────────────────────
function runShell(installedAfterUpgrade, fromVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-update-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const brew = path.join(bin, 'brew');
  // Mirrors real brew: `upgrade` exits 0 even when it has nothing to do.
  fs.writeFileSync(brew, `#!/bin/sh
case "$1" in
  upgrade) echo "Warning: Not upgrading claude-code-studio, the latest version is already installed"; exit 0;;
  list) echo "claude-code-studio ${installedAfterUpgrade}"; exit 0;;
esac
exit 0
`);
  for (const [name, marker] of [['open', 'relaunched'], ['osascript', 'notified']]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${marker} $*" >> '${dir}/markers'\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  fs.chmodSync(brew, 0o755);
  const logPath = path.join(dir, 'update.log');
  const sh = buildUpgradeShell({ brew, logPath, fromVersion });
  try {
    execFileSync('/bin/sh', ['-c', sh], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    return { log: read(logPath), markers: read(path.join(dir, 'markers')) };
  } finally {
    // Every other suite cleans its temp dir; this one used to leak one per call.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

console.log('\na brew no-op must be reported as a failure, not as OK:');
const noop = runShell('7.2.1', '7.2.1');
check('log says FAILED when the version did not move', () => {
  assert.ok(/FAILED/.test(noop.log), `expected FAILED, log was:\n${noop.log}`);
  assert.ok(!/\bOK\b/.test(noop.log), `a no-op was still reported as OK:\n${noop.log}`);
});
check('the user is notified', () => {
  assert.ok(/notified/.test(noop.markers), 'no notification fired on a failed update');
});
check('the app is relaunched anyway — it must never just vanish', () => {
  assert.ok(/relaunched/.test(noop.markers), 'the app was not reopened after a failed update');
});

console.log('\na real upgrade is reported as success:');
const real = runShell('7.2.2', '7.2.1');
check('log records the version move', () => {
  assert.ok(/OK 7\.2\.1 -> 7\.2\.2/.test(real.log), `expected an OK line, log was:\n${real.log}`);
});
check('no failure notification on success', () => {
  assert.ok(!/notified/.test(real.markers), 'a successful update still nagged the user');
});
check('the app is relaunched', () => {
  assert.ok(/relaunched/.test(real.markers), 'the app was not reopened after a successful update');
});


// ── an .app brew does not manage must not be offered a cask upgrade ──────────
// The loop this prevents, observed live: a 7.1.1 build left in dist-desktop/ from
// `npm run dist` was what actually got launched. It read the tap cask (7.5.0),
// offered the update, ran `brew upgrade --cask` — which correctly upgraded the
// bundle in /Applications — then relaunched ITSELF, still 7.1.1, saw 7.5.0 again,
// and repeated. update.log showed one clean `OK 7.4.0 -> 7.5.0`; nothing was broken
// except that the running process was never the one brew was updating.
console.log('\na build outside /Applications is not offered a cask update:');
{
  check('checkUpdate consults brewManagedPath before reading the cask',
    () => assert.ok(/if \(!brewManagedPath\(\)\) \{/.test(MAIN)));
  check('...and the guard sits BEFORE the cask fetch',
    () => assert.ok(MAIN.indexOf('brewManagedPath()') < MAIN.indexOf('await fetchTapCaskVersion()')));
  check('the unmanaged reply is available:false, not a version comparison',
    () => assert.ok(/available: false,\s*\n\s*unmanaged: true/.test(MAIN)));

  // The predicate itself, on the paths that actually occur.
  const brewManaged = (exe) => exe.includes('/Applications/');
  check('an installed app is managed',
    () => assert.strictEqual(brewManaged('/Applications/Claude Code Studio.app/Contents/MacOS/Claude Code Studio'), true));
  check('a dist-desktop build is NOT',
    () => assert.strictEqual(brewManaged('/Users/me/proj/dist-desktop/mac-arm64/Claude Code Studio.app/Contents/MacOS/Claude Code Studio'), false));
  check('nor is one run from Downloads',
    () => assert.strictEqual(brewManaged('/Users/me/Downloads/Claude Code Studio.app/Contents/MacOS/Claude Code Studio'), false));
  check('a user-local Applications install still counts',
    () => assert.strictEqual(brewManaged('/Users/me/Applications/Claude Code Studio.app/Contents/MacOS/Claude Code Studio'), true));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
