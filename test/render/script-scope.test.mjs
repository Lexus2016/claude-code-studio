// Function declarations hoist only within their OWN <script> block. index.html has
// several, and a helper defined in a LATE block is unreachable from an EARLY one until
// the parser gets there — which, for anything reachable from ws.onopen, is a race the
// browser loses regularly.
//
// The one that shipped: isEnginePaneId() sat in the terminal block near the bottom of
// the file while loadSess() — which calls it on every session open — lives in the first
// block and is reached from ws.onopen. A WebSocket opens in milliseconds; parsing
// several thousand more lines does not. When it lost, the call threw
//   ReferenceError: isEnginePaneId is not defined
// aborting loadSess() mid-way, which left the composer at height:0 and the placeholder
// rendering a line below the box.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');

// Byte offset of each <script> opening tag, so "same block" is a real question.
const blockStarts = [...HTML.matchAll(/<script(?:\s[^>]*)?>/g)].map(m => m.index);
const blockOf = (idx) => blockStarts.filter(b => b <= idx).length - 1;

function declIndex(name) {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(HTML);
  return m ? m.index : -1;
}
function firstCallIndex(name) {
  // a call that is not the declaration itself
  for (const m of HTML.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    if (!/function\s+$/.test(HTML.slice(Math.max(0, m.index - 12), m.index))) return m.index;
  }
  return -1;
}

// Helpers that are called from code reachable before the page has finished parsing.
for (const name of ['isEnginePaneId', 'enginePaneIdFor', 'chatIdOfEnginePane']) {
  test(`${name} is declared no later than its first caller's block`, () => {
    const d = declIndex(name), c = firstCallIndex(name);
    assert.notStrictEqual(d, -1, `${name} is not declared at all`);
    if (c === -1) return;                       // declared but unused — not this test's problem
    assert.ok(blockOf(d) <= blockOf(c),
      `${name} is declared in script block ${blockOf(d)} but first called from block ${blockOf(c)} — `
      + `a caller reached before the later block is parsed throws ReferenceError`);
  });
}

test('loadSess and isEnginePaneId are in the same script block', () => {
  // The specific pairing that broke. Stated explicitly so the intent survives a refactor.
  assert.strictEqual(blockOf(declIndex('isEnginePaneId')), blockOf(declIndex('loadSess')));
});

test('the helpers are declared exactly once', () => {
  // The fix moved them; a copy left behind would shadow confusingly.
  assert.strictEqual((HTML.match(/const ENGINE_PANE_PREFIX\s*=/g) || []).length, 1);
  assert.strictEqual((HTML.match(/function isEnginePaneId\s*\(/g) || []).length, 1);
});
