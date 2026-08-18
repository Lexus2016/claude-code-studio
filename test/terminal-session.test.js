// Pure-logic verification for terminal-session.js (no test framework in this project).
// Run: node test/terminal-session.test.js
const assert = require('assert');
const {
  tmuxNameFor, isTerminalTmuxName, resolveState,
  resolveAgentCommands, supportsTerminal, buildLaunchCommand,
  isReapCandidate, shouldReap, parseNewIdOutput,
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
check('reads every command field', resolveAgentCommands(CLAUDE), { interactive: 'claude', newIdFlag: '--session-id {sid}', newIdCommand: null, resume: 'claude --resume {sid}', resumeLast: 'claude --continue' });
check('missing fields become null', resolveAgentCommands(DELEGATE_ONLY), { interactive: null, newIdFlag: null, newIdCommand: null, resume: null, resumeLast: null });
check('blank strings become null', resolveAgentCommands({ interactive: '   ' }), { interactive: null, newIdFlag: null, newIdCommand: null, resume: null, resumeLast: null });
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

console.log('new-conversation id from a CLI that mints it:');
check('bare uuid is accepted', parseNewIdOutput('96357f0d-4ea3-404a-88f5-57555c2dafb2\n'), '96357f0d-4ea3-404a-88f5-57555c2dafb2');
check('banner lines are skipped, last line wins', parseNewIdOutput('Logging in...\nok\nabc123def456\n'), 'abc123def456');
check('an error sentence is rejected', parseNewIdOutput('Error: not logged in'), null);
check('empty output is rejected', parseNewIdOutput(''), null);
check('whitespace-only is rejected', parseNewIdOutput('   \n\n'), null);
check('a too-short token is rejected', parseNewIdOutput('ok'), null);
check('a path is rejected', parseNewIdOutput('/tmp/some/file'), null);
check('newIdCommand is read from config', resolveAgentCommands({ interactive: 'x', newIdCommand: 'x create-chat' }).newIdCommand, 'x create-chat');

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

const { mergeAgentDefaults, pickOverflow } = require('../terminal-session');

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
check('a cap of zero still spares the attached one', pickOverflow(LIVE, 0), ['ccsterm-b', 'ccsterm-d', 'ccsterm-a']);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
