// Regression coverage for the authentication boundary: unissued/prototype tokens,
// malformed persisted sessions, DNS rebinding against local auth bypasses, and
// revocation of HTTP and WebSocket sessions. All state is in throwaway APP_DIRs.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-auth-boundary-'));
const children = new Set();
const sockets = new Set();
let checks = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks++;
  console.log('  ok   ' + label);
}
function cleanup() {
  for (const ws of sockets) try { ws.terminate(); } catch {}
  for (const child of children) try { child.kill('SIGKILL'); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.on('exit', cleanup);

function freshAuth(stored) {
  const dir = path.join(TMP, 'unit');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'sessions-auth.json'), JSON.stringify(stored));
  process.env.APP_DIR = dir;
  delete process.env.CCS_DESKTOP;
  delete require.cache[require.resolve('../auth')];
  return require('../auth');
}
function request(port, method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: url,
      headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')));
    req.end(payload);
  });
}
function connect(port, headers = {}, endpoint = '/') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`, { headers });
    sockets.add(ws);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS handshake timed out')); }, 5000);
    ws.on('error', () => {});
    ws.once('close', () => sockets.delete(ws));
    ws.once('open', () => { clearTimeout(timer); resolve({ status: 101, ws }); });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer); res.resume(); ws.terminate(); resolve({ status: res.statusCode });
    });
  });
}
function waitClosed(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => reject(new Error('revoked socket stayed open')), 5000);
    ws.once('close', code => { clearTimeout(timer); resolve(code); });
  });
}
async function boot(name, desktop = false) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', APP_DIR: dir,
    WORKDIR: path.join(dir, 'workspace'), CCS_CONFIG_PATH: path.join(dir, 'config.json'),
    CCS_ENV_PATH: path.join(dir, '.env'), LOG_LEVEL: 'error', TRUST_PROXY: '', CCS_ALLOWED_ORIGINS: '' };
  delete env.CCS_DESKTOP;
  for (const key of ['CCS_INTERRUPT_URL', 'CCS_INTERRUPT_SESSION', 'CCS_INTERRUPT_SECRET']) delete env[key];
  if (desktop) env.CCS_DESKTOP = '1';
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  child.once('exit', () => children.delete(child));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited: ' + logs.slice(-4000));
    try { if ((await request(port, 'GET', '/api/auth/status')).status === 200) return { port, child }; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server failed to start: ' + logs.slice(-4000));
}
function cookieToken(response) {
  return (response.headers['set-cookie'] || []).join(';').match(/(?:^|;)\s*token=([^;]+)/)?.[1];
}

(async () => {
  console.log('\n— token dictionaries fail closed —');
  const token = crypto.randomBytes(32).toString('hex');
  let auth = freshAuth({ [token]: { created: Date.now(), lastUsed: Date.now() } });
  for (const invalid of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty',
    '', null, undefined, 7, [token], { toString: () => token }, 'a'.repeat(63), 'g'.repeat(64)]) {
    check('unissued token rejected: ' + String(invalid), auth.validateToken(invalid), false);
    check('same token rejected by WS helper', auth.validateWsToken(invalid), false);
  }
  check('a genuinely issued token still validates', auth.validateToken(token), true);
  check('validation never mutates Object.prototype', Object.hasOwn(Object.prototype, 'lastUsed'), false);
  for (const record of [null, {}, [], 'not a record', { created: 'not a date' }, { created: String(Date.now()) }, { created: null }, { created: -1 }]) {
    auth = freshAuth({ [token]: record });
    check('malformed session rejected: ' + JSON.stringify(record), auth.validateToken(token), false);
  }
  for (const stored of [null, [], 1, 'string']) {
    auth = freshAuth(stored);
    check('malformed cache rejected: ' + JSON.stringify(stored), auth.validateToken(token), false);
  }

  console.log('\n— loopback trust includes the destination Host —');
  const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3000' } };
  for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000', '127.0.0.53']) {
    check('local hostname accepted: ' + host, auth.isDirectLoopbackRequest({ ...local, headers: { host } }), true);
  }
  for (const host of ['evil.example:3000', '127.attacker.example:3000', 'localhost.evil.example', '127.0.0.1@evil.example', 'localhost/path', 'localhost?x', 'localhost#x', '127.0.0.999', '']) {
    check('untrusted hostname refused: ' + host, auth.isDirectLoopbackRequest({ ...local, headers: { host } }), false);
  }
  for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
    check('even an empty forwarding header removes local trust', auth.isDirectLoopbackRequest({ ...local, headers: { ...local.headers, [header]: '' } }), false);
  }
  check('non-loopback peer refused', auth.isDirectLoopbackRequest({ ...local, socket: { remoteAddress: '192.0.2.1' } }), false);

  console.log('\n— in-flight password checks cannot undo revocation —');
  // Hold bcrypt at its asynchronous boundary to make both races deterministic.
  // Only a throwaway auth file is changed; restore the real bcrypt implementation
  // before the HTTP integration tests exercise password checks end to end.
  const bcrypt = require('bcryptjs');
  const originalCompare = bcrypt.compare, originalHash = bcrypt.hash;
  const authFile = path.join(TMP, 'unit', 'data', 'auth.json');
  const writeHash = passwordHash => fs.writeFileSync(authFile, JSON.stringify({ passwordHash }));
  try {
    writeHash('original-hash');
    let finishCompare;
    bcrypt.compare = () => new Promise(resolve => { finishCompare = resolve; });
    const pendingLogin = auth.login('old-password');
    writeHash('replacement-hash');
    finishCompare(true);
    await assert.rejects(pendingLogin, /Invalid credentials/);
    check('login rechecks the hash after bcrypt completes', true, true);

    let finishHash, markHashStarted;
    const hashStarted = new Promise(resolve => { markHashStarted = resolve; });
    bcrypt.compare = async () => true;
    bcrypt.hash = () => new Promise(resolve => { finishHash = resolve; markHashStarted(); });
    const pendingChange = auth.changePassword('old-password', 'new-password');
    await hashStarted;
    writeHash('concurrent-change-hash');
    finishHash('stale-change-hash');
    await assert.rejects(pendingChange, /Invalid current password/);
    check('concurrent password change preserves the first successful write', JSON.parse(fs.readFileSync(authFile)).passwordHash, 'concurrent-change-hash');
  } finally {
    bcrypt.compare = originalCompare;
    bcrypt.hash = originalHash;
  }

  console.log('\n— HTTP and both WebSocket routes enforce token ownership —');
  const { port } = await boot('web');
  const rebound = { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` };
  check('rebound visitor is told a setup code is needed', (await request(port, 'GET', '/api/auth/status', rebound)).json.setupCodeRequired, true);
  check('rebound visitor cannot claim a new instance',
    (await request(port, 'POST', '/api/auth/setup', rebound, { password: crypto.randomBytes(16).toString('hex') })).status, 403);
  const password = crypto.randomBytes(16).toString('hex');
  const setup = await request(port, 'POST', '/api/auth/setup', {}, { password });
  check('direct local setup succeeds', setup.status, 200);
  const issued = cookieToken(setup);
  check('setup issues a token', typeof issued === 'string' && issued.length === 64, true);
  for (const key of ['__proto__', 'constructor', 'toString']) {
    for (const headers of [{ 'x-auth-token': key }, { Cookie: 'token=' + key }, { Authorization: 'Bearer ' + key }]) {
      check('HTTP refuses prototype token in every auth transport', (await request(port, 'GET', '/api/sessions', headers)).status, 401);
      for (const endpoint of ['/', '/ws/terminal?session=unused']) {
        check('WebSocket refuses prototype token in every auth transport', (await connect(port, headers, endpoint)).status, 401);
      }
    }
  }
  check('HTTP positive control', (await request(port, 'GET', '/api/sessions', { 'x-auth-token': issued })).status, 200);
  const live = await connect(port, { 'x-auth-token': issued });
  check('WS positive control', live.status, 101);
  let closed = waitClosed(live.ws);
  check('header-token logout succeeds', (await request(port, 'POST', '/api/auth/logout', { 'x-auth-token': issued })).status, 200);
  check('logout closes the accepted socket', await closed, 1008);
  check('header-token logout revokes HTTP access', (await request(port, 'GET', '/api/sessions', { 'x-auth-token': issued })).status, 401);
  check('header-token logout prevents reconnect', (await connect(port, { 'x-auth-token': issued })).status, 401);

  const login = await request(port, 'POST', '/api/auth/login', {}, { password });
  const second = cookieToken(login);
  const secondSocket = (await connect(port, { Authorization: 'Bearer ' + second })).ws;
  closed = waitClosed(secondSocket);
  const changed = await request(port, 'POST', '/api/auth/change-password', { Authorization: 'Bearer ' + second },
    { oldPassword: password, newPassword: crypto.randomBytes(16).toString('hex') });
  check('password change succeeds', changed.status, 200);
  check('password change closes the accepted socket', await closed, 1008);
  check('new password-change token still works', (await request(port, 'GET', '/api/sessions', { 'x-auth-token': cookieToken(changed) })).status, 200);
  check('old password-change token is rejected', (await request(port, 'GET', '/api/sessions', { 'x-auth-token': second })).status, 401);
  const third = cookieToken(changed);
  check('Bearer-token logout succeeds', (await request(port, 'POST', '/api/auth/logout', { Authorization: 'Bearer ' + third })).status, 200);
  check('Bearer-token logout actually revokes it', (await request(port, 'GET', '/api/sessions', { Authorization: 'Bearer ' + third })).status, 401);

  console.log('\n— desktop auth bypass refuses DNS rebinding —');
  const desktop = await boot('desktop', true);
  const evil = { Host: `evil.example:${desktop.port}`, Origin: `http://evil.example:${desktop.port}` };
  check('desktop legitimate HTTP stays available', (await request(desktop.port, 'GET', '/api/sessions')).status, 200);
  check('desktop legitimate WS stays available', (await connect(desktop.port)).status, 101);
  for (const method of ['GET', 'POST']) {
    check('desktop rebinding refused even when Origin matches Host', (await request(desktop.port, method, '/api/sessions', evil, method === 'POST' ? {} : undefined)).status, 403);
  }
  for (const endpoint of ['/', '/ws/terminal?session=unused']) {
    check('desktop rebinding refused on both WS routes', (await connect(desktop.port, evil, endpoint)).status, 403);
  }
  check('desktop forwarded loopback request refused', (await request(desktop.port, 'GET', '/api/sessions', { 'x-forwarded-for': '192.0.2.1' })).status, 403);

  console.log(`\nPASS — ${checks} authentication-boundary assertions`);
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => {
  cleanup();
  // Tests own every child and socket; cleanup closes all handles deterministically.
  process.exit(process.exitCode || 0);
});
