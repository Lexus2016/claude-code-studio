'use strict';
const { Client } = require('ssh2');
const { StringDecoder } = require('string_decoder');
const os  = require('os');
const path = require('path');
const fs  = require('fs');
const crypto = require('crypto');

const MAX_LINE_BUFFER    = 10 * 1024 * 1024; // 10 MB
// Idle (inactivity) watchdog — the remote process is killed ONLY after it produces no
// output for this long, so a long-but-active run is never cut off. Reset on every
// stdout/stderr chunk. Default 10 min. Config: CLAUDE_IDLE_TIMEOUT_MS (alias CLAUDE_TIMEOUT_MS).
const IDLE_TIMEOUT_MS    = parseInt(process.env.CLAUDE_IDLE_TIMEOUT_MS || process.env.CLAUDE_TIMEOUT_MS || '600000', 10) || 600000;
// Optional absolute ceiling — backstop against a process that emits forever. 0 = off.
const HARD_CAP_MS        = parseInt(process.env.CLAUDE_HARD_CAP_MS || '0', 10) || 0;

const MODEL_MAP = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', fable: 'fable' };

// Shell-escape a string using POSIX single-quotes
function shellEscape(str) {
  if (typeof str !== 'string') str = String(str);
  if (str.length === 0) return "''";
  if (/^[a-zA-Z0-9_.\/~:@=-]+$/.test(str)) return str;
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function expandTilde(v) {
  if (typeof v !== 'string') return v;
  if (v === '~') return os.homedir();
  if (v.startsWith('~/') || v.startsWith('~\\')) return path.join(os.homedir(), v.slice(2));
  return v;
}

// Parse "user@host" → { username, hostname }
// Falls back to current OS user if no "@" found
function parseHost(hostStr) {
  if (!hostStr) return { username: os.userInfo().username, hostname: '' };
  const at = hostStr.lastIndexOf('@');
  if (at > 0) return { username: hostStr.slice(0, at), hostname: hostStr.slice(at + 1) };
  return { username: os.userInfo().username, hostname: hostStr };
}

// ─── Host key verification — TRUST ON FIRST USE, said out loud ───────────────
// This is an explicit decision, written here rather than buried in a config flag,
// because the alternative (`hostVerifier: () => true`, which is what every SSH path
// in this file used to do) is a silent downgrade nobody reviewing the code notices.
//
// The policy is exactly OpenSSH's `StrictHostKeyChecking=accept-new`:
//   * FIRST connection to a given host:port — the server's public key is fingerprinted
//     (SHA256/base64, the same spelling `ssh-keygen -lf` prints) and PINNED into
//     data/ssh-known-hosts.json. The handshake proceeds.
//   * EVERY later connection — the fingerprint must equal the pin, or the handshake is
//     refused outright (ccsCode 'host_key_changed'). There is no "accept just this
//     once" prompt on purpose: a prompt that only appears during a real attack is a
//     prompt people click through.
//
// What this buys and what it does not: TOFU cannot protect the very first connection
// against an active man-in-the-middle — nothing but an out-of-band fingerprint can —
// but it detects a MitM, a swapped server or a hijacked IP on every connection after
// that, which is the realistic threat for a long-lived saved host.
//
// Escape hatch, opt-in and off by default: CCS_SSH_HOST_KEY_POLICY=accept-any restores
// the old accept-everything behaviour, for a fleet of ephemeral containers that
// regenerate their host key on every boot. Deliberately env-only — no UI, no toggle.
const KNOWN_HOSTS_FILE = path.join(process.env.APP_DIR || __dirname, 'data', 'ssh-known-hosts.json');

function hostKeyFingerprint(key) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key == null ? '' : key), 'utf8');
  return 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function readKnownHosts(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}

// A read-only data directory must not break connections — so a failed write means
// "could not pin", not "could not connect". The pin is a detection aid, not a lock.
function writeKnownHosts(file, map) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* ignore — see the note above */ }
}

// Build the ssh2 `hostVerifier` for ONE connection. `.state` is filled in as a side
// effect so the connection's error handler can turn a rejection into a specific,
// actionable message instead of ssh2's generic "Host denied (verification failed)".
function makeHostVerifier(hostname, port, opts = {}) {
  const file = opts.knownHostsFile || KNOWN_HOSTS_FILE;
  const id = `${hostname}:${Number(port) || 22}`;
  const state = { rejected: false, expected: null, actual: null, pinnedNow: false };
  const verify = (key) => {
    const fp = hostKeyFingerprint(key);
    state.actual = fp;
    if (String(process.env.CCS_SSH_HOST_KEY_POLICY || '').toLowerCase() === 'accept-any') return true;
    const known = readKnownHosts(file);
    const entry = known[id];
    if (!entry || typeof entry.fingerprint !== 'string' || !entry.fingerprint) {
      known[id] = { fingerprint: fp, firstSeen: new Date().toISOString() };
      writeKnownHosts(file, known);
      state.pinnedNow = true;
      return true;                 // trust on FIRST use
    }
    if (entry.fingerprint === fp) return true;
    state.rejected = true;         // the key changed under us
    state.expected = entry.fingerprint;
    return false;
  };
  verify.state = state;
  return verify;
}

// Fingerprints are public information — naming them in an error is safe and is the
// only way the user can tell a rotation apart from an attack.
function hostKeyMismatchError(verifier, hostname, port) {
  const st = verifier && verifier.state;
  const e = new Error(
    `Host key for ${hostname}:${Number(port) || 22} does not match the pinned fingerprint ` +
    `(pinned ${st && st.expected}, offered ${st && st.actual}). Refusing to connect. ` +
    `If you rotated the host key deliberately, delete that host's entry from data/ssh-known-hosts.json.`
  );
  e.ccsCode = 'host_key_changed';
  return e;
}

class ClaudeSSH {
  constructor(options = {}) {
    const { username, hostname } = parseHost(options.host || '');
    this.hostname   = hostname;
    this.username   = username;
    this.workdir    = options.workdir  || '~';
    this.port       = Number(options.port) || 22;
    // Auth: prefer explicit key, then password, then ssh-agent
    this.sshKeyPath = options.sshKeyPath ? expandTilde(options.sshKeyPath) : null;
    this.password   = options.password  || null;
  }

  // Build ssh2 connection config from instance fields
  _connConfig() {
    const cfg = {
      host:         this.hostname,
      port:         this.port,
      username:     this.username,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      // Always try keyboard-interactive for password hosts
      tryKeyboard: !!this.password,
    };
    if (this.password) {
      cfg.password = this.password;
    } else if (this.sshKeyPath && fs.existsSync(this.sshKeyPath)) {
      cfg.privateKey = fs.readFileSync(this.sshKeyPath);
    } else if (process.env.SSH_AUTH_SOCK) {
      cfg.agent = process.env.SSH_AUTH_SOCK;
    }
    // Trust on first use, refuse on change — see makeHostVerifier() above.
    this._hostVerifier = makeHostVerifier(this.hostname, this.port);
    cfg.hostVerifier = this._hostVerifier;
    return cfg;
  }

  _openSftp(conn) {
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp));
    });
  }

  _execText(conn, cmd) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      conn.exec(cmd, { pty: false }, (err, stream) => {
        if (err) return reject(err);
        stream.on('close', (code) => {
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(stderr.trim() || `Remote command failed (${code})`));
        });
        stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      });
    });
  }

  _uploadBuffer(sftp, remotePath, buffer) {
    return new Promise((resolve, reject) => {
      const out = sftp.createWriteStream(remotePath, { mode: 0o600 });
      out.on('close', resolve);
      out.on('error', reject);
      out.end(buffer);
    });
  }

  send({ prompt, contentBlocks, sessionId, model, maxTurns, systemPrompt, allowedTools, abortController, forkSession, name, effort }) {
    const attachmentSpecs = [];
    const textParts = [];
    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        if ((block.type === 'image' || block.type === 'file') && block.source?.data) {
          attachmentSpecs.push({
            type: block.type,
            mediaType: block.source.media_type || (block.type === 'image' ? 'image/png' : 'application/octet-stream'),
            name: String(block.source.name || '').trim(),
            data: block.source.data,
          });
        } else if (block.type === 'text' && block.text && block.text !== prompt) {
          textParts.push(block.text);
        }
      }
    }

    const h = {
      onText: null, onTool: null, onDone: null, onError: null,
      onSessionId: null, onThinking: null, onRateLimit: null, onResult: null,
      onUsage: null,
      _deltaBlocks: new Set(), _hasEmittedText: false,
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let buffer = '', stderrBuf = '', detectedSid = sessionId || null;
    let idleTimer = null;     // idle watchdog — reset on every chunk of remote output
    let hardCapTimer = null;  // optional absolute ceiling (armed only when HARD_CAP_MS > 0)
    let aborted = false;
    let finished = false;

    const conn = new Client();

    // Called exactly once when the connection/stream is done. stream 'close' and
    // 'error' can both fire — without this guard the stdout tail is flushed twice
    // and the stderr error block is re-sent to the client.
    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (hardCapTimer) { clearTimeout(hardCapTimer); hardCapTimer = null; }

      // Flush remaining stdout
      const tail = buffer + stdoutDecoder.end();
      if (tail.trim()) {
        try { this._handle(JSON.parse(tail), h); }
        catch { try { if (h.onText) h.onText(tail); } catch {} }
      }

      // Report stderr errors (filter known noise)
      if (code !== 0 && stderrBuf.trim() && h.onError) {
        const realErrors = stderrBuf.trim().split('\n')
          .filter(l => l.trim() && !l.includes('Loaded MCP') && !l.includes('Starting MCP'))
          .join('\n').trim();
        if (realErrors) try { h.onError(realErrors.substring(0, 1000)); } catch {}
      }

      if (h.onDone) h.onDone(detectedSid);
      try { conn.end(); } catch {}
    };

    conn.on('ready', () => {
      (async () => {
        let remoteTempDir = null;
        const remoteFilePaths = [];
        try {
          if (attachmentSpecs.length) {
            remoteTempDir = await this._execText(conn, 'mktemp -d /tmp/claude-att-XXXXXX');
            const sftp = await this._openSftp(conn);
            for (let i = 0; i < attachmentSpecs.length; i++) {
              const spec = attachmentSpecs[i];
              let ext = '';
              if (spec.name) ext = path.extname(spec.name).replace(/^\./, '');
              if (!ext) ext = spec.mediaType.split('/')[1] || (spec.type === 'image' ? 'png' : 'bin');
              const safeBase = spec.name
                ? path.basename(spec.name).replace(/[^a-zA-Z0-9._-]/g, '_')
                : `attachment-${i + 1}.${ext}`;
              const fileName = path.extname(safeBase) ? safeBase : `${safeBase}.${ext}`;
              const remotePath = path.posix.join(remoteTempDir, fileName);
              await this._uploadBuffer(sftp, remotePath, Buffer.from(spec.data, 'base64'));
              remoteFilePaths.push(remotePath);
            }
          }

          const prefixParts = [];
          if (textParts.length) prefixParts.push(textParts.join('\n\n'));
          if (remoteFilePaths.length) {
            prefixParts.push(`[Attached images/files — read these files on the remote host:\n${remoteFilePaths.map(f => `- ${f}`).join('\n')}\n]`);
          }
          const finalPrompt = prefixParts.length ? `${prefixParts.join('\n\n')}\n\n${prompt}` : prompt;

          const args = ['--print'];
          if (forkSession && sessionId) args.push('--fork-session');
          if (sessionId && typeof sessionId === 'string' && /^[a-f0-9-]+$/i.test(sessionId)) args.push('--resume', sessionId);
          if (typeof name === 'string') {
            const cleanName = name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
            if (cleanName) args.push('--name', cleanName);
          }
          if (model) args.push('--model', MODEL_MAP[model] || model);
          if (maxTurns) args.push('--max-turns', String(maxTurns));
          if (typeof effort === 'string') {
            const e = effort.trim().toLowerCase();
            if (['low', 'medium', 'high', 'xhigh', 'max'].includes(e)) {
              args.push('--effort', e);
            }
          }
          if (systemPrompt && !sessionId) args.push('--system-prompt', systemPrompt);
          if (allowedTools?.length) args.push('--allowedTools', ...allowedTools);
          args.push('--dangerously-skip-permissions');
          args.push('--output-format', 'stream-json', '--verbose');
          args.push('--include-partial-messages');
          args.push('-p', finalPrompt);

          const innerCmdParts = [
            'export PATH="$PATH:/usr/local/bin:/usr/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$(npm root -g 2>/dev/null)/../.bin"',
            'export IS_SANDBOX=1',
            `mkdir -p ${shellEscape(this.workdir)}`,
            `cd ${shellEscape(this.workdir)}`,
          ];
          if (remoteTempDir) innerCmdParts.push(`trap 'rm -rf ${shellEscape(remoteTempDir)}' EXIT`);
          innerCmdParts.push(`claude ${args.map(shellEscape).join(' ')}`);
          const remoteCmd = `bash -lc ${shellEscape(innerCmdParts.join(' && '))}`;

          conn.exec(remoteCmd, { pty: false }, (err, stream) => {
            if (err) {
              try { if (h.onError) h.onError(`SSH exec failed: ${err.message}`); } catch {}
              if (h.onDone) h.onDone(detectedSid);
              try { conn.end(); } catch {}
              return;
            }

            try { stream.stdin.end(); } catch {}

            if (abortController) {
              abortController.signal.addEventListener('abort', () => {
                aborted = true;
                try { stream.close(); } catch {}
                try { conn.end(); } catch {}
              }, { once: true });
            }

            stream.stdout.on('data', (chunk) => {
              armIdleTimer(); // remote output = alive — reset the idle clock
              buffer += stdoutDecoder.write(chunk);
              if (buffer.length > MAX_LINE_BUFFER) { buffer = ''; return; }
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || '';
              for (const line of lines) {
                if (!line.trim()) continue;
                try { this._handle(JSON.parse(line), h); continue; } catch {}
                const sm = line.match(/session[_\s]*id[:\s]*([a-f0-9-]+)/i);
                if (sm && !detectedSid) {
                  detectedSid = sm[1];
                  if (h.onSessionId) h.onSessionId(detectedSid);
                }
              }
            });

            stream.stderr.on('data', (chunk) => {
              armIdleTimer(); // stderr activity also counts as alive
              const str = stderrDecoder.write(chunk);
              if (stderrBuf.length < 8192) stderrBuf += str.slice(0, 8192 - stderrBuf.length);
              const sm = str.match(/Session:\s*([a-f0-9-]+)/i)
                || str.match(/session[_\s]*id[:\s]*([a-f0-9-]+)/i)
                || str.match(/Resuming session\s+([a-f0-9-]+)/i);
              if (sm && !detectedSid) {
                detectedSid = sm[1];
                if (h.onSessionId) h.onSessionId(detectedSid);
              }
            });

            stream.on('close', (code) => finish(code));
            stream.on('error', (err) => {
              if (!aborted) try { if (h.onError) h.onError(`SSH stream error: ${err.message}`); } catch {}
              finish(1);
            });
          });
        } catch (err) {
          try { if (h.onError) h.onError(`SSH attachment setup failed: ${err.message}`); } catch {}
          if (h.onDone) h.onDone(detectedSid);
          try { conn.end(); } catch {}
        }
      })();
    });

    conn.on('error', (err) => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (hardCapTimer) { clearTimeout(hardCapTimer); hardCapTimer = null; }
      const msg = this._hostVerifier?.state?.rejected
        ? hostKeyMismatchError(this._hostVerifier, this.hostname, this.port).message
        : err.code === 'ECONNREFUSED' ? `SSH connection refused — is sshd running on port ${this.port}?`
        : err.code === 'ENOTFOUND'            ? `Host not found: ${this.hostname}`
        : err.code === 'ETIMEDOUT'            ? `SSH connection timed out to ${this.hostname}`
        : err.level === 'client-authentication' ? `SSH auth failed — check password/key for ${this.username}@${this.hostname}`
        : `SSH error: ${err.message}`;
      try { if (h.onError) h.onError(msg); } catch {}
      if (h.onDone) h.onDone(detectedSid);
    });

    // Idle watchdog — armed now and reset on every chunk of remote output (the
    // stream.stdout/stderr handlers above call armIdleTimer). Fires only after
    // IDLE_TIMEOUT_MS of total silence, so a long-but-active run is never cut off.
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        const mins = Math.round(IDLE_TIMEOUT_MS / 60000);
        try { if (h.onError) h.onError(`SSH subprocess timed out — no output for ${mins} min (idle). Raise CLAUDE_IDLE_TIMEOUT_MS to allow longer silences.`); } catch {}
        try { conn.end(); } catch {}
      }, IDLE_TIMEOUT_MS);
    };
    armIdleTimer();

    // Optional absolute ceiling — backstop against a remote process that emits forever.
    if (HARD_CAP_MS > 0) {
      hardCapTimer = setTimeout(() => {
        hardCapTimer = null;
        const mins = Math.round(HARD_CAP_MS / 60000);
        try { if (h.onError) h.onError(`SSH subprocess timed out — exceeded hard cap of ${mins} min (CLAUDE_HARD_CAP_MS).`); } catch {}
        try { conn.end(); } catch {}
      }, HARD_CAP_MS);
    }

    conn.connect(this._connConfig());

    return {
      onText(fn)      { h.onText      = fn; return this; },
      onTool(fn)      { h.onTool      = fn; return this; },
      onDone(fn)      { h.onDone      = fn; return this; },
      onError(fn)     { h.onError     = fn; return this; },
      onSessionId(fn) { h.onSessionId = fn; return this; },
      onThinking(fn)  { h.onThinking  = fn; return this; },
      onRateLimit(fn) { h.onRateLimit = fn; return this; },
      onResult(fn)    { h.onResult    = fn; return this; },
      onUsage(fn)     { h.onUsage     = fn; return this; },
    };
  }

  _handle(data, h) {
    if (data.type === 'message_start') h._deltaBlocks = new Set();

    if (data.type === 'content_block_start' && data.content_block?.type === 'text' && h.onText) {
      if (h._hasEmittedText) h.onText('\n\n');
    }

    if (data.type === 'content_block_delta' && data.delta) {
      const idx = data.index ?? 0;
      if (data.delta.type === 'text_delta' && data.delta.text && h.onText) {
        h._deltaBlocks.add(idx); h._hasEmittedText = true; h.onText(data.delta.text);
      } else if (data.delta.type === 'thinking_delta' && data.delta.thinking && h.onThinking) {
        h._deltaBlocks.add(idx); h.onThinking(data.delta.thinking);
      }
    }

    if (data.type === 'assistant' || data.role === 'assistant') {
      // Per-turn usage: the last assistant message reflects real context-window
      // occupancy (mirrors claude-cli.js:527-530).
      const _usage = data.message?.usage || data.usage;
      if (_usage && h.onUsage && (_usage.input_tokens != null || _usage.cache_read_input_tokens != null)) {
        h.onUsage(_usage);
      }
      const content = data.content || data.message?.content || [];
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i], streamed = h._deltaBlocks.has(i);
        if (b.type === 'text'     && b.text     && h.onText     && !streamed) { h._hasEmittedText = true; h.onText(b.text); }
        else if (b.type === 'thinking' && b.thinking && h.onThinking && !streamed) h.onThinking(b.thinking);
        else if (b.type === 'tool_use' && h.onTool) h.onTool(b.name, typeof b.input === 'string' ? b.input : JSON.stringify(b.input));
      }
    }

    if (data.type === 'rate_limit_event' && data.rate_limit_info && h.onRateLimit) h.onRateLimit(data.rate_limit_info);
    if (data.type === 'result'  && h.onResult)  h.onResult(data);
    // Ensure session_id is a clean string before passing to handler
    if (data.session_id && h.onSessionId && typeof data.session_id === 'string') h.onSessionId(data.session_id);
  }
}

// ─── Standalone SSH connection tester ────────────────────────────────────────
// Returns Promise<{ latencyMs }> or rejects with Error
function testSshConnection({ host, port = 22, sshKeyPath = '', password = '' }) {
  return new Promise((resolve, reject) => {
    const { username, hostname } = parseHost(host);
    const start = Date.now();

    // The "Test" button is usually the FIRST connection to a host, so it is where
    // trust-on-first-use normally pins the fingerprint. Same verifier as every other path.
    const hostVerifier = makeHostVerifier(hostname, Number(port) || 22);
    const cfg = {
      host: hostname, port: Number(port) || 22, username,
      readyTimeout: 12000,
      tryKeyboard: !!password,
      hostVerifier,
    };
    if (password) {
      cfg.password = password;
    } else if (sshKeyPath) {
      const keyPath = expandTilde(sshKeyPath);
      if (!fs.existsSync(keyPath)) { return reject(new Error(`SSH key not found: ${keyPath}`)); }
      try { cfg.privateKey = fs.readFileSync(keyPath); } catch (e) { return reject(new Error(`Cannot read SSH key: ${e.message}`)); }
    } else if (process.env.SSH_AUTH_SOCK) {
      cfg.agent = process.env.SSH_AUTH_SOCK;
    }

    const conn = new Client();
    let done = false;
    const finish = (err) => {
      if (done) return; done = true;
      try { conn.end(); } catch {}
      if (err) reject(err); else resolve({ latencyMs: Date.now() - start });
    };

    conn.on('ready', () => {
      conn.exec('echo ok', (err, stream) => {
        if (err) return finish(new Error(`Exec failed: ${err.message}`));
        let out = '';
        stream.stdout.on('data', d => { out += d.toString(); });
        stream.on('close', (code) => {
          if (code === 0 && out.trim() === 'ok') finish(null);
          else finish(new Error(`SSH test failed (exit ${code})`));
        });
      });
    });

    conn.on('error', (err) => {
      if (hostVerifier.state.rejected) return finish(hostKeyMismatchError(hostVerifier, hostname, port));
      const msg = err.level === 'client-authentication'
        ? `Auth failed — wrong password or key for ${username}@${hostname}`
        : err.code === 'ECONNREFUSED' ? `Connection refused (port ${port})`
        : err.code === 'ENOTFOUND'    ? `Host not found: ${hostname}`
        : err.message;
      finish(new Error(msg));
    });

    conn.connect(cfg);
    setTimeout(() => finish(new Error('Connection timed out (12s)')), 14000);
  });
}


// ─── Remote command execution (non-interactive, one-shot) ────────────────────
// Runs ONE short command on a saved host and returns its output. Used by the
// remote CLI-session import (/api/sessions/cli-list-remote, cli-import-remote).
//
// Auth resolution is deliberately identical to ClaudeSSH._connConfig():
//   explicit password → explicit key file → ssh-agent
// so a host that works for a remote project also works for a remote import.
//
// Three hard rules for callers:
//   1. NEVER build `command` by concatenating user input — use shellEscape().
//   2. NEVER let a password reach a command string, a log line or an Error.
//      redactSecret() below is the last line of defence, not the first.
//   3. Output is capped (maxBytes) and the connection is torn down on timeout,
//      so a wedged or hostile remote cannot stream forever into this process.
const REMOTE_EXEC_TIMEOUT_MS = parseInt(process.env.CCS_REMOTE_EXEC_TIMEOUT_MS || '30000', 10) || 30000;
const REMOTE_EXEC_MAX_BYTES  = parseInt(process.env.CCS_REMOTE_EXEC_MAX_BYTES  || '67108864', 10) || 67108864;

// Replace every occurrence of a secret with '***'. Applied to anything that can reach
// an API response or a log line. Short strings are skipped: redacting a 2-char password
// would mangle unrelated text without protecting anything meaningful.
function redactSecret(text, ...secrets) {
  let out = text == null ? '' : String(text);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

// Map an ssh2 error onto a stable machine code + a message that names no credential.
function classifySshError(err, username, hostname, port) {
  let ccsCode = 'exec_failed';
  let message  = err && err.message ? err.message : 'SSH error';
  if (err && err.level === 'client-authentication') {
    ccsCode = 'auth_failed';
    message = `Authentication failed for ${username}@${hostname}`;
  } else if (err && (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH')) {
    ccsCode = 'unreachable';
    message = `Cannot reach ${hostname}:${port}`;
  } else if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')) {
    ccsCode = 'unreachable';
    message = `Host not found: ${hostname}`;
  } else if (err && err.code === 'ETIMEDOUT') {
    ccsCode = 'unreachable';
    message = `Connection timed out: ${hostname}:${port}`;
  }
  const e = new Error(message);
  e.ccsCode = ccsCode;
  return e;
}

// The real transport. Resolves { code, stdout, stderr, truncated }; a non-zero exit is
// NOT an error here — the caller decides, because the remote scripts use exit codes.
function runRemoteCommandOverSsh(opts = {}) {
  const {
    host, port = 22, sshKeyPath = '', password = '', command,
    timeoutMs = REMOTE_EXEC_TIMEOUT_MS, maxBytes = REMOTE_EXEC_MAX_BYTES,
  } = opts;
  const { username, hostname } = parseHost(host || '');
  const prt = Number(port) || 22;

  return new Promise((resolve, reject) => {
    if (!hostname) { const e = new Error('No hostname configured for this host'); e.ccsCode = 'bad_host'; return reject(e); }
    if (typeof command !== 'string' || !command) { const e = new Error('Empty remote command'); e.ccsCode = 'exec_failed'; return reject(e); }

    // Same trust-on-first-use pin as every other SSH path here — see makeHostVerifier().
    const hostVerifier = makeHostVerifier(hostname, prt);
    const cfg = {
      host: hostname, port: prt, username,
      readyTimeout: Math.min(timeoutMs, 20000),
      tryKeyboard: !!password,
      hostVerifier,
    };
    if (password) {
      cfg.password = password;
    } else if (sshKeyPath) {
      const keyPath = expandTilde(sshKeyPath);
      if (!fs.existsSync(keyPath)) { const e = new Error(`SSH key not found: ${keyPath}`); e.ccsCode = 'auth_failed'; return reject(e); }
      try { cfg.privateKey = fs.readFileSync(keyPath); }
      catch (err) { const e = new Error(`Cannot read SSH key: ${keyPath}`); e.ccsCode = 'auth_failed'; return reject(e); }
    } else if (process.env.SSH_AUTH_SOCK) {
      cfg.agent = process.env.SSH_AUTH_SOCK;
    }

    const conn = new Client();
    let out = Buffer.alloc(0), errOut = '', bytes = 0, truncated = false, done = false;
    const timer = setTimeout(() => {
      const e = new Error(`Remote command timed out after ${timeoutMs}ms`);
      e.ccsCode = 'timeout';
      finish(e);
    }, timeoutMs);

    function finish(err, value) {
      if (done) return; done = true;
      clearTimeout(timer);
      try { conn.end(); } catch {}
      if (err) reject(err); else resolve(value);
    }

    conn.on('ready', () => {
      conn.exec(command, { pty: false }, (err, stream) => {
        if (err) { const e = new Error('Remote exec failed'); e.ccsCode = 'exec_failed'; return finish(e); }
        stream.on('close', (code) => finish(null, {
          code: code == null ? 0 : code,
          stdout: out.toString('utf8'),
          stderr: errOut,
          truncated,
        }));
        stream.on('data', (chunk) => {
          if (truncated) return;
          bytes += chunk.length;
          if (bytes > maxBytes) {
            truncated = true;
            out = Buffer.concat([out, chunk]).subarray(0, maxBytes);
            try { stream.close(); } catch {}
            return;
          }
          out = Buffer.concat([out, chunk]);
        });
        stream.stderr.on('data', (chunk) => { if (errOut.length < 8192) errOut += chunk.toString('utf8'); });
      });
    });
    conn.on('keyboard-interactive', (n, i, il, prompts, cb) => cb(prompts.map(() => password || '')));
    conn.on('error', (err) => finish(
      hostVerifier.state.rejected
        ? hostKeyMismatchError(hostVerifier, hostname, prt)
        : classifySshError(err, username, hostname, prt)));

    try { conn.connect(cfg); }
    catch (err) { finish(classifySshError(err, username, hostname, prt)); }
  });
}

// Transport indirection. CCS_REMOTE_EXEC_HOOK points at a module exporting
// runRemoteCommand(opts) and REPLACES the ssh2 transport wholesale — that is how
// test/cli-import-remote.test.js drives the endpoints against a filesystem it owns
// without an sshd. Setting it already requires control of this process's environment,
// which is code execution anyway, so it widens no attack surface.
let _remoteExecImpl = null;
function remoteExecImpl() {
  if (_remoteExecImpl) return _remoteExecImpl;
  const hook = process.env.CCS_REMOTE_EXEC_HOOK;
  if (hook) {
    const mod = require(path.resolve(hook));
    if (typeof mod.runRemoteCommand !== 'function') {
      throw new Error('CCS_REMOTE_EXEC_HOOK module does not export runRemoteCommand()');
    }
    _remoteExecImpl = mod.runRemoteCommand;
  } else {
    _remoteExecImpl = runRemoteCommandOverSsh;
  }
  return _remoteExecImpl;
}

// Public entry point. Normalises the result shape and — critically — scrubs the
// password out of any Error the transport produced before it can reach a caller
// that might put it in an HTTP response or a log line.
async function runRemoteCommand(opts = {}) {
  try {
    const r = await remoteExecImpl()(opts);
    return {
      code:      Number(r && r.code) || 0,
      stdout:    String((r && r.stdout) || ''),
      stderr:    redactSecret((r && r.stderr) || '', opts.password),
      truncated: !!(r && r.truncated),
    };
  } catch (e) {
    const err = new Error(redactSecret((e && e.message) || 'Remote command failed', opts.password));
    err.ccsCode = (e && e.ccsCode) || 'exec_failed';
    throw err;
  }
}

module.exports = ClaudeSSH;
module.exports.testSshConnection = testSshConnection;
module.exports.runRemoteCommand = runRemoteCommand;
module.exports.shellEscape = shellEscape;
module.exports.makeHostVerifier = makeHostVerifier;
module.exports.hostKeyFingerprint = hostKeyFingerprint;
module.exports.KNOWN_HOSTS_FILE = KNOWN_HOSTS_FILE;
module.exports.redactSecret = redactSecret;
module.exports.parseHost = parseHost;
