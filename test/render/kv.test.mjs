import assert from 'node:assert';
import { loadFn } from './_load.mjs';
const f = loadFn('parseKeyValueFacts');

const out = f('**File:** index.html\n**Line:** 4626\n**Method:** lookbehind');
assert.match(out, /<dl class="kv">/);
assert.match(out, /<dt>File<\/dt><dd>index\.html<\/dd>/);
assert.match(out, /<dt>Line<\/dt><dd>4626<\/dd>/);
// a single such line is NOT a grid (needs 2+)
assert.strictEqual(f('**Note:** one line only'), '**Note:** one line only');
// ordinary bold in prose is untouched
assert.strictEqual(f('this is **bold** text'), 'this is **bold** text');
console.log('PASS kv');
