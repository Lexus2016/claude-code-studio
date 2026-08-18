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
    resume: str(c.resume),
    resumeLast: str(c.resumeLast),
  };
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
  resolveAgentCommands, supportsTerminal, buildLaunchCommand,
  isReapCandidate, shouldReap, mergeAgentDefaults,
};
