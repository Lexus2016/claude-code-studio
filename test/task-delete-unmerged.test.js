'use strict';

// Deleting a task that still holds work (#160).
//
// DELETE /api/tasks/:id answers 409 UNMERGED_WORK unless the delete is forced. The chat
// has asked again and resent with ?force=1 since #129, but the Kanban card and the
// Schedule list surfaced the raw refusal and stopped, so a task whose worktree held
// unmerged commits or uncommitted changes could not be removed from either screen.
// These run the REAL _taskDeleteRequest from both pages in a vm.
//
// Run: node test/task-delete-unmerged.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const PAGES = {
  kanban: fs.readFileSync(path.join(__dirname, '..', 'public', 'kanban.html'), 'utf8'),
  schedule: fs.readFileSync(path.join(__dirname, '..', 'public', 'schedule.html'), 'utf8'),
};

function lift(src, name) {
  let at = src.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} must exist`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, `${name} must have a top-level closing brace`);
  return src.slice(at, end + 2);
}

function harness(page) {
  const calls = { toasts: [] };
  const ctx = {
    // Keep the placeholders: the helper itself must substitute the branch and the path.
    t: k => (k === 'confirm.unmerged' ? '{branch} in {path}' : k),
    toast: (msg, kind) => calls.toasts.push({ msg, kind }),
    location: { href: '' },
  };
  vm.createContext(ctx);
  vm.runInContext(lift(PAGES[page], '_taskDeleteRequest'), ctx);
  return { ctx, calls };
}

const TK = { id: 'task-a', title: 'Original', git_branch: 'ccs/task-a', workdir: '/p/.worktrees/task-a' };

// A server double answering with the scripted statuses in order, recording every force
// flag it was asked with.
function sender(script) {
  const sent = [];
  return {
    sent,
    send: async force => {
      sent.push(force);
      const s = script.shift();
      assert.ok(s, 'unexpected extra request');
      return { status: s.status, ok: s.status >= 200 && s.status < 300, json: async () => s.body || {} };
    },
  };
}

const UNMERGED = { status: 409, body: { code: 'UNMERGED_WORK', error: 'task has unmerged or uncommitted changes' } };

for (const page of ['kanban', 'schedule']) {
  test(`${page}: a refused delete asks first and destroys nothing when cancelled`, async () => {
    const { ctx, calls } = harness(page);
    const s = sender([UNMERGED]);
    const asked = [];
    const ok = await ctx._taskDeleteRequest(TK, s.send, async msg => { asked.push(msg); return false; });
    assert.equal(ok, false);
    assert.deepEqual(s.sent, [false], 'one unforced request only');
    assert.deepEqual(asked, ['ccs/task-a in /p/.worktrees/task-a'], 'the question names the branch and the worktree');
    assert.deepEqual(calls.toasts, [], 'cancelling is not an error');
  });

  test(`${page}: confirming the warning resends with force and only then succeeds`, async () => {
    const { ctx, calls } = harness(page);
    const s = sender([UNMERGED, { status: 200, body: { ok: true } }]);
    const ok = await ctx._taskDeleteRequest(TK, s.send, async () => true);
    assert.equal(ok, true);
    assert.deepEqual(s.sent, [false, true], 'the second request is the forced one');
    assert.deepEqual(calls.toasts, []);
  });

  test(`${page}: a forced attempt refused again is reported, never asked again`, async () => {
    const { ctx, calls } = harness(page);
    const s = sender([UNMERGED, UNMERGED]);
    let asked = 0;
    const ok = await ctx._taskDeleteRequest(TK, s.send, async () => { asked++; return true; });
    assert.equal(ok, false);
    assert.equal(asked, 1, 'the same question must not loop');
    assert.deepEqual(calls.toasts.map(t => t.msg), ['toast.errtask has unmerged or uncommitted changes']);
  });

  test(`${page}: another refusal or failure is reported with the server's message`, async () => {
    const { ctx, calls } = harness(page);
    const s = sender([{ status: 409, body: { code: 'NAME_TAKEN', error: 'nope' } },
                      { status: 500, body: { error: 'boom' } }]);
    assert.equal(await ctx._taskDeleteRequest(TK, s.send, async () => true), false);
    assert.equal(await ctx._taskDeleteRequest(TK, s.send, async () => true), false);
    assert.deepEqual(calls.toasts.map(t => t.msg), ['toast.errnope', 'toast.errboom']);
  });

  test(`${page}: an expired auth session is sent to the login page`, async () => {
    const { ctx, calls } = harness(page);
    const s = sender([{ status: 401 }]);
    assert.equal(await ctx._taskDeleteRequest(TK, s.send, async () => true), false);
    assert.equal(ctx.location.href, '/login');
    assert.deepEqual(calls.toasts, []);
  });
}

// Wiring: the helper is only worth anything if both delete buttons call it, and neither
// keeps a second, unguarded delete of its own.
test('both delete entry points go through the force-aware request', () => {
  for (const [page, fn] of [['kanban', 'confirmDelete'], ['schedule', 'deleteTask']]) {
    const body = lift(PAGES[page], fn);
    assert.match(body, /_taskDeleteRequest\(/, `${page}.${fn} must use it`);
    assert.doesNotMatch(body, /apiFetch\(`\/api\/tasks\//, `${page}.${fn} must not delete behind its back`);
    assert.match(body, /\?force=1/, `${page}.${fn} must be able to force the retry`);
  }
});

test('both dictionaries carry the question in every language', () => {
  for (const [page, src] of Object.entries(PAGES)) {
    const n = (src.match(/confirm\.unmerged':/g) || []).length;
    assert.equal(n, 5, `${page}: one entry per language (uk, en, ru, fr, he)`);
  }
});

test('all inline scripts of both pages still parse', () => {
  for (const [page, src] of Object.entries(PAGES)) {
    for (const [i, m] of [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
      new vm.Script(m[1], { filename: `${page}.html#script${i}` });
    }
  }
});
