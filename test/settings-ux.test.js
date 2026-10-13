'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
function source(start, end) { return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start))); }
function element() { return { value:'', innerHTML:'', className:'', disabled:false, dataset:{}, focus(){},classList:{add(){},remove(){},toggle(){},contains(){return true;}}, appendChild(){}, querySelectorAll(){return [];} }; }
function context() {
  const elements = {};
  const c = vm.createContext({console, JSON, Set, Map, Array, Object, Error, encodeURIComponent, AbortController, clearTimeout(){}, window:{addEventListener(){}},
    $i:id => elements[id] ||= element(), t:k=>k, escH:x=>x, confirm:()=>false,
    openModalOverlay(){c.opened++;}, closeModalOverlay(){c.closed++;}, opened:0, closed:0,
    toast(){},setTimeout(){}, loadCfg(){},curWorkdir:'/project',projects:[],
    document:{createElement:()=>element(),querySelectorAll:()=>[]},
    cfgFiles:{},activeCfgTab:null,cfgResolved:null,
  });
  vm.runInContext(source('const settingsDrafts', '// ─── MCP Add/Edit Modal'),c);
  vm.runInContext(source('const CFG_FORM_TAB', '// ─── Settings form'),c);
  vm.runInContext('applyCfgTabView = () => {};',c);
  return c;
}
(async () => {
  let c=context();
  c.fetch=async()=>{throw new Error('offline');};
  await c.openCfgEditor();
  assert.equal(c.opened,1,'loading dialog opens before network');
  assert.match(c.$i('cfgLoadStatus').innerHTML,/cfg.retry/,'failed load offers retry');
  const releases=[];
  c=context(); c.fetch=()=>new Promise(r=>{releases.push(r);});
  const pending=c.openCfgEditor(); c.closeCfg();
  releases.forEach(resolve=>resolve({ok:true,json:async()=>({})}));
  await pending;
  assert.equal(c.closed,1);
  assert.equal(c.opened,1,'stale load cannot reopen a dismissed dialog');
  c=context();
  vm.runInContext("cfgSavedFiles={'a':'old','b':'old'};cfgFiles={'a':'draft','b':'old'};activeCfgTab='b';",c);
  c.$i('cfgEditor').value='old'; c.closeCfg(); assert.equal(c.closed,0,'off-tab dirty file prevents discard');
  c.confirm=()=>true;c.closeCfg();assert.equal(c.closed,1);
  c=context();
  vm.runInContext("cfgSavedFiles={'a':'old'};cfgFiles={'a':'old'};activeCfgTab='a';",c);
  c.$i('cfgEditor').value='saved snapshot';
  let finish;
  c.fetch=()=>new Promise(r=>finish=r);
  const saving=c.saveCfg(); c.$i('cfgEditor').value='newer edit'; c.closeCfg();assert.equal(c.closed,0,'pending save cannot dismiss');
  finish({ok:true,json:async()=>({ok:true})}); await saving;
  assert.equal(vm.runInContext("cfgSavedFiles.a",c),'saved snapshot');
  c.closeCfg();assert.equal(c.closed,0,'editing during save remains dirty');
  c=context();
  const input={id:'key',type:'text',value:'original'};
  c.$i('mcpEditModal').querySelectorAll=()=>[input];c.settingsRemember('mcpEditModal');
  assert.equal(c.settingsCanClose('mcpEditModal'),true);
  input.value='changed';assert.equal(c.settingsCanClose('mcpEditModal'),false);
  c.confirm=()=>true; assert.equal(c.settingsCanClose('mcpEditModal'),true);
  vm.runInContext("settingsBusy.add('mcpEditModal')",c);assert.equal(c.settingsCanClose('mcpEditModal'),true,'confirmed pending dismissal stays possible');
  c=context();
  vm.runInContext("let _mcpEditMode='add', _mcpEditId=null, _mcpEditTab='form';",c);
  c.config={mcpServers:{}};c.activeMcp=new Set();c._mcpEditCollectForm=()=>({id:'example',type:'stdio',command:'npx'});
  c._mcpEditSetError=msg=>{c.error=msg;};c.renderMcp=()=>{};c.closeMcpModal=()=>{c.closed++;};
  c.fetch=async()=>({ok:false,status:403});
  vm.runInContext(source('async function saveMcpModal()', 'function _mcpEditSetError'),c);
  await c.saveMcpModal();
  assert.equal(c.closed,0,'failed HTTP write keeps MCP editor open');
  assert.equal(c.config.mcpServers.example,undefined,'failed write never updates local config');
  assert.equal(c.error,'settings.uncertain');
  assert.equal(c.$i('mcpEditSaveBtn').disabled,false,'failed save allows retry');
  // Local instruction-file writes retain the opening project, even if the
  // underlying workspace changes before Save is pressed.
  c=context();
  vm.runInContext("cfgOpeningWorkdir='/original'; activeCfgTab='local-claude-md'; cfgFiles={'local-claude-md':'old'}; cfgSavedFiles={...cfgFiles};",c);
  c.curWorkdir='/different';c.$i('cfgEditor').value='draft';
  let request;
  c.fetch=async(url,init)=>{request=JSON.parse(init.body);return {ok:true,json:async()=>({ok:true})};};
  await c.saveCfg();assert.equal(request.dir,'/original');
  // Pending Close requires a deliberate decision but never traps the user.
  c=context();vm.runInContext("cfgOpeningWorkdir='/original';activeCfgTab='local-claude-md';cfgSavedFiles={'local-claude-md':'old'};cfgFiles={...cfgSavedFiles};",c);
  c.$i('cfgEditor').value='pending';let oldResponse;
  c.fetch=()=>new Promise(resolve=>oldResponse=resolve);
  const abandoned=c.saveCfg();c.confirm=()=>true;c.closeCfg();assert.equal(c.closed,1);
  vm.runInContext("cfgSavedFiles={'local-claude-md':'new dialog'};cfgFiles={...cfgSavedFiles};",c);
  oldResponse({ok:true,json:async()=>({ok:true})});await abandoned;
  assert.equal(vm.runInContext("cfgSavedFiles['local-claude-md']",c),'new dialog','closed operation cannot overwrite a new dialog');
  // The same 30s deadline includes a response whose JSON body never completes.
  c=context();let deadline; c.setTimeout=(fn,ms)=>{if(ms===30000)deadline=fn;return 1;};
  vm.runInContext("activeCfgTab='a';cfgSavedFiles={a:'old'};cfgFiles={a:'old'};",c);c.$i('cfgEditor').value='draft';
  c.fetch=async()=>({ok:true,json:()=>new Promise(()=>{})});
  const stalled=c.saveCfg();await Promise.resolve();await Promise.resolve();deadline();await stalled;
  assert.equal(vm.runInContext('cfgSaving',c),false,'JSON timeout restores controls');
  assert.equal(c.$i('cfgSaveBtn').disabled,false);
  // Loading success keeps the original modal focus-return entry.
  c=context();c.fetch=async()=>({ok:true,json:async()=>({})});await c.openCfgEditor();
  assert.equal(c.opened,1,'success focuses the editor without reopening the overlay');
  assert.match(source('function settingsHasUnsavedChanges()', '// ─── MCP Add/Edit Modal'),/beforeunload/);
  assert.match(html,/const response = await operation.fetch\('\/api\/mcp\/add'[\s\S]*?if \(!response.ok\) throw/);
  assert.match(html,/cfg-sec-hdr" data-cfg-section="[^"\n]*" aria-expanded=/);
  assert.match(html,/id="mcpImportDrop" role="button" tabindex="0"/);
  console.log('Settings UX: script syntax, loading/retry, draft close guards, save races, MCP guards and keyboard markup passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
