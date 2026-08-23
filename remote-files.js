// Read-only file browser for remote SSH projects — issue #57.
//
// Until now /api/files answered `{type:'remote'}` for a remote project and the UI
// rendered "file browser not available". That refusal was correct while there was no
// remote read path: the browser reads the LOCAL filesystem, and pointing it at
// /home/user/project from a Windows client shows whatever happens to sit at
// C:\home\user\project — the #53 failure family.
//
// Scope is read-only on purpose: list a directory, read a file. Download, raw serving
// (images, PDFs) and any kind of write stay refused for remote projects. That is where
// nearly all the value is for the reported use — inspect the project, open a file to
// read it — and it ships without a second transfer path to secure.
//
// THE PATH GUARD IS THE PART THAT MATTERS, and it is deliberately not the local one.
// The local guard calls path.resolve(), which on a Windows host turns the POSIX path
// '/home/user/project' into 'C:\home\user\project' — precisely the bug in #53. So:
//   1. every resolution here is path.posix, whatever this server runs on;
//   2. the remote script re-checks containment against the PHYSICAL path (`cd … &&
//      pwd -P`), not the textual one.
// Rule 2 is not belt-and-braces. This process cannot lstat the remote tree, so a
// symlink at <project>/node_modules/x -> /etc satisfies every check made from here —
// the string still starts with the project root. Only `pwd -P`, run on the remote
// after the cd, reports where that path actually lands. A symlink whose FINAL
// component is a file is refused outright instead: resolving one portably needs
// `readlink -f`, which macOS did not ship before 12.3, and a symlinked file is
// exactly the leak this guard exists to stop.

const path = require('path');
const { shellEscape } = require('./claude-ssh');

// A directory listing is one SSH round trip and the pane shows all of it, so the cap
// is about the response size, not about paging. The reporter's projects are "a few
// hundred files"; 2000 leaves a wide margin and still bounds a stray node_modules.
const MAX_ENTRIES = parseInt(process.env.CCS_REMOTE_FILES_MAX_ENTRIES || '', 10) || 2000;
// Matches the local browser's 2 MB preview cap. An oversized file is refused ON THE
// REMOTE, so it never crosses the link at all.
const MAX_FILE_BYTES = parseInt(process.env.CCS_REMOTE_FILES_MAX_BYTES || '', 10) || 2 * 1024 * 1024;

// Sentinel base for a `~`-style workdir. Same trick as remoteCliRelPath() in
// server.js: containment is checked against a fake absolute root, and only the tail
// is handed to the shell, where $HOME expands it. `~` is never sent unquoted —
// quoting it would stop the expansion, and not quoting it would stop the escaping.
const HOME_SENTINEL = '/__ccs_home__';

/**
 * Resolve a browser-supplied relative path against a remote project workdir.
 *
 * @returns {{ok:true, base:string, target:string, homeRelative:boolean}
 *          |{ok:false, error:string}}
 */
function resolveRemotePath(workdir, rel) {
  const wd = String(workdir == null ? '' : workdir).trim();
  const r  = String(rel == null ? '' : rel);
  if (!wd) return { ok: false, error: 'No remote workdir' };
  // A NUL truncates the C string the remote exec() finally receives, so everything
  // after it would vanish — including the part a guard here just approved.
  if (wd.includes('\0') || r.includes('\0')) return { ok: false, error: 'Denied' };
  // A backslash-bearing path means the workdir was typed for the wrong platform. Let
  // it through and posix.resolve treats 'a\\b' as one filename, which silently browses
  // something that does not exist rather than saying so.
  if (wd.includes('\\')) return { ok: false, error: 'Remote workdir must be a POSIX path' };

  let base, homeRelative = false;
  if (wd.startsWith('/')) {
    base = path.posix.resolve(wd);
  } else if (wd === '~' || wd.startsWith('~/')) {
    homeRelative = true;
    base = path.posix.resolve(HOME_SENTINEL, wd.slice(1).replace(/^\/+/, ''));
    if (base !== HOME_SENTINEL && !base.startsWith(HOME_SENTINEL + '/')) {
      return { ok: false, error: 'Denied' };
    }
  } else {
    return { ok: false, error: 'Remote workdir must be absolute or start with ~/' };
  }

  const target = path.posix.resolve(base, r);
  if (target !== base && !target.startsWith(base + '/')) return { ok: false, error: 'Denied' };
  return { ok: true, base, target, homeRelative };
}

// Turn a resolved path into the shell expression that names it. For a `~` workdir the
// sentinel is dropped and "$h" takes its place; for an absolute one the whole path is
// escaped as a literal.
function shellPath(p, homeRelative) {
  if (!homeRelative) return shellEscape(p);
  const tail = p.slice(HOME_SENTINEL.length).replace(/^\/+/, '');
  return tail ? `"$h"/${shellEscape(tail)}` : '"$h"';
}

/**
 * ONE script that lists a directory or reads a file, matching what the local
 * /api/files does in one request.
 *
 * POSIX sh only — this runs on Linux, macOS and BusyBox alike, so `wc -c <f` instead
 * of stat(1) (whose flags differ between GNU and BSD) and shell globs instead of
 * `find -maxdepth` (a GNU spelling).
 *
 * `nonce` frames every control line. It is random per request, so a FILENAME cannot
 * forge one — and filenames are attacker-controlled in exactly the way that matters:
 * `touch 'x\nCCS123 E d - /etc'` inside a repo you cloned.
 */
function remoteBrowseScript(nonce, plan) {
  const N = shellEscape(nonce);
  const b = shellPath(plan.base, plan.homeRelative);
  const p = shellPath(plan.target, plan.homeRelative);
  return [
    'h=${HOME}',
    `b=${b}`,
    `p=${p}`,
    // Textual check first: cheap, and it fails closed before anything is entered.
    `case "$p" in "$b"|"$b"/*) ;; *) printf '%s ESCAPE\\n' ${N}; exit 0 ;; esac`,
    `if [ ! -e "$p" ]; then printf '%s NOENT\\n' ${N}; exit 0; fi`,
    // A symlink whose final component is a file cannot be resolved portably, and it
    // is the one shape that escapes every check above. Refused, not followed.
    `if [ -L "$p" ] && [ ! -d "$p" ]; then printf '%s SYMLINK\\n' ${N}; exit 0; fi`,
    // The PHYSICAL paths. `pwd -P` is POSIX and resolves every symlinked component,
    // which is what makes the re-check below mean something.
    // $( ) throughout, not backticks: the file branch nests a command substitution
    // inside a quoted one, and backticks cannot express that without escaping that
    // differs between shells.
    'rb="$(cd "$b" 2>/dev/null && pwd -P)"',
    `if [ -z "$rb" ]; then printf '%s NOENT\\n' ${N}; exit 0; fi`,
    'if [ -d "$p" ]; then rp="$(cd "$p" && pwd -P)";',
    'else rp="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)/$(basename "$p")"; fi',
    // Not just -z: a failed `cd` in the file branch leaves rp as "/<name>", which is
    // non-empty and would sail past an emptiness test straight into the case below.
    `if [ ! -e "$rp" ]; then printf '%s NOENT\\n' ${N}; exit 0; fi`,
    // The check that catches the symlinked directory the server could not see.
    `case "$rp" in "$rb"|"$rb"/*) ;; *) printf '%s ESCAPE\\n' ${N}; exit 0 ;; esac`,
    // The RESOLVED base, echoed back. For a `~` workdir this process only ever knew
    // the sentinel, and every path the listing reports is physical — without this
    // line the containment re-check in the parser would reject the whole listing.
    `printf '%s BASE %s\\n' ${N} "$rb"`,
    'if [ -d "$rp" ]; then',
    `  printf '%s DIR\\n' ${N}`,
    '  n=0',
    '  for e in "$rp"/*; do',
    // An empty directory leaves the glob unexpanded, so this also drops the literal
    // "$p"/* that would otherwise be listed as a file named `*`.
    '    [ -e "$e" ] || continue',
    `    n=$((n+1))`,
    `    if [ "$n" -gt ${MAX_ENTRIES} ]; then printf '%s TRUNC\\n' ${N}; break; fi`,
    `    if [ -d "$e" ]; then printf '%s E d - %s\\n' ${N} "$e"`,
    '    else',
    '      sz="$(wc -c < "$e" 2>/dev/null | tr -d " ")"',
    '      [ -n "$sz" ] || sz=0',
    `      printf '%s E f %s %s\\n' ${N} "$sz" "$e"`,
    '    fi',
    '  done',
    `  printf '%s DONE %s\\n' ${N} "$n"`,
    '  exit 0',
    'fi',
    `if [ ! -f "$rp" ]; then printf '%s NOENT\\n' ${N}; exit 0; fi`,
    'sz="$(wc -c < "$rp" | tr -d " ")"',
    // Refused HERE, not after the transfer: an 8 GB log should never cross the link.
    `if [ "$sz" -gt ${MAX_FILE_BYTES} ]; then printf '%s TOOBIG %s\\n' ${N} "$sz"; exit 0; fi`,
    `printf '%s FILE %s\\n' ${N} "$sz"`,
    'cat "$rp"',
  ].join('\n');
}

/**
 * Parse remoteBrowseScript() output.
 *
 * @returns {{status:string, items?:Array, truncated?:boolean, size?:number, raw?:string}}
 *   status is one of DIR | FILE | NOENT | ESCAPE | SYMLINK | TOOBIG | BAD. Paths come back
 *   RELATIVE to the project, which is what the browser navigates by.
 */
function parseRemoteBrowse(stdout, nonce) {
  const marker = nonce + ' ';
  const lines = String(stdout == null ? '' : stdout).split('\n');

  // Control lines are found by scanning, not by position. Anything that is not one is
  // the remote's own noise — a login banner, an rc-file `echo`, a filename with an
  // embedded newline — and ignoring it is what keeps a chatty host usable.
  let base = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(marker)) continue;
    const rest = lines[i].slice(marker.length);
    const sp = rest.indexOf(' ');
    const kind = sp === -1 ? rest.trim() : rest.slice(0, sp);
    const arg = sp === -1 ? '' : rest.slice(sp + 1);

    if (kind === 'ESCAPE' || kind === 'NOENT' || kind === 'SYMLINK') return { status: kind };
    if (kind === 'BASE') { base = arg.trim(); continue; }
    if (kind === 'TOOBIG') return { status: 'TOOBIG', size: parseInt(arg, 10) || 0 };

    if (kind === 'FILE') {
      // Everything after the header IS the file, newlines and all. Joining the rest
      // rather than scanning for another marker is deliberate: a file that happens to
      // contain the nonce would otherwise truncate itself.
      return { status: 'FILE', size: parseInt(arg, 10) || 0, raw: lines.slice(i + 1).join('\n') };
    }

    if (kind === 'DIR') {
      if (!base) return { status: 'BAD' };
      const items = [];
      let truncated = false, done = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith(marker)) continue;
        const r = lines[j].slice(marker.length);
        if (r.startsWith('TRUNC')) { truncated = true; continue; }
        if (r.startsWith('DONE')) { done = true; break; }
        // `E <d|f> <size|-> <absolute path>` — the path is everything after the third
        // space, so a filename containing spaces survives intact.
        const m = /^E ([df]) (\S+) (.*)$/.exec(r);
        if (!m) continue;
        const abs = m[3];
        // Third containment check, now against the base the remote actually expanded.
        // Cheap, and it is what stops a forged `E` line from a filename that carries a
        // newline and the nonce.
        if (abs !== base && !abs.startsWith(base + '/')) continue;
        items.push({
          name: path.posix.basename(abs),
          type: m[1] === 'd' ? 'dir' : 'file',
          rel: abs === base ? '' : abs.slice(base.length + 1),
          size: m[1] === 'f' ? (parseInt(m[2], 10) || 0) : null,
        });
      }
      if (!done && !truncated) return { status: 'BAD' };
      return { status: 'DIR', items, truncated, base };
    }
  }
  return { status: 'BAD' };
}

module.exports = {
  MAX_ENTRIES, MAX_FILE_BYTES, HOME_SENTINEL,
  resolveRemotePath, remoteBrowseScript, parseRemoteBrowse, shellPath,
};
