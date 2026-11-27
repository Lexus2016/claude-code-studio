'use strict';

// Cleaning up finished tasks (#160).
//
// The board's rule, set by the owner: nothing is thrown away unseen. A bulk purge
// removes only cards whose worktree holds nothing to lose; a finished card that
// still holds work comes back for review, where the next step is either Merge (the
// change is wanted) or Delete without merging (it is not). The bulk call must never
// carry force, and a force delete must stay behind the same confirmation the single
// card delete already asks.
//
// Run: node test/task-purge.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const { planPurge, PURGE_STATUSES } = require('../task-purge.js');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const KANBAN = fs.readFileSync(path.join(ROOT, 'public', 'kanban.html'), 'utf8');

const task = (id, status, extra = {}) => ({ id, title: id, status, git_branch: `ccs/${id}`, workdir: `/p/.worktrees/${id}`, git_root: '/p', ...extra });

test('only terminal cards are candidates at all', () => {
  assert.deepEqual(PURGE_STATUSES, ['done', 'cancelled']);
  const { remove } = planPurge({
    tasks: [task('a', 'done'), task('b', 'cancelled'), task('c', 'todo'), task('d', 'in_progress'), task('e', 'backlog')],
    isRunning: () => false,
    inspect: () => 'clean',
  });
  assert.deepEqual(remove.map(t => t.id), ['a', 'b']);
});

test('a card holding work is reviewed, never removed', () => {
  const { remove, review } = planPurge({
    tasks: [task('clean', 'done'), task('dirty', 'done'), task('lost', 'cancelled')],
    isRunning: () => false,
    inspect: t => (t.id === 'dirty' ? 'unmerged' : t.id === 'lost' ? 'unreadable' : 'clean'),
  });
  assert.deepEqual(remove.map(t => t.id), ['clean']);
  assert.deepEqual(review.map(r => [r.task.id, r.reason]), [['dirty', 'unmerged'], ['lost', 'unreadable']]);
});

test('an inspection that throws is "unreadable", not permission to delete', () => {
  const { remove, review } = planPurge({
    tasks: [task('a', 'done')],
    isRunning: () => false,
    inspect: () => { throw new Error('git exploded'); },
  });
  assert.equal(remove.length, 0);
  assert.deepEqual(review.map(r => r.reason), ['unreadable']);
});

test('a running card is kept even when its worktree looks empty', () => {
  const { remove, review } = planPurge({
    tasks: [task('live', 'done')],
    isRunning: t => t.id === 'live',
    inspect: () => 'clean',
  });
  assert.equal(remove.length, 0);
  assert.deepEqual(review.map(r => r.reason), ['running']);
});

test('junk input is ignored instead of throwing', () => {
  assert.deepEqual(planPurge({ tasks: null, isRunning: () => false, inspect: () => 'clean' }), { remove: [], review: [] });
  assert.deepEqual(planPurge({ tasks: [null, undefined, {}], isRunning: () => false, inspect: () => 'clean' }), { remove: [], review: [] });
});

// ── The wiring, in source ────────────────────────────────────────────────────
test('the purge endpoint removes only what planPurge approved', () => {
  const at = SERVER.indexOf("app.post('/api/tasks/purge'");
  assert.notEqual(at, -1, 'POST /api/tasks/purge must exist');
  const body = SERVER.slice(at, SERVER.indexOf('\n});', at) + 4);
  assert.match(body, /planPurge\(/, 'the route must use the shared decision');
  assert.match(body, /for \(const task of remove\) deleteTaskRow\(task\)/, 'only the approved cards may be torn down');
  assert.doesNotMatch(body, /force/, 'the bulk call must not force anything: a force delete is a decision about one card');
});

test('both task delete doors share one teardown', () => {
  const del = SERVER.indexOf("app.delete('/api/tasks/:id'");
  assert.notEqual(del, -1);
  const body = SERVER.slice(del, SERVER.indexOf('\n});', del) + 4);
  assert.match(body, /deleteTaskRow\(task\)/, 'DELETE /api/tasks/:id must use the shared teardown');
  const helper = SERVER.indexOf('function deleteTaskRow(task)');
  assert.notEqual(helper, -1);
});

test('a task merge mirrors the worker rule: commit only on the task branch', () => {
  const at = SERVER.indexOf("app.post('/api/tasks/:id/git-merge'");
  assert.notEqual(at, -1, 'the merge door must exist');
  const body = SERVER.slice(at, SERVER.indexOf('\n});', at) + 4);
  assert.match(body, /wtStatus\.branch === task\.git_branch/, 'a stray checkout must not have work committed onto it');
  assert.match(body, /mergeBranch\(/, 'the merge goes through the worktree manager, never raw git');
});

test('the board offers the cleanup and keeps the review explicit', () => {
  assert.match(KANBAN, /id="purgeBtn"/, 'the header must carry the action');
  assert.match(KANBAN, /id="purgeOv"/, 'the review lives in its own dialog');
  assert.match(KANBAN, /async function runPurge\(/, 'the bulk call must be a named step');
  assert.match(KANBAN, /async function _purgeAct\(/, 'per-card merge/delete must be a named step');
  const run = KANBAN.slice(KANBAN.indexOf('async function runPurge('), KANBAN.indexOf('async function _purgeAct('));
  assert.doesNotMatch(run, /force/, 'the bulk step must not force anything');
  // The only force delete in the cleanup is the per-card one, behind a confirm.
  assert.match(KANBAN.slice(KANBAN.indexOf('async function _purgeAct(')), /\?force=1/, 'the per-card delete is the force door');
});

// ── The per-card actions, run for real ──────────────────────────────────────
function liftAct() {
  const at = KANBAN.indexOf('async function _purgeAct(');
  assert.notEqual(at, -1, '_purgeAct must exist');
  const end = KANBAN.indexOf('\n}', at);
  assert.notEqual(end, -1, '_purgeAct must have a top-level closing brace');
  return KANBAN.slice(at, end + 2);
}

function harness({ confirmAnswer = true, merge = { status: 200, body: { ok: true } }, del = { status: 200, body: { ok: true } } } = {}) {
  const calls = { fetched: [], toasts: [], merged: [], asked: [] };
  const ctx = {
    _purgeItems: [{ id: 'task-a', branch: 'ccs/task-a', workdir: '/p/.worktrees/task-a' }],
    t: k => (k === 'confirm.unmerged' ? '{branch} in {path}' : k),
    toast: (msg, kind) => calls.toasts.push({ msg, kind }),
    confirm: msg => { calls.asked.push(msg); return confirmAnswer; },
    encodeURIComponent,
    apiFetch: async (url, opts) => {
      calls.merged.push({ url, opts });
      return { status: merge.status, ok: merge.status >= 200 && merge.status < 300, json: async () => merge.body };
    },
    fetch: async (url, opts) => {
      calls.fetched.push({ url, opts });
      return { status: del.status, ok: del.status >= 200 && del.status < 300, json: async () => del.body };
    },
    renderPurgeReview: () => {},
    refresh: async () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(liftAct(), ctx);
  return { ctx, calls };
}

test('delete without merging sends nothing until the question is answered yes', async () => {
  const no = harness({ confirmAnswer: false });
  await no.ctx._purgeAct('task-a', 'delete');
  assert.equal(no.calls.fetched.length, 0, 'Cancel must destroy nothing');
  assert.equal(no.calls.asked.length, 1);
  assert.equal(no.calls.asked[0], 'ccs/task-a in /p/.worktrees/task-a', 'the question names what would be lost');

  const yes = harness({ confirmAnswer: true });
  await yes.ctx._purgeAct('task-a', 'delete');
  assert.equal(yes.calls.fetched.length, 1);
  assert.equal(yes.calls.fetched[0].url, '/api/tasks/task-a?force=1');
  assert.equal(yes.ctx._purgeItems.length, 0, 'the reviewed row is gone once the card is gone');
});

test('merge goes through the merge door, then the ordinary delete', async () => {
  const h = harness();
  await h.ctx._purgeAct('task-a', 'merge');
  assert.equal(h.calls.merged.length, 1);
  assert.equal(h.calls.merged[0].url, '/api/tasks/task-a/git-merge');
  assert.equal(h.calls.fetched.length, 1);
  assert.equal(h.calls.fetched[0].url, '/api/tasks/task-a', 'after a merge nothing is left to lose, so no force is needed');
  assert.equal(h.ctx._purgeItems.length, 0);
});

test('a refused merge removes nothing and says why', async () => {
  const h = harness({ merge: { status: 200, body: { ok: false, message: 'merge conflict' } } });
  await h.ctx._purgeAct('task-a', 'merge');
  assert.equal(h.calls.fetched.length, 0, 'a conflicted branch keeps its card and its tree');
  assert.equal(h.ctx._purgeItems.length, 1);
  assert.equal(h.calls.toasts.at(-1).kind, true, 'a refusal is an error toast, not a success');
  assert.match(h.calls.toasts.at(-1).msg, /merge conflict/);
});
