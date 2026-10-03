// First-run screens of the interactive TUI (claude-firstrun.js + the #20 detector).
//
// A `claude` that has never been opened on a machine — every fresh Docker container —
// stops on up to three screens before its input box: the theme picker, "do you trust
// this folder?" and the Bypass Permissions warning. None is numbered, so the detector
// missed all three; two open with the caret on "No, exit", so the engine's paste +
// Enter quit `claude` and the message was lost. The fixtures under
// test/fixtures/claude-tui/ are those screens captured from CLI 2.1.288.
//
//   1. DETECT  — the real screens read as blocked; a ready pane (input box between two
//                rules), one holding typed text, and one with carets in its history do not.
//   2. SEED    — planFirstRunSeed is pure and minimal; seedClaudeFirstRun writes only
//                when something is missing, never a file it could not parse, atomically.
//   3. ENGINE  — runInteractiveSingle against a fake `claude` that draws the trust screen:
//                the config is seeded before the spawn, --settings reaches the argv, and
//                a screen still up after the wait is reported, NEVER pasted into.
//
// Run: node test/claude-firstrun.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-firstrun-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.local', 'bin'), { recursive: true });
// Before the require: the engine reads both at module load / call time.
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_STARTUP_PROMPT_WAIT_MS = '3000';

const FR = require('../claude-firstrun');
const CI = require('../claude-interactive');
const { TMUX_SOCKET } = require('../terminal-bridge');
const fixture = n => fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-tui', n === 'askuserquestion' ? `${n}.txt` : `firstrun-${n}.txt`), 'utf8');

let engineSession = null;
function cleanup() {
  if (engineSession) spawnSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', CI.tmuxName(engineSession)], { stdio: 'ignore' });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

(async () => {
  console.log('1. the real first-run screens read as blocked');
  for (const n of ['theme', 'trust', 'bypass']) check(`${n} screen is a pending prompt`, CI.paneAwaitingInput(fixture(n)), true);
  const ready = fixture('ready');
  check('a ready pane is NOT a prompt', CI.paneAwaitingInput(ready), false);
  check('…nor is one with a draft typed in its input box',
    CI.paneAwaitingInput(ready.replace(/^❯$/m, '❯ fix the failing test\n  and add a regression test for it')), false);
  // Past prompts and quoted carets sit ABOVE the input box; it stays the last caret line.
  const history = ['❯ add a flag', '  that turns it off', '', '⏺ Done — added it.', '  › note: the default is on', ''].join('\n');
  check('carets in the history above the input box are NOT a prompt', CI.paneAwaitingInput(history + ready), false);
  check('a lone caret line with no sibling option is NOT a prompt', CI.paneAwaitingSelection('some text\n❯ No, exit\n'), false);
  // From the review: a draft can itself quote a caret, with continuation lines that look
  // like sibling options. Inside the input box's frame it is the box, not a dialog.
  check('a draft quoting "❯ npm test" inside the input box is NOT a prompt',
    CI.paneAwaitingInput(ready.replace(/^❯$/m, '❯ review this captured output:\n  ❯ npm test\n    tests passed')), false);
  check('the numbered #20 widget is still recognised', CI.paneAwaitingInput('❯ 1. Yes\n  2. No'), true);
  // Captured from a real AskUserQuestion: it is framed by two rules exactly like the
  // input box, so "between two rules" cannot be what marks the input box.
  check('a real AskUserQuestion widget (rule-framed) is a pending prompt', CI.paneAwaitingInput(fixture('askuserquestion')), true);
  check('a numbered list TYPED into the input box is NOT a prompt',
    CI.paneAwaitingInput(ready.replace(/^❯$/m, '❯ 1. Fix tests\n  2. Add docs')), false);
  check('a draft long enough to push the box\'s top rule out of the tail is NOT a prompt',
    CI.paneAwaitingInput(ready.replace(/^❯$/m, '❯ start\n' + Array.from({ length: 25 }, (_, i) => `  line ${i}`).join('\n') + '\n  ❯ npm test\n    tests passed')), false);

  console.log('\n2. seeding the CLI config');
  const dir = '/srv/project/a';
  check('an empty config gets onboarding, a theme and trust for the dir',
    FR.planFirstRunSeed({}, dir), { hasCompletedOnboarding: true, theme: 'dark', projects: { [dir]: { hasTrustDialogAccepted: true } } });
  check('a complete config needs nothing',
    FR.planFirstRunSeed({ hasCompletedOnboarding: true, theme: 'light', projects: { [dir]: { hasTrustDialogAccepted: true } } }, dir), null);
  // Measured: a trusted parent does NOT cover a child that is its own git repository,
  // and every session worktree is one. So only the dir's own key decides.
  check('a trusted ANCESTOR does not stop the seed (the CLI stops at git roots)',
    FR.planFirstRunSeed({ hasCompletedOnboarding: true, theme: 'dark', projects: { '/srv': { hasTrustDialogAccepted: true } } }, dir)?.projects?.[dir],
    { hasTrustDialogAccepted: true });
  const decomposed = '/srv/cafe\u0301';
  check('a non-NFC path is trusted under both spellings, as the CLI writes it',
    Object.keys(FR.planFirstRunSeed({ hasCompletedOnboarding: true, theme: 'dark' }, decomposed).projects).sort(),
    [decomposed, decomposed.normalize('NFC')].sort());
  const keep = { hasCompletedOnboarding: true, theme: 'light', mcpServers: { x: { command: 'y' } }, projects: { [dir]: { allowedTools: ['Bash'] }, '/other': { a: 1 } } };
  const planned = FR.planFirstRunSeed(keep, dir);
  check('only the trust key is added; the theme the user chose and every other key stay',
    planned, { ...keep, projects: { [dir]: { allowedTools: ['Bash'], hasTrustDialogAccepted: true }, '/other': { a: 1 } } });
  check('the input object is not mutated', keep.projects[dir], { allowedTools: ['Bash'] });
  check('the config path follows CLAUDE_CONFIG_DIR', FR.claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: '/c', HOME: '/h' }), path.join('/c', '.claude.json'));
  check('…resolved to an absolute path once (the pane runs in another cwd)',
    path.isAbsolute(FR.claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: 'rel-config', HOME: '/h' })), true);
  check('…and is ~/.claude.json otherwise', FR.claudeGlobalConfigPath({ HOME: '/h' }), path.join('/h', '.claude.json'));

  const work = fs.mkdtempSync(path.join(TMP, 'work-'));
  const realWork = fs.realpathSync.native(work);
  const cfg = path.join(TMP, 'cfg', '.claude.json');
  check('a missing config is created', FR.seedClaudeFirstRun({ workdir: work, configPath: cfg, env: {} }).changed, true);
  const created = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  check('…keyed by the REAL path of the workdir', created.projects[realWork], { hasTrustDialogAccepted: true });
  if (process.platform !== 'win32') check('…at mode 0600', fs.statSync(cfg).mode & 0o777, 0o600);
  const before = fs.statSync(cfg).mtimeMs;
  await sleep(20);
  check('a second start writes nothing', FR.seedClaudeFirstRun({ workdir: work, configPath: cfg, env: {} }).changed, false);
  check('…and leaves the file untouched', fs.statSync(cfg).mtimeMs, before);
  fs.writeFileSync(cfg, '{"projects": {');
  const broken = FR.seedClaudeFirstRun({ workdir: work, configPath: cfg, env: {} });
  check('a config that does not parse is refused', [broken.changed, /not valid JSON/.test(broken.reason)], [false, true]);
  check('…and left byte-for-byte as found', fs.readFileSync(cfg, 'utf8'), '{"projects": {');
  fs.writeFileSync(cfg, '  \n');
  check('an EMPTY existing file is refused (a writer caught mid-save looks like that)',
    [FR.seedClaudeFirstRun({ workdir: work, configPath: cfg, env: {} }).changed, fs.readFileSync(cfg, 'utf8')], [false, '  \n']);
  if (process.platform !== 'win32') {
    // A symlinked config keeps its link; the file it points at is the one seeded.
    const shared = path.join(TMP, 'shared.json');
    fs.writeFileSync(shared, '{"keep":1}');
    const link = path.join(TMP, 'link', '.claude.json');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(shared, link);
    FR.seedClaudeFirstRun({ workdir: work, configPath: link, env: {} });
    check('a symlinked config stays a symlink', fs.lstatSync(link).isSymbolicLink(), true);
    check('…and its target is what got seeded', JSON.parse(fs.readFileSync(shared, 'utf8')).keep === 1 && JSON.parse(fs.readFileSync(shared, 'utf8')).hasCompletedOnboarding, true);
    // The umask must not narrow an existing mode.
    const grp = path.join(TMP, 'grp', '.claude.json');
    fs.mkdirSync(path.dirname(grp), { recursive: true });
    fs.writeFileSync(grp, '{}'); fs.chmodSync(grp, 0o640);
    const old = process.umask(0o077);
    try { FR.seedClaudeFirstRun({ workdir: work, configPath: grp, env: {} }); } finally { process.umask(old); }
    check('an existing 0640 survives a 077 umask', fs.statSync(grp).mode & 0o777, 0o640);
    const dangling = path.join(TMP, 'dangle', '.claude.json');
    fs.mkdirSync(path.dirname(dangling), { recursive: true });
    fs.symlinkSync(path.join(TMP, 'nowhere.json'), dangling);
    const d = FR.seedClaudeFirstRun({ workdir: work, configPath: dangling, env: {} });
    check('a DANGLING symlinked config is refused, not replaced',
      [d.changed, /dangling/.test(d.reason), fs.lstatSync(dangling).isSymbolicLink()], [false, true, true]);
  }

  // The bind-mount path, driven directly (EBUSY cannot be produced portably).
  const ip = path.join(TMP, 'inplace', '.claude.json');
  fs.mkdirSync(path.dirname(ip), { recursive: true });
  const oldBak = `${ip}.ccs-backup-earlier`;
  fs.writeFileSync(oldBak, 'an earlier recovery copy');
  fs.writeFileSync(ip, JSON.stringify({ written: 'by a live claude after our first read' }));
  const realWrite = fs.writeSync;
  let calls = 0;
  fs.writeSync = (fd, buf, off, len, pos) => (++calls === 1 ? realWrite(fd, buf, off, Math.ceil(len / 2), pos) : realWrite(fd, buf, off, len, pos));
  let ipr;
  try { ipr = FR._writeInPlace(ip, '/srv/inplace'); } finally { fs.writeSync = realWrite; }
  let ipCfg = null; try { ipCfg = JSON.parse(fs.readFileSync(ip, 'utf8')); } catch {}
  check('a SHORT write is completed, not truncated into broken JSON', [ipr.changed, !!ipCfg, calls > 1], [true, true, true]);
  check('the in-place path plans from the file as it is NOW', ipCfg && ipCfg.written, 'by a live claude after our first read');
  check('an earlier recovery backup is never overwritten', fs.readFileSync(oldBak, 'utf8'), 'an earlier recovery copy');
  check('its own backup is removed after success', fs.readdirSync(path.dirname(ip)).filter(f => f.includes('ccs-backup') && f !== path.basename(oldBak)), []);
  check('CCS_CLAUDE_FIRSTRUN_SEED=0 turns it off', FR.seedClaudeFirstRun({ workdir: work, configPath: cfg, env: { CCS_CLAUDE_FIRSTRUN_SEED: '0' } }).reason, 'disabled');
  check('no temp file is left behind', fs.readdirSync(path.dirname(cfg)).filter(f => f.endsWith('.tmp')), []);

  console.log('\n3. the engine against a fake `claude` that stops on the trust screen');
  if (!CI.tmuxAvailable()) {
    console.log('  SKIP — tmux not available on this host');
  } else {
    const screen = path.join(TMP, 'screen.txt');
    fs.writeFileSync(screen, fixture('trust'));
    const argvDump = path.join(TMP, 'argv.txt');
    const received = path.join(TMP, 'received.txt');
    // Draws the screen, records its argv, then records everything typed or pasted into it.
    fs.writeFileSync(path.join(HOME, '.local', 'bin', 'claude'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvDump}'\nprintf '%s' "$HOME" > '${argvDump}.home'\ncat '${screen}'\nstty raw -echo 2>/dev/null\nexec cat > '${received}'\n`, { mode: 0o755 });
    const proj = fs.mkdtempSync(path.join(TMP, 'proj-'));
    engineSession = `frtest${process.pid}`;
    const frames = [];
    const ws = { send: s => frames.push(JSON.parse(s)) };
    // A bound, so a regression that pastes and then waits on a transcript fails here by
    // NAME instead of hanging the suite until the engine's own idle watchdog.
    const ac = new AbortController();
    const guard = setTimeout(() => ac.abort(), 20000);
    const r = await CI.runInteractiveSingle({ prompt: 'please do the thing', model: 'sonnet', mode: 'auto', ws, sessionId: engineSession, workdir: proj, abortController: ac });
    clearTimeout(guard);
    const cfgFile = path.join(HOME, '.claude.json');
    const seeded = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : { projects: {} };
    check('the CLI config was seeded before the spawn',
      [seeded.hasCompletedOnboarding, seeded.projects[fs.realpathSync.native(proj)]], [true, { hasTrustDialogAccepted: true }]);
    const argv = fs.existsSync(argvDump) ? fs.readFileSync(argvDump, 'utf8').split('\n') : [];
    const si = argv.indexOf('--settings');
    check('--settings reaches the child argv byte-identical', si >= 0 ? argv[si + 1] : null, FR.SKIP_BYPASS_WARNING_SETTINGS);
    check('the browser was told the turn is blocked', frames.some(f => f.type === 'input_needed' && f.phase === 'startup'), true);
    const err = frames.find(f => f.type === 'error');
    check('a screen still up after the wait is reported with the screen', !!err && /waiting on a screen/.test(err.error) && /Yes, I trust this folder/.test(err.error), true);
    check('the turn ends incomplete', r.completed, false);
    check('the pane runs on the HOME the seed wrote into (the tmux server env cannot override it)',
      fs.existsSync(argvDump + '.home') ? fs.readFileSync(argvDump + '.home', 'utf8') : null, HOME);
    await sleep(500);
    check('NOTHING was pasted into the widget', fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '', '');

    // From the review: Stop pressed DURING the wait used to fall through to the paste.
    // The pane from the run above is still up on the same screen — the reused-pane path.
    fs.writeFileSync(received, '');
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 800);
    const frames2 = [];
    const r2 = await CI.runInteractiveSingle({ prompt: 'second message', model: 'sonnet', mode: 'auto', ws: { send: x => frames2.push(JSON.parse(x)) }, sessionId: engineSession, claudeSessionId: r.cid, workdir: proj, abortController: ac2 });
    await sleep(500);
    check('Stop during the wait ends the turn', r2.completed, false);
    check('…and pastes NOTHING into the dialog', fs.readFileSync(received, 'utf8'), '');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e.stack || e); process.exit(1); });
