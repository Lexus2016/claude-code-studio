'use strict';

// Real inline UI handlers, with small DOM/network doubles for recovery and polling.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
const kanban = fs.readFileSync(path.join(__dirname, '..', 'public', 'kanban.html'), 'utf8');
function lift(src, name) {
  let at = src.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `${name} must exist`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, `${name} must have a top-level closing brace`);
  return src.slice(at, end + 2);
}

function dashboardHarness() {
  const nodes = {
    '#loader': { style: {} }, '#loadError': { style: {}, innerHTML: '' },
    '#heroRow': { innerHTML: '' },
  };
  // Browser semantics: replacing the content container removes its descendants.
  let contentHTML = '<div id="heroRow"></div>';
  nodes['#content'] = {
    style: {},
    get innerHTML() { return contentHTML; },
    set innerHTML(value) { contentHTML = value; delete nodes['#heroRow']; },
  };
  const responses = [];
  const ctx = {
    $: id => nodes[id] || null, t: x => x,
    escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    fmtNum: String,
    fetch: async () => { const value = responses.shift(); if (value instanceof Error) throw value; return value; },
    renderHeatmap() {}, renderTools() {}, renderGauge() {}, renderModelDonut() {},
    renderAgentBars() {}, renderHourly() {}, renderTimeline() {},
  };
  vm.createContext(ctx);
  vm.runInContext(['loadData', 'render', 'renderHero'].map(name => lift(dashboard, name)).join('\n'), ctx);
  return { ctx, nodes, responses };
}

test('dashboard failure then successful Refresh preserves and repopulates the layout', async () => {
  const { ctx, nodes, responses } = dashboardHarness();
  responses.push({ ok: false, status: 503 });
  await ctx.loadData();
  assert.ok(nodes['#heroRow'], 'error reporting must not remove the dashboard children');
  assert.match(nodes['#loadError'].innerHTML, /HTTP 503/);
  responses.push({ ok: true, json: async () => ({ summary: {
    total_sessions: 2, total_tool_calls: 8, total_messages: 10, estimated_hours_saved: 1,
  } }) });
  await ctx.loadData();
  assert.match(nodes['#heroRow'].innerHTML, /hero-card/);
  assert.equal(nodes['#content'].style.display, '');
  assert.equal(nodes['#loadError'].style.display, 'none');
  assert.equal(nodes['#loader'].style.display, 'none');
});

test('dashboard error messages are escaped and the error target exists in the HTML', async () => {
  const { ctx, nodes, responses } = dashboardHarness();
  responses.push(new Error('<img src=x onerror=alert(1)>'));
  await ctx.loadData();
  assert.match(dashboard, /id="loadError"/);
  assert.match(nodes['#loadError'].innerHTML, /&lt;img/);
  assert.doesNotMatch(nodes['#loadError'].innerHTML, /<img/);
});

function boardHarness() {
  const calls = [];
  const nodes = { refreshBtn: {}, refreshTs: {}, refreshTs2: {} };
  let chainFails = false;
  const ctx = {
    $i: id => nodes[id], tasks: [{ id: 'task-old' }], sessions: [], chains: [],
    lastEtag: 'same', lastChainEtag: 'old|1', curWorkdir: '/projects/current',
    _activeDelegations: [], lang: 'en', UI_LOCALES: { en: 'en-GB' },
    console: { warn() {} }, toast() {}, t: x => x, renders: 0,
    renderBoard() { ctx.renders++; },
    fetchEtag: async () => 'same',
    fetchTasks: async () => { calls.push('tasks'); return [{ id: 'task-new' }]; },
    fetchSessions: async () => { calls.push('sessions'); return [{ id: 'session-new' }]; },
    apiFetch: async url => {
      calls.push(url);
      if (url === '/api/task-chains/etag') return { json: async () => ({ ts: 'new', n: 1 }) };
      if (url.startsWith('/api/task-chains?')) {
        if (chainFails) throw new Error('Temporary chain fetch failure');
        return { json: async () => [{ id: 'chain-new' }] };
      }
      if (url === '/api/delegate/status') return { json: async () => ({ delegations: [{ id: 'delegation-new' }] }) };
      throw new Error(`Unexpected URL: ${url}`);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(lift(kanban, 'refresh'), ctx);
  ctx.refresh.project = ctx.curWorkdir;
  ctx.refresh.chainProject = ctx.curWorkdir;
  return { ctx, calls, failChains(value) { chainFails = value; } };
}

test('unchanged task ETag does not block chain-only and delegation updates', async () => {
  const { ctx, calls } = boardHarness();
  await ctx.refresh(false);
  assert.equal(ctx.chains[0]?.id, 'chain-new');
  assert.equal(ctx._activeDelegations[0]?.id, 'delegation-new');
  assert.equal(ctx.lastChainEtag, 'new|1');
  assert.ok(!calls.includes('tasks'), 'unchanged tasks need not be re-fetched');
  assert.ok(!calls.includes('sessions'));
  assert.equal(ctx.renders, 1);
});

test('failed chain data loads do not consume the ETag needed to retry', async () => {
  const { ctx, failChains } = boardHarness();
  ctx.chains = [{ id: 'cached-chain' }];
  failChains(true);
  await ctx.refresh(true);
  assert.equal(ctx.chains[0]?.id, 'cached-chain', 'keep last-known data during a temporary failure');
  assert.equal(ctx.lastChainEtag, 'old|1');
  failChains(false);
  await ctx.refresh(false);
  assert.equal(ctx.chains[0]?.id, 'chain-new');
  assert.equal(ctx.lastChainEtag, 'new|1');
});

test('forced refresh still reloads tasks and sessions', async () => {
  const { ctx } = boardHarness();
  await ctx.refresh(true);
  assert.equal(ctx.tasks[0].id, 'task-new');
  assert.equal(ctx.sessions[0].id, 'session-new');
});

test('unchanged polling preserves the board DOM', async () => {
  const { ctx, calls } = boardHarness();
  ctx.lastChainEtag = 'new|1';
  ctx.chains = [{ id: 'chain-new' }];
  ctx._activeDelegations = [{ id: 'delegation-new' }];
  await ctx.refresh(false);
  assert.ok(calls.includes('/api/delegate/status'), 'independent sources are still checked');
  assert.equal(ctx.renders, 0, 'an unchanged poll must not replace cards or disrupt a drag');
});

test('a delegation-only change still renders when both ETags are unchanged', async () => {
  const { ctx } = boardHarness();
  ctx.lastChainEtag = 'new|1';
  ctx.chains = [{ id: 'chain-new' }];
  await ctx.refresh(false);
  assert.equal(ctx._activeDelegations[0]?.id, 'delegation-new');
  assert.equal(ctx.renders, 1);
});

async function saveKanbanTask({ taskWorkdir, currentProject, pickedProject }) {
  const calls = [];
  const task = { id: 'task-a', workdir: taskWorkdir, sort_order: 1000 };
  const fields = {
    fTitle: { value: 'Edited' }, fSession: { value: 'session-a' },
    fStatus: { value: 'backlog' }, fProject: { value: pickedProject || '' },
  };
  const ctx = {
    $i: id => fields[id] || null, tasks: [task], editingId: task.id, modalMode: 'edit',
    curWorkdir: currentProject, pendingAttachments: [],
    getSessCfg: () => ({ model: 'sonnet', mode: 'auto', agent: 'single', maxTurns: 30 }),
    buildRecurToken: () => null, kbEffectiveRecurrence: value => value, kbEffectiveStatus: value => value,
    apiFetch: async (url, options) => calls.push({ url, body: JSON.parse(options.body) }),
    toast() {}, t: x => x, closeModal() {}, async refresh() {},
  };
  vm.createContext(ctx);
  vm.runInContext(lift(kanban, 'saveTask'), ctx);
  await ctx.saveTask();
  assert.equal(calls.length, 1);
  return calls[0].body;
}

test('Kanban edits preserve the task worktree rather than the current project filter', async () => {
  const body = await saveKanbanTask({
    taskWorkdir: '/projects/current/.worktrees/task-a', currentProject: '/projects/current',
  });
  assert.equal(body.workdir, '/projects/current/.worktrees/task-a');
});

test('Kanban still lets the global-view picker assign a previously unassigned task', async () => {
  const body = await saveKanbanTask({ taskWorkdir: null, currentProject: null, pickedProject: '/projects/chosen' });
  assert.equal(body.workdir, '/projects/chosen');
});

test('all inline Dashboard and Kanban scripts parse', () => {
  for (const [filename, src] of [['dashboard', dashboard], ['kanban', kanban]]) {
    for (const [i, match] of [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
      new vm.Script(match[1], { filename: `${filename}.html#script${i}` });
    }
  }
});
