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
