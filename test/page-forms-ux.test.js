'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', `${name}.html`), 'utf8');
const pages = Object.fromEntries(['auth','kanban','schedule','dashboard'].map(name => [name, read(name)]));
function lift(src, name) {
  const at = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, name);
  return src.slice(at, src.indexOf('\n}', at) + 2);
}
function element(value='') {
  return {value,style:{},dataset:{},textContent:'',hidden:false,disabled:false,attributes:{},
    focus(){this.focused=true;},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];}};
}
for (const [name, html] of Object.entries(pages)) {
  test(`${name}: all inline scripts parse`, () => {
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
  });
}
function authHarness(fetch) {
  const fields={};
  const document={getElementById:id => fields[id] ||= element()};
  const ctx=vm.createContext({document,fetch,AbortController,window:{location:{}},setTimeout:()=>123,clearTimeout(){}});
  vm.runInContext(['checkStatus','setAuthBusy','doSetup','doLogin'].map(name=>lift(pages.auth,name)).join('\n'),ctx);
  return {ctx,fields,document};
}
test('auth: status failure exposes a retry, and retry recovers to login with focus',async()=>{
  let fail=true;
  const {ctx,fields}=authHarness(async()=>{if(fail)throw Error('offline');return {ok:true,json:async()=>({setupDone:true})};});
  await ctx.checkStatus();
  assert.equal(fields.statusRetry.hidden,false);
  assert.equal(fields.statusError.hidden,false);
  assert.match(fields.statusError.textContent,/server/);
  fail=false;await ctx.checkStatus();
  assert.equal(fields.statusRetry.hidden,true);
  assert.equal(fields.statusError.hidden,true);
  assert.equal(fields.loginForm.style.display,'block');
  assert.equal(fields.loginPass.focused,true);
});
test('auth: setup preserves server-code requirement and mismatch makes no network request',async()=>{
  let requests=0;
  const {ctx,fields,document}=authHarness(async()=>{requests++;return {ok:true,json:async()=>({setupDone:false,setupCodeRequired:true})};});
  await ctx.checkStatus();
  assert.equal(fields.setupCodeField.style.display,'block');
  document.getElementById('setupPass').value='password-a';
  document.getElementById('setupPass2').value='password-b';
  await ctx.doSetup({preventDefault(){}});
  assert.equal(requests,1);
  assert.equal(fields.setupPass2.attributes['aria-invalid'],'true');
  assert.equal(fields.setupPass2.focused,true);
});
test('auth: login has visible busy state, rejects duplicate submit and restores retry after failure',async()=>{
  let reject,requests=0;
  const {ctx,fields,document}=authHarness(()=>{requests++;return new Promise((resolve,r)=>{reject=r;});});
  document.getElementById('loginBtn').textContent='Sign in';
  document.getElementById('loginPass').value='unchanged-password';
  const pending=ctx.doLogin({preventDefault(){}});
  assert.equal(fields.loginBtn.disabled,true);
  assert.equal(fields.loginBtn.textContent,'Signing in...');
  await ctx.doLogin({preventDefault(){}});assert.equal(requests,1);
  reject(Error('offline'));await pending;
  assert.equal(fields.loginBtn.disabled,false);
  assert.equal(fields.loginBtn.textContent,'Sign in');
  assert.equal(fields.loginPass.value,'unchanged-password');
  assert.equal(fields.loginForm.attributes['aria-busy'],'false');
});
test('auth: named controls and announced errors preserve password requirements',()=>{
  for(const id of ['setupName','setupPass','setupPass2','setupCode','loginPass']) assert.match(pages.auth,new RegExp(`for="${id}"`));
  assert.match(pages.auth,/id="setupError" role="alert"/);
  assert.match(pages.auth,/id="loginError" role="alert"/);
  assert.equal((pages.auth.match(/minlength="8"/g)||[]).length,2);
  assert.match(pages.auth,/15000/);
});
for(const name of ['kanban','schedule']){
  test(`${name}: title, recurrence, descriptions and execution fields have connected labels`,()=>{
    for(const id of ['fTitle','fRecurUnit','fScheduledAt','fEndDate','fDesc','fSession','fMaxTurns','fEffort']) assert.match(pages[name],new RegExp(`for="${id}"`));
    assert.match(pages[name],/aria-describedby="fScheduledAtHint"/);
    assert.match(pages[name],/grid-template-columns:1fr/);
  });
  test(`${name}: segmented choices expose their selected state and group name`,()=>{
    const buttons=[{...element(),classList:{contains:()=>true}},{...element(),classList:{contains:()=>false}}];
    const group={...element(),querySelector:()=>({textContent:'Model'}),querySelectorAll:()=>buttons};
    const ctx=vm.createContext({dialog:{querySelectorAll:()=>[group]}});
    vm.runInContext(lift(pages[name],'syncModalChoices')+'\nsyncModalChoices(dialog);',ctx);
    assert.equal(group.attributes['aria-label'],'Model');
    assert.equal(buttons[0].attributes['aria-pressed'],'true');
    assert.equal(buttons[1].attributes['aria-pressed'],'false');
  });
}
test('task and group saves prevent duplicates, preserve errors and restore action buttons',async()=>{
  for(const [page,names] of [['kanban',['saveChainTask','saveChainTaskEdit']],['schedule',['saveTask']]]){
    for(const name of names){
      const button=element(),fields={modalFt:{querySelector:()=>button},fChainTaskTitle:element('Title'),fChainTaskDesc:element('Description'),fTitle:element('Title')};
      let reject,calls=0;
      const ctx=vm.createContext({$i:id=>fields[id]||null,editingId:null,tasks:[],curWorkdir:'/project',_schedDefaultEngine:'api',_schedTmuxAvailable:true,
        getScVal:(_,fallback)=>fallback,buildRecurToken:()=>null,t:x=>x,toast(){},closeModal(){},refresh:async()=>{},
        apiFetch:()=>{calls++;return new Promise((resolve,r)=>{reject=r;});}});
      vm.runInContext(lift(pages[page],name),ctx);
      const pending=ctx[name]();assert.equal(button.disabled,true);
      assert.equal(button.attributes['aria-busy'],'true');
      await ctx[name]();assert.equal(calls,1);
      reject(Error('offline'));await pending;
      assert.equal(button.disabled,false);assert.equal(ctx[name].pending,false);
    }
  }
});
test('dashboard: error includes an in-context Refresh action and localized loading status',()=>{
  assert.match(pages.dashboard,/role="status" aria-label="Loading" data-i18n-aria="loading"/);
  assert.match(pages.dashboard,/loadError.innerHTML[^\n]*onclick="loadData\(\)"/);
  assert.equal((pages.dashboard.match(/'loading':/g)||[]).length,5);
});

test('a successful save releases its guard before the board refresh finishes',async()=>{
  // The refresh after a save can take a while; holding the guard through it made the
  // NEXT Save (a new card opened meanwhile) return silently with an enabled button.
  for(const [page,names] of [['kanban',['saveChainTask','saveChainTaskEdit']],['schedule',['saveTask']]]){
    for(const name of names){
      const button=element(),fields={modalFt:{querySelector:()=>button},fChainTaskTitle:element('Title'),fChainTaskDesc:element('Description'),fTitle:element('Title')};
      let releaseRefresh;
      const ctx=vm.createContext({$i:id=>fields[id]||null,editingId:null,tasks:[],curWorkdir:'/project',_schedDefaultEngine:'api',_schedTmuxAvailable:true,
        getScVal:(_,fallback)=>fallback,buildRecurToken:()=>null,t:x=>x,toast(){},closeModal(){},BroadcastChannel:class{postMessage(){}close(){}},
        refresh:()=>new Promise(r=>{releaseRefresh=r;}),apiFetch:async()=>({ok:true,json:async()=>({})})});
      vm.runInContext(lift(pages[page],name),ctx);
      const run=ctx[name]();
      for(let i=0;i<20;i++)await Promise.resolve();
      assert.equal(typeof releaseRefresh,'function',`${page}:${name} never reached the refresh`);
      assert.equal(ctx[name].pending,false,`${page}:${name} still blocks the next Save while the board refreshes`);
      releaseRefresh();await run;
    }
  }
});

test('kanban: every guarded save releases its guard before refreshing the board',()=>{
  for(const name of ['saveChain','saveChainTask','saveChainTaskEdit','saveTask']){
    const body=lift(pages.kanban,name);
    assert.ok(body.indexOf(`${name}.pending=false;\n    closeModal();`)>=0&&body.indexOf(`${name}.pending=false;`)<body.indexOf('await refresh('),name);
  }
});
