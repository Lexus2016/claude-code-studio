// AGENTS.md support — issue #54.
//
// Claude Code discovers CLAUDE.md but NOT AGENTS.md. Measured against CLI 2.1.231
// on 2026-08-22: a directory holding only AGENTS.md, asked "what is the secret
// codename in your project instructions", answers NONE; the byte-identical file
// renamed to CLAUDE.md answers with the codename. So a project that standardises
// on AGENTS.md was running with none of its conventions loaded — silently, with no
// error anywhere to notice.
//
// The studio already hands every LOCAL run its own system prompt, so the fix is to
// read AGENTS.md here and append it there. Nothing is written to the user's tree.
//
// PRECEDENCE — CLAUDE.md wins, and when it exists AGENTS.md is not read at all.
// The CLI already loads CLAUDE.md; appending AGENTS.md on top would either repeat
// the same instructions or hand the model two sets of conventions to reconcile.
// That is the precedence the issue asked for: CLAUDE.md → AGENTS.md.
//
// NOT COVERED — remote SSH runs. The file lives on the other machine and this
// process cannot read it, so claude-ssh.js deliberately calls none of this. A
// remote project keeps the CLI's own behaviour: CLAUDE.md yes, AGENTS.md no.

const fs = require('fs');
const path = require('path');

// Order IS the precedence. Index 0 is also the default name used when neither
// file exists yet, so a fresh project still gets CLAUDE.md when the editor saves.
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'];

// A runaway AGENTS.md ends up in the argv of every spawn. 64 KB is far above any
// hand-written conventions file and well under the platform argv ceilings the rest
// of the prompt also has to fit inside (~256 KB on macOS, ~2 MB on Linux).
const MAX_BYTES = 65536;

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Which instruction file a directory actually uses.
 * @returns {string} absolute path of the first existing INSTRUCTION_FILES entry,
 *   or <dir>/CLAUDE.md when neither exists.
 */
function resolveInstructionFile(dir) {
  const base = path.resolve(dir);
  for (const name of INSTRUCTION_FILES) {
    const p = path.join(base, name);
    if (isFile(p)) return p;
  }
  return path.join(base, INSTRUCTION_FILES[0]);
}

/**
 * The block to append to a LOCAL run's system prompt.
 * @returns {string} '' when there is nothing to add — no AGENTS.md, it is empty, or
 *   a CLAUDE.md is present and the CLI will load it by itself.
 */
function agentsMdPreamble(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  let base;
  try { base = path.resolve(cwd); } catch { return ''; }

  if (isFile(path.join(base, 'CLAUDE.md'))) return '';
  const p = path.join(base, 'AGENTS.md');
  if (!isFile(p)) return '';

  let text;
  try { text = fs.readFileSync(p, 'utf-8'); } catch { return ''; }
  if (!text.trim()) return '';

  let truncated = false;
  if (Buffer.byteLength(text, 'utf-8') > MAX_BYTES) {
    // Slicing bytes can cut a codepoint in half; the tail is prose, and one
    // replacement char at the very end is a better outcome than a decoder throw.
    text = Buffer.from(text, 'utf-8').subarray(0, MAX_BYTES).toString('utf-8');
    truncated = true;
  }

  return `--- PROJECT INSTRUCTIONS (${p}) ---\n`
    + `The following are this project's conventions, loaded from its AGENTS.md. `
    + `Treat them exactly as you would a CLAUDE.md.\n\n`
    + text.trim()
    + (truncated ? `\n\n[truncated at ${MAX_BYTES} bytes]` : '');
}

module.exports = { INSTRUCTION_FILES, MAX_BYTES, resolveInstructionFile, agentsMdPreamble };
