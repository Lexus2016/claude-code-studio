'use strict';
const { Client } = require('ssh2');
const { StringDecoder } = require('string_decoder');
const os  = require('os');
const path = require('path');
const fs  = require('fs');

const MAX_LINE_BUFFER    = 10 * 1024 * 1024; // 10 MB
const MAX_SUBPROCESS_MS  = parseInt(process.env.CLAUDE_TIMEOUT_MS || '1800000', 10);

const MODEL_MAP = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' };

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
    // StrictHostKeyChecking equivalent: accept new hosts automatically
    cfg.hostVerifier = () => true;
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

  send({ prompt, contentBlocks, sessionId, model, maxTurns, systemPrompt, allowedTools, abortController }) {
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
      _deltaBlocks: new Set(), _hasEmittedText: false,
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let buffer = '', stderrBuf = '', detectedSid = sessionId || null;
    let globalTimer = null;
    let aborted = false;

    const conn = new Client();

    // Called exactly once when the connection/stream is done
    const finish = (code) => {
      if (globalTimer) { clearTimeout(globalTimer); globalTimer = null; }

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
          if (sessionId && typeof sessionId === 'string' && /^[a-f0-9-]+$/i.test(sessionId)) args.push('--resume', sessionId);
          if (model) args.push('--model', MODEL_MAP[model] || model);
          if (maxTurns) args.push('--max-turns', String(maxTurns));
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
      if (globalTimer) { clearTimeout(globalTimer); globalTimer = null; }
      const msg = err.code === 'ECONNREFUSED' ? `SSH connection refused — is sshd running on port ${this.port}?`
        : err.code === 'ENOTFOUND'            ? `Host not found: ${this.hostname}`
        : err.code === 'ETIMEDOUT'            ? `SSH connection timed out to ${this.hostname}`
        : err.level === 'client-authentication' ? `SSH auth failed — check password/key for ${this.username}@${this.hostname}`
        : `SSH error: ${err.message}`;
      try { if (h.onError) h.onError(msg); } catch {}
      if (h.onDone) h.onDone(detectedSid);
    });

    // Global timeout guard
    globalTimer = setTimeout(() => {
      globalTimer = null;
      try { if (h.onError) h.onError('SSH subprocess timed out'); } catch {}
      try { conn.end(); } catch {}
    }, MAX_SUBPROCESS_MS);

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
      const content = data.content || data.message?.content || [];
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i], streamed = h._deltaBlocks.has(i);
        if (b.type === 'text'     && b.text     && h.onText     && !streamed) { h._hasEmittedText = true; h.onText(b.text); }
        else if (b.type === 'thinking' && b.thinking && h.onThinking && !streamed) h.onThinking(b.thinking);
        else if (b.type === 'tool_use' && h.onTool) h.onTool(b.name, typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2));
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

    const cfg = {
      host: hostname, port: Number(port) || 22, username,
      readyTimeout: 12000,
      tryKeyboard: !!password,
      hostVerifier: () => true,
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

module.exports = ClaudeSSH;
module.exports.testSshConnection = testSshConnection;
