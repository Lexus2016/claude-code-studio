'use strict';
/**
 * Argument construction for the Delegate feature's "open a terminal and run the
 * external agent" step. Extracted from server.js so the platform-specific quoting
 * is unit-testable without spawning anything — see test/delegate-terminal.test.js.
 */

/**
 * Quote a value for the shell that will run the generated command line.
 * @param {string} s
 * @param {string} platform - process.platform value
 */
function shellEscape(s, platform) {
  if (platform === 'win32') {
    // The result goes into a .bat line, so two parsers see it.
    // Inside double quotes cmd treats & | < > ^ as literal — a `^` prefix there is NOT
    // an escape, it survives into the argument and corrupts the text (the delegate
    // prompt contains both `"` and `|`). What actually needs escaping is `"` for the
    // program's own argv parser and `%` for the batch parser.
    return '"' + String(s).replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
  }
  // Unix: single-quote wrapping, replace ' with '\'' (end quote, escaped quote, start quote)
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Build the shell command that cd's into the workdir and launches the agent CLI.
 * @param {{template?: string}} agentConfig
 */
function buildTerminalCommand(agentConfig, workdir, prompt, platform) {
  const template = agentConfig.template || '';
  const cmd = template.replace('{prompt}', shellEscape(prompt, platform));
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
