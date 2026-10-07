'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-install-hooks-'));
try {
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '../scripts/install-hooks.js'), path.join(root, 'scripts/install-hooks.js'));
  const run = () => spawnSync(process.execPath, ['scripts/install-hooks.js'], { cwd: root, encoding: 'utf8' });
  const settingsPath = path.join(root, '.claude/settings.json');
  let result = run();
  assert.equal(result.status, 0);
  assert.match(result.stderr, /missing/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)).hooks, {});
  const userHook = { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo user-owned' }] };
  fs.writeFileSync(settingsPath, JSON.stringify({ custom: true, hooks: { PreToolUse: [userHook, { hooks: [{ command: 'node .claude/scripts/file-lock.js' }] }] } }));
  assert.equal(run().status, 0);
  let settings = JSON.parse(fs.readFileSync(settingsPath));
  assert.equal(settings.custom, true);
  assert.deepEqual(settings.hooks.PreToolUse, [userHook]);
  for (const filename of ['file-lock.js', 'file-unlock.js']) fs.writeFileSync(path.join(root, '.claude/scripts', filename), '// shipped script\n');
  assert.equal(run().status, 0);
  settings = JSON.parse(fs.readFileSync(settingsPath));
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)), settings);
  for (const raw of ['{broken', 'null', '[]', '{"hooks":[]}', '{"hooks":{"PreToolUse":null}}', '{"hooks":{"PreToolUse":[null]}}']) {
    fs.writeFileSync(settingsPath, raw);
    assert.equal(run().status, 1);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), raw);
  }
  console.log('Hook installer asset, preservation, idempotence and malformed-settings regressions passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
