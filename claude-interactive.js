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

// tmux negotiates UTF-8 support for the server from LANG/LC_ALL at the FIRST
// `new-session` call's env — neither the Docker image (node:20-bookworm, no ENV
// LANG) nor a macOS GUI launch sets a UTF-8 locale, so without this the tmux
// server falls back to non-UTF-8 mode and mangles every multi-byte character
// sent through load-buffer/paste-buffer (e.g. each Cyrillic letter becomes
// "–" plus a stray glyph). Same bug and same fix as terminal-bridge.js.
const UTF8_LOCALE = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
function utf8Env() {
  return { ...process.env, LANG: UTF8_LOCALE, LC_ALL: UTF8_LOCALE };
}

// Idle (inactivity) watchdog — the turn is abandoned after this long with no new
// transcript bytes. A turn that keeps writing output (the normal long-content case)
// resets the clock and is never cut off; a turn that shows the spinner but writes
// nothing for this long is treated as stuck. Default 10 min.
// Config: CLAUDE_IDLE_TIMEOUT_MS (legacy alias CLAUDE_TIMEOUT_MS).
const IDLE_TIMEOUT_MS = parseInt(process.env.CLAUDE_IDLE_TIMEOUT_MS || process.env.CLAUDE_TIMEOUT_MS || '600000', 10) || 600000;
// Optional absolute ceiling — backstop against a turn that stays "busy" forever. 0 = off.
const HARD_CAP_MS = parseInt(process.env.CLAUDE_HARD_CAP_MS || '0', 10) || 0;

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

// Is the Claude TUI actively working a turn? Used to hold completion until the
// spinner clears — a single assistant message is written to the transcript as
// SEPARATE records per block (thinking → text → tool_use), all stamped with the
// SAME final stop_reason, up to ~20s apart. So a terminal stop_reason can latch
// on the thinking record well before the final text record is flushed; breaking
// then would drop the trailing text. The spinner animates throughout that gap
// and only clears when the turn truly ends.
//
// Detection is defense-in-depth and version-independent — ANY of three signals
// means busy, biased so a false "busy" only DELAYS completion (caught by the
// safety-net) while never risking a premature break that loses text:
//   1. animation — the spinner's elapsed counter ticks every ~0.5–1s, so the
//      captured pane changes between polls during a turn (verified on live
//      2.1.x: idle sessions stay static, working ones change every poll);
//   2. elapsed-timer pattern — a seconds count followed by a "·" or ")", e.g.
//      "(8s ·" / "26m 44s ·" / "8s)", shown only during an active turn (the
//      persistent statusline uses "⏱ 5m" / "🕐 14:12", which don't match);
//   3. legacy "esc to interrupt" marker (older TUI builds).
function paneBusy(pane, prevPane) {
  if (pane === null) return false;
  if (prevPane !== null && pane !== prevPane) return true;     // 1. spinner animating
  if (/\d+s\s*[·)]/.test(pane)) return true;                  // 2. elapsed timer "(8s ·" / "43s ·" / "8s)"
  if (pane.includes('esc to interrupt')) return true;         // 3. legacy marker
  return false;
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
    // 0600: the config embeds internal MCP secrets (ASK_USER_SECRET etc.)
    if (!fs.existsSync(p)) fs.writeFileSync(p, json, { mode: 0o600 });
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
  const { prompt, systemPrompt, model, mode, ws, sessionId, abortController, claudeSessionId, workdir, tabId, mcpServers, userContent, drainInterrupts } = params;
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

      const env = utf8Env();
      delete env.CLAUDECODE; // parent Claude Code session sets this and it confuses the child
      const child = spawn('tmux', ['new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', workdir || process.cwd(), innerCmd], { env, stdio: 'ignore' });
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

    // ── Poll loop: completion = transcript turn-end (stop_reason) gated by the
    //    TUI spinner having cleared; pane is the gate, never the primary signal ──
    let remainder = '';
    let endTurnSeen = false;          // latched when an assistant record ends the turn (stop_reason ≠ tool_use)
    let sawOutput = false;
    let quietPolls = 0;               // consecutive polls with spinner gone (!busy) AND no new transcript bytes
    let prevPaneCap = null;           // previous pane capture — for spinner-animation detection in paneBusy()
    let lastActivityAt = start;       // idle watchdog cursor — bumped on transcript progress (new bytes)

    while (true) {
      await sleep(1500);

      // Mid-run clarifications. The hook mechanism the headless engine uses cannot
      // apply here — there is no per-run --settings to inject, the CLI is already
      // running interactively. The equivalent for a live TUI is to type the message
      // into it, which is exactly what a person sitting at the terminal would do.
      if (typeof drainInterrupts === 'function') {
        let pending = [];
        try { pending = drainInterrupts() || []; } catch {}
        for (const m of pending) {
          const parts = [];
          if (m.content) parts.push(m.content);
          for (const att of (Array.isArray(m.attachments) ? m.attachments : [])) {
            if (att.path) parts.push(`[Attached ${att.mimeType && att.mimeType.startsWith('image/') ? 'image' : 'file'}: ${att.name || 'file'}]\nSaved at: ${att.path}\nRead it before continuing.`);
          }
          const body = parts.join('\n\n').trim();
          if (!body) continue;
          const note = `USER CLARIFICATION (sent while you were working):\n\n${body}`;
          const tmpFile = path.join(os.tmpdir(), `ccs-int-${crypto.randomBytes(6).toString('hex')}.txt`);
          const bufName = `ccsint-${crypto.randomBytes(4).toString('hex')}`;
          try {
            fs.writeFileSync(tmpFile, note);
            spawnSync('tmux', ['load-buffer', '-b', bufName, tmpFile], { stdio: 'ignore' });
            spawnSync('tmux', ['paste-buffer', '-dpr', '-t', name, '-b', bufName], { stdio: 'ignore' });
            await sleep(250);
            spawnSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' });
          } catch {} finally { try { fs.unlinkSync(tmpFile); } catch {} }
        }
      }

      if (abortController?.signal?.aborted) {
        // Interrupt the turn, keep the tmux session alive
        try { spawnSync('tmux', ['send-keys', '-t', name, 'Escape'], { stdio: 'ignore' }); } catch {}
        return { cid, completed: false, resultMeta: { durationMs: Date.now() - start }, fullText, fullThinking, toolEvents };
      }

      if (Date.now() - lastActivityAt > IDLE_TIMEOUT_MS) {
        const mins = Math.round(IDLE_TIMEOUT_MS / 60000);
        wsSend({ type: 'error', error: `interactive engine timed out — no activity for ${mins} min (idle). Raise CLAUDE_IDLE_TIMEOUT_MS to allow longer silences.` });
        return { cid, completed: false, resultMeta: { durationMs: Date.now() - start }, fullText, fullThinking, toolEvents };
      }
      if (HARD_CAP_MS > 0 && Date.now() - start > HARD_CAP_MS) {
        const mins = Math.round(HARD_CAP_MS / 60000);
        wsSend({ type: 'error', error: `interactive engine timed out — exceeded hard cap of ${mins} min (CLAUDE_HARD_CAP_MS).` });
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
            // Turn-completion signal (authoritative, version-independent):
            // `tool_use` is the ONLY stop_reason meaning "the agent will continue
            // after the tool result". Every other terminal value — end_turn |
            // stop_sequence | refusal (the full set observed across the local
            // transcript corpus) — ends the turn. The old code matched only
            // `end_turn` AND was gated behind `!busy`, a pane marker
            // ('esc to interrupt') that no longer exists in the TUI, so `busy`
            // was always false and completion fell through to a 3s-quiet
            // heuristic that fired mid-task — reporting "done" while the agent
            // was still working.
            const _sr = rec.message?.stop_reason;
            if (_sr === 'tool_use') endTurnSeen = false;
            else if (_sr) endTurnSeen = true;
          }
        }
      }

      const pane = capturePane(name);
      const busy = paneBusy(pane, prevPaneCap);
      prevPaneCap = pane;

      // COMPLETE on the transcript turn-end signal, but ONLY once the spinner has
      // cleared and no bytes arrived this poll. `tool_use` is the sole "continue"
      // stop_reason; any other terminal value latches endTurnSeen. Because a
      // single message's blocks are written as separate records up to ~20s apart
      // (thinking → text), endTurnSeen can latch on the thinking record before the
      // final text is flushed — the !busy guard (spinner still animating during
      // that gap) holds the break until the whole message is out. Pane text is
      // never the PRIMARY signal (spinner wording is version-specific); it only
      // gates when to trust the already-latched transcript signal.
      if (endTurnSeen && !busy && !gotNewBytes) break;

      if (gotNewBytes) lastActivityAt = Date.now(); // transcript progress = real work; resets idle watchdog
      if (gotNewBytes || busy) quietPolls = 0; else quietPolls++;

      // Safety-net completion: output WAS produced, then the spinner cleared and
      // no new bytes arrived for ~18s. Covers a missed turn-end stop_reason (e.g.
      // a corrupt final transcript line that failed to JSON.parse). Safe because
      // a working agent keeps `busy` true (animation/timer), so quietPolls only
      // climbs once the turn has genuinely ended.
      if (sawOutput && quietPolls >= 12) break;

      // Dead-end guard: zero output AND spinner gone for ~30s — the message never
      // registered with the TUI; fail fast instead of waiting out the idle timeout.
      // A long thinking phase or slow first tool keeps `busy` true (spinner
      // animating) or writes a record (sawOutput), so neither trips this.
      if (!sawOutput && quietPolls >= 20) {
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

// ─── Catch-up: pull transcript activity done OUTSIDE the web UI ───────────────
// When the user opens a real terminal on a session (the "⚡ Claude Code" button →
// `claude --resume <cid>`), their typing + Claude's replies are appended to the
// SAME <cid>.jsonl this module reads. These helpers let the server pull that gap
// into the web chat on demand. Pure: no tmux, no WebSocket, no SQLite — the
// caller persists the events and re-renders.

// Current byte size of <cid>.jsonl, or null if no transcript exists yet. The
// server calls this to advance the catch-up cursor to EOF after every web turn,
// so a later catch-up only surfaces bytes a terminal session appended afterwards.
function transcriptSize(cid) {
  const p = cid ? findTranscript(cid) : null;
  if (!p) return null;
  try { return fs.statSync(p).size; } catch { return null; }
}

// Extract the human-typed text from a transcript `user` record. Records carrying
// only tool_result / image blocks (tool output fed back to the agent, not
// something a person typed) return '' and are skipped by the caller.
function userRecordText(rec) {
  const c = rec && rec.message ? rec.message.content : undefined;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    const parts = [];
    for (const b of c) {
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.join('\n').trim();
  }
  return '';
}

// Read <cid>.jsonl records appended since `startOffset` and return them as an
// ordered event list plus the new byte offset. The offset advances ONLY past
// COMPLETE lines (to the last '\n'); a half-written trailing record is left for
// the next call. Returns { found, offset, events }.
function catchUpFromTranscript({ cid, startOffset = 0 } = {}) {
  const out = { found: false, offset: Number(startOffset) || 0, events: [] };
  const transcriptPath = cid ? findTranscript(cid) : null;
  if (!transcriptPath) return out;
  out.found = true;

  let size = 0;
  try { size = fs.statSync(transcriptPath).size; } catch { return out; }
  const from = Math.max(0, Math.min(Number(startOffset) || 0, size));
  out.offset = from;
  if (size <= from) return out;

  let buf;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      buf = Buffer.alloc(size - from);
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      buf = buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
  } catch { return out; }

  const lastNl = buf.lastIndexOf(0x0A);
  if (lastNl < 0) return out;                 // no complete line yet — keep offset
  out.offset = from + lastNl + 1;             // byte-accurate advance past last newline

  const text = buf.subarray(0, lastNl + 1).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const ts = rec.timestamp || null;   // real record time → caller uses it as created_at
    if (rec.type === 'user') {
      const txt = userRecordText(rec);
      if (txt) out.events.push({ role: 'user', type: 'text', content: txt, ts });
    } else if (rec.type === 'assistant') {
      const blocks = rec.message && rec.message.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          out.events.push({ role: 'assistant', type: 'text', content: block.text, ts });
        } else if (block.type === 'thinking' && block.thinking) {
          out.events.push({ role: 'assistant', type: 'thinking', content: block.thinking, ts });
        } else if (block.type === 'tool_use') {
          out.events.push({ role: 'assistant', type: 'tool', content: JSON.stringify(block.input || {}).substring(0, 600), tool_name: block.name, ts });
        }
      }
    }
  }
  return out;
}

module.exports = { runInteractiveSingle, killInteractiveTmux, tmuxAvailable, catchUpFromTranscript, transcriptSize };
