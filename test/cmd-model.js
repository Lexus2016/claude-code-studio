'use strict';
/**
 * A small model of how Windows actually parses the delegate command line.
 * We cannot run cmd.exe on macOS/Linux CI, so the Windows quoting rules are
 * asserted against this model instead of against literal expected strings
 * (a literal-equality test is what let the `\"` bug ship — see
 * test/delegate-terminal.test.js).
 *
 * Three layers are modelled, in the order the delegate flow hits them:
 *
 *   1. batchPercent()  — batch-file phase 1: %% -> %, %VAR% -> value.
 *   2. cmdScan()       — cmd phase 2: quote-region tracking, ^ escaping,
 *                        and which of & | < > ( ) ^ are ACTIVE (i.e. actually
 *                        act as operators rather than being literal text).
 *   3. parseArgv()     — the MSVC C runtime / CommandLineToArgvW rules the
 *                        launched program uses to rebuild argv:
 *                        2n backslashes + "  -> n backslashes, quote is special
 *                        2n+1 backslashes + " -> n backslashes + literal "
 *                        "" inside a quoted region -> literal "
 *
 * plus shimReparse(), because on Windows `claude` / `codex` / `opencode` are
 * npm .cmd shims: they take the raw argument text and re-insert it via %*,
 * so cmd phase 2 runs over it a SECOND time (this is the BatBadBut class of
 * bug, CVE-2024-1874). Any escaping that is not idempotent under a second
 * phase-2 pass is broken for those targets.
 */

const CMD_METACHARS = new Set(['&', '|', '<', '>', '(', ')', '^']);

/** Batch-file phase 1: percent expansion. Runs before ^ / quote processing. */
function batchPercent(line, env = {}) {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') { out += line[i]; continue; }
    if (line[i + 1] === '%') { out += '%'; i++; continue; }          // %% -> %
    if (line[i + 1] === '*' || /[0-9]/.test(line[i + 1] || '')) { i++; continue; } // %* / %1 -> '' (no args)
    const close = line.indexOf('%', i + 1);
    if (close === -1) { continue; }                                   // lone % is dropped
    const name = line.slice(i + 1, close);
    if (Object.prototype.hasOwnProperty.call(env, name)) { out += env[name]; i = close; continue; }
    out += line.slice(i, close + 1);                                  // undefined %VAR% stays literal
    i = close;
  }
  return out;
}

/**
 * cmd phase 2. Returns:
 *   active     — metacharacters that act as operators (unquoted, un-carets)
 *   commands   — the line split on those operators, ^ escapes removed,
 *                quote characters PRESERVED (cmd hands them to the callee)
 *   continued  — true if the line ended with an active ^ (line continuation:
 *                a raw newline in the value would silently join the next line)
 */
function cmdScan(line) {
  const active = [];
  const commands = [];
  let cur = '';
  let inQuotes = false;
  let continued = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '^' && !inQuotes) {
      if (i === line.length - 1) { continued = true; break; }
      cur += line[i + 1];                 // ^X -> literal X, quote state untouched
      i++;
      continue;
    }
    if (c === '"') { inQuotes = !inQuotes; cur += c; continue; }
    if (!inQuotes && CMD_METACHARS.has(c)) {
      active.push({ char: c, index: i });
      if (c === '&' || c === '|') {
        if (line[i + 1] === c) { active.push({ char: c, index: i + 1 }); i++; }
        commands.push(cur); cur = '';
        continue;
      }
      cur += c;                            // < > ( ) — redirection/grouping, not a split
      continue;
    }
    cur += c;
  }
  commands.push(cur);
  return { active, commands: commands.map(s => s.trim()).filter(Boolean), continued, unbalancedQuote: inQuotes };
}

/** MSVC CRT / CommandLineToArgvW argv reconstruction. */
function parseArgv(s) {
  const args = [];
  let cur = '', inQ = false, started = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (!inQ && (c === ' ' || c === '\t')) {
      if (started) { args.push(cur); cur = ''; started = false; }
      i++;
      continue;
    }
    started = true;
    if (c === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') {
        cur += '\\'.repeat(n >> 1);
        if (n % 2 === 1) { cur += '"'; i++; }   // odd run: the quote is literal
      } else {
        cur += '\\'.repeat(n);
      }
      continue;
    }
    if (c === '"') {
      if (inQ && s[i + 1] === '"') { cur += '"'; i += 2; continue; }  // "" -> literal "
      inQ = !inQ; i++;
      continue;
    }
    cur += c; i++;
  }
  if (started) args.push(cur);
  return args;
}

/**
 * npm .cmd shim: `node "<shim>.js" %*` re-inserts the raw argument text and cmd
 * phase 2 parses it again. Percent expansion does NOT rerun over inserted text,
 * so only cmdScan is applied. Returns the argv the real program ends up with.
 */
function shimReparse(commandText) {
  const tail = commandText.replace(/^\S+\s*/, '');            // drop the program token
  const line = `node "C:\\npm\\node_modules\\x\\cli.js" ${tail}`;
  const scan = cmdScan(line);
  return { scan, argv: parseArgv(scan.commands[0] || '') };
}

/**
 * Full delegate flow: the built shell command is written into a .bat, so it goes
 * phase 1 -> phase 2 -> (optionally a .cmd shim re-parse) -> argv.
 */
function runBatchLine(line, env = {}) {
  const afterPercent = batchPercent(line, env);
  const scan = cmdScan(afterPercent);
  return {
    afterPercent,
    ...scan,
    argvOf: (idx) => parseArgv(scan.commands[idx] || ''),
    shimOf: (idx) => shimReparse(scan.commands[idx] || ''),
  };
}

module.exports = { CMD_METACHARS, batchPercent, cmdScan, parseArgv, shimReparse, runBatchLine };
