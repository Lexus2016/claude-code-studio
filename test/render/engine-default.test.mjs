// Three engine-selection defects that all end in "the UI says one engine, the chat runs
// on another". #105 and #103 were proposed as PRs and withdrawn by their author because
// they did not cure the reported 402 — and 3. below is why: neither touched the cause.
//
// 1. The mobile settings sheet blanked the engine chips. The API chip ships with
//    `class="mob-chip on"`, and syncMobSheetFromDesktop() compared every chip against a
//    `cur` that stayed '' for the engine group — so opening the sheet REMOVED the highlight
//    from both chips and the user saw no engine selected.
//
// 2. send() read `curEngine` before /api/version had landed. `curEngine` starts as the
//    placeholder 'api' and only becomes the configured default in resolveEngineForView(),
//    so the first message of a fresh page load could go out on the wrong engine. The server
//    persists the engine of every turn (server.js: UPDATE sessions SET run_engine), so the
//    damage is that one turn, not the chat's lifetime — which is also why the wait must be
//    BOUNDED: a /api/version that never answers may not freeze the composer.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFn } from './_load.mjs';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');
const tick = () => new Promise(r => setImmediate(r));

// ── 1. mobile sheet chips ───────────────────────────────────────────────────────────

function mobChips() {
  const mk = (mob, v) => ({ dataset: { mob, v }, on: undefined, classList: { toggle(_c, on) { this.owner.on = on; } } });
  const chips = [mk('mode', 'auto'), mk('mode', 'plan'), mk('engine', 'api'), mk('engine', 'subscription')];
  chips.forEach(c => { c.classList.owner = c; });
  globalThis.document = { querySelectorAll: () => chips };
  globalThis.$i = () => null;            // no turns inputs -> the turns branch is skipped
  return Object.fromEntries(chips.map(c => [`${c.dataset.mob}:${c.dataset.v}`, c]));
}

test('opening the mobile sheet highlights the Subscription chip when that is the engine', () => {
  const c = mobChips();
  Object.assign(globalThis, { curMode: 'auto', curAgent: 'single', curModel: 'sonnet', curEngine: 'subscription' });
  loadFn('syncMobSheetFromDesktop')();
  assert.strictEqual(c['engine:subscription'].on, true, 'Subscription chip must be on');
  assert.strictEqual(c['engine:api'].on, false, 'API chip must be off');
});

test('opening the mobile sheet highlights the API chip when that is the engine', () => {
  const c = mobChips();
  Object.assign(globalThis, { curMode: 'auto', curAgent: 'single', curModel: 'sonnet', curEngine: 'api' });
  loadFn('syncMobSheetFromDesktop')();
  assert.strictEqual(c['engine:api'].on, true, 'API chip must be on');
  assert.strictEqual(c['engine:subscription'].on, false, 'Subscription chip must be off');
});

test('the engine branch leaves the other chip groups alone', () => {
  const c = mobChips();
  Object.assign(globalThis, { curMode: 'plan', curAgent: 'single', curModel: 'sonnet', curEngine: 'api' });
  loadFn('syncMobSheetFromDesktop')();
  assert.strictEqual(c['mode:plan'].on, true);
  assert.strictEqual(c['mode:auto'].on, false);
});

// ── 2. the first message waits for the engine default ───────────────────────────────

test('engineDefaultReady() holds until the version check has settled', async () => {
  globalThis.VERSION_WAIT_MS = 5000;     // far beyond the test: only the check may release it
  globalThis._engineUserPicked = false;  // the page always declares it; here nobody has clicked
  let release;
  globalThis._versionCheckDone = new Promise(r => { release = r; });
  let done = false;
  const p = loadFn('engineDefaultReady')().then(() => { done = true; });
  await tick();
  assert.strictEqual(done, false, 'must not resolve while the version check is pending');
  release();
  await p;
  assert.strictEqual(done, true);
});

test('engineDefaultReady() gives up after VERSION_WAIT_MS when /api/version never answers', async () => {
  globalThis.VERSION_WAIT_MS = 40;
  globalThis._engineUserPicked = false;
  globalThis._versionCheckDone = new Promise(() => {});   // never settles
  const t0 = Date.now();
  await loadFn('engineDefaultReady')();
  const waited = Date.now() - t0;
  assert.ok(waited >= 25, `must wait for the bound before giving up, waited ${waited}ms`);
  assert.ok(waited < 1000, `must not wait much past the bound, waited ${waited}ms`);
});

test('engineDefaultReady() never throws, even if the version check rejects', async () => {
  globalThis.VERSION_WAIT_MS = 5000;
  globalThis._engineUserPicked = false;
  globalThis._versionCheckDone = Promise.reject(new Error('boom'));
  await loadFn('engineDefaultReady')();    // would reject here if the error escaped
});

test('send() waits for engineDefaultReady() before it touches the socket', async () => {
  const toasts = [];
  let release;
  Object.assign(globalThis, {
    ws: null,                              // after the wait, send() bails out with a toast
    t: k => k,
    toast: (...a) => toasts.push(a),
    engineDefaultReady: () => new Promise(r => { release = r; }),
  });
  const p = loadFn('send')();
  await tick();
  assert.strictEqual(toasts.length, 0, 'send() acted before the engine default was known');
  release();
  await p;
  assert.strictEqual(toasts.length, 1, 'send() must continue once the default is known');
});

// ── 3. the default must actually be APPLIED, not merely awaited ─────────────────────
// Found while verifying 2. in a real browser: with /vendor/xterm.js slow, the page kept
// curEngine='api' although the server's configured default was 'subscription' — on a clean
// `main` too. checkVersion() called loadTerminalCapability() BEFORE it stored the default,
// and that helper lives in the LAST <script> block. A reply that lands before the parser
// reaches that block throws ReferenceError, which checkVersion's own `catch {}` swallows —
// so the default, the editor label, the chat defaults and loadBots() were all silently
// skipped. Waiting for a promise that settled without doing its job (2.) cures nothing.

function versionEnv(calls) {
  globalThis._globalDefaultEngine = 'api';
  globalThis._engineUserPicked = false;
  Object.assign(globalThis, {
    syncDefaultStar: () => calls.push('syncDefaultStar'),
    fetch: () => Promise.resolve({ json: () => ({ version: '7.18.4', tmuxAvailable: true, defaultEngine: 'subscription',
                                                  claudeCli: { available: true }, editor: { label: 'VS Code' } }) }),
    applyTmuxCapability: () => {},
    showNotification: () => {},
    t: k => k,
    loadBots: () => calls.push('loadBots'),
    _syncEditorLabels: () => {},
    resolveEngineForView: () => calls.push('resolveEngineForView'),
    loadChatDefaults: () => { calls.push('loadChatDefaults'); return Promise.resolve(); },
    applyChatDefaults: () => {},
    curProjectId: null, currentSessionId: null,
    $i: () => null,                          // no #versionBadge -> stops before the GitHub lookup
  });
}

test('checkVersion() applies the configured engine even when the terminal block is not parsed yet', async () => {
  const calls = [];
  versionEnv(calls);
  delete globalThis.loadTerminalCapability;  // the late block has not run: calling it is a ReferenceError
  await loadFn('checkVersion')();
  assert.strictEqual(globalThis._globalDefaultEngine, 'subscription', 'the configured default was never stored');
  assert.ok(calls.includes('resolveEngineForView'), 'curEngine was never re-resolved from it');
  assert.ok(calls.includes('loadBots') && calls.includes('loadChatDefaults'),
    `the rest of checkVersion() was skipped: ${calls.join(', ') || '(nothing ran)'}`);
});

test('checkVersion() still preloads the terminal capability once that block exists', async () => {
  const calls = [];
  versionEnv(calls);
  globalThis.loadTerminalCapability = () => calls.push('loadTerminalCapability');
  await loadFn('checkVersion')();
  assert.strictEqual(calls.filter(c => c === 'loadTerminalCapability').length, 1);
  assert.strictEqual(globalThis._globalDefaultEngine, 'subscription');
  delete globalThis.loadTerminalCapability;
});

// ── 4. what an independent review (codex + agy) found in the first version of 2. ────
// a) A click on an engine chip made BEFORE /api/version answered was overwritten by
//    resolveEngineForView() — and, because send() now waited for that, the message left on
//    the overwritten engine: the user chose Subscription, the turn ran on API.
// b) _versionCheckDone was the promise of the WHOLE checkVersion(), which ends by awaiting
//    api.github.com for the update badge. Behind a firewall that drops packets, every send()
//    paid the full VERSION_WAIT_MS.
// c) The default was stored only after calls that can throw (notification, loadBots).

const chip = v => ({ dataset: { v }, classList: { add() {}, remove() {} },
                     closest: () => ({ querySelectorAll: () => [] }) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('clicking an engine chip is remembered as the user\'s own choice (desktop and mobile)', () => {
  Object.assign(globalThis, { curEngine: 'api', syncDefaultStar() {}, updInd() {}, syncBtn() {}, saveUIState() {},
                              updateMobSubtitle() {}, _engineUserPicked: false });
  loadFn('setOpt')(chip('subscription'), 'engine');
  assert.strictEqual(globalThis._engineUserPicked, true, 'toolbar chip');
  globalThis._engineUserPicked = false;
  loadFn('setMobOpt')(chip('subscription'), 'engine');
  assert.strictEqual(globalThis._engineUserPicked, true, 'mobile chip');
});

test('picking a model or mode is NOT an engine choice', () => {
  Object.assign(globalThis, { curModel: 'sonnet', syncDefaultStar() {}, updInd() {}, _engineUserPicked: false });
  loadFn('setOpt')(chip('opus'), 'model');
  assert.strictEqual(globalThis._engineUserPicked, false);
});

test('resolveEngineForView() hands the engine back to the defaults', () => {
  Object.assign(globalThis, { _engineUserPicked: true, _curSessionRunEngine: null, _globalDefaultEngine: 'api',
                              _tmuxAvailable: true, syncBtn() {}, syncDefaultStar() {} });
  loadFn('resolveEngineForView')();
  assert.strictEqual(globalThis._engineUserPicked, false, 'a re-resolved view is derived state again');
});

test('engineDefaultReady() does not hold a user who already chose an engine', async () => {
  globalThis.VERSION_WAIT_MS = 5000;
  globalThis._versionCheckDone = new Promise(() => {});   // /api/version has not answered
  globalThis._engineUserPicked = true;
  const r = await Promise.race([loadFn('engineDefaultReady')().then(() => 'ready'), sleep(200).then(() => 'HELD')]);
  assert.strictEqual(r, 'ready');
});

test('checkVersion() stores the default but leaves an explicit choice alone', async () => {
  const calls = [];
  versionEnv(calls);
  globalThis._engineUserPicked = true;                    // the user already clicked API
  await loadFn('checkVersion')();                         // server default is 'subscription'
  assert.strictEqual(globalThis._globalDefaultEngine, 'subscription', 'the default is still recorded for new chats');
  assert.ok(!calls.includes('resolveEngineForView'), 'the explicit choice was overwritten');
  assert.ok(calls.includes('syncDefaultStar'), 'the default star must follow the new default');
});

test('checkVersion() stores the default even if a later step throws', async () => {
  const calls = [];
  versionEnv(calls);
  globalThis.loadBots = () => { throw new Error('boom'); };
  delete globalThis.loadTerminalCapability;
  await loadFn('checkVersion')();
  assert.strictEqual(globalThis._globalDefaultEngine, 'subscription');
  assert.ok(calls.includes('resolveEngineForView'));
});

test('checkVersion() settles without waiting for the GitHub release lookup', async () => {
  const calls = [];
  versionEnv(calls);
  const local = { version: '7.18.4', tmuxAvailable: true, defaultEngine: 'subscription', claudeCli: { available: true } };
  globalThis.fetch = url => String(url).includes('api.github.com')
    ? new Promise(() => {})                               // a firewall that drops the packets
    : Promise.resolve({ json: () => local });
  globalThis.$i = () => ({});                             // a #versionBadge exists -> reaches the lookup
  globalThis.window = {};
  globalThis._checkLatestRelease = loadFn('_checkLatestRelease');
  const r = await Promise.race([loadFn('checkVersion')().then(() => 'settled'), sleep(300).then(() => 'HUNG on GitHub')]);
  assert.strictEqual(r, 'settled');
});

test('an engine picked while /api/version is pending is the engine the message leaves on', async () => {
  // The reviewer's scenario end to end, on the real functions: pick Subscription, then the
  // server's default turns out to be API, then send.
  const frames = [];
  const box = () => ({ dataset: {}, style: {}, appendChild() {}, querySelector() { return { before() {} }; } });
  let reply;
  Object.assign(globalThis, {
    document: { querySelectorAll: () => [], createElement: box },
    localStorage: { removeItem() {} }, t: k => k, toast() {},
    inEl: { value: 'Use the engine I selected', style: {} },
    ws: { readyState: 1, send: s => frames.push(JSON.parse(s)) },
    _attachments: [], _clearAttachments() { globalThis._attachments = []; }, _closeAtPopup() {},
    curProjectId: 'p', currentSessionId: null, activeTabId: 'A', openTabs: [{ id: 'A', generating: true }],
    projects: [{ id: 'p' }], curEngine: 'api', _globalDefaultEngine: 'api', _curSessionRunEngine: null,
    _tmuxAvailable: true, _engineUserPicked: false,
    curAgent: 'single', curModel: 'sonnet', curMode: 'auto', curEffort: '', curWorkdir: '/p',
    activeSkills: new Set(), activeMcp: new Set(), replyTo: null, clearReply() {}, addMsg: box,
    setUserMsgText() {}, getTS: () => ({}), interruptSendMode: 'queue', autoSkillsMode: false,
    $i: id => (id === 'versionBadge' ? null : { value: '50' }),
    syncBtn() {}, syncDefaultStar() {}, updInd() {}, loadBots() {}, _syncEditorLabels() {},
    loadChatDefaults: () => Promise.resolve(), applyChatDefaults() {}, _editorLabel: 'VS Code',
    applyTmuxCapability: loadFn('applyTmuxCapability'), resolveEngineForView: loadFn('resolveEngineForView'),
    VERSION_WAIT_MS: 3000, engineDefaultReady: loadFn('engineDefaultReady'),
    fetch: () => new Promise(r => { reply = () => r({ json: () => ({ defaultEngine: 'api', tmuxAvailable: true }) }); }),
  });
  globalThis._versionCheckDone = loadFn('checkVersion')();          // still waiting for the server
  loadFn('setOpt')(chip('subscription'), 'engine');                 // the user clicks Subscription
  const pending = loadFn('send')();
  reply();
  await pending;
  assert.strictEqual(frames[0]?.engine, 'subscription', 'the message left on the engine the user chose');
  assert.strictEqual(globalThis.curEngine, 'subscription', 'and the toolbar still shows it');
});

// The behaviour above is only real if the page feeds the promise. Column-0 anchors match
// the statement itself and never a comment that merely describes it.
// (assert.ok on a boolean, not assert.match: a failing match prints the whole 1 MB page.)
test('boot hands the real checkVersion() promise to send()', () => {
  assert.ok(/^let _versionCheckDone = Promise\.resolve\(\);/m.test(HTML), 'declaration with a harmless default');
  assert.ok(/^_versionCheckDone = checkVersion\(\);/m.test(HTML), 'boot assigns the real promise');
  assert.ok(!/^checkVersion\(\);/m.test(HTML), 'a bare call would fetch /api/version twice and feed nothing');
});
