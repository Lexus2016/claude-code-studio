'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Kanban Task Delegation (#109)');

const srvPath = path.join(__dirname, '..', 'server.js');
const srvSrc = fs.readFileSync(srvPath, 'utf8');

const kbPath = path.join(__dirname, '..', 'public', 'kanban.html');
const kbSrc = fs.readFileSync(kbPath, 'utf8');

check('server.js /api/delegate accepts taskId and custom workdir', () => {
  assert.ok(
    srvSrc.includes('const { agentId, mode, task, sessionId, model, effort, taskId, workdir: customWorkdir } = req.body;'),
    'missing taskId/customWorkdir destructuring in /api/delegate'
  );
  assert.ok(
    srvSrc.includes('const taskRow = taskId ? stmts.getTask.get(taskId) : null;'),
    'missing taskRow lookup for taskId'
  );
  assert.ok(
    srvSrc.includes('customWorkdir || taskRow?.workdir || session?.workdir || WORKDIR'),
    'missing workdir fallback hierarchy'
  );
});

check('server.js saves taskId in state and reports it in /api/delegate/status', () => {
  assert.ok(
    srvSrc.includes('taskId: delegation.taskId || null'),
    'saveDelegationState does not preserve taskId'
  );
  assert.ok(
    srvSrc.includes('taskId: d.taskId || null'),
    '/api/delegate/status does not include taskId'
  );
  assert.ok(
    srvSrc.includes('stmts.setTaskInProgress.run(taskId)'),
    'delegating a backlog/todo task does not set it in_progress'
  );
});

check('kanban.html contains delegate and delegation detail modals', () => {
  assert.ok(kbSrc.includes('id="delegateOv"'), 'missing #delegateOv modal in kanban.html');
  assert.ok(kbSrc.includes('id="delegationDetailOv"'), 'missing #delegationDetailOv modal in kanban.html');
  assert.ok(kbSrc.includes('id="dlgAgentCards"'), 'missing #dlgAgentCards in delegate modal');
  assert.ok(kbSrc.includes('id="dlgTask"'), 'missing #dlgTask in delegate modal');
  assert.ok(kbSrc.includes('id="dlgDetailBox"'), 'missing #dlgDetailBox in delegation detail modal');
});

check('kanban.html makeCard includes delegation badge and button', () => {
  assert.ok(/_activeDelegations\.find\([a-zA-Z]+=>[a-zA-Z]+\.taskId===tk\.id\)/.test(kbSrc), 'makeCard / kbDelBadge does not look up active delegation for task');
  assert.ok(kbSrc.includes('badge-purple'), 'makeCard does not apply badge-purple for delegated task');
  assert.ok(kbSrc.includes('openDelegateModalForTask'), 'makeCard card-actions lacks openDelegateModalForTask button');
});

check('kanban.html openEditModal includes delegation button in footer', () => {
  assert.ok(
    /openDelegateModalForTask\('\$\{id\}'\)/.test(kbSrc),
    'openEditModal footer lacks delegate button'
  );
});

check('kanban.html defines delegation lifecycle functions', () => {
  assert.ok(kbSrc.includes('async function openDelegateModalForTask(taskId)'), 'missing openDelegateModalForTask');
  assert.ok(kbSrc.includes('async function submitDelegation()'), 'missing submitDelegation');
  assert.ok(kbSrc.includes('async function openDelegationDetail(delegationId)'), 'missing openDelegationDetail');
  assert.ok(kbSrc.includes('async function stopActiveDelegation()'), 'missing stopActiveDelegation');
  assert.ok(kbSrc.includes('async function sendDelegationMsg()'), 'missing sendDelegationMsg');
});

check('server.js watchdog spares active delegated tasks from eviction', () => {
  const wdBlock = srvSrc.slice(srvSrc.indexOf('// Watchdog: detect tasks stuck'));
  assert.ok(wdBlock.includes('d.taskId === task.id'), 'watchdog does not check activeDelegations for taskId');
  assert.ok(wdBlock.includes('if (isDelegated)'), 'watchdog does not skip recovering delegated tasks');
});

check('server.js /api/delegate validates task status and blocks double delegation', () => {
  assert.ok(srvSrc.includes("taskRow.status === 'done' || taskRow.status === 'cancelled'"), 'missing done/cancelled task check');
  assert.ok(srvSrc.includes('Task is already being delegated to'), 'missing already-delegated task check');
});

check('server.js DELETE /api/delegate/:id reverts in_progress task to todo', () => {
  const delBlock = srvSrc.slice(srvSrc.indexOf("app.delete('/api/delegate/:id'"));
  assert.ok(delBlock.includes("status='todo'"), 'DELETE /api/delegate does not revert task status');
});

check('kanban.html delegation dialog viewer polls for updates and verifies response ok', () => {
  assert.ok(kbSrc.includes('_dlgDetailPollTimer = setInterval'), 'missing interval polling in openDelegationDetail');
  assert.ok(kbSrc.includes('clearInterval(_dlgDetailPollTimer)'), 'missing clearInterval in closeDelegationDetail');
  assert.ok(kbSrc.includes('if (!r.ok)'), 'missing r.ok check in delegation actions');
});

check('kanban.html debounces self-heal reconnect events', () => {
  assert.ok(kbSrc.includes('function triggerKbResync()'), 'missing triggerKbResync function');
  assert.ok(kbSrc.includes('now - _lastKbResync < 1500'), 'missing debounce timing check');
});

if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nAll kanban-delegation tests passed');
