// Cleaning up finished tasks (#160) — end to end.
//
// The board's rule: a bulk purge removes only cards whose worktree holds nothing
// to lose. A finished card that still owns unmerged commits comes back for review
// and keeps its row, its tree and its branch, so it can be merged (the change is
// wanted) or force-deleted (it is not) — one card at a time.
//
// This boots a REAL server against a throwaway APP_DIR and a real project repo:
//   - one finished card with nothing to lose: row, tree and branch all go;
//   - one cancelled card with an unmerged commit: returned in `review`, kept;
//   - one running card: not a candidate, and its merge door refuses;
// then it merges the reviewed card through the new merge door and deletes it.
//
// Run: node test/task-purge-e2e.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const openDatabase = require('../db-adapter');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = Number(process.env.TEST_PORT || 4557);
const BASE = `http://127.0.0.1:${PORT}`;

const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-purge-app-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-purge-home-'));
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
const defaultBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], PROJ);

let child = null, srvLog = '';
function boot() {
  srvLog = '';
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR, HOME: HOME_DIR },
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
const branchExists = b => git(['branch', '--format=%(refname:short)'], PROJ).split('\n').filter(Boolean).includes(b);

(async () => {
  boot(); await up();
  if ((await api('POST', '/api/projects', { name: 'proj', workdir: PROJ })).status !== 200) die('could not register the project');
  // `live` starts as backlog: the server retires stranded in_progress cards at boot,
  // so a card is put back into the running column only once the server is up.
  const ids = {};
  for (const [key, status] of [['clean', 'done'], ['dirty', 'cancelled'], ['live', 'backlog']]) {
    const r = await api('POST', '/api/tasks', { title: key, status, workdir: PROJ });
    if (r.status !== 200 || !r.json?.id) die(`could not create task ${key}: ${r.text}`);
    ids[key] = r.json.id;
  }
  await stop();

  const db = openDatabase(path.join(APP_DIR, 'data', 'chats.db'));
  const rowOf = (handle, id) => handle.prepare('SELECT id, status, workdir, git_root, git_branch FROM tasks WHERE id=?').get(id) || null;
  const t = { clean: rowOf(db, ids.clean), dirty: rowOf(db, ids.dirty), live: rowOf(db, ids.live) };
  db.close();
  if (![t.clean, t.dirty, t.live].every(x => x && x.git_root && x.workdir && x.git_branch)) {
    die(`tasks were not worktree-isolated: ${JSON.stringify(t)}`);
  }

  // Real work in the cancelled card's tree: one commit on its own branch, never merged.
  fs.writeFileSync(path.join(t.dirty.workdir, 'feature.txt'), 'unmerged work\n');
  git(['add', 'feature.txt'], t.dirty.workdir);
  git([...ID, 'commit', '-qm', 'the unmerged change'], t.dirty.workdir);

  boot(); await up();
  const live = await api('PUT', `/api/tasks/${ids.live}`, { ...(await api('GET', '/api/tasks?workdir=' + encodeURIComponent(PROJ))).json.find(x => x.id === ids.live), status: 'in_progress' });
  check('the running card is in the running column', live.status, 200);
  const db2 = openDatabase(path.join(APP_DIR, 'data', 'chats.db'));
  const row = id => rowOf(db2, id);

  console.log('\n— the bulk purge removes only what has nothing to lose —');
  const purge = await api('POST', '/api/tasks/purge', { workdir: PROJ });
  if (purge.status !== 200) die(`purge failed: ${purge.text}`);
  check('one card removed, the one with nothing to lose', purge.json.deleted, 1);
  check('the reviewed card is the one holding work', purge.json.review.map(r => [r.id, r.reason]), [[ids.dirty, 'unmerged']]);
  check('the review names the branch so the work can be found', purge.json.review[0].branch, t.dirty.git_branch);
  check('the clean card is gone', row(ids.clean), null);
  check('its worktree is gone with it', fs.existsSync(t.clean.workdir), false);
  check('its branch is gone too', branchExists(t.clean.git_branch), false);
  check('the card holding work keeps its row', !!row(ids.dirty), true);
  check('… its worktree', fs.existsSync(path.join(t.dirty.workdir, 'feature.txt')), true);
  check('… and its branch', branchExists(t.dirty.git_branch), true);
  check('a running card is not a purge candidate', !!row(ids.live), true);

  console.log('\n— the reviewed card is merged, then removed —');
  const conflict = await api('POST', `/api/tasks/${ids.live}/git-merge`);
  check('a running card refuses to merge', conflict.status, 409);
  check('… naming the reason', conflict.json.code, 'TASK_RUNNING');
  const before = await api('GET', `/api/tasks/${ids.dirty}/git-status`);
  check('the card reports unmerged work before the merge', before.json.unmerged, true);
  const merge = await api('POST', `/api/tasks/${ids.dirty}/git-merge`);
  check('the merge succeeds', [merge.status, merge.json.ok], [200, true]);
  const after = await api('GET', `/api/tasks/${ids.dirty}/git-status`);
  check('nothing is left unmerged', after.json.unmerged, false);
  check('the commit is on the default branch', git(['log', '--format=%s', defaultBranch], PROJ).includes('the unmerged change'), true);
  const del = await api('DELETE', `/api/tasks/${ids.dirty}`);
  check('the ordinary delete now works without force', del.status, 200);
  check('the card is gone', row(ids.dirty), null);
  check('its tree is gone', fs.existsSync(t.dirty.workdir), false);
  check('the merged branch was cleaned up', branchExists(t.dirty.git_branch), false);
  check('the running card is still there', !!row(ids.live), true);
  db2.close();

  await stop();
  check('the work survived the cleanup as history, not as a stray branch', git(['log', '--format=%s', defaultBranch], PROJ).includes('the unmerged change'), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => die(e.stack || e.message));
