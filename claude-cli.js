const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

// Kill a child process and its tree. On Windows `proc.kill()` only kills the
// direct child (cmd.exe), leaving grandchildren (node.exe) orphaned.
// `taskkill /T /F` kills the entire process tree.
function killProc(proc) {
  if (process.platform === 'win32' && proc.pid && Number.isInteger(proc.pid)) {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  } else {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

// Resolve claude binary — cross-platform (macOS, Linux, Windows)
function findClaudeBin() {
  const isWin = process.platform === 'win32';

  // Unix-only candidate paths (macOS / Linux)
  if (!isWin) {
    const unixCandidates = [
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/usr/bin/claude',
    ];
    for (const c of unixCandidates) {
      if (fs.existsSync(c)) return c;
    }
  }

  // Windows: look for claude.cmd or claude.exe in common locations
  if (isWin) {
    const appData  = process.env.APPDATA  || '';
    const localApp = process.env.LOCALAPPDATA || '';
    const winCandidates = [
      path.join(appData,  'npm', 'claude.cmd'),
      path.join(localApp, 'npm', 'claude.cmd'),
      path.join(appData,  'npm', 'claude.exe'),
      path.join(localApp, 'Programs', 'claude', 'claude.exe'),
    ];
    for (const c of winCandidates) {
      if (fs.existsSync(c)) return c;
    }
    return 'claude.cmd'; // fallback: PATH lookup for npm global install on Windows
  }

  return 'claude'; // fallback to PATH (Unix)
}

const CLAUDE_BIN = findClaudeBin();

// Global subprocess timeout — process is killed if it does not exit within this window.
// Configurable via CLAUDE_TIMEOUT_MS env var; default 10 minutes.
const MAX_SUBPROCESS_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '1800000', 10) || 1800000;

// Maximum size of a single unflushed stdout line — guards against heap exhaustion
// when the CLI emits a line without \n (should never happen in stream-json mode,
// but defensive cap prevents OOM if something goes wrong).
const MAX_LINE_BUFFER = 10 * 1024 * 1024; // 10 MB

// CLI uses short aliases — claude binary resolves them internally
const MODEL_MAP = {
  // 'opus':   'claude-opus-4-6',
  // 'sonnet': 'claude-sonnet-4-6',
  // 'haiku':  'claude-haiku-4-5',
  'opus':   'opus',
  'sonnet': 'sonnet',
  'haiku':  'haiku',
};

// ─── MCP config file cache ──────────────────────────────────────────────────
// Reuses temp files by content hash instead of creating/deleting per request.
// Key: SHA-256 hash of JSON content → { path, refCount }
// Files are cleaned up when no references remain (process exit or explicit clear).
const _mcpConfigCache = new Map();

function getMcpConfigPath(mcpServers) {
  const json = JSON.stringify({ mcpServers });
  const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
  const cached = _mcpConfigCache.get(hash);
  if (cached) {
    cached.refCount++;
    return { path: cached.path, hash, isNew: false };
  }
  const filePath = path.join(os.tmpdir(), `mcp-${hash}.json`);
  fs.writeFileSync(filePath, json);
  _mcpConfigCache.set(hash, { path: filePath, refCount: 1 });
  return { path: filePath, hash, isNew: true };
}

function releaseMcpConfig(hash) {
  if (!hash) return;
  const cached = _mcpConfigCache.get(hash);
  if (!cached) return;
  cached.refCount--;
  if (cached.refCount <= 0) {
    try { fs.unlinkSync(cached.path); } catch {}
    _mcpConfigCache.delete(hash);
  }
}

// Cleanup all cached MCP files on process exit
process.on('exit', () => {
  for (const [, entry] of _mcpConfigCache) {
    try { fs.unlinkSync(entry.path); } catch {}
  }
});

class ClaudeCLI {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.claudeBin = options.claudeBin || CLAUDE_BIN;
  }

  send({ prompt, contentBlocks, sessionId, model, maxTurns, mcpServers, systemPrompt, allowedTools, abortController }) {
    const args = ['--print'];

    // Session resumption: --resume <sessionId> (not --session-id + --resume separately)
    // Guard: only pass string UUIDs — reject objects or corrupted JSON values
    if (sessionId && typeof sessionId === 'string' && /^[a-f0-9-]+$/i.test(sessionId)) {
      args.push('--resume', sessionId);
    } else if (sessionId) {
      console.warn('[claude-cli] rejected non-UUID sessionId for --resume:', typeof sessionId, String(sessionId).substring(0, 60));
    }

    if (model) args.push('--model', MODEL_MAP[model] || model);
    if (maxTurns) args.push('--max-turns', String(maxTurns));
    // Don't pass --system-prompt when resuming a session — the system prompt is
    // already baked into the session history. Changing it invalidates cryptographic
    // signatures on thinking blocks, causing API 400 "Invalid signature in thinking block".
    if (systemPrompt && !sessionId) args.push('--system-prompt', systemPrompt);

    // allowedTools: pass each tool as separate arg (variadic)
    if (allowedTools?.length) args.push('--allowedTools', ...allowedTools);

    // MCP config file (cached by content hash — avoids write/delete per request)
    // Pass mcpServers={} to explicitly disable MCP (overrides global config).
    // Pass mcpServers={...} to use specific servers.
    // Omit mcpServers to use global defaults.
    let mcpConfigHash = null;
    let mcpConfigPath = null;
    if (mcpServers && typeof mcpServers === 'object') {
      const mcp = getMcpConfigPath(mcpServers);
      mcpConfigPath = mcp.path;
      mcpConfigHash = mcp.hash;
      args.push('--mcp-config', mcpConfigPath);
    }

    // CRITICAL: bypass permission prompts in non-interactive mode
    args.push('--dangerously-skip-permissions');

    // Stream JSON for structured output parsing
    // --verbose is required alongside --output-format stream-json since CLI ≥ 1.0.x
    args.push('--output-format', 'stream-json', '--verbose');

    // Include partial message chunks for real-time streaming
    args.push('--include-partial-messages');

    // Handle image/file attachments: save to temp dir, append file paths to prompt
    // so Claude CLI can read them via its Read tool (CLI has no native content block API).
    // Text blocks (SSH info, file content) are prepended directly to the prompt string.
    const _tempFiles = [];
    let _tempDir = null;
    let finalPrompt = prompt;
    if (contentBlocks && contentBlocks.length) {
      const filePaths = [];
      const textParts = [];
      for (const block of contentBlocks) {
        if (block.type === 'image' && block.source?.data) {
          if (!_tempDir) {
            _tempDir = path.join(os.tmpdir(), `claude-att-${Date.now()}`);
            fs.mkdirSync(_tempDir, { recursive: true });
          }
          const ext = (block.source.media_type || 'image/png').split('/')[1] || 'png';
          const fname = `attachment-${_tempFiles.length + 1}.${ext}`;
          const fpath = path.join(_tempDir, fname);
          fs.writeFileSync(fpath, Buffer.from(block.source.data, 'base64'));
          _tempFiles.push(fpath);
          filePaths.push(fpath);
        } else if (block.type === 'text' && block.text && block.text !== prompt) {
          // Collect SSH context, file contents, and other text blocks that are NOT
          // the user message itself (buildUserContent appends the message as last block)
          textParts.push(block.text);
        }
      }
      const prefixParts = [];
      if (textParts.length) prefixParts.push(textParts.join('\n\n'));
      if (filePaths.length) prefixParts.push(`[Attached images — read these files to see the screenshots/images the user shared:\n${filePaths.map(f => `- ${f}`).join('\n')}\n]`);
      if (prefixParts.length) finalPrompt = prefixParts.join('\n\n') + '\n\n' + prompt;
    }
    args.push('-p', finalPrompt);

    // Unset CLAUDECODE to allow nested invocation from dev environment.
    // Unset ANTHROPIC_API_KEY so the CLI subprocess uses Max subscription
    // instead of prompting for API key configuration (which hangs on closed stdin).
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;

    // On Windows .cmd/.bat files require cmd.exe (shell:true) to execute.
    // On Unix, binaries execute directly (shell:false is safer).
    const needsShell = process.platform === 'win32' &&
      /\.(cmd|bat)$/i.test(this.claudeBin);
    const proc = spawn(this.claudeBin, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
    });

    // Close stdin immediately (non-interactive)
    proc.stdin.end();

    const h = { onText: null, onTool: null, onDone: null, onError: null, onSessionId: null, onThinking: null, onRateLimit: null, onResult: null, _deltaBlocks: new Set(), _detectedSid: sessionId || null };
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let buffer = '', stderrBuf = '', detectedSid = sessionId || null;
    // SIGKILL fallback timer — cleared on normal close to avoid zombie timers
    let sigkillTimer = null;
    // Global timeout — kills subprocess if it doesn't finish within MAX_SUBPROCESS_MS
    let globalTimer = null;
    // Track MCP config hash for ref-counted cleanup
    let mcpHash = mcpConfigHash;
    let _finished = false;
    let _abortListener = null;
    // Track temp attachment files + parent dir for cleanup
    let attFiles = _tempFiles.slice();
    let attDir = _tempDir;

    proc.stdout.on('data', (chunk) => {
      buffer += stdoutDecoder.write(chunk);
      // Guard against a runaway line (no \n) consuming all heap
      if (buffer.length > MAX_LINE_BUFFER) {
        // Process any complete lines before discarding the oversized partial line
        const lastNl = buffer.lastIndexOf('\n');
        if (lastNl > 0) {
          const completeLines = buffer.slice(0, lastNl).split(/\r?\n/);
          for (const cl of completeLines) { if (cl.trim()) { try { this._handle(JSON.parse(cl), h); } catch {} } }
        }
        console.warn(`[claude-cli] Buffer overflow (${(buffer.length / 1024 / 1024).toFixed(1)} MB), dropping incomplete line`);
        buffer = '';
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          this._handle(d, h);
          continue;
        } catch {}
        // Fallback: session ID detection in plain text
        const sm = line.match(/session[_\s]*id[:\s]*([a-f0-9-]+)/i);
        if (sm && !detectedSid) {
          detectedSid = sm[1];
          h._detectedSid = detectedSid;
          if (h.onSessionId) h.onSessionId(detectedSid);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const str = stderrDecoder.write(chunk);
      // Cap stderr buffer at 8 KB to prevent unbounded memory growth
      if (stderrBuf.length < 8192) stderrBuf += str.slice(0, 8192 - stderrBuf.length);
      // Extract session ID from stderr
      const sm = str.match(/Session:\s*([a-f0-9-]+)/i)
        || str.match(/session[_\s]*id[:\s]*([a-f0-9-]+)/i)
        || str.match(/Resuming session\s+([a-f0-9-]+)/i);
      if (sm && !detectedSid) {
        detectedSid = sm[1];
        h._detectedSid = detectedSid;
        if (h.onSessionId) h.onSessionId(detectedSid);
      }
    });

    proc.on('close', (code) => {
      if (_finished) return; _finished = true;
      // Remove abort listener to prevent GC leak (listener holds proc reference)
      if (abortController && _abortListener) {
        abortController.signal.removeEventListener('abort', _abortListener);
        _abortListener = null;
      }
      // Clear both timers — process already exited
      if (globalTimer) { clearTimeout(globalTimer); globalTimer = null; }
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      // Flush remaining buffer (including any incomplete multi-byte sequence held by the decoder)
      buffer += stdoutDecoder.end();
      if (buffer.trim()) {
        try { this._handle(JSON.parse(buffer), h); } catch { try { if (h.onText) h.onText(buffer); } catch {} }
      }
      releaseMcpConfig(mcpHash); mcpHash = null;
      for (const f of attFiles) { try { fs.unlinkSync(f); } catch {} }
      if (attDir) { try { fs.rmSync(attDir, { recursive: true, force: true }); } catch {} attDir = null; }
      attFiles = [];
      if (code !== 0 && stderrBuf.trim() && h.onError) {
        // Filter out known non-error noise (MCP loading messages) line-by-line,
        // then report any remaining real error lines to the caller.
        const realErrors = stderrBuf.trim().split('\n')
          .filter(l => l.trim() && !l.includes('Loaded MCP') && !l.includes('Starting MCP'))
          .join('\n').trim();
        if (realErrors) {
          // Wrapped in try-catch: if the callback throws (e.g. ws.send on closed socket),
          // onDone must still fire so the caller's Promise always settles.
          try { h.onError(realErrors.substring(0, 1000)); } catch {}
        }
      }
      if (h.onDone) h.onDone(detectedSid || h._detectedSid);
    });

    proc.on('error', (err) => {
      if (_finished) return; _finished = true;
      // Remove abort listener to prevent GC leak
      if (abortController && _abortListener) {
        abortController.signal.removeEventListener('abort', _abortListener);
        _abortListener = null;
      }
      if (globalTimer) { clearTimeout(globalTimer); globalTimer = null; }
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      // Clean up MCP config and temp attachments even when the process fails to start
      releaseMcpConfig(mcpHash); mcpHash = null;
      for (const f of attFiles) { try { fs.unlinkSync(f); } catch {} }
      if (attDir) { try { fs.rmSync(attDir, { recursive: true, force: true }); } catch {} attDir = null; }
      attFiles = [];
      // Wrapped in try-catch for the same reason as in 'close': onDone must always fire.
      try { if (h.onError) h.onError(`Failed to start claude: ${err.message}. Binary: ${this.claudeBin}`); } catch {}
      if (h.onDone) h.onDone(detectedSid || h._detectedSid);
    });

    // Global timeout — must be set after all declarations to avoid TDZ with let
    globalTimer = setTimeout(() => {
      globalTimer = null;
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try { if (h.onError) h.onError('Claude subprocess timed out'); } catch {}
      killProc(proc);
      // Escalate to SIGKILL after 3 s (Unix only — on Windows killProc already force-kills)
      if (process.platform !== 'win32') {
        if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
        sigkillTimer = setTimeout(() => {
          sigkillTimer = null;
          if (proc.exitCode !== null || proc.signalCode !== null) return;
          try { proc.kill('SIGKILL'); } catch {}
        }, 3000);
      }
    }, MAX_SUBPROCESS_MS);

    if (abortController) {
      _abortListener = () => {
        killProc(proc);
        // Escalate to SIGKILL after 3 s (Unix only — on Windows killProc already force-kills).
        // Guard: if proc already exited (exitCode/signalCode set), skip to avoid
        // hitting a new process that the OS reused the same PID for.
        if (process.platform !== 'win32') {
          if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
          sigkillTimer = setTimeout(() => {
            sigkillTimer = null;
            if (proc.exitCode !== null || proc.signalCode !== null) return;
            try { proc.kill('SIGKILL'); } catch {}
          }, 3000);
        }
      };
      abortController.signal.addEventListener('abort', _abortListener);
    }

    return {
      onText(fn) { h.onText = fn; return this; },
      onTool(fn) { h.onTool = fn; return this; },
      onDone(fn) { h.onDone = fn; return this; },
      onError(fn) { h.onError = fn; return this; },
      onSessionId(fn) { h.onSessionId = fn; return this; },
      onThinking(fn) { h.onThinking = fn; return this; },
      onRateLimit(fn) { h.onRateLimit = fn; return this; },
      onResult(fn) { h.onResult = fn; return this; },
      process: proc,
    };
  }

  _handle(data, h) {
    // Reset per-block delta tracking at the start of each assistant turn
    if (data.type === 'message_start') {
      h._deltaBlocks = new Set();
      h._hasEmittedText = false;
    }

    // Inject paragraph separator between text blocks so post-tool text doesn't
    // run together with pre-tool text. Covers both:
    // - Same-turn: text(index:0) → tool(index:1) → text(index:2) — index > 0
    // - Cross-turn: turn1 text → tool → turn2 text(index:0) — index resets to 0
    // Using _hasEmittedText flag to detect cross-turn boundaries.
    if (data.type === 'content_block_start' && data.content_block?.type === 'text' && h.onText) {
      if (h._hasEmittedText) {
        h.onText('\n\n');
      }
    }

    // Handle streaming delta events (Anthropic API streaming format used by newer CLI versions)
    if (data.type === 'content_block_delta' && data.delta) {
      const idx = data.index ?? 0;
      if (data.delta.type === 'text_delta' && data.delta.text && h.onText) {
        h._deltaBlocks.add(idx);
        h._hasEmittedText = true;
        h.onText(data.delta.text);
      } else if (data.delta.type === 'thinking_delta' && data.delta.thinking && h.onThinking) {
        h._deltaBlocks.add(idx);
        h.onThinking(data.delta.thinking);
      }
    }
    // Handle assistant messages with content blocks (legacy format / tool_use)
    // Skip text/thinking for blocks already streamed via content_block_delta (per-block check)
    if (data.type === 'assistant' || data.role === 'assistant') {
      const content = data.content || data.message?.content || [];
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const streamed = h._deltaBlocks.has(i);
        if (b.type === 'text' && b.text && h.onText && !streamed) { h._hasEmittedText = true; h.onText(b.text); }
        else if (b.type === 'thinking' && b.thinking && h.onThinking && !streamed) h.onThinking(b.thinking);
        else if (b.type === 'tool_use' && h.onTool) {
          h.onTool(b.name, typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2));
        }
      }
    }
    // Rate limit event
    if (data.type === 'rate_limit_event' && data.rate_limit_info && h.onRateLimit) {
      h.onRateLimit(data.rate_limit_info);
    }
    // Result message — emitted at end of stream with session_id, subtype, num_turns etc.
    // subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | ...
    if (data.type === 'result' && h.onResult) {
      h.onResult(data);
    }
    // Session ID in result messages — ensure it's a clean string (not object/nested JSON)
    if (data.session_id && !h._detectedSid && h.onSessionId) {
      const sid = typeof data.session_id === 'string' ? data.session_id
        : (typeof data.session_id === 'object' && data.session_id.session_id) ? data.session_id.session_id
        : null;
      if (sid && typeof sid === 'string') { h._detectedSid = sid; h.onSessionId(sid); }
    }
  }
}

module.exports = ClaudeCLI;
