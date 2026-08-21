// Integration test for the bots HTTP API. Starts a real server against a THROWAWAY
// data directory, so it never touches the developer's chats.db.
//
// Part of `npm test`, but it boots a server, so it takes a few seconds.
// Run standalone: node test/bots-api.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A fixed port is a hazard: if the developer's own studio is on it, this test
// spawns a child that dies with EADDRINUSE and then POSTs/DELETEs bots against
// the LIVE instance. So: overridable, probed before use, and the readiness check
// below insists the answer came from the child we spawned.
const PORT = parseInt(process.env.TEST_PORT || '', 10) || 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-botstest-'));
// Every early process.exit() below (port already in use, server never came up,
// no auth cookie) jumps past the rmSync at the bottom of the file and leaves a
// directory behind in /tmp on each run. An exit hook covers all of them.
process.on('exit', () => { for (const _d of [APP_DIR]) { try { fs.rmSync(_d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

const rmTemp = () => { try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {} };

function probePort(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    const done = busy => { try { s.destroy(); } catch {} resolve(busy); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

(async () => {
  if (await probePort(PORT)) {
    console.error(`port ${PORT} is already in use — refusing to run, because this test`);
    console.error('creates and deletes bots and would do it against whatever is listening.');
    console.error(`Set TEST_PORT to a free port to run it anyway.`);
    rmTemp(); process.exit(1);
  }

  // CCS_DESKTOP=1 bypasses auth; APP_DIR redirects data/ to the temp dir.
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR: APP_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '', exited = false;
  srv.on('exit', () => { exited = true; });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });

  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { srv.kill('SIGTERM'); } catch {} rmTemp(); };
  // 'exit' covers the normal and thrown-assertion paths but NOT a signal, which is
  // how a cancelled run would otherwise orphan the server and leak the temp dir.
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(); process.exit(1); });

  // Wait for the server to answer rather than sleeping a fixed amount.
  let up = false;
  for (let i = 0; i < 40; i++) {
    if (exited) break;
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (exited) {
    console.error(`server exited before it was ready — port collision or startup crash; log:\n` + log.slice(-1500));
    stop(); process.exit(1);
  }
  if (!up) {
    console.error('server did not start; log:\n' + log.slice(-1500));
    stop(); process.exit(1);
  }
  // /api/health is public, so a foreign instance answers it too. Only our own child
  // prints the startup banner with this port in it.
  if (!(/server started/.test(log) && new RegExp(`"port":\\s*"?${PORT}"?`).test(log))) {
    console.error(`something on port ${PORT} answers /api/health but our child never logged`);
    console.error('"server started" with that port — refusing to assert against a foreign instance.');
    console.error(log.slice(-1500));
    stop(); process.exit(1);
  }

  console.log('creating:');
  {
    const r = await api('POST', '/api/bots', { label: 'Крипто-аналітик', description: 'crypto', avatar: '📈' });
    check('a Cyrillic label yields a transliterated handle', r.json.id, 'krypto-analityk');
    check('the avatar round-trips', r.json.avatar, '📈');
    check('the engine defaults to claude', r.json.engine, 'claude');
  }
  check('a blank label is refused', (await api('POST', '/api/bots', { label: '   ' })).status, 400);
  check('another engine is refused', (await api('POST', '/api/bots', { label: 'X', engine: 'codex' })).status, 400);
  check('a duplicate label gets a distinct handle',
    (await api('POST', '/api/bots', { label: 'Крипто-аналітик' })).json.id, 'krypto-analityk-2');
  check('an explicit taken handle is a conflict',
    (await api('POST', '/api/bots', { id: 'krypto-analityk', label: 'Impostor' })).status, 409);
  check('an oversized system prompt is refused',
    (await api('POST', '/api/bots', { label: 'Long', systemPrompt: 'x'.repeat(8193) })).status, 400);
  check('a system prompt exactly at the cap is accepted',
    (await api('POST', '/api/bots', { label: 'AtCap', systemPrompt: 'x'.repeat(8192) })).status, 200);

  console.log('updating:');
  {
    const r = await api('PUT', '/api/bots/krypto-analityk', { label: 'Крипто-аналітик v2' });
    check('a partial update keeps the avatar', r.json.avatar, '📈');
    check('a partial update keeps the description', r.json.description, 'crypto');
    check('the label changes', r.json.label, 'Крипто-аналітик v2');
    check('the handle never changes', r.json.id, 'krypto-analityk');
  }
  check('an explicitly empty field is cleared',
    (await api('PUT', '/api/bots/krypto-analityk', { label: 'K', avatar: '' })).json.avatar, '');
  check('updating a missing bot is a 404',
    (await api('PUT', '/api/bots/nosuchbot', { label: 'X' })).status, 404);

  console.log('caps that truncate rather than refuse:');
  {
    const r = await api('POST', '/api/bots', { label: 'L'.repeat(200), description: 'd'.repeat(900) });
    check('the label is truncated to its cap', r.json.label.length, 100);
    check('the description is truncated to its cap', r.json.description.length, 500);
  }

  console.log('soft delete:');
  {
    const before = (await api('GET', '/api/bots')).json.length;
    check('deleting answers ok', (await api('DELETE', '/api/bots/krypto-analityk')).json.ok, true);
    const after = (await api('GET', '/api/bots')).json;
    check('the bot leaves the list', after.length, before - 1);
    check('and is not fetchable', after.some(b => b.id === 'krypto-analityk'), false);
    // The handle must stay reserved forever: messages.agent_id stores it, so a new bot
    // reusing it would appear to be the author of the old one's messages.
    check('its handle stays reserved',
      (await api('POST', '/api/bots', { id: 'krypto-analityk', label: 'Impostor' })).status, 409);
    check('deleting it twice is a 404', (await api('DELETE', '/api/bots/krypto-analityk')).status, 404);
  }

  console.log('per-project availability:');
  {
    const a = (await api('POST', '/api/bots', { label: 'Analyst A', projectId: 'proj-1' })).json.id;
    const b = (await api('POST', '/api/bots', { label: 'Philosopher B', projectId: 'proj-2' })).json.id;
    const inP1 = (await api('GET', '/api/bots?project=proj-1')).json.map(x => x.id);
    const inP2 = (await api('GET', '/api/bots?project=proj-2')).json.map(x => x.id);
    check('a bot created in a project is offered there', inP1.includes(a), true);
    check('and is not offered in another project', inP2.includes(a), false);
    check('the other project offers its own', inP2, [b]);
    check('the library holds both',
      (await api('GET', '/api/bots')).json.filter(x => x.id === a || x.id === b).length, 2);

    await api('POST', `/api/projects/proj-1/bots/${b}`);
    check('a bot can be added to another project',
      (await api('GET', '/api/bots?project=proj-1')).json.map(x => x.id).includes(b), true);
    await api('DELETE', `/api/projects/proj-1/bots/${b}`);
    check('and removed again',
      (await api('GET', '/api/bots?project=proj-1')).json.map(x => x.id).includes(b), false);
    check('removal does not delete the bot',
      (await api('GET', '/api/bots')).json.some(x => x.id === b), true);
    check('adding a missing bot to a project is a 404',
      (await api('POST', '/api/projects/proj-1/bots/nosuchbot')).status, 404);
  }

  stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
