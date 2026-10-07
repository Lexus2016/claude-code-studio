'use strict';

// Exercise the destructive recovery/delete guards against real, disposable repos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const WM = require('../worktree-manager');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-worktree-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const worktreeDir = path.join(root, 'worktree');
  fs.mkdirSync(projectDir);
  const git = (args, cwd = projectDir) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Worktree test']);
  git(['config', 'user.email', 'worktree-test@example.invalid']);
  const defaultBranch = WM.ensureGitInitialized(projectDir);
  return { projectDir, worktreeDir, defaultBranch, branch: 'ccs/test', git };
}

test('recovery refuses an unregistered directory containing user files', t => {
  const f = fixture(t);
  fs.mkdirSync(f.worktreeDir);
  const valuable = path.join(f.worktreeDir, 'uncommitted.txt');
  fs.writeFileSync(valuable, 'the only copy');
  assert.throws(() => WM.ensureWorktree(f), /non-empty|existing files/i);
  assert.equal(fs.readFileSync(valuable, 'utf8'), 'the only copy');
});

test('recovery still recreates a removed worktree and an empty restored directory', t => {
  const f = fixture(t);
  WM.ensureWorktree(f);
  for (const restoreEmpty of [false, true]) {
    fs.rmSync(f.worktreeDir, { recursive: true });
    if (restoreEmpty) fs.mkdirSync(f.worktreeDir);
    assert.equal(WM.ensureWorktree(f).created, true);
    assert.equal(f.git(['branch', '--show-current'], f.worktreeDir), f.branch);
  }
});

test('recovery preserves work when the git link alone was lost', t => {
  const f = fixture(t);
  WM.ensureWorktree(f);
  fs.writeFileSync(path.join(f.worktreeDir, 'draft.txt'), 'keep me');
  fs.unlinkSync(path.join(f.worktreeDir, '.git'));
  assert.throws(() => WM.ensureWorktree(f), /non-empty|existing files/i);
  assert.equal(fs.readFileSync(path.join(f.worktreeDir, 'draft.txt'), 'utf8'), 'keep me');
});

test('a failed commit comparison never authorizes deleting a worktree', t => {
  const f = fixture(t);
  WM.ensureWorktree(f);
  assert.equal(WM.hasUnmergedWork({ ...f, defaultBranch: 'deleted-default-branch' }), true);
  assert.equal(WM.hasUnmergedWork({ ...f, branch: 'deleted-session-branch' }), true);
});

test('a missing worktree directory can still have unmerged branch commits', t => {
  const f = fixture(t);
  WM.ensureWorktree(f);
  fs.writeFileSync(path.join(f.worktreeDir, 'saved.txt'), 'committed work');
  WM.commitAll({ worktreeDir: f.worktreeDir, message: 'save work' });
  fs.rmSync(f.worktreeDir, { recursive: true });
  assert.equal(WM.hasUnmergedWork(f), true);
  assert.equal(f.git(['show', `${f.branch}:saved.txt`]), 'committed work');
});

test('a missing directory whose branch is merged is safe to clean up', t => {
  const f = fixture(t);
  WM.ensureWorktree(f);
  fs.rmSync(f.worktreeDir, { recursive: true });
  assert.equal(WM.hasUnmergedWork(f), false);
});

test('an automatic merge never aborts an existing manual merge', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.projectDir, 'shared.txt'), 'base\n');
  f.git(['add', '.']);
  f.git(['commit', '-qm', 'base']);
  WM.ensureWorktree(f);
  f.git(['checkout', '-qb', 'manual-branch']);
  fs.writeFileSync(path.join(f.projectDir, 'shared.txt'), 'manual branch\n');
  f.git(['commit', '-qam', 'manual branch change']);
  f.git(['checkout', f.defaultBranch]);
  fs.writeFileSync(path.join(f.projectDir, 'shared.txt'), 'main branch\n');
  f.git(['commit', '-qam', 'main branch change']);
  assert.throws(() => f.git(['merge', 'manual-branch']));
  const mergeHead = f.git(['rev-parse', 'MERGE_HEAD']);
  fs.writeFileSync(path.join(f.projectDir, 'shared.txt'), 'manual resolution in progress\n');

  const result = await WM.mergeBranch(f);
  assert.equal(result.ok, false);
  assert.equal(f.git(['rev-parse', 'MERGE_HEAD']), mergeHead);
  assert.equal(fs.readFileSync(path.join(f.projectDir, 'shared.txt'), 'utf8'), 'manual resolution in progress\n');
});
