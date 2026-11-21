// The external surface of issue #150: /api/external/v1 (token authenticated) and
// mcp-ccs.js (the stdio client an outside agent actually runs).
//
// This is the test that decides whether an outside MCP client can do what the
// issue asked for — list projects, create work in one, follow it, read the result
// — and, just as important, what it must NOT be able to do:
//
//   - no token, a stale token, or a browser Origin gets nothing;
//   - a `read` token cannot create or cancel (creating a task runs `claude`);
//   - `project` is required on create — no inherited workdir, no guessing;
//   - a card created without status lands in `backlog`, so nothing runs until the
//     caller asks for it. The one 'todo' task here carries a far-future
//     scheduled_at so the queue never selects it and no real claude is spawned;
//   - a revoked token is dead on the very next request, with no restart.
//
// The last block runs mcp-ccs.js as a real stdio MCP server against the same
// booted server, because a wrapper that is only tested through `fetch` proves
// nothing about the JSON-RPC loop the client will actually speak.
//
// Run: node test/external-api.test.js   (TEST_PORT=<n> to move off the default)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 4562);
const BASE = `http://127.0.0.1:${PORT}`;

const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-ext-api-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-ext-home-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
const WORKDIR = path.join(APP_DIR, 'workspace');
fs.mkdirSync(WORKDIR, { recursive: true });
fs.writeFileSync(path.join(APP_DIR, 'config.json'), JSON.stringify({ mcpServers: {}, skills: {} }, null, 2));
// Written directly: POST /api/projects would also git-init and notify, and this
// file only needs the registration that makes the workdir an allowed root.
fs.writeFileSync(path.join(APP_DIR, 'data', 'projects.json'), JSON.stringify([
  { id: 'proj-demo', name: 'Demo', workdir: WORKDIR, createdAt: new Date().toISOString() },
], null, 2));

let srvLog = '';
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR, HOME: HOME_DIR,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
child.on('exit', () => { exited = true; });
child.stdout.on('data', d => { srvLog += d; });
child.stderr.on('data', d => { srvLog += d; });

let cleanedUp = false;
function cleanup() { if (cleanedUp) return; cleanedUp = true; if (!exited) { try { child.kill('SIGTERM'); } catch {} } }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

async function call(method, url, { token, body, origin } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (origin) headers.origin = origin;
  const res = await fetch(BASE + url, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// A real stdio MCP client: newline JSON-RPC over the child's stdin/stdout.
function mcpClient(env) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'mcp-ccs.js')], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = new Map();
  let nextId = 1;
  proc.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  return {
    proc,
    call(method, params) {
      const id = nextId++;
      const p = new Promise((resolve) => waiters.set(id, resolve));
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return p;
    },
    text(msg) { return (msg.result?.content || []).map(c => c.text).join('\n'); },
    close() { try { proc.kill('SIGTERM'); } catch {} },
  };
}

const NEVER = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();

(async () => {
  let up = false;
  for (let i = 0; i < 120 && !exited; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (!up) die('server did not start');

  console.log('\n— a token is required, and a browser is not a client —');
  check('no token → 401', (await call('GET', '/api/external/v1/me')).status, 401);
  check('a random bearer → 401', (await call('GET', '/api/external/v1/me', { token: 'ccs_' + 'a'.repeat(48) })).status, 401);

  const readTok = await call('POST', '/api/api-tokens', { body: { name: 'monitor', scope: 'read' } });
  check('a read token is minted over the session API', readTok.status, 201);
  check('the response carries the plaintext once', /^ccs_[0-9a-f]{48}$/.test(readTok.json?.token || ''), true);
  const fullTok = await call('POST', '/api/api-tokens', { body: { name: 'runner', scope: 'full' } });
  check('a full token is minted too', fullTok.status, 201);
  const list = await call('GET', '/api/api-tokens');
  check('the list has both tokens', list.json?.length, 2);
  check('and never leaks the secret', JSON.stringify(list.json).includes(readTok.json.token), false);

  check('an Origin header is refused', (await call('GET', '/api/external/v1/me', { token: fullTok.json.token, origin: 'https://evil.example' })).status, 403);
  check('the read token opens /me', (await call('GET', '/api/external/v1/me', { token: readTok.json.token })).json?.scope, 'read');

  console.log('\n— a read token can look, not touch —');
  const projects = await call('GET', '/api/external/v1/projects', { token: readTok.json.token });
  check('projects are listed', projects.status, 200);
  check('with id, name and workdir', [projects.json[0].id, projects.json[0].name, projects.json[0].workdir], ['proj-demo', 'Demo', WORKDIR]);
  check('read cannot create', (await call('POST', '/api/external/v1/tasks', { token: readTok.json.token, body: { project: 'proj-demo', title: 'nope' } })).status, 403);
  check('read cannot cancel', (await call('POST', '/api/external/v1/tasks/whatever/cancel', { token: readTok.json.token, body: {} })).status, 403);

  console.log('\n— create needs an explicit, real project —');
  const T = fullTok.json.token;
  check('no project → 400', (await call('POST', '/api/external/v1/tasks', { token: T, body: { title: 'x' } })).status, 400);
  check('the refusal says project is required', /project is required/.test((await call('POST', '/api/external/v1/tasks', { token: T, body: { title: 'x' } })).json?.error || ''), true);
  check('unknown project → 404', (await call('POST', '/api/external/v1/tasks', { token: T, body: { project: 'proj-nope', title: 'x' } })).status, 404);
  check('an invalid status is refused', (await call('POST', '/api/external/v1/tasks', { token: T, body: { project: 'proj-demo', title: 'x', status: 'in_progress' } })).status, 400);

  console.log('\n— a card lands in backlog and stays there —');
  const created = await call('POST', '/api/external/v1/tasks', {
    token: T,
    body: { project: 'proj-demo', title: 'External card', description: 'written from outside' },
  });
  check('created 201', created.status, 201);
  check('default status is backlog', created.json?.status, 'backlog');
  check('the project is resolved, not inherited', [created.json?.project_id, created.json?.project_name], ['proj-demo', 'Demo']);
  const taskId = created.json?.id;
  check('an id came back', typeof taskId, 'string');

  const byName = await call('POST', '/api/external/v1/tasks', { token: T, body: { project: 'demo', title: 'By name' } });
  check('a project can be named instead of id-ed', byName.json?.project_id, 'proj-demo');

  const todo = await call('POST', '/api/external/v1/tasks', {
    token: T,
    body: { project: 'proj-demo', title: 'Later', status: 'todo', scheduled_at: NEVER },
  });
  check('todo is accepted', todo.json?.status, 'todo');
  check('and its schedule is stored in unix seconds', typeof todo.json?.scheduled_at, 'number');

  const listed = await call('GET', '/api/external/v1/tasks?project=proj-demo', { token: readTok.json.token });
  check('the project listing sees all three', listed.json?.length, 3);
  check('no description in the list payload', Object.prototype.hasOwnProperty.call(listed.json[0], 'description'), false);
  const filtered = await call('GET', '/api/external/v1/tasks?project=proj-demo&status=backlog', { token: readTok.json.token });
  check('status filters', filtered.json?.length, 2);
  check('an unknown project filter is a 404', (await call('GET', '/api/external/v1/tasks?project=nope', { token: readTok.json.token })).status, 404);

  const one = await call('GET', `/api/external/v1/tasks/${taskId}`, { token: readTok.json.token });
  check('get_task returns the description', one.json?.description, 'written from outside');
  check('get_task on an unknown id is a 404', (await call('GET', '/api/external/v1/tasks/nope', { token: readTok.json.token })).status, 404);
  const res1 = await call('GET', `/api/external/v1/tasks/${taskId}/result`, { token: readTok.json.token });
  check('a card with no run has no result', res1.json?.output, null);

  console.log('\n— cancel, and the done guard —');
  const cancelled = await call('POST', `/api/external/v1/tasks/${taskId}/cancel`, { token: T, body: { reason: 'test' } });
  check('cancel works', [cancelled.json?.ok, cancelled.json?.status], [true, 'cancelled']);
  check('cancelling again is idempotent', (await call('POST', `/api/external/v1/tasks/${taskId}/cancel`, { token: T, body: {} })).status, 200);
  await call('PUT', `/api/tasks/${byName.json.id}`, { body: { status: 'done' } });
  check('a completed task cannot be cancelled', (await call('POST', `/api/external/v1/tasks/${byName.json.id}/cancel`, { token: T, body: {} })).status, 400);

  console.log('\n— mcp-ccs.js speaks the protocol an MCP client speaks —');
  const mcp = mcpClient({ CCS_URL: BASE, CCS_TOKEN: T });
  const init = await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  check('initialize answers', init.result?.serverInfo?.name, 'ccs');
  const tools = await mcp.call('tools/list', {});
  check('six tools are exposed', tools.result?.tools?.length, 6);
  const ct = tools.result.tools.find(t => t.name === 'create_task');
  check('create_task requires project and title', ct.inputSchema.required, ['project', 'title']);
  const projText = mcp.text(await mcp.call('tools/call', { name: 'list_projects', arguments: {} }));
  check('list_projects reaches the server', projText.includes('Demo') && projText.includes('proj-demo'), true);
  const createdByMcp = mcp.text(await mcp.call('tools/call', { name: 'create_task', arguments: { project: 'proj-demo', title: 'From MCP' } }));
  check('create_task explains that nothing runs', createdByMcp.includes('backlog') && createdByMcp.includes('nothing runs'), true);
  const listByMcp = mcp.text(await mcp.call('tools/call', { name: 'list_tasks', arguments: { project: 'proj-demo', status: 'backlog' } }));
  check('list_tasks finds the new card', listByMcp.includes('From MCP'), true);
  const badResult = await mcp.call('tools/call', { name: 'get_task_result', arguments: { task_id: 'nope' } });
  check('a 404 surfaces as a tool error, not a crash', badResult.result?.isError, true);
  check('and says what went wrong', /task not found/.test(mcp.text(badResult)), true);
  mcp.close();

  const readMcp = mcpClient({ CCS_URL: BASE, CCS_TOKEN: readTok.json.token });
  await readMcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const readTry = await readMcp.call('tools/call', { name: 'create_task', arguments: { project: 'proj-demo', title: 'nope' } });
  check('a read token is refused through the MCP wrapper too', readTry.result?.isError, true);
  check('with the read-only hint', /read-only/.test(readMcp.text(readTry)), true);
  readMcp.close();

  const noTok = mcpClient({ CCS_URL: BASE, CCS_TOKEN: '' });
  await noTok.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const noTokTry = await noTok.call('tools/call', { name: 'list_projects', arguments: {} });
  check('a missing token is explained instead of silent', /CCS_TOKEN is not set/.test(noTok.text(noTokTry)), true);
  noTok.close();

  console.log('\n— revocation is immediate —');
  check('revoking the read token', (await call('DELETE', `/api/api-tokens/${readTok.json.id}`)).status, 200);
  check('the read token is dead', (await call('GET', '/api/external/v1/me', { token: readTok.json.token })).status, 401);
  check('the full token still works', (await call('GET', '/api/external/v1/me', { token: T })).status, 200);
  check('revoking an unknown id is a 404', (await call('DELETE', '/api/api-tokens/nope')).status, 404);

  cleanup();
  await sleep(200);
  console.log(`\nexternal-api: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); die('unexpected failure'); });
