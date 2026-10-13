'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function src(name) {const start=html.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);return html.slice(start,html.indexOf('\n}',start)+2);}
function element(){return {textContent:'',innerHTML:'',children:[],attrs:{},disabled:false,className:'',style:{},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},append(...x){this.children.push(...x)},appendChild(x){this.children.push(x)},replaceChildren(...x){this.children=x},focus(){this.focused=true},classList:{contains:()=>false}};}
function harness(){const els=new Map(),pending=[],errors=[];const el=id=>{if(!els.has(id))els.set(id,element());return els.get(id)};const c=vm.createContext({Set,Number,AbortController,setTimeout,clearTimeout,_formActions:new Set(),_filesListSeq:0,_filesRemote:false,_switchGen:0,_cliListSeq:0,_cliSessions:[],_filesQS:x=>x,$i:el,t:x=>x,escH:x=>x,toast:x=>errors.push(x),document:{createElement:()=>element()},fetch:()=>new Promise(resolve=>pending.push(resolve)),makeKeyboardRow:()=>{},cliImportHostId:()=>'',renderCliSessionList:()=>{},cliImportErrText:()=> 'error'});for(const n of ['runFormAction','renderSectionError','loadFiles','loadCliSessions','makeKeyboardRow'])vm.runInContext(src(n),c);return{c,el,pending,errors};}
const reply=data=>({ok:true,json:async()=>data});

test('duplicate submissions share one action and restore the original control',async()=>{const h=harness();let finish,calls=0;h.el('save').textContent='Save';const job=()=>{calls++;return new Promise(r=>finish=r)};const a=h.c.runFormAction('save','status',job);await h.c.runFormAction('save','status',job);assert.equal(calls,1);assert.equal(h.el('save').disabled,true);finish();await a;assert.equal(h.el('save').disabled,false);assert.equal(h.el('save').textContent,'Save');});
test('rejected submission keeps form fields and shows an inline alert',async()=>{const h=harness();h.el('name').value='Draft';await h.c.runFormAction('save','status',async()=>{throw Error('Network failed')});assert.equal(h.el('name').value,'Draft');assert.equal(h.el('status').attrs.role,'alert');assert.equal(h.el('status').textContent,'Network failed');assert.equal(h.el('save').disabled,false);});
test('file list latest path wins even within one project',async()=>{const h=harness();const a=h.c.loadFiles('old'),b=h.c.loadFiles('new');h.pending[1](reply({type:'dir',items:[]}));await b;h.pending[0](reply({type:'remote'}));await a;assert.equal(h.c._filesRemote,false);assert.match(h.el('filesTree').innerHTML,/files.empty/);});
test('project change invalidates an older file listing',async()=>{const h=harness();const a=h.c.loadFiles('old');h.c._switchGen++;h.pending[0](reply({type:'remote'}));await a;assert.equal(h.c._filesRemote,false);});
test('HTTP file errors render actionable retry rather than old contents',async()=>{const h=harness();const a=h.c.loadFiles('private');h.pending[0]({ok:false,json:async()=>({error:'Denied'})});await a;const alert=h.el('filesTree').children[0];assert.equal(alert.attrs.role,'alert');assert.equal(alert.children[0].textContent,'Denied');assert.equal(alert.children[1].textContent,'forms.retry');assert.equal(typeof alert.children[1].onclick,'function');});
test('file row keyboard activation ignores nested action-button keys',()=>{const h=harness(),row=element();let calls=0;h.c.makeKeyboardRow(row,()=>calls++);row.onkeydown({target:row,key:'Enter',preventDefault(){}});row.onkeydown({target:{},key:' ',preventDefault(){}});assert.equal(calls,1);assert.equal(row.tabIndex,0);});
test('CLI source/path change invalidates an outstanding listing',async()=>{const h=harness();h.el('cliImportWorkdir').value='/old';const a=h.c.loadCliSessions();h.c._cliListSeq++;h.pending[0](reply({sessions:[{sessionId:'old'}]}));await a;assert.equal(h.c._cliSessions.length,0);assert.equal(h.el('cliImportBtn').disabled,true);});
test('folder selection and exploration are separate native actions without click delay',()=>{const fn=src('browseDirs');assert.match(fn,/createElement\('button'\)/);assert.match(fn,/open\.onclick = \(\) => browseDirs\(it\.path\)/);assert.doesNotMatch(fn,/el\._t|setTimeout/);assert.match(fn,/seq !== _browseDirsSeq/);assert.match(fn,/renderSectionError/);});
test('directory draft stays in DOM while closed; success clears its reuse flag',()=>{assert.match(src('openAddProject'),/if \(_projectFormHasDraft\) return/);assert.match(src('closeDirModal'),/_projectFormHasDraft = !preservePending/);assert.match(src('_selectDirRequest'),/closeDirModal\(true\)/);});
test('preview ignores responses after Close or a newer project/file',()=>{assert.match(src('closeFpv'),/\+\+_filePreviewSeq/);assert.match(src('openFilePreview'),/seq !== _filePreviewSeq \|\| gen !== _switchGen/);});
test('SSH save preserves blank-on-edit password semantics and validates port',()=>{const fn=src('_saveNewSshHostRequest');assert.match(fn,/if \(!isEdit \|\| password !== '' \|\| !existingHost\?\.password\) payload\.password = password/);assert.match(fn,/port < 1 \|\| port > 65535/);assert.match(fn,/payload\.password = ''/);assert.match(src('saveNewSshHost'),/runFormAction/);assert.match(src('testNewSshHost'),/if \(!stillCurrent\(\)\) return/);});
test('SSH fields have labels and credentials never enter navigation draft storage',()=>{for(const id of ['sshHostLabel','sshHostHost','sshHostPort','sshHostKey','sshHostPassword'])assert.match(html,new RegExp('<label for="'+id+'"'));assert.doesNotMatch(src('workspaceVisit'),/password|sshHostPassword|tunnelNgrokToken|tgBotToken/);});
test('failed skill deletion leaves the item enabled and available',()=>{const fn=src('rSkill');assert.ok(fn.indexOf('if (!response.ok)')<fn.indexOf('activeSkills.delete'));assert.match(fn,/catch \(error\)/);assert.match(src('uploadSkill'),/finally \{ input.disabled = false; \}/);});
test('shared forms retain strong focus, inline invalid and mobile type scale',()=>{assert.match(html,/\.modal :is\(input,select,textarea\):focus-visible/);assert.match(html,/\[aria-invalid=true\]/);assert.match(html,/font-size:16px !important/);assert.match(html,/\.tn-provider-card:focus-within/);});
test('request timeout reports uncertainty and unlocks without automatic retry',async()=>{const h=harness();let calls=0;await h.c.runFormAction('save','status',signal=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{const error=Error('aborted');error.name='AbortError';reject(error)}));},1);assert.equal(calls,1);assert.equal(h.el('status').textContent,'forms.uncertain');assert.equal(h.el('save').disabled,false);});
test('failed MCP deletion preserves configuration and active selection',async()=>{const h=harness();Object.assign(h.c,{confirm:()=>true,config:{mcpServers:{x:{label:'X'}}},activeMcp:new Set(['x']),renderMcp:()=>{}});vm.runInContext(src('rMcp'),h.c);const run=h.c.rMcp('x');h.pending[0]({ok:false});await run;assert.equal(h.c.activeMcp.has('x'),true);assert.ok(h.c.config.mcpServers.x);assert.equal(h.errors.length,1);});
test('late project creation can notify but cannot take over a newer workspace',()=>{const h=harness();Object.assign(h.c,{_projectDialogSeq:1,curProjectId:'a',activeTabId:'chat'});vm.runInContext(src('projectRequestContext')+'\n'+src('projectRequestStillCurrent'),h.c);const context=h.c.projectRequestContext();assert.equal(h.c.projectRequestStillCurrent(context),true);h.c.curProjectId='b';assert.equal(h.c.projectRequestStillCurrent(context),false);for(const name of ['_selectDirRequest','cloneProjectFromUrl'])assert.match(src(name),/!projectRequestStillCurrent\(context\)/);});
test('connection controls do not claim successful stop or delete after HTTP failure',()=>{for(const name of ['deleteRemoteHost','tunnelStop','tgStopBot','tgToggleAccept'])assert.match(src(name),/if \(!response.ok\) throw/);assert.match(src('loadRemoteHosts'),/renderSectionError/);});

test('non-cooperative post-save refresh cannot keep form pending forever',async()=>{const h=harness();await h.c.runFormAction('save','status',()=>new Promise(()=>{}),1);assert.equal(h.el('save').disabled,false);assert.equal(h.el('status').textContent,'forms.uncertain');});

test('canceled departure keeps reconnect enabled; bfcache return can reconnect',()=>{
 const lifecycle=html.slice(html.indexOf('// Only an actual departure'),html.indexOf("window.addEventListener('online'"));
 const handlers={};let connects=0;const ctx={window:{addEventListener:(n,f)=>handlers[n]=f},_intentionalClose:false,_reconnectTimer:42,clearTimeout:()=>{},ws:{readyState:3},connect:()=>connects++};
 vm.runInNewContext(lifecycle,ctx);
 assert.equal(handlers.beforeunload,undefined);assert.equal(ctx._intentionalClose,false);
 handlers.pagehide();assert.equal(ctx._intentionalClose,true);assert.equal(ctx._reconnectTimer,null);
 handlers.pageshow({persisted:true});assert.equal(ctx._intentionalClose,false);assert.equal(connects,1);
 ctx.ws.readyState=0;handlers.pageshow({persisted:true});assert.equal(connects,1);
});

test('the folder list, not the dialog footer, gives way on a short screen',()=>{
  // #projLocalSection is the list's parent; as a plain block it kept the list at 340px and
  // pushed the Add button below .modal's overflow:hidden edge at 1366x768 (observed live).
  assert.match(html,/#projLocalSection \{ display:flex; flex-direction:column; flex:0 1 auto; min-height:0; \}/);
  assert.match(html,/#projLocalSection \.dir-list \{ min-height:96px; \}/);
});
