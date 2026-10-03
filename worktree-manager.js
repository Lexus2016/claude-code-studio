'use strict';
/**
 * Git-worktree-per-session isolation. See docs/superpowers/specs/2026-08-25-worktree-isolation-design.md
 *
 * Every chat/terminal session and every autonomous (Kanban) task gets its own
 * git worktree, so the three write channels into a project's workdir (the
 * `claude` CLI subprocess, a raw tmux pane, the Telegram bot) can never
 * collide on the same files — a soft file-lock cannot cover the tmux pane
 * (no interposition point), but a separate directory holds for all three by
 * construction, with zero extra plumbing at each write site.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

let _gitAvailable = null;
function gitAvailable() {
  if (_gitAvailable !== null) return _gitAvailable;
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    _gitAvailable = true;
  } catch {
    _gitAvailable = false;
  }
  return _gitAvailable;
}
// Test-only: force a re-probe.
function _resetGitAvailableCache() { _gitAvailable = null; }

function _git(args, cwd, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
function _gitOk(args, cwd) {
  try { _git(args, cwd); return true; } catch { return false; }
}

/** Read a git config value, or '' when it is unset — `_git` throws on a missing key,
 *  and an exception is not an answer to "is there an identity here". */
function _gitRead(args, cwd) {
  try { return _git(args, cwd); } catch { return ''; }
}

/** Identity to hand a commit-creating git command when the machine has none.
 *
 *  Git only invents `user@host` when it can build a plausible address from the
 *  hostname; a bare CI runner or a container refuses with "Author identity unknown
 *  / Please tell me who you are" and the commit fails. Reproduced in a Linux
 *  container, which is also what the project's own Dockerfile produces: git
 *  installed, no identity configured.
 *
 *  Returns EMPTY when a real identity exists: a commit in the user's own project
 *  must stay attributed to the user, and `-c` would override it.
 *
 *  BOTH halves are checked, and both must be NON-EMPTY. `git config user.email`
 *  exits 0 for a key explicitly set to the empty string, so testing the exit code
 *  alone accepted `user.email = ""` as an identity and produced a commit with an
 *  empty author — verified in the container before this was tightened. */
function _identityArgs(dir) {
  const email = _gitRead(['config', 'user.email'], dir);
  const name = _gitRead(['config', 'user.name'], dir);
  if (email && name) return [];
  return ['-c', 'user.email=claude-code-studio@localhost', '-c', 'user.name=Claude Code Studio'];
}


function hasGitRepo(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

/**
 * Idempotent: git init (if needed) + an initial commit (if the repo has no
 * commits yet) — `git worktree add -b` needs an existing ref to branch from.
 * Never touches an already-initialized repo beyond reading its HEAD.
 */
// Only written when the directory has no .gitignore of its own AND is about to
// get its first-ever commit — a project that already tracks history keeps
// whatever .gitignore (or lack of one) it already chose. Without this, an
// auto `git add -A` on a never-before-versioned directory commits .env,
// node_modules/ and any local secrets straight into history, permanently.
const _BOOTSTRAP_GITIGNORE = `# Auto-created by Claude Code Studio before its first commit.
node_modules/
.env
.env.*
!.env.example
.DS_Store
`;

function ensureGitInitialized(dir) {
  if (!hasGitRepo(dir)) {
    _git(['init'], dir);
  }
  let hasCommit = _gitOk(['rev-parse', '--verify', 'HEAD'], dir);
  if (!hasCommit) {
    const gitignorePath = path.join(dir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, _BOOTSTRAP_GITIGNORE);
    }
    _git(['add', '-A', '--', '.'], dir);
    // --allow-empty: an empty project still needs a ref for worktrees to branch from.
    _git([..._identityArgs(dir), 'commit', '--allow-empty', '-m', 'Initial commit (auto-created by Claude Code Studio)'], dir);
  }
  return getDefaultBranch(dir);
}

function getDefaultBranch(dir) {
  return _git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
}

function branchNameFor(kind, id) {
  return `ccs/${kind}-${id}`;
}

function worktreePath(appDir, projectId, unitId) {
  return path.join(appDir, 'data', 'worktrees', String(projectId), String(unitId));
}

// path.resolve() does not resolve symlinks (e.g. macOS /var -> /private/var,
// which os.tmpdir() returns), so a plain resolve() comparison can miss an
// already-registered worktree and cause ensureWorktree() to prune/recreate
// one git still tracks. realpathSync throws on a path that doesn't exist yet.
function _real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function _listWorktrees(projectDir) {
  let out;
  try { out = _git(['worktree', 'list', '--porcelain'], projectDir); } catch { return []; }
  const entries = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { if (cur) entries.push(cur); cur = { worktree: line.slice(9) }; }
    else if (line.startsWith('branch ')) { if (cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, ''); }
    else if (line === 'bare' || line === 'detached') { if (cur) cur.detached = true; }
  }
  if (cur) entries.push(cur);
  return entries;
}

/**
 * Create (or reuse) the worktree for one session/task. Safe to call again for
 * the same unit — e.g. after a server restart with the row already in SQLite.
 */
function ensureWorktree({ projectDir, worktreeDir, branch }) {
  // Must also confirm the directory is still on disk with a real `.git` link
  // — git's own registration survives an out-of-band removal (independent
  // Docker volume reset/restore, manual cleanup, disk pruning) and reports it
  // as merely 'prunable', which would otherwise short-circuit this function
  // into returning a workdir that does not exist (or, after a restore that
  // recreates an empty directory at the same path, one that is not actually a
  // usable worktree), permanently stranding the session/task.
  const existing = _listWorktrees(projectDir).find(w => _real(w.worktree) === _real(worktreeDir));
  if (existing && fs.existsSync(path.join(worktreeDir, '.git'))) return { created: false, path: worktreeDir, branch: existing.branch || branch };

  // A directory can be left on disk without git's own registration (crash
  // between mkdir and `worktree add`, or a stale entry after manual cleanup)
  // — prune git's bookkeeping and remove any orphan directory before retrying.
  try { _git(['worktree', 'prune'], projectDir); } catch { /* best effort */ }
  if (fs.existsSync(worktreeDir)) fs.rmSync(worktreeDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

  const branchExists = _gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], projectDir);
  if (branchExists) {
    _git(['worktree', 'add', worktreeDir, branch], projectDir);
  } else {
    _git(['worktree', 'add', worktreeDir, '-b', branch], projectDir);
  }
  return { created: true, path: worktreeDir, branch };
}

/** Never a bare rm -rf — always through git so `.git/worktrees/<name>` never goes stale. */
function removeWorktree({ projectDir, worktreeDir, branch, force = false }) {
  const args = ['worktree', 'remove', worktreeDir];
  if (force) args.push('--force');
  try {
    _git(args, projectDir);
  } catch (e) {
    if (!force) throw e;
    // Directory already gone / never registered — prune stale bookkeeping and move on.
    try { _git(['worktree', 'prune'], projectDir); } catch { /* best effort */ }
    if (fs.existsSync(worktreeDir)) fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
  if (branch) {
    try { _git(['branch', '-D', branch], projectDir); } catch { /* merged already, or never existed */ }
  }
}

/**
 * Returns whether the unit's worktree has unmerged commits and/or
 * uncommitted changes — used to gate archive/delete on real data loss.
 */
function hasUnmergedWork({ worktreeDir, projectDir, defaultBranch, branch }) {
  if (!fs.existsSync(worktreeDir)) return false;
  const dirty = _git(['status', '--porcelain'], worktreeDir).length > 0;
  if (dirty) return true;
  try {
    const ahead = _git(['rev-list', '--count', `${defaultBranch}..${branch}`], projectDir);
    return parseInt(ahead, 10) > 0;
  } catch { return false; }
}

/**
 * Remove every unit worktree under `<appDir>/data/worktrees` that no database row
 * owns any more — the trees that leaked before session expiry learned to remove its
 * own (SESSION_TTL_DAYS deleted the row and left the tree). The caller supplies
 * `isReferenced(dir)`; this module does not read the database.
 *
 * Deliberately more cautious than removeWorktree(force:true), because nobody is
 * watching and nobody confirmed anything:
 *   - a tree younger than `minAgeMs` is kept — creation writes the tree first and
 *     the owning row a moment later, and a clean fresh tree looks exactly like an
 *     orphan in between;
 *   - a tree with uncommitted changes, or commits its project's current branch does
 *     not have, is kept and reported, never discarded;
 *   - a tree whose project or branch cannot be read is kept (fail safe);
 *   - removal is `git worktree remove` WITHOUT --force, so git itself refuses a tree
 *     that changed between the check and the call.
 * @returns {{ removed: string[], kept: Array<{dir: string, reason: string}> }}
 */
function pruneOrphanWorktrees({ appDir, isReferenced, minAgeMs = 60 * 60 * 1000, now = Date.now() }) {
  const out = { removed: [], kept: [] };
  const root = path.join(appDir, 'data', 'worktrees');
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); }
  catch { return out; }   // no worktrees directory yet
  for (const proj of projects) {
    const projDir = path.join(root, proj.name);
    let units;
    try { units = fs.readdirSync(projDir, { withFileTypes: true }).filter(d => d.isDirectory()); }
    catch { continue; }
    for (const unit of units) {
      const dir = path.join(projDir, unit.name);
      const keep = (reason) => out.kept.push({ dir, reason });
      if (isReferenced(dir)) continue;
      try { if (now - fs.statSync(dir).mtimeMs < minAgeMs) { keep('recent'); continue; } }
      catch { continue; }
      let projectDir, branch;
      try {
        // A linked worktree's common dir is the main repository's `.git`.
        projectDir = path.dirname(path.resolve(dir, _git(['rev-parse', '--git-common-dir'], dir)));
        branch = _git(['branch', '--show-current'], dir);
      } catch { keep('not a git worktree'); continue; }
      if (!branch) { keep('detached HEAD'); continue; }
      try {
        if (hasUnmergedWork({ worktreeDir: dir, projectDir, defaultBranch: getDefaultBranch(projectDir), branch })) {
          keep('unmerged or uncommitted work'); continue;
        }
        removeWorktree({ projectDir, worktreeDir: dir, branch, force: false });
        out.removed.push(dir);
      } catch (e) { keep(`git refused: ${String(e?.stderr || e?.message || e).trim().split('\n')[0]}`); }
    }
    try { fs.rmdirSync(projDir); } catch { /* not empty — still holds live trees */ }
  }
  return out;
}

/**
 * green/amber/red only — a merge CONFLICT happens in the shared project
 * root (projectDir), not in this worktree, so 'purple' is not derivable
 * from git state here. Callers overlay 'purple' from a stored conflict flag
 * set by mergeBranch() below, cleared on the next successful merge attempt.
 */
function getStatus({ worktreeDir, defaultBranch }) {
  const branch = _git(['branch', '--show-current'], worktreeDir);
  if (!branch || branch === defaultBranch) return { state: 'green', branch: branch || defaultBranch, dirty: false };
  const dirty = _git(['status', '--porcelain'], worktreeDir).length > 0;
  return { state: dirty ? 'red' : 'amber', branch, dirty };
}

function commitAll({ worktreeDir, message }) {
  const dirty = _git(['status', '--porcelain'], worktreeDir).length > 0;
  if (!dirty) return { committed: false };
  _git(['add', '-A', '--', '.'], worktreeDir);
  _git([..._identityArgs(worktreeDir), 'commit', '-m', message], worktreeDir);
  return { committed: true };
}

// Serializes merges per project root so two sessions' merges never race each
// other in the shared main worktree — tractable because merges are already
// server-orchestrated, unlike the file-write channels this feature protects.
const _mergeQueues = new Map();
function _enqueue(key, fn) {
  const prev = _mergeQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  _mergeQueues.set(key, next.catch(() => {}));
  return next;
}

/**
 * Merge `branch` into `defaultBranch` inside projectDir (the shared main
 * worktree — never a session worktree). On conflict, aborts immediately so
 * the shared root is never left mid-conflict for other sessions/merges.
 */
function mergeBranch({ projectDir, defaultBranch, branch }) {
  return _enqueue(path.resolve(projectDir), async () => {
    const current = _git(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
    if (current !== defaultBranch) _git(['checkout', defaultBranch], projectDir);
    try {
      // A --no-ff merge writes a merge COMMIT, so it needs an author just as much.
      _git([..._identityArgs(projectDir), 'merge', '--no-ff', '--no-edit', branch], projectDir);
      return { ok: true };
    } catch (e) {
      try { _git(['merge', '--abort'], projectDir); } catch { /* nothing to abort */ }
      return { ok: false, conflict: true, message: e.stderr || e.message };
    }
  });
}

module.exports = {
  gitAvailable, _resetGitAvailableCache,
  hasGitRepo, ensureGitInitialized, getDefaultBranch,
  branchNameFor, worktreePath,
  ensureWorktree, removeWorktree, hasUnmergedWork, pruneOrphanWorktrees,
  getStatus, commitAll, mergeBranch,
};
