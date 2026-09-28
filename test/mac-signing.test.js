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
// - A CI runner has neither the Developer ID certificate nor the notarytool
//   profile. A mac leg there published an UNSIGNED build, and the app updates itself
//   through Squirrel.Mac, which refuses an update not signed by the same Developer
//   ID. macOS is released from the Mac that holds both (scripts/release-mac.js,
//   pinned by test/release-mac.test.js), so CI must not build it at all.
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
check('npm run release:mac builds the mac target this config pins', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.scripts['release:mac'], 'node scripts/release-mac.js');
  assert.ok(/\['electron-builder', '--mac', '--publish', 'never'\]/.test(read('scripts/release-mac.js')));
});

// ── 3. CI does not build macOS ───────────────────────────────────────────────
// Code only: the header comment explains why, and names what it does not do.
const WF_CODE = WF.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
check('release-desktop.yml has no macOS leg', () => {
  assert.ok(!/macos-/.test(WF_CODE), 'a macOS runner is still used');
  assert.ok(!/--mac\b/.test(WF_CODE), 'electron-builder --mac is still run');
});
check('...and carries no Apple signing secrets', () => {
  assert.ok(!/MAC_CSC|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|CSC_LINK/.test(WF_CODE));
});
check('...and no cask bump (release-mac.js does it from the verified dmg)', () => {
  assert.ok(!/bump-cask|HOMEBREW_TAP_TOKEN|homebrew-claude-code-studio/.test(WF_CODE));
});
check('Windows and Linux are still built and published there', () => {
  assert.ok(/os: windows-latest[\s\S]*?args: "--win"/.test(WF_CODE));
  assert.ok(/os: ubuntu-latest[\s\S]*?args: "--linux"/.test(WF_CODE));
  assert.ok(/electron-builder \$\{\{ matrix\.args \}\} --publish always/.test(WF_CODE));
});

// ── 4. local settings never ship or get committed ────────────────────────────
check('electron-builder.env is excluded from the bundle and from git', () => {
  assert.ok(/^\s+- "!electron-builder\.env"$/m.test(YML), 'not in the files: exclusions');
  assert.ok(/^electron-builder\.env$/m.test(read('.gitignore')), 'not in .gitignore');
});

console.log(`\nmac-signing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
