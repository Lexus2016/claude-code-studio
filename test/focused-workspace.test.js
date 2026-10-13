'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf('\n}', start) + 2);
}
function harness({ ready = Promise.resolve() } = {}) {
  const events = {}, windowEvents = {}, timers = [], calls = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, textContent:'', value:'', style:{}, classList:{contains:()=>false}, scrollTop:0, disabled:false });
    return elements.get(id);
  };
  const rail = {scrollTop:12};
  const history = {length:1, state:null, entries:[], replaceState(state) {this.state = state; this.entries[this.length-1]=state;}, pushState(state) {this.state=state; this.entries[this.length++]=state;}};
  const context = vm.createContext({
    console, URLSearchParams, WeakMap, Object, Number, Set,
    _workspaceHistoryRestoring:false, _workspaceHistorySeq:0, _pendingWorkspaceReturn:null,
    _workspaceNavReady:true, _workspaceIntentPending:0, navigator:{platform:'MacIntel'},
    _projectsReady:ready, curProjectId:'p', curWorkdir:'/p', activeTabId:'a', currentSessionId:'a',
    projects:[{id:'p',name:'Project'}, {id:'q',name:'Other'}], openTabs:[{id:'a',title:'Alpha'},{id:'b',title:'Beta'}],
    msgsEl:{scrollTop:41,innerHTML:''}, _shownFrom:7, _SEC_FILTER_CFG:{hist:{}},
    document:{getElementById:element, querySelector:()=>rail, addEventListener:(type,fn,capture=false)=>{(events[type] ||= []).push({fn,capture});}},
    window:{addEventListener:(type,fn)=>{windowEvents[type]=fn;}},
    history, location:{href:'http://localhost/'}, $i:element, t:x=>x,
    setTimeout:fn=>{timers.push(fn);},
    saveUIState:()=>calls.push('save'), saveComposerState:()=>calls.push('draft'),
    applySecFilter:(key,value)=>calls.push(['filter',key,value]),
    hideTerminalView:()=>calls.push('hide-terminal'), showW:()=>calls.push('welcome'),
    restoreComposerState:()=>calls.push('restore-draft'), renderTabs:()=>{}, updateSessBar:()=>{},
    openWorkspaceJump:()=>{}, closeWorkspaceJump:()=>{}, dismissWorkspaceOverlays:()=>calls.push('dismiss'),
  });
  context.openTab = (id,title) => {calls.push(['open',id]);context.activeTabId=id;context.currentSessionId=id;};
  context.loadSess = async id => {calls.push(['load',id]);context.currentSessionId=id;};
  context.switchProject = id => {calls.push(['project',id]);context.curProjectId=id;context.activeTabId='b';};
  for(const name of ['workspaceVisit','sameWorkspaceVisit','rememberWorkspaceVisit','syncWorkspaceEntry','updateWorkspaceLocation','restoreWorkspaceVisit','initWorkspaceNavigation']) vm.runInContext(source(name),context);
  context.initWorkspaceNavigation();
  const event = type => ({type,key:'Enter',target:{closest:()=>true}});
  async function dispatch(target,{stopped=false,kind='click'}={}) {
    const e=event(kind);
    for(const h of events[kind] || []) if(h.capture) h.fn(e);
    // Browsers may checkpoint between capture and target listeners.
    await Promise.resolve();
    target();
    if(!stopped) for(const h of events[kind] || []) if(!h.capture) h.fn(e);
    return e;
  }
  const flush=()=>{while(timers.length) timers.shift()();};
  return {context,events,windowEvents,timers,calls,history,element,dispatch,flush};
}

test('native details retain advanced tools and every original run control', () => {
  const tools=html.slice(html.indexOf('<details class="workspace-tools"'),html.indexOf('<!-- LEFT PANEL TAB -->'));
  for(const id of ['bots','agents','mcp','skills','cmds','sshHosts','tunnel','tg']) assert.match(tools,new RegExp('id="'+id+'Body"'));
  const run=html.slice(html.indexOf('<details class="run-settings"'),html.indexOf('</details>',html.indexOf('<details class="run-settings"')));
  for(const id of ['maxTurns','effortSel','pinDefaultsBtn','resetDefaultsBtn']) assert.match(run,new RegExp('id="'+id+'"'));
  for(const mode of ['auto','planning','task','single','multi','dispatch','conversation','haiku','sonnet','opus','fable','api','subscription']) assert.ok(run.includes('data-v="'+mode+'"'),mode);
  for(const id of ['sessBarRestartBtn','sessBarPaneBtn','sessBarDelegateBtn','stopBtn','termRefreshBtn']) assert.ok(html.includes('id="'+id+'"'),id);
});

test('hidden sidebars cannot leave invisible focus targets; welcome actions are native buttons', () => {
  assert.match(html,/\.left\.collapsed, \.right\.collapsed \{ visibility:hidden; \}/);
  assert.match(html,/<div class="right collapsed" id="rightPanel">/);
  assert.doesNotMatch(html,/<div class="wp-card"/);
  assert.match(html,/<button type="button" class="wp-card"/);
});

test('effort changes synchronize both mobile and desktop controls', () => {
  const h=harness();
  h.context.localStorage={setItem(){}};
  vm.runInContext(source('setEffort'),h.context);
  h.context.setEffort('high');
  assert.equal(h.element('effortSel').value,'high');assert.equal(h.element('mobEffort').value,'high');
  h.context.setEffort('invalid');assert.equal(h.element('effortSel').value,'');assert.equal(h.element('mobEffort').value,'');
});

test('run summary reports the actual mode, team, model and engine', () => {
  const h=harness(); Object.assign(h.context,{curMode:'planning',curAgent:'conversation',curModel:'opus',curEngine:'subscription',activeMcp:new Set(['x']),activeSkills:new Set(['a','b'])});
  vm.runInContext(source('updateWorkspaceSummary'),h.context);h.context.updateWorkspaceSummary();
  assert.equal(h.element('runSettingsSummary').textContent,'mode.plan · agent.conversation · opus · engine.sub');
  assert.equal(h.element('workspaceToolsCount').textContent,'3');
});

test('native capture checkpoint cannot record before the target navigation runs', async () => {
  const h=harness(); await h.dispatch(()=>{assert.equal(h.history.length,1);h.context.activeTabId='b';});
  assert.equal(h.history.length,2);assert.equal(h.history.entries[0].ccsWorkspace.tabId,'a');assert.equal(h.history.state.ccsWorkspace.tabId,'b');
  h.flush();assert.equal(h.history.length,2,'fallback must not duplicate bubble commit');
});

test('stopped events commit once via a post-dispatch task', async () => {
  const h=harness();await h.dispatch(()=>{h.context.activeTabId='b';},{stopped:true});assert.equal(h.history.length,1);
  h.flush();assert.equal(h.history.length,2);assert.equal(h.history.state.ccsWorkspace.tabId,'b');
});

test('same-tab choices, polls and repeated activation do not grow history', async () => {
  const h=harness();await h.dispatch(()=>{});h.context.updateWorkspaceLocation();h.flush();assert.equal(h.history.length,1);
  await h.dispatch(()=>{h.context.activeTabId='b';});await h.dispatch(()=>{}, {kind:'keydown'});h.flush();assert.equal(h.history.length,2);
});

test('A → B → Back → Forward restores choices and filters without extra entries', async () => {
  const h=harness();h.element('histFilterInp').value='Alpha';await h.dispatch(()=>{h.context.activeTabId='b';});
  const a=h.history.entries[0].ccsWorkspace,b=h.history.entries[1].ccsWorkspace;
  await h.context.restoreWorkspaceVisit(a);assert.equal(h.context.activeTabId,'a');assert.equal(h.element('histFilterInp').value,'Alpha');
  await h.context.restoreWorkspaceVisit(b);assert.equal(h.context.activeTabId,'b');assert.equal(h.history.length,2);assert.ok(h.calls.includes('save'));
});

test('a newer Back/Forward request wins while projects are loading', async () => {
  let resolve;const ready=new Promise(r=>{resolve=r});const h=harness({ready});
  const first=h.context.restoreWorkspaceVisit({projectId:'q',tabId:'old'});
  const second=h.context.restoreWorkspaceVisit({projectId:'p',tabId:'b'});
  resolve();await Promise.all([first,second]);assert.equal(h.context.activeTabId,'b');assert.ok(!h.calls.some(c=>Array.isArray(c)&&c[0]==='project'));
});

test('newer user navigation cancels a pending Back restore', async () => {
  let resolve;const h=harness({ready:new Promise(r=>{resolve=r})});
  const pending=h.context.restoreWorkspaceVisit({projectId:'q',tabId:'old'});
  await h.dispatch(()=>{h.context.activeTabId='b';});resolve();await pending;
  assert.equal(h.context.activeTabId,'b');assert.equal(h.context.curProjectId,'p');assert.equal(h.context._workspaceHistoryRestoring,false);
});

test('a project restore does not launch a second same-session transcript load', async () => {
  const h=harness();await h.context.restoreWorkspaceVisit({projectId:'q',tabId:'b'});
  assert.deepEqual(h.calls.filter(c=>Array.isArray(c)&&c[0]==='project'),[['project','q']]);
  assert.ok(!h.calls.some(c=>Array.isArray(c)&&c[0]==='load'));
});

test('closed draft and terminal history entries are never recreated as chats', async () => {
  for(const visit of [{projectId:'p',tabId:'gone',isNew:true},{projectId:'p',tabId:'gone',kind:'terminal'}]) {
    const h=harness();await h.context.restoreWorkspaceVisit(visit);assert.equal(h.context.activeTabId,'a');assert.ok(!h.calls.some(c=>Array.isArray(c)&&c[0]==='open'));
  }
});

test('deleted projects fail safely and never change the active project', async () => {
  const h=harness();await h.context.restoreWorkspaceVisit({projectId:'deleted',tabId:'b'});assert.equal(h.context.curProjectId,'p');assert.equal(h.context.activeTabId,'a');assert.equal(h.context._workspaceHistoryRestoring,false);
});

test('page departure saves drafts before writing its history snapshot', () => {
  const h=harness();const order=[];h.context.saveUIState=()=>order.push('draft');h.context.rememberWorkspaceVisit=()=>order.push('history');
  h.windowEvents.pagehide();assert.deepEqual(order,['draft','history']);
});

test('Back dismisses overlays before restoring the workspace, without a second back()', () => {
  const h=harness();const order=[];h.context.dismissWorkspaceOverlays=()=>order.push('dismiss');h.context.restoreWorkspaceVisit=()=>order.push('restore');
  h.windowEvents.popstate({state:{ccsWorkspace:{projectId:'p',tabId:'a'}}});assert.deepEqual(order,['dismiss','restore']);
  assert.doesNotMatch(source('dismissWorkspaceOverlays').replace(/\/\/[^\n]*/g, ''),/history\.back\(/);
});

test('explicit session deep links take precedence over saved navigation', () => {
  assert.match(html,/history\.state\?\.ccsWorkspace && !new URLSearchParams\(location\.search\)\.has\('open_session'\)/);
  assert.match(html,/id !== activeTabId\) return; \/\/ a newer navigation owns the viewport/);
});

test('mobile close-before-open is synchronous and settings launches from persistent focus', () => {
  assert.doesNotMatch(source('toggleMobSheet'),/requestAnimationFrame/);
  assert.match(source('toggleMobSheet'),/sheet\.inert = false/);
  assert.match(source('closeMobSheet'),/sheet\.inert = true/);
  assert.match(html,/onclick="closeMobSheet\(\);openCfgEditor\(\)"/);
  assert.match(source('initFocusedWorkspace'),/summary'\)\.focus\(\);\n    menu\.open = false;/);
});

test('a click whose handler re-renders the tabs synchronously still records history', async () => {
  // openTab() -> renderTabs() -> updateWorkspaceLocation() runs INSIDE the click.
  // Without the pending-intent guard the sync would rewrite the current entry to
  // the new view, finishIntent would find nothing changed, and no entry is pushed.
  const h=harness();
  await h.dispatch(()=>{h.context.activeTabId='b';h.context.updateWorkspaceLocation();});
  assert.equal(h.history.length,2);
  assert.equal(h.history.entries[0].ccsWorkspace.tabId,'a');
  assert.equal(h.history.entries[1].ccsWorkspace.tabId,'b');
  assert.equal(h.context._workspaceIntentPending,0);
});

test('the current entry follows a chat that appears without a click, in place', () => {
  const h=harness();
  h.history.state={ccsWorkspace:{projectId:'p',tabId:null,isNew:false,kind:'chat'}};
  h.context.activeTabId='a'; h.context.updateWorkspaceLocation();
  assert.equal(h.history.length,1,'a sync replaces, it never pushes');
  assert.equal(h.history.state.ccsWorkspace.tabId,'a');
  assert.equal(h.history.state.ccsWorkspace.scrollTop,null,'the offset on screen may belong to another chat');
  const written=h.history.state; h.context.updateWorkspaceLocation();
  assert.equal(h.history.state,written,'an unchanged view writes nothing (Safari rate-limits replaceState)');
});

test('boot renders cannot overwrite the entry before it has been read', () => {
  const h=harness(); h.context._workspaceNavReady=false;
  const entry={ccsWorkspace:{projectId:'q',tabId:'old',isNew:false,kind:'chat'}};
  h.history.state=entry; h.context.updateWorkspaceLocation();
  assert.equal(h.history.state,entry);
});

test('Back: an overlay closing re-renders the tabs, and the arrived-at entry survives', () => {
  const h=harness(); const arrived={ccsWorkspace:{projectId:'q',tabId:'old',isNew:false,kind:'chat'}};
  h.history.state=arrived;
  h.context.dismissWorkspaceOverlays=()=>h.context.updateWorkspaceLocation();
  h.context.restoreWorkspaceVisit=()=>{};
  h.windowEvents.popstate({state:arrived});
  assert.equal(h.history.state,arrived);
});

test('a pushed entry opens at the bottom; only the departed one keeps its reading position', async () => {
  const h=harness(); await h.dispatch(()=>{h.context.activeTabId='b';});
  assert.equal(h.history.entries[0].ccsWorkspace.scrollTop,41);
  assert.equal(h.history.entries[1].ccsWorkspace.scrollTop,null);
});

test('a restore started during boot waits for the last script block to be parsed', async () => {
  // Reload or a cross-document Back restores from boot, and the no-tab branch calls
  // hideTerminalView(), declared in the LAST <script> block. Observed: ReferenceError.
  const h=harness(); const doc=h.context.document; doc.readyState='loading';
  const done=h.context.restoreWorkspaceVisit({projectId:'p',tabId:null});
  for(let i=0;i<5;i++) await Promise.resolve();
  assert.ok(!h.calls.includes('hide-terminal'),'nothing may run before DOMContentLoaded');
  doc.readyState='interactive'; for(const l of h.events.DOMContentLoaded) l.fn();
  await done;
  assert.ok(h.calls.includes('hide-terminal'));
});

test('Go to opens with Cmd+K on macOS and leaves Ctrl+K to the text field', () => {
  const src=source('initWorkspaceNavigation');
  assert.match(src,/isMac \? e\.metaKey && !e\.ctrlKey : e\.ctrlKey && !e\.metaKey/);
});

test('Run settings closes on an outside click, but not on the Go to… click that opened it', () => {
  const src=source('initFocusedWorkspace');
  assert.match(src,/run\?\.open && !run\.contains\(e\.target\) && !e\.target\.closest\?\.\('#workspaceJumpModal'\)/);
});
