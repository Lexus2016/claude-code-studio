import assert from 'node:assert';
import { loadFn } from './_load.mjs';

// One user screenshot showed three failures at once: a <pre> holding a single stray
// backtick, the word `json` leaking out of a block as body text, and a paragraph of prose
// swallowed into a horizontally-scrolling code block. All three came from ONE regex,
// /```(\w*)\r?\n?([\s\S]*?)```/g, which paired fences positionally and ignored run length.
globalThis.LIST_CONTINUATION_TOKEN = '\x06LB\x07';
globalThis.t = (k) => k;
globalThis.copyCode = () => {};
globalThis.STREAM_CURSOR = '<span class="stream-cursor"></span>';
for (const fn of ['escH', '_lineIndent', 'isSafeHref', 'extractFences',
  'reformatInlineNumberedItems', 'normalizeListContinuations', 'parseListBlock',
  'replaceMarkdownLinks', 'promoteStatusLine', 'parseKeyValueFacts', 'parseAdmonitions',
  'autolinkBareUrls', 'linkifyStandaloneButtons']) {
  globalThis[fn] = loadFn(fn);
}
const renderMd = globalThis.renderMd = loadFn('renderMd');
const renderStreaming = loadFn('renderStreaming');
const F = '```', F4 = '````';
const codeOf = html => [...html.matchAll(/<code(?: id="[^"]*")?>([\s\S]*?)<\/code>/g)].map(m => m[1]);

// D1 — a sentence that MENTIONS a fence must not open one, or every paragraph up to the
// next real fence is swallowed into <pre> (and .msg pre code has overflow-x:auto, so the
// user sees prose scrolling sideways).
{
  const html = renderMd(`Wrap it in ${F}json here.\n\nPlain prose paragraph.\n\n${F}json\n{"a": 1}\n${F}\n`);
  assert.match(html, /<p[^>]*>Plain prose paragraph\.<\/p>/, 'D1: prose stays prose');
  assert.deepStrictEqual(codeOf(html), ['{&quot;a&quot;: 1}'], 'D1: exactly one code block');
}

// D2 — a 4-backtick fence wrapping a ```json sample. The old regex took 3 of the 4
// backticks as the opener, so the block held a lone "`" and `json` leaked out as text.
{
  const html = renderMd(`${F4}\n${F}json\n{"ok": true}\n${F}\n${F4}\n\nafter`);
  assert.deepStrictEqual(codeOf(html), [`${F}json\n{&quot;ok&quot;: true}\n${F}`], 'D2: nested sample kept verbatim');
  assert.ok(!/<\/pre>json/.test(html), 'D2: no leaked info string');
  assert.match(html, /<p[^>]*>after<\/p>/, 'D2: tail prose intact');
}

// D2b — CommonMark: the closing fence must be at least as long as the opening one; a
// LONGER run still closes and must not leak its extra backticks into the next paragraph.
{
  const html = renderMd(`${F}js\nconst a = 1;\n${F4}\n\nprose`);
  assert.deepStrictEqual(codeOf(html), ['const a = 1;'], 'D2b: block closes on the longer run');
  assert.ok(!/<\/pre>`/.test(html), 'D2b: no leaked backtick');
}

// D3 — pairing must be stateful, not positional. One stray fence between two real blocks
// used to shift every later pair by one: the second block's OPENING fence became the
// closer of the mention, so "sh" and "echo two" leaked out as prose.
{
  const html = renderMd(`${F}sh\necho one\n${F}\n\nSee ${F}json above.\n\n${F}sh\necho two\n${F}\n\ntail`);
  assert.deepStrictEqual(codeOf(html), ['echo one', 'echo two'], 'D3: both real blocks survive the mention');
  assert.match(html, /<p[^>]*>tail<\/p>/, 'D3: tail prose intact');
}

// D4 — the info string is a whole word, not \w*: ```objective-c used to render as lang
// "objective" with "-c" as the first line of code.
assert.match(renderMd(`${F}objective-c\nNSLog(@"x");\n${F}`), /<span class="lang">objective-c<\/span>/, 'D4: hyphenated lang');

// Inline code: CommonMark's double-backtick form carries a literal backtick.
assert.match(renderMd('Write ``a`b`` inline.'), /<code>a`b<\/code>/, 'inline: ``a`b``');

// A fence inside a list item: normalizeListContinuations runs AFTER extraction now, so the
// body must not contain \x06LB\x07 continuation tokens and must be dedented.
{
  const html = renderMd(`1. Run this:\n   ${F}bash\n   npm test\n   ${F}\n2. Next`);
  assert.deepStrictEqual(codeOf(html), ['npm test'], 'list: clean dedented body');
  assert.ok(!/\x06|\x07/.test(html), 'list: no continuation tokens leaked into <code>');
}

// A fence inside a blockquote keeps its quote and loses the "&gt; " markers.
assert.match(renderMd(`> note:\n> ${F}js\n> x = 1\n> ${F}\n`), /<blockquote[\s\S]*<pre>[\s\S]*<code[^>]*>x = 1<\/code>/, 'quote: real block inside the quote');

// The contract CLAUDE.md pins: copy button + language label survive.
{
  const html = renderMd(`${F}js\nconst x = 1;\n${F}`);
  assert.match(html, /<span class="lang">js<\/span>/, 'lang label');
  assert.match(html, /class="copy-code-btn"/, 'copy button');
}

// Streaming: an unterminated fence renders raw, WITHOUT a copy button, plus the cursor —
// and a mid-sentence ```json must not be mistaken for one (the old parity counter did).
{
  const open = renderStreaming(`text\n\n${F}js\nconst x = 1;\nlet y`);
  assert.match(open, /<code>const x = 1;\nlet y<\/code><\/pre><span class="stream-cursor">/, 'stream: open block raw');
  assert.ok(!/copy-code-btn/.test(open), 'stream: no copy button on an in-flight block');
  const mention = renderStreaming(`use ${F}json here\n\nprose`);
  assert.ok(!/<pre>/.test(mention), 'stream: a mention opens nothing');
}

// The final render is a pure function of the full text — the 100ms throttle cannot change it.
{
  const full = `a\n\n${F}js\nx\n${F}\n\nb`;
  assert.strictEqual(renderMd(full).replace(/cb[a-z0-9]+/g, 'ID'), renderMd(full).replace(/cb[a-z0-9]+/g, 'ID'), 'renderMd is deterministic');
}
console.log('PASS fences');
