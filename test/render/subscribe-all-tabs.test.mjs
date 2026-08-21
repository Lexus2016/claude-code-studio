import assert from 'node:assert';
import { loadFn } from './_load.mjs';

// Regression: one failed /api/tasks/running-sessions fetch used to cancel every
// background subscription. The express error handler (server.js) answers with JSON
// `{error:'internal_error'}` (500) or `{error:'unauthorized'}` (401) — `.json()`
// resolves fine, but `new Set(<plain object>)` throws TypeError: object is not
// iterable, which the outer catch swallowed *before* the subscribe loop ran.

const subscribeAllTabs = loadFn('subscribeAllTabs');

// Fixed tab layout: 2 tabs in the current project, 1 in a background project.
function setup(fetchImpl) {
  const sent = [];
  globalThis._subscribingAllTabs = false;
  globalThis.fetch = fetchImpl;
  globalThis.curProjectId = 'p1';
  globalThis.openTabs = [{ id: 's1' }, { id: 's2' }];
  globalThis.projectTabs = { p1: globalThis.openTabs, p2: [{ id: 's3' }] };
  globalThis.ws = { readyState: 1, send: m => sent.push(JSON.parse(m)) };
  globalThis.renderTabs = () => { rendered.tabs = true; };
  globalThis.renderProjects = () => { rendered.projs = true; };
  const rendered = { tabs: false, projs: false };
  return { sent, rendered };
}

const subscribed = s => s.filter(m => m.type === 'subscribe_session').map(m => m.sessionId).sort();

// 1. Happy path — array response still drives the spinners.
{
  const { sent, rendered } = setup(async () => ({ json: async () => ['s1', 's3'] }));
  await subscribeAllTabs();
  assert.deepStrictEqual(subscribed(sent), ['s1', 's2', 's3'], 'ok: every tab subscribed');
  assert.strictEqual(globalThis.openTabs[0].generating, true, 'ok: current-project spinner set');
  assert.strictEqual(globalThis.projectTabs.p2[0].generating, true, 'ok: background-project spinner set');
  assert.ok(rendered.tabs && rendered.projs, 'ok: both renderers called');
}

// 2. HTTP 500 — error JSON is an object, not an array. Must not abort the loop.
{
  const { sent } = setup(async () => ({ json: async () => ({ error: 'internal_error' }) }));
  await subscribeAllTabs();
  assert.deepStrictEqual(subscribed(sent), ['s1', 's2', 's3'], '500: every tab still subscribed');
}

// 3. HTTP 401 (expired token) — same shape, same requirement.
{
  const { sent } = setup(async () => ({ json: async () => ({ error: 'unauthorized' }) }));
  await subscribeAllTabs();
  assert.deepStrictEqual(subscribed(sent), ['s1', 's2', 's3'], '401: every tab still subscribed');
}

// 4. Network blip — fetch itself rejects.
{
  const { sent } = setup(async () => { throw new TypeError('Failed to fetch'); });
  await subscribeAllTabs();
  assert.deepStrictEqual(subscribed(sent), ['s1', 's2', 's3'], 'offline: every tab still subscribed');
}

// 5. Non-JSON body (HTML 500 from a proxy) — .json() rejects.
{
  const { sent } = setup(async () => ({ json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  await subscribeAllTabs();
  assert.deepStrictEqual(subscribed(sent), ['s1', 's2', 's3'], 'bad body: every tab still subscribed');
}

// 6. The re-entrancy guard must be released even after a failure.
assert.strictEqual(globalThis._subscribingAllTabs, false, 'guard released');

console.log('PASS subscribe-all-tabs');
