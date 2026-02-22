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
const FILE_LOCK_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const OUR_HOOKS = {
  PreToolUse: [
    {
      matcher: FILE_LOCK_MATCHER,
      hooks: [{ type: 'command', command: 'bash .claude/scripts/file-lock.sh' }],
    },
  ],
  PostToolUse: [
    {
      matcher: FILE_LOCK_MATCHER,
      hooks: [{ type: 'command', command: 'bash .claude/scripts/file-unlock.sh' }],
    },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if `command` is already present somewhere in the hook list. */
function hasCommand(hookList, command) {
  return hookList.some(entry =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some(h => h.command === command)
  );
}

/** Deep-merge our hooks into existing settings object (mutates `existing`). */
function mergeHooks(existing) {
  if (!existing.hooks) existing.hooks = {};

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

console.log('✓ Claude Code file-lock hooks installed (.claude/settings.json)');
