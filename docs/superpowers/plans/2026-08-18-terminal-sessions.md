# Terminal Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a studio session be a live terminal running an agent CLI (Claude Code, codex, agy, opencode) in the browser, restorable after a studio restart or host reboot, and reaped from memory when idle.

**Architecture:** A session is typed at creation (`kind = 'chat' | 'terminal'`) and never switches, so no session ever has two drivers. Terminal sessions live in detached tmux sessions named `ccsterm-<id>`; the browser attaches through a `script`-wrapped `tmux attach-session` whose stdout/stdin are pumped over a dedicated WebSocket to xterm.js. All decision logic (which restore path, which launch command, whether to reap) lives in a pure module so it is unit-testable; every tmux/spawn side effect lives in a separate bridge module.

**Tech Stack:** Node 20, `ws`, tmux, system `script`, vendored xterm.js. No new npm dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-08-18-terminal-sessions-design.md`

## Global Constraints

- No new npm dependencies. No build step. xterm.js is vendored as a plain file under `public/vendor/` and loaded with a `<script>` tag.
- `public/index.html` stays a single file.
- No TypeScript, no `as`-style typecasts, vanilla JS and vanilla CSS only.
- SQLite: WAL stays on; schema changes are `ALTER TABLE ... ADD COLUMN` only, in the existing block (grep `ALTER TABLE sessions ADD COLUMN transcript_offset`).
- Tests are plain CommonJS + `node:assert`, in the style of `test/overload-detector.test.js`. New test files are appended to the `test` script in `package.json`.
- tmux session names for this feature are always prefixed `ccsterm-`. The `subscription` engine owns `ccs-` and must not be touched.
- `TERM=xterm-256color` must be set explicitly on every spawned `script` process.
- Line numbers in this repo drift (`server.js` grew 76 lines during the design session). Locate every edit point by grep anchor, never by line number.
- User-facing UI strings go through the existing i18n table in `public/index.html`; English is the source language for code, comments and commits.

---

### Task 1: Pure decision logic

**Files:**
- Create: `terminal-session.js`
- Create: `test/terminal-session.test.js`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `tmuxNameFor(sessionId) -> string`, `isTerminalTmuxName(name) -> boolean`, `resolveState({hasSession, paneDead}) -> 'attach'|'respawn'|'cold'`, `resolveAgentCommands(agentConfig) -> {interactive, newIdFlag, resume, resumeLast}`, `supportsTerminal(agentConfig) -> boolean`, `buildLaunchCommand({commands, convId, isRestore}) -> string|null`, `isReapCandidate({attached, idleSec, sessionAgeSec, idleThresholdSec, minAgeSec}) -> boolean`, `shouldReap({...candidate fields, paneHashA, paneHashB}) -> boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/terminal-session.test.js`:

```js
// Pure-logic verification for terminal-session.js (no test framework in this project).
// Run: node test/terminal-session.test.js
const assert = require('assert');
const {
  tmuxNameFor, isTerminalTmuxName, resolveState,
  resolveAgentCommands, supportsTerminal, buildLaunchCommand,
  isReapCandidate, shouldReap,
} = require('../terminal-session');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass++; console.log(`  ok   ${label}`);
  } catch {
    fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const CLAUDE = { label: 'Claude Code', interactive: 'claude', newIdFlag: '--session-id {sid}', resume: 'claude --resume {sid}', resumeLast: 'claude --continue' };
const CODEX  = { label: 'OpenAI Codex', interactive: 'codex', resume: 'codex resume {sid}', resumeLast: 'codex resume --last' };
const DELEGATE_ONLY = { label: 'Legacy', template: 'legacy {prompt}' };

console.log('tmux naming:');
check('prefixes with ccsterm-', tmuxNameFor('abc123'), 'ccsterm-abc123');
check('sanitises unsafe chars', tmuxNameFor('a b/c;d'), 'ccsterm-a_b_c_d');
check('recognises own names', isTerminalTmuxName('ccsterm-abc'), true);
check('rejects subscription-engine names', isTerminalTmuxName('ccs-abc'), false);
check('rejects non-strings', isTerminalTmuxName(null), false);

console.log('restore state:');
check('no tmux session -> cold', resolveState({ hasSession: false, paneDead: false }), 'cold');
check('session with live pane -> attach', resolveState({ hasSession: true, paneDead: false }), 'attach');
check('session with dead pane -> respawn', resolveState({ hasSession: true, paneDead: true }), 'respawn');

console.log('agent commands:');
check('reads all four fields', resolveAgentCommands(CLAUDE), { interactive: 'claude', newIdFlag: '--session-id {sid}', resume: 'claude --resume {sid}', resumeLast: 'claude --continue' });
check('missing fields become null', resolveAgentCommands(DELEGATE_ONLY), { interactive: null, newIdFlag: null, resume: null, resumeLast: null });
check('blank strings become null', resolveAgentCommands({ interactive: '   ' }), { interactive: null, newIdFlag: null, resume: null, resumeLast: null });
check('delegation-only agent unsupported', supportsTerminal(DELEGATE_ONLY), false);
check('interactive agent supported', supportsTerminal(CODEX), true);

console.log('launch command:');
check('first start, id-capable agent pins the id',
  buildLaunchCommand({ commands: resolveAgentCommands(CLAUDE), convId: 'u-1', isRestore: false }),
  'claude --session-id u-1');
check('first start, agent without newIdFlag ignores the id',
  buildLaunchCommand({ commands: resolveAgentCommands(CODEX), convId: 'u-1', isRestore: false }),
  'codex');
check('restore with known id uses resume',
  buildLaunchCommand({ commands: resolveAgentCommands(CLAUDE), convId: 'u-1', isRestore: true }),
  'claude --resume u-1');
check('restore without id falls back to resumeLast',
  buildLaunchCommand({ commands: resolveAgentCommands(CODEX), convId: null, isRestore: true }),
  'codex resume --last');
check('restore with no resume options starts clean',
  buildLaunchCommand({ commands: resolveAgentCommands({ interactive: 'foo' }), convId: null, isRestore: true }),
  'foo');
check('unsupported agent yields null',
  buildLaunchCommand({ commands: resolveAgentCommands(DELEGATE_ONLY), convId: null, isRestore: false }),
  null);

console.log('reaper:');
const BASE = { attached: 0, idleSec: 3600, sessionAgeSec: 3600, paneHashA: 'x', paneHashB: 'x' };
check('idle, unattached, quiet -> reap', shouldReap({ ...BASE }), true);
check('someone attached -> keep', shouldReap({ ...BASE, attached: 1 }), false);
check('too young -> keep', shouldReap({ ...BASE, sessionAgeSec: 30 }), false);
check('recent window activity -> keep', shouldReap({ ...BASE, idleSec: 60 }), false);
check('pane still changing -> keep', shouldReap({ ...BASE, paneHashB: 'y' }), false);
check('busy check not performed -> keep', shouldReap({ ...BASE, paneHashB: null }), false);
check('custom threshold respected', shouldReap({ ...BASE, idleSec: 300, idleThresholdSec: 120 }), true);

console.log('reap candidacy (cheap checks only — no pane hashes):');
check('idle and unattached is a candidate', isReapCandidate({ attached: 0, idleSec: 3600, sessionAgeSec: 3600 }), true);
check('attached is not a candidate', isReapCandidate({ attached: 1, idleSec: 3600, sessionAgeSec: 3600 }), false);
check('young session is not a candidate', isReapCandidate({ attached: 0, idleSec: 3600, sessionAgeSec: 10 }), false);
check('recently active is not a candidate', isReapCandidate({ attached: 0, idleSec: 10, sessionAgeSec: 3600 }), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/terminal-session.test.js`
Expected: FAIL — `Cannot find module '../terminal-session'`

- [ ] **Step 3: Write the implementation**

Create `terminal-session.js`:

```js
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
  if (attached > 0) return false;              // someone is watching
  if (sessionAgeSec < minAgeSec) return false; // just created
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

module.exports = {
  TMUX_PREFIX, tmuxNameFor, isTerminalTmuxName, resolveState,
  resolveAgentCommands, supportsTerminal, buildLaunchCommand,
  isReapCandidate, shouldReap,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/terminal-session.test.js`
Expected: `30 passed, 0 failed`, exit code 0

- [ ] **Step 5: Wire into `npm test`**

In `package.json`, append to the `test` script (keep the existing `&&` chain):

```
&& node test/terminal-session.test.js
```

Run: `npm test`
Expected: all existing suites plus the new one pass.

- [ ] **Step 6: Commit**

```bash
git add terminal-session.js test/terminal-session.test.js package.json
git commit -m "feat(terminal): pure decision logic for terminal sessions"
```

---

### Task 2: Agent commands in config

**Files:**
- Modify: `server.js` (grep anchor `const DEFAULT_EXTERNAL_AGENTS = {`)
- Modify: `server.js` (grep anchor `// Merge-in default external agents`)
- Modify: `test/terminal-session.test.js` (append a section)

**Interfaces:**
- Consumes: `resolveAgentCommands`, `supportsTerminal` from Task 1.
- Produces: `DEFAULT_EXTERNAL_AGENTS` entries carrying `interactive` / `newIdFlag` / `resume` / `resumeLast`; a `claude` entry usable as a terminal agent; `mergeAgentDefaults(config, defaults) -> {config, dirty}` exported from `terminal-session.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/terminal-session.test.js`, before the final `console.log` summary:

```js
const { mergeAgentDefaults } = require('../terminal-session');

console.log('config merge:');
const DEFAULTS = {
  claude: { label: 'Claude Code', interactive: 'claude', newIdFlag: '--session-id {sid}', resume: 'claude --resume {sid}', resumeLast: 'claude --continue' },
  codex:  { label: 'OpenAI Codex', template: 'codex {prompt}', interactive: 'codex', resume: 'codex resume {sid}', resumeLast: 'codex resume --last' },
};
{
  const r = mergeAgentDefaults({ externalAgents: {}, _removedAgents: [] }, DEFAULTS);
  check('adds missing agents', Object.keys(r.config.externalAgents).sort(), ['claude', 'codex']);
  check('marks dirty when it added something', r.dirty, true);
}
{
  // An existing user agent keeps its own template but gains the new terminal fields.
  const existing = { externalAgents: { codex: { label: 'My Codex', template: 'codex --yolo {prompt}' } }, _removedAgents: [] };
  const r = mergeAgentDefaults(existing, DEFAULTS);
  check('never overwrites a user template', r.config.externalAgents.codex.template, 'codex --yolo {prompt}');
  check('never overwrites a user label', r.config.externalAgents.codex.label, 'My Codex');
  check('backfills interactive', r.config.externalAgents.codex.interactive, 'codex');
  check('backfills resume', r.config.externalAgents.codex.resume, 'codex resume {sid}');
}
{
  const r = mergeAgentDefaults({ externalAgents: {}, _removedAgents: ['codex'] }, DEFAULTS);
  check('respects _removedAgents', Object.keys(r.config.externalAgents), ['claude']);
}
{
  const already = { externalAgents: { claude: { ...DEFAULTS.claude }, codex: { ...DEFAULTS.codex } }, _removedAgents: [] };
  check('idempotent second run is not dirty', mergeAgentDefaults(already, DEFAULTS).dirty, false);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/terminal-session.test.js`
Expected: FAIL — `mergeAgentDefaults is not a function`

- [ ] **Step 3: Implement `mergeAgentDefaults` in `terminal-session.js`**

Add before `module.exports` and extend the export list with `mergeAgentDefaults`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/terminal-session.test.js`
Expected: all checks pass, exit code 0

- [ ] **Step 5: Update the defaults in `server.js`**

First add the module requires next to the existing top-level ones (grep `require('./multi-agent-result')`). `path`, `fs`, `os` and `crypto` are already required at the top of `server.js` — verified — so nothing else is needed:

```js
const {
  tmuxNameFor, resolveAgentCommands, supportsTerminal, buildLaunchCommand,
  isReapCandidate, shouldReap, pickOverflow, mergeAgentDefaults,
} = require('./terminal-session');
const termBridge = require('./terminal-bridge');
```

`terminal-bridge.js` does not exist until Task 4. Add only the `terminal-session` require now and add the `termBridge` line in Task 4; requiring a missing module crashes the server at boot.

Then replace the `DEFAULT_EXTERNAL_AGENTS` object (grep `const DEFAULT_EXTERNAL_AGENTS = {`) with — commands verified against the installed CLIs on 2026-08-18:

```js
// `template` is the one-shot delegation form (existing behaviour). The terminal
// fields are what a live attached session needs: `interactive` starts a TUI,
// `newIdFlag` pins the conversation id we generate so a later resume is exact,
// `resume`/`resumeLast` restore after a host reboot or a reap.
const DEFAULT_EXTERNAL_AGENTS = {
  claude:   { label: 'Claude Code',    interactive: 'claude',   newIdFlag: '--session-id {sid}', resume: 'claude --resume {sid}', resumeLast: 'claude --continue' },
  codex:    { label: 'OpenAI Codex',   template: 'codex {prompt}',        interactive: 'codex',    resume: 'codex resume {sid}',   resumeLast: 'codex resume --last' },
  agy:      { label: 'Antigravity CLI', template: 'agy -i {prompt}',      interactive: 'agy',      resume: 'agy --conversation {sid}', resumeLast: 'agy --continue' },
  opencode: { label: 'opencode',       template: 'opencode run {prompt}', interactive: 'opencode', resume: 'opencode -s {sid}',    resumeLast: 'opencode -c' },
};
```

- [ ] **Step 6: Use the tested merge in `loadConfig`**

Replace the hand-rolled merge loop (grep `// Merge-in default external agents`) with a call to the tested helper:

```js
  // Merge-in default external agents (skip explicitly removed ones)
  const merged = mergeAgentDefaults(c, DEFAULT_EXTERNAL_AGENTS);
  if (merged.dirty) dirty = true;
```

- [ ] **Step 7: Verify against the real config**

```bash
cp config.json /tmp/config.json.bak
node -e "require('./server.js')" & sleep 3; kill %1
node -e "const c=require('./config.json'); console.log(JSON.stringify(c.externalAgents,null,2))"
```

Expected: every agent has `interactive`; `codex`/`agy`/`opencode` keep their original `template`; a `claude` entry now exists.
Restore if anything looks wrong: `cp /tmp/config.json.bak config.json`

- [ ] **Step 8: Commit**

```bash
git add server.js terminal-session.js test/terminal-session.test.js
git commit -m "feat(terminal): interactive + resume commands for external agents"
```

---

### Task 3: Schema and session-creation API

**Files:**
- Modify: `server.js` (grep anchor `ALTER TABLE sessions ADD COLUMN transcript_offset`)
- Modify: `server.js` (grep anchor `createSession: db.prepare(`)
- Modify: `server.js` (grep anchor `app.post('/api/sessions', (req, res) => {`)
- Create: `test/terminal-schema.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `supportsTerminal` from Task 1.
- Produces: `sessions.kind` (`'chat'` default), `sessions.terminal_agent`, `sessions.agent_conv_id`; `POST /api/sessions` accepting `{kind, terminalAgent}`; prepared statement `stmts.setAgentConvId`.

- [ ] **Step 1: Write the failing test**

Create `test/terminal-schema.test.js`:

```js
// Verifies the terminal-session columns are added idempotently and defaults are sane.
// Run: node test/terminal-schema.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const openDatabase = require('../db-adapter');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const dbPath = path.join(os.tmpdir(), `ccs-schema-test-${Date.now()}.db`);
const db = openDatabase(dbPath);
db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)`);

// The exact statements server.js runs — copy any change here into server.js too.
const MIGRATIONS = [
  `ALTER TABLE sessions ADD COLUMN kind TEXT DEFAULT 'chat'`,
  `ALTER TABLE sessions ADD COLUMN terminal_agent TEXT`,
  `ALTER TABLE sessions ADD COLUMN agent_conv_id TEXT`,
];
function migrate() { for (const sql of MIGRATIONS) { try { db.exec(sql); } catch {} } }

migrate();
const cols = db.prepare(`SELECT * FROM pragma_table_info('sessions')`).all().map(r => r.name);
check('kind added', cols.includes('kind'), true);
check('terminal_agent added', cols.includes('terminal_agent'), true);
check('agent_conv_id added', cols.includes('agent_conv_id'), true);

migrate(); // second run must not throw and must not duplicate
const cols2 = db.prepare(`SELECT * FROM pragma_table_info('sessions')`).all().map(r => r.name);
check('migration is idempotent', cols2.length, cols.length);

db.prepare(`INSERT INTO sessions (id,title) VALUES (?,?)`).run('s1', 'legacy row');
check('existing rows default to chat', db.prepare(`SELECT kind FROM sessions WHERE id=?`).get('s1').kind, 'chat');

try { fs.unlinkSync(dbPath); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/terminal-schema.test.js`
Expected: FAIL — `kind added` fails, because the migration list is only in the test so far; if `db-adapter` resolves, the failure is the assertion, not a crash. (If it crashes on `openDatabase`, install the optional dep first: `npm install`.)

- [ ] **Step 3: Add the migrations to `server.js`**

Immediately after the `transcript_offset` migration line, add:

```js
// Terminal sessions: kind is fixed at creation and never switched — a session is
// either driven by the chat engine or by a human in a terminal, never both.
try { db.exec(`ALTER TABLE sessions ADD COLUMN kind TEXT DEFAULT 'chat'`); } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN terminal_agent TEXT`); } catch {}   // external-agent id, e.g. 'claude'
try { db.exec(`ALTER TABLE sessions ADD COLUMN agent_conv_id TEXT`); } catch {}    // the agent's own conversation id, for exact resume
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/terminal-schema.test.js`
Expected: `5 passed, 0 failed`

- [ ] **Step 5: Accept `kind` at session creation**

Add a prepared statement next to `createSession` (do NOT change `createSession` itself — it is called from eight places):

```js
  createTerminalSession: db.prepare(`INSERT INTO sessions (id,title,active_mcp,active_skills,mode,agent_mode,model,workdir,kind,terminal_agent,agent_conv_id) VALUES (?,?,'[]','[]','auto','single',?,?,'terminal',?,?)`),
  setAgentConvId: db.prepare(`UPDATE sessions SET agent_conv_id=? WHERE id=?`),
```

Then extend `POST /api/sessions`:

```js
app.post('/api/sessions', (req, res) => {
  const { title = i18nSession(), workdir = null, model = 'sonnet', mode = 'auto', agentMode = 'single', kind = 'chat', terminalAgent = null } = req.body || {};
  const id = genId();
  if (kind === 'terminal') {
    // loadConfig(), NOT loadMergedConfig(): the merged view is a whitelist of
    // mcpServers/skills/slashCommands/lang/defaultEngine/recentProjectsCount and
    // does NOT carry externalAgents — same reason /api/external-agents reads
    // loadConfig(). Using the merged view here silently 400s every request.
    const agents = loadConfig().externalAgents || {};
    if (!terminalAgent || !supportsTerminal(agents[terminalAgent])) {
      return res.status(400).json({ error: 'terminalAgent must name an agent with an "interactive" command' });
    }
    // Pin the conversation id up front when the agent supports it (claude --session-id),
    // so a later restore resumes THIS conversation instead of "the most recent one".
    const convId = resolveAgentCommands(agents[terminalAgent]).newIdFlag ? crypto.randomUUID() : null;
    stmts.createTerminalSession.run(id, String(title).substring(0, 200), sqlVal(model), sqlVal(workdir) || null, terminalAgent, convId);
    return res.json(stmts.getSession.get(id));
  }
  stmts.createSession.run(id, String(title).substring(0, 200), '[]', '[]', sqlVal(mode), sqlVal(agentMode), sqlVal(model), sqlVal(workdir) || null);
  res.json(stmts.getSession.get(id));
});
```

- [ ] **Step 6: Verify by hand**

```bash
npm run dev &
sleep 3
curl -s -X POST localhost:3000/api/sessions -H 'content-type: application/json' \
  -d '{"kind":"terminal","terminalAgent":"claude","title":"term test"}' | head -c 400
curl -s -X POST localhost:3000/api/sessions -H 'content-type: application/json' \
  -d '{"kind":"terminal","terminalAgent":"nope"}' | head -c 200
kill %1
```

Expected: the first returns a session with `"kind":"terminal"`, `"terminal_agent":"claude"` and a UUID in `agent_conv_id`; the second returns HTTP 400 with the `terminalAgent must name…` error.

- [ ] **Step 7: Add the suite to `npm test` and commit**

Append `&& node test/terminal-schema.test.js` to the `test` script, then:

```bash
npm test
git add server.js test/terminal-schema.test.js package.json
git commit -m "feat(terminal): session kind, agent and conversation id columns"
```

---

### Task 4: tmux bridge

**Files:**
- Create: `terminal-bridge.js`
- Create: `test/terminal-bridge.integration.test.js`

**Interfaces:**
- Consumes: `tmuxNameFor`, `resolveState`, `resolveAgentCommands`, `buildLaunchCommand` from Task 1.
- Produces: `tmuxAvailable()`, `sessionInfo(name) -> {exists, paneDead, attached, activityAgeSec, ageSec}`, `paneHash(name) -> string|null`, `ensureSession({name, workdir, launchCommand}) -> 'attach'|'respawn'|'cold'`, `attach({name, cols, rows, onData, onExit}) -> handle{write,resize,close}`, `detachClients(name)`, `killSession(name)`, `listTerminalSessions() -> string[]`, `captureScreen(name) -> Buffer|null`, `decodeOutputPayload(str) -> Buffer`, `saveScrollback(name, file)`.

> **IMPLEMENTED — transport changed during execution.** The `script`-based PTY shim
> below does NOT work from Node (`script: tcgetattr/ioctl: Operation not supported on
> socket`): Node's `stdio: 'pipe'` allocates socketpairs, not real pipes. The shipped
> implementation uses **tmux control mode** (`tmux -C attach-session`) instead — see the
> rewritten "PTY transport" section of the spec and the header comment in
> `terminal-bridge.js`. Code blocks in this task are kept for the record but are
> superseded by the committed module.

- [ ] **Step 1: Write the failing integration test**

Create `test/terminal-bridge.integration.test.js`:

```js
// Integration test — needs a real tmux. Skips cleanly when tmux is unavailable.
// Run: node test/terminal-bridge.integration.test.js
const assert = require('assert');
const bridge = require('../terminal-bridge');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!bridge.tmuxAvailable()) {
    console.log('SKIP tmux-dependent checks — tmux not available on this host');
    process.exit(0);
  }
  const name = 'ccsterm-itest';
  bridge.killSession(name);

  check('cold start reports cold', bridge.ensureSession({ name, workdir: '/tmp', launchCommand: `sh -c 'while true; do echo tick; sleep 1; done'` }), 'cold');
  await sleep(1500);
  let info = bridge.sessionInfo(name);
  check('session exists after cold start', info.exists, true);
  check('nobody attached yet', info.attached, 0);
  check('pane alive', info.paneDead, false);

  // Attaching must deliver the program's output as bytes.
  let got = '';
  const h = bridge.attach({ name, cols: 80, rows: 24, onData: d => { got += d.toString('utf8'); }, onExit: () => {} });
  await sleep(1500);
  check('attach streams output', got.includes('tick'), true);
  check('attach registers a client', bridge.sessionInfo(name).attached, 1);

  // Closing the browser tab must not kill the agent.
  h.close();
  await sleep(1000);
  info = bridge.sessionInfo(name);
  check('closing the client leaves the session alive', info.exists, true);
  check('client count drops to zero', info.attached, 0);

  // The busy signal the reaper relies on.
  const a = bridge.paneHash(name); await sleep(3000); const b = bridge.paneHash(name);
  check('producing output changes the pane hash', a !== b, true);

  bridge.killSession(name);
  check('killSession removes it', bridge.sessionInfo(name).exists, false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/terminal-bridge.integration.test.js`
Expected: FAIL — `Cannot find module '../terminal-bridge'`

- [x] **Step 3: Implement `terminal-bridge.js`**

SUPERSEDED — the `script`-based implementation originally written here does not work
from Node (see the note at the top of this task). The shipped module uses tmux control
mode; read `terminal-bridge.js` in the repo root for the real code. Its header comment
records why `script` and `pipe-pane -IO` were both rejected. The public contract is
unchanged from what Task 5 consumes: `attach()` still returns `{write, resize, close}`
and still calls `onData(Buffer)` / `onExit()`.

- [ ] **Step 4: Run the integration test**

Run: `node test/terminal-bridge.integration.test.js`
Expected: `25 passed, 0 failed` on a host with tmux; the six pure decoder checks still run and the tmux-dependent ones SKIP without tmux.

Do NOT add this suite to `npm test` — it depends on tmux and takes ~8 s. Note it in the commit message as a manual suite.

- [ ] **Step 5: Commit**

```bash
git add terminal-bridge.js test/terminal-bridge.integration.test.js
git commit -m "feat(terminal): tmux bridge with script-based PTY attach

Manual suite (needs tmux): node test/terminal-bridge.integration.test.js"
```

- [ ] **Step 6: Add the bridge require to `server.js`**

Now that the module exists, add it next to the `terminal-session` require from Task 2:

```js
const termBridge = require('./terminal-bridge');
```

Run: `npm run dev` — the server must still boot cleanly (it does not use `termBridge` yet).

---

### Task 5: WebSocket route, safety gate and lifecycle cleanup

**Files:**
- Modify: `server.js` (grep anchors `server.on('upgrade'`, `app.get('/api/version'`, `killInteractiveTmux(id)`, and the server-start block)
- Create: nothing

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 4.
- Produces: `GET /api/terminal/capability -> {available, reason}`; WS endpoint `/ws/terminal?session=<id>`; startup cleanup; delete cleanup.

- [ ] **Step 1: Add the capability endpoint**

Next to the `/api/version` handler:

```js
// Capability-checked, never OS-sniffed — same pattern as tmuxAvailable for the
// subscription engine. Native Windows has neither tmux nor script and no ConPTY
// API in Node without a native module, so terminal sessions are simply unavailable
// there and the UI disables the entry point.
app.get('/api/terminal/capability', (_, res) => {
  const cfg = loadConfig();  // NOT loadMergedConfig: it whitelists fields and drops terminal/externalAgents
  const enabled = cfg.terminal?.enabled === true;
  const tmuxOk = termBridge.tmuxAvailable();
  const tunnelOn = tunnelManager?.getStatus?.()?.active === true;
  let reason = '';
  if (!enabled) reason = 'disabled in config (terminal.enabled)';
  else if (!tmuxOk) reason = 'tmux not found on this host';
  else if (tunnelOn) reason = 'a public tunnel is active — terminal access is blocked';
  res.json({ available: enabled && tmuxOk && !tunnelOn, reason });
});
```

Adjust `tunnelManager?.getStatus?.()` to the actual instance name — grep `new TunnelManager` in `server.js` and check the field name `getStatus()` returns for "running"; if it is not `active`, use whatever field it exposes.

- [ ] **Step 2: Route the WebSocket**

Create a second `WebSocketServer({ noServer: true })` next to the existing `wss`, then extend the upgrade handler (grep `server.on('upgrade'`) — keep the existing auth check exactly as it is and branch on pathname AFTER it:

```js
const wssTerm = new WebSocketServer({ noServer: true });
```

```js
  // ... existing token validation stays untouched ...
  const pathname = (() => { try { return new URL(req.url, 'http://x').pathname; } catch { return req.url; } })();
  if (pathname === '/ws/terminal') {
    wssTerm.handleUpgrade(req, socket, head, ws => wssTerm.emit('connection', ws, req));
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
```

- [ ] **Step 3: Implement the terminal connection handler**

```js
// Terminal WS protocol:
//   server → client: binary frames = raw PTY bytes; JSON text frames = control
//   client → server: {type:'input',data} | {type:'resize',cols,rows} | {type:'kill'}
wssTerm.on('connection', (ws, req) => {
  ws.on('error', (e) => { try { log.warn('terminal ws error', { msg: e?.message }); } catch {} });
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

  const cfg = loadConfig();  // NOT loadMergedConfig: it whitelists fields and drops terminal/externalAgents
  if (cfg.terminal?.enabled !== true) { send({ type: 'error', error: 'terminal sessions are disabled' }); return ws.close(); }
  if (tunnelManager?.getStatus?.()?.active === true) { send({ type: 'error', error: 'blocked while a public tunnel is active' }); return ws.close(); }
  if (!termBridge.tmuxAvailable()) { send({ type: 'error', error: 'tmux unavailable on this host' }); return ws.close(); }

  let sessionId = null;
  try { sessionId = new URL(req.url, 'http://x').searchParams.get('session'); } catch {}
  const session = sessionId ? stmts.getSession.get(sessionId) : null;
  if (!session || session.kind !== 'terminal') { send({ type: 'error', error: 'not a terminal session' }); return ws.close(); }

  const agents = loadConfig().externalAgents || {};
  const commands = resolveAgentCommands(agents[session.terminal_agent]);
  if (!commands.interactive) { send({ type: 'error', error: `agent "${session.terminal_agent}" has no interactive command` }); return ws.close(); }

  const name = tmuxNameFor(session.id);
  const existed = termBridge.hasSession(name);
  const launch = buildLaunchCommand({ commands, convId: session.agent_conv_id, isRestore: existed || !!session.agent_conv_id });
  const state = termBridge.ensureSession({ name, workdir: session.workdir || WORKDIR, launchCommand: launch });

  // Tell the UI what happened. A resumeLast restore is NOT guaranteed to be this
  // conversation — the user must see that distinction.
  send({
    type: 'ready',
    state,
    restoredExact: !!(session.agent_conv_id && commands.resume),
    agent: session.terminal_agent,
  });

  // Replay the scrollback captured before the last reap, if any.
  const sbFile = path.join(os.tmpdir(), `ccsterm-sb-${session.id}.txt`);
  if (state !== 'attach' && fs.existsSync(sbFile)) {
    try { ws.send(Buffer.from(fs.readFileSync(sbFile, 'utf8').replace(/\n/g, '\r\n') + '\r\n')); } catch {}
  }

  const handle = termBridge.attach({
    name, cols: 80, rows: 24,
    onData: (buf) => { try { ws.send(buf); } catch {} },
    onExit: () => { send({ type: 'exit' }); try { ws.close(); } catch {} },
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) { handle.write(raw); return; }
    let msg = null;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (msg.type === 'input') handle.write(msg.data);
    else if (msg.type === 'resize') handle.resize(msg.cols, msg.rows);
    else if (msg.type === 'kill') { termBridge.killSession(name); try { ws.close(); } catch {} }
  });

  // Closing the browser tab detaches the CLIENT only — the agent keeps working.
  ws.on('close', () => handle.close());
});
```

- [ ] **Step 4: Clean up orphaned clients at startup**

In the server-start block (grep `server.listen(`), after the listen callback logs:

```js
// `script` clients survive a studio restart and stay attached, which would pin
// session_attached above zero and stop the reaper from ever firing. Drop them all.
try {
  for (const name of termBridge.listTerminalSessions()) termBridge.detachClients(name);
} catch {}
```

- [ ] **Step 5: Kill the tmux session when the studio session is deleted**

At the delete handler (grep `killInteractiveTmux(id)`), add alongside it:

```js
  for (const id of ids) { try { termBridge.killSession(tmuxNameFor(id)); } catch {} }
```

- [ ] **Step 6: Add the config defaults**

Where config defaults are seeded (grep `defaultEngine`), add a `terminal` block if absent:

```js
  if (!c.terminal) { c.terminal = { enabled: false, idleTimeoutMin: 30, maxLive: 3 }; dirty = true; }
```

- [ ] **Step 7: Verify by hand**

```bash
npm run dev &
sleep 3
curl -s localhost:3000/api/terminal/capability
# expect {"available":false,"reason":"disabled in config (terminal.enabled)"}
node -e "const f='config.json';const c=require('./'+f);c.terminal={enabled:true,idleTimeoutMin:30,maxLive:3};require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
kill %1; npm run dev & sleep 3
curl -s localhost:3000/api/terminal/capability
# expect {"available":true,"reason":""}
SID=$(curl -s -X POST localhost:3000/api/sessions -H 'content-type: application/json' \
  -d '{"kind":"terminal","terminalAgent":"claude","title":"t"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).id")
echo "session=$SID"; tmux ls | grep ccsterm || echo "no tmux session yet (expected until a WS connects)"
kill %1
```

Expected: capability flips from unavailable to available; session creation returns an id. The tmux session appears only once a WebSocket connects (Task 7 provides the client; until then verify with `websocat` or the browser console).

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "feat(terminal): websocket endpoint, capability gate and lifecycle cleanup"
```

---

### Task 6: Reaper

**Files:**
- Modify: `server.js` (grep anchor `server.listen(`)
- Modify: `test/terminal-session.test.js` (append a section)

**Interfaces:**
- Consumes: `shouldReap` (Task 1), `sessionInfo`/`paneHash`/`saveScrollback`/`killSession` (Task 4).
- Produces: `startTerminalReaper({ intervalMs })` in `server.js`; `pickOverflow(sessions, maxLive) -> string[]` in `terminal-session.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/terminal-session.test.js`:

```js
const { pickOverflow } = require('../terminal-session');

console.log('live-session cap:');
const LIVE = [
  { name: 'ccsterm-a', attached: 0, activityAgeSec: 100 },
  { name: 'ccsterm-b', attached: 0, activityAgeSec: 900 },
  { name: 'ccsterm-c', attached: 1, activityAgeSec: 5000 },
  { name: 'ccsterm-d', attached: 0, activityAgeSec: 400 },
];
check('under the cap nothing is picked', pickOverflow(LIVE, 4), []);
check('picks the most idle unattached first', pickOverflow(LIVE, 3), ['ccsterm-b']);
check('never picks an attached session', pickOverflow(LIVE, 1), ['ccsterm-b', 'ccsterm-d', 'ccsterm-a']);
check('cap of zero still spares attached', pickOverflow(LIVE, 0), ['ccsterm-b', 'ccsterm-d', 'ccsterm-a']);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/terminal-session.test.js`
Expected: FAIL — `pickOverflow is not a function`

- [ ] **Step 3: Implement `pickOverflow`**

Add to `terminal-session.js` and its exports:

```js
// Which sessions to close when more are live than `maxLive`. Attached sessions are
// never candidates — someone is looking at them. The rest are ordered most-idle
// first, so the oldest untouched terminal goes first.
function pickOverflow(sessions, maxLive) {
  const list = Array.isArray(sessions) ? sessions : [];
  const cap = Number.isFinite(maxLive) ? Math.max(0, maxLive) : 3;
  const attached = list.filter(s => (s.attached || 0) > 0);
  const idle = list.filter(s => (s.attached || 0) === 0)
    .sort((a, b) => (b.activityAgeSec || 0) - (a.activityAgeSec || 0));
  const overflow = Math.max(0, list.length - cap);
  const closable = Math.min(overflow, idle.length);
  void attached;
  return idle.slice(0, closable).map(s => s.name);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/terminal-session.test.js`
Expected: all checks pass.

- [ ] **Step 5: Wire the reaper into `server.js`**

```js
// Terminal reaper. Agents are expensive (measured: opencode ~1.8 GB, claude ~1 GB);
// tmux itself is ~3.7 MB, so the target is the agent process.
//
// Order matters and every step is a short-circuit to "keep":
//   1. attached          — somebody is watching
//   2. session age       — never reap something just created
//   3. window_activity   — cheap idle filter (NOT session_activity: it does not move
//                          when the pane produces output)
//   4. pane hash x2      — the decisive busy check; a redrawing pane means the agent
//                          is working, and killing it could corrupt a half-written file
function startTerminalReaper({ intervalMs = 60000 } = {}) {
  if (!termBridge.tmuxAvailable()) return null;
  const tick = async () => {
    try {
      const cfg = loadConfig();  // NOT loadMergedConfig: it whitelists fields and drops terminal/externalAgents
      if (cfg.terminal?.enabled !== true) return;
      const idleThresholdSec = Math.max(60, (cfg.terminal?.idleTimeoutMin ?? 30) * 60);
      const maxLive = cfg.terminal?.maxLive ?? 3;

      const names = termBridge.listTerminalSessions();
      const live = names.map(name => ({ name, ...termBridge.sessionInfo(name) })).filter(s => s.exists);

      const candidates = new Set(pickOverflow(live, maxLive));
      for (const s of live) {
        if (candidates.has(s.name)) continue;
        if (isReapCandidate({ attached: s.attached, idleSec: s.activityAgeSec, sessionAgeSec: s.ageSec, idleThresholdSec })) {
          candidates.add(s.name);
        }
      }
      if (!candidates.size) return;

      // Busy check last: two capture-pane hashes 3 s apart. Identical → idle.
      const first = new Map();
      for (const name of candidates) first.set(name, termBridge.paneHash(name));
      await new Promise(r => setTimeout(r, 3000));
      for (const name of candidates) {
        const info = termBridge.sessionInfo(name);
        if (!info.exists || info.attached > 0) continue;  // someone connected meanwhile
        const decided = shouldReap({
          attached: info.attached, idleSec: info.activityAgeSec, sessionAgeSec: info.ageSec,
          paneHashA: first.get(name), paneHashB: termBridge.paneHash(name),
          idleThresholdSec,
          // An over-cap session is closed even though it may not be idle long enough —
          // the cap is the reason, the idle threshold is not.
          ...(pickOverflow(live, maxLive).includes(name) ? { idleThresholdSec: 0, minAgeSec: 0 } : {}),
        });
        if (!decided) continue;
        const sid = name.slice('ccsterm-'.length);
        termBridge.saveScrollback(name, path.join(os.tmpdir(), `ccsterm-sb-${sid}.txt`));
        termBridge.killSession(name);
        log.info('terminal session reaped', { name });
      }
    } catch (e) { log.warn('terminal reaper failed', { msg: e?.message }); }
  };
  return setInterval(tick, intervalMs);
}
```

Start it next to the startup cleanup from Task 5:

```js
startTerminalReaper({ intervalMs: 60000 });
```

- [ ] **Step 6: Verify the reaper end-to-end**

```bash
node -e "const f='config.json';const c=require('./'+f);c.terminal={enabled:true,idleTimeoutMin:1,maxLive:3};require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
tmux kill-session -t ccsterm-reaptest 2>/dev/null
tmux new-session -d -s ccsterm-reaptest "sleep 600"     # silent → must be reaped
tmux kill-session -t ccsterm-busytest 2>/dev/null
tmux new-session -d -s ccsterm-busytest "sh -c 'while true; do echo work; sleep 1; done'"  # noisy → must survive
npm run dev &
sleep 200
tmux ls | grep ccsterm
kill %1
```

Expected after ~3 minutes: `ccsterm-reaptest` is gone, `ccsterm-busytest` is still listed, and a scrollback file exists at `/tmp/ccsterm-sb-reaptest.txt`. Reset `idleTimeoutMin` to 30 afterwards.

- [ ] **Step 7: Commit**

```bash
npm test
git add server.js terminal-session.js test/terminal-session.test.js
git commit -m "feat(terminal): idle reaper with pane-hash busy check and live-session cap"
```

---

### Task 7: Browser terminal

**Files:**
- Create: `public/vendor/xterm.js`, `public/vendor/xterm.css`, `public/vendor/xterm-addon-fit.js`
- Modify: `public/index.html` (grep anchors `function newTab()`, `function switchTab(id)`, `applyTmuxCapability`, the i18n tables)

**Interfaces:**
- Consumes: `GET /api/terminal/capability`, `POST /api/sessions` with `{kind:'terminal', terminalAgent}`, WS `/ws/terminal?session=<id>`.
- Produces: `openTerminalSession(sessionId)`, `closeTerminalPane()`, global `_terminalAvailable`.

- [ ] **Step 1: Vendor xterm.js**

```bash
mkdir -p public/vendor
curl -fsSL https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js        -o public/vendor/xterm.js
curl -fsSL https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css       -o public/vendor/xterm.css
curl -fsSL https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js -o public/vendor/xterm-addon-fit.js
ls -la public/vendor
```

Expected: three files, `xterm.js` roughly 250-300 KB. These are plain static assets served by the existing Express static handler — no build step is introduced.

- [ ] **Step 2: Add the markup and styles**

In `public/index.html`, next to the other top-level panes, add:

```html
<link rel="stylesheet" href="/vendor/xterm.css">
<div id="termPane" style="display:none;position:absolute;inset:0;background:#0b0b0f;z-index:5;flex-direction:column;">
  <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.08);">
    <span id="termDot" style="width:8px;height:8px;border-radius:50%;background:#3fb950;flex-shrink:0;"></span>
    <span id="termTitle" style="font-size:12px;opacity:.8;"></span>
    <span id="termState" style="font-size:11px;opacity:.55;"></span>
    <span style="flex:1"></span>
    <button id="termKillBtn" style="font-size:11px;padding:2px 8px;border-radius:4px;background:transparent;border:1px solid rgba(255,255,255,.15);cursor:pointer;"></button>
  </div>
  <div id="termHost" style="flex:1;min-height:0;"></div>
</div>
<script src="/vendor/xterm.js"></script>
<script src="/vendor/xterm-addon-fit.js"></script>
```

- [ ] **Step 3: Add the client logic**

```js
let _terminalAvailable = false, _term = null, _termFit = null, _termWs = null, _termSessionId = null;

async function loadTerminalCapability() {
  try {
    const r = await fetch('/api/terminal/capability', { headers: authHeaders() });
    const j = await r.json();
    _terminalAvailable = !!j.available;
    const btn = document.getElementById('newTerminalBtn');
    if (btn) { btn.disabled = !_terminalAvailable; btn.title = j.reason || ''; btn.style.opacity = _terminalAvailable ? '' : '.4'; }
  } catch { _terminalAvailable = false; }
}

async function createTerminalSession(agentId) {
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ kind: 'terminal', terminalAgent: agentId, title: `${agentId} terminal` }),
  });
  if (!r.ok) { alert(t('term.createFailed')); return; }
  const s = await r.json();
  await loadHist();
  openTerminalSession(s.id, agentId);
}

function openTerminalSession(sessionId, agentLabel) {
  closeTerminalPane();
  _termSessionId = sessionId;
  const pane = document.getElementById('termPane');
  pane.style.display = 'flex';
  document.getElementById('termTitle').textContent = agentLabel || '';
  document.getElementById('termKillBtn').textContent = t('term.kill');

  _term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: { background: '#0b0b0f' }, cursorBlink: true, scrollback: 10000 });
  _termFit = new FitAddon.FitAddon();
  _term.loadAddon(_termFit);
  _term.open(document.getElementById('termHost'));
  _termFit.fit();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _termWs = new WebSocket(`${proto}//${location.host}/ws/terminal?session=${encodeURIComponent(sessionId)}`);
  _termWs.binaryType = 'arraybuffer';

  _termWs.onopen = () => sendTermResize();
  _termWs.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { _term.write(new Uint8Array(ev.data)); return; }
    let msg = null; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'ready') {
      // A restore without an exact conversation id resumed "the agent's most recent
      // conversation", which may not be this one — say so instead of implying it is.
      const key = msg.state === 'attach' ? 'term.state.attached'
        : msg.restoredExact ? 'term.state.restored' : 'term.state.restoredLast';
      document.getElementById('termState').textContent = t(key);
      document.getElementById('termDot').style.background = '#3fb950';
    } else if (msg.type === 'exit') {
      document.getElementById('termDot').style.background = '#8b949e';
      document.getElementById('termState').textContent = t('term.state.exited');
    } else if (msg.type === 'error') {
      _term.write(`\r\n\x1b[31m${msg.error}\x1b[0m\r\n`);
      document.getElementById('termDot').style.background = '#f85149';
    }
  };
  _termWs.onclose = () => { document.getElementById('termDot').style.background = '#8b949e'; };

  _term.onData(d => { if (_termWs?.readyState === 1) _termWs.send(JSON.stringify({ type: 'input', data: d })); });
  window.addEventListener('resize', sendTermResize);
  document.getElementById('termKillBtn').onclick = () => {
    if (!confirm(t('term.killConfirm'))) return;
    if (_termWs?.readyState === 1) _termWs.send(JSON.stringify({ type: 'kill' }));
    closeTerminalPane();
  };
}

function sendTermResize() {
  if (!_term || !_termFit) return;
  _termFit.fit();
  if (_termWs?.readyState === 1) _termWs.send(JSON.stringify({ type: 'resize', cols: _term.cols, rows: _term.rows }));
}

function closeTerminalPane() {
  window.removeEventListener('resize', sendTermResize);
  try { _termWs?.close(); } catch {}
  try { _term?.dispose(); } catch {}
  _termWs = null; _term = null; _termFit = null; _termSessionId = null;
  const pane = document.getElementById('termPane');
  if (pane) pane.style.display = 'none';
}
```

- [ ] **Step 4: Wire the entry points**

1. Call `loadTerminalCapability()` where `applyTmuxCapability` is called (grep `applyTmuxCapability`).
2. Add a `+ Terminal` button next to the new-chat control that opens a small agent picker built from `GET /api/external-agents` (offer only agents whose `interactive` field is set) and calls `createTerminalSession(id)`.
3. In `switchTab(id)` and wherever a session is opened from the history list, check the session's `kind`: if `'terminal'`, call `openTerminalSession(session.id, session.terminal_agent)` and return early instead of rendering the chat pane; otherwise call `closeTerminalPane()` first so switching back to a chat hides the terminal.
4. In the sessions list renderer, show a `▮` marker for `kind === 'terminal'` rows.

- [ ] **Step 5: Add the i18n strings**

Add to every language table already present in `public/index.html` (English values shown; translate for the others, Ukrainian included):

```
'term.kill': 'Kill',
'term.killConfirm': 'Kill this terminal session? The conversation can be resumed later.',
'term.createFailed': 'Could not create the terminal session',
'term.state.attached': 'attached',
'term.state.restored': 'restored',
'term.state.restoredLast': 'restored the agent\'s last conversation',
'term.state.exited': 'agent exited',
```

- [ ] **Step 6: Verify in the browser**

```bash
npm run dev
```

Then in the browser at `http://localhost:3000`:
1. `+ Terminal` → pick Claude Code → the TUI appears and accepts typing.
2. Resize the window → the TUI reflows, no scrambled output.
3. Reload the page → the same session reattaches with its content intact.
4. `kill %1` the studio, `npm run dev` again, reopen the session → still attaches (tmux survived).
5. `tmux kill-server`, reopen the session → it comes back via resume, header shows `restored`.
6. Press Kill → the tmux session is gone (`tmux ls` shows no `ccsterm-*`).
7. Open a chat session → the terminal pane hides and chat works as before.
8. `curl -s localhost:3000/api/terminal/capability` with `terminal.enabled=false` → the button is disabled with the reason in its tooltip.

- [ ] **Step 7: Commit**

```bash
git add public/vendor public/index.html
git commit -m "feat(terminal): browser terminal pane with xterm.js"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Typed sessions (`kind`) | 3 |
| Three restore states | 1 (`resolveState`), 4 (`ensureSession`), 5 (WS handler) |
| Agent command matrix | 2 |
| Deterministic id via `newIdFlag` | 1, 3 |
| Reaper signals + order | 1 (`shouldReap`), 6 |
| Live-session cap | 1 (`pickOverflow`), 6 |
| Orphaned client cleanup | 5 |
| Scrollback preservation | 4 (`saveScrollback`), 5 (replay), 6 (capture before kill) |
| PTY transport (`TERM`, `window-size manual`, `remain-on-exit`) | 4 |
| Security (off by default, tunnel block, reused auth) | 5 |
| Platform capability flag | 5, 7 |
| Non-goal: chat import | not implemented, by design |

**Open items the executor must resolve, not guess:**

- `tunnelManager?.getStatus?.()?.active` — the field name is assumed. Grep `getStatus()` in `tunnel-manager.js` and use the real "running" field.
- `authHeaders()` in Task 7 assumes an existing helper in `public/index.html`. If the SPA sends the auth cookie implicitly, drop the header spread.
- The `+ Terminal` entry point placement is described, not pinned to a line — `public/index.html` is a single 9000-line file and the exact insertion point is the executor's call.
