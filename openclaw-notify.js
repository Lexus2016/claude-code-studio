/**
 * openclaw-notify.js — Send notifications through OpenClaw → Discord
 * Uses `openclaw message send` CLI to deliver notifications.
 */
'use strict';
const { execFile } = require('child_process');

const NOTIFY_ENABLED = process.env.OPENCLAW_NOTIFY !== 'false';
const DISCORD_CHANNEL = process.env.OPENCLAW_NOTIFY_CHANNEL || '1479520243385765888'; // Claude Studio thread

function notify(text) {
  if (!NOTIFY_ENABLED) return;
  try {
    execFile('openclaw', [
      'message', 'send',
      '--channel', 'discord',
      '--target', DISCORD_CHANNEL,
      '--message', text
    ], { timeout: 30000 }, (err) => {
      if (err) console.error('[openclaw-notify] Failed:', err.message);
    });
  } catch (e) {
    console.error('[openclaw-notify] Error:', e.message);
  }
}

function taskStarted(task) {
  const model = task.model || 'sonnet';
  const phase = (task.notes || '').match(/\[bmad-phase:(\w+)\]/)?.[1] || '';
  const phaseLabel = phase ? ` → ${phase.replace('bmad_', '').toUpperCase()}` : '';
  notify(`🚀 **Task Started**${phaseLabel}: ${task.title}\n📁 Model: ${model}`);
}

function taskCompleted(task, durationMs) {
  const mins = Math.round((durationMs || 0) / 60000);
  const phase = (task.notes || '').match(/\[bmad-phase:(\w+)\]/)?.[1] || '';
  const phaseLabel = phase ? ` (${phase.replace('bmad_', '')})` : '';
  notify(`✅ **Task Done**${phaseLabel}: ${task.title}\n⏱️ ${mins}min`);
}

function taskFailed(task, reason) {
  notify(`❌ **Task Failed**: ${task.title}\n💬 ${(reason || 'Unknown error').substring(0, 200)}`);
}

function progressSummary(projectName, stats) {
  const lines = [
    `📊 **Sprint Progress — ${projectName}**`,
    `Backlog: ${stats.backlog} · Todo: ${stats.todo} · Active: ${stats.active} · Done: ${stats.done}`,
    `Progress: ${stats.done}/${stats.total} (${Math.round(stats.done/Math.max(stats.total,1)*100)}%)`,
  ];
  if (stats.recentlyCompleted?.length) {
    lines.push(`\nRecently completed:`);
    for (const t of stats.recentlyCompleted.slice(0, 5)) {
      lines.push(`  ✅ ${t}`);
    }
  }
  notify(lines.join('\n'));
}

module.exports = { notify, taskStarted, taskCompleted, taskFailed, progressSummary };
