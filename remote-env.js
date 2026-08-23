// The PATH a remote SSH run actually needs — issue #59.
//
// THE BUG, precisely: `bash -lc` is a LOGIN shell, which is not the same thing as an
// INTERACTIVE one. Every popular version manager — mise, asdf, nvm, pyenv, rbenv,
// nodenv, fnm, sdkman — publishes its binaries from ~/.bashrc, and the stock
// Debian/Ubuntu ~/.bashrc opens with
//     case $- in *i*) ;; *) return;; esac
// so a non-interactive login shell returns before the activation line ever runs.
// `node` is then on the user's PATH and not on ours, on the same host, for the same
// account.
//
// What the user sees is worse than the cause: the remote `claude` starts fine (its
// own launcher sits on the login PATH), gets to the end of the turn, spawns a
// SessionEnd hook through /bin/sh, and the hook reports `node: not found`. That reads
// as "Node is not installed" about a host where `which node` answers immediately.
//
// WHY PATH AND NOT SOURCING ~/.bashrc. Two reasons, both fatal to the alternative:
//   1. stdout. This command's stdout is a stream-json pipe parsed line by line; rc
//      files print banners, fortunes and `neofetch`. One stray line derails the run.
//   2. it would not work anyway. The rc file that needs sourcing is exactly the one
//      guarded by that `return` — sourcing it non-interactively contributes nothing.
// So: shim directories, plus the init scripts each manager documents as safe to
// source non-interactively, plus an escape hatch. All of it stdout-free by
// construction, because the whole block redirects to /dev/null.
//
// CHAIN SAFETY. The caller joins its statements with ` && `, so a prelude that ends
// on a false test would silently skip the `claude` invocation behind it. Everything
// here is therefore one command group ending in `|| true`, and the user's own init
// command runs under `eval` so that a syntax error in it is a runtime failure the
// `|| true` absorbs — not a parse error that takes the entire remote command with it.

// Same escaper as claude-ssh.js's shellEscape(), duplicated on purpose: claude-ssh.js
// requires THIS module, so importing it back would be a cycle for five lines.
function sq(str) {
  if (typeof str !== 'string') str = String(str);
  if (str.length === 0) return "''";
  if (/^[a-zA-Z0-9_.\/~:@=-]+$/.test(str)) return str;
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// Shim / bin directories, prepended when they exist. Order inside the list does not
// matter much; what matters is that they land in FRONT of the system PATH, which is
// what an interactive shell does and therefore what the user means by "node".
const SHIM_DIRS = [
  '${XDG_DATA_HOME:-$HOME/.local/share}/mise/shims',
  '$HOME/.asdf/shims', '$HOME/.asdf/bin',
  '$HOME/.pyenv/shims', '$HOME/.pyenv/bin',
  '$HOME/.rbenv/shims', '$HOME/.rbenv/bin',
  '$HOME/.nodenv/shims', '$HOME/.nodenv/bin',
  '$HOME/.volta/bin',
  '$HOME/.bun/bin',
  '$HOME/.cargo/bin',
  '$HOME/go/bin',
  '${XDG_DATA_HOME:-$HOME/.local/share}/fnm',
];

// The PATH the studio has always appended. Kept verbatim: hosts configured against
// 7.x already rely on it, and dropping it to "clean up" would be a silent regression
// on every one of them.
const LEGACY_PATH = 'export PATH="$PATH:/usr/local/bin:/usr/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$(npm root -g 2>/dev/null)/../.bin"';

/**
 * One chain-safe shell statement that makes a remote non-interactive shell resolve
 * the same interpreters the user's interactive shell resolves.
 *
 * @param {object} [opts]
 * @param {string} [opts.initCommand] extra shell run last, after everything above, so
 *   it can override any of it. Defaults to $CCS_REMOTE_INIT on the SERVER — the host
 *   config has no field for it, and a server-wide setting is the honest scope for a
 *   deployment that talks to one remote.
 * @returns {string}
 */
function remoteEnvPrelude(opts = {}) {
  const initCommand = typeof opts.initCommand === 'string' && opts.initCommand.trim()
    ? opts.initCommand.trim()
    : (process.env.CCS_REMOTE_INIT || '').trim();

  const lines = [
    LEGACY_PATH,
    // One line, not four: the caller joins with '; ' and `for ...; do; ...` is a
    // bash syntax error — the separator must not land between `do` and its body.
    `for d in ${SHIM_DIRS.map(d => `"${d}"`).join(' ')}; do `
      + `[ -d "$d" ] && case ":$PATH:" in *":$d:"*) : ;; *) PATH="$d:$PATH" ;; esac; done`,
    'export PATH',
    // Documented non-interactive entry points. nvm.sh runs `nvm use default` on load,
    // which is the whole reason it is sourced rather than PATH-guessed: the default
    // alias is the only thing that says WHICH installed node the user means.
    '[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"',
    '[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ] && . "$HOME/.sdkman/bin/sdkman-init.sh"',
    // Directory-aware managers, evaluated AFTER the caller has cd'd into the project:
    // .tool-versions / mise.toml pin a version per directory, and asking from the
    // wrong directory answers with the global one.
    'command -v mise >/dev/null 2>&1 && eval "$(mise env -s bash 2>/dev/null)"',
    'command -v fnm  >/dev/null 2>&1 && eval "$(fnm env 2>/dev/null)"',
  ];
  if (initCommand) lines.push(`eval ${sq(initCommand)}`);

  return `{ ${lines.join('; ')}; } >/dev/null 2>&1 || true`;
}

// Probe used by the connection test. Prints `key=value` lines and nothing else, so a
// host whose rc file is chatty cannot fake a result — the parser ignores what it does
// not recognise. Runs the prelude first, so it reports the PATH a real run would get,
// not the one a bare `ssh host command` gets.
function remoteEnvProbeCommand() {
  const probe = [
    'printf "ccsenv=ok\\n"',
    'printf "node=%s\\n" "$(command -v node 2>/dev/null || echo -)"',
    'printf "nodeVersion=%s\\n" "$(node --version 2>/dev/null || echo -)"',
    'printf "claude=%s\\n" "$(command -v claude 2>/dev/null || echo -)"',
  ].join('; ');
  return `bash -lc ${sq(`${remoteEnvPrelude()}; ${probe}`)}`;
}

/** Parse remoteEnvProbeCommand() output. Unknown lines are ignored on purpose. */
function parseRemoteEnvProbe(stdout) {
  const out = { ok: false, node: '', nodeVersion: '', claude: '' };
  for (const line of String(stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k === 'ccsenv') out.ok = v === 'ok';
    else if (k === 'node') out.node = v === '-' ? '' : v;
    else if (k === 'nodeVersion') out.nodeVersion = v === '-' ? '' : v;
    else if (k === 'claude') out.claude = v === '-' ? '' : v;
  }
  return out;
}

module.exports = { remoteEnvPrelude, remoteEnvProbeCommand, parseRemoteEnvProbe, SHIM_DIRS };
