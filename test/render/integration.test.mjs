import assert from 'node:assert';
import { loadFn } from './_load.mjs';

// constants + UI stubs that renderMd touches but which aren't render logic
globalThis.LIST_CONTINUATION_TOKEN = '\x06LB\x07';
globalThis.t = (k) => k;
globalThis.copyCode = () => {};

// real helpers, resolved as globals by renderMd (loaded from the actual index.html)
for (const fn of ['escH', '_lineIndent', 'isSafeHref', 'reformatInlineNumberedItems',
  'normalizeListContinuations', 'parseListBlock', 'replaceMarkdownLinks',
  'promoteStatusLine', 'parseKeyValueFacts', 'parseAdmonitions', 'autolinkBareUrls',
  'linkifyStandaloneButtons']) {
  globalThis[fn] = loadFn(fn);
}
const renderMd = loadFn('renderMd');

const msg = [
  '# Audit complete',
  '**File:** index.html',
  '**Line:** 4626',
  '',
  '> [!WARNING]',
  '> verify in browser',
  '',
  'See https://core.telegram.org/bots/api and the repo.',
  '',
  '[Open app](http://localhost:3000)',
  '',
  '---',
  '✅ Done — committed 6ad6928',
].join('\n');

const html = renderMd(msg);

assert.match(html, /<div class="status-pill done">.*committed 6ad6928/s, 'status pill');
assert.match(html, /<div class="callout warn">/, 'warning callout');
assert.match(html, /<dl class="kv"><dt>File<\/dt>/, 'kv grid');
assert.match(html, /<a href="https:\/\/core\.telegram\.org\/bots\/api"[^>]*class="md-link"/, 'autolinked bare url');
assert.match(html, /class="md-link link-btn"[^>]*>Open app/, 'standalone button');
assert.match(html, /<h1>Audit complete<\/h1>/, 'headline h1');
// regression: the (1)(2)(3) fix still holds — no false list
assert.ok(!/<ol/.test(renderMd('parts: (1) a, (2) b, (3) c')), 'no false ordered list');
console.log('PASS integration');
process.stdout.write('\n----- rendered HTML -----\n' + html + '\n');
