'use strict';
/**
 * First-run screens of the interactive `claude` TUI, and why the subscription engine
 * answers two of them on the user's behalf.
 *
 * Measured against CLI 2.1.288 in a fresh HOME: before its input box, an interactive
 * `claude --dangerously-skip-permissions` shows up to three blocking screens —
 *
 *   1. the theme picker            — gone once `hasCompletedOnboarding` is true
 *   2. "Do you trust this folder?" — gone once `projects[<dir>].hasTrustDialogAccepted`
 *                                    is true. An ancestor's entry counts only up to a
 *                                    git root — measured: a trusted parent does NOT
 *                                    cover a child that is its own repository, which is
 *                                    exactly what every session worktree is
 *   3. the Bypass Permissions warning — gone with `skipDangerousModePermissionPrompt`
 *
 * None of them is numbered, so the #20 detector did not see them, and 2 and 3 open
 * with the caret on "No, exit": the engine pasted the user's message, Enter picked
 * "No, exit", and `claude` quit. On a machine where the CLI had never been opened —
 * every fresh Docker container — the subscription engine could not start at all.
 *
 * Why answering them is not a change of posture: the studio's default engine runs
 * `claude -p --dangerously-skip-permissions` in the very same directories, and the
 * CLI documents that `-p` skips the trust dialog outright and shows no warning. The
 * user consented to both when they added the project and picked the engine; the TUI
 * merely asks again. Screen 3 is therefore answered with `--settings` on the command
 * line (claude-interactive.js) and writes nothing. Screens 1 and 2 have no flag, so
 * this module writes the two keys into the CLI's global config — and only those.
 *
 * What the write is allowed to do:
 *   - nothing at all when nothing is missing, which is every start but the first per
 *     directory, so the file the user's own `claude` sessions use is rarely touched;
 *   - never write a file it could not PARSE — a half-written or hand-broken config is
 *     left exactly as found, and the TUI simply shows its screen (the detector in
 *     claude-interactive.js then says so in the browser);
 *   - trust the EXACT directory the engine starts in, never a parent, and decide by
 *     that exact key alone — the CLI's ancestor rule stops at git roots, so reading an
 *     ancestor here would skip the seed in precisely the case that needs it. The CLI
 *     adds a `projects` entry for every directory it runs in anyway, and writes its own
 *     trust under both the raw and the NFC form of the path; this does the same;
 *   - an existing file that is EMPTY is refused too: that is what a writer caught
 *     mid-save looks like, not a config with nothing in it;
 *   - write atomically: temp file next to the REAL file (a symlinked config keeps its
 *     link), mode and owner copied, and the file re-read just before the rename — if a
 *     live `claude` saved in between, the plan is redone on what it wrote instead of
 *     overwriting it. A running `claude` merges on its own next save (measured: a key
 *     added while one ran survived its exit), so only that narrow window needs care;
 *   - a single-file bind mount cannot be renamed onto (EBUSY): there the file is
 *     backed up beside itself, rewritten in place and fsynced, and restored from the
 *     backup if the write fails.
 *
 * `CCS_CLAUDE_FIRSTRUN_SEED=0` turns the write off; the screens then appear in the
 * engine pane and the browser asks the user to answer them there.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Where the CLI keeps its global config — `$CLAUDE_CONFIG_DIR/.claude.json` when
 *  that is set (measured), `~/.claude.json` otherwise. */
function claudeGlobalConfigPath(env = process.env) {
  // Resolved here, once: a RELATIVE dir would mean the studio's cwd to this module and
  // the project's cwd to the `claude` in the pane. The engine pins the same resolution.
  if (env.CLAUDE_CONFIG_DIR) return path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json');
  return path.join(env.HOME || os.homedir(), '.claude.json');
}

function _real(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** The keys the CLI looks a directory up under: the path and its NFC form. */
function trustKeys(dir) {
  return [...new Set([dir, dir.normalize('NFC')])];
}

/** Is `dir` trusted by its OWN entry? Deliberately not the CLI's ancestor rule: that
 *  one stops at git roots, and a session worktree is one. */
function isTrusted(config, dir) {
  const projects = config && typeof config.projects === 'object' && config.projects ? config.projects : {};
  return trustKeys(dir).every(k => projects[k] && projects[k].hasTrustDialogAccepted === true);
}

/**
 * Pure: what has to change in `config` so the TUI opens on its input box in `dir`.
 * Returns the NEW object, or null when nothing is missing. Never mutates `config`.
 * @param {object} config  parsed global config
 * @param {string} dir     absolute, already-resolved directory the engine starts in
 */
function planFirstRunSeed(config, dir) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  let next = null;
  const edit = () => (next ||= { ...config });
  if (config.hasCompletedOnboarding !== true) edit().hasCompletedOnboarding = true;
  // The picker is what onboarding would have asked; dark matches the studio's own UI.
  if (!config.theme) edit().theme = 'dark';
  if (dir && !isTrusted(config, dir)) {
    const projects = { ...(config.projects && typeof config.projects === 'object' ? config.projects : {}) };
    for (const k of trustKeys(dir)) projects[k] = { ...(projects[k] || {}), hasTrustDialogAccepted: true };
    edit().projects = projects;
  }
  return next;
}

/**
 * Make sure the interactive TUI will not stop on screens 1 and 2 in `workdir`.
 * Best effort by design: every failure leaves the config untouched and returns a
 * reason, because the fallback (the screen appears and the browser asks the user)
 * is worse UX but never wrong.
 * @returns {{ changed: boolean, reason?: string, path: string }}
 */
function seedClaudeFirstRun({ workdir, configPath = claudeGlobalConfigPath(), env = process.env } = {}) {
  if (env.CCS_CLAUDE_FIRSTRUN_SEED === '0') return { changed: false, reason: 'disabled', path: configPath };
  const dir = workdir ? _real(workdir) : null;
  // The REAL file: renaming onto a symlink would replace the link, and the target the
  // CLI actually reads would stay unseeded while edits split between two files. A
  // DANGLING link has no real file to resolve to — refuse rather than replace it.
  let target = configPath;
  try {
    if (fs.lstatSync(configPath).isSymbolicLink()) {
      try { target = fs.realpathSync.native(configPath); }
      catch { return { changed: false, reason: 'a dangling symlink — left as found', path: configPath }; }
    }
  } catch { /* does not exist yet */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = _readConfig(target);
    if (r.error) return { changed: false, reason: r.error, path: target };
    const next = planFirstRunSeed(r.config, dir);
    if (!next) return { changed: false, path: target };
    const body = JSON.stringify(next, null, 2);
    const mode = r.st ? r.st.mode & 0o777 : 0o600;
    const tmp = `${target}.ccs-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, body, { mode });
      fs.chmodSync(tmp, mode);                                // the umask filtered `mode` above
      if (r.st) { try { fs.chownSync(tmp, r.st.uid, r.st.gid); } catch { /* not ours to give away */ } }
      // A live `claude` that saved since our read wins: redo the plan on what it wrote.
      // What remains is the gap between this read and the rename — two syscalls, not a
      // lock: the CLI's own lock is not a public contract this file can take part in.
      if (_readRaw(target) !== r.raw) { fs.unlinkSync(tmp); continue; }
      try { fs.renameSync(tmp, target); }
      catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        if (e.code !== 'EBUSY' && e.code !== 'EXDEV') throw e;
        return _writeInPlace(target, dir);
      }
      return { changed: true, path: target };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      return { changed: false, reason: `write failed: ${e.code || e.message}`, path: target };
    }
  }
  return { changed: false, reason: 'the file kept changing under us — left to the CLI', path: target };
}

/** Raw text of the file, or null when it does not exist. Other errors throw. */
function _readRaw(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Read + parse with every refusal the seed honours. */
function _readConfig(file) {
  let raw, st = null;
  try { raw = _readRaw(file); if (raw !== null) st = fs.statSync(file); }
  catch (e) { return { error: `unreadable: ${e.code || e.message}` }; }
  if (raw === null) return { raw, st, config: {} };
  if (!raw.trim()) return { error: 'empty — left as found' };
  try { return { raw, st, config: JSON.parse(raw) }; }
  catch { return { error: 'not valid JSON — left as found' }; }
}

/** A single-file bind mount is a mount point and cannot be renamed onto. Rewrite it in
 *  place: plan from the content AS IT IS NOW (not from the earlier read), keep a backup
 *  under a unique name, write every byte, fsync — and put the backup back if any of
 *  that fails. A backup that could not be restored is left where the reason says. */
function _writeInPlace(target, dir) {
  const bak = `${target}.ccs-backup-${process.pid}-${Date.now()}`;
  try { fs.copyFileSync(target, bak, fs.constants.COPYFILE_EXCL); }
  catch (e) { return { changed: false, reason: `no backup possible: ${e.code || e.message}`, path: target }; }
  const r = _readConfig(bak);
  if (r.error) { try { fs.unlinkSync(bak); } catch {} return { changed: false, reason: r.error, path: target }; }
  const next = planFirstRunSeed(r.config, dir);
  if (!next) { try { fs.unlinkSync(bak); } catch {} return { changed: false, path: target }; }
  const buf = Buffer.from(JSON.stringify(next, null, 2), 'utf8');
  let fd = null;
  try {
    fd = fs.openSync(target, 'r+');
    for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off, off);
    fs.ftruncateSync(fd, buf.length);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    try { fs.unlinkSync(bak); } catch {}
    return { changed: true, path: target };
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.writeFileSync(target, fs.readFileSync(bak)); fs.unlinkSync(bak); }
    catch { return { changed: false, reason: `write failed and the original is in ${bak}: ${e.code || e.message}`, path: target }; }
    return { changed: false, reason: `write failed, original restored: ${e.code || e.message}`, path: target };
  }
}

/** `--settings` payload that answers screen 3. A constant, so the spawn command is
 *  deterministic (engine-spawn-cmd.test.js asserts the argv byte for byte). */
const SKIP_BYPASS_WARNING_SETTINGS = '{"skipDangerousModePermissionPrompt":true}';

module.exports = { claudeGlobalConfigPath, isTrusted, trustKeys, planFirstRunSeed, seedClaudeFirstRun, SKIP_BYPASS_WARNING_SETTINGS, _writeInPlace };
