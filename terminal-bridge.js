// terminal-bridge.js — tmux side effects for terminal sessions.
//
// Transport: tmux CONTROL MODE (`tmux -C attach-session`). tmux owns the agent's
// PTY; the control client needs none, so ordinary Node pipes are enough and there
// is no platform branch.
//
// Why not `script -q /dev/null tmux attach-session` (the obvious PTY shim, since
// node-pty is banned as a native module): it dies from Node with
// `script: tcgetattr/ioctl: Operation not supported on socket`, because Node's
// `stdio: 'pipe'` allocates socketpairs rather than real pipes and BSD `script`
// calls tcgetattr on its stdio. It works from a shell, which is how it was first —
// and wrongly — validated. A FIFO for stdin does not help.
//
// Why not `pipe-pane -IO` with FIFOs (raw bytes both ways, verified working): it
// carries no events and no resize, so it needs a second control channel anyway,
// plus two FIFOs and two `cat` processes per session. Control mode carries output,
// input, resize and lifecycle events on one channel; the price is ~30 lines of
// parsing. Same bootstrap limitation either way (see attach()).
//
// All decision logic lives in terminal-session.js — this module only executes.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { TMUX_PREFIX, resolveState } = require('./terminal-session');

function have(bin, args) {
  try { const r = spawnSync(bin, args, { stdio: 'ignore' }); return !r.error && r.status === 0; }
  catch { return false; }
}
let _tmux = null;
function tmuxAvailable() { if (_tmux === null) _tmux = have('tmux', ['-V']); return _tmux; }

function tmux(args, opts = {}) {
  try { return spawnSync('tmux', args, { encoding: 'utf8', ...opts }); }
  catch { return { status: 1, stdout: '', stderr: '' }; }
}

function hasSession(name) {
  const r = tmux(['has-session', '-t', name], { stdio: 'ignore' });
  return r.status === 0;
}

// One display-message call for every field the reaper needs.
// NOTE: session_activity is deliberately NOT used — it does not move when the pane
// produces output (measured), so it cannot tell a working agent from an idle one.
// window_activity does move and is the correct idle signal.
function sessionInfo(name) {
  if (!hasSession(name)) return { exists: false, paneDead: false, attached: 0, activityAgeSec: 0, ageSec: 0 };
  const fmt = '#{pane_dead}|#{session_attached}|#{window_activity}|#{session_created}';
  const r = tmux(['display-message', '-p', '-t', name, fmt]);
  const [dead, attached, activity, created] = String(r.stdout || '').trim().split('|');
  const now = Math.floor(Date.now() / 1000);
  return {
    exists: true,
    paneDead: dead === '1',
    attached: parseInt(attached, 10) || 0,
    activityAgeSec: Math.max(0, now - (parseInt(activity, 10) || now)),
    ageSec: Math.max(0, now - (parseInt(created, 10) || now)),
  };
}

function paneHash(name) {
  const r = tmux(['capture-pane', '-p', '-t', name]);
  if (r.status !== 0) return null;
  return crypto.createHash('sha1').update(r.stdout || '').digest('hex');
}

function listTerminalSessions() {
  const r = tmux(['list-sessions', '-F', '#{session_name}']);
  if (r.status !== 0) return [];
  return String(r.stdout || '').split('\n').map(s => s.trim()).filter(s => s.startsWith(TMUX_PREFIX));
}

// Create or revive the tmux session. Returns which path was taken.
// remain-on-exit: an agent that exits leaves a DEAD pane instead of destroying the
// session, so the scrollback survives and respawn-pane can revive it in place.
// window-size manual: SIGWINCH cannot be delivered through `script`, so sizing is
// driven explicitly by resize(); tmux's default (`latest`) would let any client
// resize the window out from under the others.
function ensureSession({ name, workdir, launchCommand }) {
  const state = resolveState({ hasSession: hasSession(name), paneDead: sessionInfo(name).paneDead });
  if (state === 'attach') return state;
  if (state === 'respawn') {
    tmux(['respawn-pane', '-k', '-t', name, launchCommand]);
    return state;
  }
  const env = { ...process.env };
  delete env.CLAUDECODE; // parent Claude Code session sets this and it confuses the child
  spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', workdir, launchCommand], { env, stdio: 'ignore' });
  tmux(['set-option', '-t', name, 'remain-on-exit', 'on']);
  tmux(['set-option', '-t', name, 'window-size', 'manual']);
  return state;
}

// Decode one %output payload back to the exact bytes the program wrote.
// tmux escapes a byte as \ooo (three octal digits); a literal backslash arrives
// as \\ . Everything else is passed through. The payload is handled as latin1 so
// one char == one byte — decoding as UTF-8 would corrupt any multi-byte character
// that happens to straddle the escape boundary.
function decodeOutputPayload(payload) {
  const bytes = [];
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== '\\') { bytes.push(payload.charCodeAt(i) & 0xff); continue; }
    const oct = payload.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    if (payload[i + 1] === '\\') { bytes.push(0x5c); i += 1; continue; }
    bytes.push(0x5c);
  }
  return Buffer.from(bytes);
}

// Current visible screen, with SGR attributes, as bytes — the bootstrap a freshly
// attached client needs. Control mode replays nothing that happened before the
// attach, so without this the browser shows an empty terminal until the agent
// happens to redraw. Known limitation: this restores the visible text and colours,
// NOT the full terminal state (alternate-screen flag, cursor shape, saved cursor,
// keyboard modes). The agent's next redraw fixes those.
function captureScreen(name) {
  const r = tmux(['capture-pane', '-p', '-e', '-t', name]);
  if (r.status !== 0) return null;
  return Buffer.from(String(r.stdout || '').replace(/\n/g, '\r\n'), 'utf8');
}

// Attach a control-mode client.
//
// Sequencing on attach: spawn first and BUFFER every %output, then capture the
// screen, emit the capture, then flush the buffer. Capturing first would drop
// whatever the agent wrote between the capture and the attach.
function attach({ name, cols, rows, onData, onExit }) {
  const env = { ...process.env };
  delete env.CLAUDECODE; // parent Claude Code session sets this and it confuses children
  const p = spawn('tmux', ['-C', 'attach-session', '-t', name], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  let booted = false;
  const pending = [];
  const emit = (buf) => { if (!buf || !buf.length) return; try { onData(buf); } catch {} };

  // Line assembly: a tmux notification can be split across chunk boundaries, and
  // several can arrive in one chunk. Accumulate raw bytes and cut on LF only.
  let buf = Buffer.alloc(0);
  p.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let nl;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '');
      buf = buf.subarray(nl + 1);
      if (line.startsWith('%output ')) {
        // `%output %<pane-id> <payload>` — split off exactly two fields; the
        // payload itself contains spaces and must not be tokenised.
        const rest = line.slice('%output '.length);
        const sp = rest.indexOf(' ');
        const data = decodeOutputPayload(sp === -1 ? '' : rest.slice(sp + 1));
        if (booted) emit(data); else pending.push(data);
      } else if (line.startsWith('%exit') || line.startsWith('%pane-exited')
              || line.startsWith('%session-closed') || line.startsWith('%pane-died')) {
        try { onExit(); } catch {}
      }
      // Everything else (%begin/%end/%error command framing, %session-changed,
      // %window-* notifications and command reply bodies) is protocol chatter and
      // must never reach the browser terminal.
    }
  });

  p.on('exit', () => { try { onExit(); } catch {} });
  p.on('error', () => { try { onExit(); } catch {} });

  const write = (data) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    // Chunk large input: a paste becomes a single send-keys command line whose hex
    // form is ~3x the byte count, and an unbounded line can overrun tmux's command
    // parser. 512 bytes keeps every command line under ~1.6 KB.
    for (let i = 0; i < b.length; i += 512) {
      const hex = b.subarray(i, i + 512).toString('hex').replace(/(..)/g, '$1 ').trim();
      try { p.stdin.write(`send-keys -t ${name} -H ${hex}\n`); } catch {}
    }
  };

  const doResize = (c, r) => {
    const cc = Math.max(20, Math.min(500, parseInt(c, 10) || 80));
    const rr = Math.max(5, Math.min(200, parseInt(r, 10) || 24));
    // resize-window, NOT `refresh-client -C`: ensureSession sets `window-size manual`,
    // which makes the window size server-driven and ignores the client's own size.
    // The two conflict — verified: with manual sizing, refresh-client -C leaves the
    // window at its old dimensions. Manual sizing is what we want, because it stops
    // a second browser tab from resizing the window out from under the first
    // (tmux's default policy is `latest` — the most recent client wins).
    tmux(['resize-window', '-t', name, '-x', String(cc), '-y', String(rr)]);
  };

  doResize(cols, rows);
  // Bootstrap once the client is registered: give tmux a moment to attach, then
  // paint the current screen and release everything buffered since.
  setTimeout(() => {
    const screen = captureScreen(name);
    if (screen) emit(Buffer.concat([Buffer.from('\x1b[H\x1b[2J', 'latin1'), screen]));
    booted = true;
    while (pending.length) emit(pending.shift());
  }, 150);

  return {
    write,
    resize: doResize,
    close() { try { p.kill('SIGTERM'); } catch {} },
  };
}

// Drop every client of a session without killing it. Used at startup: `script`
// processes are children of the studio's Node process and SURVIVE a studio restart,
// staying attached forever and pinning session_attached above zero — which would
// stop the reaper from ever firing.
function detachClients(name) { tmux(['detach-client', '-s', name]); }

function saveScrollback(name, file) {
  const r = tmux(['capture-pane', '-p', '-S', '-', '-t', name]);
  if (r.status !== 0) return false;
  try { fs.writeFileSync(file, r.stdout || '', { mode: 0o600 }); return true; } catch { return false; }
}

function killSession(name) { tmux(['kill-session', '-t', name], { stdio: 'ignore' }); }

module.exports = {
  tmuxAvailable, hasSession, sessionInfo, paneHash,
  listTerminalSessions, ensureSession, attach, detachClients,
  captureScreen, decodeOutputPayload, saveScrollback, killSession,
};
