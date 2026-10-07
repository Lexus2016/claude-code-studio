'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { isStudioUrl, isTrustedSender } = require('../electron/navigation-policy');
const port = 43123;
const origin = `http://127.0.0.1:${port}`;
for (const suffix of ['', '/', '/kanban', '/?q=test', '/#chat']) {
  assert.equal(isStudioUrl(origin + suffix, port), true);
}
for (const url of ['https://example.com', `http://127.0.0.1:${port + 1}/`, `${origin}@evil.example/`, `http://evil@127.0.0.1:${port}/`, `http://localhost:${port}/`, 'file:///tmp/index.html', 'data:text/html,test', 'javascript:alert(1)', 'invalid']) {
  assert.equal(isStudioUrl(url, port), false, url);
}
assert.equal(isStudioUrl(origin, null), false);
assert.equal(isTrustedSender({ senderFrame: { url: origin, parent: null } }, port), true);
assert.equal(isTrustedSender({ senderFrame: { url: origin, parent: {} } }, port), false);
assert.equal(isTrustedSender({ senderFrame: { url: 'https://example.com', parent: null } }, port), false);
assert.equal(isTrustedSender({}, port), false);

// Exercise the actual installed policy without needing Electron or a display.
const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const policy = main.slice(main.indexOf('function applyWindowOpenPolicy('), main.indexOf('\nasync function createWindow'));
const external = [];
const context = { serverPort: port, isStudioUrl, path, __dirname: path.join(__dirname, '../electron'), shell: { openExternal: url => external.push(url) } };
vm.runInNewContext(`${policy}; this.applyPolicy = applyWindowOpenPolicy;`, context);
function contents() {
  const wc = new EventEmitter();
  wc.setWindowOpenHandler = handler => { wc.open = handler; };
  return wc;
}
const wc = contents();
context.applyPolicy(wc);
assert.equal(wc.open({ url: origin + '/kanban' }).action, 'allow');
assert.equal(wc.open({ url: 'https://example.com' }).action, 'deny');
assert.equal(external.pop(), 'https://example.com');
for (const eventName of ['will-navigate', 'will-redirect']) {
  let blocked = false;
  wc.emit(eventName, { preventDefault() { blocked = true; } }, origin + '/');
  assert.equal(blocked, false);
  wc.emit(eventName, { preventDefault() { blocked = true; } }, 'https://example.com');
  assert.equal(blocked, true);
  assert.equal(external.pop(), 'https://example.com');
  blocked = false;
  wc.emit(eventName, { preventDefault() { blocked = true; } }, 'file:///tmp/evil.html');
  assert.equal(blocked, true);
  assert.equal(external.length, 0);
}
const child = contents();
wc.emit('did-create-window', { webContents: child });
assert.equal(child.listenerCount('will-navigate'), 1);
assert.equal(child.open({ url: 'https://example.com' }).action, 'deny');
for (const channel of ['update:check', 'update:start', 'app:getVersion']) {
  const handler = main.slice(main.indexOf(`ipcMain.handle('${channel}'`)).split('\n});')[0];
  assert.match(handler, /isTrustedSender\(event, serverPort\)/, channel);
}
console.log('Electron navigation and IPC boundary regressions passed');
