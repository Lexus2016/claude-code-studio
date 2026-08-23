// The remote non-interactive PATH — issue #59.
//
// The reported failure: a SessionEnd hook on an SSH project dies with
// `/bin/sh: 1: node: not found` on a host where `which node` answers instantly. Cause
// is not Node — it is that `bash -lc` is a LOGIN shell, not an INTERACTIVE one, and
// every version manager (mise, asdf, nvm, pyenv, …) publishes its binaries from
// ~/.bashrc, which returns early when `$-` has no `i`.
//
// These run against REAL bash rather than asserting on the generated string, because
// every bug this fix can reintroduce is a shell bug, not a JavaScript one:
//   - a `for … ; do; …` that does not parse (the first draft had exactly that);
//   - a prelude that ends on a false test, which silently swallows the ` && claude …`
//     the caller chains behind it — the run would just never start;
//   - a prelude that PRINTS, which derails the stream-json parser reading that stdout.
//
// Run: node test/remote-env.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { remoteEnvPrelude, remoteEnvProbeCommand, parseRemoteEnvProbe, SHIM_DIRS } = require('../remote-env');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// `bash -lc` — the same invocation claude-ssh.js uses, so a login-shell-only failure
// shows up here too instead of passing under a plain `sh -c`.
function bash(script, env) {
  try {
    return execFileSync('bash', ['-lc', script], {
      encoding: 'utf-8',
      env: { ...process.env, ...(env || {}) },
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return `__EXIT_${e.status}__` + (e.stdout || '');
  }
}

const HAVE_BASH = (() => {
  try { execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

console.log('\n— the prelude is valid shell —');
if (!HAVE_BASH) {
  console.log('  SKIP — no bash on this machine');
} else {
  const p = remoteEnvPrelude();
  const tmp = path.join(os.tmpdir(), `ccs-prelude-${process.pid}.sh`);
  fs.writeFileSync(tmp, p + '\n');
  let parses = true;
  try { execFileSync('bash', ['-n', tmp], { stdio: 'ignore' }); } catch { parses = false; }
  fs.rmSync(tmp, { force: true });
  check('bash parses the prelude', parses, true);

  // THE chain-safety property. The caller writes `… && ${prelude} && claude …`, so a
  // prelude whose last statement is a failing `[ -d … ]` test does not "do nothing" —
  // it cancels the run behind it, with no error anywhere.
  check('a chained command still runs after it', bash(`${p} && echo NEXT`).trim(), 'NEXT');
  check('the prelude prints nothing on stdout', bash(p), '');

  // A user-supplied init command is arbitrary shell. A SYNTAX error in it must stay a
  // runtime eval failure — if it reached the parser it would take the whole remote
  // command with it, `claude` included.
  const broken = remoteEnvPrelude({ initCommand: 'if then fi ((' });
  check('a syntactically broken init command cannot break the chain',
    bash(`${broken} && echo NEXT`).trim(), 'NEXT');
  check('a broken init command still prints nothing', bash(broken), '');

  // It runs LAST, so it can override everything above it — that is the escape hatch
  // for a host whose version manager is not in the list.
  const withInit = remoteEnvPrelude({ initCommand: 'export CCS_MARK=hello; echo noise-on-stdout' });
  check('the init command takes effect', bash(`${withInit} && printf %s "$CCS_MARK"`), 'hello');
  check('even a chatty init command prints nothing', bash(withInit), '');

  // $CCS_REMOTE_INIT is read where the prelude is BUILT — in this process — not on
  // the remote. Setting it on the child would prove nothing.
  process.env.CCS_REMOTE_INIT = 'export CCS_MARK=fromenv';
  check('$CCS_REMOTE_INIT is the default init command',
    bash(`${remoteEnvPrelude()} && printf %s "$CCS_MARK"`), 'fromenv');
  check('an explicit initCommand wins over the env var',
    bash(`${remoteEnvPrelude({ initCommand: 'export CCS_MARK=explicit' })} && printf %s "$CCS_MARK"`), 'explicit');
  delete process.env.CCS_REMOTE_INIT;
}

console.log('\n— a shim directory actually reaches PATH —');
// The whole point of the fix, end to end: a fake HOME holding an asdf-style shim, and
// the interpreter resolved from it. Nothing here touches the real HOME.
if (!HAVE_BASH) {
  console.log('  SKIP — no bash on this machine');
} else {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-fakehome-'));
  const shims = path.join(home, '.asdf', 'shims');
  fs.mkdirSync(shims, { recursive: true });
  const shim = path.join(shims, 'ccs-fake-tool');
  fs.writeFileSync(shim, '#!/bin/sh\necho from-shim\n');
  fs.chmodSync(shim, 0o755);

  const env = { HOME: home, XDG_DATA_HOME: path.join(home, '.local', 'share'), NVM_DIR: path.join(home, '.nvm') };
  check('a tool that exists only in a shim dir resolves',
    bash(`${remoteEnvPrelude()} && ccs-fake-tool`, env).trim(), 'from-shim');
  // Prepended, not appended: an interactive shell puts the manager in FRONT of
  // /usr/bin, so appending would keep handing back the system interpreter — the exact
  // version mismatch the managers exist to prevent.
  check('the shim dir is prepended, not appended',
    bash(`${remoteEnvPrelude()} && case "$PATH" in ${shims}:*) echo front ;; *) echo elsewhere ;; esac`, env).trim(), 'front');
  // Chained runs share one shell; a dir added twice would grow PATH without bound.
  check('an already-present dir is not added twice',
    bash(`${remoteEnvPrelude()} && ${remoteEnvPrelude()} && printf %s "$PATH" | tr ':' '\\n' | grep -c '^${shims}$'`, env).trim(), '1');
  check('a missing shim dir is simply skipped',
    bash(`${remoteEnvPrelude()} && echo NEXT`, { HOME: path.join(home, 'nothing-here') }).trim(), 'NEXT');

  fs.rmSync(home, { recursive: true, force: true });
}

console.log('\n— the probe —');
check('every shim dir is expressed relative to $HOME or $XDG_DATA_HOME',
  SHIM_DIRS.every(d => d.startsWith('$HOME/') || d.startsWith('${XDG_DATA_HOME:')), true);
check('mise, asdf, pyenv and volta are all covered',
  ['mise', 'asdf', 'pyenv', 'volta'].every(m => SHIM_DIRS.some(d => d.includes(m))), true);

check('the probe parses its own shape', parseRemoteEnvProbe(
  'ccsenv=ok\nnode=/usr/bin/node\nnodeVersion=v20.11.0\nclaude=/usr/local/bin/claude\n'),
  { ok: true, node: '/usr/bin/node', nodeVersion: 'v20.11.0', claude: '/usr/local/bin/claude' });
// A host with a chatty rc file prints banners into this stream. Unknown lines are
// ignored rather than treated as a parse failure — otherwise the diagnostic that
// exists to explain a broken host breaks on the same hosts.
check('unrelated output is ignored', parseRemoteEnvProbe(
  'Welcome to Ubuntu 22.04\nccsenv=ok\n*** MOTD ***\nnode=/usr/bin/node\n').ok, true);
check('a missing tool reads as empty, not as the literal dash',
  parseRemoteEnvProbe('ccsenv=ok\nnode=-\nnodeVersion=-\nclaude=-\n'),
  { ok: true, node: '', nodeVersion: '', claude: '' });
check('no output at all is not ok', parseRemoteEnvProbe('').ok, false);
check('a truncated probe is not ok', parseRemoteEnvProbe('node=/usr/bin/node\n').ok, false);

if (HAVE_BASH) {
  // The probe command is `bash -lc '<escaped script>'`; running it through bash -lc
  // again would double-wrap, so strip the wrapper and run the payload directly.
  const out = bash(remoteEnvProbeCommand().replace(/^bash -lc /, '').replace(/^'|'$/g, '').replace(/'\\''/g, "'"));
  const probe = parseRemoteEnvProbe(out);
  check('the probe reports ok against this machine', probe.ok, true);
  check('the probe finds the node running this test', probe.node.length > 0, true);
}

console.log('\n— the call site —');
// Static, and deliberately so: the ordering is a decision, not an accident. mise and
// asdf pin a version PER DIRECTORY, so a prelude that ran before the `cd` would report
// the global version for every project. There is no ssh2 stub to assert this
// dynamically, and pinning the order in source beats not pinning it.
const sshSrc = fs.readFileSync(path.join(__dirname, '..', 'claude-ssh.js'), 'utf-8');
const block = sshSrc.slice(sshSrc.indexOf('const innerCmdParts = ['), sshSrc.indexOf('const remoteCmd ='));
check('claude-ssh.js builds its command with the prelude', block.includes('remoteEnvPrelude()'), true);
check('the prelude comes AFTER the cd', block.indexOf('cd ${shellEscape') < block.indexOf('remoteEnvPrelude()'), true);
check('the old hardcoded PATH export is gone from the call site',
  block.includes('$HOME/.npm-global/bin'), false);
check('…and survives inside the prelude, so existing hosts do not regress',
  remoteEnvPrelude().includes('$HOME/.npm-global/bin'), true);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
