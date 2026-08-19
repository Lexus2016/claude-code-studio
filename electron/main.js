'use strict';

// Claude Code Studio — Electron desktop shell.
// One codebase, two launchers: this process forks the existing server.js
// (unchanged) and renders it in a native window. Web mode (`node server.js`)
// is unaffected — none of this runs there.

const { app, BrowserWindow, shell, ipcMain, utilityProcess, dialog, Menu, Tray, nativeImage, Notification } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const https = require('https');
const { execFileSync, spawn } = require('child_process');

let serverProc = null;
let serverPort = null;
let tray = null;
let trayReady = false;
let mainWindow = null;

// GUI launches (Finder/Dock) inherit a minimal PATH — make sure the common
// locations for `claude`, `brew`, `node`, `git` are present before we fork the
// server, otherwise the forked server can't find the `claude` CLI.
function augmentPath() {
  const home = os.homedir();
  const extra = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, 'bin'),
  ];
  const cur = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  process.env.PATH = Array.from(new Set([...cur, ...extra])).join(path.delimiter);
}

// The whole app is a front-end for the `claude` CLI. Detect it up front and,
// if missing, tell the user exactly how to install it instead of silently
// failing the first chat.
function findClaude() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const out = String(execFileSync(probe, ['claude'], { encoding: 'utf8' })).trim().split(/\r?\n/)[0];
    if (out) return out;
  } catch (_) {}
  return null;
}

async function ensureClaude() {
  if (findClaude()) return;
  const choice = await dialog.showMessageBox({
    type: 'warning',
    title: 'Claude CLI not found',
    message: 'Claude Code Studio needs the “claude” command-line tool.',
    detail: 'It was not found on your system. Install it, then restart the app:\n\n    npm install -g @anthropic-ai/claude-code\n\nThe app will still open, but chatting will not work until “claude” is installed and on your PATH.',
    buttons: ['Open install guide', 'Continue anyway', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response === 0) shell.openExternal('https://docs.claude.com/en/docs/claude-code');
  if (choice.response === 2) { app.isQuiting = true; app.quit(); throw new Error('quit: claude missing'); }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// Reuse the same loopback port across launches. The renderer origin is
// http://127.0.0.1:<port>; with a fresh random port every launch (plain
// getFreePort) the origin changed too, wiping ALL origin-scoped localStorage
// (project tabs, language, font size, draft, reasoning effort) on every
// restart. Persisting the port keeps the origin — and that state — stable.
async function getStablePort() {
  const portFile = path.join(app.getPath('userData'), 'desktop-port');
  let saved = 0;
  try { saved = parseInt(String(fs.readFileSync(portFile, 'utf8')).trim(), 10) || 0; } catch (_) {}
  if (saved >= 1024 && saved <= 65535 && (await isPortFree(saved))) return saved;
  const port = await getFreePort();
  try { fs.writeFileSync(portFile, String(port)); } catch (_) {}
  return port;
}

function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/health', timeout: 2000 },
        (res) => { res.resume(); return res.statusCode === 200 ? resolve() : retry(); }
      );
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('server did not become healthy in time'));
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

function startServer(port) {
  const appDir = app.getPath('userData');
  const serverPath = path.join(__dirname, '..', 'server.js');
  serverProc = utilityProcess.fork(serverPath, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      APP_DIR: appDir,                 // user data lives in OS userData dir
      WORKDIR: path.join(appDir, 'workspace'),
      CCS_DESKTOP: '1',
      NODE_ENV: process.env.NODE_ENV || 'production',
      // NOTE: do NOT set ELECTRON_RUN_AS_NODE here — it would force the
      // utilityProcess into pure-Node mode and crash on Electron's own utility
      // flags. The forked server uses the system `node` (NODE_CMD default) for
      // its MCP helpers. Packaged builds without a system node are a separate
      // hardening item (electron-as-node via per-spawn ELECTRON_RUN_AS_NODE).
    },
  });
  serverProc.on('exit', (code) => {
    serverProc = null;
    if (code !== 0 && !app.isQuiting) console.error('[electron] server exited with code', code);
  });
}

function stopServer() {
  if (serverProc) { try { serverProc.kill(); } catch (_) {} serverProc = null; }
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'Claude Code Studio',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // External links open in the user's browser, not inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow = win;
  // Closing the window does NOT quit the app — it hides to the tray so the forked
  // server.js (and its scheduler / processQueue loop) keeps running and scheduled
  // tasks keep firing. A real quit sets app.isQuiting (tray "Quit" / before-quit),
  // which lets this handler fall through so the window actually closes.
  win.on('close', (e) => {
    // Hide to tray only when a tray exists to reopen / quit from. Without a working
    // tray (e.g. some Linux DEs) fall through and close normally, so the user is never
    // stranded with no window and no tray.
    if (!app.isQuiting && trayReady) { e.preventDefault(); win.hide(); maybeHintBackground(); }
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  await win.loadURL(`http://127.0.0.1:${serverPort}`);
  return win;
}

// Bring the window back from the tray (or recreate it if it was destroyed).
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  else if (serverProc) createWindow().catch((e) => console.error('[electron] reopen failed:', e.message));
}

// Menu-bar / system-tray icon: the visible anchor for the background app and the
// place the real "Quit" lives once the window can be closed without quitting.
function createTray() {
  if (tray) return;
  try {
    // The icon must live under electron/ (packed into app.asar). build/ is
    // electron-builder's buildResources dir and is NOT packed — a path there resolves
    // to an empty image in a packaged app (dev works only because it reads live files).
    let img = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
    if (!img.isEmpty()) img = img.resize({ width: 18, height: 18 });
    tray = new Tray(img);
    tray.setToolTip('Claude Code Studio — running in background');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Claude Code Studio', click: showMainWindow },
      { type: 'separator' },
      { label: 'Scheduler runs in the background', enabled: false },
      { type: 'separator' },
      { label: 'Quit Claude Code Studio', click: () => { app.isQuiting = true; stopServer(); app.quit(); } },
    ]));
    tray.on('click', showMainWindow);
    trayReady = true;
  } catch (e) {
    // No usable tray on this platform → keep default quit-on-close so the user can exit.
    console.error('[electron] tray unavailable; window close will quit the app:', e.message);
    trayReady = false;
  }
}

// One-time heads-up the first time the window is hidden, so closing it doesn't feel
// like the app vanished while it is in fact still running (by design) in the tray.
function maybeHintBackground() {
  try {
    const flag = path.join(app.getPath('userData'), '.bg-hint-shown');
    if (fs.existsSync(flag)) return;
    fs.writeFileSync(flag, '1');
    if (Notification.isSupported()) {
      new Notification({
        title: 'Claude Code Studio is still running',
        body: 'It stays in the menu bar so your scheduled tasks keep firing. Use the icon’s “Quit” to stop it completely.',
      }).show();
    }
  } catch (_) {}
}

async function boot() {
  augmentPath();
  await ensureClaude();
  serverPort = await getStablePort();
  startServer(serverPort);
  await waitForHealth(serverPort);
  await createWindow();
  setupMenu();
  createTray();
}

// ─── Updates ────────────────────────────────────────────────────────────────
// Windows/Linux: electron-updater (GitHub feed). macOS: app-triggered
// `brew upgrade --cask` (we never use Squirrel.Mac, so no Apple signing needed).
const GH_OWNER = 'Lexus2016';
const GH_REPO = 'claude-code-studio';
const CASK_NAME = 'claude-code-studio';

function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if (pa[i] > pb[i]) return true; if (pa[i] < pb[i]) return false; }
  return false;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/releases/latest`,
      headers: { 'User-Agent': 'claude-code-studio', Accept: 'application/vnd.github+json' },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('GitHub HTTP ' + res.statusCode)); }
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub request timeout')); });
  });
}

function findBrew() {
  for (const b of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    try { if (fs.existsSync(b)) return b; } catch (_) {}
  }
  try { return String(execFileSync('which', ['brew'], { encoding: 'utf8' })).trim() || null; } catch (_) { return null; }
}

function sendUpdateLog(line) {
  const w = BrowserWindow.getAllWindows()[0];
  if (w && !w.isDestroyed()) w.webContents.send('update:log', String(line));
}

async function checkUpdate() {
  const currentVersion = app.getVersion();
  if (process.platform === 'darwin') {
    const rel = await fetchLatestRelease();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    return { platform: 'darwin', currentVersion, version, available: !!(version && semverGt(version, currentVersion)) };
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const r = await autoUpdater.checkForUpdates();
  const version = r && r.updateInfo && r.updateInfo.version;
  return { platform: process.platform, currentVersion, version, available: !!(version && semverGt(version, currentVersion)) };
}

// Run one brew step with the app still OPEN, streaming its output to the update
// bar. Resolves { ok } — a step is never allowed to reject and strand the UI.
// `optional` marks a step whose failure is expected on older Homebrew (`trust`).
function runBrewStep(brew, args, label, { optional = false, timeoutMs = 900000 } = {}) {
  return new Promise((resolve) => {
    sendUpdateLog(label);
    const child = spawn(brew, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    let timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, timeoutMs);
    const onData = (buf) => {
      // brew redraws download progress with \r; keep only the newest fragment so
      // the one-line bar shows a live percentage instead of a growing wall.
      const parts = String(buf).split(/[\r\n]+/).filter((x) => x.trim());
      if (parts.length) { last = parts[parts.length - 1].trim(); sendUpdateLog(label + ' ' + last); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => { clearTimeout(timer); resolve({ ok: optional, err: 'spawn failed' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: optional || code === 0, code, last });
    });
  });
}

async function startUpdate() {
  if (process.platform === 'darwin') {
    const brew = findBrew();
    if (!brew) return { fallback: true, command: `brew install --cask ${CASK_NAME}`, reason: 'brew-not-found' };
    let managed = false;
    try { execFileSync(brew, ['list', '--cask', CASK_NAME], { stdio: 'ignore' }); managed = true; } catch (_) {}
    if (!managed) return { fallback: true, command: `brew install --cask ${CASK_NAME}`, reason: 'not-brew-managed' };
    const tap = `${GH_OWNER.toLowerCase()}/${GH_REPO}`;

    // ── Phase A: everything that does NOT touch the app bundle ──────────────
    // Runs with the window still open so the user watches real progress. This is
    // the slow part — a tap refresh plus a ~150MB download — and it used to happen
    // after the app had already vanished, which is why a working update was
    // indistinguishable from a broken button.
    //
    // Homebrew 6.0+ refuses to load a cask from a third-party tap until it is
    // trusted. On older Homebrew there is no `trust` subcommand, so the step is
    // optional: its failure must not abort the update.
    await runBrewStep(brew, ['trust', tap], 'Trusting tap…', { optional: true, timeoutMs: 60000 });
    // `brew update` FIRST: a stale local tap clone otherwise keeps brew pinned to
    // the installed version, so `brew upgrade` is a no-op while the in-app check
    // (which reads the GitHub release) keeps re-offering the same version — an
    // endless update loop. Do NOT set HOMEBREW_NO_AUTO_UPDATE: it suppresses
    // exactly that tap refresh.
    const upd = await runBrewStep(brew, ['update'], 'Refreshing Homebrew…', { timeoutMs: 300000 });
    if (!upd.ok) return { error: 'brew update failed' + (upd.last ? ': ' + upd.last : '') };
    // Download into brew's cache while we are still alive. `brew upgrade` below
    // then finds it cached and only has to verify, swap and relaunch.
    const fetched = await runBrewStep(brew, ['fetch', '--cask', CASK_NAME], 'Downloading update…');
    if (!fetched.ok) return { error: 'download failed' + (fetched.last ? ': ' + fetched.last : '') };

    // ── Phase B: the swap ──────────────────────────────────────────────────
    // This one cannot keep the app open: the cask carries `uninstall quit:`, and
    // brew must quit us to replace our own bundle. It therefore has to outlive
    // this process — a detached shell in its own process group (verified: it
    // survives app.quit(), see the comment on unref below).
    // Relaunch whether the upgrade succeeds or fails — the app must never just
    // vanish; on failure show a notification instead of silently reopening the
    // SAME version, which is what makes a failed update look like a broken button.
    // Output goes to a log file: without it a failed upgrade leaves no trace at
    // all, and "it didn't update" cannot be diagnosed afterwards.
    const logPath = path.join(app.getPath('userData'), 'update.log');
    const q = (x) => String(x).replace(/'/g, `'\\''`);
    const sh = `exec >> '${q(logPath)}' 2>&1; echo "=== $(date) upgrading ${CASK_NAME} ==="; `
      + `if '${q(brew)}' upgrade --cask ${CASK_NAME}; then echo OK; open -a "Claude Code Studio"; `
      + `else echo FAILED; osascript -e 'display notification "Update failed — see update.log, or run: brew upgrade --cask ${CASK_NAME}" with title "Claude Code Studio"'; open -a "Claude Code Studio"; fi`;
    sendUpdateLog('Installing — the app will restart…');
    const child = spawn('/bin/sh', ['-c', sh], { detached: true, stdio: 'ignore' });
    child.unref();
    // detached + unref puts the shell in its own process group, so it keeps
    // running once this process exits; stopServer() only kills the server child
    // by pid and cannot reach it.
    setTimeout(() => { app.isQuiting = true; stopServer(); app.quit(); }, 1500);
    return { started: true, via: 'brew', log: logPath };
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.on('download-progress', (p) => sendUpdateLog(`Downloading… ${Math.round(p.percent)}%`));
  autoUpdater.on('error', (e) => sendUpdateLog('Update error: ' + e.message));
  autoUpdater.on('update-downloaded', () => {
    sendUpdateLog('Downloaded — restarting to install…');
    setTimeout(() => { app.isQuiting = true; stopServer(); autoUpdater.quitAndInstall(); }, 1000);
  });
  await autoUpdater.downloadUpdate();
  return { started: true, via: 'electron-updater' };
}

ipcMain.handle('update:check', async () => {
  try { return await checkUpdate(); } catch (e) { return { available: false, error: e.message, currentVersion: app.getVersion() }; }
});
ipcMain.handle('update:start', async () => {
  try { return await startUpdate(); } catch (e) { return { error: e.message }; }
});

ipcMain.handle('app:getVersion', () => app.getVersion());

// ─── Import data from the CLI / web version ─────────────────────────────────
// Native menu item to migrate an existing studio's chat history + settings into
// the desktop app's userData. Safe: validates the source, backs up current data,
// copies with the server stopped, then restarts.
//   data/   — chats.db (history), projects.json, remote-hosts.json, hosts.key, uploads/
//   skills/ — user-added skill files
//   config.json — MCP servers + active skills
// Intentionally NOT imported: .env (PORT/WORKDIR are set by the desktop shell and
// would conflict) and workspace/ (working files, potentially large — not config).
const IMPORT_DIRS = ['data', 'skills'];
const IMPORT_FILES = ['config.json'];

function copyIfExists(src, dst) {
  try {
    if (!fs.existsSync(src)) return false;
    fs.cpSync(src, dst, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.error('[import] copy failed', src, '->', dst, e.message);
    return false;
  }
}

async function importFromCli() {
  const win = BrowserWindow.getAllWindows()[0] || null;
  const pick = await dialog.showOpenDialog(win, {
    title: 'Import from CLI / web Claude Code Studio',
    message: 'Select the folder of your existing studio (it contains data/ and config.json)',
    properties: ['openDirectory'],
    buttonLabel: 'Choose folder',
  });
  if (pick.canceled || !pick.filePaths[0]) return;
  const src = pick.filePaths[0];
  const dst = app.getPath('userData');

  if (path.resolve(src) === path.resolve(dst)) {
    await dialog.showMessageBox(win, { type: 'info', message: 'That is already the desktop app’s own data folder — nothing to import.' });
    return;
  }
  const looksRight = fs.existsSync(path.join(src, 'data', 'chats.db')) || fs.existsSync(path.join(src, 'config.json'));
  if (!looksRight) {
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'That folder doesn’t look like a Claude Code Studio install.',
      detail: 'Expected data/chats.db or config.json inside the selected folder.',
    });
    return;
  }
  const confirm = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Import & Restart', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Import settings and chat history?',
    detail: `From:\n${src}\n\nThis replaces the desktop app’s current chat history and settings (config.json + skills). A timestamped backup is made first. The app will restart when done.`,
  });
  if (confirm.response !== 0) return;

  // Release the SQLite DB before overwriting it.
  stopServer();
  await new Promise((r) => setTimeout(r, 700));

  // Back up the current data first (recovery path).
  const backupDir = path.join(dst, `backup-${Date.now()}`);
  try { fs.mkdirSync(backupDir, { recursive: true }); } catch (_) {}
  for (const d of IMPORT_DIRS) copyIfExists(path.join(dst, d), path.join(backupDir, d));
  for (const f of IMPORT_FILES) copyIfExists(path.join(dst, f), path.join(backupDir, f));

  // Import from the chosen folder.
  let copied = 0;
  for (const d of IMPORT_DIRS) { if (copyIfExists(path.join(src, d), path.join(dst, d))) copied++; }
  for (const f of IMPORT_FILES) { if (copyIfExists(path.join(src, f), path.join(dst, f))) copied++; }

  await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Restart now'],
    message: 'Import complete.',
    detail: `Imported ${copied} item(s). A backup of the previous data is at:\n${backupDir}\n\nThe app will now restart.`,
  });
  app.relaunch();
  app.exit(0);
}

function setupMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Import data from CLI / web version…', click: () => { importFromCli().catch((e) => console.error('[import]', e)); } },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Project on GitHub', click: () => shell.openExternal(`https://github.com/${GH_OWNER}/${GH_REPO}`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(boot).catch((err) => {
  console.error('[electron] startup failed:', err);
  app.quit();
});

app.on('activate', () => { showMainWindow(); });
// With a tray the window only hides on close, so this rarely fires — and when it does we
// deliberately stay alive (the tray keeps the scheduler reachable). Without a tray there
// is nothing to return to, so quit normally instead of stranding a headless process.
app.on('window-all-closed', () => { if (!trayReady) { app.isQuiting = true; stopServer(); app.quit(); } });
app.on('before-quit', () => { app.isQuiting = true; stopServer(); });
