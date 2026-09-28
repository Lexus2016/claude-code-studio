// scripts/release-mac.js — the macOS release is built, verified and published from the
// Mac that holds the Developer ID certificate (docs/electron-desktop/MAC-SIGNING.md).
//
// What this file pins is the order and the refusals, because every failure here
// publishes something that looks fine and is not:
//
// - electron-builder SKIPS notarization — one log line, exit 0 — when the keychain
//   profile is missing. With `--publish always` that dmg would already be on the
//   release. So the build runs with `--publish never`, and nothing is uploaded until
//   spctl says "Notarized Developer ID" about the app AND about the app inside the dmg.
// - A stale latest-mac.yml in dist-desktop/ (from another version) would point every
//   installed app at the wrong zip. It is checked against the version being released.
// - The Homebrew cask is rewritten with regexes; a cask in another shape would be
//   pushed with the new version and the old checksum. rewriteCask() refuses instead.
//
// Run: node test/release-mac.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.error(`  FAIL ${label} — ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'release-mac.js'), 'utf8');
const R = require('../scripts/release-mac.js');

// ── artefacts ────────────────────────────────────────────────────────────────
console.log('\nartefacts:');
check('the five files electron-builder writes for one arm64 mac build', () => {
  assert.deepStrictEqual(R.macArtifacts('7.18.0'), [
    'claude-code-studio-7.18.0-arm64.dmg',
    'claude-code-studio-7.18.0-arm64.dmg.blockmap',
    'claude-code-studio-7.18.0-arm64.zip',
    'claude-code-studio-7.18.0-arm64.zip.blockmap',
    'latest-mac.yml',
  ]);
});
check('...named by the same pattern electron-builder.yml gives the mac target', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const mac = /^mac:\n((?:(?:[ #].*)?\n)*)/m.exec(yml)[1];
  assert.ok(/artifactName: "claude-code-studio-\$\{version\}-\$\{arch\}\.\$\{ext\}"/.test(mac));
});

// ── latest-mac.yml ───────────────────────────────────────────────────────────
// electron-updater verifies the zip against the sha512 in this file, so it must
// describe the very files being uploaded — not just mention their names.
console.log('\nlatest-mac.yml:');
const Z = 'claude-code-studio-7.18.0-arm64.zip', D = 'claude-code-studio-7.18.0-arm64.dmg';
const YML = (v, zipSha, dmgSha, pathName) => `version: ${v}\nfiles:\n  - url: claude-code-studio-${v}-arm64.zip\n    sha512: ${zipSha}\n    size: 1\n  - url: claude-code-studio-${v}-arm64.dmg\n    sha512: ${dmgSha}\n    size: 2\npath: ${pathName || `claude-code-studio-${v}-arm64.zip`}\nsha512: ${zipSha}\n`;
const DIG = { [Z]: 'zzz+/=', [D]: 'ddd+/=' };
check('accepts the file that describes exactly these zip and dmg', () =>
  assert.strictEqual(R.latestMacProblem(YML('7.18.0', 'zzz+/=', 'ddd+/='), '7.18.0', DIG), null));
check('refuses one left over from another version', () =>
  assert.ok(R.latestMacProblem(YML('7.17.0', 'zzz+/=', 'ddd+/='), '7.18.0', DIG)));
check('refuses a checksum that is not the zip being uploaded', () =>
  assert.ok(/sha512/.test(R.latestMacProblem(YML('7.18.0', 'OLD', 'ddd+/='), '7.18.0', DIG))));
check('refuses a checksum that is not the dmg being uploaded', () =>
  assert.ok(/sha512/.test(R.latestMacProblem(YML('7.18.0', 'zzz+/=', 'OLD'), '7.18.0', DIG))));
check('refuses a `path:` that points at another zip, even if the name appears elsewhere', () =>
  assert.ok(R.latestMacProblem(`# ${Z}\n` + YML('7.18.0', 'zzz+/=', 'ddd+/=', 'claude-code-studio-7.17.0-arm64.zip'), '7.18.0', DIG)));
check('refuses one with no entry for a file', () =>
  assert.ok(R.latestMacProblem(`version: 7.18.0\npath: ${Z}\nfiles:\n  - url: ${Z}\n    sha512: zzz+/=\n`, '7.18.0', DIG)));

// ── notarization verdict ─────────────────────────────────────────────────────
console.log('\nspctl verdict:');
const OK = 'x.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Ievgenii Muran (BKZ6Y9W9MF)\n';
check('a notarized app passes', () => assert.strictEqual(R.isNotarized(OK, 0), true));
check('...but not when spctl itself exited non-zero', () => assert.strictEqual(R.isNotarized(OK, 3), false));
check('signed but not notarized does not', () => assert.strictEqual(R.isNotarized(
  'x.app: accepted\nsource=Developer ID\norigin=Developer ID Application: Ievgenii Muran (BKZ6Y9W9MF)\n', 0), false));
// Verbatim spctl output for a Developer ID signed, un-notarized build (measured).
check('signed but un-notarized, as spctl really prints it, does not', () => assert.strictEqual(R.isNotarized(
  'CCS Update Test.app: rejected\nsource=Unnotarized Developer ID\norigin=Developer ID Application: Ievgenii Muran (BKZ6Y9W9MF)\n', 3), false));
check('a rejection does not, even if "Notarized" appears', () => assert.strictEqual(R.isNotarized(
  'x.app: rejected\nsource=Notarized Developer ID\n', 0), false));

// ── preflight ────────────────────────────────────────────────────────────────
console.log('\npreflight:');
const T = { version: '7.18.0', headTags: ['v7.18.0'], dirty: '', headCommit: 'abc', remoteTagCommit: 'abc' };
check('HEAD on the tag, clean tree, remote tag = HEAD → ok', () => assert.strictEqual(R.tagProblem(T), null));
check('a local tag that differs from the pushed one → refused (it would build one commit and publish under another)',
  () => assert.ok(R.tagProblem({ ...T, remoteTagCommit: 'def' })));
check('a tag that was never pushed → refused', () => assert.ok(R.tagProblem({ ...T, remoteTagCommit: null })));
// Measured: an annotated tag lists its object and the peeled commit.
const LS = 'a506a0ed3dc187b0f3421801dd8dd2991209fd06\trefs/tags/v7.17.0\n9d89ac75dcb4b5f6f360fe21acd11f7c39f8cdcb\trefs/tags/v7.17.0^{}\n';
check('remoteTagCommit takes the peeled commit of an annotated tag',
  () => assert.strictEqual(R.remoteTagCommit(LS, 'v7.17.0'), '9d89ac75dcb4b5f6f360fe21acd11f7c39f8cdcb'));
check('...and the ref itself for a lightweight tag',
  () => assert.strictEqual(R.remoteTagCommit('1111111111111111111111111111111111111111\trefs/tags/v7.18.0\n', 'v7.18.0'), '1111111111111111111111111111111111111111'));
check('...and null when the tag is not there',
  () => assert.strictEqual(R.remoteTagCommit('', 'v7.18.0'), null));
check('HEAD not on the tag → refused (it would ship another commit under this version)',
  () => assert.ok(R.tagProblem({ ...T, headTags: [] })));
check('a dirty tree → refused', () => assert.ok(R.tagProblem({ ...T, dirty: ' M electron/main.js' })));
check('the keychain profile comes from the environment first', () =>
  assert.strictEqual(R.keychainProfile('APPLE_KEYCHAIN_PROFILE=from-file\n', { APPLE_KEYCHAIN_PROFILE: 'from-env' }), 'from-env'));
check('...then from electron-builder.env, comments ignored', () =>
  assert.strictEqual(R.keychainProfile('# note\nAPPLE_KEYCHAIN_PROFILE=murable\n', {}), 'murable'));
check('...and is null when neither names one', () => assert.strictEqual(R.keychainProfile('', {}), null));

// ── cask ─────────────────────────────────────────────────────────────────────
console.log('\nHomebrew cask (transitional):');
const SHA = 'c'.repeat(64);
const CASK = 'cask "claude-code-studio" do\n  version "7.17.0"\n  sha256 "' + 'a'.repeat(64) + '"\n\n  url "…"\nend\n';
check('rewrites version and sha256', () => {
  const out = R.rewriteCask(CASK, '7.18.0', SHA);
  assert.ok(/^  version "7\.18\.0"$/m.test(out));
  assert.ok(new RegExp(`^  sha256 "${SHA}"$`, 'm').test(out));
});
check('refuses the old per-arch shape instead of pushing a stale checksum', () => {
  const old = 'cask "x" do\n  version "7.17.0"\n  sha256 arm:   "' + 'a'.repeat(64) + '",\n         intel: "' + 'b'.repeat(64) + '"\nend\n';
  assert.throws(() => R.rewriteCask(old, '7.18.0', SHA), /sha256/);
});
check('refuses a cask without a version line', () =>
  assert.throws(() => R.rewriteCask('cask "x" do\n  sha256 "' + 'a'.repeat(64) + '"\nend\n', '7.18.0', SHA), /version/));
check('refuses a malformed checksum argument', () => assert.throws(() => R.rewriteCask(CASK, '7.18.0', 'nope'), /sha256/));
check('refuses a cask with two sha256 lines (only one would be rewritten)', () =>
  assert.throws(() => R.rewriteCask(CASK.replace('\n\n', '\n  sha256 "' + 'b'.repeat(64) + '"\n\n'), '7.18.0', SHA), /sha256/));
check('the checksum pushed is the one GitHub serves for the dmg', () => {
  assert.strictEqual(R.assetDigest([{ name: D, digest: 'sha256:' + SHA }], D), SHA);
  assert.strictEqual(R.assetDigest([{ name: D }], D), null);
  assert.strictEqual(R.assetDigest([], D), null);
});

// ── order ────────────────────────────────────────────────────────────────────
console.log('\norder of operations (scripts/release-mac.js):');
// Code only: the header explains, in prose, what `--publish always` would do.
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
const MAIN = (/async function main\(\)[\s\S]*$/.exec(CODE) || [''])[0];
check('the build never publishes by itself', () => {
  assert.ok(/'--publish', 'never'/.test(CODE), 'electron-builder is not run with --publish never');
  assert.ok(!/--publish['",\s]+always/.test(CODE), '--publish always found');
});
check('notarization is verified before anything is uploaded', () => {
  const verify = MAIN.indexOf('verifyNotarized(');
  const upload = MAIN.indexOf('uploadAssets(');
  assert.ok(verify > 0 && upload > 0, 'verifyNotarized / uploadAssets not both called from main()');
  assert.ok(verify < upload, 'upload happens before the notarization check');
});
check('the dmg itself is checked, not only the unpacked app', () => assert.ok(/'hdiutil', \['attach'/.test(CODE)));
check('latest-mac.yml is validated before upload', () => {
  assert.ok(MAIN.indexOf('latestMacProblem(') > 0 && MAIN.indexOf('latestMacProblem(') < MAIN.indexOf('uploadAssets('));
});
check('existing mac assets are not overwritten without --force', () => {
  assert.ok(/force \? \['--clobber'\] : \[\]/.test(CODE), '--clobber not gated on --force');
  assert.ok(/if \(clash\.length && !force\) die\(/.test(CODE), 'existing assets are not refused');
});
check('the cask is bumped only after the upload', () => {
  // --cask-only redoes just that step and must return before the build path.
  const only = /if \(args\.includes\('--cask-only'\)\) \{[\s\S]*?\n  \}/.exec(MAIN);
  assert.ok(only && /return;/.test(only[0]), 'no --cask-only branch that returns');
  const rest = MAIN.slice(only.index + only[0].length);
  const up = rest.indexOf('uploadAssets('), cask = rest.indexOf('bumpCask(');
  assert.ok(up > 0 && cask > up, 'in the release path, bumpCask is not after uploadAssets');
});

const fnBody = (name) => (new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(CODE) || [''])[0];
check('the cask checksum is compared with GitHub\'s before the tap is even cloned', () => {
  const b = fnBody('bumpCask');
  const cmp = b.indexOf('assetDigest('), clone = b.indexOf("'clone'");
  assert.ok(cmp > 0 && clone > 0 && cmp < clone, 'assetDigest check missing or after git clone');
  assert.ok(/if \(served !== sha\) throw/.test(b), 'a mismatch does not stop the bump');
});
check('the dmg is detached before a failed check exits (die() skips a finally)', () => {
  const b = fnBody('verifyNotarized');
  const t = b.slice(b.indexOf('try {'), b.indexOf('} finally {'));
  assert.ok(t.length > 0, 'no try/finally around the mounted image');
  assert.ok(!/die\(/.test(t), 'die() inside the try would leave the image mounted');
});

console.log(`\nrelease-mac: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
