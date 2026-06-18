import assert from 'node:assert';
import { loadFn } from './_load.mjs';
const f = loadFn('promoteStatusLine');

// Pill carries the short LABEL; the long summary stays as normal text (no giant pill).
const done = f('body text\n\n---\n✅ Done — committed 14b8a3a and verified');
assert.match(done, /<div class="status-pill done"><span class="sp-ic">✅<\/span>Done<\/div>/);
assert.match(done, /committed 14b8a3a and verified/);          // summary preserved as text
assert.ok(!/sp-ic">✅<\/span>Done — committed/.test(done));     // NOT the old giant-pill form

assert.match(f('---\n❓ Waiting for input — choose'),
  /status-pill wait"><span class="sp-ic">❓<\/span>Waiting for input<\/div>/);
assert.match(f('---\n⏳ In progress — building'),
  /status-pill run"><span class="sp-ic">⏳<\/span>In progress<\/div>/);
assert.match(f('---\n⚠️ Blocked — needs token'), /status-pill warn/);

// no status line → unchanged
assert.strictEqual(f('just a normal message'), 'just a normal message');
// a plain horizontal rule with non-status text below is left intact
assert.strictEqual(f('above\n\n---\nordinary paragraph'), 'above\n\n---\nordinary paragraph');
console.log('PASS status-badge');
