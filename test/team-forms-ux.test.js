'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
function slice(start, end) { return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start))); }
const helpers = slice('const _teamPending = new Map();', 'function openBotForm(id)');
const saves = [
  ['bot', 'saveBot', '// Remove the bot'],
  ['cmd', 'saveCommand', 'async function rCommand'],
  ['agent', 'saveAgent', 'async function deleteAgent'],
  ['delegate', 'submitDelegation', 'function _renderDelegatePanel'],
];
function harness(prefix, fn, end) {
  const nodes = new Map(); let requests = [], resolve, reject, closed = 0;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', checked: false, disabled: false, dataset: {}, attrs: {}, textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      focus() { this.focused = true; }, closest() { return null; },
      querySelectorAll() { return []; }, querySelector() { return { dataset: { agentId: 'test-agent' }, focus() {} }; },
    });
    return nodes.get(id);
  }
  const control = node(prefix + 'SaveBtn');
  node(prefix + 'Modal').querySelectorAll = selector => selector === '[aria-invalid]' ? [] : [control];
  const context = vm.createContext({ Map, console, AbortController, setTimeout, clearTimeout, $i: node, t: key => key, _editingBotId: null, _editingCmdId: null, _editingAgentId: null,
    _externalAgents: {}, _agentUniqueId: () => 'test-agent', _parseAgentCatalog: x => x ? x.split(',') : [],
    curProjectId: 'p1', currentSessionId: 's1', activeTabId: 'tab1', config: { slashCommands: [] }, _activeDelegation: null, _dlgShownCount: 0,
    document: { querySelector: () => ({ value: 'sync' }) },
    fetch: (url, init) => { requests.push({ url, init }); return new Promise((a, b) => { resolve = a; reject = b; }); },
    toast() {}, loadBots: async () => {}, insertBotMention() {}, renderCommands() {}, renderAgents() {},
    cancelBotForm() { closed++; }, cancelCmdForm() { closed++; }, cancelAgentForm() { closed++; }, closeDelegateModal() { closed++; },
    _renderDelegatePanel() {}, _startDelegatePolling() {},
  });
  vm.runInContext(helpers + slice('async function ' + fn + '()', end), context);
  node('botLabel').value = 'Analyst'; node('botPrompt').value = 'Preserve this prompt';
  node('cmdName').value = 'review'; node('cmdText').value = 'Review code';
  node('agentLabel').value = 'Terminal only'; node('agentInteractive').value = 'cli';
  node('agentModels').value = 'model-a,model-b'; node('agentEfforts').value = 'low,high';
  node('agentResume').value = 'cli resume {sid}'; node('agentResumeLast').value = 'cli resume --last';
  node('agentNewIdFlag').value = '--id {sid}'; node('agentNewIdCommand').value = 'cli create';
  node('dlgTask').value = 'Do the work'; node('dlgModel').value = 'model-a'; node('dlgEffort').value = 'high';
  return { node, context, requests, run: () => context[fn](), resolve: x => resolve(x), reject: x => reject(x), closed: () => closed };
}
for (const [prefix, fn, end] of saves) {
  test(`${fn}: duplicate submission blocked, all controls restored after success`, async () => {
    const h = harness(prefix, fn, end); const pending = h.run();
    await h.run(); assert.equal(h.requests.length, 1);
    assert.equal(h.node(prefix + 'SaveBtn').disabled, true);
    assert.equal(h.node(prefix + 'Modal').attrs['aria-busy'], 'true');
    h.resolve({ ok: true, json: async () => ({ ok: true, id: 'new', delegationId: 'd1', agent: 'Test' }) });
    await pending;
    assert.equal(h.node(prefix + 'SaveBtn').disabled, false);
    assert.equal(h.node(prefix + 'Modal').attrs['aria-busy'], undefined);
    assert.equal(h.closed(), 1);
  });
  test(`${fn}: network failure keeps form open and retry is possible`, async () => {
    const h = harness(prefix, fn, end); const pending = h.run();
    h.reject(new Error('offline')); await pending;
    assert.equal(h.closed(), 0); assert.equal(h.node(prefix + 'SaveBtn').disabled, false);
    assert.equal(h.node(prefix + 'Feedback').textContent, 'team.network');
    assert.equal(h.node(prefix + 'Feedback').dataset.error, 'true');
    const retry = h.run(); assert.equal(h.requests.length, 2);
    h.resolve({ ok: false, status: 400, json: async () => ({ error: 'Server validation failed' }) }); await retry;
    assert.match(h.node(prefix + 'Feedback').textContent, /Server validation failed/);
    assert.equal(h.closed(), 0);
  });
}
test('agent terminal-only capability and every catalog/restore field survive submission', async () => {
  const h = harness(...saves[2]); const pending = h.run();
  const body = JSON.parse(h.requests[0].init.body);
  assert.equal(body.template, ''); assert.equal(body.interactive, 'cli');
  assert.deepEqual(body.models, ['model-a', 'model-b']); assert.deepEqual(body.efforts, ['low', 'high']);
  assert.equal(body.resume, 'cli resume {sid}'); assert.equal(body.resumeLast, 'cli resume --last');
  assert.equal(body.newIdFlag, '--id {sid}'); assert.equal(body.newIdCommand, 'cli create');
  h.resolve({ ok: true, json: async () => ({}) }); await pending;
});
test('delegation preserves mode, task, session, model and effort payload', async () => {
  const h = harness(...saves[3]); const pending = h.run();
  assert.deepEqual(JSON.parse(h.requests[0].init.body), { agentId: 'test-agent', mode: 'sync', task: 'Do the work', sessionId: 's1', model: 'model-a', effort: 'high' });
  h.resolve({ ok: true, json: async () => ({}) }); await pending;
});
test('invalid bot, command and agent input focuses the field before any request', async () => {
  for (const [index, field] of [[0, 'botLabel'], [1, 'cmdText'], [2, 'agentLabel']]) {
    const h = harness(...saves[index]); h.node(field).value = ''; await h.run();
    assert.equal(h.requests.length, 0); assert.equal(h.node(field).focused, true);
    assert.equal(h.node(field).attrs['aria-invalid'], 'true');
  }
});
test('optional sections keep core bot prompt and both agent capabilities outside disclosure', () => {
  const bot = slice('id="botModal"', 'id="agentModal"');
  assert.ok(bot.indexOf('id="botPrompt"') < bot.indexOf('<details'));
  assert.ok(bot.includes('id="botGlobal"')); assert.ok(bot.includes('id="botDeleteBtn"'));
  const agent = slice('id="agentModal"', '<!-- Confirm Stop Modal -->');
  assert.ok(agent.indexOf('id="agentTemplate"') < agent.indexOf('<details'));
  assert.ok(agent.indexOf('id="agentInteractive"') < agent.indexOf('<details'));
  for (const id of ['agentModels','agentEfforts','agentResume','agentResumeLast','agentNewIdFlag','agentNewIdCommand']) assert.ok(agent.includes(`id="${id}"`));
  assert.ok(agent.includes('May restore a different conversation.'));
});
test('delegation has native keyboard controls and catalog-based tuning remains intact', () => {
  const markup = slice('<!-- Delegate Modal -->', '<!-- Toast -->');
  for (const radio of markup.matchAll(/<input[^>]+name="dlgMode"[^>]+>/g)) assert.ok(!radio[0].includes('display:none'));
  const opener = slice('function openDelegateModal(', '/** Populate Model');
  assert.match(opener, /document.createElement\('button'\)/);
  assert.match(opener, /setAttribute\('aria-pressed', 'true'\)/);
  assert.match(opener, /generation !== _delegateLoadGeneration/);
  assert.match(opener, /if \(!keepTask\)/);
  assert.match(slice('function _dlgFillTuning(', 'function closeDelegateModal'), /tpl.includes/);
  assert.match(html, /#delegateModal \.dlg-mode-cards \{ grid-template-columns:1fr; \}/);
});
test('commands have keyboard-operable insertion and explicit empty state', () => {
  const renderer = slice('function renderCommands()', 'function openCmdForm');
  assert.match(renderer, /<button type="button" class="inf cmd-insert"/);
  assert.match(renderer, /team.command.empty/);
  assert.match(renderer, /querySelector\('\.cmd-insert'\).addEventListener\('click'/);
});
test('every inline script remains syntactically valid', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
test('failed bot load is not shown as an empty library and offers retry', async () => {
  let rendered = false;
  const context = vm.createContext({ $i: () => null, t: k => k, _bots: [], _botsById: {}, _botsLoadError: false,
    _switchGen: 1, curProjectId: null, _teamFetch: async () => ({ ok: false }), renderBots() { rendered = true; } });
  vm.runInContext(slice('async function loadBots()', 'function renderBots()'), context);
  await context.loadBots(); assert.equal(context._botsLoadError, true); assert.equal(rendered, true);
  assert.match(slice('function renderBots()', '// The shortest path'), /onclick="loadBots\(\)"/);
});
test('failed external agent load preserves last known configuration and reports failure', async () => {
  const agents = { existing: { interactive: 'cli', models: ['one'] } };
  const context = vm.createContext({ _externalAgents: agents, fetch: async () => ({ ok: false }) });
  vm.runInContext(slice('async function _loadExternalAgents()', '// Icons for the agents'), context);
  assert.equal(await context._loadExternalAgents(), false); assert.equal(context._externalAgents, agents);
});
test('command delete failure does not remove the existing command', async () => {
  let renders = 0;
  const context = vm.createContext({ config: { slashCommands: [{ id: 'one', name: '/test' }] }, confirm: () => true,
    t: k => k, toast() {}, fetch: async () => ({ ok: false, status: 500 }), renderCommands() { renders++; } });
  vm.runInContext(slice('async function rCommand(', "document.addEventListener('keydown'"), context);
  await context.rCommand('one'); assert.equal(context.config.slashCommands.length, 1); assert.equal(renders, 0);
});
test('hung save has bounded uncertain-outcome state and restores controls', async () => {
  const h = harness(...saves[0]); let timeout;
  h.context.setTimeout = callback => { timeout = callback; return 1; };
  h.context.clearTimeout = () => {};
  const pending = h.run(); assert.equal(h.node('botSaveBtn').disabled, true);
  timeout(); await pending;
  assert.equal(h.node('botSaveBtn').disabled, false);
  assert.equal(h.node('botFeedback').textContent, 'team.network');
  assert.equal(h.requests.length, 1); assert.equal(h.closed(), 0);
});
test('pending forms retain a safe dismissal path without losing in-flight edit identity', () => {
  for (const [prefix, fn, marker, editing] of [
    ['bot','cancelBotForm','async function saveBot','_editingBotId'],
    ['cmd','cancelCmdForm','function editCommand','_editingCmdId'],
    ['agent','cancelAgentForm','// Comma-separated','_editingAgentId'],
  ]) {
    let closed = 0;
    const context = vm.createContext({ _teamPending: new Map([[prefix, []]]), [editing]: 'existing', closeModalOverlay() { closed++; } });
    vm.runInContext(slice('function ' + fn + '()', marker), context);
    context[fn](); assert.equal(closed, 1); assert.equal(context[editing], 'existing');
  }
  const close = slice('function closeDelegateModal()', 'async function submitDelegation');
  assert.ok(!close.includes('_teamPending')); assert.match(close, /closeModalOverlay/);
  assert.match(helpers, /filter\(el => !\/\(\?:cancelBotForm/);
});
test('late bot and delegation successes never affect another project, session or tab', async () => {
  for (const changed of ['curProjectId', 'currentSessionId', 'activeTabId']) {
    for (const index of [0, 3]) {
      const h = harness(...saves[index]); let mentions = 0, panels = 0;
      h.context.insertBotMention = () => { mentions++; };
      h.context._renderDelegatePanel = () => { panels++; };
      const pending = h.run(); h.context[changed] = 'other';
      h.resolve({ ok: true, json: async () => ({ id: 'new', delegationId: 'd1', agent: 'Test' }) }); await pending;
      assert.equal(mentions, 0); assert.equal(panels, 0); assert.equal(h.context._activeDelegation, null);
      assert.equal(h.closed(), 1);
    }
  }
});
