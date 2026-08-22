// Markdown tables — steps 3.4 and 3.5 of renderMd, which had NO coverage at all
// despite being the only part of the pipeline that emits a whole HTML subtree.
//
// The load-bearing case is 3.4's inline-header split. Its regex is a nested
// quantifier, `(?:[^|\n]+\|){2,40}`, and the bound is a fix, not a style choice:
// unbounded, a long pipe-heavy line that never reaches a separator row backtracks
// from every start position. Measured O(n^2) — a single 168 KB line took 7.4 s of
// blocked main thread, re-run every 100 ms while such a message streams.
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

test('a standard table becomes thead + tbody', () => {
  const out = renderMd('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(out, /<div class="table-wrap"><table>/);
  assert.match(out, /<thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/);
  assert.match(out, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/);
});

test('step 3.4 splits a header the model left glued to the sentence before it', () => {
  const out = renderMd('Ось таблиця | Підсистема | Стан |\n|---|---|\n| a | b |');
  // the prose must survive as its own paragraph...
  assert.match(out, /<p dir="auto">Ось таблиця<\/p>/);
  // ...and the pipes must become a real header row, not body text
  assert.match(out, /<th>Підсистема<\/th><th>Стан<\/th>/);
});

test('a row that already starts with | is left alone by 3.4', () => {
  // the skip-branch inside the 3.4 callback: without it a legitimate first column
  // would be torn off the table and rendered as a paragraph
  const out = renderMd('| # | Col1 | Col2 |\n|---|---|---|\n| 1 | x | y |');
  assert.match(out, /<thead><tr><th>#<\/th><th>Col1<\/th><th>Col2<\/th><\/tr><\/thead>/);
  assert.doesNotMatch(out, /<p dir="auto">\| #/);
});

test('the separator-first fallback renders a headerless table', () => {
  const out = renderMd('|---|---|\n| 1 | 2 |');
  assert.match(out, /<table><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.doesNotMatch(out, /<thead>/);
});

test('a separator with no data rows is left as text, not an empty table', () => {
  const out = renderMd('|---|---|');
  assert.doesNotMatch(out, /<table>/);
});

test('a header with no body still renders the header', () => {
  const out = renderMd('| A | B |\n|---|---|');
  assert.match(out, /<thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/);
  assert.doesNotMatch(out, /<tbody>/);
});

test('$ sequences in cells are literal, not regex replacement patterns', () => {
  // the replace callbacks return strings; `$&` / `$1` would be substituted if any
  // of them were ever switched to a string replacement
  const out = renderMd('| A | B |\n|---|---|\n| $& | $1 |');
  assert.match(out, /<td>\$&amp;<\/td><td>\$1<\/td>/);
});

test('inline markdown inside cells is still processed', () => {
  const out = renderMd('| A | B |\n|---|---|\n| **x** | [l](http://a.b) |');
  assert.match(out, /<td><strong>x<\/strong><\/td>/);
  assert.match(out, /<a href="http:\/\/a\.b"[^>]*>l/);
});

test('a table inside a fenced code block stays literal', () => {
  const out = renderMd('```\n| A | B |\n|---|---|\n| 1 | 2 |\n```');
  assert.match(out, /<code[^>]*>\| A \| B \|/);
  assert.doesNotMatch(out, /<table>/);
});

test('step 3.4 is linear, not quadratic, on a long pipe-heavy line', () => {
  // REGRESSION GUARD. Input shape: one very long line full of `|` that never reaches
  // a separator row — exactly what a Bash tool dump looks like. With the unbounded
  // quantifier this took ~7.4 s; bounded it is ~30 ms. The assertion is deliberately
  // loose (2 s) so it fails only on a real algorithmic regression, never on a slow CI box.
  const line = 'note | ' + Array.from({ length: 20000 }, (_, i) => 'c' + i).join(' | ') + ' |';
  const t0 = process.hrtime.bigint();
  renderMd(line);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `renderMd took ${ms.toFixed(0)} ms on a ${line.length}-char pipe line — the 3.4 quantifier bound is gone`);
});

test('two tables separated by a blank line stay two tables', () => {
  // The block regex used `\s*`, which matches newlines — so the blank line between
  // two tables was swallowed and both fell into ONE match. The second table's header
  // row and its separator row were then rendered as data cells: <td>B</td>, <td>---</td>.
  const out = renderMd('| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |');
  assert.strictEqual((out.match(/<table>/g) || []).length, 2);
  assert.doesNotMatch(out, /<td>---<\/td>/, 'a separator row leaked in as a data cell');
  assert.doesNotMatch(out, /<td>B<\/td>/, 'the second header leaked in as a data cell');
  assert.match(out, /<thead><tr><th>B<\/th><\/tr><\/thead>/);
});

test('a table still absorbs its own trailing spaces', () => {
  // Negative control for the fix above: `[ \t]*` must keep doing what `\s*` did
  // WITHIN a table — trailing whitespace on a row is not a table boundary.
  const out = renderMd('| A | B |   \n|---|---|  \n| 1 | 2 |  ');
  assert.strictEqual((out.match(/<table>/g) || []).length, 1);
  assert.match(out, /<td>1<\/td><td>2<\/td>/);
});

test('an escaped pipe stays inside its cell', () => {
  // GFM writes a literal pipe in a cell as `\|`. A naive split('|') tore
  // `string \| null` — the ordinary way to write a union type — into two cells and
  // left a dangling backslash, making the row wider than its own header.
  const out = renderMd('| A | B |\n|---|---|\n| a \\| b | c |');
  assert.strictEqual((out.match(/<td>/g) || []).length, 2, 'the row must have exactly 2 cells');
  assert.match(out, /<td>a \| b<\/td><td>c<\/td>/);
  assert.doesNotMatch(out, /<td>a \\<\/td>/, 'the backslash leaked into the cell');
});

test('an escaped BACKSLASH before a real separator still splits the cells', () => {
  // The subtle half of the escaped-pipe rule, and the reason this is a scan rather than
  // a regex split: a lookbehind sees only ONE character back, so it read the pipe in
  // `C:\\| next` — an escaped backslash followed by a REAL separator — as escaped and
  // merged the two cells. An EVEN run of backslashes does not escape what follows it.
  const out = renderMd('| A | B |\n|---|---|\n| C:\\\\| next |');
  assert.strictEqual((out.match(/<td>/g) || []).length, 2);
  assert.match(out, /<td>C:\\<\/td><td>next<\/td>/);
});

test('the {2,40} bound on the 3.4 quantifier is still in the source', () => {
  // A direct pin on the fix: the timing test above would also pass if the whole step
  // were deleted, and a future edit could drop the bound without anyone noticing.
  const src = loadFn('renderMd').toString();
  assert.match(src, /\(\?:\[\^\|\\n\]\+\\\|\)\{2,40\}/);
});
