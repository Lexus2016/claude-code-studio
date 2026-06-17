'use strict';

// Claude Code Studio — Electron desktop shell.
// One codebase, two launchers: this process forks the existing server.js
// (unchanged) and renders it in a native window. Web mode (`node server.js`)
// is unaffected — none of this runs there.

const { app, BrowserWindow, shell, ipcMain, utilityProcess, dialog } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const https = require('https');
const { execFileSync, spawn } = require('child_process');

let serverProc = null;
let serverPort = null;

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
  await win.loadURL(`http://127.0.0.1:${serverPort}`);
  return win;
}

async function boot() {
  augmentPath();
  await ensureClaude();
  serverPort = await getFreePort();
  startServer(serverPort);
  await waitForHealth(serverPort);
  await createWindow();
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

async function startUpdate() {
  if (process.platform === 'darwin') {
    const brew = findBrew();
    if (!brew) return { fallback: true, command: `brew install --cask ${CASK_NAME}`, reason: 'brew-not-found' };
    let managed = false;
    try { execFileSync(brew, ['list', '--cask', CASK_NAME], { stdio: 'ignore' }); managed = true; } catch (_) {}
    if (!managed) return { fallback: true, command: `brew install --cask ${CASK_NAME}`, reason: 'not-brew-managed' };
    sendUpdateLog('Running: brew upgrade --cask ' + CASK_NAME + ' …');
    // brew quits the running app (cask `quit:`); the detached shell then relaunches it.
    const sh = `'${brew}' upgrade --cask ${CASK_NAME}; open -a "Claude Code Studio"`;
    const child = spawn('/bin/sh', ['-c', sh], { detached: true, stdio: 'ignore', env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } });
    child.unref();
    setTimeout(() => { app.isQuiting = true; stopServer(); app.quit(); }, 1000);
    return { started: true, via: 'brew' };
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

app.whenReady().then(boot).catch((err) => {
  console.error('[electron] startup failed:', err);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverProc) createWindow();
});
app.on('window-all-closed', () => { app.isQuiting = true; stopServer(); app.quit(); });
app.on('before-quit', () => { app.isQuiting = true; stopServer(); });
