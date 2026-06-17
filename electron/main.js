'use strict';

// Claude Code Studio — Electron desktop shell.
// One codebase, two launchers: this process forks the existing server.js
// (unchanged) and renders it in a native window. Web mode (`node server.js`)
// is unaffected — none of this runs there.

const { app, BrowserWindow, shell, ipcMain, utilityProcess } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');

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
  serverPort = await getFreePort();
  startServer(serverPort);
  await waitForHealth(serverPort);
  await createWindow();
}

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
