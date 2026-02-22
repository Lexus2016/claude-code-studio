const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

  send({ prompt, imagePaths, sessionId, model, maxTurns, mcpServers, systemPrompt, allowedTools, abortController }) {
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

    const h = { onText: null, onTool: null, onDone: null, onError: null, onSessionId: null, onThinking: null };
    let buffer = '', stderrBuf = '', detectedSid = sessionId || null;
    // SIGKILL fallback timer — cleared on normal close to avoid zombie timers
    let sigkillTimer = null;
    // Track MCP config path locally so error handler can also clean it up
    let mcpPath = mcpConfigPath;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
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
      const str = chunk.toString();
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
      // Clear SIGKILL timer — process already exited, no need to escalate
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
      // Flush remaining buffer
      if (buffer.trim()) {
        try { this._handle(JSON.parse(buffer), h); } catch { if (h.onText) h.onText(buffer); }
      }
      if (mcpPath) { try { fs.unlinkSync(mcpPath); } catch {} mcpPath = null; }
      if (code !== 0 && stderrBuf.trim() && h.onError) {
        // Filter out known non-error messages
        const errMsg = stderrBuf.trim();
        if (!errMsg.includes('Loaded MCP') && !errMsg.includes('Starting MCP')) {
          h.onError(errMsg.substring(0, 1000));
        }
      }
      if (h.onDone) h.onDone(detectedSid);
    });

    proc.on('error', (err) => {
      // Clean up MCP config even when the process fails to start
      if (mcpPath) { try { fs.unlinkSync(mcpPath); } catch {} mcpPath = null; }
      if (h.onError) h.onError(`Failed to start claude: ${err.message}. Binary: ${this.claudeBin}`);
      if (h.onDone) h.onDone(detectedSid);
    });

    if (abortController) {
      // { once: true } ensures the listener is auto-removed after firing
      abortController.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        // Escalate to SIGKILL after 3 s if process ignores SIGTERM
        sigkillTimer = setTimeout(() => {
          sigkillTimer = null;
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
      process: proc,
    };
  }

  _handle(data, h) {
    // Handle assistant messages with content blocks
    if (data.type === 'assistant' || data.role === 'assistant') {
      const content = data.content || data.message?.content || [];
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
      for (const b of blocks) {
        if (b.type === 'text' && b.text && h.onText) h.onText(b.text);
        else if (b.type === 'thinking' && b.thinking && h.onThinking) h.onThinking(b.thinking);
        else if (b.type === 'tool_use' && h.onTool) {
          h.onTool(b.name, typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2));
        }
      }
    }
    // Session ID in result messages
    if (data.session_id && h.onSessionId) h.onSessionId(data.session_id);
  }
}

module.exports = ClaudeCLI;
