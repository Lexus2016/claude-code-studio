// Integration test for GET /api/tasks/running-sessions. Starts a real server against a
// THROWAWAY data directory, so it never touches the developer's chats.db.
//
// Regression guard: a plain web chat never writes a `tasks` row, so a DB-only query
// returned [] while a chat was mid-turn. subscribeAllTabs() feeds this endpoint into
// tab.generating, so background tabs silently lost their busy dot after a reload.
// The endpoint must union the DB with activeChatSessions + activeTasks.
//
// Run: node test/running-sessions.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-runsess-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-runsess-home-'));
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// A fake `claude` that just sleeps keeps the turn in flight deterministically and for
// free. findClaudeBin() probes $HOME/.local/bin/claude first and has no env override,
// so HOME is what we redirect.
const binDir = path.join(HOME_DIR, '.local', 'bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nsleep 60\n');
fs.chmodSync(path.join(binDir, 'claude'), 0o755);

// CCS_DESKTOP=1 bypasses auth; APP_DIR redirects data/ to the temp dir.
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR: APP_DIR, HOME: HOME_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });

function cleanup() {
  try { srv.kill('SIGTERM'); } catch {}
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

(async () => {
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (!up) { console.error('server did not start\n' + srvLog.slice(-2000)); cleanup(); process.exit(1); }

  console.log('running-sessions:');
  const created = await api('POST', '/api/sessions', { title: 'runsess', workdir: APP_DIR });
  const sid = created.json && created.json.id;
  check('session created', typeof sid, 'string');
  if (!sid) { console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

  const idle = await api('GET', '/api/tasks/running-sessions');
  check('idle session is not reported as running', (idle.json || []).includes(sid), false);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  }).catch(e => { console.error(e.message); cleanup(); process.exit(1); });
  ws.send(JSON.stringify({ type: 'chat', text: 'hi', tabId: sid, sessionId: sid, model: 'sonnet', mode: 'auto' }));

  // Wait for the turn to actually be in flight before asserting, rather than assuming a
  // fixed delay is enough on a loaded machine.
  let live = false;
  for (let i = 0; i < 40; i++) {
    const act = await api('GET', '/api/activity');
    if (((act.json && act.json.live) || []).some(x => x.session_id === sid)) { live = true; break; }
    await sleep(250);
  }
  check('chat turn is in flight (per /api/activity)', live, true);

  const running = await api('GET', '/api/tasks/running-sessions');
  check('in-flight plain chat IS reported by running-sessions', (running.json || []).includes(sid), true);
  check('running-sessions returns no duplicate ids',
    (running.json || []).length, new Set(running.json || []).size);

  try { ws.close(); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
