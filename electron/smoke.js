'use strict';

// Headless smoke test (Phase 0 de-risk spike). Proves, without opening a window:
//   1. utilityProcess.fork runs the unchanged server.js under Electron's Node
//   2. node:sqlite works there (if it didn't, the server would crash on boot
//      and /api/health would never pass)
//   3. /api/health returns 200
// Run with: npx electron electron/smoke.js   (exits 0 on success, 1 on failure)

const { app, utilityProcess } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function health(port, ms = 30000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const go = () => {
      const r = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (x) => {
        x.resume(); return x.statusCode === 200 ? resolve() : retry();
      });
      r.on('error', retry);
      r.on('timeout', () => { r.destroy(); retry(); });
    };
    const retry = () => (Date.now() > deadline ? reject(new Error('health timeout')) : setTimeout(go, 300));
    go();
  });
}

app.whenReady().then(async () => {
  let code = 1;
  let proc = null;
  try {
    const port = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-smoke-'));
    proc = utilityProcess.fork(path.join(__dirname, '..', 'server.js'), [], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(port),
        APP_DIR: tmp,
        WORKDIR: path.join(tmp, 'workspace'),
        CCS_DESKTOP: '1',
        NODE_ENV: 'production',
      },
    });
    console.log('[smoke] electron node:', process.versions.node, '| electron:', process.versions.electron, '| port:', port);
    await health(port);
    console.log('[smoke] OK — server forked under Electron, node:sqlite worked, /api/health=200');
    code = 0;
  } catch (e) {
    console.error('[smoke] FAIL:', e.message);
  } finally {
    if (proc) { try { proc.kill(); } catch (_) {} }
    app.exit(code);
  }
}).catch((e) => { console.error('[smoke] whenReady fail:', e); app.exit(1); });
