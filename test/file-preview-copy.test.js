'use strict';
// Issue #137 — a Copy action in the file preview viewer.
//
// The viewer's functions are RUN, not regex-matched: the file-preview block is cut out of
// public/index.html and evaluated in a vm with a stubbed fetch, $i and clipboard. What must
// hold:
//   - the toolbar carries a Copy button that is hidden until there is text to copy;
//   - a text or markdown preview shows it and copies exactly the content that was fetched,
//     not the escaped DOM;
//   - a binary, image or PDF preview leaves it hidden, and an empty file has nothing to copy;
//   - closing the viewer hides it and clears the stored text, so a stale path cannot be copied;
//   - the copy path is the shared copyText(), which also works over plain http.
//
// Run: node test/file-preview-copy.test.js
const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

console.log('toolbar:');
{
  const btn = html.match(/<button class="fpv-btn" id="fpvCopyBtn"[^>]*>/);
  check('the copy button exists', !!btn, true);
  check('it starts hidden', btn ? /style="display:none"/.test(btn[0]) : null, true);
  check('it calls fpvCopyText()', btn ? /onclick="fpvCopyText\(\)"/.test(btn[0]) : null, true);
  check('its label is translated', /data-i18n="fpv\.copy"/.test(html), true);
  check('it sits in the preview toolbar, before Download',
    html.indexOf('id="fpvCopyBtn"') < html.indexOf('id="fpvDownloadBtn"'), true);
}

const start = html.indexOf("let _fpvPath = '', _fpvName = '', _fpvIsImg = false;");
const end = html.indexOf('async function copyImageToClipboard(', start);
assert.ok(start > 0 && end > start, 'file-preview block not found in public/index.html');
const BLOCK = html.slice(start, end);

function makeViewer(respond) {
  const els = new Map();
  const copied = [], toasts = [];
  const $i = id => {
    if (!els.has(id)) els.set(id, { style: {}, textContent: '', innerHTML: '' });
    return els.get(id);
  };
  const sandbox = {
    console,
    fetch: async () => ({ json: async () => respond() }),
    $i,
    t: k => k,
    escH: s => String(s),
    renderMd: s => s,
    _filesQS: () => 'path=x',
    _filesRemote: false,
    _switchGen: 0,
    openModalOverlay() {},
    closeModalOverlay() {},
    toast: m => toasts.push(m),
    copyText: async text => { copied.push(text); },
    __els: els, __copied: copied, __toasts: toasts,
  };
  vm.createContext(sandbox);
  vm.runInContext(BLOCK + '\nthis.__api = { openFilePreview, fpvCopyText, closeFpv };', sandbox);
  return sandbox;
}

const shown = ctx => ctx.__els.get('fpvCopyBtn').style.display;

(async () => {
  console.log('\nbehaviour:');
  {
    const text = makeViewer(() => ({ content: 'line one\nline two\n' }));
    await text.__api.openFilePreview('notes.txt', 'notes.txt');
    check('a text file shows the button', shown(text), '');
    await text.__api.fpvCopyText();
    check('copying hands over the fetched content', text.__copied, ['line one\nline two\n']);
    check('and reports it', text.__toasts, ['toast.text_copied']);
  }

  {
    const md = makeViewer(() => ({ content: '# Title\n\nbody' }));
    await md.__api.openFilePreview('README.md', 'README.md');
    check('a markdown preview shows the button', shown(md), '');
    await md.__api.fpvCopyText();
    check('markdown is copied as source, not rendered HTML', md.__copied, ['# Title\n\nbody']);
  }

  {
    const empty = makeViewer(() => ({ content: '' }));
    await empty.__api.openFilePreview('empty.txt', 'empty.txt');
    check('an empty file hides it (there is nothing to copy)', shown(empty), 'none');
    await empty.__api.fpvCopyText();
    check('and copying is a no-op', empty.__copied, []);
  }

  {
    const binary = makeViewer(() => ({ content: '[Binary]' }));
    await binary.__api.openFilePreview('app.exe', 'app.exe');
    check('a binary preview stays hidden', shown(binary), 'none');
  }

  {
    const img = makeViewer(() => ({ content: '' }));
    await img.__api.openFilePreview('photo.png', 'photo.png');
    check('an image preview stays hidden', shown(img), 'none');
  }

  {
    const pdf = makeViewer(() => ({ content: '' }));
    await pdf.__api.openFilePreview('doc.pdf', 'doc.pdf');
    check('a PDF preview stays hidden', shown(pdf), 'none');
  }

  {
    const refused = makeViewer(() => ({ error: 'Path outside the project' }));
    await refused.__api.openFilePreview('x.txt', 'x.txt');
    check('a refused read leaves it hidden', shown(refused), 'none');
  }

  {
    const reuse = makeViewer(() => ({ content: 'kept' }));
    await reuse.__api.openFilePreview('a.txt', 'a.txt');
    check('opening a text file shows the button', shown(reuse), '');
    reuse.__api.closeFpv();
    check('closing hides the button', shown(reuse), 'none');
    await reuse.__api.fpvCopyText();
    check('a closed viewer copies nothing', reuse.__copied, []);
  }

  {
    // The handler reads the text out of the viewer state, so a path that points somewhere
    // else after a failed copy attempt must not resurrect the previous file's text.
    const stale = makeViewer(() => ({ content: 'first' }));
    await stale.__api.openFilePreview('one.txt', 'one.txt');
    stale.fetch = async () => ({ json: async () => ({ error: 'gone' }) });
    await stale.__api.openFilePreview('two.txt', 'two.txt');
    check('reopening a file that fails to load hides the button', shown(stale), 'none');
    await stale.__api.fpvCopyText();
    check('and the previous file is not copied in its place', stale.__copied, []);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
