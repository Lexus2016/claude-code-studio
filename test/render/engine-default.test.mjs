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
  globalThis._versionCheckDone = new Promise(() => {});   // never settles
  const t0 = Date.now();
  await loadFn('engineDefaultReady')();
  const waited = Date.now() - t0;
  assert.ok(waited >= 25, `must wait for the bound before giving up, waited ${waited}ms`);
  assert.ok(waited < 1000, `must not wait much past the bound, waited ${waited}ms`);
});

test('engineDefaultReady() never throws, even if the version check rejects', async () => {
  globalThis.VERSION_WAIT_MS = 5000;
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
  Object.assign(globalThis, {
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

// The behaviour above is only real if the page feeds the promise. Column-0 anchors match
// the statement itself and never a comment that merely describes it.
// (assert.ok on a boolean, not assert.match: a failing match prints the whole 1 MB page.)
test('boot hands the real checkVersion() promise to send()', () => {
  assert.ok(/^let _versionCheckDone = Promise\.resolve\(\);/m.test(HTML), 'declaration with a harmless default');
  assert.ok(/^_versionCheckDone = checkVersion\(\);/m.test(HTML), 'boot assigns the real promise');
  assert.ok(!/^checkVersion\(\);/m.test(HTML), 'a bare call would fetch /api/version twice and feed nothing');
});
