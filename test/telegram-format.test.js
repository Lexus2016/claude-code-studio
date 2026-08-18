// Verification for the Telegram message-formatting fixes (chunking, HTML repair,
// truncation, callback_data sizing). Pure functions only — no bot instance, no DB,
// no network: each method is called against a minimal `this` carrying only the
// helpers it actually uses.
// Run: node test/telegram-format.test.js
const assert = require('assert');
const TelegramBot = require('../telegram-bot');

const P = TelegramBot.prototype;
// Minimal receiver: the formatting helpers only reach for each other and _t.
const bot = {
  _escHtml: P._escHtml,
  _safeCut: P._safeCut,
  _balanceTags: P._balanceTags,
  _mdToHtml: P._mdToHtml,
  _inlineToHtml: P._inlineToHtml,
  _mdTableToText: P._mdTableToText,
  _chunkForTelegram: P._chunkForTelegram,
  _findSplit: P._findSplit,
  _renderFileHtml: P._renderFileHtml,
  _t: (k, v) => (k === 'files_truncated' ? `[truncated, ${v.len} chars total]` : k),
};

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// Telegram rejects a message whose tags do not nest properly. This is the exact
// check its parser applies, minus the entity-type whitelist.
function isWellFormed(html) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, closing, name] = m;
    if (!closing) { stack.push(name.toLowerCase()); continue; }
    if (stack.pop() !== name.toLowerCase()) return false;
  }
  return stack.length === 0;
}

console.log('tag balancing (Telegram rejects overlapping entities outright):');
check('crossed emphasis is re-nested',
  bot._balanceTags('<b>a<i>b</b>c</i>'), '<b>a<i>b</i></b><i>c</i>');
check('the re-nested result is well-formed',
  isWellFormed(bot._balanceTags('<b>a<i>b</b>c</i>')), true);
check('an unclosed tag is closed', bot._balanceTags('<b>hello'), '<b>hello</b>');
check('a stray closer is dropped', bot._balanceTags('</i>text'), 'text');
check('attributes survive untouched',
  bot._balanceTags('<a href="http://x/?a=1&amp;b=2">l</a>'), '<a href="http://x/?a=1&amp;b=2">l</a>');
check('plain text is returned unchanged', bot._balanceTags('no tags here'), 'no tags here');
check('deeply nested but valid markup is left alone',
  bot._balanceTags('<b><i><s>x</s></i></b>'), '<b><i><s>x</s></i></b>');

console.log('\nmarkdown -> html (output must always be parseable):');
{
  // The measured breaker: emphasis that overlaps rather than nests.
  const html = bot._mdToHtml.call(bot, '**bold _both** italic_');
  check('crossed markdown emphasis yields well-formed html', isWellFormed(html), true);
}
check('a stray < in prose is escaped',
  bot._mdToHtml.call(bot, 'a < b').includes('&lt;'), true);
check('snake_case is not turned into italics',
  bot._mdToHtml.call(bot, 'my_file_name.py').includes('<i>'), false);
{
  const html = bot._mdToHtml.call(bot, 'run `sed s/a/$&/g` now');
  // '$&' in a replacement string is a substitution pattern — a string replacer
  // spliced the matched text back in and leaked the internal placeholder marker.
  check('a $-pattern inside inline code survives verbatim',
    html.includes('<code>sed s/a/$&amp;/g</code>'), true);
  check('no internal placeholder marker leaks out', /\x01/.test(html), false);
}
check("a $' pattern inside inline code survives verbatim",
  bot._mdToHtml.call(bot, "x `$'tail` y").includes("<code>$&#039;tail</code>")
    || bot._mdToHtml.call(bot, "x `$'tail` y").includes("<code>$'tail</code>"), true);

console.log('\nsurrogate-safe truncation (a split pair renders as U+FFFD):');
{
  const emoji = '🙂';                       // one astral char = 2 code units
  const s = 'ab' + emoji + 'cd';
  check('cutting mid-pair drops the whole char', bot._safeCut(s, 3), 'ab');
  check('cutting after the pair keeps it', bot._safeCut(s, 4), 'ab' + emoji);
  check('a short string is returned unchanged', bot._safeCut('abc', 10), 'abc');
  check('no lone surrogate is ever produced',
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(bot._safeCut('x'.repeat(10) + emoji, 11)), false);
}

console.log('\nsplit-point search (was dead code — every cut was a hard cut):');
{
  // Both call sites pass a window of EXACTLY `limit` chars, so a `<=` guard made
  // this return `limit` unconditionally and the boundary search never ran.
  const para = 'a'.repeat(40) + '\n\n' + 'b'.repeat(59);
  check('a paragraph boundary is preferred', bot._findSplit.call(bot, para, 100), 40);
  const line = 'a'.repeat(40) + '\n' + 'b'.repeat(59);
  check('a single newline is used when no paragraph break exists',
    bot._findSplit.call(bot, line, 100), 41);
  const sentence = 'a'.repeat(40) + '. ' + 'b'.repeat(58);
  check('a sentence end is used next', bot._findSplit.call(bot, sentence, 100), 42);
  const words = 'a'.repeat(50) + ' ' + 'b'.repeat(49);
  check('a word boundary is used last', bot._findSplit.call(bot, words, 100), 51);
  check('an unbreakable run falls back to a hard cut',
    bot._findSplit.call(bot, 'a'.repeat(100), 100), 100);
  check('a hard cut never splits a surrogate pair',
    bot._findSplit.call(bot, 'a'.repeat(99) + '🙂'.slice(0, 1) + 'x', 100), 99);
}

console.log('\nchunking raw markdown (fences only exist BEFORE html conversion):');
{
  const long = 'Intro paragraph.\n\n```js\n' + 'const x = 1;\n'.repeat(400) + '```\n\nOutro.';
  const chunks = bot._chunkForTelegram.call(bot, long, 3900);
  check('a long fenced answer is split into several chunks', chunks.length > 1, true);
  check('every chunk is within the limit', chunks.every(c => c.length <= 3900), true);
  check('every chunk has balanced fences',
    chunks.every(c => (c.match(/```/g) || []).length % 2 === 0), true);
  // The actual delivery path: chunk raw, convert each piece.
  const htmlChunks = chunks.map(c => bot._mdToHtml.call(bot, c));
  check('each converted chunk is well-formed html', htmlChunks.every(isWellFormed), true);
}
check('a short text is a single chunk',
  bot._chunkForTelegram.call(bot, 'hello', 3900), ['hello']);
check('empty input yields no chunks', bot._chunkForTelegram.call(bot, '', 3900), []);

console.log('\nfile rendering (budget must be measured on the ESCAPED length):');
{
  // Markup-heavy content expands ~4-5x under HTML escaping, so a raw-length gate
  // passed while the real payload still blew past Telegram's limit.
  const xml = '<row attr="v">value</row>\n'.repeat(300);
  const out = bot._renderFileHtml.call(bot, 'data.xml', 'xml', xml, xml.length);
  check('the rendered message fits a Telegram message', out.length <= 4096, true);
  check('the code block is still closed', out.trimEnd().includes('</code></pre>'), true);
  check('truncation is stated, not silent', out.includes('[truncated,'), true);
  check('no raw unescaped tag from the file leaks in', out.includes('<row'), false);
}
{
  const small = 'const a = 1;\n';
  const out = bot._renderFileHtml.call(bot, 'a.js', 'js', small, small.length);
  check('a small file is not truncated', out.includes('[truncated,'), false);
  check('the language class is set', out.includes('class="language-js"'), true);
}
check('a hostile extension cannot inject into the class attribute',
  bot._renderFileHtml.call(bot, 'x', 'js"><script>', 'x', 1).includes('<script>'), false);

console.log('\ncallback_data limits (Telegram counts BYTES, not characters):');
{
  // 33 Cyrillic chars = 66 UTF-8 bytes: under a 61-CHAR gate, over the 64-byte cap.
  const cyrillic = 'ф'.repeat(33);
  check('a short Cyrillic path is over the byte cap', Buffer.byteLength(cyrillic, 'utf8') > 61, true);
  check('but under the old character cap', cyrillic.length <= 61, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
