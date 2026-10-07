'use strict';

// Fake only the subprocess, retaining real filesystem staging and event handling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const children = [];
class FakeProcess extends EventEmitter {
  constructor(args) {
    super();
    this.args = args;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { end() {} };
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
  }
  kill(signal) {
    this.signals.push(signal);
    this.signalCode = signal;
    setImmediate(() => this.emit('close', null));
  }
}
const originalSpawn = childProcess.spawn;
childProcess.spawn = (_bin, args) => {
  const child = new FakeProcess(args);
  children.push(child);
  return child;
};
const ClaudeCLI = require('../claude-cli');
childProcess.spawn = originalSpawn;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-cli-runtime-'));
test.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

function file(name, data) {
  return { type: 'file', source: { name, media_type: 'text/plain', data: Buffer.from(data).toString('base64') } };
}
function start(t, contentBlocks, abortController) {
  const run = new ClaudeCLI({ cwd, claudeBin: 'fake-claude' }).send({ prompt: 'read files', contentBlocks, abortController });
  const child = children.at(-1);
  t.after(() => child.emit('close', 0));
  const prompt = child.args[child.args.indexOf('-p') + 1];
  return { run, child, files: [...prompt.matchAll(/^- (.+)$/gm)].map(m => m[1]) };
}

test('same-named attachments retain independent bytes', t => {
  const { files } = start(t, [file('report.txt', 'first'), file('report.txt', 'second')]);
  assert.equal(new Set(files).size, 2);
  assert.deepEqual(files.map(f => fs.readFileSync(f, 'utf8')), ['first', 'second']);
});

test('filenames that sanitize identically retain independent bytes', t => {
  const { files } = start(t, [file('a?.txt', 'first'), file('a*.txt', 'second')]);
  assert.equal(new Set(files).size, 2);
  assert.deepEqual(files.map(f => fs.readFileSync(f, 'utf8')), ['first', 'second']);
});

test('an ordinal does not make a valid long attachment name exceed filesystem limits', t => {
  const { files } = start(t, [file('a'.repeat(250) + '.txt', 'long name')]);
  assert.equal(fs.readFileSync(files[0], 'utf8'), 'long name');
  assert.equal(path.extname(files[0]), '.txt');
});

test('simultaneous runs never share staging directories or cleanup', t => {
  const originalNow = Date.now;
  let first, second;
  try {
    Date.now = () => 2345678901234;
    first = start(t, [file('report.txt', 'one')]);
    second = start(t, [file('report.txt', 'two')]);
  } finally { Date.now = originalNow; }
  assert.notEqual(path.dirname(first.files[0]), path.dirname(second.files[0]));
  first.child.emit('close', 0);
  assert.equal(fs.existsSync(first.files[0]), false);
  assert.equal(fs.readFileSync(second.files[0], 'utf8'), 'two');
});

test('an already-aborted turn stops and settles exactly once', async t => {
  const ac = new AbortController();
  ac.abort();
  const { run, child } = start(t, [], ac);
  let done = 0;
  run.onDone(() => { done++; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(child.signals[0], 'SIGTERM');
  assert.equal(done, 1);
});

test('attachment metadata cannot create path segments', () => {
  const { attachmentFileName } = require('../attachment-files');
  for (const name of ['', '..', '../report.txt', 'a?.txt', 'a*.txt']) {
    for (const mediaType of ['text/plain', 'image/../../outside', 'image/png; charset=utf8', null]) {
      const filename = attachmentFileName({ name, mediaType, type: 'file' }, 0);
      assert.equal(path.basename(filename), filename);
      assert.match(filename, /^1-[a-zA-Z0-9._-]+$/);
    }
  }
});

test('SSH uploads duplicate attachments to distinct remote paths', async () => {
  class FakeClient extends EventEmitter {
    connect() { setImmediate(() => this.emit('ready')); }
    end() { setImmediate(() => this.emit('close')); }
    exec(_cmd, _opts, cb) {
      const stream = new EventEmitter();
      stream.stdout = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.stdin = { end() {} };
      cb(null, stream);
      setImmediate(() => stream.emit('close', 0));
    }
  }
  const sshPath = require.resolve('ssh2');
  const previous = require.cache[sshPath];
  require.cache[sshPath] = { id: sshPath, filename: sshPath, loaded: true, exports: { Client: FakeClient } };
  const ClaudeSSH = require('../claude-ssh');
  if (previous) require.cache[sshPath] = previous;
  else delete require.cache[sshPath];
  const ssh = new ClaudeSSH({ host: 'user@example.invalid', workdir: '/project', password: 'test' });
  const uploads = new Map();
  ssh._execText = async () => '/tmp/claude-att-unique';
  ssh._openSftp = async () => ({});
  ssh._uploadBuffer = async (_sftp, filename, buffer) => { uploads.set(filename, buffer.toString()); };
  const errors = [];
  await new Promise(resolve => {
    ssh.send({ prompt: 'read', contentBlocks: [file('report.txt', 'first'), file('report.txt', 'second')] })
      .onError(e => errors.push(e)).onDone(resolve);
  });
  assert.deepEqual(errors, []);
  assert.equal(uploads.size, 2);
  assert.deepEqual([...uploads.values()], ['first', 'second']);
  assert.ok([...uploads.keys()].every(filename => path.posix.dirname(filename) === '/tmp/claude-att-unique'));
});
