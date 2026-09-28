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
  const rw = () => false, ro = () => true;          // isReadOnly(dir)
  check('/Applications is fine', () => assert.strictEqual(installBlocker(exe('/Applications'), rw), null));
  check('~/Applications is fine', () => assert.strictEqual(installBlocker(exe('/Users/me/Applications'), rw), null));
  check('a dist-desktop build is fine — Squirrel updates it in place',
    () => assert.strictEqual(installBlocker(exe('/Users/me/proj/dist-desktop/mac-arm64'), rw), null));
  check('a Gatekeeper-translocated copy is blocked, whatever the probe says',
    () => assert.strictEqual(installBlocker(exe('/private/var/folders/ab/xy/T/AppTranslocation/0F1E-22/d'), rw), 'translocated'));
  check('a read-only volume (a mounted dmg) is blocked',
    () => assert.strictEqual(installBlocker(exe('/Volumes/Claude Code Studio 7.18.0-arm64'), ro), 'read-only'));
  check('the probe is asked about the folder that HOLDS the .app', () => {
    let asked = null;
    installBlocker(exe('/Applications'), (dir) => { asked = dir; return false; });
    assert.strictEqual(asked, '/Applications');
  });
  check('an unbundled dev run (electron .) is not blocked',
    () => assert.strictEqual(installBlocker('/Users/me/proj/node_modules/electron/dist/Electron', ro), null));

  // Measured on this machine: access(W_OK) on a mounted dmg → EROFS; on /private/var/root
  // → EACCES; on /System → EPERM. Only the first is a place the app cannot be updated
  // from. A folder the user lacks permission for — /Applications on a standard account —
  // is Squirrel's to deal with; "move the app to Applications" would be wrong advice
  // for an app that is already there.
  const fsWith = (code) => ({ constants: { W_OK: 2 }, accessSync() { if (code) { const e = new Error(code); e.code = code; throw e; } } });
  check('isReadOnlyDir: a read-only volume (EROFS) is read-only',
    () => assert.strictEqual(extract('isReadOnlyDir', { fs: fsWith('EROFS') })('/Volumes/x'), true));
  check('isReadOnlyDir: a permission denial (EACCES) is NOT',
    () => assert.strictEqual(extract('isReadOnlyDir', { fs: fsWith('EACCES') })('/Applications'), false));
  check('isReadOnlyDir: nor is EPERM',
    () => assert.strictEqual(extract('isReadOnlyDir', { fs: fsWith('EPERM') })('/Applications'), false));
  check('isReadOnlyDir: a writable folder is not',
    () => assert.strictEqual(extract('isReadOnlyDir', { fs: fsWith(null) })('/Applications'), false));
}

// ── progress and failures reach every window ─────────────────────────────────
// Same-origin child windows get the preload and the banner too, and the one that
// started the install need not be getAllWindows()[0].
console.log('\nupdate messages are broadcast:');
{
  const win = (destroyed) => ({ got: [], isDestroyed: () => destroyed, webContents: { send(ch, m) { this.owner.got.push([ch, m]); } } });
  const a = win(false), b = win(false), dead = win(true);
  for (const w of [a, b, dead]) w.webContents.owner = w;
  const broadcastUpdate = extract('broadcastUpdate', { BrowserWindow: { getAllWindows: () => [a, b, dead] } });
  broadcastUpdate('update:failed', 'boom');
  check('every live window receives it', () => {
    assert.deepStrictEqual(a.got, [['update:failed', 'boom']]);
    assert.deepStrictEqual(b.got, [['update:failed', 'boom']]);
  });
  check('a destroyed window is skipped', () => assert.deepStrictEqual(dead.got, []));
  check('sendUpdateLog and sendUpdateFailed both go through it', () => {
    assert.ok(/broadcastUpdate\('update:log'/.test(source('sendUpdateLog')));
    assert.ok(/broadcastUpdate\('update:failed'/.test(source('sendUpdateFailed')));
  });
}

// ── 3–4. getUpdater: listeners once, errors only during an install ───────────
console.log('\ngetUpdater():');
function harness() {
  // Electron's own autoUpdater — the one Squirrel drives.
  const native = new EventEmitter();
  const fake = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, quitCalls: 0,
    // What MacUpdater.quitAndInstall() does before Squirrel has the update: it adds
    // its own native listener, and nothing removes it if Squirrel then fails.
    quitAndInstall() { this.quitCalls++; native.on('update-downloaded', () => {}); },
  });
  const upd = { updater: null, inFlight: false, installing: false, nativeListeners: [] };
  const logs = [], failures = [];
  const getUpdater = extract('getUpdater', {
    require: (m) => {
      if (m === 'electron-updater') return { autoUpdater: fake };
      if (m === 'electron') return { autoUpdater: native };
      throw new Error('unexpected require ' + m);
    },
    upd,
    sendUpdateLog: (l) => logs.push(l),
    sendUpdateFailed: (m) => failures.push(m),
  });
  return { fake, native, upd, logs, failures, getUpdater };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
}
check('a downloaded update is installed', async () => {
  const h = harness(); h.getUpdater();
  h.upd.inFlight = true;
  h.fake.emit('update-downloaded', { version: '9.9.9' });
  await wait(1200);
  assert.strictEqual(h.fake.quitCalls, 1);
});
// Seen in an end-to-end run: the same update downloaded twice fired update-downloaded
// twice, and the second quitAndInstall() threw Squirrel's "The command is disabled and
// cannot be executed" out of a timer — an uncaught exception in the main process, which
// Electron shows the user as a crash dialog.
check('a second update-downloaded does not install twice', async () => {
  const h = harness(); h.getUpdater();
  h.upd.inFlight = true;
  h.fake.emit('update-downloaded', { version: '9.9.9' });
  h.fake.emit('update-downloaded', { version: '9.9.9' });
  await wait(1200);
  assert.strictEqual(h.fake.quitCalls, 1);
});
check('quitAndInstall() throwing becomes a reported failure, not a crash', async () => {
  const h = harness(); h.getUpdater();
  h.fake.quitAndInstall = () => { throw new Error('The command is disabled and cannot be executed'); };
  h.upd.inFlight = true;
  h.fake.emit('update-downloaded', { version: '9.9.9' });
  await wait(1200);                      // an escaping throw would crash this process here
  assert.deepStrictEqual(h.failures, ['The command is disabled and cannot be executed']);
  assert.strictEqual(h.upd.inFlight, false);
});
check('after a failed install the next attempt installs again', async () => {
  const h = harness(); h.getUpdater();
  h.upd.inFlight = true;
  h.fake.emit('update-downloaded', { version: '9.9.9' });
  await wait(1100);
  h.fake.emit('error', new Error('Squirrel: code signature did not match'));
  h.upd.inFlight = true;                 // the user pressed Retry
  h.fake.emit('update-downloaded', { version: '9.9.9' });
  await wait(1100);
  assert.strictEqual(h.fake.quitCalls, 2);
});
check('a failed Squirrel attempt leaves no library listener behind for the Retry', async () => {
  const h = harness(); h.getUpdater();
  for (let attempt = 1; attempt <= 3; attempt++) {
    h.upd.inFlight = true;
    h.fake.emit('update-downloaded', { version: '9.9.9' });
    await wait(1100);
    assert.strictEqual(h.native.listenerCount('update-downloaded'), 1, `attempt ${attempt}: before the failure`);
    h.fake.emit('error', new Error('Squirrel: code signature did not match'));
    assert.strictEqual(h.native.listenerCount('update-downloaded'), 0, `attempt ${attempt}: after the failure`);
  }
});

// ── checkUpdate trusts electron-updater's verdict ────────────────────────────
// It returns updateInfo for a release it has REJECTED too (staged rollout,
// minimumSystemVersion); comparing versions here offered an update whose
// downloadUpdate() then failed with "Please check update first" on every Retry.
console.log('\ncheckUpdate():');
function checkWith(result) {
  return extract('checkUpdate', {
    app: { getVersion: () => '7.18.0' },
    process: { platform: 'darwin' },
    getUpdater: () => ({ checkForUpdates: async () => result }),
    installBlocker: () => null, appExePath: () => '', isReadOnlyDir: () => false,
  })();
}
check('a newer release electron-updater rejected is not offered', async () => {
  const r = await checkWith({ isUpdateAvailable: false, updateInfo: { version: '99.0.0' } });
  assert.strictEqual(r.available, false);
});
check('an accepted release is offered', async () => {
  const r = await checkWith({ isUpdateAvailable: true, updateInfo: { version: '7.19.0' } });
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.version, '7.19.0');
});
check('an unpackaged run (null result) offers nothing', async () => {
  const r = await checkWith(null);
  assert.strictEqual(r.available, false);
});

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
  const upd = { updater: null, inFlight: false, installing: false, nativeListeners: [] };
  let downloads = 0;
  const startUpdate = extract('startUpdate', {
    process: { platform },
    installBlocker: () => blocker,
    appExePath: () => '/x/Claude Code Studio.app/Contents/MacOS/Claude Code Studio',
    isReadOnlyDir: () => false,
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
  assert.ok(/broadcastUpdate\('update:failed'/.test(MAIN_CODE));
});

// The banner itself, RUN in a vm against a minimal DOM — the same technique as
// test/terminal-keys.test.js. Source checks cannot tell a wired handler from a dead one.
function runBanner({ check: checkRes, start: startRes, tickSpinner = false }) {
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
    start: () => (startRes instanceof Error ? Promise.reject(startRes) : Promise.resolve(startRes)),
    onLog: (cb) => handlers.log.push(cb),
    onFailed: (cb) => handlers.failed.push(cb),
  };
  const doc = { body: mk(), head: mk(), createElement: mk, getElementById: () => null };
  const js = BANNER.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>$/, '');
  vm.runInNewContext(js, {
    window: { electronAPI: { update: api } }, document: doc,
    // tickSpinner fires each interval once, at once: the spinner's first tick
    // is what overwrites the title with "Updating… 0s".
    setInterval: (fn) => { if (tickSpinner) fn(); return 1; }, clearInterval: () => {}, Date, Math, Promise,
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
check('banner: a click refused as blocked puts the title back (no frozen "Updating…")', async () => {
  const b = runBanner({ check: { available: true, version: '9.0.0' }, start: { installBlocked: 'read-only' }, tickSpinner: true });
  await tick();
  b.btn.onclick();
  assert.strictEqual(b.msgEl.textContent, 'upd.updating', 'harness: the spinner tick did not run');
  await tick();
  assert.strictEqual(b.msgEl.textContent, 'upd.new_version');
  assert.strictEqual(b.logEl.textContent, 'upd.move_to_apps');
});
check('banner: a rejected start() turns into Retry instead of spinning forever', async () => {
  const b = runBanner({ check: { available: true, version: '9.0.0' }, start: new Error('IPC channel closed') });
  await tick();
  b.btn.onclick();
  await tick(); await tick();
  assert.strictEqual(b.msgEl.textContent, 'upd.failed');
  assert.strictEqual(b.btn.textContent, 'upd.retry');
  assert.strictEqual(b.logEl.textContent, 'IPC channel closed');
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
