# Worktree isolation — design spec

Status: approved, implementing now (2026-08-25)

## Problem

Claude Code Studio lets several sessions (chats, terminals, Telegram bots,
Kanban tasks) operate against the same project `workdir` at once. Nothing
stops two of them from writing the same file at the same time. A soft
file-lock scheme is unenforceable: three write channels exist into a
workdir — the `claude` CLI subprocess (interceptable), a raw tmux pane
(NOT interceptable, no interposition point), and the Telegram bot
(interceptable) — so a lock that only the interceptable two respect gives
false confidence, not real protection.

## Decision

Every session gets its own `git worktree`, created automatically, with no
user-facing on/off switch (a manual toggle is a guaranteed source of user
error — isolation must be unconditional). Isolation is filesystem-level and
therefore holds for all three write channels equally, including the tmux
pane, because a worktree is just a directory the pane's shell is launched
in.

### Placement and naming

- Worktree path: `<APP_DIR>/data/worktrees/<projectId>/<sessionId>` — outside
  the project's own tree, inside the studio's own data directory (mirrors
  where `data/chats.db` and `data/sessions-auth.json` already live).
- Branch name: `ccs/session-<sessionId>`.

### Git availability gating

- `gitAvailable` capability flag, computed once at boot (`git --version`),
  exposed on `/api/version` next to the existing `tmuxAvailable` — same
  pattern, not a new one.
- No `git` binary → session creation is hard-blocked with a clear message.
  No silent fallback to shared-workdir mode; that would silently reintroduce
  the exact hazard this feature removes.
- Project has no `.git` → auto `git init` + an initial commit (worktrees
  need an existing ref to branch from) the first time a session is created
  against it.

### Dependency isolation

No symlinking or copying `node_modules` / `venv` / `target` between
worktrees. Full independent bootstrap per worktree. The package manager's
own on-disk cache (npm/pip/cargo cache, not the project-local install dir)
is what keeps this fast; sharing the install dir risks exactly the kind of
cross-session interference this feature exists to prevent.

### Merge policy — actor-differentiated

- **Autonomous / Kanban tasks:** auto-merge into the project's default
  branch the moment the scheduler marks the task `done`. If the merge does
  not fast-forward or conflicts, the task status becomes `blocked` instead
  of `done`, with the conflict recorded, and does NOT retry silently.
- **Interactive chat / terminal sessions:** never auto-merge. The session
  shows a persistent branch-status indicator; merging is one explicit click.

### Branch status indicator (chat UI)

Four states, computed via `git status --porcelain` + `git branch
--show-current` in the session's worktree, pushed over the existing
WebSocket channel alongside `done`:

| Color  | Meaning                              | Click action           |
|--------|---------------------------------------|-------------------------|
| green  | on the project's default branch       | none (nothing to do)   |
| amber  | session branch, clean, not merged     | Merge                  |
| red    | session branch, uncommitted changes   | Commit                 |
| purple | merge conflict (`MERGE_HEAD` present) | view conflict / resolve|

Recomputed on session open and after every turn — not only per-turn, so a
tab reopened later still shows the true state.

### Merge queue

Merges into the shared default branch are serialized server-side (one at a
time per project) to avoid two sessions' merges racing each other; this is
tractable because merges are already server-orchestrated (unlike the
abandoned per-file lock, which had no server-side choke point at all).

### Safety

- Archiving/deleting a session whose worktree has unmerged commits or
  uncommitted changes requires confirmation — never silently discards work.
- Worktree removal always goes through `git worktree remove`, never a bare
  `rm -rf`, so git's own bookkeeping (`.git/worktrees/<name>`) never goes
  stale.

## Explicitly out of scope for this iteration

- Cross-worktree diff/merge preview UI beyond "conflict, go resolve it".
- Remote-SSH sessions (already run on a different filesystem/process
  boundary; the workdir there is not this server's to worktree).
