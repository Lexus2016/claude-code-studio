'use strict';
/**
 * Argument construction for the Delegate feature's "open a terminal and run the
 * external agent" step. Extracted from server.js so the platform-specific quoting
 * is unit-testable without spawning anything — see test/delegate-terminal.test.js.
 */

/**
 * Windows quoting. THREE parsers see this value, in this order:
 *
 *   1. batch phase 1 (percent expansion) — the command is written into a .bat
 *      (openTerminal() in server.js), so `%` must be doubled or it is eaten.
 *   2. cmd phase 2 — cmd does NOT know `\` as an escape character. It only
 *      COUNTS double quotes to track whether it is inside a quoted region;
 *      `& | < > ( ) ^` are operators outside such a region and literal text
 *      inside it. `^` escapes a metacharacter ONLY outside quotes.
 *   3. the launched program's argv parser (MSVC CRT / CommandLineToArgvW):
 *      2n backslashes + `"` -> n backslashes and the quote is a delimiter,
 *      2n+1 backslashes + `"` -> n backslashes and a LITERAL quote,
 *      `""` inside a quoted region -> a literal quote.
 *
 * The rule implemented here: keep the whole value inside ONE balanced cmd quoted
 * region, and encode an embedded quote as `""` (never `\"`), doubling any
 * backslash run that precedes a quote for layer 3.
 *
 * Why not the textbook `\"` + `^`-escape-everything pair: `\"` leaves an ODD
 * number of quotes behind, which flips cmd out of its quoted region and hands
 * the rest of the prompt to the shell as bare text (that was the bug — the real
 * sync prompt contains `"| answer"`, so cmd split the line on the `|`). And
 * `^`-escaping instead of quoting only survives ONE pass: on Windows `claude`,
 * `codex` and `opencode` are npm .cmd shims that re-insert the raw argument text
 * via `%*`, so cmd phase 2 runs a second time and the carets are already gone
 * (BatBadBut, CVE-2024-1874). `""` is balanced, therefore idempotent under that
 * re-parse, and every metacharacter stays inside a quoted region in both passes.
 *
 * Newlines are folded to spaces: a raw newline ends the .bat line, and cmd has no
 * escape for it (`^` + newline is a line continuation, which swallows it).
 *
 * Not handled: `!` under `setlocal EnableDelayedExpansion`. The generated .bat
 * never enables it, and cmd /k inherits the default (off) unless the machine sets
 * it in HKCU\Software\Microsoft\Command Processor.
 */
function winEscape(s) {
  let out = '"';
  let backslashes = 0;
  for (const ch of String(s).replace(/\r\n|\r|\n/g, ' ')) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') { out += '\\'.repeat(backslashes * 2) + '""'; backslashes = 0; continue; }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // A trailing backslash run would eat the closing quote at layer 3, so double it.
  out += '\\'.repeat(backslashes * 2) + '"';
  return out.replace(/%/g, '%%');
}

/**
 * Quote a value for the shell that will run the generated command line.
 * @param {string} s
 * @param {string} platform - process.platform value
 */
function shellEscape(s, platform) {
  if (platform === 'win32') return winEscape(s);
  // Unix: single-quote wrapping, replace ' with '\'' (end quote, escaped quote, start quote)
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Build the shell command that cd's into the workdir and launches the agent CLI.
 *
 * `{model}` and `{effort}` are optional placeholders an agent template may use, e.g.
 * `claude --model {model} {prompt}`. They are OMITTED, not blanked, when the caller
 * chose nothing: a template that writes `--model {model}` would otherwise become
 * `--model ` and the CLI would read the next token as the model name. The whole flag
 * has to disappear with the value, so the substitution eats the surrounding run of
 * spaces and leaves one.
 *
 * Every substituted value goes through shellEscape for the same reason `{prompt}`
 * does: these come from an HTTP body, and a model name is a string like any other.
 *
 * @param {{template?: string}} agentConfig
 * @param {{model?: string, effort?: string}} [opts]
 */
function buildTerminalCommand(agentConfig, workdir, prompt, platform, opts = {}) {
  const template = agentConfig.template || '';
  let cmd = template;
  for (const [name, value] of [['model', opts.model], ['effort', opts.effort]]) {
    const token = `{${name}}`;
    if (!cmd.includes(token)) continue;
    if (value) {
      cmd = cmd.split(token).join(shellEscape(String(value), platform));
    } else {
      // Drop the placeholder AND the flag in front of it: `--model {model}` with no
      // model must not become `--model` with the prompt as its argument.
      cmd = cmd.replace(new RegExp(`\\s*(?:--?[\\w-]+[= ])?\\{${name}\\}`, 'g'), '');
    }
  }
  cmd = cmd.replace('{prompt}', shellEscape(prompt, platform));
  // Not every agent CLI accepts a --cwd flag, so always cd into the workdir first
  return `cd ${shellEscape(workdir, platform)} && ${cmd}`;
}

/**
 * argv for `cmd.exe` that opens the .bat in a new window.
 *
 * `start` reads its first argument as the window TITLE only when that argument is
 * QUOTED. Bare `start Delegate cmd.exe ...` makes Windows look for a program named
 * "Delegate" and fail with "Windows cannot find 'Delegate'" (issue #22).
 *
 * Must be spawned with windowsVerbatimArguments: true — otherwise Node re-quotes
 * '"Delegate"' into '"\"Delegate\""', which `start` again treats as a program name.
 * That is also why tmpBat is quoted here: os.tmpdir() embeds the username, which
 * may contain spaces.
 */
function winTerminalArgs(tmpBat) {
  return ['/c', 'start', '"Delegate"', 'cmd.exe', '/k', `"${tmpBat}"`];
}

module.exports = { shellEscape, buildTerminalCommand, winTerminalArgs };
