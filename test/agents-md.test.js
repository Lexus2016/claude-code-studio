// AGENTS.md as a first-class instruction file — issue #54.
//
// The premise this whole feature rests on, measured against claude CLI 2.1.231:
// a directory holding ONLY AGENTS.md gets no project instructions at all (the model
// answers "NONE" when asked for a codename planted in the file), while the identical
// file renamed CLAUDE.md loads fine. So the studio has to read AGENTS.md itself.
//
// Three things are pinned here:
//   1. discovery + precedence (CLAUDE.md wins, AGENTS.md is the fallback, neither
//      present still yields CLAUDE.md so a fresh save gets the default name);
//   2. the system-prompt block — INCLUDING the silence cases, which are the ones a
//      refactor breaks: a CLAUDE.md present must suppress it entirely, or a project
//      with both files gets its conventions twice;
//   3. that it actually reaches the spawned process as --append-system-prompt and
//      NOT as --system-prompt. That distinction is load-bearing: --system-prompt
//      REPLACES the CLI's default prompt, and the task runner spawns with no
//      systemPrompt at all, so getting it wrong there would silently drop every
//      default instruction.
//
// Run: node test/agents-md.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { INSTRUCTION_FILES, MAX_BYTES, resolveInstructionFile, agentsMdPreamble } = require('../agents-md');
const ClaudeCLI = require('../claude-cli');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-agentsmd-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

// Each case gets its own directory: the whole feature keys off which files exist,
// so reusing one directory and deleting between cases would make order matter.
function mkdir(name, files) {
  const d = path.join(ROOT, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files || {})) fs.writeFileSync(path.join(d, f), body, 'utf-8');
  return d;
}

console.log('\n— discovery and precedence —');
const dBoth   = mkdir('both',   { 'CLAUDE.md': 'claude side', 'AGENTS.md': 'agents side' });
const dAgents = mkdir('agents', { 'AGENTS.md': 'agents side' });
const dClaude = mkdir('claude', { 'CLAUDE.md': 'claude side' });
const dNone   = mkdir('none',   {});

check('precedence order is CLAUDE.md then AGENTS.md', INSTRUCTION_FILES, ['CLAUDE.md', 'AGENTS.md']);
check('both present → CLAUDE.md wins', path.basename(resolveInstructionFile(dBoth)), 'CLAUDE.md');
check('only AGENTS.md → AGENTS.md is used', path.basename(resolveInstructionFile(dAgents)), 'AGENTS.md');
check('only CLAUDE.md → unchanged from before', path.basename(resolveInstructionFile(dClaude)), 'CLAUDE.md');
check('neither → CLAUDE.md, so a fresh save gets the default name',
  path.basename(resolveInstructionFile(dNone)), 'CLAUDE.md');
check('the resolved path is absolute and inside the directory asked about',
  resolveInstructionFile(dAgents), path.join(dAgents, 'AGENTS.md'));

// A directory named CLAUDE.md is not an instruction file. statSync().isFile() is what
// rules it out; a bare existsSync() would return the directory and the read would EISDIR.
const dDir = mkdir('dirnamed', { 'AGENTS.md': 'agents side' });
fs.mkdirSync(path.join(dDir, 'CLAUDE.md'), { recursive: true });
check('a DIRECTORY named CLAUDE.md does not shadow a real AGENTS.md',
  path.basename(resolveInstructionFile(dDir)), 'AGENTS.md');

console.log('\n— the system-prompt block —');
check('AGENTS.md alone produces a block', agentsMdPreamble(dAgents).includes('agents side'), true);
check('the block names the file it came from', agentsMdPreamble(dAgents).includes(path.join(dAgents, 'AGENTS.md')), true);
// The suppression cases. Without these a project holding both files hands the model
// the same conventions twice — once via the CLI's CLAUDE.md, once via this block.
check('a CLAUDE.md suppresses the block entirely', agentsMdPreamble(dBoth), '');
check('no AGENTS.md → nothing to add', agentsMdPreamble(dClaude), '');
check('empty directory → nothing to add', agentsMdPreamble(dNone), '');
check('a whitespace-only AGENTS.md is not a block',
  agentsMdPreamble(mkdir('blank', { 'AGENTS.md': '   \n\n\t\n' })), '');
check('a missing directory is not an error', agentsMdPreamble(path.join(ROOT, 'nope')), '');
check('a non-string cwd is not an error', agentsMdPreamble(undefined), '');
check('an empty cwd is not an error', agentsMdPreamble(''), '');

const big = mkdir('big', { 'AGENTS.md': 'x'.repeat(MAX_BYTES + 5000) });
const bigBlock = agentsMdPreamble(big);
check('an oversized AGENTS.md is truncated, not dropped', bigBlock.length > 0, true);
check('truncation is announced in the block', bigBlock.includes('[truncated at'), true);
check('the truncated body stays under the byte cap',
  Buffer.byteLength(bigBlock.slice(bigBlock.indexOf('---\n')), 'utf-8') <= MAX_BYTES + 400, true);

console.log('\n— what actually reaches the spawned process —');
// A stand-in for the claude binary that records its argv and exits. send() gets no
// stream JSON back and reports a failure; that is irrelevant here — argv is the assertion.
const BIN = path.join(ROOT, 'fake-claude');
const ARGV_OUT = path.join(ROOT, 'argv.txt');
// NUL-separated, not newline-separated: the AGENTS.md block being asserted on is
// itself multi-line, so a newline split would chop one argument into several and
// the assertions would read the wrong element.
fs.writeFileSync(BIN, ['#!/bin/sh', ': > "$ARGV_OUT"', 'for a in "$@"; do printf "%s\\0" "$a" >> "$ARGV_OUT"; done', 'exit 0'].join('\n') + '\n');
fs.chmodSync(BIN, 0o755);

function argvFor(cwd, sendOpts) {
  try { fs.rmSync(ARGV_OUT, { force: true }); } catch {}
  process.env.ARGV_OUT = ARGV_OUT;
  const cli = new ClaudeCLI({ cwd, claudeBin: BIN });
  return new Promise((resolve) => {
    const done = () => setTimeout(() => {
      let out = '';
      try { out = fs.readFileSync(ARGV_OUT, 'utf-8'); } catch {}
      resolve(out.split('\0').slice(0, -1));
    }, 60);
    cli.send({ prompt: 'hi', ...sendOpts }).onDone(done).onError(done);
  });
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
}

(async () => {
  const a1 = await argvFor(dAgents, { systemPrompt: 'STUDIO PROMPT' });
  check('AGENTS.md is passed as --append-system-prompt', (flagValue(a1, '--append-system-prompt') || '').includes('agents side'), true);
  // The one that must never regress: --system-prompt REPLACES the CLI default.
  check('AGENTS.md is NOT smuggled into --system-prompt', flagValue(a1, '--system-prompt'), 'STUDIO PROMPT');

  // The task runner spawns with no systemPrompt at all. Before this feature no
  // --system-prompt was passed there; that must still hold, or the CLI's default
  // prompt is replaced by a conventions file.
  const a2 = await argvFor(dAgents, {});
  check('no systemPrompt → --system-prompt still absent', a2.includes('--system-prompt'), false);
  check('no systemPrompt → AGENTS.md still appended', (flagValue(a2, '--append-system-prompt') || '').includes('agents side'), true);

  const a3 = await argvFor(dClaude, { systemPrompt: 'STUDIO PROMPT' });
  check('a CLAUDE.md project passes no --append-system-prompt', a3.includes('--append-system-prompt'), false);

  const a4 = await argvFor(dNone, { systemPrompt: 'STUDIO PROMPT' });
  check('a project with neither file is untouched', a4.includes('--append-system-prompt'), false);

  // Resuming must not change the system prompt — it invalidates thinking-block
  // signatures (API 400). Same guard the existing --system-prompt line has.
  const a5 = await argvFor(dAgents, { systemPrompt: 'STUDIO PROMPT', sessionId: '11111111-2222-3333-4444-555555555555' });
  check('on --resume, no --append-system-prompt', a5.includes('--append-system-prompt'), false);
  check('on --resume, no --system-prompt either (unchanged behaviour)', a5.includes('--system-prompt'), false);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
