// "Open in VS Code" — issue #63.
//
// The whole feature is one string per case, and a string that is subtly wrong opens
// the WRONG FOLDER on the user's machine rather than failing. So the URI shapes are
// pinned literally here, not described.
//
// The invariant this file exists for: the browser deep link and the CLI argument are
// NOT the same URI.
//
//   browser :  vscode://vscode-remote/ssh-remote+user@host/srv/app
//   CLI     :  --folder-uri vscode-remote://ssh-remote+user@host/srv/app
//
// In the first, the editor's own scheme is the scheme and `vscode-remote` is the
// authority — that is how the desktop URL handler routes it. In the second,
// `vscode-remote` IS the scheme, because the editor is already running. Collapse the
// two and one of the paths silently stops working, in a way no test that only checks
// "contains ssh-remote" would notice.
//
// Run: node test/editor-links.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../editor-links');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const local  = o => E.resolveEditorTarget({ workdir: '/home/u/app', ...o });
const remote = o => E.resolveEditorTarget({ isRemote: true, workdir: '/srv/app', remoteHost: 'deploy@10.0.0.5', ...o });

// ── 1. The two shapes ────────────────────────────────────────────────────────
console.log('\nthe deep link and the CLI argument are different URIs:');
{
  const r = remote({});
  check('the browser link puts vscode-remote in the AUTHORITY',
    r.url, 'vscode://vscode-remote/ssh-remote+deploy@10.0.0.5/srv/app');
  check('the CLI argument puts it in the SCHEME',
    r.cliArgs, ['--folder-uri', 'vscode-remote://ssh-remote+deploy@10.0.0.5/srv/app']);
  // --folder-uri and not a bare path: VS Code guesses file-vs-folder from the
  // extension, so a directory named `app.v2` opens as a file.
  check('a remote FILE uses --file-uri, not --folder-uri',
    remote({ rel: 'src/index.js', isFile: true }).cliArgs,
    ['--file-uri', 'vscode-remote://ssh-remote+deploy@10.0.0.5/srv/app/src/index.js']);
  check('and its kind says so', remote({ rel: 'a.js', isFile: true }).kind, 'file');
  check('a rel path without isFile is still a folder', remote({ rel: 'src' }).kind, 'folder');

  const l = local({});
  check('a local project is a plain file: URI', l.url, 'vscode://file/home/u/app');
  check('and the CLI just gets the path — `code <workspace>`', l.cliArgs, ['/home/u/app']);
}

// ── 2. The SSH authority ─────────────────────────────────────────────────────
console.log('\nthe SSH authority carries the port only when it is not 22:');
{
  check('port 22 is left off — it is the default on both sides',
    E.sshAuthority('u@h', 22), 'u@h');
  check('an absent port likewise', E.sshAuthority('u@h', 0), 'u@h');
  // Omitting a non-standard port is NOT the safe choice: the connection would then
  // be attempted against 22 and fail. `host:port` at worst fails the same way.
  check('a non-standard port is appended', E.sshAuthority('u@h', 2222), 'u@h:2222');
  check('and it reaches the URI',
    remote({ port: 2222 }).url, 'vscode://vscode-remote/ssh-remote+deploy@10.0.0.5:2222/srv/app');
  check('a remote project with no host recorded is refused by name',
    E.resolveEditorTarget({ isRemote: true, workdir: '/srv/app' }).code, 'NO_HOST');
}

// ── 3. Encoding ──────────────────────────────────────────────────────────────
console.log('\npath encoding keeps a URI a URI, and a drive letter a drive letter:');
{
  check('a space becomes %20', local({ workdir: '/home/u/my app' }).url, 'vscode://file/home/u/my%20app');
  // One unescaped '#' truncates the path at the fragment — the editor would open the
  // parent folder instead, silently.
  check('a # is escaped, or the path ends there',
    local({ workdir: '/home/u/c#proj' }).url, 'vscode://file/home/u/c%23proj');
  check('a ? is escaped too', local({ workdir: '/home/u/a?b' }).url, 'vscode://file/home/u/a%3Fb');
  check('non-ASCII is UTF-8 percent-encoded', E.encodeSegment('café'), 'caf%C3%A9');
  // encodeURIComponent() would write %3A here. VS Code's own docs spell it
  // `vscode://file/c:/myProject`, and %3A is not recognised.
  check('a colon survives — a Windows drive letter lives INSIDE the path',
    E.encodeSegment('c:'), 'c:');
  check('and @ survives, because the authority is user@host', E.encodeSegment('u@h'), 'u@h');
  check('separators are not encoded away', E.encodePath('/a b/c'), '/a%20b/c');
}

// ── 4. Guards ────────────────────────────────────────────────────────────────
console.log('\nwhat it refuses, and why the refusal is by name:');
{
  // A `~/project` workdir is legal everywhere else in this app because the remote
  // SHELL expands it. A URI has no shell: Remote-SSH would look for a directory
  // literally called `~`. Refusing beats opening the wrong folder.
  const tilde = E.resolveEditorTarget({ isRemote: true, workdir: '~/app', remoteHost: 'u@h' });
  check('a ~-relative remote workdir is refused', tilde.ok, false);
  check('with a code the UI can branch on', tilde.code, 'NOT_ABSOLUTE');
  check('and a message that names the workdir', /~\/app/.test(tilde.error), true);

  check('a backslash in a remote workdir is refused',
    E.resolveEditorTarget({ isRemote: true, workdir: '/srv\\app', remoteHost: 'u@h' }).code, 'NOT_POSIX');
  // A NUL truncates the C string exec() finally receives, so everything after it
  // vanishes — including a part a guard here just approved.
  check('a NUL anywhere is denied', local({ workdir: '/home/u/a\u0000b' }).code, 'DENIED');
  check('a newline is denied — it would split the URI', local({ rel: 'a\nb' }).code, 'DENIED');
  check('a control char in the host is denied',
    E.resolveEditorTarget({ isRemote: true, workdir: '/srv/app', remoteHost: 'u@h\r' }).code, 'DENIED');
  check('an empty workdir is refused', E.resolveEditorTarget({}).code, 'NO_WORKDIR');

  // rel is a path from the browser. It is contained on BOTH sides, and the remote
  // side uses path.posix so a Windows HOST cannot turn '/srv/app' into 'C:\srv\app'
  // (the #53 failure family) before the check runs.
  check('a remote rel cannot climb out', remote({ rel: '../../etc' }).code, 'DENIED');
  check('a local rel cannot either', local({ rel: '../../etc' }).code, 'DENIED');
  check('a rel that stays inside is fine', remote({ rel: 'src/a.js' }).target, '/srv/app/src/a.js');
  check('the project root itself is inside itself', local({ rel: '.' }).ok, true);
  check('remote resolution is POSIX, never this platform',
    remote({ rel: 'src/./x/../a.js' }).target, '/srv/app/src/a.js');
}

// ── 5. The editor catalog ────────────────────────────────────────────────────
console.log('\nthe editor catalog is a fixed list, not free text:');
{
  // The value becomes both a URI scheme and an argv[0]. Neither is somewhere to
  // accept arbitrary user text, so an unknown id falls back rather than being used.
  check('an unknown id falls back to VS Code', E.editorFor('emacs').id, 'vscode');
  check('as does an empty one', E.editorFor('').id, 'vscode');
  check('as does undefined', E.editorFor().id, 'vscode');
  check('the default is VS Code', E.DEFAULT_EDITOR, 'vscode');
  check('every catalogued id has a scheme and a CLI',
    E.EDITOR_IDS.filter(id => !E.EDITORS[id].scheme || !E.EDITORS[id].cli || !E.EDITORS[id].label), []);
  check('Insiders has its own scheme', E.editorFor('insiders').scheme, 'vscode-insiders');
  check('and its own binary', E.editorFor('insiders').cli, 'code-insiders');
  check('a fork changes only the scheme — vscode-remote means the same thing in all of them',
    remote({ editor: 'cursor' }).url, 'cursor://vscode-remote/ssh-remote+deploy@10.0.0.5/srv/app');
  check('the CLI side of a fork keeps the vscode-remote scheme',
    remote({ editor: 'cursor' }).cliArgs[1], 'vscode-remote://ssh-remote+deploy@10.0.0.5/srv/app');
  check('the resolved editor rides along for the UI label', local({ editor: 'windsurf' }).editor.label, 'Windsurf');
}

// ── 6. The server wiring ─────────────────────────────────────────────────────
// Source-level, like config-resolve.test.js's operator guard: these are decisions
// that a later edit would silently undo, and none of them is observable from the
// pure module.
console.log('\nthe wiring in server.js:');
{
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = SRC.indexOf("app.post('/api/editor/open'");
  check('the endpoint exists', start > -1, true);
  const body = SRC.slice(start, SRC.indexOf("\n});\n", start));

  // Reusing the file browser's resolver IS the access rule: "you may open in an
  // editor whatever you may browse". A bespoke second guard here would be a second
  // thing to keep in sync with isPathAllowed().
  check('it authorises through the file browser resolver', /resolveFilesWorkdir\(workdir\)/.test(body), true);
  check('and denies when that resolver says no', /if \(!resolved\) return res\.status\(403\)/.test(body), true);
  // isRemote must come from the PROJECT RECORD. Inferring it from the path would
  // hand a local POSIX-looking workdir to Remote-SSH.
  check('isRemote comes from the resolved project, not from the path',
    /isRemote: resolved\.isRemote/.test(body), true);

  // A shell is the one thing this must not involve: the value being launched is a
  // filesystem path, and cmd.exe re-parses arguments a second time through the npm
  // .cmd shims (the BatBadBut family delegate-terminal.js already had to work around).
  check('the spawn never goes through a shell', /shell\s*:/.test(body), false);
  check('the editor outlives this process', /detached: true/.test(body), true);
  check('a missing CLI is a client-side deep link, not an error',
    /opened: 'client'/.test(body), true);

  // Windows puts `code.cmd` on PATH, not `code.exe`, and Node refuses to spawn a
  // .cmd without shell:true. Accepting .CMD here would therefore not "add Windows
  // support" — it would make every Windows launch throw instead of falling through
  // to the deep link, which is the better answer there anyway.
  const exts = SRC.match(/const _EXEC_EXTS = [^\n]+/)[0];
  check('only directly-spawnable extensions count on Windows', /\.CMD|\.BAT/.test(exts), false);
  check('and the POSIX side uses a bare name', /\[''\]/.test(exts), true);

  // falsyFallsThrough on the catalog row claims `||`; config-resolve.test.js reads
  // the operator out of this line, so it has to be here at all.
  check('loadMergedConfig resolves `editor` with ||',
    /^\s*editor:\s*l\.editor \|\| g\.editor \|\| /m.test(SRC), true);
  check('/api/version reports the configured editor for the button label',
    /editor: \{ id: _ed\.id, label: _ed\.label \}/.test(SRC), true);
}

// ── 7. The SPA gating ────────────────────────────────────────────────────────
console.log('\nthe per-file button is local-only, for a different reason than download is:');
{
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // The remote FOLDER link works. VS Code's URL handler mis-handles a remote FILE
  // uri — it opens it as a folder (microsoft/vscode-remote-release#4333) — so the
  // viewer's button comes off for a remote file while the project row keeps working.
  check('the viewer button is hidden for a remote file',
    /\$i\('fpvEditorBtn'\)\.style\.display = remote \? 'none' : '';/.test(HTML), true);
  // Hidden is not guarded: the handler is a global and the modal outlives the
  // listing that set the flag.
  check('and the handler refuses one as well',
    /function fpvOpenInEditor\(\) \{\s*\n\s*if \(!_fpvPath \|\| _filesRemote\) return;/.test(HTML), true);
  check('the project row opens the workspace, remote or not',
    /openInEditor\('\$\{escArg\(p\.workdir\)\}'\)/.test(HTML), true);
  // No browser reports whether a protocol handler ran, so the hint is shown every
  // time that path is taken — phrased as a condition, not as an error.
  check('the deep-link path always says what to check',
    /setTimeout\(\(\) => toast\(t\('editor\.hint'\)/.test(HTML), true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
