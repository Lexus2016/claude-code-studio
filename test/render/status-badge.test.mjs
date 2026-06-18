import assert from 'node:assert';
import { loadFn } from './_load.mjs';
const f = loadFn('promoteStatusLine');

const done = f('body text\n\n---\n✅ Done — committed 14b8a3a');
assert.match(done, /<div class="status-pill done"><span class="sp-ic">✅<\/span>committed 14b8a3a<\/div>/);
assert.match(f('---\n❓ Waiting for input — choose'), /status-pill wait/);
assert.match(f('---\n⚠️ Heads up'), /status-pill warn/);
// no status line → unchanged
assert.strictEqual(f('just a normal message'), 'just a normal message');
// a plain horizontal rule with non-status text below is left intact
assert.strictEqual(f('above\n\n---\nordinary paragraph'), 'above\n\n---\nordinary paragraph');
console.log('PASS status-badge');
