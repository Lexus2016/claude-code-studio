// renderMd carries user text past three internal placeholder tokens built from raw
// control bytes: \x02BLOCK<n>\x03 (fenced code), \x04ICODE<n>\x05 (inline code) and
// \x06LB\x07 (list continuation). extractFences runs at step 1, BEFORE escH at step 2,
// so a literal \x02 in the source is never escaped and reaches the restore step intact.
//
// That made a forged token reachable from ordinary output — a `cat` of a binary file,
// a hexdump in a tool result, anything carrying raw control bytes. The BLOCK restore
// destructured the missing slot and threw an uncaught TypeError out of renderMd; every
// call site is a bare `innerHTML = renderMd(...)`, so in the history path the throw
// aborted the loop and the whole message list stopped rendering.
import { test } from 'node:test';
import assert from 'node:assert';
import { loadFn } from './_load.mjs';

globalThis.LIST_CONTINUATION_TOKEN = '\x06LB\x07';
globalThis.STREAM_CURSOR = '<span class="stream-cursor"></span>';
globalThis.t = (k) => k;
globalThis.copyCode = () => {};
for (const fn of ['extractFences', 'escH', '_lineIndent', 'isSafeHref', 'reformatInlineNumberedItems',
  'normalizeListContinuations', 'parseListBlock', 'replaceMarkdownLinks',
  'promoteStatusLine', 'parseKeyValueFacts', 'parseAdmonitions', 'autolinkBareUrls',
  'linkifyStandaloneButtons']) {
  globalThis[fn] = loadFn(fn);
}
const renderMd = loadFn('renderMd');
globalThis.renderMd = renderMd;               // renderStreaming delegates to it
const renderStreaming = loadFn('renderStreaming');

const forged = {
  'a forged BLOCK token in prose': 'before \x02BLOCK0\x03 after',
  'a forged BLOCK index far past the end': '\x02BLOCK99\x03',
  'a forged BLOCK token after a genuine fence': '```js\nreal\n```\n\n\x02BLOCK5\x03',
  'a forged ICODE token': 'a \x04ICODE0\x05 b',
  'a forged ICODE index far past the end': '\x04ICODE42\x05',
  'a forged list-continuation token': 'a \x06LB\x07 b',
  'several forged tokens at once': '\x02BLOCK1\x03 \x04ICODE1\x05 \x06LB\x07',
};

for (const [label, input] of Object.entries(forged)) {
  test(`renderMd survives ${label}`, () => {
    assert.doesNotThrow(() => renderMd(input));
  });
  test(`renderStreaming survives ${label}`, () => {
    assert.doesNotThrow(() => renderStreaming(input));
  });
}

test('a forged token renders as visible text, not as "undefined"', () => {
  // The ICODE variant did not throw — it rendered the literal word "undefined" inside
  // a <code> element, which is arguably worse: silently wrong instead of loudly broken.
  const out = renderMd('a \x04ICODE0\x05 b');
  assert.doesNotMatch(out, /undefined/);
  const blk = renderMd('before \x02BLOCK0\x03 after');
  assert.doesNotMatch(blk, /undefined/);
  assert.match(blk, /before/);
  assert.match(blk, /after/);
});

test('a genuine fence next to a forged token still renders normally', () => {
  // The guard must not cost the real feature: index 0 is a real block here, 5 is not.
  const out = renderMd('```js\nreal\n```\n\n\x02BLOCK5\x03');
  assert.match(out, /<code id="[a-z0-9]+">real<\/code>/);
  assert.match(out, /<span class="lang">js<\/span>/);
});
