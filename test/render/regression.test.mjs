import assert from 'node:assert';
import { loadFn } from './_load.mjs';

const plain = 'Just a normal paragraph with (1) a, (2) b and a word.';
for (const fn of ['promoteStatusLine', 'parseAdmonitions', 'parseKeyValueFacts']) {
  assert.strictEqual(loadFn(fn)(plain), plain, `${fn} altered plain prose`);
}
// autolink / button helpers leave non-matching input untouched
assert.strictEqual(loadFn('autolinkBareUrls')('no links here'), 'no links here');
assert.strictEqual(loadFn('linkifyStandaloneButtons')('<p>plain paragraph</p>'), '<p>plain paragraph</p>');
console.log('PASS regression');
