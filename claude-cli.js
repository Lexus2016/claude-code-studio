const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { StringDecoder } = require('string_decoder');

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
const MAX_SUBPROCESS_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '1800000', 10);

// Maximum size of a single unflushed stdout line — guards against heap exhaustion
// when the CLI emits a line without \n (should never happen in stream-json mode,
// but defensive cap prevents OOM if something goes wrong).
const MAX_LINE_BUFFER = 10 * 1024 * 1024; // 10 MB

// CLI uses short aliases — claude binary resolves them internally
const MODEL_MAP = {
  'opus':   'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku':  'claude-haiku-4-5',
};

class ClaudeCLI {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.claudeBin = options.claudeBin || CLAUDE_BIN;
  }

  send({ prompt, sessionId, model, maxTurns, mcpServers, systemPrompt, allowedTools, abortController }) {
    const args = ['--print'];

    // Session resumption: --resume <sessionId> (not --session-id + --resume separately)
    if (sessionId) args.push('--resume', sessionId);

    if (model) args.push('--model', MODEL_MAP[model] || model);
    if (maxTurns) args.push('--max-turns', String(maxTurns));
    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    // allowedTools: pass each tool as separate arg (variadic)
    if (allowedTools?.length) args.push('--allowedTools', ...allowedTools);

    // MCP config file
    let mcpConfigPath = null;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      mcpConfigPath = path.join(os.tmpdir(), `mcp-${Date.now()}.json`);
      fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }));
      args.push('--mcp-config', mcpConfigPath);
    }

    // CRITICAL: bypass permission prompts in non-interactive mode
    args.push('--dangerously-skip-permissions');

    // Stream JSON for structured output parsing
    args.push('--output-format', 'stream-json');

    // Include partial message chunks for real-time streaming
    args.push('--include-partial-messages');

    args.push('-p', prompt);

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

    const h = { onText: null, onTool: null, onDone: null, onError: null, onSessionId: null, onThinking: null, onRateLimit: null, _deltaBlocks: new Set() };
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let buffer = '', stderrBuf = '', detectedSid = sessionId || null;
    // SIGKILL fallback timer — cleared on normal close to avoid zombie timers
    let sigkillTimer = null;
    // Global timeout — kills subprocess if it doesn't finish within MAX_SUBPROCESS_MS
    let globalTimer = null;
    // Track MCP config path locally so error handler can also clean it up
    let mcpPath = mcpConfigPath;

    proc.stdout.on('data', (chunk) => {
      buffer += stdoutDecoder.write(chunk);
      // Guard against a runaway line (no \n) consuming all heap
      if (buffer.length > MAX_LINE_BUFFER) { buffer = ''; return; }
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
        if (h.onSessionId) h.onSessionId(detectedSid);
      }
    });

    proc.on('close', (code) => {
      // Clear both timers — process already exited
      if (globalTimer) { clearTimeout(globalTimer); globalTimer = null; }
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      // Flush remaining buffer (including any incomplete multi-byte sequence held by the decoder)
      buffer += stdoutDecoder.end();
      if (buffer.trim()) {
        try { this._handle(JSON.parse(buffer), h); } catch { try { if (h.onText) h.onText(buffer); } catch {} }
      }
      if (mcpPath) { try { fs.unlinkSync(mcpPath); } catch {} mcpPath = null; }
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
      if (h.onDone) h.onDone(detectedSid);
    });

    proc.on('error', (err) => {
      if (globalTimer) { clearTimeout(globalTimer); globalTimer = null; }
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      // Clean up MCP config even when the process fails to start
      if (mcpPath) { try { fs.unlinkSync(mcpPath); } catch {} mcpPath = null; }
      // Wrapped in try-catch for the same reason as in 'close': onDone must always fire.
      try { if (h.onError) h.onError(`Failed to start claude: ${err.message}. Binary: ${this.claudeBin}`); } catch {}
      if (h.onDone) h.onDone(detectedSid);
    });

    // Global timeout — must be set after all declarations to avoid TDZ with let
    globalTimer = setTimeout(() => {
      globalTimer = null;
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try { if (h.onError) h.onError('Claude subprocess timed out'); } catch {}
      proc.kill('SIGTERM');
      sigkillTimer = setTimeout(() => {
        sigkillTimer = null;
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        try { proc.kill('SIGKILL'); } catch {}
      }, 3000);
    }, MAX_SUBPROCESS_MS);

    if (abortController) {
      // { once: true } ensures the listener is auto-removed after firing
      abortController.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        // Escalate to SIGKILL after 3 s if process ignores SIGTERM.
        // Guard: if proc already exited (exitCode/signalCode set), skip to avoid
        // hitting a new process that the OS reused the same PID for.
        sigkillTimer = setTimeout(() => {
          sigkillTimer = null;
          if (proc.exitCode !== null || proc.signalCode !== null) return;
          try { proc.kill('SIGKILL'); } catch {}
        }, 3000);
      }, { once: true });
    }

    return {
      onText(fn) { h.onText = fn; return this; },
      onTool(fn) { h.onTool = fn; return this; },
      onDone(fn) { h.onDone = fn; return this; },
      onError(fn) { h.onError = fn; return this; },
      onSessionId(fn) { h.onSessionId = fn; return this; },
      onThinking(fn) { h.onThinking = fn; return this; },
      onRateLimit(fn) { h.onRateLimit = fn; return this; },
      process: proc,
    };
  }

  _handle(data, h) {
    // Reset per-block delta tracking at the start of each assistant turn
    if (data.type === 'message_start') {
      h._deltaBlocks = new Set();
    }

    // New text content block starting after other blocks (e.g. after tool_use) — inject paragraph separator
    // so the post-tool text doesn't run together with the pre-tool text.
    if (data.type === 'content_block_start' && data.content_block?.type === 'text' && (data.index ?? 0) > 0 && h.onText) {
      h.onText('\n\n');
    }

    // Handle streaming delta events (Anthropic API streaming format used by newer CLI versions)
    if (data.type === 'content_block_delta' && data.delta) {
      const idx = data.index ?? 0;
      if (data.delta.type === 'text_delta' && data.delta.text && h.onText) {
        h._deltaBlocks.add(idx);
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
        if (b.type === 'text' && b.text && h.onText && !streamed) h.onText(b.text);
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
    // Session ID in result messages
    if (data.session_id && h.onSessionId) h.onSessionId(data.session_id);
  }
}

module.exports = ClaudeCLI;
