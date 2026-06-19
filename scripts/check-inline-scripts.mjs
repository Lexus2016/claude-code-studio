import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
// Inline <script> blocks only (skip ones with a src attribute).
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, i = 0, fail = 0;
while ((m = re.exec(html))) {
  i++;
  const code = m[1];
  if (!code.trim()) continue;
  try {
    // new Function compiles the body — throws SyntaxError on malformed JS.
    // eslint-disable-next-line no-new-func
    new Function(code);
    console.log(`script #${i}: OK (${code.length} chars)`);
  } catch (e) {
    fail++;
    console.error(`script #${i}: SYNTAX ERROR -> ${e.message}`);
  }
}
console.log(fail ? `FAIL: ${fail} block(s) with syntax errors` : 'ALL SCRIPT BLOCKS OK');
process.exit(fail ? 1 : 0);
