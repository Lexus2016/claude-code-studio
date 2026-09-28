// macOS release: Developer ID signing + notarization, Apple Silicon only.
//
// Every failure this file guards against produces a build that LOOKS fine: the
// dmg exists, the CI step is green, the app even launches on the machine that
// built it. The damage only shows on a user's Mac:
//
// - osascript's Apple Events to Terminal.app are checked against THIS app (the
//   responsible process) under the hardened runtime. Without
//   `com.apple.security.automation.apple-events` they are refused (-1743) with no
//   prompt — "Open in Terminal" silently does nothing.
// - electron-builder signs, logs "skipped macOS notarization" and publishes when
//   the certificate is present but the APPLE_* credentials are not. Gatekeeper
//   rejects that dmg exactly like an unsigned one.
// - The tap bump rewrites the cask with `sed`, which exits 0 when nothing matched:
//   a new version with the old checksum, and every `brew install` fails.
//
// See docs/electron-desktop/MAC-SIGNING.md. Run: node test/mac-signing.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const YML = read('electron-builder.yml');
const WF = read('.github/workflows/release-desktop.yml');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.error(`  FAIL ${label} — ${e.message}`); }
}

// A top-level YAML block: from `name:` to the next unindented line.
function yamlBlock(src, name) {
  const m = new RegExp(`^${name}:\\n((?:(?:[ #].*)?\\n)*)`, 'm').exec(src);
  assert.ok(m, `no top-level "${name}:" block`);
  return m[1];
}
// A job inside the workflow: from `  <job>:` to the next job at the same indent.
function job(name) {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|(?![\\s\\S]))`, 'm').exec(WF);
  assert.ok(m, `no job "${name}" in release-desktop.yml`);
  return m[1];
}
const MAC = yamlBlock(YML, 'mac');
const macKey = (k) => { const m = new RegExp(`^  ${k}:\\s*(.*)$`, 'm').exec(MAC); return m && m[1].replace(/^"|"$/g, '').trim(); };

// ── 1. entitlements ──────────────────────────────────────────────────────────
const ENT_PATH = 'build/entitlements.mac.plist';
const entKeys = () => (read(ENT_PATH).match(/<key>([^<]+)<\/key>\s*<true\/>/g) || [])
  .map(s => s.replace(/<key>([^<]+)<\/key>[\s\S]*/, '$1'));

check('hardened runtime is on and both app and helpers use the project entitlements', () => {
  assert.strictEqual(macKey('hardenedRuntime'), 'true');
  assert.strictEqual(macKey('entitlements'), ENT_PATH);
  // The server runs in a utilityProcess — inside a Helper bundle — so the helpers
  // need the same Apple Events key, not electron-builder's template.
  assert.strictEqual(macKey('entitlementsInherit'), ENT_PATH);
  assert.ok(fs.existsSync(path.join(ROOT, ENT_PATH)), `${ENT_PATH} missing`);
});
check('entitlements keep V8 JIT working under the hardened runtime', () => {
  assert.ok(entKeys().includes('com.apple.security.cs.allow-jit'), entKeys().join(', '));
});
check('server.js drives Terminal via osascript, so the Apple Events entitlement is present', () => {
  const srv = read('server.js');
  assert.ok(/osascript/.test(srv) && /tell application "Terminal"/.test(srv),
    'server.js no longer scripts Terminal — revisit whether the entitlement is still needed');
  assert.ok(entKeys().includes('com.apple.security.automation.apple-events'), entKeys().join(', '));
  assert.ok(/NSAppleEventsUsageDescription:\s*"[^"]{10,}"/.test(MAC),
    'mac.extendInfo.NSAppleEventsUsageDescription missing — the Automation prompt has no text');
});
check('notarization is not switched off in the config', () => {
  assert.notStrictEqual(macKey('notarize'), 'false');
});

// ── 2. Apple Silicon only ────────────────────────────────────────────────────
check('mac targets are arm64 only', () => {
  const arches = [...MAC.matchAll(/^\s+arch:\s*\[?([^\]\n]+)\]?/gm)].flatMap(m => m[1].split(',').map(s => s.trim()));
  assert.ok(arches.length >= 2, `expected an arch on every mac target, got ${JSON.stringify(arches)}`);
  assert.deepStrictEqual([...new Set(arches)], ['arm64']);
});
check('the CI mac build asks for arm64 and nothing else', () => {
  const run = /npx electron-builder --mac[^\n]*/.exec(job('build-mac'));
  assert.ok(run, 'no electron-builder --mac invocation in build-mac');
  assert.ok(/--arm64\b/.test(run[0]) && !/--x64\b|--universal\b/.test(run[0]), run[0]);
});

// ── 3. CI signing: credentials in, half-configured refused ───────────────────
check('build-mac maps the MAC_CSC_* and APPLE_* secrets into electron-builder\'s env', () => {
  const j = job('build-mac');
  for (const [env, secret] of [
    ['CSC_LINK', 'MAC_CSC_LINK'], ['CSC_KEY_PASSWORD', 'MAC_CSC_KEY_PASSWORD'],
    ['APPLE_ID', 'APPLE_ID'], ['APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_APP_SPECIFIC_PASSWORD'],
    ['APPLE_TEAM_ID', 'APPLE_TEAM_ID'],
  ]) {
    assert.ok(new RegExp(`^\\s+${env}: \\$\\{\\{ secrets\\.${secret} \\}\\}$`, 'm').test(j), `${env} ← secrets.${secret}`);
  }
});
check('build-mac never switches signing off', () => {
  // Squirrel.Mac (the in-app updater) refuses an update not signed by the same
  // Developer ID, so an unsigned mac release is a broken release, not a fallback.
  assert.ok(!/CSC_IDENTITY_AUTO_DISCOVERY/.test(job('build-mac')));
});
// The two guards, as the job's own shell runs them — before the build, both exit 1.
function guard(re, what) {
  const j = job('build-mac');
  const g = re.exec(j);
  assert.ok(g, `no ${what} guard`);
  assert.ok(/exit 1/.test(g[0]), `${what} guard does not fail the job`);
  assert.ok(j.indexOf(g[0]) < j.indexOf('npx electron-builder --mac'), `${what} guard must run before the build`);
}
check('no certificate fails the job', () =>
  guard(/if \[ -z "\$\{CSC_LINK:-\}" \]; then[\s\S]*?\n\s*fi\n/, 'missing-certificate'));
check('a certificate without notarization credentials fails the job', () =>
  guard(/if[^\n]*APPLE_ID[^\n]*APPLE_APP_SPECIFIC_PASSWORD[^\n]*APPLE_TEAM_ID[\s\S]*?\n\s*fi\n/, 'partial-credentials'));

// ── 4. tap bump ──────────────────────────────────────────────────────────────
check('bump-cask fetches only the arm64 dmg and verifies what sed wrote', () => {
  // Comment lines dropped: the one explaining the check names the old `intel:` stanza.
  const j = job('bump-cask').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.ok(/-arm64\.dmg/.test(j), 'arm64 dmg not fetched');
  assert.ok(!/x64\.dmg|intel:/.test(j), 'still references the Intel build');
  assert.ok(/grep -q "\^  sha256 \\"\$\{ARM_SHA\}\\"\$"/.test(j), 'no post-sed checksum verification');
});

// ── 5. local settings never ship or get committed ────────────────────────────
check('electron-builder.env is excluded from the bundle and from git', () => {
  assert.ok(/^\s+- "!electron-builder\.env"$/m.test(YML), 'not in the files: exclusions');
  assert.ok(/^electron-builder\.env$/m.test(read('.gitignore')), 'not in .gitignore');
});

console.log(`\nmac-signing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
