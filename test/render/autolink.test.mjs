import assert from 'node:assert';
import { loadFn } from './_load.mjs';
const f = loadFn('autolinkBareUrls');

// bare url becomes an external link
assert.match(f('see https://core.telegram.org/bots/api here'),
  /<a href="https:\/\/core\.telegram\.org\/bots\/api" target="_blank" rel="noopener noreferrer" class="md-link">https:\/\/core\.telegram\.org\/bots\/api<span class="ext">↗<\/span><\/a>/);
// trailing period excluded from the href
assert.match(f('go to https://x.com.'), /https:\/\/x\.com<span/);
assert.ok(f('go to https://x.com.').endsWith('.'));
// balanced paren: keep inner ), drop the wrapping one
assert.match(f('(https://en.wikipedia.org/wiki/Foo_(bar))'),
  /wiki\/Foo_\(bar\)<span/);
// do NOT relink inside an existing <a>
const already = '<a href="https://x.com" class="md-link">x</a>';
assert.strictEqual(f(already), already);
// do NOT linkify inside <code>
assert.strictEqual(f('<code>https://x.com</code>'), '<code>https://x.com</code>');
console.log('PASS autolink');
