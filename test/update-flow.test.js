// The desktop app's in-app update (electron/main.js + the banner in public/index.html).
//
// Every OS now updates through electron-updater. On macOS that is Squirrel.Mac, which
// needs a Developer ID signed app (docs/electron-desktop/MAC-SIGNING.md) and replaced
// the app-triggered `brew upgrade --cask`. What this file pins is where Squirrel fails
// quietly, and where the brew flow it replaced used to loop:
//
//   1. Squirrel.Mac closes every window BEFORE it quits. The close-to-tray handler
//      hides a window unless app.isQuiting is set, which cancels that quit: the
//      update is staged, the app never restarts, and the banner spins forever.
//   2. Squirrel replaces the bundle in place. It cannot do that from a mounted dmg or
//      from a Gatekeeper-translocated copy (both read-only), so it has to be caught
//      before the download and turned into "move the app to Applications".
//   3. electron-updater's `error` event fires for a failed CHECK too (latest-mac.yml
//      is uploaded ~8 min after the release is published). Only an error during an
//      install the user started may turn the banner into "Update failed".
//   4. Listeners are registered once. Registering them per click stacked a new set on
//      every Retry, so the second attempt logged and installed twice.
//
// Run: node test/update-flow.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let pass = 0, fail = 0;
const pending = [];
function check(label, fn) {
  const done = (e) => {
    if (e) { fail++; console.error(`  FAIL ${label} — ${e.message}`); }
    else { pass++; console.log(`  ok   ${label}`); }
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(() => done(), done));
    else done();
  } catch (e) { done(e); }
}

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
// Code only: the comments explain what was removed and would match its names.
const MAIN_CODE = MAIN.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

// ─── Extract a top-level function by name ────────────────────────────────────
// A guard that cannot find its target must fail loudly, never quietly pass.
function source(name) {
  const at = MAIN.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notStrictEqual(at, -1, `function ${name} is gone — update this test`);
  let i = MAIN.indexOf('(', at), paren = 0;
  for (; i < MAIN.length; i++) {
    if (MAIN[i] === '(') paren++;
    else if (MAIN[i] === ')' && --paren === 0) break;
  }
  const open = MAIN.indexOf('{', i);
  let depth = 0, end = -1;
  for (let j = open; j < MAIN.length; j++) {
    if (MAIN[j] === '{') depth++;
    else if (MAIN[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  assert.notStrictEqual(end, -1, `unbalanced braces in ${name}`);
  return MAIN.slice(at, end);
}
// Build `name` with the given closure variables bound to the values passed.
function extract(name, env = {}) {
  const keys = Object.keys(env);
  return new Function(...keys, `${source(name)}; return ${name};`)(...keys.map(k => env[k]));
}

// ── 1. brew is gone ──────────────────────────────────────────────────────────
console.log('\nno Homebrew in the update path:');
for (const gone of ['brew', 'fetchTapCaskVersion', 'parseCaskVersion', 'buildUpgradeShell', 'CASK_NAME', 'brewManagedPath']) {
  check(`main.js no longer references ${gone}`, () => assert.ok(!new RegExp(`\\b${gone}\\b`).test(MAIN_CODE)));
}
check('checkUpdate and startUpdate both go through getUpdater() on every OS', () => {
  for (const fn of ['checkUpdate', 'startUpdate']) {
    const src = source(fn);
    assert.ok(/getUpdater\(\)/.test(src), `${fn} does not use getUpdater()`);
    assert.ok(!/require\('electron-updater'\)/.test(src), `${fn} requires electron-updater itself`);
  }
});

// ── 2. installBlocker ────────────────────────────────────────────────────────
console.log('\nwhere Squirrel can replace the bundle:');
{
  const installBlocker = extract('installBlocker', { path });
  const exe = (dir) => `${dir}/Claude Code Studio.app/Contents/MacOS/Claude Code Studio`;
  const writable = () => true, readOnly = () => false;
  check('/Applications is fine', () => assert.strictEqual(installBlocker(exe('/Applications'), writable), null));
  check('~/Applications is fine', () => assert.strictEqual(installBlocker(exe('/Users/me/Applications'), writable), null));
  check('a dist-desktop build is fine — Squirrel updates it in place',
    () => assert.strictEqual(installBlocker(exe('/Users/me/proj/dist-desktop/mac-arm64'), writable), null));
  check('a Gatekeeper-translocated copy is blocked, whatever the write probe says',
    () => assert.strictEqual(installBlocker(exe('/private/var/folders/ab/xy/T/AppTranslocation/0F1E-22/d'), writable), 'translocated'));
  check('a read-only location (a mounted dmg) is blocked',
    () => assert.strictEqual(installBlocker(exe('/Volumes/Claude Code Studio 7.18.0-arm64'), readOnly), 'read-only'));
  check('the write probe is asked about the folder that HOLDS the .app', () => {
    let asked = null;
    installBlocker(exe('/Applications'), (dir) => { asked = dir; return true; });
    assert.strictEqual(asked, '/Applications');
  });
  check('an unbundled dev run (electron .) is not blocked',
    () => assert.strictEqual(installBlocker('/Users/me/proj/node_modules/electron/dist/Electron', readOnly), null));
}

// ── 3–4. getUpdater: listeners once, errors only during an install ───────────
console.log('\ngetUpdater():');
function harness() {
  const fake = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, quitCalls: 0,
    quitAndInstall() { this.quitCalls++; },
  });
  const upd = { updater: null, inFlight: false };
  const logs = [], failures = [];
  const getUpdater = extract('getUpdater', {
    require: (m) => { assert.strictEqual(m, 'electron-updater'); return { autoUpdater: fake }; },
    upd,
    sendUpdateLog: (l) => logs.push(l),
    sendUpdateFailed: (m) => failures.push(m),
  });
  return { fake, upd, logs, failures, getUpdater };
}
{
  const h = harness();
  const a = h.getUpdater(), b = h.getUpdater();
  check('returns one instance', () => assert.strictEqual(a, b));
  check('registers each listener exactly once', () => {
    for (const ev of ['error', 'download-progress', 'update-downloaded']) {
      assert.strictEqual(h.fake.listenerCount(ev), 1, `${ev}: ${h.fake.listenerCount(ev)} listeners`);
    }
  });
  check('never downloads or installs on its own', () => {
    assert.strictEqual(h.fake.autoDownload, false);
    assert.strictEqual(h.fake.autoInstallOnAppQuit, false);
  });
  check('an error while only CHECKING is not reported as a failed update', () => {
    h.upd.inFlight = false;
    h.fake.emit('error', new Error('Cannot find latest-mac.yml'));
    assert.deepStrictEqual(h.failures, []);
  });
  check('an error during an install is reported, and ends the install', () => {
    h.upd.inFlight = true;
    h.fake.emit('error', new Error('Code signature did not match'));
    assert.deepStrictEqual(h.failures, ['Code signature did not match']);
    assert.strictEqual(h.upd.inFlight, false);
  });
  check('a downloaded update is installed', () => new Promise((resolve, reject) => {
    h.fake.emit('update-downloaded', { version: '9.9.9' });
    setTimeout(() => {
      try { assert.strictEqual(h.fake.quitCalls, 1); resolve(); } catch (e) { reject(e); }
    }, 1200);
  }));
}

// ── 1 (again). the quit must not be eaten by close-to-tray ───────────────────
console.log('\nSquirrel.Mac can quit the app:');
check('before-quit-for-update sets app.isQuiting before the windows close', () => {
  const m = /autoUpdater\.on\('before-quit-for-update',[^\n]*\n?[^\n]*app\.isQuiting = true/.exec(MAIN_CODE);
  assert.ok(m, 'no before-quit-for-update → app.isQuiting = true');
  assert.ok(/require\('electron'\)/.test(MAIN_CODE), 'must be Electron\'s own autoUpdater — that is the one Squirrel drives');
});
check('the close-to-tray handler still honours app.isQuiting', () => {
  assert.ok(/if \(!app\.isQuiting && trayReady\) \{ e\.preventDefault\(\);/.test(MAIN_CODE));
});

// ── startUpdate ──────────────────────────────────────────────────────────────
console.log('\nstartUpdate():');
function start({ platform = 'darwin', blocker = null, download = () => Promise.resolve() } = {}) {
  const upd = { updater: null, inFlight: false };
  let downloads = 0;
  const startUpdate = extract('startUpdate', {
    process: { platform },
    installBlocker: () => blocker,
    appExePath: () => '/x/Claude Code Studio.app/Contents/MacOS/Claude Code Studio',
    canWriteDir: () => true,
    getUpdater: () => ({ downloadUpdate: () => { downloads++; return download(); } }),
    upd,
  });
  return { startUpdate, upd, downloads: () => downloads };
}
check('a blocked macOS install is refused before anything is downloaded', async () => {
  const s = start({ blocker: 'translocated' });
  const r = await s.startUpdate();
  assert.strictEqual(r.installBlocked, 'translocated');
  assert.strictEqual(s.downloads(), 0);
  assert.strictEqual(s.upd.inFlight, false);
});
check('the macOS blocker is not consulted on Windows/Linux', async () => {
  const s = start({ platform: 'win32', blocker: 'read-only' });
  const r = await s.startUpdate();
  assert.strictEqual(r.started, true);
  assert.strictEqual(s.downloads(), 1);
});
check('an install in progress is marked in flight', async () => {
  const s = start();
  const r = await s.startUpdate();
  assert.strictEqual(r.started, true);
  assert.strictEqual(s.upd.inFlight, true);
});
check('a failed download is thrown to the IPC handler and ends the install', async () => {
  const s = start({ download: () => Promise.reject(new Error('net::ERR_CONNECTION_RESET')) });
  await assert.rejects(s.startUpdate(), /ERR_CONNECTION_RESET/);
  assert.strictEqual(s.upd.inFlight, false);
});

// ── the banner ───────────────────────────────────────────────────────────────
console.log('\nthe update banner (index.html) and its bridge (preload.js):');
const BANNER = (/<!-- ccs-desktop-update-ui[\s\S]*?<\/script>/.exec(HTML) || [''])[0];
check('the banner block exists', () => assert.ok(BANNER.length > 500));
check('the brew "copy this command" fallback is gone', () => {
  assert.ok(!/res\.fallback|upd\.copy_cmd|upd\.via_terminal|upd\.copied/.test(BANNER));
});
check('a blocked install shows "move to Applications" and no button', () => {
  const body = (/function showBlocked\(\)\{([\s\S]*?)\n  \}/.exec(BANNER) || [])[1];
  assert.ok(body, 'no showBlocked()');
  assert.ok(/btn\.style\.display\s*=\s*'none'/.test(body), 'showBlocked leaves the button up');
  assert.ok(/upd\.move_to_apps/.test(body), 'showBlocked does not say what to do');
  // Both the periodic check and the click route a blocked install there.
  assert.ok(/r\.installBlocked\) showBlocked\(\)/.test(BANNER), 'check() ignores installBlocked');
  assert.ok(/res\.installBlocked\) showBlocked\(\)/.test(BANNER), 'onUpdate() ignores installBlocked');
});
check('main → preload carry a failure that happens after start() has answered', () => {
  assert.ok(/onFailed:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('update:failed'/.test(PRELOAD));
  assert.ok(/webContents\.send\('update:failed'/.test(MAIN_CODE));
});

// The banner itself, RUN in a vm against a minimal DOM — the same technique as
// test/terminal-keys.test.js. Source checks cannot tell a wired handler from a dead one.
function runBanner({ check: checkRes, start: startRes }) {
  const vm = require('vm');
  const els = [];
  const mk = () => {
    const e = { style: {}, textContent: '', disabled: false, onclick: null, children: [],
      appendChild(c) { this.children.push(c); } };
    els.push(e);
    return e;
  };
  const handlers = { log: [], failed: [] };
  const api = {
    check: () => Promise.resolve(checkRes),
    start: () => Promise.resolve(startRes),
    onLog: (cb) => handlers.log.push(cb),
    onFailed: (cb) => handlers.failed.push(cb),
  };
  const doc = { body: mk(), head: mk(), createElement: mk, getElementById: () => null };
  const js = BANNER.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>$/, '');
  vm.runInNewContext(js, {
    window: { electronAPI: { update: api } }, document: doc,
    setInterval: () => 0, clearInterval: () => {}, Date, Math, Promise,
  });
  // build() creates, in order: bar, msg, btn, log, close, spinner.
  const [bar, msgEl, btn, logEl] = els.slice(2);
  return { bar, msgEl, btn, logEl, handlers };
}
const tick = () => new Promise((r) => setImmediate(r));

check('banner: a blocked install says "move to Applications" and offers no button', async () => {
  const b = runBanner({ check: { available: true, version: '9.0.0', installBlocked: 'translocated' } });
  await tick();
  assert.strictEqual(b.bar.style.display, 'flex');
  assert.strictEqual(b.btn.style.display, 'none');
  assert.strictEqual(b.logEl.textContent, 'upd.move_to_apps');
});
check('banner: a failure reported after the download turns it into Retry', async () => {
  const b = runBanner({ check: { available: true, version: '9.0.0' }, start: { started: true } });
  await tick();
  assert.notStrictEqual(b.btn.style.display, 'none', 'no Update button');
  b.btn.onclick();
  await tick();
  assert.strictEqual(b.handlers.failed.length, 1, 'onFailed subscribed once, at init');
  b.handlers.failed[0]('code signature did not match');
  assert.strictEqual(b.msgEl.textContent, 'upd.failed');
  assert.strictEqual(b.btn.textContent, 'upd.retry');
  assert.strictEqual(b.btn.style.display, '');
  assert.strictEqual(b.logEl.textContent, 'code signature did not match');
});
check('banner: a stray failure while idle changes nothing', async () => {
  const b = runBanner({ check: { available: true, version: '9.0.0' } });
  await tick();
  const before = b.msgEl.textContent;
  b.handlers.failed[0]('late error');
  assert.strictEqual(b.msgEl.textContent, before);
});
check('banner: clicking twice does not stack log handlers', async () => {
  const b = runBanner({ check: { available: true, version: '9.0.0' }, start: { error: 'x' } });
  await tick();
  b.btn.onclick(); await tick();
  b.btn.onclick(); await tick();
  assert.strictEqual(b.handlers.log.length, 1);
});
check('every language has the new string and none keeps the removed ones', () => {
  const langs = HTML.match(/['"]upd\.available['"]\s*:/g) || [];
  const moves = HTML.match(/['"]upd\.move_to_apps['"]\s*:/g) || [];
  assert.ok(langs.length >= 5, `found ${langs.length} languages`);
  assert.strictEqual(moves.length, langs.length, `upd.move_to_apps in ${moves.length} of ${langs.length}`);
  assert.ok(!/['"]upd\.(copy_cmd|via_terminal|copied)['"]\s*:/.test(HTML), 'removed keys still translated');
});

Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
