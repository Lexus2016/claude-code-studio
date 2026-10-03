// Session expiry goes through the same teardown as the delete buttons.
//
// SESSION_TTL_DAYS used to run a bare `DELETE FROM sessions`. Every expired
// session's git worktree (and its `ccs/session-*` branch) stayed on disk with no
// row left to own it, so data/worktrees grew without bound — first reported by a
// third-party Docker image that had to prune them in its entrypoint. Its
// queued_messages (no FK) came back at every boot too.
//
// This boots a REAL server twice against one APP_DIR. Boot 1 creates isolated
// sessions; between boots the test ages some of them in SQLite; boot 2 runs expiry
// at startup (runDatabaseMaintenance), and the test checks what is left on disk:
//   - a clean expired session: row, tree, branch and queued message all gone;
//   - an expired session with UNCOMMITTED work: kept, row and tree — nobody was
//     asked, so nothing is discarded;
//   - an expired session holding a Kanban card: session gone, card kept, unlinked;
//   - a fresh session: untouched;
//   - an orphan tree no row owns, older than an hour: removed; a fresh one: kept.
// Then the delete buttons are driven once each, because they now share the code.
//
// Run: node test/session-expiry.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = Number(process.env.TEST_PORT || 4553);
const BASE = `http://127.0.0.1:${PORT}`;

const APP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-expiry-app-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-expiry-home-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
fs.writeFileSync(path.join(APP_DIR, 'config.json'), JSON.stringify({ mcpServers: {}, skills: {} }));
const WORKDIR = path.join(APP_DIR, 'workspace');
const PROJ = path.join(WORKDIR, 'proj');
fs.mkdirSync(PROJ, { recursive: true });

const ID = ['-c', 'user.email=ci-test-noreply', '-c', 'user.name=Test'];
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-q'], PROJ);
fs.writeFileSync(path.join(PROJ, 'README.md'), 'x\n');
git(['add', '.'], PROJ);
git([...ID, 'commit', '-qm', 'init'], PROJ);
const branches = () => git(['branch', '--format=%(refname:short)'], PROJ).split('\n').filter(Boolean);

let child = null, srvLog = '';
function boot() {
  srvLog = '';
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR, HOME: HOME_DIR, SESSION_TTL_DAYS: '30' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.exited = false;
  child.on('exit', () => { child.exited = true; });
  child.stdout.on('data', d => { srvLog += d; });
  child.stderr.on('data', d => { srvLog += d; });
}
async function up() {
  for (let i = 0; i < 80 && !child.exited; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {}
    await sleep(250);
  }
  if (child.exited || !srvLog.includes('server started')) die(`server on ${PORT} did not start`);
}
async function stop() {
  if (!child || child.exited) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 40 && !child.exited; i++) await sleep(100);
  if (!child.exited) { child.kill('SIGKILL'); await sleep(200); }
}
process.on('exit', () => { if (child && !child.exited) try { child.kill('SIGKILL'); } catch {} });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); if (child) try { child.kill('SIGKILL'); } catch {} process.exit(1); }

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

(async () => {
  boot(); await up();
  if ((await api('POST', '/api/projects', { name: 'proj', workdir: PROJ })).status !== 200) die('could not register the project');
  const ids = {};
  for (const k of ['clean', 'dirty', 'card', 'fresh']) {
    const r = await api('POST', '/api/sessions', { title: k, workdir: PROJ });
    if (r.status !== 200 || !r.json?.id) die(`could not create session ${k}: ${r.text}`);
    ids[k] = r.json.id;
  }
  await stop();

  const db = new Database(path.join(APP_DIR, 'data', 'chats.db'));
  const tree = {};
  for (const [k, id] of Object.entries(ids)) tree[k] = db.prepare('SELECT workdir FROM sessions WHERE id=?').get(id).workdir;
  if (!Object.values(tree).every(d => d && fs.existsSync(d) && d.startsWith(path.join(APP_DIR, 'data', 'worktrees')))) {
    die(`sessions were not worktree-isolated: ${JSON.stringify(tree)}`);
  }
  const age = db.prepare(`UPDATE sessions SET updated_at=datetime('now','-40 days') WHERE id=?`);
  for (const k of ['clean', 'dirty', 'card']) age.run(ids[k]);
  db.prepare(`INSERT INTO queued_messages (session_id, payload) VALUES (?, ?)`).run(ids.clean, JSON.stringify({ type: 'chat', text: 'queued' }));
  db.prepare(`INSERT INTO tasks (id, title, status, session_id) VALUES ('card-1', 'a card', 'backlog', ?)`).run(ids.card);
  db.close();
  fs.writeFileSync(path.join(tree.dirty, 'work-in-progress.txt'), 'not committed\n');

  // Two trees no row owns, next to the sessions' own.
  const slugDir = path.dirname(tree.clean);
  const orphanOld = path.join(slugDir, 'session-orphan-old');
  const orphanNew = path.join(slugDir, 'session-orphan-new');
  git(['worktree', 'add', '-q', orphanOld, '-b', 'ccs/session-orphan-old'], PROJ);
  git(['worktree', 'add', '-q', orphanNew, '-b', 'ccs/session-orphan-new'], PROJ);
  const twoHoursAgo = (Date.now() - 2 * 3600 * 1000) / 1000;
  fs.utimesSync(orphanOld, twoHoursAgo, twoHoursAgo);

  boot(); await up();   // expiry runs at startup
  const db2 = new Database(path.join(APP_DIR, 'data', 'chats.db'), { readonly: true });
  const row = id => db2.prepare('SELECT id FROM sessions WHERE id=?').get(id) || null;

  console.log('\n— an expired clean session goes with everything it owned —');
  check('the session row is gone', row(ids.clean), null);
  check('its worktree is gone', fs.existsSync(tree.clean), false);
  check('its branch is gone', branches().includes(`ccs/session-${ids.clean}`), false);
  check('its queued message does not come back at boot',
    db2.prepare('SELECT COUNT(*) c FROM queued_messages WHERE session_id=?').get(ids.clean).c, 0);

  console.log('\n— expiry is unattended, so it discards nothing anyone would be asked about —');
  check('a session with uncommitted work keeps its row', !!row(ids.dirty), true);
  check('…and its worktree, with the work in it', fs.existsSync(path.join(tree.dirty, 'work-in-progress.txt')), true);
  check('a Kanban card outlives its expired chat', db2.prepare(`SELECT session_id FROM tasks WHERE id='card-1'`).get(), { session_id: null });
  check('…while that chat and its tree are gone', [row(ids.card), fs.existsSync(tree.card)], [null, false]);
  check('a fresh session is untouched', [!!row(ids.fresh), fs.existsSync(tree.fresh)], [true, true]);

  console.log('\n— trees leaked by earlier versions are reconciled —');
  check('an orphan older than an hour is removed', fs.existsSync(orphanOld), false);
  check('…through git, branch included', branches().includes('ccs/session-orphan-old'), false);
  check('a fresh orphan is kept (its row may be a moment away)', fs.existsSync(orphanNew), true);
  db2.close();

  console.log('\n— the delete buttons share that teardown —');
  check('DELETE refuses a session with uncommitted work', (await api('DELETE', `/api/sessions/${ids.dirty}`)).status, 409);
  check('DELETE removes a clean one', (await api('DELETE', `/api/sessions/${ids.fresh}`)).status, 200);
  check('…and its worktree', fs.existsSync(tree.fresh), false);
  check('bulk delete with force removes the dirty one',
    (await api('POST', '/api/sessions/bulk-delete', { ids: [ids.dirty], force: true })).json?.ok, true);
  check('…and its worktree', fs.existsSync(tree.dirty), false);

  await stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => die(e.stack || String(e)));
