// Integration test for the SSH remote CLI-session import (issue #23).
//
// Covers GET /api/sessions/cli-list-remote and POST /api/sessions/cli-import-remote
// against a FAKE remote whose filesystem this test owns. No sshd is started, no key is
// generated and ~/.ssh is never touched.
//
// How the fake remote works — and why it is worth more than a mock:
// claude-ssh.js resolves its transport through CCS_REMOTE_EXEC_HOOK. The hook installed
// here runs the *real* command string the endpoints build, through a real /bin/sh, with
// HOME pointed at a throwaway directory. So every assertion below also exercises the
// POSIX-sh scripts themselves — the `wc -c` size check, the `dd` head-read, the glob
// auto-discovery, the `case "$f" in "$b"/*)` base guard and shellEscape() quoting. A
// plain stub would have proved none of that.
//
// Named assertions that fail if a guard is removed (see the mutation notes in the PR):
//   - "remote list: ../ escape in ?project= is refused (400)"
//   - "remote import: ../ escape in projects{} is refused per-session"
//   - "remote import: oversize transcript is refused"
//   - "remote import produces the SAME message rows as the local import"
//
// Run: node test/cli-import-remote.test.js   (TEST_PORT=<n> to move off the default port)
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT  = Number(process.env.TEST_PORT || 4517);
const PORT2 = PORT + 1;                       // real-SSH bonus server (unhooked)
const BASE  = `http://127.0.0.1:${PORT}`;
const BASE2 = `http://127.0.0.1:${PORT2}`;

// ── Throwaway directories ────────────────────────────────────────────────────
const APP_DIR     = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-remimp-app-'));
const APP_DIR2    = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-remimp-app2-'));  // bonus server only
const HOME_DIR    = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-remimp-home-'));   // the studio's own $HOME
const REMOTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-remimp-rem-'));    // the fake remote's $HOME
const BARE_HOME   = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-remimp-bare-'));   // a remote with no ~/.claude
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// The workdir both sides pretend the CLI ran in — its slug is the project directory name.
const WORKDIR = path.join(APP_DIR, 'proj');
fs.mkdirSync(WORKDIR, { recursive: true });
const SLUG = WORKDIR.replace(/[/_]/g, '-');            // mirrors cwdToCliProjectName()

// A password we then hunt for in every response body and in the whole server log.
const SECRET_PW = 'pw-3f9c1a-never-leak';

// One transcript, byte-identical on both sides, under two different session ids so the
// remote import and the local import can both run and be compared row for row.
const LOCAL_ID  = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const REMOTE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BIG_ID    = 'cccccccc-3333-4333-8333-cccccccccccc';
const TS = '2026-08-01T10:00:00.000Z';
// A transcript pulled off a remote host is UNTRUSTED input: it reaches SQLite and then
// the SPA. The app has exactly one escaping point for message bodies — renderMd(), which
// HTML-escapes everything outside a fenced code block — and imported rows reach it the
// same way locally imported rows do. This payload rides along in the shared fixture so
// the parity assertion below proves the two paths store byte-identical rows: no
// server-side escaping, no double-encoding, therefore no second path to audit.
const XSS_PAYLOAD = 'Done. <img src=x onerror="alert(1)"> & <script>alert(String.fromCharCode(49))<\/script> \'q\'';
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', timestamp: TS, cwd: WORKDIR, message: { content: 'refactor the parser please' } }),
  JSON.stringify({ type: 'assistant', timestamp: TS, message: { content: [
    { type: 'thinking', thinking: 'weighing two options' },
    { type: 'text', text: 'Starting with the tokenizer.' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x.js' } },
  ] } }),
  JSON.stringify({ type: 'user', timestamp: TS, message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  JSON.stringify({ type: 'user', timestamp: TS, message: { content: [{ type: 'text', text: 'looks good' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: TS, message: { content: [{ type: 'text', text: XSS_PAYLOAD }] } }),
].join('\n') + '\n';

// Local side: $HOME/.claude/projects/<slug>/<LOCAL_ISECRET_PW.jsonl
const localProjDir = path.join(HOME_DIR, '.claude', 'projects', SLUG);
fs.mkdirSync(localProjDir, { recursive: true });
fs.writeFileSync(path.join(localProjDir, LOCAL_ID + '.jsonl'), TRANSCRIPT);

// Remote side: same slug, plus an EMPTY project dir so auto-discovery has to skip it.
const remoteProjDir = path.join(REMOTE_HOME, '.claude', 'projects', SLUG);
fs.mkdirSync(remoteProjDir, { recursive: true });
fs.writeFileSync(path.join(remoteProjDir, REMOTE_ID + '.jsonl'), TRANSCRIPT);
fs.mkdirSync(path.join(REMOTE_HOME, '.claude', 'projects', '-empty-project'), { recursive: true });
// A project directory whose NAME is shell syntax. Every remote script interpolates this
// name, so it only ever resolves if shellEscape() quoted it; drop the escaping and the
// `;` terminates the command, `$( )` substitutes, and the spaces split the word — the
// transcript below then becomes unreachable and the three INJ_* assertions fail.
// The marker is SPLIT in the literal name (`CCS` + `$(echo PWNED)`) and only becomes the
// contiguous string CCSPWNED if the shell actually evaluates it — so the "never ran"
// assertion below cannot be satisfied merely by the name being echoed back in a path.
const INJ_DIR = 'inj;echo CCS$(echo PWNED);-p r o j';
const INJ_ID  = 'dddddddd-4444-4444-8444-dddddddddddd';
fs.mkdirSync(path.join(REMOTE_HOME, '.claude', 'projects', INJ_DIR), { recursive: true });
fs.writeFileSync(path.join(REMOTE_HOME, '.claude', 'projects', INJ_DIR, INJ_ID + '.jsonl'), TRANSCRIPT);
// Oversize transcript: valid JSONL, but well past the 4 KB cap this run imposes.
fs.writeFileSync(path.join(remoteProjDir, BIG_ID + '.jsonl'),
  TRANSCRIPT + JSON.stringify({ type: 'user', timestamp: TS, message: { content: 'x'.repeat(9000) } }) + '\n');
// A file that must never be reachable through ~/.claude/projects.
fs.writeFileSync(path.join(REMOTE_HOME, 'secret-outside.txt'), 'must not be readable via the import');
const IMPORT_CAP = 4096;

// ── The fake transport ───────────────────────────────────────────────────────
// Selected by hostname so one hook covers every failure mode the UI has a message for.
const HOOK = path.join(APP_DIR, 'fake-remote-exec.js');
fs.writeFileSync(HOOK, `
const { execFile } = require('child_process');
exports.runRemoteCommand = function ({ host, password, command }) {
  return new Promise((resolve, reject) => {
    const fail = (msg, ccsCode) => { const e = new Error(msg); e.ccsCode = ccsCode; reject(e); };
    if (/unreachable/.test(host)) return fail('Cannot reach unreachable.invalid:22', 'unreachable');
    if (/badauth/.test(host))     return fail('Authentication failed for tester@badauth.invalid', 'auth_failed');
    // A deliberately leaky driver: proves runRemoteCommand() scrubs the secret itself
    // rather than trusting every transport to behave.
    if (/leaky/.test(host))       return fail('ssh handshake failed (tried password ' + password + ')', 'exec_failed');
    const home = /bare/.test(host) ? process.env.CCS_TEST_BARE_HOME : process.env.CCS_TEST_REMOTE_HOME;
    execFile('/bin/sh', ['-c', command],
      { env: { HOME: home, PATH: process.env.PATH }, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout, stderr }));
  });
};
`);

// ── Server lifecycle ─────────────────────────────────────────────────────────
// Only ever signals a pid recorded at spawn time — never a pid looked up by name.
// `children` holds every server this test spawned (the hooked one, and — only when
// this machine already allows passwordless ssh to itself — an unhooked one for the
// real-SSH bonus). They are started sequentially so two processes never share a db.
const children = [];
let srvLog = '';

function startServer(port, appDir, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port), CCS_DESKTOP: '1', APP_DIR: appDir, WORKDIR, HOME: HOME_DIR,
      CCS_REMOTE_IMPORT_MAX_BYTES: String(IMPORT_CAP),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const h = { child, exited: false, port };
  child.on('exit', () => { h.exited = true; });
  child.stdout.on('data', d => { srvLog += d; });
  child.stderr.on('data', d => { srvLog += d; });
  children.push(h);
  return h;
}
async function stopServer(h) {
  if (!h || h.exited) return;
  try { h.child.kill('SIGTERM'); } catch {}
  for (let i = 0; i < 60 && !h.exited; i++) await sleep(50);
}
function killServer() { for (const h of children) if (!h.exited) { try { h.child.kill('SIGTERM'); } catch {} } }
function removeTempDirs() {
  for (const d of [APP_DIR, APP_DIR2, HOME_DIR, REMOTE_HOME, BARE_HOME]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}
let cleanedUp = false;
function cleanup() { if (cleanedUp) return; cleanedUp = true; killServer(); removeTempDirs(); }

// Wait for a spawned server to answer, and prove the answer comes from OUR child.
async function awaitReady(h, base) {
  let up = false;
  for (let i = 0; i < 80; i++) {
    if (h.exited) break;
    try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (h.exited) die(`server on port ${h.port} exited before it became ready — port collision or startup crash`);
  if (!up) die(`server on port ${h.port} did not start`);
  const banner = new RegExp(`"port":\\s*"?${h.port}"?`);
  if (!(srvLog.includes('server started') && banner.test(srvLog))) {
    die(`something on port ${h.port} answers /api/health but our server never logged "server started" — refusing to assert against a foreign instance`);
  }
}

// 'exit' covers the normal and the thrown-assertion paths. It does NOT fire on a signal,
// which is how a cancelled CI job would otherwise leave an orphaned server on the port.
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(1); });
}
async function cleanupGracefully() {
  if (cleanedUp) return;
  for (const h of children) await stopServer(h);
  cleanup();
}
function die(msg) {
  console.error(msg);
  if (srvLog) console.error(srvLog.slice(-2000));
  cleanup();
  process.exit(1);
}

async function api(method, url, body, base = BASE) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
// /export is the only read path that returns tool rows too (the paginated
// /messages endpoint filters type='tool' out for the UI), so parity is compared
// against the complete set of rows the import actually wrote.
async function messagesOf(sessionId) {
  const r = await api('GET', `/api/sessions/${sessionId}/export`);
  return (r.json && r.json.messages || []).map(m => ({ role: m.role, type: m.type, content: m.content, tool_name: m.tool_name }));
}
function probePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', err => resolve(err.code || String(err)));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen(port, '127.0.0.1');
  });
}
async function addHost(label, host, opts = {}) {
  const r = await api('POST', '/api/remote-hosts',
    { label, host, port: 22, password: opts.password === undefined ? SECRET_PW : opts.password },
    opts.base || BASE);
  if (r.status !== 200 || !r.json || !r.json.id) die(`could not create remote host ${label}: ${r.text}`);
  return r.json.id;
}

(async () => {
  // ── Preflight ──────────────────────────────────────────────────────────────
  // Without this the test's own server dies with EADDRINUSE and every assertion below
  // runs against a foreign instance — importing sessions into a database this test did
  // not create. /api/health is public, so the readiness loop alone cannot tell them apart.
  const busy = await probePort(PORT);
  if (busy) {
    console.error(`\nFAIL cli-import-remote: port ${PORT} is already in use (${busy}).`);
    console.error(`  This test starts its OWN server on that port and asserts against it.`);
    console.error(`  Refusing to run: a foreign instance would make every assertion meaningless`);
    console.error(`  and would be handed imported sessions in a database this test did not create.`);
    console.error(`  Free port ${PORT}, or re-run with: TEST_PORT=<free port> node test/cli-import-remote.test.js`);
    removeTempDirs();
    process.exit(1);
  }

  const srv = startServer(PORT, APP_DIR, {
    CCS_REMOTE_EXEC_HOOK: HOOK,
    CCS_TEST_REMOTE_HOME: REMOTE_HOME,
    CCS_TEST_BARE_HOME: BARE_HOME,
  });
  await awaitReady(srv, BASE);
  if (!fs.existsSync(path.join(APP_DIR, 'data', 'chats.db'))) die('our server never created its own chats.db in the temp APP_DIR');

  // ── Saved hosts are the credential store (requirement: remember connections) ──
  console.log('saved SSH hosts are reused, and never hand back the password:');
  const okHost     = await addHost('fake-ok',     'tester@fake-remote.invalid');
  const bareHost   = await addHost('fake-bare',   'tester@bare-remote.invalid');
  const downHost   = await addHost('fake-down',   'tester@unreachable.invalid');
  const authHost   = await addHost('fake-auth',   'tester@badauth.invalid');
  const leakyHost  = await addHost('fake-leaky',  'tester@leaky.invalid');

  const listed = await api('GET', '/api/remote-hosts');
  check('GET /api/remote-hosts masks the password', (listed.json || []).every(h => h.password === '***'), true);
  check('GET /api/remote-hosts leaks no plaintext password', listed.text.includes(SECRET_PW), false);

  // ── Unknown host id ────────────────────────────────────────────────────────
  console.log('\nunknown host id:');
  const noHost = await api('GET', '/api/sessions/cli-list-remote?hostId=rh-does-not-exist');
  check('remote list: unknown hostId → 404', noHost.status, 404);
  check('remote list: unknown hostId → code host_not_found', noHost.json && noHost.json.code, 'host_not_found');
  const noHostImp = await api('POST', '/api/sessions/cli-import-remote', { hostId: 'rh-nope', sessionIds: [REMOTE_ID] });
  check('remote import: unknown hostId → 404 host_not_found',
    [noHostImp.status, noHostImp.json && noHostImp.json.code], [404, 'host_not_found']);

  // ── Distinct, actionable failures ──────────────────────────────────────────
  console.log('\ndistinct failure codes:');
  const down = await api('GET', `/api/sessions/cli-list-remote?hostId=${downHost}`);
  check('remote list: unreachable host → 502 unreachable',
    [down.status, down.json && down.json.code], [502, 'unreachable']);
  const bad = await api('GET', `/api/sessions/cli-list-remote?hostId=${authHost}`);
  check('remote list: auth failure → 401 auth_failed',
    [bad.status, bad.json && bad.json.code], [401, 'auth_failed']);
  const bare = await api('GET', `/api/sessions/cli-list-remote?hostId=${bareHost}`);
  check('remote list: remote with no ~/.claude → 200 no_claude_dir',
    [bare.status, bare.json && bare.json.code, (bare.json && bare.json.sessions || []).length], [200, 'no_claude_dir', 0]);
  const emptyProj = await api('GET', `/api/sessions/cli-list-remote?hostId=${okHost}&project=-empty-project`);
  check('remote list: project dir with no transcripts → code empty',
    [emptyProj.status, emptyProj.json && emptyProj.json.code, emptyProj.json.sessions.length], [200, 'empty', 0]);

  // ── Credentials never come back out ────────────────────────────────────────
  console.log('\ncredential non-leakage:');
  const leak = await api('GET', `/api/sessions/cli-list-remote?hostId=${leakyHost}`);
  check('remote list: a leaky transport error still returns 502', leak.status, 502);
  check('remote list: the password is redacted out of the error body', leak.text.includes(SECRET_PW), false);
  check('remote list: the redaction marker is present instead', /\*\*\*/.test(leak.json && leak.json.error || ''), true);

  // ── Path traversal ─────────────────────────────────────────────────────────
  console.log('\npath traversal on the remote path:');
  for (const evil of ['../../../../etc', '..', '../-empty-project', '/etc']) {
    const r = await api('GET', `/api/sessions/cli-list-remote?hostId=${okHost}&project=${encodeURIComponent(evil)}`);
    check(`remote list: ../ escape in ?project= is refused (400) — ${evil}`,
      [r.status, r.json && r.json.code], [400, 'invalid_path']);
  }
  const evilImport = await api('POST', '/api/sessions/cli-import-remote', {
    hostId: okHost, sessionIds: [REMOTE_ID], projects: { [REMOTE_ID]: '../../..' }, workdir: WORKDIR,
  });
  check('remote import: ../ escape in projects{} is refused per-session',
    (evilImport.json && evilImport.json.errors || []).map(e => e.error), ['path traversal']);
  check('remote import: nothing was imported through the escape',
    (evilImport.json && evilImport.json.imported || []).length, 0);

  // ── shellEscape() is load-bearing, not decorative ──────────────────────────
  // These three run against a project directory literally named
  //   inj;echo CCS$(echo PWNED);-p r o j
  // through a REAL /bin/sh. They pass only because every interpolated value in
  // remoteListScript()/remoteFetchScript() goes through shellEscape(); with the escaping
  // removed the `;` ends the command, `$( )` substitutes and the spaces split the word,
  // so the transcript can never be found.
  console.log('\nshell metacharacters in a remote project name:');
  const injList = await api('GET',
    `/api/sessions/cli-list-remote?hostId=${okHost}&project=${encodeURIComponent(INJ_DIR)}`);
  check('shellEscape: a project name full of shell syntax still lists its transcript',
    [injList.status, (injList.json && injList.json.sessions || []).map(x => x.sessionId)],
    [200, [INJ_ID]]);
  const injImp = await api('POST', '/api/sessions/cli-import-remote',
    { hostId: okHost, sessionIds: [INJ_ID], projects: { [INJ_ID]: INJ_DIR } });
  check('shellEscape: a transcript under that name still imports',
    [injImp.status, (injImp.json && injImp.json.imported || []).length, injImp.json.errors], [200, 1, []]);
  check('shellEscape: the embedded command never ran',
    /CCSPWNED/.test(injList.text + injImp.text + srvLog), false);

  // ── Listing: auto-discovery and the workdir-scoped form ────────────────────
  console.log('\nremote listing:');
  const auto = await api('GET', `/api/sessions/cli-list-remote?hostId=${okHost}`);
  check('remote list: auto-discovery reaches 200', auto.status, 200);
  const autoIds = (auto.json && auto.json.sessions || []).map(s => s.sessionId).sort();
  check('remote list: auto-discovery finds every transcript under ~/.claude/projects',
    autoIds, [REMOTE_ID, BIG_ID, INJ_ID].sort());
  check('remote list: rows carry their project slug',
    (auto.json.sessions.find(s => s.sessionId === REMOTE_ID) || {}).project, SLUG);

  const scoped = await api('GET', `/api/sessions/cli-list-remote?hostId=${okHost}&workdir=${encodeURIComponent(WORKDIR)}`);
  check('remote list: ?workdir= narrows to that project', scoped.status, 200);
  check('remote list: ?workdir= returns the same transcripts',
    scoped.json.sessions.map(s => s.sessionId).sort(), [REMOTE_ID, BIG_ID].sort());
  check('remote list: projectPath points inside the remote ~/.claude/projects',
    scoped.json.projectPath.endsWith('/.claude/projects/' + SLUG), true);

  // The row shape has to match the local listing exactly, or the picker cannot render
  // one list for both sources.
  const local = await api('GET', `/api/sessions/cli-list?workdir=${encodeURIComponent(WORKDIR)}`);
  const localRow  = (local.json && local.json.sessions || []).find(s => s.sessionId === LOCAL_ID);
  const remoteRow = auto.json.sessions.find(s => s.sessionId === REMOTE_ID);
  if (!localRow) die('the local cli-list did not see the fixture transcript — the test setup is wrong');
  check('remote row has the same keys as a local row',
    Object.keys(localRow).sort().every(k => k in remoteRow), true);
  check('remote row: title matches the local row for the same transcript', remoteRow.title, localRow.title);
  check('remote row: timestamp matches', remoteRow.timestamp, localRow.timestamp);
  check('remote row: messageCount matches', remoteRow.messageCount, localRow.messageCount);
  check('remote row: not yet imported', remoteRow.alreadyImported, false);

  // ── Oversize transcript ────────────────────────────────────────────────────
  console.log('\nsize cap:');
  const big = await api('POST', '/api/sessions/cli-import-remote',
    { hostId: okHost, sessionIds: [BIG_ID], workdir: WORKDIR });
  check('remote import: oversize transcript is refused',
    (big.json && big.json.errors || []).length, 1);
  check('remote import: the refusal names the size cap',
    /transcript too large/.test(((big.json.errors || [])[0] || {}).error || ''), true);
  check('remote import: the oversize transcript created no session',
    (big.json.imported || []).length, 0);

  // ── The actual import, compared row-for-row with a local import ────────────
  console.log('\nimport parity with the local path:');
  const rimp = await api('POST', '/api/sessions/cli-import-remote',
    { hostId: okHost, sessionIds: [REMOTE_ID], workdir: WORKDIR });
  check('remote import: 200', rimp.status, 200);
  check('remote import: one session imported', (rimp.json && rimp.json.imported || []).length, 1);
  check('remote import: no errors', (rimp.json.errors || []), []);
  const remoteNewId = rimp.json.imported[0].newId;

  const limp = await api('POST', '/api/sessions/cli-import', { sessionIds: [LOCAL_ID], workdir: WORKDIR });
  check('local import: one session imported', (limp.json && limp.json.imported || []).length, 1);
  const localNewId = limp.json.imported[0].newId;

  const remoteMsgs = await messagesOf(remoteNewId);
  const localMsgs  = await messagesOf(localNewId);
  check('local import produced the expected rows', localMsgs.length, 6);
  check('remote import produces the SAME message rows as the local import', remoteMsgs, localMsgs);
  check('remote import kept the tool_use row', remoteMsgs.filter(m => m.type === 'tool').map(m => m.tool_name), ['Read']);
  check('remote import kept the thinking row', remoteMsgs.filter(m => m.type === 'thinking').length, 1);
  check('remote import dropped the pure tool_result user entry',
    remoteMsgs.filter(m => m.role === 'user').length, 2);

  // Untrusted remote text reaches SQLite unmodified, exactly as local text does — the
  // single escaping point is renderMd() in the SPA, which both sources render through.
  // If the remote path ever grew its own encode/decode step, these two diverge.
  const remotePayload = remoteMsgs.filter(m => m.role === 'assistant' && m.type === 'text').pop();
  const localPayload  = localMsgs .filter(m => m.role === 'assistant' && m.type === 'text').pop();
  check('untrusted remote content is stored verbatim, byte for byte',
    remotePayload && remotePayload.content, XSS_PAYLOAD);
  check('untrusted content stored by the remote path equals what the local path stores',
    remotePayload && remotePayload.content, localPayload && localPayload.content);

  const rsess = await api('GET', `/api/sessions/${remoteNewId}`);
  check('remote import records claude_session_id', rsess.json && rsess.json.claude_session_id, REMOTE_ID);
  check('remote import records the transcript timestamp', String(rsess.json.created_at), TS);
  check('remote import title matches the local import title',
    rimp.json.imported[0].title, limp.json.imported[0].title);

  // ── Re-import is a no-op, and the listing now says so ──────────────────────
  console.log('\nre-import:');
  const again = await api('POST', '/api/sessions/cli-import-remote',
    { hostId: okHost, sessionIds: [REMOTE_ID], workdir: WORKDIR });
  check('remote import: an already-imported session is skipped, not duplicated',
    [(again.json.imported || []).length, again.json.skipped], [0, [REMOTE_ID]]);
  const after = await api('GET', `/api/sessions/cli-list-remote?hostId=${okHost}`);
  check('remote list: the imported row is now flagged alreadyImported',
    (after.json.sessions.find(s => s.sessionId === REMOTE_ID) || {}).alreadyImported, true);

  // ── Host key policy: trust on first use, refuse on change ──────────────────
  // Unit-level on purpose: CCS_REMOTE_EXEC_HOOK replaces the ssh2 transport wholesale,
  // so the verifier can only be exercised by calling it. It is the same function all
  // three connection sites in claude-ssh.js install.
  console.log('\nhost key pinning (TOFU):');
  const { makeHostVerifier, hostKeyFingerprint } = require('../claude-ssh');
  const khFile = path.join(APP_DIR, 'kh.json');
  const KEY_A = Buffer.from('ssh-ed25519 AAAA-fixture-key-A');
  const KEY_B = Buffer.from('ssh-ed25519 AAAA-fixture-key-B');
  const v1 = makeHostVerifier('h.example', 22, { knownHostsFile: khFile });
  check('host key: the first connection is accepted and pinned', [v1(KEY_A), v1.state.pinnedNow], [true, true]);
  check('host key: the pin was persisted',
    (JSON.parse(fs.readFileSync(khFile, 'utf8'))['h.example:22'] || {}).fingerprint, hostKeyFingerprint(KEY_A));
  const v2 = makeHostVerifier('h.example', 22, { knownHostsFile: khFile });
  check('host key: the same key is accepted on every later connection', [v2(KEY_A), v2.state.rejected], [true, false]);
  const v3 = makeHostVerifier('h.example', 22, { knownHostsFile: khFile });
  check('host key: a CHANGED key is refused, not prompted for', [v3(KEY_B), v3.state.rejected], [false, true]);
  check('host key: the refusal reports the pinned fingerprint', v3.state.expected, hostKeyFingerprint(KEY_A));
  check('host key: the same host on another port is a separate pin',
    makeHostVerifier('h.example', 2222, { knownHostsFile: khFile })(KEY_B), true);
  check('host key: fingerprints use the ssh-keygen SHA256 spelling',
    /^SHA256:[A-Za-z0-9+/]+$/.test(hostKeyFingerprint(KEY_A)), true);
  process.env.CCS_SSH_HOST_KEY_POLICY = 'accept-any';
  check('host key: CCS_SSH_HOST_KEY_POLICY=accept-any is the documented escape hatch',
    makeHostVerifier('h.example', 22, { knownHostsFile: khFile })(KEY_B), true);
  delete process.env.CCS_SSH_HOST_KEY_POLICY;
  const v5 = makeHostVerifier('h.example', 22, { knownHostsFile: khFile });
  check('host key: the escape hatch did not overwrite the pin', [v5(KEY_B), v5.state.rejected], [false, true]);

  // ── Nothing outside ~/.claude/projects was ever read ───────────────────────
  console.log('\nblast radius:');
  const allText = [noHost.text, down.text, bad.text, bare.text, leak.text, auto.text, scoped.text, rimp.text, evilImport.text].join('\n');
  check('no response body ever contained the file that lives outside the base',
    allText.includes('must not be readable via the import'), false);
  check('the password never reached any response body', allText.includes(SECRET_PW), false);
  check('the password never reached the server log', srvLog.includes(SECRET_PW), false);

  // ── Bonus: a real SSH round trip, only if this machine already allows it ───
  // Runs against a SECOND server started WITHOUT CCS_REMOTE_EXEC_HOOK, so it exercises
  // the ssh2 transport in claude-ssh.js for real. Skipped silently otherwise; this test
  // never enables sshd, never writes ~/.ssh and never generates a key.
  console.log('\nreal SSH (bonus, skipped unless `ssh localhost true` already works):');
  let sshWorks = false;
  try {
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=3', 'localhost', 'true'], { stdio: 'ignore', timeout: 8000 });
    sshWorks = true;
  } catch { sshWorks = false; }

  if (!sshWorks) {
    console.log('  skip real-SSH round trip: `ssh localhost true` is refused or needs a prompt on this machine');
  } else if (await probePort(PORT2)) {
    console.log(`  skip real-SSH round trip: port ${PORT2} is busy`);
  } else {
    await stopServer(srv);                       // one server at a time, one db at a time
    const srv2 = startServer(PORT2, APP_DIR2, { HOME: REMOTE_HOME });
    await awaitReady(srv2, BASE2);
    // No password: falls through to the explicit key / ssh-agent branch, exactly like
    // ClaudeSSH does. HOME is the fake remote tree, so a real ssh to localhost lands in
    // the developer's own home — hence only the shape of the reply is asserted.
    const realId = await addHost('real-localhost', `${os.userInfo().username}@localhost`,
      { password: '', base: BASE2 });
    const r = await api('GET', `/api/sessions/cli-list-remote?hostId=${realId}`, null, BASE2);
    check('real SSH: the endpoint answers with a recognised code',
      ['ok', 'empty', 'no_claude_dir', 'no_projects_dir'].includes(r.json && r.json.code), true);
    check('real SSH: no password appears in the reply', r.text.includes(SECRET_PW), false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await cleanupGracefully();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); });
