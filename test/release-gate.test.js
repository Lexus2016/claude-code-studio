'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { test } = require('node:test');
function workflow(name) { return yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows',name),'utf8')); }
test('reusable CI tests the exact caller commit across both SQLite runtimes',()=>{
  const ci=workflow('ci.yml');assert.ok(Object.hasOwn(ci.on,'workflow_call'));
  assert.deepEqual(ci.jobs.test.strategy.matrix.node,[20,24]);
  const steps=ci.jobs.test.steps;
  assert.equal(steps.find(s=>s.uses?.startsWith('actions/checkout@')).with.ref,'${{ github.sha }}');
  assert.ok(steps.some(s=>s.run==='npm ci'));
  assert.ok(steps.some(s=>s.run==='npm test'));
  assert.ok(steps.some(s=>s.run?.includes('apt-get install -y tmux')));
  assert.ok(!steps.some(s=>s['continue-on-error']));
});
for(const [file,job]of [['release.yml','release'],['release-desktop.yml','build']])test(`${file} cannot publish before exact-commit CI succeeds`,()=>{
  const w=workflow(file);assert.equal(w.jobs.verify.uses,'./.github/workflows/ci.yml');
  assert.equal(w.jobs.verify.permissions.contents,'read');assert.equal(w.jobs[job].needs,'verify');
  assert.ok(!w.jobs.verify['continue-on-error']);assert.ok(!w.jobs[job].if?.includes('always()'));
  assert.equal(w.jobs[job].steps.find(s=>s.uses?.startsWith('actions/checkout@')).with.ref,'${{ github.sha }}');
});
