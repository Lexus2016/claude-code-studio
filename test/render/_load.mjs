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
  const at = src.indexOf(sig);
  if (at === -1) throw new Error(`function ${name} not found in index.html`);
  const open = src.indexOf('{', at);
  const rel = src.slice(open).search(/\n\}/);   // first column-0 closing brace
  if (rel === -1) throw new Error(`end of function ${name} not found in index.html`);
  const body = src.slice(open, open + rel + 2); // include the "\n}"
  const signature = src.slice(at, open);        // `function NAME(origParams) `
  // eslint-disable-next-line no-new-func
  return new Function(`return (${signature}${body});`)();
}

