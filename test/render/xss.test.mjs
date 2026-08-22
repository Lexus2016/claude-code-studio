// Adversarial end-to-end escaping. escH runs at step 4 of renderMd, before any raw
// HTML is generated, and code blocks are escaped a second time on restore — but until
// now nothing pinned that, so a reordering of the pipeline could have removed the
// guarantee silently. Every payload here is fed through the WHOLE renderMd, not
// through escH in isolation, because the pipeline order is the thing under test.
//
// Model output is attacker-influenced in practice: it echoes file contents, web pages,
// tool results and user text. Treat it as untrusted.
import { test } from 'node:test';
import assert from 'node:assert';
import { loadFn } from './_load.mjs';

globalThis.LIST_CONTINUATION_TOKEN = '\x06LB\x07';
globalThis.t = (k) => k;
globalThis.copyCode = () => {};
for (const fn of ['extractFences', 'escH', '_lineIndent', 'isSafeHref', 'reformatInlineNumberedItems',
  'normalizeListContinuations', 'parseListBlock', 'replaceMarkdownLinks',
  'promoteStatusLine', 'parseKeyValueFacts', 'parseAdmonitions', 'autolinkBareUrls',
  'linkifyStandaloneButtons']) {
  globalThis[fn] = loadFn(fn);
}
const renderMd = loadFn('renderMd');

// No live <script> element, and no event-handler attribute, anywhere in the output.
// Checked structurally: an escaped `&lt;script&gt;` is text and passes; a real tag fails.
function assertInert(out, label) {
  // The renderer emits exactly one handler of its own — the code-block copy button,
  // which CLAUDE.md pins as part of the contract. Strip that known-good markup first,
  // then require that NOTHING else in the output carries an event handler. Whitelisting
  // the literal button rather than the attribute name keeps the check adversarial.
  const stripped = out.replace(/<button class="copy-code-btn" onclick="copyCode\('[a-z0-9]+',this\)">/g, '<button>');
  assert.doesNotMatch(stripped, /<script/i, `${label}: emitted a live <script> tag`);
  assert.doesNotMatch(stripped, /<[a-z][^>]*\son[a-z]+\s*=/i, `${label}: emitted an event-handler attribute`);
  out = stripped;
  // <svg> is deliberately NOT in this list: the blockquote renderer emits its own
  // decorative quote icon as inline SVG. An injected <svg onload=…> is still caught,
  // by the event-handler assertion above.
  assert.doesNotMatch(out, /<iframe|<object|<embed/i, `${label}: emitted an embedding tag`);
  assert.doesNotMatch(out, /(?:href|src)\s*=\s*["']?\s*javascript:/i, `${label}: emitted a javascript: URL`);
}

const payloads = {
  'raw script tag': '<script>alert(1)</script>',
  'img onerror': '<img src=x onerror=alert(1)>',
  'anchor with inline handler': '<a href="x" onmouseover="alert(1)">y</a>',
  'svg onload': '<svg onload=alert(1)>',
  'iframe srcdoc': '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  'body onload': '<body onload=alert(1)>',
  'markdown link, javascript scheme': '[click](javascript:alert(1))',
  'markdown link, mixed case scheme': '[click](JaVaScRiPt:alert(1))',
  'markdown link, leading whitespace': '[click](  javascript:alert(1))',
  'markdown link, entity-encoded scheme': '[click](java&#115;cript:alert(1))',
  'markdown link, data: html': '[click](data:text/html,<script>alert(1)</script>)',
  'markdown link, vbscript scheme': '[click](vbscript:msgbox(1))',
  'markdown image, javascript scheme': '![x](javascript:alert(1))',
  'bare javascript: url': 'javascript:alert(1)',
  'url with a quote break-out': 'http://x.com" onmouseover="alert(1)',
  'payload inside a fenced block': '```\n</script><img onerror=alert(1) src=x>\n```',
  'payload inside inline code': '`<img src=x onerror=alert(1)>`',
  'payload inside a table cell': '| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | y |',
  'payload inside a blockquote': '> <img src=x onerror=alert(1)>',
  'payload inside a list item': '- <script>alert(1)</script>',
  'payload inside a heading': '# <img src=x onerror=alert(1)>',
  'payload inside an admonition': '> [!WARNING]\n> <script>alert(1)</script>',
  'payload in a key-value fact': '**File:** <script>alert(1)</script>',
  'attribute break-out via title': '[x](http://a.b "onmouseover=alert(1)")',
};

for (const [label, payload] of Object.entries(payloads)) {
  test(`inert: ${label}`, () => {
    assertInert(renderMd(payload), label);
  });
}

test('the escaping is real, not an artefact of the payload being dropped', () => {
  // Positive control. If renderMd silently swallowed input, every test above would
  // pass while proving nothing — so assert the text is present AND escaped.
  const out = renderMd('<img src=x onerror=alert(1)>');
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('code blocks are escaped on restore, not just on the way in', () => {
  const out = renderMd('```js\n<script>alert(1)</script>\n```');
  assert.match(out, /&lt;script&gt;/);
  assertInert(out, 'fenced');
});

test('a safe link still renders as a link with the hardened rel', () => {
  // Negative control for isSafeHref: over-blocking would be its own bug.
  const out = renderMd('[ok](https://example.com)');
  assert.match(out, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer"/);
});
