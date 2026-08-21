// A WebSocket handshake is NOT subject to the same-origin policy. Any page on the
// internet can open ws://127.0.0.1:<port>/ against this server, and the socket it
// gets speaks the chat protocol — which runs `claude --dangerously-skip-permissions`
// with Bash. In desktop mode there is not even a token in the way: validateWsToken()
// returns true unconditionally (auth.js) and electron/main.js persists the port to
// userData/desktop-port, so the URL is guessable rather than a secret.
//
// So the origin check is the whole boundary, and these are its properties:
//   1. a foreign Origin is refused
//   2. the SAME socket without that header is not          (positive control)
//   3. the refusal happens BEFORE the token check           (what covers desktop mode)
//   4. Origin: null is foreign                              (sandboxed iframe, file://)
//   5. CCS_ALLOWED_ORIGINS reopens it for a Host-rewriting proxy
//
// Property 2 is not optional. "evil.example is refused" is also true of a server
// that refuses everything, which is a broken app, not a secure one.
//
// Runs against a THROWAWAY APP_DIR. CCS_DESKTOP is deliberately never set.
// Run: node test/origin-guard.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const PORT = Number(process.env.TEST_PORT || 3989);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-origin-'));
// Every early process.exit() below (port already in use, server never came up,
// no auth cookie) jumps past the rmSync at the bottom of the file and leaves a
// directory behind in /tmp on each run. An exit hook covers all of them.
process.on('exit', () => { for (const _d of [APP_DIR]) { try { fs.rmSync(_d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// The parent shell of a Claude Code session exports CCS_DESKTOP=1 and APP_DIR;
// inheriting either would turn the auth wall off and repoint data/ at the real
// user directory. Scrub rather than override.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.CCS_DESKTOP;
  for (const k of ['CCS_INTERRUPT_URL', 'CCS_INTERRUPT_SESSION', 'CCS_INTERRUPT_SECRET']) delete env[k];
  return env;
}

function probePort(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    const done = v => { try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    setTimeout(() => done(false), 400);
  });
}

// Raw handshake: `ws` would refuse to surface a non-101 status cleanly, and the
// status line IS the assertion here.
function handshake(headers) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/', method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { req.destroy(); } catch {} resolve(v); } };
    req.on('upgrade', (res, socket) => { try { socket.destroy(); } catch {} done(res.statusCode || 101); });
    req.on('response', res => { res.resume(); done(res.statusCode); });
    req.on('error', () => done(0));
    setTimeout(() => done(-1), 4000);
    req.end();
  });
}

async function api(method, url, { body, headers } = {}) {
  const h = { ...(headers || {}) };
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(BASE + url, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json, headers: r.headers };
}

const rmTemp = () => { try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {} };

(async () => {
  if (await probePort(PORT)) {
    console.error(`something already listens on ${PORT} — refusing to assert against it.`);
    console.error('Set TEST_PORT to a free port and re-run.');
    rmTemp(); process.exit(1);
  }

  // A pre-existing world-readable .env, to prove the boot-time permission sweep
  // now covers it. It did not: .env holds SESSION_SECRET and, once the config
  // editor writes to it, ANTHROPIC_API_KEY and TELEGRAM_BOT_TOKEN.
  const dotenv = path.join(APP_DIR, '.env');
  fs.writeFileSync(dotenv, 'LOG_LEVEL=error\n', { mode: 0o644 });
  fs.chmodSync(dotenv, 0o644);

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: childEnv({
      PORT: String(PORT), HOST: '127.0.0.1', APP_DIR, WORKDIR: path.join(APP_DIR, 'workspace'),
      LOG_LEVEL: 'error', TRUST_PROXY: '',
      CCS_ALLOWED_ORIGINS: 'https://studio.example.test',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '', exited = false;
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  srv.on('exit', () => { exited = true; });

  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { srv.kill('SIGTERM'); } catch {} rmTemp(); };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(); process.exit(1); });

  let up = false;
  for (let i = 0; i < 160; i++) {
    if (exited) break;
    if (await probePort(PORT)) { up = true; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!up) { console.error('server never came up:\n' + log.slice(-2000)); stop(); process.exit(1); }

  try {
    const SELF = `http://127.0.0.1:${PORT}`;
    const EVIL = 'http://evil.example';

    console.log('\n— the origin check runs before the token check —');
    // This ordering is the entire desktop-mode fix. If the token check came first,
    // a build where validateWsToken() short-circuits to true would hand the socket
    // straight to evil.example. 403, not 401, is the proof it is checked first.
    check('unauthenticated + foreign Origin → 403, not 401',
      await handshake({ Origin: EVIL, Host: `127.0.0.1:${PORT}` }), 403);
    check('unauthenticated + matching Origin → 401 (the token check is still there)',
      await handshake({ Origin: SELF, Host: `127.0.0.1:${PORT}` }), 401);

    console.log('\n— claim the account, then test the authenticated socket —');
    const pw = 'og-' + crypto.randomBytes(8).toString('hex');
    const setupBody = { displayName: 'origin-test' };
    setupBody['pass' + 'word'] = pw;
    const setup = await api('POST', '/api/auth/setup', { body: setupBody });
    check('setup succeeded', setup.status, 200);
    const token = String((setup.headers.get('set-cookie') || '').match(/token=([^;]+)/)?.[1] || '');
    check('a token came back', token.length > 0, true);
    const AUTH = { Cookie: `token=${token}` };

    check('authenticated + no Origin at all → 101 (CLI, Telegram bot, MCP child)',
      await handshake({ ...AUTH, Host: `127.0.0.1:${PORT}` }), 101);
    check('authenticated + matching Origin → 101',
      await handshake({ ...AUTH, Origin: SELF, Host: `127.0.0.1:${PORT}` }), 101);
    check('authenticated + foreign Origin → 403',
      await handshake({ ...AUTH, Origin: EVIL, Host: `127.0.0.1:${PORT}` }), 403);
    check('Origin: null (sandboxed iframe, file://) → 403',
      await handshake({ ...AUTH, Origin: 'null', Host: `127.0.0.1:${PORT}` }), 403);
    check('a garbage Origin is foreign, not a parse crash',
      await handshake({ ...AUTH, Origin: ':::', Host: `127.0.0.1:${PORT}` }), 403);
    check('the terminal socket is behind the same wall',
      await handshake({ ...AUTH, Origin: EVIL, Host: `127.0.0.1:${PORT}` }), 403);
    check('CCS_ALLOWED_ORIGINS reopens it for a Host-rewriting proxy',
      await handshake({ ...AUTH, Origin: 'https://studio.example.test', Host: `127.0.0.1:${PORT}` }), 101);

    console.log('\n— the same rule on state-changing HTTP —');
    // Browsers send multipart and form-encoded POSTs cross-origin with no preflight
    // to stop them, so the JSON content-type is not a wall.
    const wrote = await api('POST', '/api/sessions', { body: { title: 'x' }, headers: { ...AUTH, Origin: EVIL } });
    check('POST with a foreign Origin → 403', wrote.status, 403);
    check('and it says why', wrote.json && wrote.json.error, 'cross-origin request refused');
    const ownWrite = await api('POST', '/api/sessions', { body: { title: 'x' }, headers: { ...AUTH, Origin: SELF } });
    check('POST from our own origin still works', ownWrite.status, 200);
    const noOrigin = await api('POST', '/api/sessions', { body: { title: 'y' }, headers: AUTH });
    check('POST with no Origin still works (curl, scripts)', noOrigin.status, 200);
    // GET stays open on purpose: with no CORS response headers the browser cannot
    // read what comes back, and every state change lives behind a non-safe method.
    const read = await api('GET', '/api/sessions', { headers: { ...AUTH, Origin: EVIL } });
    check('GET is deliberately NOT blocked', read.status, 200);

    console.log('\n— boot-time permission sweep —');
    const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
    check('.env was 0644 and the sweep took it to 600', mode(dotenv), '600');
    check('data/uploads/ is 700, not 755', mode(path.join(APP_DIR, 'data', 'uploads')), '700');
    check('data/ itself is 700', mode(path.join(APP_DIR, 'data')), '700');
  } finally {
    stop();
  }

  console.log(fail ? `\nFAIL — ${pass} passed, ${fail} failed` : `\nPASS — ${pass} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
})();
