import assert from 'node:assert';
import { loadFn } from './_load.mjs';
const f = loadFn('linkifyStandaloneButtons');

// sole-link paragraph → button class added
assert.match(
  f('<p><a href="https://x.com" class="md-link">Open app<span class="ext">↗</span></a></p>'),
  /class="md-link link-btn"/);
// link inside prose → unchanged (stays inline)
const inline = '<p>see <a href="https://x.com" class="md-link">x</a> now</p>';
assert.strictEqual(f(inline), inline);
console.log('PASS standalone-links');
