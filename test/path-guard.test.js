// Guards two controls that had zero test coverage (FIX-10 in .planning/FIXES.md):
//
//   1. isPathAllowed() — every endpoint that takes a filesystem path from the
//      browser runs through it. It is the only thing standing between an
//      authenticated session and `GET /api/browse-dirs?path=/etc`.
//   2. "a public tunnel is active → no browser terminal". A published tunnel plus
//      a browser terminal is a public shell, so the refusal must hold on BOTH the
//      capability endpoint the UI reads and the /ws/terminal socket itself.
//
// Both are asserted against a REAL server on a THROWAWAY data directory — never
// the developer's chats.db. The tunnel case spawns a fake `cloudflared` on PATH
// that prints a trycloudflare URL and then idles, which is all TunnelManager
// looks for; nothing leaves this machine.
//
// Run: node test/path-guard.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// 3991-3995 are claimed by the other suites in the chain.
const PORT = Number(process.env.TEST_PORT || 3996);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-pathguard-'));
// Every early process.exit() below (port already in use, server never came up,
// no auth cookie) jumps past the rmSync at the bottom of the file and leaves a
// directory behind in /tmp on each run. An exit hook covers all of them.
process.on('exit', () => { for (const _d of [APP_DIR]) { try { fs.rmSync(_d, { recursive: true, force: true }); } catch {} } });
const BIN_DIR = path.join(APP_DIR, 'fakebin');
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

// terminal.enabled must be true up front: /api/terminal/capability checks the
// config flag FIRST, so with the feature off the tunnel branch is unreachable and
// the assertion below would pass for the wrong reason.
fs.writeFileSync(path.join(APP_DIR, 'config.json'), JSON.stringify({ terminal: { enabled: true } }, null, 2));

// TunnelManager only requires that `which cloudflared` succeeds and that the
// process emits a trycloudflare URL on stdout or stderr. `trap` so SIGTERM from
// /api/tunnel/stop actually reaps it instead of leaking a sleeper.
const FAKE_CF = path.join(BIN_DIR, 'cloudflared');
fs.writeFileSync(FAKE_CF, [
  '#!/bin/sh',
  'trap "exit 0" TERM INT',
  'echo "INF Your quick Tunnel has been created! Visit it at: https://ccs-pathguard-fake.trycloudflare.com"',
  'while true; do sleep 1 & wait $!; done',
].join('\n') + '\n');
fs.chmodSync(FAKE_CF, 0o755);

// Generated per run so no credential literal ever lands in the repo.
const PW = crypto.randomBytes(18).toString('hex');
let TOKEN = null;
async function api(method, url, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (TOKEN) headers['x-auth-token'] = TOKEN;
  const r = await fetch(BASE + url, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await r.json(); } catch {}
  // The token is handed out as an httpOnly cookie, never in the JSON body — so
  // authenticating here means reading Set-Cookie, exactly as a browser would.
  const setCookie = r.headers.get('set-cookie') || '';
  const cookieToken = (setCookie.match(/(?:^|[;,\s])token=([^;,\s]+)/) || [])[1] || null;
  return { status: r.status, json, cookieToken };
}

// The parent shell of a Claude Code session exports CCS_DESKTOP=1 (which turns
// the auth wall off) and APP_DIR (which repoints data/ at the real user dir), so
// the child env is scrubbed rather than merely overridden.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.CCS_DESKTOP;
  for (const k of ['CCS_INTERRUPT_URL', 'CCS_INTERRUPT_SESSION', 'CCS_INTERRUPT_SECRET']) delete env[k];
  return env;
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

// Poll instead of sleeping: a fixed wait passes on an idle laptop and lies on a
// loaded CI box. Same helper shape as terminal-bridge.integration.test.js.
async function waitFor(pred, { timeoutMs = 20000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v; try { v = await pred(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// Opens /ws/terminal and resolves with whatever the server said first: the JSON
// control frame it rejects with, or 'unauthorized' when the upgrade is refused.
function termWs(token, sessionId = 'nonexistent') {
  return new Promise(resolve => {
    const headers = token ? { 'x-auth-token': token } : {};
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?session=${encodeURIComponent(sessionId)}`, { headers });
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => done({ error: '<timeout>' }), 10000);
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); done({ status: res.statusCode, error: 'unauthorized' }); });
    ws.on('error', () => { clearTimeout(timer); done({ error: 'unauthorized' }); });
    ws.on('message', (data) => {
      if (Buffer.isBuffer(data) && !data.toString().startsWith('{')) return; // raw terminal bytes
      try { const j = JSON.parse(data.toString()); clearTimeout(timer); done(j); } catch {}
    });
  });
}

(async () => {
  if (await canConnect('127.0.0.1', PORT, 500)) {
    console.error(`port ${PORT} is already in use — refusing to run against someone else's server. Set TEST_PORT.`);
    process.exit(1);
  }

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: childEnv({
      PORT: String(PORT), APP_DIR, WORKDIR: APP_DIR, HOST: '127.0.0.1', LOG_LEVEL: 'error',
      PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  const stop = () => { try { srv.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);

  try {
    const up = await waitFor(async () => {
      // setupDone===false identifies OUR freshly-seeded instance; a stray server
      // on this port answers 200 too and would pass half the asserts silently.
      const r = await api('GET', '/api/auth/status');
      return r.status === 200 && r.json?.setupDone === false;
    }, { timeoutMs: 30000, intervalMs: 250 });
    if (!up) { console.error('server never came up:\n' + srvLog); stop(); process.exit(1); }

    const setup = await api('POST', '/api/auth/setup', { password: PW, displayName: 'Owner' });
    TOKEN = setup.cookieToken;
    if (!TOKEN) {
      const login = await api('POST', '/api/auth/login', { password: PW });
      TOKEN = login.cookieToken;
    }
    check('authenticated for the guarded endpoints', typeof TOKEN === 'string' && TOKEN.length > 0, true);

    // ── isPathAllowed: refusals ──────────────────────────────────────────────
    console.log('\n— path guard: paths outside every allowed root are refused —');

    // A symlink sitting INSIDE an allowed root is lexically inside it while every
    // read lands on the target. This is the case plain string containment misses.
    const escape = path.join(APP_DIR, 'escape');
    fs.symlinkSync('/etc', escape);
    const nested = path.join(APP_DIR, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const deepEscape = path.join(nested, 'out');
    fs.symlinkSync('/etc', deepEscape);
    // Not decoration: created inside a bare catch, a host that cannot symlink would
    // make every assertion below pass against a path that does not exist.
    check('the escaping symlink fixtures exist and point outside',
      [fs.realpathSync(escape), fs.realpathSync(deepEscape)],
      [fs.realpathSync('/etc'), fs.realpathSync('/etc')]);

    const refused = [
      ['/etc', 'an absolute path outside every root'],
      ['/etc/passwd', 'a file outside every root'],
      ['/', 'the filesystem root'],
      [path.join(APP_DIR, '..', '..', '..', '..', 'etc'), 'a relative climb out of WORKDIR'],
      [escape, 'a symlink inside WORKDIR pointing at /etc'],
      [deepEscape, 'a symlink nested one level deep inside WORKDIR'],
    ];
    for (const [p, label] of refused) {
      const r = await api('GET', `/api/browse-dirs?path=${encodeURIComponent(p)}`);
      check(`browse-dirs refuses ${label}`, [r.status, r.json?.error], [403, 'path not allowed']);
    }
    check('claude-md refuses a dir outside every root',
      (await api('GET', '/api/claude-md?dir=%2Fetc')).status, 403);
    check('claude-md POST refuses a local write outside every root',
      (await api('POST', '/api/claude-md', { type: 'local', dir: '/etc', content: 'x' })).status, 403);

    // ── isPathAllowed: the positive control ──────────────────────────────────
    // Without these, a guard that refused EVERYTHING would pass the block above.
    console.log('\n— path guard: legitimate roots still work —');
    const inside = path.join(APP_DIR, 'inside');
    fs.mkdirSync(inside, { recursive: true });
    for (const [p, label] of [
      [APP_DIR, 'WORKDIR itself'],
      [inside, 'a directory under WORKDIR'],
      [os.homedir(), 'the home directory'],
      [path.join(__dirname, '..'), 'the application directory'],
    ]) {
      const r = await api('GET', `/api/browse-dirs?path=${encodeURIComponent(p)}`);
      check(`browse-dirs allows ${label}`, r.status, 200);
    }
    check('claude-md allows a dir inside WORKDIR',
      (await api('GET', `/api/claude-md?dir=${encodeURIComponent(APP_DIR)}`)).status, 200);

    // ── /api/files: the same symlink rule, on the endpoint that reads content ──
    // This family compared workdir + path lexically and never resolved symlinks, so
    // a link committed to a cloned repo turned the file browser into a reader for
    // anything the server process could open.
    console.log('\n— the file browser resolves symlinks before deciding —');
    for (const [q, label] of [
      ['escape', 'a symlinked directory'],
      ['escape/passwd', 'a file behind a symlinked directory'],
      ['nested/out/passwd', 'a file behind a symlink one level deep'],
      ['../../../../etc', 'a relative climb'],
    ]) {
      check(`/api/files refuses ${label}`,
        (await api('GET', `/api/files?path=${encodeURIComponent(q)}`)).status, 403);
      check(`/api/files/raw refuses ${label}`,
        (await api('GET', `/api/files/raw?path=${encodeURIComponent(q)}`)).status, 403);
      check(`/api/files/download refuses ${label}`,
        (await api('GET', `/api/files/download?path=${encodeURIComponent(q)}`)).status, 403);
    }
    // Positive control: a guard that answered 403 to everything would pass the loop.
    fs.writeFileSync(path.join(inside, 'ok.txt'), 'hello');
    const okDir = await api('GET', '/api/files?path=inside');
    check('and a real directory inside the workdir still lists',
      [okDir.status, okDir.json?.type], [200, 'dir']);
    const okFile = await api('GET', '/api/files?path=inside%2Fok.txt');
    check('and a real file inside the workdir still reads',
      [okFile.status, okFile.json?.content], [200, 'hello']);

    // ── session workdir: the cwd of `claude --dangerously-skip-permissions` ────
    console.log('\n— a session cannot be pointed at an arbitrary directory —');
    const badSess = await api('POST', '/api/sessions', { title: 'x', workdir: '/etc' });
    check('POST /api/sessions refuses a workdir outside every root',
      [badSess.status, badSess.json?.error], [400, 'workdir is outside the allowed roots']);
    check('POST /api/sessions refuses a workdir behind a symlink',
      (await api('POST', '/api/sessions', { title: 'x', workdir: escape })).status, 400);
    const goodSess = await api('POST', '/api/sessions', { title: 'x', workdir: inside });
    check('and a workdir inside an allowed root is accepted', goodSess.status, 200);

    // ── /ws/terminal auth, and the pre-tunnel control ────────────────────────
    console.log('\n— terminal socket: auth and the pre-tunnel baseline —');
    check('/ws/terminal refuses an unauthenticated upgrade',
      (await termWs(null)).error, 'unauthorized');

    // The control for the tunnel assertion further down: with no tunnel running
    // the socket must fail for some OTHER reason. If this ever returns the tunnel
    // message, the tunnel assertion below proves nothing.
    const preTunnel = await termWs(TOKEN);
    check('with no tunnel running the socket does not cite a tunnel',
      preTunnel.error === 'blocked while a public tunnel is active', false);

    const capBefore = await api('GET', '/api/terminal/capability');
    check('capability does not cite a tunnel before one is started',
      capBefore.json?.reasonKey === 'term.off.tunnel', false);

    // ── the public-shell refusal ─────────────────────────────────────────────
    console.log('\n— terminal is blocked while a public tunnel is active —');
    const start = await api('POST', '/api/tunnel/start', { provider: 'cloudflared' });
    check('fake tunnel starts and reports its URL',
      [start.status, start.json?.publicUrl], [200, 'https://ccs-pathguard-fake.trycloudflare.com']);
    const running = await waitFor(async () => (await api('GET', '/api/tunnel/status')).json?.running === true);
    check('server reports the tunnel as running', running === true, true);

    const duringTunnel = await termWs(TOKEN);
    check('/ws/terminal refuses while the tunnel is up',
      duringTunnel.error, 'blocked while a public tunnel is active');

    const capDuring = await api('GET', '/api/terminal/capability');
    // The capability endpoint tests !enabled → !tmux → tunnel in that order, so on
    // a host without tmux it stops one branch early. Reported, not silently passed.
    if (capDuring.json?.reasonKey === 'term.off.tmux') {
      console.log('  skip  capability tunnel branch — no tmux on this host, it short-circuits earlier');
    } else {
      check('capability reports the tunnel as the blocker',
        [capDuring.json?.available, capDuring.json?.reasonKey], [false, 'term.off.tunnel']);
    }

    // ── and it lifts again when the tunnel stops ─────────────────────────────
    console.log('\n— the refusal lifts when the tunnel stops —');
    await api('POST', '/api/tunnel/stop');
    const stopped = await waitFor(async () => (await api('GET', '/api/tunnel/status')).json?.running === false);
    check('server reports the tunnel as stopped', stopped === true, true);
    const capAfter = await api('GET', '/api/terminal/capability');
    check('capability no longer cites a tunnel',
      capAfter.json?.reasonKey === 'term.off.tunnel', false);
    const afterTunnel = await termWs(TOKEN);
    check('/ws/terminal no longer cites a tunnel',
      afterTunnel.error === 'blocked while a public tunnel is active', false);
  } finally {
    try { await api('POST', '/api/tunnel/stop'); } catch {}
    stop();
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
