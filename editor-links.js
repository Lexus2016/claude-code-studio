'use strict';
// "Open in VS Code" for the active workspace — issue #63.
//
// Two ways exist to put a folder into a desktop editor from a web app, and this
// project needs BOTH, because the studio is not always running on the machine the
// browser is on:
//
//   1. a `vscode://` deep link, followed by the browser. The editor is launched by
//      whichever machine is rendering the page — which is, by definition, the
//      machine with the screen the user is looking at. Nothing can be detected
//      this way: a browser reports neither that a protocol handler exists nor that
//      it failed.
//   2. the `code` CLI, spawned by the server. This one CAN be detected (`--version`
//      either resolves or it does not), so it is the path that can answer the
//      issue's "display a clear message" requirement — but it opens a window on the
//      SERVER host, which is wrong inside Docker, over a tunnel, or from a phone.
//
// server.js prefers (2) when an editor binary actually resolves and falls back to
// (1) otherwise, which lands correctly in every deployment shape without a single
// `process.platform` test: a container has no `code` on PATH, so it hands the
// browser a link; a workstation has one, so it opens the window itself.
//
// This module is the pure half — flavor catalog, URI construction, path guards —
// so the format can be pinned without spawning anything (test/editor-links.test.js).
//
// THE TWO URI SHAPES ARE NOT THE SAME STRING, and mixing them up is the bug this
// header exists to prevent:
//
//   browser deep link :  vscode://vscode-remote/ssh-remote+user@host/srv/app
//   CLI argument      :  --folder-uri vscode-remote://ssh-remote+user@host/srv/app
//
// In (1) the editor's own scheme is the scheme and `vscode-remote` is the URI
// AUTHORITY — that is how the desktop URL handler routes it. In (2) `vscode-remote`
// is the scheme, because at that point the editor is already running and is being
// handed a workspace URI directly.

const path = require('path');

/**
 * Editors that register a VS Code-compatible URL handler and ship a CLI. Every one
 * of them is a VS Code fork, so `vscode-remote://ssh-remote+…` means the same thing
 * in all of them — only the scheme and the binary name differ. This is the "allow
 * configuring a custom editor" half of the issue: a fixed list rather than a free
 * text field, because both values end up in a URI and one of them ends up as an
 * argv[0], and neither is somewhere to accept arbitrary user text.
 */
const EDITORS = {
  vscode:   { label: 'VS Code',          scheme: 'vscode',          cli: 'code' },
  insiders: { label: 'VS Code Insiders', scheme: 'vscode-insiders', cli: 'code-insiders' },
  vscodium: { label: 'VSCodium',         scheme: 'vscodium',        cli: 'codium' },
  cursor:   { label: 'Cursor',           scheme: 'cursor',          cli: 'cursor' },
  windsurf: { label: 'Windsurf',         scheme: 'windsurf',        cli: 'windsurf' },
};
const DEFAULT_EDITOR = 'vscode';
const EDITOR_IDS = Object.keys(EDITORS);

/** @param {string} [id] */
function editorFor(id) {
  const key = String(id || '').trim();
  return EDITORS[key] ? { id: key, ...EDITORS[key] } : { id: DEFAULT_EDITOR, ...EDITORS[DEFAULT_EDITOR] };
}

// Percent-encode one path segment. encodeURIComponent() is too aggressive here: it
// escapes `:`, and a Windows drive letter is spelled `c:` INSIDE the path of a
// `vscode://file/c:/…` URI — VS Code's own documentation writes it unescaped, and
// `%3A` is not recognised. `sub-delims` and `@` are likewise legal in a path segment
// per RFC 3986, so they are left alone; a space, a `#` or a `?` are not, and one
// unescaped `#` would truncate the path at the fragment.
const SAFE_SEGMENT = /[^A-Za-z0-9\-._~!$&'()*+,;=:@]/g;
function encodeSegment(s) {
  return String(s).replace(SAFE_SEGMENT, c =>
    Array.from(Buffer.from(c, 'utf8')).map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''));
}

/** Encode an absolute POSIX-ish path, keeping the separators. */
function encodePath(p) {
  return String(p).split('/').map(encodeSegment).join('/');
}

/**
 * The SSH authority VS Code Remote-SSH resolves. `user@host` is what the extension's
 * own quick-pick accepts, and it is also exactly what this project already stores on
 * a remote host record, so no SSH config alias has to exist on the client.
 *
 * A non-22 port is appended. Omitting it is not the safer choice: the connection
 * would then be attempted against port 22 and fail, whereas `host:port` at worst
 * fails the same way on an old extension build.
 */
function sshAuthority(remoteHost, port) {
  const h = String(remoteHost || '').trim();
  if (!h) return '';
  const p = Number(port);
  return (p && p !== 22) ? `${h}:${p}` : h;
}

/** Anything that would let a value break out of the URI, or out of argv. */
function unsafeValue(s) {
  // A NUL truncates the C string an exec() finally receives, so everything after it
  // vanishes — including a part a guard here just approved. The rest are characters
  // that cannot appear in a real path and would only ever arrive from a crafted
  // request; a newline in particular would split a URI across two lines.
  return /[\u0000-\u001f\u007f]/.test(String(s));
}

/**
 * Resolve an "open this in the editor" request into the two things server.js needs:
 * a deep link for the browser and an argv tail for the CLI.
 *
 * @param {object} o
 * @param {string} [o.editor]      — EDITORS key; anything unknown falls back to VS Code
 * @param {boolean} [o.isRemote]   — the project's own flag, never inferred from the path
 * @param {string} o.workdir       — project root (local absolute path, or POSIX path on the host)
 * @param {string} [o.remoteHost]  — `user@host` as stored on the project
 * @param {number} [o.port]
 * @param {string} [o.rel]         — path INSIDE the project to open instead of the root
 * @param {boolean} [o.isFile]     — open `rel` as a file rather than as a folder
 * @returns {{ok:true, editor:object, kind:'folder'|'file', url:string, cliArgs:string[], target:string}
 *          |{ok:false, error:string, code:string}}
 */
function resolveEditorTarget(o) {
  const opts = o || {};
  const editor = editorFor(opts.editor);
  const workdir = String(opts.workdir == null ? '' : opts.workdir).trim();
  const rel = String(opts.rel == null ? '' : opts.rel);
  if (!workdir) return { ok: false, code: 'NO_WORKDIR', error: 'No workspace is active' };
  if (unsafeValue(workdir) || unsafeValue(rel) || unsafeValue(opts.remoteHost || '')) {
    return { ok: false, code: 'DENIED', error: 'Denied' };
  }
  const kind = (opts.isFile && rel) ? 'file' : 'folder';

  if (opts.isRemote) {
    const authority = sshAuthority(opts.remoteHost, opts.port);
    if (!authority) return { ok: false, code: 'NO_HOST', error: 'This remote project has no SSH host recorded' };
    // Remote paths are resolved with path.posix WHATEVER THIS SERVER RUNS ON — the
    // same rule remote-files.js exists to keep. path.resolve() on a Windows host
    // turns '/srv/app' into 'C:\srv\app', which is the #53 failure family, and here
    // it would additionally be baked into a URI handed to the user's editor.
    if (!workdir.startsWith('/')) {
      // A `~/project` workdir is legal everywhere else in this app because the remote
      // shell expands it. A URI has no shell: Remote-SSH would look for a directory
      // literally named `~`. Resolving it would need an SSH round trip, which is not
      // something a link-builder should be doing — so it is refused BY NAME instead
      // of silently producing a link that opens the wrong folder.
      return { ok: false, code: 'NOT_ABSOLUTE',
        error: `VS Code Remote needs an absolute path — this project's workdir is "${workdir}". Re-create it with the full path on the host.` };
    }
    if (workdir.includes('\\')) {
      return { ok: false, code: 'NOT_POSIX', error: 'Remote workdir must be a POSIX path' };
    }
    const target = path.posix.resolve(workdir, rel);
    if (target !== workdir && !target.startsWith(workdir.replace(/\/+$/, '') + '/')) {
      return { ok: false, code: 'DENIED', error: 'Denied' };
    }
    const uriPath = encodePath(target);
    const auth = `ssh-remote+${encodeSegment(authority)}`;
    return {
      ok: true, editor, kind, target,
      // Browser: the editor's scheme, `vscode-remote` as the authority.
      url: `${editor.scheme}://vscode-remote/${auth}${uriPath}`,
      // CLI: `vscode-remote` IS the scheme. --file-uri / --folder-uri rather than a
      // bare path, because VS Code guesses file-vs-folder from the extension
      // otherwise and a folder called `app.v2` opens as a file.
      cliArgs: [kind === 'file' ? '--file-uri' : '--folder-uri', `vscode-remote://${auth}${uriPath}`],
    };
  }

  // Local: this path is on the machine running the server, so the platform's own
  // resolver is the right one.
  let target;
  try { target = rel ? path.resolve(workdir, rel) : path.resolve(workdir); }
  catch { return { ok: false, code: 'DENIED', error: 'Denied' }; }
  const rootAbs = path.resolve(workdir);
  const inside = path.relative(rootAbs, target);
  if (inside !== '' && (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside))) {
    return { ok: false, code: 'DENIED', error: 'Denied' };
  }
  // `vscode://file/` wants forward slashes and no leading one of its own:
  // 'C:\p\x' -> 'vscode://file/C:/p/x', '/home/u/x' -> 'vscode://file/home/u/x'.
  const uriPath = encodePath(target.replace(/\\/g, '/').replace(/^\/+/, ''));
  return {
    ok: true, editor, kind, target,
    url: `${editor.scheme}://file/${uriPath}`,
    // A bare path is what the issue asks for (`code <workspace>`) and what every
    // fork accepts; the file/folder ambiguity that forces --folder-uri on the remote
    // side does not exist here, because the CLI can stat it.
    cliArgs: [target],
  };
}

module.exports = { EDITORS, EDITOR_IDS, DEFAULT_EDITOR, editorFor, resolveEditorTarget, sshAuthority, encodePath, encodeSegment };
