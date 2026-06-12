// claude-interactive.js — tmux-driven interactive Claude engine ("subscription" / Max).
//
// Instead of headless `claude -p` (which bills separate Agent SDK credits), this module
// keeps a PERSISTENT interactive Claude Code TUI session alive inside a detached tmux
// session (one per studio session) and exchanges messages with it via tmux buffers,
// reading replies from the session transcript at ~/.claude/projects/<encoded-cwd>/<cid>.jsonl.
// Interactive sessions run on the Claude Max subscription.
//
// Engine capabilities / behavior:
// - mcpServers: passed via --mcp-config at spawn time (works in interactive mode)
// - systemPrompt: applied at spawn time via --append-system-prompt
// - config changes (system prompt / MCP set / model) are detected via a hash stored
//   in the tmux session environment — the session is respawned with --resume, which
//   keeps writing to the SAME transcript file (verified empirically)
// - image attachments: saved to temp files, paths appended to the prompt (the agent
//   reads them with its Read tool); other structured blocks are flattened to text
// - maxTurns is IGNORED (not applicable to interactive sessions)
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

// Write the MCP servers map to a content-addressed temp file for --mcp-config.
// Files are tiny, idempotent by hash, and intentionally not deleted — the TUI
// reads the path at spawn time and a respawn with the same config reuses it.
function mcpConfigPath(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object' || Object.keys(mcpServers).length === 0) return null;
  try {
    const json = JSON.stringify({ mcpServers });
    const hash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
    const p = path.join(os.tmpdir(), `ccs-mcp-${hash}.json`);
    if (!fs.existsSync(p)) fs.writeFileSync(p, json);
    return p;
  } catch {
    return null;
  }
}

// tmux session environment — survives studio server restarts, dies with the session
function getTmuxEnv(name, key) {
  try {
    const r = spawnSync('tmux', ['show-environment', '-t', name, key], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    const line = (r.stdout || '').trim();
    const eq = line.indexOf('=');
    return eq >= 0 ? line.slice(eq + 1) : null;
  } catch {
    return null;
  }
}

function setTmuxEnv(name, key, val) {
  try { spawnSync('tmux', ['set-environment', '-t', name, key, val], { stdio: 'ignore' }); } catch {}
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
  const { prompt, systemPrompt, model, mode, ws, sessionId, abortController, claudeSessionId, workdir, tabId, mcpServers, userContent } = params;
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
    // ── Resolve per-session config (system prompt, MCP, model) ─────────────
    const mp = mode === 'planning' ? 'MODE: PLANNING ONLY. Analyze, plan, DO NOT modify files.\n\n'
      : mode === 'task' ? 'MODE: EXECUTION.\n\n' : '';
    const sp = (mp + (systemPrompt || '')).trim();
    const modelAlias = /^[a-zA-Z0-9._-]+$/.test(String(model || '')) ? model : 'sonnet';
    const mcpPath = mcpConfigPath(mcpServers);
    let mcpJson = '';
    if (mcpPath) { try { mcpJson = fs.readFileSync(mcpPath, 'utf8'); } catch {} }
    const cfgHash = crypto.createHash('sha256').update(JSON.stringify([sp, mcpJson, modelAlias])).digest('hex').slice(0, 16);

    // ── Spawn (or reuse) the tmux session ──────────────────────────────────
    // tmux alive but no recorded claude session id: without a cid we cannot
    // locate the transcript — kill and respawn fresh.
    if (!cid && tmuxHasSession(name)) killInteractiveTmux(sessionId);

    // Config changed since spawn (skills/mode/MCP/model)? Respawn with --resume —
    // verified to keep writing to the SAME <cid>.jsonl transcript.
    if (cid && tmuxHasSession(name) && getTmuxEnv(name, 'CCS_CFG') !== cfgHash) {
      killInteractiveTmux(sessionId);
    }

    if (!tmuxHasSession(name)) {
      const resuming = !!cid;
      if (!cid) cid = crypto.randomUUID();
      const idFlag = resuming ? `--resume ${shq(cid)}` : `--session-id ${shq(cid)}`;

      const claudeBin = findClaudeBin();
      let innerCmd = `env -u CLAUDECODE ${shq(claudeBin)} ${idFlag} --model ${shq(modelAlias)} --dangerously-skip-permissions`;
      if (sp) innerCmd += ` --append-system-prompt ${shq(sp)}`;
      if (mcpPath) innerCmd += ` --mcp-config ${shq(mcpPath)}`;

      const child = spawn('tmux', ['new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', workdir || process.cwd(), innerCmd], { stdio: 'ignore' });
      await new Promise((resolve) => {
        child.on('exit', resolve);
        child.on('error', resolve);
      });

      if (!tmuxHasSession(name)) {
        wsSend({ type: 'error', error: 'failed to start tmux session for interactive engine' });
        return { cid, completed: false, resultMeta: null, fullText: '', fullThinking: '', toolEvents: [] };
      }

      setTmuxEnv(name, 'CCS_CFG', cfgHash);

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

    // ── Flatten structured userContent: extra text blocks are prepended, image
    // blocks are saved to temp files the agent can open with its Read tool ─────
    let sendText = String(prompt || '');
    if (Array.isArray(userContent)) {
      const extra = [];
      for (const block of userContent) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          // the main prompt text is already in sendText — keep only extra blocks (e.g. SSH host info)
          if (block.text && block.text !== prompt) extra.push(block.text);
        } else if (block.type === 'image' && block.source?.data) {
          try {
            const ext = String(block.source.media_type || 'image/png').split('/')[1] || 'png';
            const imgFile = path.join(os.tmpdir(), `ccs-att-${crypto.randomBytes(6).toString('hex')}.${ext}`);
            fs.writeFileSync(imgFile, Buffer.from(block.source.data, 'base64'));
            extra.push(`[Attached image saved at: ${imgFile} — use the Read tool to view it]`);
          } catch {}
        }
      }
      if (extra.length) sendText = extra.join('\n') + '\n\n' + sendText;
    }

    // ── Send the prompt (tmp file → tmux buffer → bracketed paste → Enter) ─
    const tmpFile = path.join(os.tmpdir(), `ccs-msg-${crypto.randomBytes(8).toString('hex')}.txt`);
    const bufName = `ccsbuf-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmpFile, sendText);
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

      // Dead-end guard: TUI idle for ~30s with zero output and no end_turn —
      // the message likely never registered; fail fast instead of waiting MAX_RUN_MS
      if (!busy && !sawOutput && !endTurnSeen && quietPolls >= 20) {
        wsSend({ type: 'error', error: 'interactive session went idle without producing a reply' });
        return { cid, completed: false, resultMeta: { durationMs: Date.now() - start }, fullText, fullThinking, toolEvents };
      }
    }

    return { cid, completed: true, resultMeta: { durationMs: Date.now() - start }, fullText, fullThinking, toolEvents };
  } catch (e) {
    wsSend({ type: 'error', error: 'interactive engine error: ' + (e?.message || String(e)) });
    return { cid, completed: false, resultMeta: { durationMs: Date.now() - start }, fullText, fullThinking, toolEvents };
  }
}

module.exports = { runInteractiveSingle, killInteractiveTmux };
