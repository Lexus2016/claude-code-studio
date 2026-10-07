'use strict';

// A real inherited stdout pipe reproduces what an agent's long-running Bash tool
// does: killing only the CLI parent leaves both the tool and onDone alive forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ClaudeCLI = require('../claude-cli');

test('Stop kills a CLI tool process even after its parent exits', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-cli-tree-'));
  const binary = path.join(dir, 'fake-claude');
  const pidFile = path.join(dir, 'tool-pid');
  const readyFile = path.join(dir, 'ready');
  const descendant = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(() => {}, 1000);`;
  fs.writeFileSync(binary, `#!${process.execPath}\nconst child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  let pid;
  const ac = new AbortController();
  let doneCount = 0;
  const run = new ClaudeCLI({ cwd: dir, claudeBin: binary }).send({ prompt: 'run', abortController: ac }).onDone(() => { doneCount++; });
  t.after(async () => {
    ac.abort();
    try { run.process.kill('SIGKILL'); } catch {}
    try { if (pid) process.kill(pid, 'SIGKILL'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const readyUntil = Date.now() + 2500;
  while (!fs.existsSync(readyFile) && Date.now() < readyUntil) await new Promise(resolve => setTimeout(resolve, 20));
  if (fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(fs.existsSync(readyFile), 'the test child must be running before Stop');
  ac.abort();
  const doneUntil = Date.now() + 4500;
  while (!doneCount && Date.now() < doneUntil) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(doneCount, 1, 'a descendant holding stdout must not strand onDone after Stop');
});
