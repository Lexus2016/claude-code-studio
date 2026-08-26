// worktree-manager.js — the git primitives behind per-session/per-task isolation.
//
// What has to hold, and what breaks if it doesn't:
//   - ensureGitInitialized() must leave a resolvable ref behind even for an EMPTY
//     project — `git worktree add -b` fails with no commit to branch from.
//   - ensureWorktree() must be idempotent: a server restart re-runs session setup
//     against a worktree that may already exist and be registered.
//   - mergeBranch() must NEVER leave the shared project root mid-conflict — a
//     merge --abort on failure is what lets the NEXT session's merge proceed.
//   - getStatus() reports green/amber/red from git state only; 'purple' (merge
//     conflict) is a caller-side flag because a conflict happens in the shared
//     root, not in the worktree being inspected.
//
// Run: node test/worktree-manager.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const WM = require('../worktree-manager');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.error(`  FAIL ${label} — ${e.message}`); }
}

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ccs-wm-${name}-`));
  return dir;
}
function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function initTestIdentity(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) { try { git(['init'], dir); } catch { /* already a repo, or worktree */ } }
  git(['config', 'user.email', 'ci-test-noreply'], dir);
  git(['config', 'user.name', 'Test'], dir);
}

async function main() {

console.log('gitAvailable():');
{
  check('reports true when the git binary resolves (it is on PATH in CI/dev)', WM.gitAvailable(), true);
}

console.log('\nensureGitInitialized():');
{
  const dir = tmpDir('init-empty');
  const branch = WM.ensureGitInitialized(dir);
  check('returns a resolvable branch name for an EMPTY project', typeof branch, 'string');
  check('HEAD now resolves (a ref exists to branch worktrees from)',
    (() => { try { git(['rev-parse', '--verify', 'HEAD'], dir); return true; } catch { return false; } })(), true);

  const dir2 = tmpDir('init-existing-files');
  fs.writeFileSync(path.join(dir2, 'a.txt'), 'hello');
  const branch2 = WM.ensureGitInitialized(dir2);
  check('a project with real files gets those files in the initial commit', typeof branch2, 'string');
  check('the file is tracked after auto-init', git(['ls-files'], dir2).split('\n').includes('a.txt'), true);

  const dir3 = tmpDir('init-idempotent');
  WM.ensureGitInitialized(dir3);
  const commitCountBefore = git(['rev-list', '--count', 'HEAD'], dir3);
  WM.ensureGitInitialized(dir3);
  const commitCountAfter = git(['rev-list', '--count', 'HEAD'], dir3);
  check('calling it again on an already-initialized repo adds no commits', commitCountAfter, commitCountBefore);

  const dir4 = tmpDir('init-gitignore-bootstrap');
  fs.writeFileSync(path.join(dir4, '.env'), 'SECRET=abc123\n');
  fs.writeFileSync(path.join(dir4, 'a.txt'), 'hello');
  WM.ensureGitInitialized(dir4);
  check('a .gitignore is auto-created before the first commit',
    fs.existsSync(path.join(dir4, '.gitignore')), true);
  const tracked4 = git(['ls-files'], dir4).split('\n');
  check('.env is excluded from the initial commit', tracked4.includes('.env'), false);
  check('.gitignore itself is committed', tracked4.includes('.gitignore'), true);
  check('unrelated real files still get committed', tracked4.includes('a.txt'), true);

  const dir5 = tmpDir('init-gitignore-preexisting');
  fs.writeFileSync(path.join(dir5, '.gitignore'), 'custom-ignore-rule\n');
  fs.writeFileSync(path.join(dir5, '.env'), 'SECRET=abc123\n');
  WM.ensureGitInitialized(dir5);
  check("a project's own pre-existing .gitignore is left untouched",
    fs.readFileSync(path.join(dir5, '.gitignore'), 'utf8'), 'custom-ignore-rule\n');
  check('.env still gets committed when the project chose its own .gitignore without that rule',
    git(['ls-files'], dir5).split('\n').includes('.env'), true);
}

console.log('\nensureWorktree() / removeWorktree():');
{
  const projectDir = tmpDir('project');
  initTestIdentity(projectDir);
  const defaultBranch = WM.ensureGitInitialized(projectDir);
  const worktreeDir = path.join(tmpDir('worktrees-root'), 'session-1');
  const branch = WM.branchNameFor('session', '1');

  const first = WM.ensureWorktree({ projectDir, worktreeDir, branch });
  check('first call creates the worktree', first.created, true);
  check('the worktree directory now exists on disk', fs.existsSync(worktreeDir), true);
  initTestIdentity(worktreeDir);

  const second = WM.ensureWorktree({ projectDir, worktreeDir, branch });
  check('a second call against the same unit is a no-op, not an error', second.created, false);

  WM.removeWorktree({ projectDir, worktreeDir, branch });
  check('removeWorktree deletes the directory', fs.existsSync(worktreeDir), false);
  check("removeWorktree also deletes the session's branch", git(['branch', '--list', branch], projectDir), '');

  // Re-creating after removal must work — this is what a fresh session for the
  // same slot (or a retried creation after a crash) needs.
  const third = WM.ensureWorktree({ projectDir, worktreeDir, branch });
  check('re-creating after a clean removal succeeds', third.created, true);
  check('branch matches the requested default branch scheme', third.branch, branch);
  void defaultBranch;
}

console.log('\ngetStatus() — green/amber/red from git state:');
{
  const projectDir = tmpDir('project-status');
  initTestIdentity(projectDir);
  const defaultBranch = WM.ensureGitInitialized(projectDir);
  const worktreeDir = path.join(tmpDir('worktrees-status'), 'session-2');
  const branch = WM.branchNameFor('session', '2');
  WM.ensureWorktree({ projectDir, worktreeDir, branch });
  initTestIdentity(worktreeDir);

  const clean = WM.getStatus({ worktreeDir, defaultBranch });
  check('a freshly created, untouched worktree is amber (clean, not merged)', clean.state, 'amber');

  fs.writeFileSync(path.join(worktreeDir, 'new.txt'), 'x');
  const dirty = WM.getStatus({ worktreeDir, defaultBranch });
  check('an uncommitted change makes it red', dirty.state, 'red');

  WM.commitAll({ worktreeDir, message: 'add new.txt' });
  const cleanAgain = WM.getStatus({ worktreeDir, defaultBranch });
  check('committing turns it back to amber', cleanAgain.state, 'amber');
}

console.log('\ncommitAll():');
{
  const projectDir = tmpDir('project-commit');
  initTestIdentity(projectDir);
  WM.ensureGitInitialized(projectDir);
  const worktreeDir = path.join(tmpDir('worktrees-commit'), 'session-3');
  const branch = WM.branchNameFor('session', '3');
  WM.ensureWorktree({ projectDir, worktreeDir, branch });
  initTestIdentity(worktreeDir);

  const noop = WM.commitAll({ worktreeDir, message: 'nothing to commit' });
  check('nothing to commit is reported, not silently accepted as a commit', noop.committed, false);

  fs.writeFileSync(path.join(worktreeDir, 'f.txt'), 'content');
  const real = WM.commitAll({ worktreeDir, message: 'add f.txt' });
  check('a real change is committed', real.committed, true);
}

console.log('\nhasUnmergedWork():');
{
  const projectDir = tmpDir('project-unmerged');
  initTestIdentity(projectDir);
  const defaultBranch = WM.ensureGitInitialized(projectDir);
  const worktreeDir = path.join(tmpDir('worktrees-unmerged'), 'session-4');
  const branch = WM.branchNameFor('session', '4');
  WM.ensureWorktree({ projectDir, worktreeDir, branch });
  initTestIdentity(worktreeDir);

  check('a fresh worktree with no commits of its own has no unmerged work',
    WM.hasUnmergedWork({ worktreeDir, projectDir, defaultBranch, branch }), false);

  fs.writeFileSync(path.join(worktreeDir, 'g.txt'), 'x');
  check('an uncommitted change counts as unmerged work (would be lost on delete)',
    WM.hasUnmergedWork({ worktreeDir, projectDir, defaultBranch, branch }), true);

  WM.commitAll({ worktreeDir, message: 'add g.txt' });
  check('a committed-but-not-merged change still counts as unmerged work',
    WM.hasUnmergedWork({ worktreeDir, projectDir, defaultBranch, branch }), true);
}

console.log('\nmergeBranch():');
{
  const projectDir = tmpDir('project-merge');
  initTestIdentity(projectDir);
  const defaultBranch = WM.ensureGitInitialized(projectDir);
  const worktreeDir = path.join(tmpDir('worktrees-merge'), 'session-5');
  const branch = WM.branchNameFor('session', '5');
  WM.ensureWorktree({ projectDir, worktreeDir, branch });
  initTestIdentity(worktreeDir);
  fs.writeFileSync(path.join(worktreeDir, 'h.txt'), 'x');
  WM.commitAll({ worktreeDir, message: 'add h.txt' });

  const result = await WM.mergeBranch({ projectDir, defaultBranch, branch });
  check('a clean merge reports ok', result.ok, true);
  check('the file lands in the shared project root after merge', fs.existsSync(path.join(projectDir, 'h.txt')), true);
  check('the project root stays on the default branch after merging', git(['branch', '--show-current'], projectDir), defaultBranch);
}

console.log('\nmergeBranch() — conflict aborts instead of leaving the root mid-conflict:');
{
  const projectDir = tmpDir('project-conflict');
  initTestIdentity(projectDir);
  fs.writeFileSync(path.join(projectDir, 'shared.txt'), 'original\n');
  const defaultBranch = WM.ensureGitInitialized(projectDir);

  const worktreeDir = path.join(tmpDir('worktrees-conflict'), 'session-6');
  const branch = WM.branchNameFor('session', '6');
  WM.ensureWorktree({ projectDir, worktreeDir, branch });
  initTestIdentity(worktreeDir);
  fs.writeFileSync(path.join(worktreeDir, 'shared.txt'), 'from the session branch\n');
  WM.commitAll({ worktreeDir, message: 'change shared.txt in session branch' });

  // Diverge the root itself so the merge is a genuine conflict, not a fast-forward.
  fs.writeFileSync(path.join(projectDir, 'shared.txt'), 'changed on main meanwhile\n');
  git(['add', '-A'], projectDir);
  git(['commit', '-m', 'change shared.txt on main'], projectDir);

  const result = await WM.mergeBranch({ projectDir, defaultBranch, branch });
  check('a real conflict is reported, not silently swallowed', result.ok, false);
  check('and flagged specifically as a conflict', result.conflict, true);
  check('the root is left clean — no half-finished merge for the next session to trip over',
    git(['status', '--porcelain'], projectDir), '');
  check('no MERGE_HEAD left behind', (() => {
    try { git(['rev-parse', '--verify', 'MERGE_HEAD'], projectDir); return true; } catch { return false; }
  })(), false);
}

console.log('\nmergeBranch() — serializes concurrent merges into the same project root:');
{
  const projectDir = tmpDir('project-serial');
  initTestIdentity(projectDir);
  const defaultBranch = WM.ensureGitInitialized(projectDir);

  const units = ['a', 'b', 'c'];
  const branches = [];
  for (const u of units) {
    const worktreeDir = path.join(tmpDir(`worktrees-serial-${u}`), `session-${u}`);
    const branch = WM.branchNameFor('session', u);
    WM.ensureWorktree({ projectDir, worktreeDir, branch });
    initTestIdentity(worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, `${u}.txt`), u);
    WM.commitAll({ worktreeDir, message: `add ${u}.txt` });
    branches.push(branch);
  }

  const results = await Promise.all(branches.map(branch => WM.mergeBranch({ projectDir, defaultBranch, branch })));
  check('every independent, non-conflicting merge succeeds despite running concurrently',
    results.every(r => r.ok), true);
  check('all three files land in the root — none of the concurrent merges clobbered another',
    units.every(u => fs.existsSync(path.join(projectDir, `${u}.txt`))), true);
}

// ── A machine with no git identity must still bootstrap, and be attributable ──
// `git commit` invents user@host only when it can build a plausible address from
// the hostname; a bare container refuses with "unable to auto-detect email
// address". setupUnitWorktree() runs inside POST /api/tasks, so that failure took
// the whole request down with it. The official Docker image is exactly such a
// machine: git installed, no identity set.
//
// Asserting "it did not throw" is NOT enough — a developer machine auto-detects
// and passes either way, which is how a green test can hide a broken fix. The
// pin is the AUTHOR: with the fallback the commit is ours, without it the commit
// is whatever git guessed (or there is no commit at all).
console.log('\nbootstrapping without a configured git identity:');
{
  const os2 = require('os'), fs2 = require('fs'), path2 = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'wm-noident-'));
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  try {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    let branch = null, threw = null;
    try { branch = WM.ensureGitInitialized(dir); } catch (e) { threw = e; }
    check('it does not throw', threw === null, true);
    check('and reports a branch', typeof branch === 'string' && branch.length > 0, true);
    const author = execFileSync('git', ['log', '-1', '--format=%ae'], { cwd: dir, encoding: 'utf8' }).trim();
    check('the bootstrap commit is attributed to the studio, not to a guessed address',
      author, 'claude-code-studio@localhost');

    // `git config user.email` EXITS 0 for a key explicitly set to "", so testing the
    // exit code alone accepted an empty identity and produced a commit with an empty
    // author. Verified in a container before this was tightened.
    const dir2 = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'wm-emptyident-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir2, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', ''], { cwd: dir2, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', ''], { cwd: dir2, stdio: 'ignore' });
      WM.ensureGitInitialized(dir2);
      const a2 = execFileSync('git', ['log', '-1', '--format=%ae'], { cwd: dir2, encoding: 'utf8' }).trim();
      check('an EMPTY user.email does not count as an identity', a2, 'claude-code-studio@localhost');
    } finally { try { fs2.rmSync(dir2, { recursive: true, force: true }); } catch {} }
  } finally {
    if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
    if (saved.s === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = saved.s;
    try { fs2.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// A project that DOES have an identity must keep it — a bootstrap commit in the
// user's own repo belongs to the user, not to us.
console.log('\nan existing identity is never overridden:');
{
  const os2 = require('os'), fs2 = require('fs'), path2 = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'wm-ident-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'someone@example.com'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Someone'], { cwd: dir, stdio: 'ignore' });
    WM.ensureGitInitialized(dir);
    const author = execFileSync('git', ['log', '-1', '--format=%ae'], { cwd: dir, encoding: 'utf8' }).trim();
    check('the project owner authored the bootstrap commit', author, 'someone@example.com');
  } finally {
    try { fs2.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── Who inherits a worktree, and who must never remove one ─────────────────
// Isolation is not "every creator gets a tree". Three sites CONTINUE work that
// already has one, and each of them dropped the metadata that says so. Pinned as
// source text (the technique test/render/script-scope.test.mjs uses) because the
// property is which columns a call site carries, not what a pure function returns.
console.log('\ncontinuation sites inherit instead of minting a second tree:');
{
  const fs2 = require('fs'), path2 = require('path');
  const SRV = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
  const near = (anchor, span = 900) => { const i = SRV.indexOf(anchor); return i === -1 ? null : SRV.slice(i, i + span); };

  // A compact continues the same conversation in the same tree. Copying `workdir`
  // alone left it sharing a directory it did not know it shared.
  const cmp = near("const compactTitle =");
  check('compact copies git_root/git_branch, not just workdir',
    cmp !== null && /setSessionGit\.run\(sess\.workdir, sess\.git_root, sess\.git_branch, newId\)/.test(cmp), true);

  // The task already has a worktree from POST /api/tasks; its session is a sidecar.
  const st = near("stmts.setTaskSession.run(sessionId, task.id)", 1200);
  const stBack = SRV.slice(Math.max(0, SRV.indexOf("stmts.setTaskSession.run(sessionId, task.id)") - 900), SRV.indexOf("stmts.setTaskSession.run(sessionId, task.id)"));
  check('startTask copies the task git columns onto its sidecar session',
    /setSessionGit\.run\(task\.workdir, task\.git_root, task\.git_branch, sessionId\)/.test(stBack), true);

  // An export from an isolated session carries a worktree path that exists only on
  // the machine it came from — and only until that worktree is removed.
  const imp = near("String(session.title || 'Imported session')", 1200);
  check('JSON import stores the PROJECT root, never the exported worktree',
    imp !== null && /session\.git_root \|\| session\.workdir \|\| null/.test(imp), true);
  check('and it does not mint a worktree for imported history',
    imp !== null && !/setupUnitWorktree/.test(imp), true);
}

console.log('\na shared worktree is not removed while another session uses it:');
{
  const fs2 = require('fs'), path2 = require('path');
  const SRV = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
  const i = SRV.indexOf("removeWorktree failed on session delete");
  const win = i === -1 ? '' : SRV.slice(Math.max(0, i - 1200), i);
  // force:true means a removal that should not have happened reports no error at all,
  // so the guard has to come BEFORE the call rather than being cleaned up after.
  check('the delete path counts other sessions on the same workdir first',
    /FROM sessions WHERE workdir=\? AND id<>\?/.test(win), true);
  check('and the count is read before removeWorktree, not after',
    win.indexOf('FROM sessions WHERE workdir=?') < win.indexOf('WM.removeWorktree'), true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
}

main();
