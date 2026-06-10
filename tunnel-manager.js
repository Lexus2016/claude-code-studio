// ─── Tunnel Manager for Claude Code Studio ──────────────────────────────────
// Manages cloudflared / ngrok tunnel subprocess to expose the server to the internet.
// No external npm dependencies — uses Node 20 built-in child_process.
'use strict';

const EventEmitter = require('events');
const { spawn } = require('child_process');
const { execSync } = require('child_process');

const STARTUP_TIMEOUT = 30_000;     // 30s to detect URL
const SHUTDOWN_TIMEOUT = 5_000;     // 5s graceful, then SIGKILL
const HEALTH_CHECK_INTERVAL = 30_000; // 30s periodic health check

class TunnelManager extends EventEmitter {
  constructor({ log, port }) {
    super();
    this.log = log || console;
    this.port = port;
    this._proc = null;
    this._state = {
      running: false,
      provider: null,
      publicUrl: null,
      startedAt: null,
      pid: null,
      error: null,
    };
    this._healthTimer = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start a tunnel with the given provider.
   * @param {'cloudflared'|'ngrok'} provider
   * @param {{ ngrokAuthtoken?: string }} config
   * @returns {Promise<{ publicUrl: string }>}
   */
  async start(provider = 'cloudflared', config = {}) {
    if (this._proc) {
      throw new Error('Tunnel already running. Stop it first.');
    }

    // Validate binary exists
    this._assertBinaryExists(provider);

    this.log.info(`[tunnel] Starting ${provider} tunnel on port ${this.port}`);

    return new Promise((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(new Error(`Tunnel startup timed out after ${STARTUP_TIMEOUT / 1000}s`));
      }, STARTUP_TIMEOUT);

      try {
        this._proc = this._spawnTunnel(provider, config);
        this._state.provider = provider;
        this._state.pid = this._proc.pid;
      } catch (err) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
        return;
      }

      // Capture process reference — all handlers guard against stale callbacks
      // from a previous process after rapid stop/start cycles.
      const proc = this._proc;

      // Listen for URL on stdout/stderr. Each stream keeps an accumulating buffer
      // (capped) so a URL split across two 'data' chunks is still matched —
      // otherwise neither half matches and start() rejects on the 30s timeout
      // even though the tunnel is up.
      const onData = (stream) => {
        let buf = '';
        return (chunk) => {
          if (this._proc !== proc) return; // stale handler from previous process
          const text = chunk.toString();
          this.log.debug(`[tunnel:${stream}] ${text.trim()}`);
          buf = (buf + text).slice(-65536); // bound growth; URLs are far shorter

          const url = this._parseUrl(provider, buf);
          if (url && !settled) {
            settled = true;
            clearTimeout(timeout);
            this._state.running = true;
            this._state.publicUrl = url;
            this._state.startedAt = new Date().toISOString();
            this._state.error = null;
            this.log.info(`[tunnel] Public URL: ${url}`);
            this.emit('url', url);
            this._startHealthCheck();
            resolve({ publicUrl: url });
          }
        };
      };

      proc.stdout?.on('data', onData('stdout'));
      proc.stderr?.on('data', onData('stderr'));

      proc.on('error', (err) => {
        if (this._proc !== proc) return; // stale handler
        clearTimeout(timeout);
        this.log.error(`[tunnel] Process error: ${err.message}`);
        this._cleanup(err.message);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      proc.on('exit', (code, signal) => {
        if (this._proc !== proc) return; // stale handler
        clearTimeout(timeout);
        const reason = `Process exited (code=${code}, signal=${signal})`;
        this.log.info(`[tunnel] ${reason}`);
        const wasRunning = this._state.running;
        this._cleanup(reason);
        if (!settled) {
          settled = true;
          reject(new Error(reason));
        } else if (wasRunning) {
          this.emit('close', reason);
        }
      });
    });
  }

  /**
   * Stop the running tunnel.
   */
  stop() {
    if (!this._proc) return;

    this.log.info('[tunnel] Stopping tunnel...');
    this._stopHealthCheck();

    const proc = this._proc;
    this._proc = null;
    // Mark as not running BEFORE kill — prevents exit handler from
    // seeing wasRunning=true and emitting a duplicate 'close' event.
    this._state.running = false;

    // Graceful shutdown — on Windows taskkill /T /F kills the entire process tree
    if (process.platform === 'win32' && proc.pid && Number.isInteger(proc.pid)) {
      try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    } else {
      try { proc.kill('SIGTERM'); } catch {}
      // Escalate to SIGKILL after timeout (Unix only — Windows already force-killed above)
      const forceKill = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, SHUTDOWN_TIMEOUT);
      forceKill.unref();
      proc.once('exit', () => clearTimeout(forceKill));
    }
    this._cleanup('Stopped by user');
    this.emit('close', 'Stopped by user');
  }

  /**
   * Get the current tunnel status.
   */
  getStatus() {
    return { ...this._state };
  }

  /**
   * Check if the tunnel is currently running.
   */
  isRunning() {
    return this._state.running;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  _spawnTunnel(provider, config) {
    // Clean environment — remove CLAUDECODE to prevent subprocess confusion
    const env = { ...process.env };
    delete env.CLAUDECODE;

    // On Windows, tunnel binaries installed via npm/chocolatey may be .cmd wrappers
    // that require shell:true to execute (consistent with claude-cli.js approach).
    const needsShell = process.platform === 'win32';

    if (provider === 'cloudflared') {
      return spawn('cloudflared', [
        'tunnel', '--url', `http://localhost:${this.port}`, '--no-autoupdate',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        shell: needsShell,
      });
    }

    if (provider === 'ngrok') {
      const args = ['http', String(this.port), '--log', 'stdout', '--log-format', 'json'];
      if (config.ngrokAuthtoken) {
        args.push('--authtoken', config.ngrokAuthtoken);
      }
      return spawn('ngrok', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        shell: needsShell,
      });
    }

    throw new Error(`Unknown tunnel provider: ${provider}`);
  }

  _parseUrl(provider, text) {
    if (provider === 'cloudflared') {
      // cloudflared writes: "INF ... https://xxx.trycloudflare.com ..."
      const match = text.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i);
      return match ? match[1] : null;
    }

    if (provider === 'ngrok') {
      // ngrok JSON log: {"url":"https://xxx.ngrok-free.app", ...}
      // Can appear in multiple JSON lines
      for (const line of text.split('\n')) {
        try {
          const json = JSON.parse(line.trim());
          if (json.url && json.url.startsWith('https://')) return json.url;
        } catch {
          // Also try regex for non-JSON output
          const match = line.match(/(https:\/\/[a-z0-9-]+\.ngrok[a-z-]*\.(?:app|io))/i);
          if (match) return match[1];
        }
      }
      return null;
    }

    return null;
  }

  _assertBinaryExists(provider) {
    const binary = provider === 'cloudflared' ? 'cloudflared' : 'ngrok';
    const isWin = process.platform === 'win32';
    const lookupCmd = isWin ? `where ${binary}` : `which ${binary}`;

    try {
      execSync(lookupCmd, { stdio: 'ignore' });
    } catch {
      const installUrl = provider === 'cloudflared'
        ? 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
        : 'https://ngrok.com/download';
      const installCmd = this._getInstallCmd(binary);
      const err = new Error(`'${binary}' not found`);
      err.installUrl = installUrl;
      err.installCmd = installCmd;
      err.provider = provider;
      throw err;
    }
  }

  _getInstallCmd(binary) {
    const platform = process.platform;
    if (platform === 'darwin') return `brew install ${binary}`;
    if (platform === 'win32') {
      return binary === 'cloudflared'
        ? `winget install Cloudflare.cloudflared`
        : `choco install ngrok`;
    }
    // Linux
    if (binary === 'cloudflared') {
      return `curl -fsSL https://pkg.cloudflare.com/cloudflared-stable-linux-amd64.deb -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb`;
    }
    return `snap install ngrok`;
  }

  _startHealthCheck() {
    this._stopHealthCheck();
    this._healthTimer = setInterval(() => {
      if (this._proc && this._proc.exitCode !== null) {
        this.log.warn('[tunnel] Process exited unexpectedly during health check');
        this._cleanup('Process exited unexpectedly');
        this.emit('close', 'Process exited unexpectedly');
      }
    }, HEALTH_CHECK_INTERVAL);
    this._healthTimer.unref(); // Don't prevent Node.js from exiting
  }

  _stopHealthCheck() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  _cleanup(reason) {
    this._stopHealthCheck();
    this._state.running = false;
    this._state.publicUrl = null;
    this._state.pid = null;
    this._state.startedAt = null;
    this._state.error = reason || null;
    if (this._proc) {
      try {
        this._proc.stdout?.removeAllListeners('data');
        this._proc.stderr?.removeAllListeners('data');
        this._proc.removeAllListeners('error');
        this._proc.removeAllListeners('exit');
      } catch {}
    }
    this._proc = null;
  }
}

module.exports = TunnelManager;
