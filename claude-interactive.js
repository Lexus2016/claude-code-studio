// claude-interactive.js — tmux-driven interactive Claude engine ("subscription" / Max).
//
// Instead of headless `claude -p` (which bills separate Agent SDK credits), this module
// keeps a PERSISTENT interactive Claude Code TUI session alive inside a detached tmux
// session (one per studio session) and exchanges messages with it via tmux buffers,
// reading replies from the session transcript at ~/.claude/projects/<encoded-cwd>/<cid>.jsonl.
// Interactive sessions run on the Claude Max subscription.
//
// v1 LIMITATIONS (intentional):
// - mcpServers are IGNORED (no per-request MCP config in the interactive TUI)
// - maxTurns is IGNORED (interactive sessions have no turn cap)
// - attachments / userContent blocks are IGNORED (text prompt only)
// - systemPrompt is applied only at tmux SPAWN time via --append-system-prompt;
//   mid-session skill/mode changes take effect only after the tmux session is respawned
//
// This module NEVER touches SQLite and NEVER sends the 'done' WS event — the caller
// (server.js WS chat handler) persists collected output and sends 'done' after return.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { findClaudeBin } = require('./claude-cli');

// Overall run timeout — mirrors claude-cli.js MAX_SUBPROCESS_MS (default 30 min)
const MAX_RUN_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '1800000', 10) || 1800000;

// Pane marker shown by the Claude TUI while a turn is in progress
const BUSY_MARKER = 'esc to interrupt';

// ─── tmux availability (checked once, cached) ───────────────────────────────
let _tmuxAvailable = null;
function tmuxAvailable() {
  if (_tmuxAvailable === null) {
    try {
      const r = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
      _tmuxAvailable = !r.error && r.status === 0;
    } catch {
      _tmuxAvailable = false;
    }
  }
  return _tmuxAvailable;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// POSIX single-quote shell escaping: wrap in ', replace embedded ' with '\''
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function tmuxName(localSessionId) {
  return 'ccs-' + String(localSessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function tmuxHasSession(name) {
  try {
    const r = spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function capturePane(name) {
  try {
    const r = spawnSync('tmux', ['capture-pane', '-p', '-t', name], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return r.stdout || '';
  } catch {
    return null;
  }
}

// Locate <cid>.jsonl under ~/.claude/projects/* — do NOT hand-encode the cwd→dirname
// mapping (macOS realpath/encoding is non-trivial); scan subdirectories instead.
function findTranscript(cid) {
  try {
    const root = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) return null;
    for (const dir of fs.readdirSync(root)) {
      const candidate = path.join(root, dir, cid + '.jsonl');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── public API ──────────────────────────────────────────────────────────────

// Best-effort tmux session kill (called on studio session delete)
function killInteractiveTmux(localSessionId) {
  try {
    spawnSync('tmux', ['kill-session', '-t', tmuxName(localSessionId)], { stdio: 'ignore' });
  } catch {}
}

// Run one message through the persistent interactive tmux session.
// Params: same object as server.js runCliSingle — uses prompt, systemPrompt, model,
// mode, ws, sessionId, abortController, claudeSessionId, workdir, tabId; ignores the rest.
// Returns { cid, completed, resultMeta, fullText, fullThinking, toolEvents }.
async function runInteractiveSingle(params) {
  const { prompt, systemPrompt, model, mode, ws, sessionId, abortController, claudeSessionId, workdir, tabId } = params;
  const start = Date.now();
  const wsSend = (obj) => {
    try { ws.send(JSON.stringify({ ...obj, ...(tabId ? { tabId } : {}) })); } catch {}
  };

  let fullText = '', fullThinking = '';
  const toolEvents = [];

  if (!tmuxAvailable()) {
    wsSend({ type: 'error', error: 'tmux not found — interactive engine unavailable' });
    return { cid: claudeSessionId || null, completed: false, resultMeta: null, fullText: '', fullThinking: '', toolEvents: [] };
  }

  const name = tmuxName(sessionId);
  let cid = claudeSessionId || null;

  try {
    // ── Spawn (or reuse) the tmux session ──────────────────────────────────
    // tmux alive but no recorded claude session id: without a cid we cannot
    // locate the transcript — kill and respawn fresh.
    if (!cid && tmuxHasSession(name)) killInteractiveTmux(sessionId);

    if (!tmuxHasSession(name)) {
      const resuming = !!cid;
      if (!cid) cid = crypto.randomUUID();
      const idFlag = resuming ? `--resume ${shq(cid)}` : `--session-id ${shq(cid)}`;

      const mp = mode === 'planning' ? 'MODE: PLANNING ONLY. Analyze, plan, DO NOT modify files.\n\n'
        : mode === 'task' ? 'MODE: EXECUTION.\n\n' : '';
      const sp = (mp + (systemPrompt || '')).trim();

      const claudeBin = findClaudeBin();
      let innerCmd = `env -u CLAUDECODE ${shq(claudeBin)} ${idFlag} --model ${shq(model || 'sonnet')} --dangerously-skip-permissions`;
      if (sp) innerCmd += ` --append-system-prompt ${shq(sp)}`;

      const child = spawn('tmux', ['new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', workdir || process.cwd(), innerCmd], { stdio: 'ignore' });
      await new Promise((resolve) => {
        child.on('exit', resolve);
        child.on('error', resolve);
      });

      if (!tmuxHasSession(name)) {
        wsSend({ type: 'error', error: 'failed to start tmux session for interactive engine' });
        return { cid, completed: false, resultMeta: null, fullText: '', fullThinking: '', toolEvents: [] };
      }

      // Wait for the TUI to settle: two consecutive identical, non-empty captures
      let prev = null;
      const settleDeadline = Date.now() + 20000;
      while (Date.now() < settleDeadline) {
        await sleep(500);
        const cap = capturePane(name);
        if (cap && cap.trim() && cap === prev) break;
        prev = cap;
      }
    }

    // ── Record transcript offset BEFORE sending ────────────────────────────
    let transcriptPath = findTranscript(cid);
    let offset = 0;
    if (transcriptPath) {
      try { offset = fs.statSync(transcriptPath).size; } catch { offset = 0; }
    }

    // ── Send the prompt (tmp file → tmux buffer → bracketed paste → Enter) ─
    const tmpFile = path.join(os.tmpdir(), `ccs-msg-${crypto.randomBytes(8).toString('hex')}.txt`);
    const bufName = `ccsbuf-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmpFile, String(prompt || ''));
      spawnSync('tmux', ['load-buffer', '-b', bufName, tmpFile], { stdio: 'ignore' });
      spawnSync('tmux', ['paste-buffer', '-dpr', '-t', name, '-b', bufName], { stdio: 'ignore' });
      await sleep(300);
      spawnSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    // ── Poll loop: tail transcript + watch pane busy marker ────────────────
    let remainder = '';
    let endTurnSeen = false;
    let sawOutput = false;
    let quietPolls = 0; // consecutive polls with no busy marker and no new bytes
    const deadline = start + MAX_RUN_MS;

    while (true) {
      await sleep(1500);

      if (abortController?.signal?.aborted) {
        // Interrupt the turn, keep the tmux session alive
        try { spawnSync('tmux', ['send-keys', '-t', name, 'Escape'], { stdio: 'ignore' }); } catch {}
        return { cid, completed: false, resultMeta: { durationMs: Date.now() - start }, fullText, fullThinking, toolEvents };
      }

      if (Date.now() > deadline) {
        wsSend({ type: 'error', error: 'interactive engine timed out waiting for a reply' });
        return { cid, completed: false, resultMeta: { durationMs: Date.now() - start }, fullText, fullThinking, toolEvents };
      }

      // Locate transcript lazily — file may not exist until the first reply starts
      if (!transcriptPath) {
        transcriptPath = findTranscript(cid);
        if (transcriptPath) offset = 0;
      }

      // Tail new transcript bytes from the recorded offset
      let gotNewBytes = false;
      if (transcriptPath) {
        let size = 0;
        try { size = fs.statSync(transcriptPath).size; } catch { size = 0; }
        if (size > offset) {
          gotNewBytes = true;
          let chunk = '';
          try {
            const fd = fs.openSync(transcriptPath, 'r');
            try {
              const buf = Buffer.alloc(size - offset);
              const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
              chunk = buf.subarray(0, bytesRead).toString('utf8');
              offset += bytesRead;
            } finally {
              fs.closeSync(fd);
            }
          } catch {}

          const data = remainder + chunk;
          const lines = data.split('\n');
          remainder = lines.pop() || ''; // keep trailing partial line
          for (const line of lines) {
            if (!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch { continue; }
            if (rec.type !== 'assistant') continue; // ignore user/system/attachment records
            const blocks = rec.message?.content;
            if (Array.isArray(blocks)) {
              for (const block of blocks) {
                if (block.type === 'text' && block.text) {
                  fullText += block.text;
                  sawOutput = true;
                  wsSend({ type: 'text', text: block.text });
                } else if (block.type === 'thinking' && block.thinking) {
                  fullThinking += block.thinking;
                  sawOutput = true;
                  wsSend({ type: 'thinking', text: block.thinking });
                } else if (block.type === 'tool_use') {
                  const input = JSON.stringify(block.input || {}).substring(0, 600);
                  toolEvents.push({ name: block.name, input });
                  sawOutput = true;
                  wsSend({ type: 'tool', tool: block.name, input });
                }
              }
            }
            if (rec.message?.stop_reason === 'end_turn') endTurnSeen = true;
          }
        }
      }

      // Busy detection via pane content
      const pane = capturePane(name);
      const busy = pane !== null && pane.includes(BUSY_MARKER);

      if (busy || gotNewBytes) {
        quietPolls = 0;
      } else {
        quietPolls++;
      }

      // COMPLETE when not busy AND (end_turn seen since send, OR some output arrived
      // and two consecutive quiet polls passed)
      if (!busy && (endTurnSeen || (sawOutput && quietPolls >= 2))) break;
    }

    return { cid, completed: true, resultMeta: { durationMs: Date.now() - start }, fullText, fullThinking, toolEvents };
  } catch (e) {
    wsSend({ type: 'error', error: 'interactive engine error: ' + (e?.message || String(e)) });
    return { cid, completed: false, resultMeta: { durationMs: Date.now() - start }, fullText, fullThinking, toolEvents };
  }
}

module.exports = { runInteractiveSingle, killInteractiveTmux };
