// Structure guards for the four defects fixed on top of 7.7.0. All four live in
// public/index.html, none of them has a DOM-less unit to call, and all four are the
// kind of regression a single careless edit reintroduces -- so they are pinned as
// source structure, the way test/render/script-scope.test.mjs pins declaration scope.
//
// Why each assertion exists:
//
//  1. The interrupt pill must stay DOWNSTREAM of the textarea. `.iw` is a flex row,
//     so any earlier sibling owns the text's left edge: with the pill upstream, the
//     placeholder jumped ~70px right the instant a turn started, and the narrower box
//     re-wrapped the hint. Moving it back up is a one-line edit with no visible test.
//
//  2. There is exactly ONE place that computes the composer's height. The bug was not
//     a wrong formula -- it was five copies of the right formula, only one of which ran
//     on the paths that actually change the wrap (boot, setLang, a panel toggle, the
//     pill entering the row). A sixth ad-hoc `inEl.scrollHeight` is the regression.
//
//  3/4. The terminal pane's refresh button, its send line, and the two focus calls that
//     make a stale pane usable again. `showTerminalView()` has always ended on
//     term.focus() -- which is why switching tabs away and back "fixed" a deaf pane --
//     so a missing refocus elsewhere fails silently and looks like a server bug.
//
// Scope matters as much as presence: refreshTerminalSession/sendToTerminal read `_terms`
// and `_termSessionId`, which are block-scoped consts in the terminal <script>. Declared
// in another block they parse fine and throw ReferenceError on the first click.
//
// Run: node test/composer-terminal.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Inline blocks only: a <script src> tag has no body and must not shift the numbering.
const BLOCKS = [];
{
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m; while ((m = re.exec(SRC))) BLOCKS.push(m[1]);
}
const blockOf = needle => BLOCKS.findIndex(b => b.includes(needle));
const count = needle => SRC.split(needle).length - 1;

console.log('\n— 1. the interrupt pill sits downstream of the textarea —');

const iwStart = SRC.indexOf('<div class="iw">');
const iwEnd = SRC.indexOf('id="charCounter"', iwStart);
check('composer row and char counter both found', iwStart > 0 && iwEnd > iwStart, true);
const iPill = SRC.indexOf('id="interruptPill"');
const iText = SRC.indexOf('<textarea id="input"');
check('pill declared exactly once', count('id="interruptPill"'), 1);
check('pill markup comes AFTER the textarea', iPill > iText, true);
check('pill is still inside the composer row', iPill > iwStart && iPill < iwEnd, true);
// The slide-in reads as "grew out of the right edge" only if it travels that way.
check('fade-in slides from the pill\'s own side (+6px, not -6px)',
  /@keyframes ib-fadein \{ from \{ opacity: 0; transform: translateX\(6px\);/.test(SRC), true);

console.log('\n— 2. one composer autosize path, called from every wrap-changing event —');

check('autosizeInput declared exactly once', count('function autosizeInput()'), 1);
check('autosizeInput lives in the same block as setLang (block 1)', blockOf('function autosizeInput'), blockOf('function setLang'));
check('the cap is a named constant', /const COMPOSER_MAX_H = 130;/.test(SRC), true);
// The one surviving read of inEl.scrollHeight is the one inside the helper. Every other
// composer path must call autosizeInput() instead of open-coding the same two lines.
check('exactly one read of inEl.scrollHeight in the whole file', count('inEl.scrollHeight'), 1);
check('that read is inside autosizeInput',
  /function autosizeInput\(\) \{[^}]*Math\.min\(inEl\.scrollHeight, COMPOSER_MAX_H\)/.test(SRC), true);

// The four paths that change the WRAP without changing the VALUE. Each is a path the
// pre-fix code never re-measured on, and each maps to a line in the user's report.
const b1 = BLOCKS[blockOf('function autosizeInput')];
// Slice from the declaration to the next top-level `function ` — a fixed character
// budget silently truncates setLang(), whose i18n sweep lines are ~200 chars each.
const bodyOf = name => {
  const i = b1.indexOf(name);
  if (i < 0) return '';
  const end = b1.indexOf('\nfunction ', i + name.length);
  return b1.slice(i, end < 0 ? b1.length : end);
};
check('boot re-measures once fonts have landed', /document\.fonts\.ready\.then\(autosizeInput\)/.test(b1), true);
check('boot re-measures on load', /window\.addEventListener\('load', autosizeInput\)/.test(b1), true);
check('a window resize re-measures (debounced)', /_autosizeTimer[\s\S]{0,160}setTimeout\(autosizeInput/.test(b1), true);
check('setLang re-measures after swapping the placeholder', bodyOf('function setLang').includes('autosizeInput()'), true);
check('setSendStop re-measures when the pill enters/leaves the row',
  (bodyOf('function setSendStop').match(/autosizeInput\(\)/g) || []).length, 2);
check('a sidebar toggle re-measures', /if \(id === 'leftPanel' \|\| id === 'rightPanel'\) autosizeInput\(\);/.test(b1), true);

console.log('\n— 3. the terminal refresh button —');

const TB = BLOCKS[blockOf('const _terms')];
check('a refresh button exists in the terminal header', count('id="termRefreshBtn"'), 1);
check('it calls refreshTerminalSession()', /id="termRefreshBtn"[^>]*onclick="refreshTerminalSession\(\)"/.test(SRC), true);
check('and it is labelled for every locale, not hardcoded', /id="termRefreshBtn"[^>]*data-i18n-title="term\.refresh\.title"/.test(SRC), true);
check('refreshTerminalSession declared exactly once', count('function refreshTerminalSession()'), 1);
check('declared in the terminal block, where _terms is in scope', blockOf('function refreshTerminalSession'), blockOf('const _terms'));

// Order is the whole fix. `exited` latches when a pane is reported gone and would make
// _connectTerminalWs give up after one retry; detaching entry.ws before close() stops the
// dying socket's onclose (which compares entry.ws === ws) from racing a second reconnect
// against the one we are about to open.
const rts = TB.slice(TB.indexOf('function refreshTerminalSession()'));
const rtsBody = rts.slice(0, rts.indexOf('\n}\n') + 3);
const at = s => rtsBody.indexOf(s);
check('it clears the latched `exited` flag', at('entry.exited = false') > 0, true);
check('it detaches entry.ws BEFORE closing the old socket', at('entry.ws = null') < at('old.close()'), true);
check('it closes before reconnecting', at('old.close()') < at('_connectTerminalWs(sessionId)'), true);
check('it reconnects unconditionally — no readyState test', /readyState/.test(rtsBody), false);

console.log('\n— 4. sending a line into a terminal session —');

// The composer is display:none in term-mode, which is why this input has to exist at all.
// It is one member of a selector LIST that ends in `display: none !important`, not a
// rule of its own — match the list, or this passes for the wrong reason if it is split out.
check('the composer really is hidden in term mode',
  /\.center\.term-mode > \.ia,[\s\S]{0,400}?display: none !important;/.test(SRC), true);
check('a send input exists under the pane', count('id="termSendInput"'), 1);
check('Enter submits it', /id="termSendInput"[\s\S]{0,400}?onkeydown="if\(event\.key==='Enter'\)/.test(SRC), true);
check('sendToTerminal declared exactly once', count('function sendToTerminal()'), 1);
check('declared in the terminal block', blockOf('function sendToTerminal'), blockOf('const _terms'));

const sts = TB.slice(TB.indexOf('function sendToTerminal()'));
const stsBody = sts.slice(0, sts.indexOf('\n}\n') + 3);
// The same frame term.onData() writes — that is what makes it work on an agent tab and
// on the engine pane alike, where a `view=engine` viewer may only send `input`.
check('it writes the terminal protocol\'s input frame', /type: 'input', data: text \+ '\\r'/.test(stsBody), true);
check('CR, not LF — a PTY needs the Return key', /'\\n'/.test(stsBody), false);
check('it refuses to send on a socket that is not OPEN', /readyState !== 1/.test(stsBody), true);
check('and says so instead of failing silently', /toast\(t\('term\.paste\.notconnected'\), true\)/.test(stsBody), true);
check('it clears the box after sending', /box\.value = ''/.test(stsBody), true);

console.log('\n— focus: why a deaf pane used to need a tab switch —');

check('a reconnect refocuses the pane',
  /ws\.onopen = \(\) => \{[\s\S]{0,700}?requestAnimationFrame\(\(\) => \{ try \{ term\.focus\(\); \} catch \{\} \}\);/.test(TB), true);
check('clicking the pane refocuses it',
  /host\.addEventListener\('mouseup'[\s\S]{0,260}?term\.focus\(\)/.test(TB), true);
check('but not while a selection is being dragged out',
  /host\.addEventListener\('mouseup'[\s\S]{0,160}?if \(term\.hasSelection && term\.hasSelection\(\)\) return;/.test(TB), true);

console.log('\n— i18n: the three new keys exist in all five locales —');

for (const key of ['term.refresh.title', 'term.send.ph', 'term.send.title']) {
  // Both quote styles: uk/en/ru use single quotes in this file, fr/he double.
  const n = count(`'${key}'`) + count(`"${key}"`);
  // 5 definitions + 2 data-i18n* attributes for two of them, 1 for the third.
  check(`${key} defined in 5 locales`, n >= 5, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
