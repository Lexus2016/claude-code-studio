import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = join(dirname(fileURLToPath(import.meta.url)), '../../public/index.html');

// Extract a top-level `function NAME(...) { ... }` body from index.html and return it
// as a real callable. Brace-balances while skipping strings, template literals, regex
// literals and comments so braces inside them don't miscount.
// Extract a top-level `function NAME(...) { ... }` from index.html and return it as a
// real callable. Top-level functions in this single file always close with a brace at
// column 0 ("\n}"); inner braces are indented. That boundary is far more robust than
// brace-balancing across regex/template-literal soup.
export function loadFn(name) {
  const src = readFileSync(HTML, 'utf8');
  const sig = 'function ' + name + '(';
  let at = src.indexOf(sig);
  if (at === -1) throw new Error(`function ${name} not found in index.html`);
  // Keep a leading `async ` — without it `await` in the body is a SyntaxError.
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  const open = src.indexOf('{', at);
  const rel = src.slice(open).search(/\n\}/);   // first column-0 closing brace
  if (rel === -1) throw new Error(`end of function ${name} not found in index.html`);
  const body = src.slice(open, open + rel + 2); // include the "\n}"
  const signature = src.slice(at, open);        // `function NAME(origParams) `
  // eslint-disable-next-line no-new-func
  return new Function(`return (${signature}${body});`)();
}

// Extract a top-level `const NAME = { ... };` object literal from index.html and
// return it as a real object. Getters/setters inside the literal close over free
// identifiers (e.g. `getTS`, `activeTabId`) the way they do in the real page: `new
// Function` bodies resolve unresolved names against `globalThis`, so the caller sets
// those up (`globalThis.getTS = ...`) before calling this, exactly like loadFn.
export function loadConst(name) {
  const src = readFileSync(HTML, 'utf8');
  const sig = 'const ' + name + ' = {';
  const at = src.indexOf(sig);
  if (at === -1) throw new Error(`const ${name} not found in index.html`);
  const open = src.indexOf('{', at);
  const rel = src.slice(open).search(/\n\};/);   // first column-0 closing brace + semicolon
  if (rel === -1) throw new Error(`end of const ${name} not found in index.html`);
  const body = src.slice(open, open + rel + 2); // include the "\n}"
  // eslint-disable-next-line no-new-func
  return new Function(`return (${body});`)();
}

