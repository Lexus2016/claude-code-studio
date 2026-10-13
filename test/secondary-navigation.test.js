'use strict';
// Standalone structural and real-renderer checks; no browser dependency in npm test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', name + '.html'), 'utf8');
for (const [name, target] of [['kanban', 'board'], ['schedule', 'agenda'], ['dashboard', 'main']]) {
  const html = read(name);
  test(`${name}: every inline script parses`, () => {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length);
    for (const [i, script] of scripts.entries()) new vm.Script(script[1], { filename: `${name}#${i}` });
  });
  test(`${name}: navigation identifies the current page and skips to a focusable landmark`, () => {
    assert.match(html, new RegExp(`class="nav-sw-btn active" aria-current="page" href="/${name}"`));
    assert.match(html, new RegExp(`class="skip-link" href="#${target}" data-i18n="nav.skip"`));
    assert.match(html, new RegExp(`id="${target}" role="main" tabindex="-1"`));
    assert.equal([...html.matchAll(/'nav.skip':/g)].length, 5, 'every supported locale translates the skip link');
  });
  test(`${name}: mobile labels and reduced motion remain available`, () => {
    const focusedCSS = html.slice(html.indexOf('/* Focused workspace:'));
    assert.match(focusedCSS, /\.nav-sw-btn span\{ display:block;/);
    assert.match(focusedCSS, /\.hb span\{ display:inline;/);
    assert.match(focusedCSS, /\.hdr-meta\{ display:flex; width:100%; \}/);
    assert.match(focusedCSS, /prefers-reduced-motion:reduce/);
  });
}

test('Kanban actions are reachable by keyboard without shifting the timestamp', () => {
  const html = read('kanban');
  const css = html.slice(html.indexOf('/* Clear hierarchy on the board'));
  assert.match(css, /\.card-actions\{ display:flex; opacity:0; \}/);
  assert.match(css, /\.card:focus-within \.card-actions\{ opacity:1; \}/);
  assert.match(css, /\.card:hover \.card-time\{ display:inline; \}/);
  assert.match(css, /@media\(hover:none\),\(pointer:coarse\)/);
});

test('Dashboard session navigation uses native links and escapes user-provided titles', () => {
  const html = read('dashboard');
  const lift = name => {
    const start = html.indexOf(`function ${name}(`);
    const end = html.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start);
    return html.slice(start, end + 2);
  };
  const wrap = { innerHTML: '' };
  const context = vm.createContext({ $: () => wrap, t: key => key, locale: () => 'en-GB' });
  // escHtml is one line, so take that line rather than the multiline helper.
  const escapeSource = html.split('\n').find(line => line.startsWith('function escHtml('));
  vm.runInContext(escapeSource + '\n' + lift('renderTimeline'), context);
  context.renderTimeline([{ id: 'session/a?b', title: '<img src=x onerror=alert(1)>', msg_count: 2, tool_count: 1 }]);
  assert.match(wrap.innerHTML, /<a class="tl-item" href="\/\?open_session=session%2Fa%3Fb">/);
  assert.match(wrap.innerHTML, /&lt;img/);
  assert.doesNotMatch(wrap.innerHTML, /onclick=|<img/);
  assert.match(wrap.innerHTML, /<\/a>/);
});

function navigationHarness(name, { saved = null, historySaved = null, search = '', blocked = false } = {}) {
  const route = '/' + name + search;
  const store = new Map();
  if (saved) store.set('ccs_navigation:' + route, JSON.stringify({version:1, route, ...saved}));
  const host = {scrollLeft:0, scrollTop:0};
  const input = {value:''};
  const back = {};
  const columns = [{dataset:{status:'todo'}, scrollTop:0}, {dataset:{status:'done'}, scrollTop:0}];
  const events = {};
  const frames = [];
  const history = {length:2, state:{unrelated:'keep'}, replaceState(state) { this.state = state; }};
  if (historySaved) history.state.ccsNavigation = {version:1, route, ...historySaved};
  const context = vm.createContext({
    location:{pathname:'/' + name, search}, history, URLSearchParams, curWorkdir:'/current',
    sessionStorage:{getItem:key => {if (blocked) throw Error('blocked'); return store.get(key) || null;}, setItem:(key,val) => {if (blocked) throw Error('blocked'); store.set(key,val);}},
    document:{visibilityState:'visible', getElementById:id => id === 'projDdSearch' ? input : id === 'pageBackBtn' ? back : id === (name === 'kanban' ? 'board' : name === 'dashboard' ? 'main' : '') ? host : null,
      querySelectorAll:selector => selector === '.col-body' && name === 'kanban' ? columns : [], addEventListener:(event, fn) => {events[event]=fn;}},
    window:{scrollX:0, scrollY:0, scrollTo(x,y) {this.scrollX=x;this.scrollY=y;}, addEventListener:(event,fn) => {events[event]=fn;}},
    requestAnimationFrame:fn => frames.push(fn),
  });
  const script = [...read(name).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(source => source.includes('const pageNavigation ='));
  vm.runInContext(script + '\nthis.navigation = pageNavigation;', context);
  return {navigation:context.navigation, context, host, input, columns, history, store, events, flush:() => frames.splice(0).forEach(fn => fn())};
}

for (const name of ['kanban', 'schedule', 'dashboard']) {
  test(`${name}: restores tab-local scroll and project search only after layout`, () => {
    // A same-tab snapshot of the project now on screen (the harness curWorkdir).
    const h = navigationHarness(name, {saved:{project:'/current', search:'studio', scroll:{x:-220,y:480,columns:[{status:'todo',y:160}]}}});
    h.navigation.restore();
    assert.equal(h.input.value,'studio');
    assert.equal(h.host.scrollTop,0);
    h.flush();
    if (name === 'schedule') assert.equal(h.context.window.scrollY,480);
    else assert.equal(h.host.scrollTop,480);
    if (name === 'kanban') {
      assert.equal(h.host.scrollLeft,-220,'RTL board offsets must survive');
      assert.equal(h.columns[0].scrollTop,160);
      assert.equal(h.columns[1].scrollTop,0);
    }
    h.host.scrollTop=80;
    h.navigation.restore();h.flush();
    assert.equal(h.host.scrollTop,80,'restoration must not fight later user scrolling');
  });
  test(`${name}: a fresh visit never borrows the view of a different project`, () => {
    // Chat moved to another project since this tab last saw the page: the old
    // board's scroll and search must not be painted over the current one.
    const h = navigationHarness(name, {saved:{project:'/saved', search:'studio', scroll:{x:0,y:480,columns:[]}}});
    h.navigation.restore(); h.flush();
    assert.equal(h.input.value,'');
    assert.equal(name === 'schedule' ? h.context.window.scrollY : h.host.scrollTop, 0);
  });
  test(`${name}: Back/Forward to this entry restores its own view, whatever project is current`, () => {
    const h = navigationHarness(name, {historySaved:{project:'/entry', search:'q', scroll:{x:0,y:300,columns:[]}}});
    h.navigation.restore(); h.flush();
    assert.equal(h.input.value,'q');
    assert.equal(name === 'schedule' ? h.context.window.scrollY : h.host.scrollTop, 300);
  });
  test(`${name}: remembers departure state without replacing unrelated history`, () => {
    const h = navigationHarness(name);
    h.host.scrollLeft=200;h.host.scrollTop=150;h.input.value='project query';
    h.events.pagehide();
    assert.equal(h.history.state.unrelated,'keep');
    assert.equal(h.history.state.ccsNavigation.project,'/current');
    assert.equal(h.history.state.ccsNavigation.search,'project query');
    assert.equal(h.store.size,1);
    assert.equal(h.history.state.ccsNavigation.route,'/' + name);
  });
  test(`${name}: current history entry wins over a more recent revisit snapshot`, () => {
    const h = navigationHarness(name, {saved:{project:'/saved'},historySaved:{project:'/entry'}});
    assert.equal(h.navigation.resolveProject('/current',[{workdir:'/saved'},{workdir:'/entry'}]),'/entry');
  });
  test(`${name}: explicit links win and missing remembered projects degrade safely`, () => {
    const projects=[{id:'a',workdir:'/saved'},{id:'b',workdir:'/linked'}];
    for(const [search,expected] of [['?all=1',null],['?workdir=%2Flinked','/linked'],['?project=b','/linked'],['?project=deleted',null],['?open_session=s','/current'],['?session=s','/current']]) {
      const h=navigationHarness(name,{search,saved:{project:'/saved'}});
      assert.equal(h.navigation.resolveProject('/current',projects),expected,search);
    }
    assert.equal(navigationHarness(name,{saved:{project:'/gone'}}).navigation.resolveProject('/current',projects),'/current');
    // Only the history entry itself carries a project; the per-tab copy is the
    // last visit, and a fresh visit follows the shared current project instead.
    assert.equal(navigationHarness(name,{saved:{project:null}}).navigation.resolveProject('/current',projects),'/current');
    assert.equal(navigationHarness(name,{saved:{project:'/saved'}}).navigation.resolveProject('/current',projects),'/current');
    assert.equal(navigationHarness(name,{historySaved:{project:null}}).navigation.resolveProject('/current',projects),null);
    assert.equal(navigationHarness(name,{historySaved:{project:'/saved'}}).navigation.resolveProject('/current',projects),'/saved');
    assert.equal(navigationHarness(name,{historySaved:{project:'/gone'}}).navigation.resolveProject('/current',projects),'/current');
  });
  test(`${name}: blocked storage does not break navigation`, () => {
    const h=navigationHarness(name,{blocked:true});
    assert.doesNotThrow(()=>h.events.pagehide());
    assert.doesNotThrow(()=>h.navigation.restore());
    assert.equal(h.navigation.resolveProject('/current',[]),'/current');
  });
}
