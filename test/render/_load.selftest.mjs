import assert from 'node:assert';
import { loadFn } from './_load.mjs';

const isSafeHref = loadFn('isSafeHref'); // existing pure fn in index.html
assert.strictEqual(isSafeHref('https://x.com'), true);
assert.strictEqual(isSafeHref('javascript:alert(1)'), false);
console.log('PASS _load.selftest');
