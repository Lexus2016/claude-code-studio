// GitHub #96 — "Interactive engine fails to start for any project with a large AGENTS.md".
//
// The subscription engine spawns its TUI with `tmux new-session -d … <command>`, and a
// tmux command travels to the tmux server over an imsg socket that caps the whole
// message at ~16 KB. The system prompt rode inside that command, so a project whose
// AGENTS.md was 25 KB (legal: agents-md.MAX_BYTES is 64 KB) could never start a
// session — tmux answered `command too long`, which was thrown away with stderr, and
// the user saw only "failed to start tmux session for interactive engine".
//
// What this suite pins:
//   1. tmuxLaunchCommand() hands tmux a PATH, never the prompt — bounded size whatever
//      the prompt weighs, written into a private 0700 dir with mode 0600.
//   2. The script is `sh`-shaped and `exec`s, so the pane's process is still `claude`.
//   3. End to end through a REAL tmux: a 40 KB prompt reaches the child's argv
//      byte-identical. This is the assertion the fix exists for.
//
// Run: node test/engine-spawn-cmd.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildInteractiveCommand, tmuxLaunchCommand } = require('../claude-interactive');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A prompt bigger than every tmux command limit, and bigger than the 25 KB AGENTS.md
// in the report. Non-ASCII on purpose: the same command carries the UTF-8 locale.
const BIG_PROMPT = 'AGENTS.md conventions — правило #' + 'x'.repeat(40000);

console.log('\n#96 — spawn command never carries the system prompt\n');

// ── 1. the pure builder ──────────────────────────────────────────────────────
const inner = buildInteractiveCommand({
  claudeBin: '/usr/local/bin/claude', idFlag: "--session-id 'abc'", modelAlias: 'sonnet',
  sp: BIG_PROMPT, mcpPath: null,
});
check('builder puts the prompt in the child argv', inner.includes(BIG_PROMPT), true);
check('builder keeps --dangerously-skip-permissions', inner.includes('--dangerously-skip-permissions'), true);
check('builder omits --mcp-config when there is none', inner.includes('--mcp-config'), false);
check('builder emits --mcp-config when there is one',
  buildInteractiveCommand({ claudeBin: 'claude', idFlag: '--resume x', modelAlias: 'opus', sp: '', mcpPath: '/tmp/m.json' })
    .includes("--mcp-config '/tmp/m.json'"), true);
check('builder omits --append-system-prompt for an empty prompt',
  buildInteractiveCommand({ claudeBin: 'claude', idFlag: '--resume x', modelAlias: 'opus', sp: '', mcpPath: null })
    .includes('--append-system-prompt'), false);

// ── 2. what tmux is actually handed ──────────────────────────────────────────
const launch = tmuxLaunchCommand(inner);
check('launch command does not contain the prompt', launch.includes(BIG_PROMPT), false);
// The measured tmux ceiling is ~16.3 KB; 1 KB leaves room for any tmpdir path and is
// still two orders of magnitude below it.
check('launch command stays under 1 KB for a 40 KB prompt', Buffer.byteLength(launch) < 1024, true);
check('launch command is `sh <path>`', /^sh '.*\/spawn-[0-9a-f]{16}\.sh'$/.test(launch), true);

const scriptPath = launch.slice(4, -1);
const body = fs.readFileSync(scriptPath, 'utf8');
check('script starts with a sh shebang', body.startsWith('#!/bin/sh\n'), true);
check('script execs, so the pane process stays `claude`', body.includes('\nexec env -u CLAUDECODE '), true);
check('script carries the prompt byte-identical', body.includes(BIG_PROMPT), true);
check('script mode is 0600', fs.statSync(scriptPath).mode & 0o777, 0o600);
check('script dir is 0700 — a shared /tmp path would be pre-creatable, and this is EXEC\'d',
  fs.statSync(path.dirname(scriptPath)).mode & 0o777, 0o700);
check('same command reuses the same script', tmuxLaunchCommand(inner), launch);
check('a different command gets a different script', tmuxLaunchCommand(inner + ' --x') !== launch, true);

// ── 3. end to end through a real tmux ────────────────────────────────────────
const SOCKET = 'ccs-test-spawn96';
const targs = a => ['-L', SOCKET, ...a];
function tmux(a) { return spawnSync('tmux', targs(a), { encoding: 'utf8' }); }
const haveTmux = (() => { const r = spawnSync('tmux', ['-V'], { encoding: 'utf8' }); return !r.error && r.status === 0; })();

(async () => {
  if (!haveTmux) {
    console.log('  skip tmux integration — tmux not installed');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-96-'));
    const dump = path.join(dir, 'argv.bin');
    // Fake `claude`: records its argv NUL-separated, then holds the pane open so the
    // session is still there to assert on. The argv is written to a temp file and
    // renamed into place: `> dump` creates the file before the first byte lands, and
    // the poll below reads as soon as the file EXISTS — under load that read a
    // truncated 40 KB argument. A rename makes the dump appear only when complete.
    const fakeClaude = path.join(dir, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done > "' + dump + '.tmp" && mv "' + dump + '.tmp" "' + dump + '"\nsleep 30\n', { mode: 0o755 });

    const realInner = buildInteractiveCommand({
      claudeBin: fakeClaude, idFlag: "--session-id 'e2e'", modelAlias: 'sonnet', sp: BIG_PROMPT, mcpPath: null,
    });

    // Informational control, NOT an assertion: the inline command is what shipped
    // before this fix. A tmux build that raised its imsg cap would make it pass and
    // that is not a defect — the script path is correct either way.
    const ctl = tmux(['new-session', '-d', '-s', 'ccs96ctl', '-c', dir, realInner]);
    console.log(`  info inline command (${Buffer.byteLength(realInner)} B) → ${(ctl.stderr || '').trim() || 'accepted'}`);
    tmux(['kill-session', '-t', 'ccs96ctl']);

    const r = tmux(['new-session', '-d', '-s', 'ccs96', '-x', '220', '-y', '50', '-c', dir, tmuxLaunchCommand(realInner)]);
    check('tmux accepted the launch command', (r.stderr || '').trim(), '');
    check('tmux session exists', tmux(['has-session', '-t', 'ccs96']).status, 0);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fs.existsSync(dump)) await sleep(50);
    let argv = [];
    if (fs.existsSync(dump)) {
      argv = fs.readFileSync(dump, 'utf8').split('\0');
      argv.pop(); // trailing NUL
    }
    const i = argv.indexOf('--append-system-prompt');
    check('child received --append-system-prompt', i >= 0, true);
    check('child received the 40 KB prompt byte-identical', i >= 0 ? argv[i + 1] : null, BIG_PROMPT);
    check('child still received --dangerously-skip-permissions', argv.includes('--dangerously-skip-permissions'), true);
    check('child still received the session id', argv.slice(0, 2), ['--session-id', 'e2e']);

    tmux(['kill-server']);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
