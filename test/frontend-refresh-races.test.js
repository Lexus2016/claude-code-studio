'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
function lift(file, name) {
  const src = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
  let start = src.indexOf(`function ${name}(`); if (src.slice(start - 6, start) === 'async ') start -= 6;
  return src.slice(start, src.indexOf('\n}', start) + 2);
}
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function schedule() {
  const waits = [], nodes = { schStatusEl: {}, refreshTs: {} };
  const ctx = { curWorkdir:'A', tasks:[], sessions:[], chains:[], renders:0, errors:[],
    $i:id=>nodes[id], t:key=>key==='locale'?'en-GB':key, toast:e=>ctx.errors.push(e),
    render(){ctx.renders++;}, fetchTasks(){const d=deferred();waits.push(d);return d.promise;},
    fetchSessions:async()=>[], fetchChains:async()=>[] };
  vm.createContext(ctx);vm.runInContext(lift('schedule.html','refresh'),ctx);return {ctx,waits,nodes};
}
test('Schedule ignores a delayed project A result after project B is selected and loaded', async () => {
  const {ctx,waits}=schedule();const old=ctx.refresh();ctx.curWorkdir='B';const latest=ctx.refresh();
  waits[1].resolve([{id:'B'}]);await latest;waits[0].resolve([{id:'A'}]);await old;
  assert.equal(ctx.tasks[0].id,'B');assert.equal(ctx.renders,1);
});
test('Schedule ignores older same-project failures without replacing a successful status', async () => {
  const {ctx,waits,nodes}=schedule();const old=ctx.refresh();const latest=ctx.refresh();
  waits[1].resolve([{id:'new'}]);await latest;waits[0].reject(new Error('old failure'));await old;
  assert.equal(ctx.tasks[0].id,'new');assert.equal(nodes.schStatusEl.className,'status-dot ok');assert.equal(ctx.errors.length,0);
});
function board(block) {
  const wait=deferred(), nodes={refreshBtn:{},refreshTs:{},refreshTs2:{}};
  const ctx={curWorkdir:'A',tasks:[],sessions:[],chains:[],_activeDelegations:[],lastEtag:'',lastChainEtag:'',renders:0,errors:[],
    $i:id=>nodes[id],lang:'en',UI_LOCALES:{en:'en-GB'},t:x=>x,console:{warn(){}},toast:e=>ctx.errors.push(e),renderBoard(){ctx.renders++;},
    fetchEtag:async()=>ctx.curWorkdir+'-etag',
    fetchTasks(){const project=ctx.curWorkdir;return project==='A'&&block==='tasks'?wait.promise:Promise.resolve([{id:project}]);},
    fetchSessions:async()=>[],
    async apiFetch(url){const project=ctx.curWorkdir;
      if(url==='/api/task-chains/etag')return {json:async()=>({ts:project,n:1})};
      if(url.startsWith('/api/task-chains?'))return {json:()=>project==='A'&&block==='chains'?wait.promise:Promise.resolve([{id:project}])};
      if(url==='/api/delegate/status')return {json:()=>project==='A'&&block==='delegations'?wait.promise:Promise.resolve({delegations:[{id:project}]})};
      throw new Error(url);
    }
  };
  vm.createContext(ctx);vm.runInContext(lift('kanban.html','refresh'),ctx);return {ctx,wait,nodes};
}
for(const stage of ['tasks','chains','delegations'])test(`Kanban rejects stale project data at the ${stage} await boundary`,async()=>{
  const {ctx,wait}=board(stage);const old=ctx.refresh(true);await tick();ctx.curWorkdir='B';await ctx.refresh(true);
  wait.resolve(stage==='delegations'?{delegations:[{id:'A'}]}:[{id:'A'}]);await old;
  assert.equal(ctx.tasks[0].id,'B');assert.equal(ctx.chains[0].id,'B');assert.equal(ctx._activeDelegations[0].id,'B');assert.equal(ctx.lastEtag,'B-etag');assert.equal(ctx.lastChainEtag,'B|1');assert.equal(ctx.renders,1);
});
test('an older Kanban failure cannot stop a newer loading spinner or emit an obsolete error',async()=>{
  const {ctx,wait,nodes}=board('tasks');const old=ctx.refresh(true);await tick();
  const newest=deferred();ctx.curWorkdir='B';ctx.fetchTasks=()=>newest.promise;const next=ctx.refresh(true);await tick();
  wait.reject(new Error('obsolete'));await old;assert.match(nodes.refreshBtn.innerHTML,/spinning/);assert.equal(ctx.errors.length,0);
  newest.resolve([{id:'B'}]);await next;assert.equal(nodes.refreshBtn.innerHTML,'&#8635;');
});
test('Dashboard ignores an older failure after a newer request renders successfully',async()=>{
  const waits=[],nodes={'#loader':{style:{}},'#content':{style:{}},'#loadError':{style:{},innerHTML:''}};
  const ctx={$:id=>nodes[id],fetch(){const d=deferred();waits.push(d);return d.promise;},render(d){ctx.value=d;},t:x=>x,escHtml:String};
  vm.createContext(ctx);vm.runInContext(lift('dashboard.html','loadData'),ctx);const old=ctx.loadData();const next=ctx.loadData();
  waits[1].resolve({ok:true,json:async()=>({id:'new'})});await next;waits[0].reject(new Error('obsolete'));await old;
  assert.equal(ctx.value.id,'new');assert.equal(nodes['#loadError'].style.display,'none');assert.equal(nodes['#content'].style.display,'');
});
test('Kanban polling cannot reuse a different project cache while a forced switch is in flight',async()=>{
  const {ctx}=board('none');await ctx.refresh(true);
  const oldWait=deferred();let calls=0;ctx.curWorkdir='B';ctx.fetchEtag=async()=>'A-etag';
  ctx.fetchTasks=()=>++calls===1?oldWait.promise:Promise.resolve([{id:'B'}]);
  const forced=ctx.refresh(true);await tick();await ctx.refresh(false);
  assert.equal(calls,2,'same global ETag must not reuse project A tasks for project B');
  assert.equal(ctx.tasks[0].id,'B');assert.equal(ctx.refresh.project,'B');
  oldWait.resolve([{id:'stale forced B'}]);await forced;assert.equal(ctx.tasks[0].id,'B');
});
