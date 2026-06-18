import assert from 'node:assert';
import { loadFn } from './_load.mjs';
const f = loadFn('parseAdmonitions');

// runs on escaped text where '>' is '&gt;'
const warn = f('&gt; [!WARNING]\n&gt; do not do this\n&gt; really');
assert.match(warn, /<div class="callout warn">/);
assert.match(warn, /<div class="ct">Warning<\/div>/);
assert.match(warn, /do not do this<br>really/);

assert.match(f('&gt; [!NOTE]\n&gt; fyi'), /callout info/);
assert.match(f('&gt; [!TIP]\n&gt; nice'), /callout success/);
assert.match(f('&gt; [!CAUTION]\n&gt; danger'), /callout danger/);

// a plain quote is left for the normal blockquote handler (no callout)
assert.strictEqual(f('&gt; just a quote'), '&gt; just a quote');
console.log('PASS admonitions');
