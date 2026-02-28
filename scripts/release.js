#!/usr/bin/env node
/**
 * scripts/release.js — one-command release
 *
 * Usage:
 *   npm run release 5.19.0
 *   npm run release patch     (5.18.1 → 5.18.2)
 *   npm run release minor     (5.18.1 → 5.19.0)
 *   npm run release major     (5.18.1 → 6.0.0)
 *
 * What it does:
 *   1. Bumps version in package.json
 *   2. Commits: "chore: release v5.19.0"
 *   3. Tags: v5.19.0
 *   4. Pushes commit + tag → GitHub Actions creates the Release automatically
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PKG  = path.join(ROOT, 'package.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  → ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function currentVersion() {
  return JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
}

function bumpVersion(part, pkg) {
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  if (part === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump type: ${part}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (!arg) {
  console.error('Usage: npm run release <version|patch|minor|major>');
  console.error('Example: npm run release 5.19.0');
  process.exit(1);
}

// Resolve target version
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
let version;
if (['patch', 'minor', 'major'].includes(arg)) {
  version = bumpVersion(arg, pkg);
} else if (/^\d+\.\d+\.\d+$/.test(arg)) {
  version = arg;
} else {
  console.error(`Invalid version: "${arg}". Use semver (e.g. 5.19.0) or patch/minor/major.`);
  process.exit(1);
}

const tag = `v${version}`;
console.log(`\n🚀 Releasing ${tag} (current: ${currentVersion()})\n`);

// 1. Verify working tree is clean (only package.json allowed as staged)
try {
  const dirty = execSync('git status --porcelain', { cwd: ROOT }).toString().trim();
  const lines = dirty.split('\n').filter(Boolean);
  const nonPkg = lines.filter(l => !l.endsWith('package.json'));
  if (nonPkg.length > 0) {
    console.error('⛔ Working tree has uncommitted changes:');
    nonPkg.forEach(l => console.error('  ', l));
    console.error('\nCommit or stash changes before releasing.');
    process.exit(1);
  }
} catch {}

// 2. Update package.json
pkg.version = version;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
console.log(`✓ package.json → ${version}`);

// 3. Commit + tag
run(`git add package.json`);
run(`git commit -m "chore: release ${tag}"`);
run(`git tag ${tag}`);
console.log(`✓ Committed and tagged ${tag}`);

// 4. Push commit + tag
run(`git push origin main`);
run(`git push origin ${tag}`);

console.log(`\n✅ Done! GitHub Actions will create the release automatically.`);
console.log(`   https://github.com/Lexus2016/claude-code-studio/releases/tag/${tag}\n`);
