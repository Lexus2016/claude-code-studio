// terminal-session.js — pure decision logic for terminal sessions.
//
// Everything here is a pure function: no tmux calls, no fs, no sockets. The side
// effects live in terminal-bridge.js. This split exists so the logic can be unit
// tested the same way rate-limit-utils.js and multi-agent-result.js are.

// Terminal sessions use their own tmux prefix. The `subscription` engine owns
// `ccs-` (claude-interactive.js) — the two must never collide.
const TMUX_PREFIX = 'ccsterm-';

function tmuxNameFor(sessionId) {
  return TMUX_PREFIX + String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isTerminalTmuxName(name) {
  return typeof name === 'string' && name.startsWith(TMUX_PREFIX);
}

// Which restore path applies when a session is opened.
//   'attach'  — tmux session exists, agent alive
//   'respawn' — tmux session exists, agent exited (remain-on-exit left a dead pane)
//   'cold'    — no tmux session (host rebooted, or the reaper killed it)
function resolveState({ hasSession, paneDead }) {
  if (!hasSession) return 'cold';
  return paneDead ? 'respawn' : 'attach';
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// The delegation `template` field is deliberately NOT consulted: it encodes a
// one-shot run with an embedded prompt (`opencode run {prompt}` exits immediately),
// which is useless for an attached terminal.
function resolveAgentCommands(agentConfig) {
  const c = agentConfig || {};
  return {
    interactive: str(c.interactive),
    newIdFlag: str(c.newIdFlag),
    newIdCommand: str(c.newIdCommand),
    resume: str(c.resume),
    resumeLast: str(c.resumeLast),
  };
}

// Extract a conversation id from the stdout of a `newIdCommand`.
//
// Three ways to get an exact id, in order of preference:
//   newIdFlag    — we generate it and the CLI accepts it (claude, grok)
//   newIdCommand — the CLI generates it and prints it (cursor-agent create-chat)
//   neither      — unknown until the agent writes its own store; resumeLast is
//                  the only fallback and may restore a different conversation
//
// Only the last non-empty line is considered, and it must look like a bare id:
// banners, warnings and error text all contain spaces or punctuation and are
// rejected rather than stored as a bogus id.
function parseNewIdOutput(stdout) {
  const lines = String(stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  return /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(last) ? last : null;
}

function supportsTerminal(agentConfig) {
  return resolveAgentCommands(agentConfig).interactive !== null;
}

// The shell command tmux runs for this session.
//   first start + newIdFlag → pin the conversation id we generated, so a later
//                             resume targets exactly this conversation
//   restore + id + resume   → resume that conversation
//   restore, no id          → resumeLast ("the agent's most recent conversation" —
//                             the UI must say so, it may not be this one)
function buildLaunchCommand({ commands, convId = null, isRestore = false }) {
  const c = commands || {};
  if (!c.interactive) return null;
  if (isRestore) {
    if (convId && c.resume) return c.resume.replace('{sid}', convId);
    if (c.resumeLast) return c.resumeLast;
    return c.interactive;
  }
  if (convId && c.newIdFlag) return `${c.interactive} ${c.newIdFlag.replace('{sid}', convId)}`;
  return c.interactive;
}

// Reap decision, split in two so the expensive half can be skipped.
//
// isReapCandidate covers the cheap checks the reaper runs on every session each
// minute. shouldReap adds the pane-hash comparison, which costs two capture-pane
// calls a few seconds apart and is therefore only run on candidates.
//
// `#{session_activity}` is deliberately absent: it does NOT move when the pane
// produces output (measured), so a reaper built on it kills working agents.
// `idleSec` must therefore come from `#{window_activity}`, which does move.
function isReapCandidate({
  attached,
  idleSec,
  sessionAgeSec,
  idleThresholdSec = 1800,
  minAgeSec = 120,
}) {
  if (attached > 0) return false;               // someone is watching
  if (sessionAgeSec < minAgeSec) return false;  // just created
  if (idleSec < idleThresholdSec) return false; // still producing output
  return true;
}

// Full decision. paneHashA/paneHashB are two captures a few seconds apart:
// identical means the pane stopped redrawing, i.e. the agent is not working.
// The busy check is mandatory, not an optimisation — resume restores the
// conversation, but not a file the agent was halfway through writing.
function shouldReap(opts) {
  const { paneHashA = null, paneHashB = null } = opts || {};
  if (!isReapCandidate(opts || {})) return false;
  if (paneHashA === null || paneHashB === null) return false; // busy check not run
  if (paneHashA !== paneHashB) return false;                  // pane redrawing → working
  return true;
}


// Which sessions to close when more are live than `maxLive`. Attached sessions are
// never candidates — someone is looking at them. The rest are ordered most-idle
// first, so the longest-untouched terminal goes first.
function pickOverflow(sessions, maxLive) {
  const list = Array.isArray(sessions) ? sessions : [];
  const cap = Number.isFinite(maxLive) ? Math.max(0, maxLive) : 3;
  const idle = list.filter(s => (s.attached || 0) === 0)
    .sort((a, b) => (b.activityAgeSec || 0) - (a.activityAgeSec || 0));
  const overflow = Math.max(0, list.length - cap);
  return idle.slice(0, Math.min(overflow, idle.length)).map(s => s.name);
}

// Merge default agent definitions into a loaded config. Existing user fields win;
// only genuinely missing keys are backfilled, so an upgrade adds the new terminal
// fields (interactive/resume/...) to agents the user already customised without
// clobbering their command line.
function mergeAgentDefaults(config, defaults) {
  const cfg = config || {};
  const agents = cfg.externalAgents || {};
  const removed = new Set(cfg._removedAgents || []);
  let dirty = false;
  for (const [id, def] of Object.entries(defaults || {})) {
    if (removed.has(id)) continue;
    if (!agents[id]) {
      agents[id] = { ...def };
      dirty = true;
      continue;
    }
    for (const [k, v] of Object.entries(def)) {
      if (agents[id][k] === undefined) { agents[id][k] = v; dirty = true; }
    }
  }
  cfg.externalAgents = agents;
  return { config: cfg, dirty };
}

module.exports = {
  TMUX_PREFIX, tmuxNameFor, isTerminalTmuxName, resolveState,
  resolveAgentCommands, supportsTerminal, buildLaunchCommand, parseNewIdOutput,
  isReapCandidate, shouldReap, pickOverflow, mergeAgentDefaults,
};
