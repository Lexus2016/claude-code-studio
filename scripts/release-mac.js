#!/usr/bin/env node
/**
 * scripts/release-mac.js — build, verify and publish the macOS release from this Mac
 *
 * Usage (after `npm run release …` has pushed the tag):
 *   npm run release:mac              build, verify, upload, bump the Homebrew cask
 *   npm run release:mac -- --force   overwrite mac assets already on the release
 *   npm run release:mac -- --cask-only   redo only the cask step (the dmg is on the release)
 *
 * The macOS build needs the Developer ID certificate and the notarytool keychain
 * profile, and both live only in this Mac's keychain — so it is not built in CI.
 * docs/electron-desktop/MAC-SIGNING.md has the one-time setup.
 *
 * What it does, in this order:
 *   1. Preflight: HEAD is the tag v<package.json version>, the tree is clean, the
 *      notarytool profile works, the GitHub Release exists (release.yml creates it).
 *   2. electron-builder --mac --publish never — signs and notarizes.
 *   3. Verify: codesign, spctl "Notarized Developer ID" on the app AND on the app
 *      inside the dmg, stapler, the bundle version, latest-mac.yml.
 *   4. gh release upload — only now, and only what was verified.
 *   5. Transitional (retire ~2026-10-28): bump the Homebrew cask.
 *
 * Why the build never publishes by itself: electron-builder SKIPS notarization — one
 * log line, exit 0 — when the credentials are missing, and `--publish always` would
 * already have put that dmg on the release. Pinned by test/release-mac.test.js.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist-desktop');
const REPO = 'Lexus2016/claude-code-studio';
const TAP  = 'Lexus2016/homebrew-claude-code-studio';
const CASK = 'Casks/claude-code-studio.rb';

// ── Pure helpers (exported for the test) ──────────────────────────────────────

// electron-builder.yml, mac: artifactName "claude-code-studio-${version}-${arch}.${ext}".
function macArtifacts(version) {
  const base = `claude-code-studio-${version}-arm64`;
  return [`${base}.dmg`, `${base}.dmg.blockmap`, `${base}.zip`, `${base}.zip.blockmap`, 'latest-mac.yml'];
}

// latest-mac.yml is what every installed copy reads, and electron-updater checks the
// downloaded zip against its sha512. So it must describe the very files being uploaded
// — a stale one, or one whose checksum is another build's, breaks every update.
// `digests` maps file name → base64 sha512 of the file on disk.
function latestMacProblem(yml, version, digests) {
  const text = String(yml || '');
  const v = /^version:\s*(\S+)\s*$/m.exec(text);
  if (!v || v[1] !== version) return `latest-mac.yml is for ${v ? v[1] : 'no version'}, not ${version}`;
  const zip = `claude-code-studio-${version}-arm64.zip`;
  const p = /^path:\s*(\S+)\s*$/m.exec(text);
  if (!p || p[1] !== zip) return `latest-mac.yml path: is ${p ? p[1] : 'missing'}, not ${zip}`;
  for (const [name, sha] of Object.entries(digests || {})) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const e = new RegExp(`^\\s*- url:\\s*${esc}\\s*\\n\\s*sha512:\\s*(\\S+)`, 'm').exec(text);
    if (!e) return `latest-mac.yml has no entry for ${name}`;
    if (e[1] !== sha) return `latest-mac.yml sha512 for ${name} is not the file being uploaded`;
  }
  return null;
}

function isNotarized(spctlOutput, exitCode) {
  const s = String(spctlOutput || '');
  return exitCode === 0 && /: accepted$/m.test(s) && /^source=Notarized Developer ID$/m.test(s);
}

// `git ls-remote origin refs/tags/<tag>*`: an annotated tag lists its own object and,
// as `<tag>^{}`, the commit it points at — that commit is what must match HEAD.
function remoteTagCommit(lsRemote, tag) {
  const rows = String(lsRemote || '').split('\n').map((l) => l.split('\t'));
  const peeled = rows.find((r) => r[1] === `refs/tags/${tag}^{}`);
  const plain = rows.find((r) => r[1] === `refs/tags/${tag}`);
  return (peeled || plain || [null])[0] || null;
}

function tagProblem({ version, headTags, dirty, headCommit, remoteTagCommit: remote }) {
  const tag = `v${version}`;
  if (String(dirty || '').trim()) return `the working tree is not clean:\n${dirty}`;
  if (!(headTags || []).includes(tag)) return `HEAD is not the tag ${tag} — check it out first (git checkout ${tag})`;
  if (!remote) return `the tag ${tag} is not on origin — push it first (npm run release does)`;
  if (remote !== headCommit) return `the local tag ${tag} is ${headCommit}, origin's is ${remote} — this would build one commit and publish it under another`;
  return null;
}

// The checksum GitHub itself reports for a release asset ("sha256:<hex>").
function assetDigest(assets, name) {
  const a = (assets || []).find((x) => x.name === name);
  const m = a && /^sha256:([a-f0-9]{64})$/.exec(String(a.digest || ''));
  return m ? m[1] : null;
}

// The environment wins, then electron-builder.env — the same order electron-builder
// itself uses (dotenv never overrides a variable that is already set).
function keychainProfile(envFileText, env) {
  if (env && env.APPLE_KEYCHAIN_PROFILE) return env.APPLE_KEYCHAIN_PROFILE;
  const m = /^\s*APPLE_KEYCHAIN_PROFILE\s*=\s*(\S+)\s*$/m.exec(String(envFileText || ''));
  return m ? m[1] : null;
}

// sed-style rewriting exits happily when nothing matched; this refuses instead, so a
// cask in any other shape is never pushed with the new version and the old checksum.
function rewriteCask(rb, version, sha) {
  if (!/^[a-f0-9]{64}$/.test(String(sha))) throw new Error(`not a sha256: ${sha}`);
  // Exactly one of each: with two, only the first would be rewritten.
  const versionRe = /^  version "[^"]*"$/gm;
  const shaRe = /^  sha256 "[a-f0-9]{64}"$/gm;
  if ((String(rb).match(versionRe) || []).length !== 1) throw new Error('cask must have exactly one `  version "…"` line');
  if ((String(rb).match(shaRe) || []).length !== 1) throw new Error('cask must have exactly one single-arch `  sha256 "…"` line');
  return rb.replace(versionRe, `  version "${version}"`).replace(shaRe, `  sha256 "${sha}"`);
}

// ── Side effects ──────────────────────────────────────────────────────────────

// Every short command gets a timeout, so a stalled network call ends the run instead
// of hanging it. The build does not: notarization legitimately takes many minutes, and
// its output is on screen.
const SHORT = 10 * 60 * 1000;
function sh(cmd, args, opts = {}) {
  return String(execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SHORT, ...opts }));
}
// spctl and stapler report on stderr; merge both so the verdict can be read.
function shAll(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: SHORT });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function releaseAssets(tag) {
  return JSON.parse(sh('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'assets'])).assets;
}
function fileDigest(file, algo, enc) {
  return require('crypto').createHash(algo).update(fs.readFileSync(file)).digest(enc);
}
function step(msg) { console.log(`\n▸ ${msg}`); }
function die(msg) { console.error(`\n⛔ ${msg}\n`); process.exit(1); }

function productName() {
  const m = /^productName:\s*(.+)$/m.exec(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
  return m ? m[1].trim() : 'Claude Code Studio';
}

function preflight(version) {
  step('Preflight');
  const tag = `v${version}`;
  const problem = tagProblem({
    version,
    headTags: sh('git', ['tag', '--points-at', 'HEAD']).split('\n').map((s) => s.trim()).filter(Boolean),
    dirty: sh('git', ['status', '--porcelain']).trim(),
    headCommit: sh('git', ['rev-parse', 'HEAD']).trim(),
    remoteTagCommit: remoteTagCommit(sh('git', ['ls-remote', 'origin', `refs/tags/${tag}*`]), tag),
  });
  if (problem) die(problem);
  console.log(`  ✓ HEAD = ${tag} = origin's ${tag}`);

  const envFile = path.join(ROOT, 'electron-builder.env');
  const profile = keychainProfile(fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '', process.env);
  if (!profile) die('no notarytool keychain profile — put APPLE_KEYCHAIN_PROFILE=<name> in electron-builder.env (see docs/electron-desktop/MAC-SIGNING.md)');
  const hist = shAll('xcrun', ['notarytool', 'history', '--keychain-profile', profile]);
  if (hist.code !== 0) die(`notarytool profile "${profile}" does not work:\n${hist.out.trim()}`);
  console.log(`  ✓ notarytool profile "${profile}"`);

  // release.yml creates the release a minute or so after the tag lands.
  let view;
  for (let i = 0; ; i++) {
    view = shAll('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'isDraft']);
    if (view.code === 0) break;
    if (i >= 36) die(`GitHub Release ${tag} does not exist — did release.yml run for the tag?`);
    if (i === 0) console.log(`  … waiting for GitHub Release ${tag}`);
    spawnSync('sleep', ['5']);
  }
  // A draft's download URLs are not public: the cask and every updater would 404.
  if (JSON.parse(view.out).isDraft) die(`GitHub Release ${tag} is a draft — publish it first`);
  console.log(`  ✓ GitHub Release ${tag}`);
}

function build() {
  step('electron-builder --mac --publish never');
  // Anything left from an earlier build must not be mistaken for this one.
  fs.rmSync(path.join(DIST, 'latest-mac.yml'), { force: true });
  const r = spawnSync('npx', ['electron-builder', '--mac', '--publish', 'never'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) die('electron-builder failed');
}

function verifyNotarized(version) {
  step('Verify signature and notarization');
  const app = path.join(DIST, 'mac-arm64', `${productName()}.app`);
  if (!fs.existsSync(app)) die(`no ${app}`);

  const bundleVersion = sh('defaults', ['read', path.join(app, 'Contents', 'Info.plist'), 'CFBundleShortVersionString']).trim();
  if (bundleVersion !== version) die(`the built app is ${bundleVersion}, not ${version}`);

  const cs = shAll('codesign', ['--verify', '--deep', '--strict', app]);
  if (cs.code !== 0) die(`codesign --verify failed:\n${cs.out}`);
  const sp = shAll('spctl', ['-a', '-vvv', '-t', 'exec', app]);
  if (!isNotarized(sp.out, sp.code)) die(`the app is not notarized — electron-builder skips notarization silently when the profile is missing:\n${sp.out}`);
  const st = shAll('xcrun', ['stapler', 'validate', app]);
  if (st.code !== 0) die(`no stapled ticket:\n${st.out}`);
  console.log('  ✓ app: signed, notarized, stapled');

  // The dmg is what people download; check the app inside it, not only the one on disk.
  const dmg = path.join(DIST, macArtifacts(version)[0]);
  const attach = shAll('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', dmg]);
  const mount = ((/\t(\/Volumes\/.+)$/m.exec(attach.out) || [])[1] || '').trim();
  if (attach.code !== 0 || !mount) die(`cannot mount ${dmg}:\n${attach.out}`);
  // Decide first, detach, then die: die() exits the process, which would skip a
  // `finally` and leave the image mounted.
  let problem = null;
  try {
    const inner = path.join(mount, `${productName()}.app`);
    const innerVersion = shAll('defaults', ['read', path.join(inner, 'Contents', 'Info.plist'), 'CFBundleShortVersionString']).out.trim();
    const sp2 = shAll('spctl', ['-a', '-vvv', '-t', 'exec', inner]);
    if (innerVersion !== version) problem = `the app inside the dmg is ${innerVersion}, not ${version}`;
    else if (!isNotarized(sp2.out, sp2.code)) problem = `the app inside the dmg is not notarized:\n${sp2.out}`;
  } finally {
    shAll('hdiutil', ['detach', mount, '-quiet']);
  }
  if (problem) die(problem);
  console.log(`  ✓ dmg: the app inside is ${version} and notarized`);
}

function uploadAssets(tag, files, force) {
  step(`Upload to GitHub Release ${tag}`);
  const names = files.map((f) => path.basename(f));
  const existing = releaseAssets(tag).map((a) => a.name);
  const clash = names.filter((n) => existing.includes(n));
  if (clash.length && !force) die(`the release already has ${clash.join(', ')} — rerun with --force to replace them`);
  const r = spawnSync('gh', ['release', 'upload', tag, ...files, '--repo', REPO, ...(force ? ['--clobber'] : [])], { cwd: ROOT, stdio: 'inherit', timeout: 60 * 60 * 1000 });
  const after = releaseAssets(tag);
  // gh uploads one file at a time; a failure part-way leaves the release mixed.
  const wrong = names.filter((n) => {
    const a = after.find((x) => x.name === n);
    return !a || a.size !== fs.statSync(path.join(DIST, n)).size;
  });
  if (r.status !== 0 || wrong.length) {
    die(`the upload did not complete — the release now has ${names.filter((n) => !wrong.includes(n)).join(', ') || 'none of the files'}; missing or different: ${wrong.join(', ')}.\n   Rerun with: npm run release:mac -- --force`);
  }
  console.log(`  ✓ ${files.length} files on the release`);
}

// Transitional: the cask exists only so installs from before the signed release —
// whose update button runs `brew upgrade --cask` — can reach it. Retire ~2026-10-28
// together with this step (docs/electron-desktop/MAC-SIGNING.md).
function bumpCask(version, dmgPath) {
  step('Bump the Homebrew cask (transitional)');
  const sha = fileDigest(dmgPath, 'sha256', 'hex');
  // The cask must carry the checksum of what GitHub serves, not of whatever file with
  // that name is on disk now (--cask-only runs after the upload, possibly much later).
  const served = assetDigest(releaseAssets(`v${version}`), path.basename(dmgPath));
  if (!served) throw new Error(`GitHub reports no sha256 for ${path.basename(dmgPath)} on v${version}`);
  if (served !== sha) throw new Error(`${path.basename(dmgPath)} on disk is not the one on the release (${sha.slice(0, 12)}… vs ${served.slice(0, 12)}…)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-tap-'));
  try {
    sh('git', ['clone', '-q', `https://github.com/${TAP}.git`, dir]);
    const file = path.join(dir, CASK);
    const before = fs.readFileSync(file, 'utf8');
    const after = rewriteCask(before, version, sha);
    if (after === before) { console.log('  ✓ cask already at this version and checksum'); return; }
    fs.writeFileSync(file, after);
    const who = ['-c', `user.name=${sh('git', ['config', 'user.name']).trim()}`, '-c', `user.email=${sh('git', ['config', 'user.email']).trim()}`];
    sh('git', [...who, 'commit', '-q', '-am', `chore: claude-code-studio ${version}`], { cwd: dir });
    sh('git', ['push', '-q', 'origin', 'HEAD'], { cwd: dir });
    console.log(`  ✓ cask → ${version} (${sha.slice(0, 12)}…)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'darwin') die('the macOS release is built on macOS');
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const tag = `v${version}`;
  const files = macArtifacts(version).map((f) => path.join(DIST, f));
  console.log(`\n🍎 macOS release ${tag}`);

  if (args.includes('--cask-only')) {
    if (!fs.existsSync(files[0])) die(`no ${files[0]} — the cask checksum is computed from the uploaded dmg`);
    try { bumpCask(version, files[0]); } catch (e) { die(e.message); }
    return;
  }

  preflight(version);
  build();
  verifyNotarized(version);
  for (const f of files) if (!fs.existsSync(f)) die(`missing ${f}`);
  const [dmg, , zip] = files;
  const problem = latestMacProblem(fs.readFileSync(path.join(DIST, 'latest-mac.yml'), 'utf8'), version, {
    [path.basename(zip)]: fileDigest(zip, 'sha512', 'base64'),
    [path.basename(dmg)]: fileDigest(dmg, 'sha512', 'base64'),
  });
  if (problem) die(problem);
  console.log('  ✓ latest-mac.yml describes exactly these files');
  uploadAssets(tag, files, force);
  try {
    bumpCask(version, files[0]);
  } catch (e) {
    die(`the release is published, but the cask bump failed: ${e.message}\n   Retry with: npm run release:mac -- --cask-only`);
  }
  console.log(`\n✅ macOS ${tag} is on https://github.com/${REPO}/releases/tag/${tag}\n`);
}

module.exports = { macArtifacts, latestMacProblem, isNotarized, remoteTagCommit, tagProblem, assetDigest, keychainProfile, rewriteCask, verifyNotarized };

if (require.main === module) main().catch((e) => die(e.stack || e.message));
