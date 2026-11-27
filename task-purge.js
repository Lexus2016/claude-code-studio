'use strict';

/**
 * What a bulk purge of finished tasks may destroy (#160).
 *
 * The board's rule: nothing is thrown away unseen. Only a card that has nothing
 * to lose — no unmerged commits, no uncommitted files — goes in one pass. A
 * finished or cancelled card whose worktree still holds work comes back in
 * `review` instead, so the work can be looked at and then either merged (the
 * change is wanted) or force-deleted after an explicit confirmation (it is not).
 *
 * The decision is a pure function on purpose: it is the one place where a wrong
 * answer deletes real work, so it is exercised directly by test/task-purge.test.js
 * rather than only through a running server.
 */

// Terminal columns on the board. `todo`/`in_progress` cards are live work and are
// never candidates, whatever the caller passes.
const PURGE_STATUSES = ['done', 'cancelled'];

/**
 * @param {object} opts
 * @param {object[]} opts.tasks          candidate rows (task shape from the DB)
 * @param {(task: object) => boolean} opts.isRunning  a task that may not be touched
 * @param {(task: object) => 'clean'|'unmerged'|'unreadable'} opts.inspect
 *        what the task's worktree holds; a throw is read as 'unreadable'
 * @returns {{remove: object[], review: {task: object, reason: string}[]}}
 */
function planPurge({ tasks, isRunning, inspect }) {
  const remove = [];
  const review = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || !PURGE_STATUSES.includes(task.status)) continue;
    if (isRunning(task)) {
      // A card the worker still owns: deleting it mid-run would pull the tree out
      // from under the process. It stays, and says why.
      review.push({ task, reason: 'running' });
      continue;
    }
    let state;
    try {
      state = inspect(task);
    } catch {
      // An inspection that failed is not permission to delete: the only copy of
      // that work may be exactly what we could not read.
      state = 'unreadable';
    }
    if (state === 'unmerged') { review.push({ task, reason: 'unmerged' }); continue; }
    if (state === 'unreadable') { review.push({ task, reason: 'unreadable' }); continue; }
    remove.push(task);
  }
  return { remove, review };
}

module.exports = { PURGE_STATUSES, planPurge };
