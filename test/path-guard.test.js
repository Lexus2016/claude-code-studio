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

    // ── issue #53: a REMOTE workdir is not judged by the LOCAL filesystem guard ──
    // isPathAllowed() runs path.resolve(), which applies the LOCAL platform's rules.
    // On Windows `path.resolve('/home/user/project')` prepends the current drive and
    // returns 'C:\\home\\user\\project' — outside every allowed root, so every remote
    // session was refused with "workdir is outside the allowed roots", and the mangled
    // path also reached the remote shell as `cd C:/home/user/project`.
    //
    // The assertions below are platform-independent: on THIS machine the same remote
    // path is simply a directory that does not exist and sits outside the roots, which
    // is the identical failure the Windows drive-letter prefix produced.
    console.log('\n— a registered remote workdir is accepted for a run —');
    const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const REMOTE_WD = '/home/user/project-' + crypto.randomBytes(4).toString('hex');
    // Negative control FIRST: unregistered, it must still be refused. Without this the
    // test would pass against a guard that had simply been removed.
    const beforeReg = await api('POST', '/api/sessions', { title: 'remote-unregistered', workdir: REMOTE_WD });
    check('an unregistered foreign path is still refused',
      [beforeReg.status, beforeReg.json?.error], [400, 'workdir is outside the allowed roots']);

    // Register it as a remote project. Written straight to projects.json: POST /api/projects
    // validates remoteHostId against the SSH host list, which is not what is under test here.
    const projectsFile = path.join(APP_DIR, 'data', 'projects.json');
    const existingProjects = (() => { try { return JSON.parse(fs.readFileSync(projectsFile, 'utf-8')); } catch { return []; } })();
    existingProjects.push({ id: 'p-remote-53', name: 'remote 53', workdir: REMOTE_WD,
      isRemote: true, remoteHostId: 'h1', remoteHost: 'user@example.invalid', port: 22 });
    fs.writeFileSync(projectsFile, JSON.stringify(existingProjects, null, 2));

    const afterReg = await api('POST', '/api/sessions', { title: 'remote-registered', workdir: REMOTE_WD });
    check('a registered remote workdir is accepted', afterReg.status, 200);
    check('...and is stored verbatim, with no local path rewriting',
      afterReg.json?.workdir, REMOTE_WD);

    // The local guard itself must NOT have been weakened — /api/files and friends rely on it.
    check('the local browse guard still refuses that same remote path',
      (await api('GET', `/api/browse-dirs?path=${encodeURIComponent(REMOTE_WD)}`)).status, 403);
    check('and still refuses /etc',
      (await api('GET', '/api/browse-dirs?path=%2Fetc')).status, 403);

    // ── issue #53, part 2: one lookup, and a trailing slash must not change it ──
    // The "is this a remote project" test was written out three times with exact string
    // equality — the workdir guard, the chat router and the Telegram router. They had to
    // agree EXACTLY or a run the guard accepted could still be routed as local, and a
    // remote workdir used as a local cwd is where the `C:` comes from: Node resolves a
    // POSIX-absolute cwd against the current drive, so `/home/user/project` starts the
    // child in `C:\home\user\project`.
    console.log('\n— the remote-project lookup is one function, and tolerates a trailing slash —');
    check('a trailing slash still names the same remote project',
      (await api('POST', '/api/sessions', { title: 'remote-slash', workdir: REMOTE_WD + '/' })).status, 200);
    // Narrowly: no lookup may pair a workdir match with an isRemote test outside the
    // one helper. Two other `find(p => p.workdir === …)` calls remain on purpose — they
    // resolve a project NAME for notifications and for the config resolver, and neither
    // decides local-vs-SSH routing, which is the only thing that can misroute a run.
    check('no remote-routing lookup is written out by hand any more',
      (srvSrc.match(/p\.workdir === [^)]*&& p\.isRemote|p\.isRemote && p\.workdir ===/g) || [])
        .filter(m => !m.includes('norm(p.workdir)')).length, 0);
    check('...which is findRemoteProject',
      (srvSrc.match(/findRemoteProject\(/g) || []).length >= 3, true);

    // ── a task on a remote project is refused, not run locally ────────────────
    // The actual cause behind #53's "remote SSH TASK execution is broken":
    // runSshSingle() is wired into the chat and Telegram paths only. The task runner
    // has no SSH branch, so `new ClaudeCLI({ cwd: task.workdir })` spawned the LOCAL
    // agent with a path that lives on another machine — on Windows, Node resolves a
    // POSIX-absolute cwd against the current drive and the agent starts in C:\home\...
    console.log('\n— a task cannot be created on a remote SSH project —');
    const tRemote = await api('POST', '/api/tasks', { title: 'remote task', description: 'x', workdir: REMOTE_WD });
    check('creating one is refused with a reason',
      [tRemote.status, tRemote.json?.error], [400, 'tasks are not supported on remote SSH projects']);
    check('a task on a LOCAL workdir is still fine',
      (await api('POST', '/api/tasks', { title: 'local task', description: 'x', workdir: APP_DIR })).status, 200);
    check('the runner refuses too, not just the endpoint',
      /Tasks cannot run on the remote project/.test(srvSrc), true);
    check('...and it checks before constructing the local CLI',
      srvSrc.indexOf('const _taskRemote = findRemoteProject(task.workdir)')
        < srvSrc.indexOf('const cli = new ClaudeCLI({ cwd: task.workdir'), true);

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

    // ── /api/files/raw: an inline SVG is a document, not a picture ────────────
    // Navigating to a stored .svg executes its <script> in THIS origin with the
    // session cookie. helmet's CSP is off (the SPA is one file of inline scripts),
    // so the route has to carry `sandbox` itself. Scoped to SVG — the PDF branch of
    // this same endpoint feeds an iframe viewer and must stay unsandboxed.
    console.log('\n— an inline SVG cannot script the app origin —');
    async function rawHeaders(rel) {
      const r = await fetch(`${BASE}/api/files/raw?path=${encodeURIComponent(rel)}`,
        { headers: { 'x-auth-token': TOKEN } });
      await r.arrayBuffer();                       // drain, else the socket lingers
      return [r.status, r.headers.get('content-security-policy')];
    }
    fs.writeFileSync(path.join(inside, 'x.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    fs.writeFileSync(path.join(inside, 'x.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    check('/api/files/raw sandboxes an inline SVG',
      await rawHeaders('inside/x.svg'), [200, "sandbox; frame-ancestors 'none'"]);
    check('and leaves a plain image unsandboxed',
      await rawHeaders('inside/x.png'), [200, "frame-ancestors 'none'"]);

    // ── /api/project-files: the same symlink rule, on the @-mention endpoints ──
    // These two took `dir` and `path` from the query and compared them with plain
    // path.resolve + startsWith. The /api/files family above resolves symlinks first;
    // these did not, so the very link /api/files refuses read straight through here.
    // Both require `dir` to belong to a registered LOCAL project, hence the fixture.
    console.log('\n— the @-mention file search resolves symlinks too —');
    const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-pathguard-outside-'));
    process.on('exit', () => { try { fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch {} });
    fs.writeFileSync(path.join(OUTSIDE, 'canary.txt'), 'CANARY');
    const canaryLink = path.join(inside, 'canary-link.txt');
    fs.symlinkSync(path.join(OUTSIDE, 'canary.txt'), canaryLink);
    // Not decoration: if the host cannot symlink, the assertion below would pass
    // against a path that simply does not exist.
    check('the escaping symlink fixture points out of the project',
      fs.readFileSync(canaryLink, 'utf-8'), 'CANARY');

    const proj = await api('POST', '/api/projects', { name: 'pathguard', workdir: APP_DIR });
    check('a local project is registered for the search endpoints', proj.status, 200);

    const pfRead = await api('GET', `/api/project-files/read?dir=${encodeURIComponent(APP_DIR)}`
      + `&path=${encodeURIComponent(canaryLink)}`);
    check('/api/project-files/read refuses a symlink pointing out of the project',
      [pfRead.status, pfRead.json?.content], [403, undefined]);
    check('/api/project-files refuses a dir that is itself a symlink out',
      (await api('GET', `/api/project-files?dir=${encodeURIComponent(escape)}&q=`)).status, 403);
    // Positive control — a blanket 403 would pass both lines above.
    const pfOk = await api('GET', `/api/project-files/read?dir=${encodeURIComponent(APP_DIR)}`
      + `&path=${encodeURIComponent(path.join(inside, 'ok.txt'))}`);
    check('and a real file inside the project still reads',
      [pfOk.status, pfOk.json?.content], [200, 'hello']);

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
