#!/usr/bin/env node
/**
 * install-hooks.js — postinstall script
 *
 * Merges Claude Code file-lock hooks into .claude/settings.json
 * without overwriting any hooks the user may already have configured.
 *
 * Runs automatically on: npm install
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Resolve project root (works whether run from root or scripts/)
const ROOT         = path.resolve(__dirname, '..');
const SETTINGS_DIR = path.join(ROOT, '.claude');
const SETTINGS     = path.join(SETTINGS_DIR, 'settings.json');
const LOCKS_DIR    = path.join(SETTINGS_DIR, 'locks');

// ── Our hooks to install ──────────────────────────────────────────────────────
// Use Node.js scripts for cross-platform compatibility (macOS, Linux, Windows).
// Node is guaranteed available since this is a Node.js project.
const FILE_LOCK_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const OUR_HOOKS = {
  PreToolUse: [
    {
      matcher: FILE_LOCK_MATCHER,
      hooks: [{ type: 'command', command: 'node .claude/scripts/file-lock.js' }],
    },
  ],
  PostToolUse: [
    {
      matcher: FILE_LOCK_MATCHER,
      hooks: [{ type: 'command', command: 'node .claude/scripts/file-unlock.js' }],
    },
  ],
};

// Legacy commands from older versions — remove on upgrade to prevent duplicates
const LEGACY_COMMANDS = [
  'bash .claude/scripts/file-lock.sh',
  'bash .claude/scripts/file-unlock.sh',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if `command` is already present somewhere in the hook list. */
function hasCommand(hookList, command) {
  return hookList.some(entry =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some(h => h.command === command)
  );
}

/** Remove legacy hook commands that may have been installed by older versions. */
function removeLegacyHooks(existing) {
  if (!existing.hooks) return;
  for (const event of Object.keys(existing.hooks)) {
    if (!Array.isArray(existing.hooks[event])) continue;
    existing.hooks[event] = existing.hooks[event].filter(entry => {
      if (!Array.isArray(entry.hooks)) return true;
      entry.hooks = entry.hooks.filter(h => !LEGACY_COMMANDS.includes(h.command));
      return entry.hooks.length > 0;
    });
  }
}

/** Deep-merge our hooks into existing settings object (mutates `existing`). */
function mergeHooks(existing) {
  if (!existing.hooks) existing.hooks = {};
  removeLegacyHooks(existing);

  for (const [event, entries] of Object.entries(OUR_HOOKS)) {
    if (!existing.hooks[event]) {
      existing.hooks[event] = entries;
      continue;
    }
    for (const entry of entries) {
      const command = entry.hooks[0].command;
      if (!hasCommand(existing.hooks[event], command)) {
        existing.hooks[event].push(entry);
      }
    }
  }
}

// Ensure hook scripts directory exists (scripts are shipped in .claude/scripts/)
function ensureScriptsDir() {
  try {
    fs.mkdirSync(path.join(ROOT, '.claude', 'scripts'), { recursive: true });
  } catch (e) {
    console.warn('[hooks] Could not create scripts dir:', e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// 1. Read existing settings (or start fresh)
let settings = {};
if (fs.existsSync(SETTINGS)) {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    console.warn('[hooks] Could not parse .claude/settings.json — starting fresh.');
  }
}

// 2. Merge
mergeHooks(settings);

// 3. Write back
fs.mkdirSync(SETTINGS_DIR, { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');

// 4. Ensure locks directory exists
fs.mkdirSync(LOCKS_DIR, { recursive: true });
const gitkeep = path.join(LOCKS_DIR, '.gitkeep');
if (!fs.existsSync(gitkeep)) fs.writeFileSync(gitkeep, '');

// 5. Ensure scripts directory exists
ensureScriptsDir();

console.log('✓ Claude Code file-lock hooks installed (.claude/settings.json)');
