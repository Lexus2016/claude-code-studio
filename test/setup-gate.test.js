// Guards the first-run boundary: who is allowed to claim the account, and where
// the server listens by default. Claiming the account on a fresh install hands
// out a UI that runs `claude --dangerously-skip-permissions` with Bash in $HOME,
// so "whoever POSTs first wins" is not an acceptable default.
//
// Starts a real server against a THROWAWAY data directory — never touches the
// developer's chats.db. CCS_DESKTOP is deliberately NOT set: it bypasses auth.
// Run: node test/setup-gate.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// 3991/3992: every other test in the chain claims 3993-3999.
const PORT = Number(process.env.TEST_PORT || 3991);
const PORT2 = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-setupgate-'));
// Every early process.exit() below (port already in use, server never came up,
// no auth cookie) jumps past the rmSync at the bottom of the file and leaves a
// directory behind in /tmp on each run. An exit hook covers all of them.
process.on('exit', () => { for (const _d of [APP_DIR]) { try { fs.rmSync(_d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// TRUST_PROXY=true makes X-Forwarded-For authoritative for req.ip, which is how
// a request can look remote while the socket is still loopback. That is exactly
// the nginx/cloudflared shape this gate has to survive.
async function api(method, url, body, forwardedFor) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  const r = await fetch(BASE + url, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// The parent shell of a Claude Code session exports CCS_DESKTOP=1 and APP_DIR.
// Inheriting either turns the auth wall off and repoints data/ at the real user
// directory, so the child env is scrubbed rather than merely overridden.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.CCS_DESKTOP;
  for (const k of ['CCS_INTERRUPT_URL', 'CCS_INTERRUPT_SESSION', 'CCS_INTERRUPT_SECRET']) delete env[k];
  return env;
}

function firstExternalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

function canConnect(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = ok => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

(async () => {
  console.log('\n— unit: address classification —');
  const auth = require(path.join(__dirname, '..', 'auth.js'));
  for (const [addr, want] of [
    ['127.0.0.1', true], ['127.0.0.53', true], ['::1', true],
    ['::ffff:127.0.0.1', true], ['localhost', true],
    ['192.168.1.7', false], ['::ffff:192.168.1.7', false], ['10.0.0.3', false],
    ['203.0.113.5', false], ['', false], [null, false], [undefined, false],
    // Not loopback despite the digits — a naive substring/prefix test gets this wrong.
    ['1.127.0.0', false], ['217.0.0.1', false],
  ]) {
    check(`isLoopbackAddress(${JSON.stringify(addr)})`, auth.isLoopbackAddress(addr), want);
  }

  console.log('\n— integration: the first-run gate —');
  for (const p of [PORT, PORT2]) {
    if (await canConnect('127.0.0.1', p, 500)) {
      console.error(`port ${p} is already in use — refusing to run against someone else's server. Set TEST_PORT.`);
      process.exit(1);
    }
  }
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: childEnv({ PORT: String(PORT), APP_DIR, WORKDIR: APP_DIR, HOST: '127.0.0.1', TRUST_PROXY: 'true', LOG_LEVEL: 'error' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const stop = () => { try { srv.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);

  try {
    // Readiness: the endpoint we actually use, not just /api/health.
    let up = false;
    for (let i = 0; i < 120; i++) {
      // setupDone===false identifies OUR freshly-seeded instance. A stray server
      // on this port answers 200 too, and would silently pass half the asserts.
      try { const r = await api('GET', '/api/auth/status'); if (r.status === 200 && r.json?.setupDone === false) { up = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    if (!up) { console.error('server never came up:\n' + log); stop(); process.exit(1); }

    const code = (log.match(/one-time code:\s*([0-9A-F]{8})/) || [])[1];
    check('console prints a one-time setup code', /^[0-9A-F]{8}$/.test(code || ''), true);

    check('local visitor is not asked for a code',
      (await api('GET', '/api/auth/status')).json.setupCodeRequired, false);
    check('remote visitor is told a code is needed',
      (await api('GET', '/api/auth/status', null, '203.0.113.5')).json.setupCodeRequired, true);

    let r = await api('POST', '/api/auth/setup', { password: 'hunter2hunter2' }, '203.0.113.5');
    check('remote setup without a code is refused', [r.status, r.json.error], [403, 'setup_code_required']);
    r = await api('POST', '/api/auth/setup', { password: 'hunter2hunter2', setupCode: 'DEADBEEF' }, '203.0.113.6');
    check('remote setup with a wrong code is refused', [r.status, r.json.error], [403, 'setup_code_required']);
    r = await api('POST', '/api/auth/setup', { password: 'hunter2hunter2', setupCode: (code || '') + 'X' }, '203.0.113.7');
    check('a longer near-miss code is refused', r.status, 403);
    check('no account was created by any of that',
      fs.existsSync(path.join(APP_DIR, 'data', 'auth.json')), false);

    r = await api('POST', '/api/auth/setup', { password: 'hunter2hunter2', displayName: 'Owner', setupCode: code }, '203.0.113.8');
    check('remote setup with the printed code succeeds', [r.status, r.json.ok], [200, true]);
    check('the account now exists',
      fs.existsSync(path.join(APP_DIR, 'data', 'auth.json')), true);

    // The code is single-use by construction: it only exists while setup is pending.
    r = await api('POST', '/api/auth/setup', { password: 'takeover12345', setupCode: code }, '203.0.113.9');
    check('the same code cannot claim the account twice', r.status, 400);
    check('protected routes still demand a token',
      (await api('GET', '/api/config', null, '203.0.113.9')).status, 401);
  } finally {
    stop();
  }

  console.log('\n— integration: default bind is loopback-only —');
  const lanIp = firstExternalIPv4();
  const APP_DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-setupgate2-'));
  fs.mkdirSync(path.join(APP_DIR2, 'data'), { recursive: true });
  const srv2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // No HOST at all — this is the out-of-the-box configuration.
    env: childEnv({ PORT: String(PORT2), APP_DIR: APP_DIR2, WORKDIR: APP_DIR2, HOST: '', LOG_LEVEL: 'error', TRUST_PROXY: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop2 = () => { try { srv2.kill('SIGTERM'); } catch {} };
  process.on('exit', stop2);
  try {
    let up2 = false;
    for (let i = 0; i < 120; i++) {
      if (await canConnect('127.0.0.1', PORT2, 300)) { up2 = true; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    check('reachable on loopback with no HOST set', up2, true);
    // The gate reads the SOCKET, not req.ip, and treats the mere presence of a
    // forwarding header as proof a hop happened — whatever TRUST_PROXY says.
    //
    // Why that direction: behind a reverse proxy with TRUST_PROXY unset (the default,
    // and a very common misconfiguration) req.ip is the proxy's own 127.0.0.1, so
    // EVERY internet visitor looked like the console owner and could claim a fresh
    // install. Erring the other way costs a local user who forges the header one
    // glance at the console; erring this way hands out a shell.
    const spoof = await fetch(`http://127.0.0.1:${PORT2}/api/auth/status`, { headers: { 'x-forwarded-for': '203.0.113.5' } }).then(r => r.json());
    check('a forwarded request is treated as remote even with TRUST_PROXY unset', spoof.setupCodeRequired, true);
    // Positive control: without the header the very same socket is still the console.
    // Without this pair, the assertion above would also pass if the gate had simply
    // started demanding a code from everyone.
    const direct = await fetch(`http://127.0.0.1:${PORT2}/api/auth/status`).then(r => r.json());
    check('and the same loopback socket without the header is not', direct.setupCodeRequired, false);
    if (lanIp) {
      check(`not reachable on ${lanIp} with no HOST set`, await canConnect(lanIp, PORT2), false);
    } else {
      console.log('  skip  no external IPv4 on this host — cannot prove the negative');
    }
  } finally {
    stop2();
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); fs.rmSync(APP_DIR2, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
