import assert from 'node:assert';
import { test } from 'node:test';
import { loadFn } from './_load.mjs';

// AskUserQuestion carries its payload as `{questions:[{question, options:[…]}]}` — an
// ARRAY, unlike every other tool input, which is a flat object of strings. Before this
// branch existed, `_toolInputBrief` fell through every probe and returned '', so the
// activity row rendered as a bare "Ask" and the user had to expand raw JSON to read
// the question. GitHub issue #20.
const brief = loadFn('_toolInputBrief');

const payload = (nOptions = 2, nQuestions = 1) => JSON.stringify({
  questions: Array.from({ length: nQuestions }, (_, qi) => ({
    question: `Which caching strategy${qi ? ' ' + qi : ''}?`,
    header: 'Cache',
    multiSelect: false,
    options: Array.from({ length: nOptions }, (_, i) => ({ label: `opt${i}`, description: 'x'.repeat(60) })),
  })),
});


test('the question text itself is the summary', () => {
  assert.match(brief('AskUserQuestion', payload()), /Which caching strategy\?/);
});

test('option labels are listed', () => {
  const s = brief('AskUserQuestion', payload(3));
  assert.match(s, /opt0/); assert.match(s, /opt1/); assert.match(s, /opt2/);
});

test('extra questions are counted, not dropped silently', () => {
  assert.match(brief('AskUserQuestion', payload(2, 3)), /\+2/);
});

test('never returns an empty summary for a well-formed payload', () => {
  for (const n of [1, 2, 4, 8]) {
    assert.notStrictEqual(brief('AskUserQuestion', payload(n)), '', `${n} options produced an empty label`);
  }
});

test('a realistic payload survives the 600-char wire cap intact', () => {
  // The server truncates tool input at 600 chars before sending it over the WebSocket.
  // Compact JSON (not pretty-printed) is what keeps a 5-option question parseable.
  const wire = payload(5).substring(0, 600);
  assert.strictEqual(JSON.parse(wire).questions.length, 1, 'payload was truncated mid-JSON');
  assert.match(brief('AskUserQuestion', wire), /Which caching strategy\?/);
});

test('unrelated tools are unaffected', () => {
  assert.match(brief('Bash', JSON.stringify({ command: 'ls -la' })), /ls -la/);
});
