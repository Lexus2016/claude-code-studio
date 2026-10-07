'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openDatabase = require('../db-adapter');
const installRevisionTracking = require('../db-revisions');
const { test } = require('node:test');
function database(file = ':memory:') {
  const db = openDatabase(file);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS task_chains (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT);`);
  return db;
}
test('same-second updates and delete/insert with unchanged count invalidate task ETags', () => {
  const db = database();
  try {
    db.exec("INSERT INTO tasks VALUES ('a','todo','2026-01-01 00:00:00')");
    const rev = installRevisionTracking(db);
    const before = rev.tasks.get();
    db.exec("UPDATE tasks SET status='done' WHERE id='a'");
    const after = rev.tasks.get();
    assert.equal(before.n, after.n); assert.notEqual(before.ts, after.ts);
    assert.equal(db.prepare('SELECT updated_at FROM tasks').get().updated_at, '2026-01-01 00:00:00');
    db.exec("DELETE FROM tasks WHERE id='a'; INSERT INTO tasks VALUES ('b','todo','2026-01-01 00:00:00')");
    assert.equal(rev.tasks.get().n, after.n); assert.notEqual(rev.tasks.get().ts, after.ts);
  } finally { db.close(); }
});
test('chain mutations have independent revisions and rollback restores both data and revision', () => {
  const db = database();
  try {
    const rev = installRevisionTracking(db), tasks = rev.tasks.get().ts, before = rev.task_chains.get().ts;
    db.exec("INSERT INTO task_chains VALUES ('a','first','2026-01-01 00:00:00')");
    assert.notEqual(rev.task_chains.get().ts, before); assert.equal(rev.tasks.get().ts, tasks);
    const after = rev.task_chains.get().ts;
    db.exec('BEGIN'); db.exec("UPDATE task_chains SET title='second' WHERE id='a'");
    assert.notEqual(rev.task_chains.get().ts, after); db.exec('ROLLBACK');
    assert.equal(rev.task_chains.get().ts, after);
    db.exec("DELETE FROM task_chains WHERE id='a'"); assert.notEqual(rev.task_chains.get().ts, after);
  } finally { db.close(); }
});
test('revision installation is idempotent, persists across restart, and distinguishes new databases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-revisions-'));
  try {
    let db = database(path.join(dir, 'db.sqlite')); let rev = installRevisionTracking(db);
    db.exec("INSERT INTO tasks VALUES ('a','todo','fixed')");const original = rev.tasks.get().ts;
    assert.equal(installRevisionTracking(db).tasks.get().ts, original); db.close();
    db = database(path.join(dir, 'db.sqlite')); rev = installRevisionTracking(db);
    assert.equal(rev.tasks.get().ts, original);
    db.exec("UPDATE tasks SET status='done' WHERE id='a'");assert.notEqual(rev.tasks.get().ts, original);db.close();
    const other = database();try { assert.notEqual(installRevisionTracking(other).tasks.get().ts, original); } finally { other.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('server task and chain polling uses the persistent revision statements', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /const dataRevisions = installRevisionTracking\(db\)/);
  assert.match(source, /getTasksEtag: dataRevisions\.tasks/);
  assert.match(source, /getChainsEtag: dataRevisions\.task_chains/);
  assert.match(source, /ts: \[ce\.ts, te\.ts\]\.join\('\|'\)/);
});
test('real HTTP task and chain ETags change for rapid edits and deletes', { timeout: 20000 }, async () => {
  const net = require('node:net');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-revision-api-'));
  const socket = net.createServer();
  await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({mcpServers:{},skills:{}}));
  const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,APP_DIR:dir,HOME:dir,WORKDIR:dir,PORT:String(port),CCS_DESKTOP:'1'},stdio:['ignore','pipe','pipe']});
  let log='',exited=false;child.on('exit',()=>{exited=true;});
  child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const api=async(method,url,body)=>{
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    assert.ok(response.ok,`${method} ${url}: ${response.status}`);return response.json();
  };
  try{
    for(let i=0;i<100&&!log.includes('server started')&&!exited;i++)await pause(50);
    assert.ok(!exited&&log.includes('server started'),log);
    const task=await api('POST','/api/tasks',{title:'revision test',status:'backlog'});
    const before=await api('GET','/api/tasks/etag');const chainsBefore=await api('GET','/api/task-chains/etag');
    await api('PUT',`/api/tasks/${task.id}`,{title:'rapid edit 1'});
    const first=await api('GET','/api/tasks/etag');assert.notEqual(first.ts,before.ts);assert.equal(first.n,before.n);
    await api('PUT',`/api/tasks/${task.id}`,{title:'rapid edit 2'});
    assert.notEqual((await api('GET','/api/tasks/etag')).ts,first.ts);
    assert.notEqual((await api('GET','/api/task-chains/etag')).ts,chainsBefore.ts);
    await api('DELETE',`/api/tasks/${task.id}`);assert.equal((await api('GET','/api/tasks/etag')).n,before.n-1);
    const chain=await api('POST','/api/task-chains',{title:'revision chain'});
    const chainBefore=await api('GET','/api/task-chains/etag');
    await api('PUT',`/api/task-chains/${chain.id}`,{title:'changed chain'});
    assert.notEqual((await api('GET','/api/task-chains/etag')).ts,chainBefore.ts);
  }finally{
    child.kill('SIGTERM');for(let i=0;i<50&&!exited;i++)await pause(50);
    if(!exited){child.kill('SIGKILL');await pause(100);}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
