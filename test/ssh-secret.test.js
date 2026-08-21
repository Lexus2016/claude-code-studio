// An SSH credential must never leave the server process.
//
// The SSH host attachment carries a password. Three places used to hand that
// password onward, and each one lands somewhere that outlives the chat:
//
//   1. buildAttachmentContentBlocks() interpolated it into a prompt text block.
//      That block is passed to the CLI as `-p <prompt>` (claude-cli.js:270) and is
//      written verbatim into the transcript jsonl on disk.
//   2. serializeMessageAttachments() persisted it into messages.attachments, a
//      plaintext column in data/chats.db.
//   3. saveInterruptAttachments() returned it to the MCP subprocess, which turns it
//      into a tool result the model reads.
//
// None of the three bought anything: there is no sshpass anywhere in this project,
// so the model cannot use a password non-interactively even when handed one. Real
// SSH runs server-side in claude-ssh.js, reading the credential from the host entry.
//
// Everything below is asserted against a REAL server on a THROWAWAY APP_DIR — never
// the developer's chats.db — with a fake `claude` on the HOME probe path that records
// its own argv. Every leak assertion is paired with a POSITIVE CONTROL, because
// "the password is absent" also holds when the SSH path never ran at all.
//
// Run: node test/ssh-secret.test.js
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

// 3991-3997 are claimed by the other suites in the serial chain.
const PORT = Number(process.env.TEST_PORT || 3998);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-sshsec-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-sshsec-home-'));
// Every early process.exit() below (port already in use, server never came up,
// no auth cookie) jumps past the rmSync at the bottom of the file and leaves a
// directory behind in /tmp on each run. An exit hook covers all of them.
process.on('exit', () => { for (const _d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(_d, { recursive: true, force: true }); } catch {} } });
const DUMP_DIR = path.join(APP_DIR, 'dump');
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
fs.mkdirSync(DUMP_DIR, { recursive: true });

// Both generated per run, so no credential literal ever lands in the repo and a
// grep for either string cannot collide with unrelated content.
const LOGIN_PW = crypto.randomBytes(18).toString('hex');
const SSH_PW   = 'sshsecret-' + crypto.randomBytes(18).toString('hex');

// The fake `claude`. findClaudeBin() probes $HOME/.local/bin/claude first and has no
// env override, so HOME is what gets redirected. It records its argv — which is where
// the prompt lives — and, while the `hold` sentinel exists, polls the internal MCP
// interrupt endpoint exactly as mcp-user-interrupt.js does, recording what it is given.
const binDir = path.join(HOME_DIR, '.local', 'bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const DUMP = ${JSON.stringify(DUMP_DIR)};
fs.writeFileSync(path.join(DUMP, 'argv-' + process.pid + '.json'), JSON.stringify(process.argv.slice(2)));
const hold = path.join(DUMP, 'hold');
const url = process.env.CCS_INTERRUPT_URL, sec = process.env.CCS_INTERRUPT_SECRET, sid = process.env.CCS_INTERRUPT_SESSION;
(async () => {
  while (fs.existsSync(hold)) {
    await new Promise(r => setTimeout(r, 100));
    if (!(url && sec && sid)) continue;
    try {
      const r = await fetch(url + '/api/internal/user-interrupt', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sec },
        body: JSON.stringify({ sessionId: sid }),
      });
      const j = await r.json();
      if (j && Array.isArray(j.messages) && j.messages.length) {
        fs.appendFileSync(path.join(DUMP, 'interrupts.jsonl'), JSON.stringify(j.messages) + '\\n');
      }
    } catch {}
  }
  process.exit(0);
})();
`);
fs.chmodSync(path.join(binDir, 'claude'), 0o755);

let TOKEN = null;
async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(TOKEN ? { 'x-auth-token': TOKEN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await r.json(); } catch {}
  // The token is handed out as an httpOnly cookie, never in the JSON body.
  const setCookie = r.headers.get('set-cookie') || '';
  const cookieToken = (setCookie.match(/(?:^|[;,\s])token=([^;,\s]+)/) || [])[1] || null;
  return { status: r.status, json, cookieToken };
}

// The parent shell of a Claude Code session exports CCS_DESKTOP=1 (auth wall off) and
// APP_DIR (repoints data/ at the real user dir), so the child env is scrubbed.
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
// loaded box. Same helper shape as terminal-bridge.integration.test.js.
async function waitFor(pred, { timeoutMs = 25000, intervalMs = 60 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v; try { v = await pred(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

const dumpedArgv = () => fs.readdirSync(DUMP_DIR)
  .filter(f => f.startsWith('argv-'))
  .map(f => JSON.parse(fs.readFileSync(path.join(DUMP_DIR, f), 'utf8')));

function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { 'x-auth-token': TOKEN } });
  ws._frames = [];
  ws.on('message', raw => { try { ws._frames.push(JSON.parse(raw)); } catch {} });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 10000);
  });
}

(async () => {
  if (await canConnect('127.0.0.1', PORT, 500)) {
    console.error(`port ${PORT} is already in use — refusing to run against someone else's server. Set TEST_PORT.`);
    process.exit(1);
  }

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: childEnv({ PORT: String(PORT), APP_DIR, WORKDIR: APP_DIR, HOME: HOME_DIR, HOST: '127.0.0.1', LOG_LEVEL: 'error' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  const stop = () => { try { srv.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);

  try {
    // setupDone===false identifies OUR freshly-seeded instance; a stray server on this
    // port answers 200 too and would pass half the asserts for the wrong reason.
    const up = await waitFor(async () => {
      const r = await api('GET', '/api/auth/status');
      return r.status === 200 && r.json?.setupDone === false;
    }, { timeoutMs: 20000 });
    if (!up) { console.error('server did not come up on a fresh APP_DIR'); console.error(srvLog.slice(-3000)); stop(); process.exit(1); }

    const setup = await api('POST', '/api/auth/setup', { password: LOGIN_PW, displayName: 'sshsec' });
    TOKEN = setup.cookieToken;
    if (!TOKEN) { console.error('no auth cookie from /api/auth/setup'); stop(); process.exit(1); }

    // ── the host entry itself ────────────────────────────────────────────────
    console.log('\n— the stored host entry —');
    const created = await api('POST', '/api/remote-hosts', {
      label: 'sshsec-host', host: '198.51.100.7', port: 22, user: 'root', password: SSH_PW,
    });
    const hostId = created.json?.id;
    check('a host with a password can still be created', typeof hostId === 'string' && hostId.length > 0, true);
    check('the create response masks the password', JSON.stringify(created.json).includes(SSH_PW), false);
    check('the list endpoint masks the password',
      JSON.stringify((await api('GET', '/api/remote-hosts')).json).includes(SSH_PW), false);
    const hostsFile = fs.readFileSync(path.join(APP_DIR, 'data', 'remote-hosts.json'), 'utf8');
    check('the on-disk host file stores it encrypted, not in the clear', hostsFile.includes(SSH_PW), false);
    check('positive control: the host file really does hold this entry', hostsFile.includes('198.51.100.7'), true);

    // ── surface 1+2: the prompt handed to the CLI, and the DB row ────────────
    console.log('\n— a chat turn carrying an SSH attachment —');
    fs.writeFileSync(path.join(DUMP_DIR, 'hold'), '1');   // make the fake claude linger
    const sess = await api('POST', '/api/sessions', { title: 'sshsec' });
    const sid = sess.json?.id;
    check('a session was created', typeof sid === 'string' || typeof sid === 'number', true);

    const ws = await openWs();
    ws.send(JSON.stringify({
      type: 'chat', text: 'connect to the host', tabId: sid, sessionId: sid, model: 'sonnet', mode: 'auto',
      attachments: [{ type: 'ssh', hostId, label: 'sshsec-host', host: '198.51.100.7', port: 22 }],
    }));

    const argvSeen = await waitFor(() => dumpedArgv().length > 0);
    check('the CLI was actually invoked', argvSeen !== null, true);

    const promptArgs = dumpedArgv().map(a => {
      const i = a.indexOf('-p');
      return i >= 0 ? String(a[i + 1] || '') : '';
    });
    const prompt = promptArgs.find(p => p.includes('[SSH Host:')) || '';
    check('positive control: the SSH block reached the prompt at all', prompt.length > 0, true);
    check('positive control: the prompt names the host', prompt.includes('198.51.100.7'), true);
    check('positive control: the prompt states the auth method', prompt.includes('Auth: password'), true);
    check('the prompt carries no credential', prompt.includes(SSH_PW), false);
    check('and no argv anywhere carries it', JSON.stringify(dumpedArgv()).includes(SSH_PW), false);

    // ── surface 3: the MCP interrupt payload ─────────────────────────────────
    console.log('\n— an interrupt carrying an SSH attachment —');
    ws.send(JSON.stringify({
      type: 'interrupt', tabId: sid, text: 'use this host instead',
      attachments: [{ type: 'ssh', hostId, label: 'sshsec-host', host: '198.51.100.7', port: 22 }],
    }));
    const queued = await waitFor(() => ws._frames.some(f => f.type === 'interrupt_queued'));
    check('the interrupt was queued rather than run as a new turn', queued === true, true);

    const ipath = path.join(DUMP_DIR, 'interrupts.jsonl');
    const delivered = await waitFor(() => fs.existsSync(ipath) && fs.readFileSync(ipath, 'utf8').trim().length > 0);
    check('the MCP subprocess was handed the interrupt', delivered === true, true);
    const payload = delivered ? fs.readFileSync(ipath, 'utf8') : '';
    const att = delivered
      ? (JSON.parse(payload.trim().split('\n')[0])[0]?.attachments || []).find(a => a.type === 'ssh')
      : null;
    check('positive control: the SSH attachment reached the MCP payload', !!att, true);
    check('positive control: it names the host', att?.host, '198.51.100.7');
    check('positive control: it reports the auth method', att?.authMethod, 'password');
    check('the MCP payload carries no credential', payload.includes(SSH_PW), false);
    // No `att || {}` fallback: with one, a payload that carried no attachment at all
    // would satisfy this line while proving nothing. `att` is asserted non-null above.
    check('and it has no password field at all', Object.prototype.hasOwnProperty.call(att, 'password'), false);
    // Absence of the plaintext is not the same as absence of the field: an encrypted
    // or base64 copy would pass the includes() check above and still be a leak.
    //
    // `sshKeyPath` is on the allow-list and nothing else is. It is a PATH to a key
    // file, never the key itself — server.js says so at the point it builds this
    // object, and mcp-user-interrupt.js prints it to the model as `SSH Key: <path>`
    // on purpose, so the model can name the host's key without ever holding it.
    // Matching on the name alone flagged it as a leak; matching on a name AND a
    // non-empty value is what actually distinguishes material from metadata.
    const CRED_SHAPED = /pass|secret|key|credential|token/i;
    const ALLOWED_PATH_FIELDS = ['sshKeyPath'];
    check('nor any other credential-shaped field',
      Object.entries(att)
        .filter(([k, v]) => CRED_SHAPED.test(k) && !ALLOWED_PATH_FIELDS.includes(k) && v !== '' && v != null)
        .map(([k]) => k), []);
    // This host authenticates by password, so the allow-listed field must be empty
    // here — which is the only reason the line above can be trusted at all. If a
    // future change starts populating it from a password-only host, this fails.
    check('and the allow-listed path field is empty for a password host', att.sshKeyPath, '');
    // The allow-list is scoped to a path. Key MATERIAL in any field, under any name,
    // is still a leak — and a PEM body would sail past the SSH_PW includes() check.
    check('no key material anywhere in the payload', /BEGIN [A-Z ]*PRIVATE KEY/.test(payload), false);
    // Positive control: the filter above still catches a populated credential field.
    // Without this, narrowing the match could have disarmed the assertion entirely.
    check('positive control: a populated password field would still be caught',
      Object.entries({ ...att, password: 'x' })
        .filter(([k, v]) => CRED_SHAPED.test(k) && !ALLOWED_PATH_FIELDS.includes(k) && v !== '' && v != null)
        .map(([k]) => k), ['password']);
    check('positive control: so would an encrypted copy under another name',
      Object.entries({ ...att, credentialBlob: 'AES:zzz' })
        .filter(([k, v]) => CRED_SHAPED.test(k) && !ALLOWED_PATH_FIELDS.includes(k) && v !== '' && v != null)
        .map(([k]) => k), ['credentialBlob']);

    try { fs.unlinkSync(path.join(DUMP_DIR, 'hold')); } catch {}
    await waitFor(() => ws._frames.some(f => f.type === 'done'), { timeoutMs: 15000 });

    // ── surface 2, both shapes: what actually sits in chats.db ───────────────
    console.log('\n— what is written to messages.attachments —');
    // An ad-hoc host: no hostId, the credential arrives inline from the browser. This is
    // the shape that reached SQLite in the clear, since the hostId path never persisted it.
    const sess2 = await api('POST', '/api/sessions', { title: 'sshsec-inline' });
    const sid2 = sess2.json?.id;
    const ws2 = await openWs();
    ws2.send(JSON.stringify({
      type: 'chat', text: 'connect', tabId: sid2, sessionId: sid2, model: 'sonnet', mode: 'auto',
      attachments: [{ type: 'ssh', label: 'adhoc', host: '198.51.100.9', port: 2222, password: SSH_PW }],
    }));
    const stored = await waitFor(async () => {
      const r = await api('GET', `/api/sessions/${sid2}/messages`);
      const rows = Array.isArray(r.json) ? r.json : (r.json?.messages || []);
      const m = rows.find(x => x.attachments && String(x.attachments).includes('198.51.100.9'));
      return m ? String(m.attachments) : false;
    });
    check('positive control: the attachment row was persisted', typeof stored === 'string', true);
    check('positive control: it keeps the host', String(stored).includes('198.51.100.9'), true);
    check('the stored row carries no credential', String(stored).includes(SSH_PW), false);

    const storedById = await waitFor(async () => {
      const r = await api('GET', `/api/sessions/${sid}/messages`);
      const rows = Array.isArray(r.json) ? r.json : (r.json?.messages || []);
      const m = rows.find(x => x.attachments && String(x.attachments).includes('198.51.100.7'));
      return m ? String(m.attachments) : false;
    });
    check('positive control: the hostId-shaped row was persisted too', typeof storedById === 'string', true);
    check('positive control: it keeps the hostId, the pointer to the credential',
      String(storedById).includes(hostId), true);
    check('the hostId-shaped row carries no credential', String(storedById).includes(SSH_PW), false);

    // Nothing anywhere under the data directory may hold it in the clear. This is the
    // catch-all: it fails even if a future code path invents a fourth surface.
    console.log('\n— the data directory as a whole —');
    const leaked = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        let buf; try { buf = fs.readFileSync(p); } catch { continue; }
        if (buf.includes(SSH_PW)) leaked.push(path.relative(APP_DIR, p));
      }
    };
    walk(path.join(APP_DIR, 'data'));
    check('no file under data/ contains the credential in the clear', leaked, []);

    try { ws.close(); } catch {}
    try { ws2.close(); } catch {}
  } finally {
    try { fs.unlinkSync(path.join(DUMP_DIR, 'hold')); } catch {}
    stop();
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
