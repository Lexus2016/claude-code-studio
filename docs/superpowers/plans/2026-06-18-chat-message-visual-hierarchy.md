# Chat Message Visual Hierarchy — Implementation Plan

> ✅ **IMPLEMENTED 2026-06-18** — all 8 tasks committed (`ee4622a`→`5a0eef8`), 8/8 node
> tests green, visual verified via real-CSS preview screenshot. Deviations from the
> original plan (applied during execution):
> - **Task 0 loader:** the brace-balancer overran on `renderMd` (regex-heavy body). Replaced
>   with a column-0 closing-brace boundary (`\n}`) — robust for all top-level functions here.
> - **Task 1:** also updated `replaceMarkdownLinks` to emit `class="md-link"` + ↗ so markdown
>   and bare links are identical and feed the Task 2 button detection (gap in original plan).
> - **Task 4 status pill:** split `rest` on the em dash (multi-word labels) and run the
>   transform AFTER `escH` (it emits raw HTML that must not be re-escaped) — the plan's
>   pre-escape integration point and first-word split were both corrected.
> - **Task 6 kv:** runs after `escH`, before bold; added `dl` to the block-tag set.

# Chat Message Visual Hierarchy — Implementation Plan (original)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make assistant chat messages scannable — status badge, headline, callouts, key facts, richer code/tables, and active (external-opening) links — driven only by explicit structure, implemented entirely in `public/index.html`.

**Architecture:** Extend the existing hand-rolled `renderMd()` pipeline with a few small **pure** transforms (`autolinkBareUrls`, `linkifyStandaloneButtons`, `parseAdmonitions`, `promoteStatusLine`) inserted at precise points, plus a CSS pass. No new dependencies, no build step, no WebSocket/SQLite/`claude-cli.js` changes.

**Tech Stack:** Vanilla JS + vanilla CSS in a single-file SPA. Node (for test scripts). Playwright MCP (for the final integration check).

---

## Testing Approach (project-specific — read first)

The project has **no test framework** and `public/index.html` is single-file by mandate,
so functions cannot be `require`d. Each new transform is therefore designed as a **pure,
dependency-free** function and verified by a committed node script that loads the **real
source** out of `index.html` and runs it — zero logic duplication, zero drift:

`test/render/_load.mjs` (built in Task 0) reads `public/index.html`, extracts a named
function via brace-balancing (string/regex/comment aware), and returns it callable.

Integration (correct ordering inside `renderMd`, CSS) is verified once at the end with
Playwright against the running app (Task 8).

Each pure transform MUST be written as a self-contained `function name(text) { … }` with
**no calls to `escH`, `t()`, or other app globals**, so the loader can eval it in isolation.

---

## File Structure

- **Modify:** `public/index.html`
  - New pure helpers added next to `renderMd` (search anchor: `function renderMd(text) {`).
  - Integration calls inside `renderMd`.
  - CSS added in the message-styles block (search anchor: `/* ─── Markdown styles inside .msg ─── */`).
- **Create:** `test/render/_load.mjs` — function-source loader/eval harness.
- **Create:** `test/render/autolink.test.mjs`
- **Create:** `test/render/standalone-links.test.mjs`
- **Create:** `test/render/admonitions.test.mjs`
- **Create:** `test/render/status-badge.test.mjs`

Run tests with: `node test/render/<name>.test.mjs` (exits non-zero on failure).

---

### Task 0: Function-source test harness

**Files:**
- Create: `test/render/_load.mjs`
- Test: `test/render/_load.selftest.mjs`

- [ ] **Step 1: Write the harness**

Create `test/render/_load.mjs`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = join(dirname(fileURLToPath(import.meta.url)), '../../public/index.html');

// Extract a top-level `function NAME(...) { ... }` body from index.html and return it
// as a real callable. Brace-balances while skipping strings, template literals, regex
// literals and comments so braces inside them don't miscount.
export function loadFn(name) {
  const src = readFileSync(HTML, 'utf8');
  const sig = 'function ' + name + '(';
  const at = src.indexOf(sig);
  if (at === -1) throw new Error(`function ${name} not found in index.html`);
  let i = src.indexOf('{', at);
  const bodyStart = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && c2 === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i, c); continue; }
    if (c === '/' && isRegexStart(src, i)) { i = skipRegex(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const body = src.slice(bodyStart, i);             // includes outer braces
  const signature = src.slice(at, bodyStart);       // `function NAME(origParams) ` — keep real params
  // eslint-disable-next-line no-new-func
  return new Function(`return (${signature}${body});`)();
}

function skipString(s, i, q) {
  for (i++; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === q) return i; }
  return i;
}
function skipRegex(s, i) {
  let inClass = false;
  for (i++; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i;
  }
  return i;
}
// A `/` starts a regex (not division) if the previous non-space token is an operator,
// `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `;`, or `return`.
function isRegexStart(s, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j])) j--;
  if (j < 0) return true;
  const prev = s[j];
  if ('(,=:[!&|?{;+-*%<>~^'.includes(prev)) return true;
  if (s.slice(Math.max(0, j - 5), j + 1).match(/\breturn$/)) return true;
  return false;
}
```

- [ ] **Step 2: Write the self-test (proves the harness loads a real existing fn)**

Create `test/render/_load.selftest.mjs`:

```js
import assert from 'node:assert';
import { loadFn } from './_load.mjs';

const isSafeHref = loadFn('isSafeHref'); // existing pure fn in index.html
assert.strictEqual(isSafeHref('https://x.com'), true);
assert.strictEqual(isSafeHref('javascript:alert(1)'), false);
console.log('PASS _load.selftest');
```

- [ ] **Step 3: Run the self-test**

Run: `node test/render/_load.selftest.mjs`
Expected: `PASS _load.selftest` (exit 0). If it throws, fix `_load.mjs` before continuing.

- [ ] **Step 4: Commit**

```bash
git add test/render/_load.mjs test/render/_load.selftest.mjs
git commit -m "test(render): function-source loader harness for single-file index.html"
```

---

### Task 1: Bare-URL autolink (pure helper)

**Files:**
- Modify: `public/index.html` (add `autolinkBareUrls` near `renderMd`)
- Test: `test/render/autolink.test.mjs`

`autolinkBareUrls(html)` runs on the post-markdown HTML string. It linkifies raw
`http(s)://…` runs that are NOT already inside an `<a …>…</a>` or `<code>…</code>` span,
strips trailing sentence punctuation, and balances a trailing `)`.

- [ ] **Step 1: Write the failing test**

Create `test/render/autolink.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/render/autolink.test.mjs`
Expected: throws `function autolinkBareUrls not found in index.html`.

- [ ] **Step 3: Implement the helper**

In `public/index.html`, immediately ABOVE `function renderMd(text) {`, insert:

```js
// Linkify bare http(s) URLs in already-rendered HTML, skipping <a>/<code> regions.
// Pure (no app globals) so it is unit-testable via test/render/_load.mjs.
function autolinkBareUrls(html) {
  // Split into segments, leaving <a…>…</a> and <code>…</code> untouched.
  const parts = html.split(/(<a\b[^>]*>.*?<\/a>|<code\b[^>]*>.*?<\/code>)/gs);
  const URL = /\bhttps?:\/\/[^\s<]+/g;
  return parts.map((seg, idx) => {
    if (idx % 2 === 1) return seg; // protected <a>/<code> segment
    return seg.replace(URL, raw => {
      let url = raw;
      let trail = '';
      // strip trailing sentence punctuation
      const m = url.match(/[.,;:!?]+$/);
      if (m) { trail = m[0]; url = url.slice(0, -trail.length); }
      // drop a single unbalanced trailing ')'
      if (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
        url = url.slice(0, -1); trail = ')' + trail;
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${url}<span class="ext">↗</span></a>${trail}`;
    });
  }).join('');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/render/autolink.test.mjs`
Expected: `PASS autolink`.

- [ ] **Step 5: Integrate into `renderMd`**

In `renderMd`, find the links line `text = replaceMarkdownLinks(text);` and add right after it:

```js
  text = autolinkBareUrls(text);
```

(Markdown links are already `<a>` by now and are skipped; inline code was restored to
`<code>` on the line above and is skipped too.)

- [ ] **Step 6: Add inline-link CSS**

In the `.msg` styles block, the existing `.msg a { … }` rule stays. Add:

```css
.msg a.md-link { color: var(--blue); text-decoration: none; border-bottom: 1px solid rgba(88,166,255,.3); transition: color .15s, border-color .15s; }
.msg a.md-link:hover { color: #a8d0ff; border-bottom-color: var(--blue); }
.msg a.md-link .ext { font-size: .78em; opacity: .7; margin-left: 1px; vertical-align: .05em; }
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html test/render/autolink.test.mjs
git commit -m "feat(ui): autolink bare URLs as external links with ↗ affordance"
```

---

### Task 2: Standalone link → button style

**Files:**
- Modify: `public/index.html` (add `linkifyStandaloneButtons`, integrate, CSS)
- Test: `test/render/standalone-links.test.mjs`

A paragraph whose only content is a single link becomes a button-styled action.

- [ ] **Step 1: Write the failing test**

Create `test/render/standalone-links.test.mjs`:

```js
import assert from 'node:assert';
import { loadFn } from './_load.mjs';
const f = loadFn('linkifyStandaloneButtons');

// sole-link paragraph → button class added
assert.match(
  f('<p><a href="https://x.com" class="md-link">Open app<span class="ext">↗</span></a></p>'),
  /class="md-link link-btn"/);
// link inside prose → unchanged (stays inline)
const inline = '<p>see <a href="https://x.com" class="md-link">x</a> now</p>';
assert.strictEqual(f(inline), inline);
console.log('PASS standalone-links');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/render/standalone-links.test.mjs`
Expected: throws `function linkifyStandaloneButtons not found`.

- [ ] **Step 3: Implement**

Insert above `function renderMd` in `public/index.html`:

```js
// A paragraph that contains exactly one link and nothing else becomes a button action.
// Pure; runs after paragraph wrapping.
function linkifyStandaloneButtons(html) {
  return html.replace(/<p>(<a\b[^>]*\bclass="md-link)("[^>]*>.*?<\/a>)<\/p>/gs, (m, a, b) => {
    // reject if there is any text/other node beside the single <a>
    const inner = m.slice(3, -4); // strip <p> … </p>
    if (!/^<a\b[^>]*>.*<\/a>$/s.test(inner.trim())) return m;
    return `<p>${a} link-btn${b}</p>`;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/render/standalone-links.test.mjs`
Expected: `PASS standalone-links`.

- [ ] **Step 5: Integrate**

In `renderMd`, after the paragraph-assembly line `text = out.join('\n');`, add:

```js
  text = linkifyStandaloneButtons(text);
```

- [ ] **Step 6: Add button CSS**

```css
.msg a.link-btn { display: inline-flex; align-items: center; gap: 7px; border-bottom: none; background: rgba(124,106,239,.12); border: 1px solid rgba(124,106,239,.35); color: var(--accent2); font-size: 13px; font-weight: 600; padding: 5px 12px; border-radius: 8px; }
.msg a.link-btn:hover { background: rgba(124,106,239,.2); border-color: var(--accent); color: #cdbcff; }
.msg a.link-btn .ext { opacity: .8; }
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html test/render/standalone-links.test.mjs
git commit -m "feat(ui): render standalone links as button actions"
```

---

### Task 3: Admonition callouts

**Files:**
- Modify: `public/index.html` (add `parseAdmonitions`, integrate before blockquote merge, CSS)
- Test: `test/render/admonitions.test.mjs`

Supports `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` blocks (one `>`-quoted block, first line
the marker, following `>` lines the body). Maps to 4 visual kinds.

- [ ] **Step 1: Write the failing test**

Create `test/render/admonitions.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/render/admonitions.test.mjs`
Expected: throws `function parseAdmonitions not found`.

- [ ] **Step 3: Implement**

Insert above `function renderMd`:

```js
// GitHub-style admonitions. Operates on HTML-escaped text (lines start with '&gt;').
// Pure. Must run BEFORE the generic blockquote merge so these aren't eaten as quotes.
function parseAdmonitions(text) {
  const KIND = { NOTE: ['info','Note'], TIP: ['success','Tip'], IMPORTANT: ['info','Important'],
                 WARNING: ['warn','Warning'], CAUTION: ['danger','Caution'] };
  return text.replace(/(?:^&gt;[ \t]*\[!(\w+)\][ \t]*\n(?:^&gt;.*\n?)*)/gim, (block, tag) => {
    const k = KIND[tag.toUpperCase()];
    if (!k) return block;                    // unknown marker → leave as-is
    const lines = block.trim().split('\n').map(l => l.replace(/^&gt;[ \t]?/, ''));
    const body = lines.slice(1).join('<br>').trim();
    return `<div class="callout ${k[0]}"><div class="ct">${k[1]}</div>${body}</div>\n`;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/render/admonitions.test.mjs`
Expected: `PASS admonitions`.

- [ ] **Step 5: Integrate**

In `renderMd`, find the blockquote merge line (search anchor `'<blockquote>'` /
`((?:^&gt;\s*.+\n?)+)`) and add, on the line BEFORE it:

```js
  text = parseAdmonitions(text);
```

Then add `div` to the paragraph-wrap `blockTags` regex isn't needed (callout already starts
with `<div`, which `blockTags` matches via `|div`). Confirm `blockTags` contains `div`.

- [ ] **Step 6: Add callout CSS**

```css
.msg .callout { border-left: 3px solid #3a4560; padding: 8px 13px; border-radius: 0 8px 8px 0; margin: 8px 0; font-size: .95em; line-height: 1.6; background: rgba(255,255,255,.018); }
.msg .callout .ct { font-weight: 700; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; margin-bottom: 2px; }
.msg .callout.success { border-left-color: var(--green); background: rgba(63,185,80,.05); } .msg .callout.success .ct { color: #56d364; }
.msg .callout.info { border-left-color: var(--blue); background: rgba(88,166,255,.05); } .msg .callout.info .ct { color: #79b8ff; }
.msg .callout.warn { border-left-color: var(--orange); background: rgba(229,164,53,.06); } .msg .callout.warn .ct { color: #f0b84a; }
.msg .callout.danger { border-left-color: var(--red); background: rgba(248,81,73,.06); } .msg .callout.danger .ct { color: #ff7b72; }
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html test/render/admonitions.test.mjs
git commit -m "feat(ui): GitHub-style admonition callouts in messages"
```

---

### Task 4: Status line → badge pill

**Files:**
- Modify: `public/index.html` (add `promoteStatusLine`, integrate, CSS)
- Test: `test/render/status-badge.test.mjs`

The trailing status line `--- \n ✅ Done — …` (and ❓ ⚠️ ✗ ⏳ variants) is converted to a
pill at the position it already occupies.

- [ ] **Step 1: Write the failing test**

Create `test/render/status-badge.test.mjs`:

```js
import assert from 'node:assert';
import { loadFn } from './_load.mjs';
const f = loadFn('promoteStatusLine');

const done = f('body text\n\n---\n✅ Done — committed 14b8a3a');
assert.match(done, /<div class="status-pill done"><span class="sp-ic">✅<\/span>committed 14b8a3a<\/div>/);
assert.match(f('---\n❓ Waiting for input — choose'), /status-pill wait/);
assert.match(f('---\n⚠️ Heads up'), /status-pill warn/);
// no status line → unchanged
assert.strictEqual(f('just a normal message'), 'just a normal message');
console.log('PASS status-badge');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/render/status-badge.test.mjs`
Expected: throws `function promoteStatusLine not found`.

- [ ] **Step 3: Implement**

Insert above `function renderMd`:

```js
// Promote a trailing status line "--- \n <emoji> <label> — <rest>" into a pill.
// Runs on raw text (before escaping/markdown). Pure.
function promoteStatusLine(text) {
  const MAP = [
    ['done', /^(✅|✓)/], ['wait', /^(❓|⏳ *waiting|🟡)/i], ['warn', /^(⚠️|⚠)/],
    ['err', /^(❌|✗|🔴)/], ['run', /^(⏳|🔄)/],
  ];
  return text.replace(/\n?-{3,}\s*\n\s*(\S.*)$/s, (m, line) => {
    const icon = (line.match(/^\s*(\p{Emoji_Presentation}|\p{Emoji}|[✅✓❓⚠️⚠❌✗⏳🔄🟡🔴])/u) || [,''])[1] || '';
    const rest = line.replace(/^\s*\S+\s*/, '').replace(/^—\s*/, '').trim() || line.trim();
    let kind = 'run';
    for (const [k, re] of MAP) if (re.test(line.trim())) { kind = k; break; }
    return `\n<div class="status-pill ${kind}"><span class="sp-ic">${icon}</span>${rest}</div>`;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/render/status-badge.test.mjs`
Expected: `PASS status-badge`. (If emoji property escapes error on your Node, replace the
`icon` line's regex with the explicit class `/^\s*([✅✓❓⚠️⚠❌✗⏳🔄🟡🔴]+)/`.)

- [ ] **Step 5: Integrate**

In `renderMd`, immediately AFTER `text = reformatInlineNumberedItems(text);` /
`text = normalizeListContinuations(text);` (the pre-processing block near the top), add:

```js
  text = promoteStatusLine(text);
```

Confirm `blockTags` (paragraph-wrap) matches `div` so the pill isn't `<p>`-wrapped.

- [ ] **Step 6: Add pill CSS**

```css
.msg .status-pill { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; letter-spacing: .02em; padding: 5px 12px; border-radius: 8px; margin: 6px 0 2px; }
.msg .status-pill .sp-ic { font-size: 13px; }
.msg .status-pill.done { background: rgba(63,185,80,.16); color: #56d364; border: 1px solid rgba(63,185,80,.3); }
.msg .status-pill.wait { background: rgba(88,166,255,.15); color: #79b8ff; border: 1px solid rgba(88,166,255,.3); }
.msg .status-pill.warn { background: rgba(229,164,53,.15); color: #f0b84a; border: 1px solid rgba(229,164,53,.3); }
.msg .status-pill.err  { background: rgba(248,81,73,.15); color: #ff7b72; border: 1px solid rgba(248,81,73,.3); }
.msg .status-pill.run  { background: rgba(160,141,245,.15); color: #b9a6ff; border: 1px solid rgba(160,141,245,.3); }
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html test/render/status-badge.test.mjs
git commit -m "feat(ui): promote message status line into a colored pill"
```

---

### Task 5: Typography pass — headline, section labels, calm body, inline-code chips

Pure CSS. No JS, no tests beyond the visual check in Task 8.

**Files:** Modify `public/index.html` (CSS only)

- [ ] **Step 1: Add CSS**

In the `.msg` styles block, add (these restyle existing markdown output):

```css
/* first heading of a message = headline */
.msg > h1:first-child, .msg > h2:first-child { font-size: 1.32em; font-weight: 800; letter-spacing: -.01em; color: #f0f4fb; border-bottom: none; margin: 2px 0 10px; padding: 0; }
/* h3/h4 = section labels with hairline rule */
.msg h3 { font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 8px; margin: 16px 0 6px; }
.msg h3::after { content: ''; flex: 1; height: 1px; background: var(--border); }
/* calm body */
.msg p { color: #aebbd4; }
.msg p strong, .msg li strong { color: var(--text); }
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "style(ui): typographic hierarchy for message headline/sections/body"
```

---

### Task 6: Key–value facts block (strict, explicit trigger)

**Files:**
- Modify: `public/index.html` (add `parseKeyValueFacts`, integrate, CSS)
- Test: `test/render/kv.test.mjs`

A run of 2+ consecutive lines each shaped `**Key:** value` becomes a 2-column facts grid.
Strict trigger avoids prose false-positives.

- [ ] **Step 1: Write the failing test**

Create `test/render/kv.test.mjs`:

```js
import assert from 'node:assert';
import { loadFn } from './_load.mjs';
const f = loadFn('parseKeyValueFacts');

const out = f('**File:** index.html\n**Line:** 4626\n**Method:** lookbehind');
assert.match(out, /<dl class="kv">/);
assert.match(out, /<dt>File<\/dt><dd>index\.html<\/dd>/);
// a single such line is NOT a grid (needs 2+)
assert.strictEqual(f('**Note:** one line only'), '**Note:** one line only');
console.log('PASS kv');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/render/kv.test.mjs`
Expected: throws `function parseKeyValueFacts not found`.

- [ ] **Step 3: Implement** (runs on raw text, before bold processing)

Insert above `function renderMd`:

```js
// Convert a run of 2+ "**Key:** value" lines into a key-value grid. Pure.
function parseKeyValueFacts(text) {
  return text.replace(/(?:^\*\*[^*\n]+:\*\*[ \t].+\n?){2,}/gm, block => {
    const rows = block.trim().split('\n').map(l => {
      const m = l.match(/^\*\*([^*\n]+):\*\*[ \t](.+)$/);
      return m ? `<dt>${m[1]}</dt><dd>${m[2]}</dd>` : '';
    }).join('');
    return `<dl class="kv">${rows}</dl>\n`;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/render/kv.test.mjs`
Expected: `PASS kv`.

- [ ] **Step 5: Integrate** — in `renderMd`, after `text = promoteStatusLine(text);`, add:

```js
  text = parseKeyValueFacts(text);
```

Note: this emits raw `<dt>`/`<dd>` before HTML escaping. Since keys/values come from the
model and step 2 escapes remaining HTML, wrap values through the existing escape by placing
this call AFTER `text = escH(text);` instead — adjust the regex to match `**` literally
(unaffected by escaping). Verify against the test, which uses unescaped input; if you move
it post-escape, update the test input to escaped form.

- [ ] **Step 6: Add CSS**

```css
.msg .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 8px 0; font-size: .95em; }
.msg .kv dt { color: var(--muted); }
.msg .kv dd { color: var(--text); margin: 0; font-weight: 600; }
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html test/render/kv.test.mjs
git commit -m "feat(ui): key-value facts grid from **Key:** value runs"
```

---

### Task 7: Regression guard — existing markdown still works

**Files:** Test: `test/render/regression.test.mjs`

- [ ] **Step 1: Write the test** (loads `renderMd` is NOT possible — it has deps; instead
assert the new pure fns leave ordinary prose untouched, the real safety property)

Create `test/render/regression.test.mjs`:

```js
import assert from 'node:assert';
import { loadFn } from './_load.mjs';

const plain = 'Just a normal paragraph with (1) a, (2) b and a word.';
for (const fn of ['promoteStatusLine','parseAdmonitions','parseKeyValueFacts']) {
  assert.strictEqual(loadFn(fn)(plain), plain, `${fn} altered plain prose`);
}
// autolink leaves non-URL prose untouched
assert.strictEqual(loadFn('autolinkBareUrls')('no links here'), 'no links here');
console.log('PASS regression');
```

- [ ] **Step 2: Run** — `node test/render/regression.test.mjs` → `PASS regression`.

- [ ] **Step 3: Commit**

```bash
git add test/render/regression.test.mjs
git commit -m "test(render): guard that new transforms leave plain prose untouched"
```

---

### Task 8: Integration check on the running app (Playwright)

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

Run: `npm run dev` (serves on `PORT`, default 3000). Note the URL.

- [ ] **Step 2: Drive a message through the real renderer**

Using Playwright MCP, open the app, and in the page console evaluate a render of a sample
that exercises every feature, then assert the DOM:

```js
// in browser console via Playwright
const el = document.createElement('div'); el.className = 'msg';
el.innerHTML = renderMd([
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
].join('\n'));
document.body.appendChild(el);
```

Assert present: `.status-pill.done`, `.callout.warn`, `.kv dt`, `a.md-link` (autolinked
bare URL), `a.link-btn` (standalone), and `h1` styled as headline.

- [ ] **Step 3: Visual confirmation**

Screenshot the rendered `.msg`. Confirm: status pill reads "Done", warning callout is amber,
links show ↗, bare URL is clickable, standalone link is a button, body text is calm/muted.

- [ ] **Step 4: Regression spot-check**

Render a plain prose message and a message with `(1) (2) (3)` inline enumeration; confirm no
false lists, no broken links, no stray pills.

---

## Self-Review

**Spec coverage:**
- Status badge → Task 4 ✓ · Headline/section labels/body → Task 5 ✓ · Callouts → Task 3 ✓ ·
  Key-value facts → Task 6 ✓ · Code/tables → unchanged (kept) ✓ · Inline link + autolink → Task 1 ✓ ·
  Button link → Task 2 ✓ · Safe schemes/new tab → Task 1 (reuses `isSafeHref` semantics via `https?` only) ✓ ·
  No prose-importance guessing → all triggers explicit ✓ · Tests per transform → Tasks 0-7 ✓ ·
  Regression guard → Task 7 ✓ · Integration → Task 8 ✓.
- **Gap noted:** "Fact chips" (mono chips from inline-code meta line) from the mockup is folded
  into the key-value grid (Task 6) rather than a separate chip row — simpler, same intent. If a
  distinct chip row is wanted later, add it as a follow-up; not blocking.

**Placeholder scan:** none — every code step shows complete code. Task 6 Step 5 contains an
ordering decision with an explicit instruction + how to adjust the test; resolve it during that
task (not a placeholder, a documented branch).

**Type/name consistency:** helper names used consistently — `autolinkBareUrls`,
`linkifyStandaloneButtons`, `parseAdmonitions`, `promoteStatusLine`, `parseKeyValueFacts`; CSS
classes `md-link`, `link-btn`, `callout {success|info|warn|danger}`, `status-pill {done|wait|warn|err|run}`,
`kv` are the same in tests, JS, and CSS.

**Ordering inside `renderMd` (locked):**
1. `reformatInlineNumberedItems` → `normalizeListContinuations` (existing)
2. `promoteStatusLine` (new)
3. `parseKeyValueFacts` (new — see Task 6 Step 5 for escape ordering)
4. extract code blocks, `escH`, extract inline code (existing)
5. headers/hr; `parseAdmonitions` (new) THEN blockquote merge; lists; tables (existing)
6. inline (bold/italic/code restore), `replaceMarkdownLinks`, `autolinkBareUrls` (new)
7. paragraph wrap, then `linkifyStandaloneButtons` (new)
8. restore code blocks (existing)
