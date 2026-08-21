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
const os = require('node:os');
const path = require('node:path');
const { TMUX_PREFIX, resolveState } = require('./terminal-session');

// tmux negotiates UTF-8 support for the control-mode client (and for the server on
// first `new-session`) from LANG/LC_ALL at process start via setlocale(). Neither the
// Docker image (node:20-bookworm, no ENV LANG) nor a macOS GUI launch (Electron from
// Finder/Dock does not source .zshrc) sets a UTF-8 locale, so tmux falls back to
// non-UTF-8 mode and mangles every multi-byte character it sends/receives — e.g. each
// Cyrillic letter (UTF-8 lead byte 0xD0/0xD1) turns into "–"/"—" plus a stray glyph.
// C.UTF-8 is glibc-builtin (no locale-gen needed) on Debian/Linux; macOS has no
// C.UTF-8 but ships en_US.UTF-8 out of the box.
const UTF8_LOCALE = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
function utf8Env() {
  return { ...process.env, LANG: UTF8_LOCALE, LC_ALL: UTF8_LOCALE };
}

function have(bin, args) {
  try { const r = spawnSync(bin, args, { stdio: 'ignore' }); return !r.error && r.status === 0; }
  catch { return false; }
}
let _tmux = null;
function tmuxAvailable() { if (_tmux === null) _tmux = have('tmux', ['-V']); return _tmux; }

// Control-mode commands are newline-delimited, so a session name carrying a newline
// would split the line and let a caller smuggle a second tmux command. tmuxNameFor()
// already sanitises, but attach()/ensureSession() must not depend on their caller
// having used it.
function assertName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`unsafe tmux session name: ${JSON.stringify(name)}`);
  }
  return name;
}

// Terminal sessions live on their OWN tmux server (socket `ccstudio`), never the
// default one. Measured failure this was written for: an agent working in a repo ran
// `tmux kill-server` before a test run (a normal thing to do — the test suite itself
// documented it), which destroyed every live studio terminal on the default socket,
// mid-work. The session prefix alone is no protection: kill-server is server-wide.
// A separate socket makes any tmux command a human or an agent runs in a shell —
// kill-server included — physically unable to touch studio sessions.
const TMUX_SOCKET = 'ccstudio';
function tmuxArgs(args) { return ['-L', TMUX_SOCKET, ...args]; }

// How long ensureSession() waits for a just-launched command to prove it did not die
// on the spot, and how often it looks. See the comment at the end of ensureSession()
// for the measurement these numbers come from.
const LAUNCH_GRACE_MS = 300;
const LAUNCH_POLL_MS = 20;

// ensureSession() is synchronous and its callers depend on that, so the poll above
// cannot await. Atomics.wait on a throwaway buffer blocks the thread without burning
// CPU, unlike a spin loop (which would make the very contention being measured worse).
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB: fall through, the poll just spins */ }
}

function tmux(args, opts = {}) {
  try { return spawnSync('tmux', tmuxArgs(args), { encoding: 'utf8', ...opts }); }
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
  // `-t <session>` resolves to the ACTIVE pane, so the #{pane_dead} above answers "is the
  // focused pane dead", not "did the agent exit" — and remain-on-exit is a WINDOW option, so
  // every pane Claude Code's agent-teams splits off leaves a dead pane behind when its
  // teammate finishes. Reading one pane made resolveState() return 'respawn' while the
  // user's own `claude` was still running; ensureSession then relaunched
  // `claude --resume <the same id>` on top of it, the agent refused, the caller's self-heal
  // read that fast exit as "nothing to resume", and it killed the whole session. Two live
  // working sessions were lost to exactly this. The agent is gone only when EVERY pane is dead.
  const _panes = tmux(['list-panes', '-t', name, '-F', '#{pane_dead}']);
  const _paneStates = String(_panes.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  const _allDead = _paneStates.length > 0 && _paneStates.every(s => s === '1');
  const now = Math.floor(Date.now() / 1000);
  return {
    exists: true,
    // `dead` stays as the fallback for a tmux answer we could not parse.
    paneDead: _paneStates.length ? _allDead : dead === '1',
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

// Create or revive the tmux session. Returns which path was taken, or throws when
// tmux refuses — a missing workdir, an unreachable tmux socket or a bad launch
// command must not be reported as a successful cold start, or the caller attaches
// to a session that does not exist.
//
// remain-on-exit: an agent that exits leaves a DEAD pane instead of destroying the
// session, so the scrollback survives and respawn-pane can revive it in place.
// window-size manual: the size stops following clients, so a tab attaching or
// detaching no longer resizes the window under the other tabs (tmux's default
// `latest` re-sizes to whichever client acted last, including on detach). It does
// NOT arbitrate between two tabs actively resizing — there the last resize still
// wins, same as `latest`. Sizing goes through resize-window; `refresh-client -C`
// works only under the default policy and is silently ignored here (measured).
function ensureSession({ name, workdir, launchCommand }) {
  assertName(name);
  const state = resolveState({ hasSession: hasSession(name), paneDead: sessionInfo(name).paneDead });
  if (state === 'attach') return state;
  if (state === 'respawn') {
    const r = tmux(['respawn-pane', '-k', '-t', name, launchCommand]);
    if (r.status !== 0) throw new Error(`tmux respawn-pane failed: ${String(r.stderr || '').trim() || 'unknown error'}`);
    return state;
  }
  const env = utf8Env();
  delete env.CLAUDECODE; // parent Claude Code session sets this and it confuses the child
  // tmux does NOT fail on a missing -c directory: it silently falls back to $HOME
  // (measured — exit 0, pane_current_path=~). The agent would then run against the
  // wrong tree, so check before creating.
  if (!workdir || !fs.existsSync(workdir)) {
    throw new Error(`workdir does not exist: ${workdir}`);
  }
  const r = spawnSync('tmux', tmuxArgs(['new-session', '-d', '-s', name, '-c', workdir, launchCommand]), { env, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`tmux new-session failed: ${String(r.stderr || r.error?.message || '').trim() || 'unknown error'}`);
  }
  // Set the options BEFORE deciding whether the launch worked. remain-on-exit is what
  // turns "the session vanished" into "the pane is dead" — applying it first means a
  // command that dies leaves evidence behind whichever way the race below lands.
  tmux(['set-option', '-t', name, 'remain-on-exit', 'on']);
  tmux(['set-option', '-t', name, 'window-size', 'manual']);

  // A launch command that dies immediately also exits 0 above: `new-session -d`
  // returns as soon as the session exists, which is before the command has had a
  // chance to fail. The failure then surfaces one of two ways, depending on which
  // side of that race set-option landed on — the session disappears, or the pane is
  // left dead — and it surfaces LATE: measured on this machine with a nonexistent
  // binary, tmux reaped 28/30 launches before the first has-session call but took
  // 32-44 ms on the other 2 under CPU load. A single immediate check (what this used
  // to be) therefore reported a dead agent as a successful cold start ~7% of the
  // time, and the caller went on to attach to a session that was not there.
  // So poll both signals to a deadline instead of guessing once. LAUNCH_GRACE_MS is
  // ~7x the worst delay observed. It is only ever paid in full by a HEALTHY cold
  // start, taking that path from ~130 ms to ~440 ms (measured) — a cost worth paying
  // once per terminal open, next to spawning the agent process itself, and the price
  // of not handing the caller a session that is already gone.
  const deadline = Date.now() + LAUNCH_GRACE_MS;
  for (;;) {
    if (!hasSession(name)) {
      throw new Error(`agent command exited immediately: ${launchCommand}`);
    }
    if (sessionInfo(name).paneDead) {
      // Leave nothing half-created behind: the caller is getting an exception, so it
      // will not attach, and a stray dead-pane session would later look respawnable.
      killSession(name);
      throw new Error(`agent command exited immediately: ${launchCommand}`);
    }
    if (Date.now() >= deadline) break;
    sleepSync(LAUNCH_POLL_MS);
  }
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
// Bootstrap sequencing. Control mode replays nothing from before the attach, so the
// browser is painted from a capture-pane snapshot. The snapshot is taken with a
// SYNCHRONOUS spawnSync, which is the load-bearing detail: Node cannot run the
// stdout 'data' handler while it blocks, so every %output buffered up to that moment
// is output tmux had already applied to the pane — i.e. it is already inside the
// snapshot. Replaying it would double-print and can corrupt a TUI's screen, so the
// buffer is DISCARDED, not flushed. Anything arriving after the snapshot returns is
// streamed live.
function attach({ name, cols, rows, onData, onExit, resizeOnAttach = true }) {
  assertName(name);
  const env = utf8Env();
  delete env.CLAUDECODE; // parent Claude Code session sets this and it confuses children
  const p = spawn('tmux', tmuxArgs(['-C', 'attach-session', '-t', name]), { env, stdio: ['pipe', 'pipe', 'pipe'] });

  let booted = false;
  const emit = (buf) => { if (!buf || !buf.length) return; try { onData(buf); } catch {} };
  // A dying session reports twice — once as a `%…-closed`/`%exit` notification and
  // again when the control client process exits. Callers close a WebSocket in this
  // handler, so it must fire at most once.
  let exited = false;
  const fireExit = () => { if (exited) return; exited = true; try { onExit(); } catch {} };

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
        // Pre-boot output is already inside the snapshot below — drop it.
        if (booted) emit(decodeOutputPayload(sp === -1 ? '' : rest.slice(sp + 1)));
      } else if (line.startsWith('%exit')) {
        // %exit is the ONLY exit notification tmux control mode sends (session
        // killed, server killed, or we detached). Its reason field is empty on
        // every path in 3.7b, so it cannot be branched on — treat any %exit as
        // "gone". Note: %pane-exited / %session-closed / %pane-died do NOT exist
        // in the protocol (checked against the full list in `man tmux`).
        fireExit();
      } else if (line.startsWith('%subscription-changed deadwatch ')) {
        // The agent process exiting under `remain-on-exit on` fires NO notification
        // at all — verified: the pane goes pane_dead=1 and the control client hears
        // nothing, so without this the browser would sit on a frozen frame forever.
        // A format subscription is the only mechanism that reports it.
        if (/:\s*1\s*$/.test(line)) fireExit();
      }
      // Everything else (%begin/%end/%error command framing, %session-changed,
      // %window-* notifications and command reply bodies) is protocol chatter and
      // must never reach the browser terminal.
    }
  });

  p.on('exit', fireExit);
  p.on('error', fireExit);

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

  // Land text in the pane WITHOUT submitting it — a "paste a skill/command" action,
  // not "run" it. write() above sends keystrokes one at a time via send-keys, so any
  // \n in the text would be read as an Enter and submit mid-paste. Going through a
  // tmux buffer + `paste-buffer -p` instead wraps the text in bracketed-paste markers
  // (ESC[200~ ... ESC[201~), which every readline-based program — including Claude
  // Code's own TUI, per claude-interactive.js's prompt-injection path — treats as one
  // block of literal text and leaves sitting in the line for the user to edit/submit.
  const paste = (text) => {
    const tmpFile = path.join(os.tmpdir(), `ccsterm-paste-${crypto.randomBytes(8).toString('hex')}.txt`);
    const bufName = `ccspaste_${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmpFile, String(text), { encoding: 'utf8', mode: 0o600 });
      tmux(['load-buffer', '-b', bufName, tmpFile]);
      tmux(['paste-buffer', '-dpr', '-t', name, '-b', bufName]);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  };

  const doResize = (c, r) => {
    const cc = parseInt(c, 10), rr = parseInt(r, 10);
    // Reject an implausible geometry instead of clamping it UP. The old floors (20 cols /
    // 5 rows) turned obvious garbage into something tmux would accept: a browser measuring
    // a hidden xterm proposes ~9x5 (getComputedStyle on a display:none element returns the
    // literal "100%", and parseInt("100%") === 100), which used to arrive here and become a
    // real 20x5 window. A viewport that genuinely cannot show 40x10 is not worth resizing to.
    if (!Number.isFinite(cc) || !Number.isFinite(rr) || cc < 40 || rr < 10) return;
    // Never resize a SPLIT window. resize-window moves the whole window and tmux
    // redistributes panes by its own layout rules on the way down AND on the way up — it
    // does not restore the previous window_layout, and nothing here ever calls
    // select-layout. One shrink-and-grow cycle on a two-pane window is permanent damage:
    // measured, a 50/50 split came back 33/77 and no later resize undid it. When the window
    // is split the pane belongs to whoever split it (Claude Code's agent-teams does exactly
    // this), so the browser should size its xterm to the pane instead.
    if (paneCount(name) > 1) return;
    // resize-window, NOT `refresh-client -C`: ensureSession sets `window-size manual`
    // and the two conflict — verified in both directions (refresh-client -C leaves a
    // manually-sized window untouched). See the policy note on ensureSession.
    tmux(['resize-window', '-t', name, '-x', String(Math.min(500, cc)), '-y', String(Math.min(200, rr))]);
  };

  // resizeOnAttach:false is for a pane this module did NOT create — the subscription
  // engine's `ccs-<id>` session (claude-interactive.js), spawned at a fixed 220x50 and
  // driven by a poller that reads the pane. Reflowing a running Claude TUI to the
  // browser's geometry just because someone opened a viewer would repaint the whole
  // screen mid-turn; the caller sets `window-size manual` first and sizes ITS xterm to
  // the pane instead of the other way round.
  if (resizeOnAttach) doResize(cols, rows);
  // Subscribe to the pane's liveness — see the %subscription-changed branch above.
  try { p.stdin.write('refresh-client -B "deadwatch:%*:#{pane_dead}"\n'); } catch {}
  // Bootstrap once the client is registered: give tmux a moment to attach, then
  // paint the current screen and release everything buffered since.
  setTimeout(() => {
    if (exited) return;
    const screen = captureScreen(name);   // synchronous — see the bootstrap note above
    booted = true;                        // set in the same tick, before any data event
    if (screen) emit(Buffer.concat([Buffer.from('\x1b[H\x1b[2J', 'latin1'), screen]));
  }, 150);

  return {
    write,
    paste,
    resize: doResize,
    // Read-only, for callers that need to know when the control client itself is
    // gone rather than guessing with a timer (the integration test waits on it to
    // prove BOTH exit reports have had their chance before asserting onExit fired
    // exactly once). Nothing in the server writes to it.
    pid: p.pid,
    close() { try { p.kill('SIGTERM'); } catch {} },
  };
}

// How many panes the session's current window holds.
//
// The studio has no concept of panes: it creates one command per session and every tmux
// target it writes is `-t <session>`, which tmux resolves to the ACTIVE PANE of the current
// window. That assumption is false in practice — Claude Code's agent-teams feature
// (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) splits whatever window it runs in, one pane per
// teammate. Measured on a live session: a 111x38 window holding `claude --resume <id>` at
// 33x37 next to a teammate at 77x37.
function paneCount(name) {
  assertName(name);
  const r = tmux(['list-panes', '-t', name, '-F', '#{pane_id}']);
  // Fail SAFE, not optimistic: callers use this to decide whether it is safe to resize a
  // window we may not own. Answering 1 on an unreadable tmux would re-enable exactly the
  // layout-destroying resize this guard exists to prevent, so an unknown count reads as
  // "more than one".
  if (r.status !== 0) return 2;
  const _n = String(r.stdout || '').split('\n').filter(Boolean).length;
  return _n || 2;
}

// Freeze a session's geometry so an attaching client cannot resize it. tmux's default
// `window-size latest` policy hands the window to whichever client acted last, so a
// control-mode attach alone (no resize command at all) is enough to reflow a running
// TUI. Set this BEFORE attach() on any pane this module does not own.
function setWindowSizeManual(name) {
  assertName(name);
  tmux(['set-option', '-t', name, 'window-size', 'manual']);
}

// The pane's current geometry, so a viewer can size itself to the pane.
// Falls back to 80x24 when the session is gone or tmux answers with junk.
function paneSize(name) {
  const r = tmux(['display-message', '-p', '-t', name, '#{window_width}|#{window_height}']);
  const [c, rr] = String(r.stdout || '').trim().split('|');
  return { cols: parseInt(c, 10) || 80, rows: parseInt(rr, 10) || 24 };
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
  TMUX_SOCKET, tmuxAvailable, hasSession, sessionInfo, paneHash,
  listTerminalSessions, ensureSession, attach, detachClients,
  setWindowSizeManual, paneSize, paneCount,
  captureScreen, decodeOutputPayload, saveScrollback, killSession,
};
