// i18n completeness audit — run before a release.
//
// Sources of translated strings that must stay in sync across every language:
//   1. telegram-bot-i18n.js  — the bot's dictionaries
//   2. public/index.html     — the SPA's inline TRANSLATIONS object
//   3. public/kanban.html    — the board's inline TR object
//   4. public/schedule.html  — the scheduler's inline TR object
// and every key the UI actually asks for (`t('key')`, `data-i18n`,
// `data-i18n-title`, `data-i18n-ph`, `data-i18n-aria`, `data-i18n-tip`,
// `data-i18n-html`) must exist in ALL of them, or that language silently renders
// the raw key.
//
// Section 6 closes the other half of the loop: a string that was never routed
// through `t()` at all cannot be caught by a parity check, so it scans the
// markup for user-facing text and attributes carrying no translation key.
//
// Run: node test/i18n-completeness.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ── 1. Telegram bot dictionaries ────────────────────────────────────────────
console.log('telegram bot dictionaries:');
{
  const dicts = require('../telegram-bot-i18n.js');
  const langs = Object.keys(dicts).filter(k => dicts[k] && typeof dicts[k] === 'object');
  check('every expected language is present', langs.sort(), ['en', 'fr', 'he', 'ru', 'uk']);

  const keysOf = l => new Set(Object.keys(dicts[l]));
  const union = new Set(langs.flatMap(l => [...keysOf(l)]));
  for (const l of langs) {
    const missing = [...union].filter(k => !keysOf(l).has(k));
    check(`${l}: no missing keys (${union.size} total)`, missing, []);
  }
  // An empty string renders as a blank label — as broken as a missing key.
  for (const l of langs) {
    const empty = [...keysOf(l)].filter(k => !String(dicts[l][k] ?? '').trim());
    check(`${l}: no empty values`, empty, []);
  }
}

// ── 2. SPA inline dictionaries ──────────────────────────────────────────────
console.log('\nweb UI (public/index.html) dictionaries:');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// TRANSLATIONS is a plain object literal in an inline script; evaluate just that.
const i18nStart = html.indexOf('const TRANSLATIONS = {');
assert.ok(i18nStart !== -1, 'could not locate the TRANSLATIONS object in public/index.html');
let depth = 0, i = html.indexOf('{', i18nStart), end = -1;
for (; i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
assert.ok(end !== -1, 'unbalanced braces in the TRANSLATIONS object');
const I18N = new Function('return ' + html.slice(html.indexOf('{', i18nStart), end + 1))();

const webLangs = Object.keys(I18N);
check('every expected language is present', webLangs.slice().sort(), ['en', 'fr', 'he', 'ru', 'uk']);

const webKeys = l => new Set(Object.keys(I18N[l]));
const webUnion = new Set(webLangs.flatMap(l => [...webKeys(l)]));
for (const l of webLangs) {
  const missing = [...webKeys('uk')].filter(k => !webKeys(l).has(k));
  check(`${l}: covers every key defined in the base language (${webKeys('uk').size})`, missing, []);
}
for (const l of webLangs) {
  const extra = [...webKeys(l)].filter(k => !webKeys('uk').has(k));
  check(`${l}: defines no key the base language lacks`, extra, []);
}

// ── 3. Keys the UI actually requests must exist ─────────────────────────────
console.log('\nkeys referenced by the UI resolve in every language:');
{
  const referenced = new Set();
  // t('key') / t("key") — the runtime lookup. TT() is the update banner's
  // late-bound wrapper around the same dictionary.
  for (const m of html.matchAll(/\b(?:t|TT)\(\s*['"]([a-zA-Z0-9_.\-]+)['"]/g)) referenced.add(m[1]);
  // data-i18n[-title|-ph|-aria|-tip|-html]="key" — markup lookups
  for (const m of html.matchAll(/data-i18n(?:-title|-ph|-aria|-tip|-html)?="([a-zA-Z0-9_.\-]+)"/g)) referenced.add(m[1]);
  // A trailing dot means the key is built at runtime, e.g. t('bot.state.' + st).
  // The concrete members of such a family are covered by the parity check above.
  for (const k of [...referenced]) if (k.endsWith('.')) referenced.delete(k);

  check('the UI references a non-trivial number of keys', referenced.size > 100, true);
  for (const l of webLangs) {
    const missing = [...referenced].filter(k => !webKeys(l).has(k)).sort();
    check(`${l}: every referenced key is defined (${referenced.size} referenced)`, missing, []);
  }
}

// ── 4. Placeholder parity ───────────────────────────────────────────────────
// A translation that drops a {placeholder} silently renders a sentence with a
// hole in it; one that invents a new placeholder renders a literal "{foo}".
console.log('\nplaceholder parity against the base language:');
{
  const dicts = require('../telegram-bot-i18n.js');
  const phOf = s => (String(s).match(/\{[a-z_]+\}/gi) || []).sort().join(',');
  for (const l of ['en', 'ru', 'fr', 'he']) {
    const mismatched = Object.keys(dicts.uk)
      .filter(k => dicts[l][k] !== undefined && phOf(dicts.uk[k]) !== phOf(dicts[l][k]));
    check(`telegram ${l}: placeholders match uk`, mismatched, []);
  }
  for (const l of ['en', 'ru', 'fr', 'he']) {
    const mismatched = Object.keys(I18N.uk)
      .filter(k => I18N[l][k] !== undefined && phOf(I18N.uk[k]) !== phOf(I18N[l][k]));
    check(`web ${l}: placeholders match uk`, mismatched, []);
  }
}

// ── 5. Secondary page dictionaries (kanban / schedule) ──────────────────────
// Both pages ship their own inline `TR` object and their own `t()`. They used to
// carry uk/en/ru only and fall back to uk, so a French or Hebrew user got a
// Ukrainian board — the concrete complaint in issue #26.
console.log('\nsecondary page dictionaries (kanban / schedule):');
const PAGE_DICTS = {};
for (const file of ['kanban.html', 'schedule.html']) {
  const src = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
  const start = src.indexOf('const TR = {');
  assert.ok(start !== -1, `could not locate the TR object in public/${file}`);
  let d = 0, j = src.indexOf('{', start), stop = -1;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) { stop = j; break; } }
  }
  assert.ok(stop !== -1, `unbalanced braces in the TR object of public/${file}`);
  const TR = new Function('return ' + src.slice(src.indexOf('{', start), stop + 1))();
  PAGE_DICTS[file] = { src, TR };

  const langs = Object.keys(TR);
  check(`${file}: every expected language is present`, langs.slice().sort(), ['en', 'fr', 'he', 'ru', 'uk']);

  const keys = l => new Set(Object.keys(TR[l]));
  const base = keys('en');
  for (const l of langs) {
    check(`${file} ${l}: covers every key defined in the base language (${base.size})`,
      [...base].filter(k => !keys(l).has(k)), []);
    check(`${file} ${l}: defines no key the base language lacks`,
      [...keys(l)].filter(k => !base.has(k)), []);
    check(`${file} ${l}: no empty values`,
      [...keys(l)].filter(k => !String(TR[l][k] ?? '').trim()), []);
  }

  // The page must not fall back to a language the user did not pick.
  check(`${file}: t() falls back to English, not to a locale-specific dictionary`,
    /TR\[lang\]\s*\|\|\s*TR\.en/.test(src), true);
  check(`${file}: sets document direction (Hebrew is RTL)`,
    /document\.documentElement\.dir\s*=/.test(src), true);

  const referenced = new Set();
  for (const m of src.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.\-]+)['"]/g)) referenced.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-title|-ph|-aria|-tip|-html)?="([a-zA-Z0-9_.\-]+)"/g)) referenced.add(m[1]);
  for (const k of [...referenced]) if (k.endsWith('.')) referenced.delete(k);
  // Without this, a broken extraction regex leaves `referenced` empty and every
  // check below passes while proving nothing. The count is printed in the labels
  // but a printed number is not an assertion.
  check(`${file}: the key extraction found a non-trivial number of references`,
    referenced.size > 20, true);
  for (const l of langs) {
    check(`${file} ${l}: every referenced key is defined (${referenced.size} referenced)`,
      [...referenced].filter(k => !keys(l).has(k)).sort(), []);
  }

  const phOf = v => (String(v).match(/\{[a-z_]+\}/gi) || []).sort().join(',');
  for (const l of langs.filter(x => x !== 'en')) {
    check(`${file} ${l}: placeholders match en`,
      [...base].filter(k => TR[l][k] !== undefined && phOf(TR.en[k]) !== phOf(TR[l][k])), []);
  }
}

// ── 6. No hardcoded user-facing strings ─────────────────────────────────────
// Sections 1-5 only prove that the keys we DO use resolve everywhere. A string
// that was never routed through `t()` is invisible to them, and that is exactly
// what issue #26 reported: filter labels, tooltips and toasts frozen in one
// language. This section fails when user-visible text carries no translation key.
console.log('\nno hardcoded user-facing strings:');
{
  // Text nodes must carry data-i18n / data-i18n-html; these four visible
  // attributes must carry their data-i18n-* twin.
  const I18N_ATTRS = [
    ['title', 'data-i18n-title'],
    ['placeholder', 'data-i18n-ph'],
    ['aria-label', 'data-i18n-aria'],
    ['data-tip', 'data-i18n-tip'],
  ];
  // Tags that hold vector graphics or code, never prose.
  const SKIP_TAGS = new Set(['script', 'style', 'svg', 'path', 'rect', 'line', 'circle',
    'polyline', 'polygon', 'g', 'defs', 'use', 'ellipse']);

  // Exempt literals. Each entry states why it is NOT UI copy; nothing goes in
  // here just to silence the check.
  const ALLOWED = new Set([
    'Claude Code Studio',                    // product name — a brand is not translated
    'Claude Code Studio — AI Chat & Agents', // <title>, product name
    'Kanban — Claude Code Studio',           // <title>, product name
    'Schedule — Claude Code Studio',         // <title>, product name
    'CCS',                                   // the logo mark, product initials
    'GitHub',                                // company name
    'Claude Desktop',                        // Anthropic product name
    '⚡ Claude Code',                         // Anthropic product name
    '⚡ Max',                                 // Claude Max plan name
    'Max ⚠',                                 // Claude Max plan name + status glyph
    'ngrok',                                 // third-party tunnel service name
    'cloudflared',                           // Cloudflare tunnel binary name
    'npx',                                   // command name typed verbatim into a shell
    'codex',                                 // external agent CLI binary name
    'Haiku', 'Sonnet', 'Opus', 'Fable',      // model names, shown as-is in the picker
    'haiku', 'sonnet', 'opus', 'fable',      // the exact aliases passed to the claude CLI
    'API',                                   // protocol acronym, identical in all five languages
    'URL',                                   // standards acronym
    'JSON',                                  // data-format name
    '⚙ MCP',                                 // Model Context Protocol acronym
    'Markdown (.md)',                        // format name + file extension
    'stdio', 'http',                         // MCP transport identifiers, matched literally by the server
    'claude_desktop_config.json',            // literal filename the user has to open
    '{"mcpServers":{...}}',                  // JSON snippet shown as sample config
    '/check', '/review',                     // literal slash-command names
    'EN', 'UK', 'RU', 'FR', 'HE',            // ISO language codes in the language picker
    'Ctrl', 'Shift', 'Enter', 'Esc',         // keyboard key caps, printed on the hardware
    // Sample values inside placeholders — they illustrate a format, they are not prose.
    'my-server',                             // example MCP server id
    'My Server',                             // example MCP server display name
    'ngrok authtoken...',                    // example ngrok token
    '123456:ABC-DEF...',                     // example Telegram bot token format
    'https://api.example.com/mcp',           // example MCP endpoint
    '/home/user/myproject',                  // example project path
    '/path/to/project',                      // example project path
    '~/.ssh/id_rsa',                         // example SSH key path
    'deploy@eu.myserver.com',                                   // example SSH user@host
    '-y&#10;@modelcontextprotocol/server-filesystem&#10;/path/to/dir', // example argv, one arg per line
    'codex resume {sid}',                    // example external-agent resume command
    'codex resume --last',                   // example external-agent resume command
    '--session-id {sid}',                    // example CLI flag
    'cursor-agent create-chat',              // example external-agent spawn command
  ]);

  // Blank out scripts, styles and comments while preserving line numbers, so what
  // is left is markup only. (Strings built inside template literals are out of
  // scope here — sections 3 and 5 cover those through their t() references.)
  const blank = m => '\n'.repeat((m.match(/\n/g) || []).length);
  const stripCode = src => src
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);

  const hasWords = s => /[\p{L}]{2}/u.test(s);

  function scanMarkup(file, src) {
    const markup = stripCode(src);
    const hits = [];
    const tagRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>([^<]*)/g;
    let m;
    while ((m = tagRe.exec(markup)) !== null) {
      const tag = m[1].toLowerCase(), attrs = m[2];
      if (SKIP_TAGS.has(tag)) continue;
      const line = () => markup.slice(0, m.index).split('\n').length;
      const text = m[3].replace(/&#?\w+;/g, ' ').trim();
      if (text && hasWords(text) && !ALLOWED.has(text) && !/data-i18n(=|-html=)/.test(attrs))
        hits.push(`${file}:${line()} <${tag}> text "${text}"`);
      for (const [attr, marker] of I18N_ATTRS) {
        const am = attrs.match(new RegExp(`\\b${attr}="([^"]*)"`));
        if (am && hasWords(am[1]) && !ALLOWED.has(am[1]) && !attrs.includes(marker + '='))
          hits.push(`${file}:${line()} <${tag}> @${attr} "${am[1]}"`);
      }
    }
    return hits;
  }

  // Literals handed straight to the user by toast()/alert()/confirm().
  const CALL_RE = /\b(?:toast|alert|confirm)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  function scanCalls(file, src) {
    const hits = [];
    for (const m of src.matchAll(CALL_RE)) {
      const txt = m[2];
      if (!hasWords(txt) || ALLOWED.has(txt)) continue;
      hits.push(`${file}:${src.slice(0, m.index).split('\n').length} ${txt}`);
    }
    return hits;
  }

  // ── Self-test the scanners ───────────────────────────────────────────────
  // Six assertions below say "the scanner found nothing". That is also what a
  // scanner whose regex stopped matching reports. So first prove each one still
  // sees a violation it is supposed to see, and still ignores what it should.
  {
    const FIX = [
      '<div>Save now</div>',                               // bare text
      '<button title="Delete this">x</button>',            // untranslated attribute
      '<span data-i18n="btn.ok">Save now</span>',          // marked — must be ignored
      '<script>const s = "Save now";</script>',            // inside script — must be ignored
      '<!-- Save now -->',                                 // comment — must be ignored
      '<div>~/.ssh/id_rsa</div>',                          // on the ALLOWED list
    ].join('\n');
    const hits = scanMarkup('fixture', FIX);
    check('scanMarkup catches bare text in markup',
      hits.some(h => /<div> text "Save now"/.test(h)), true);
    check('scanMarkup catches an untranslated attribute',
      hits.some(h => /@title "Delete this"/.test(h)), true);
    check('scanMarkup ignores marked, scripted, commented and allow-listed text',
      hits.length, 2);

    const CALLS = "toast('Saved'); alert(t('x.y')); confirm(\"Are you sure\"); log('Saved');";
    const chits = scanCalls('fixture', CALLS);
    check('scanCalls catches a literal handed to toast()',
      chits.some(h => /Saved$/.test(h)), true);
    check('scanCalls catches a literal handed to confirm()',
      chits.some(h => /Are you sure$/.test(h)), true);
    check('scanCalls ignores t() calls and non-user-facing calls', chits.length, 2);
  }

  for (const file of ['index.html', 'kanban.html', 'schedule.html']) {
    const src = PAGE_DICTS[file] ? PAGE_DICTS[file].src
      : fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    check(`${file}: no untranslated text or attribute in the markup`, scanMarkup(file, src), []);
    check(`${file}: no untranslated toast/alert/confirm literal`, scanCalls(file, src), []);
  }
}

// ── The SPA's own markup must be ENGLISH ───────────────────────────────────
// Issue #75: the static HTML shipped Ukrainian, and setLang() runs at the very end
// of the file. Anything that stopped the script before it — an error, a slow load,
// a browser that ran the tail late — left the interface in a language nobody had
// chosen, while the parts rendered through t() were already English. That is the
// "mixed language" in the report, and no dictionary check could see it: every key
// was present in all five languages. The markup itself was the bug.
console.log('\nthe SPA markup ships English, not a translation:');
{
  const CYR = /[\u0400-\u04FF]/;
  // Everything except the TRANSLATIONS object, which is Cyrillic by definition.
  const tStart = html.indexOf('const TRANSLATIONS = {');
  const heStart = html.indexOf('\n  he: {', tStart);
  const tEnd = html.indexOf('\n  };', heStart);
  const outside = html.slice(0, tStart) + html.slice(tEnd);

  const textNodes = [...outside.matchAll(/>([^<>]{2,120})</g)]
    .map(m => m[1]).filter(v => CYR.test(v)).map(v => v.trim().slice(0, 50));
  check('no Cyrillic text nodes in the markup', textNodes, []);

  const attrs = [...outside.matchAll(/(?:data-tip|title|placeholder|aria-label)="([^"]{2,120})"/g)]
    .map(m => m[1]).filter(v => CYR.test(v)).map(v => v.slice(0, 50));
  check('no Cyrillic UI attributes in the markup', attrs, []);

  // `t('k') || 'Не знайдено'` — a fallback that fires exactly when the key is
  // missing, i.e. precisely when the user is most likely not to read that language.
  const fallbacks = [...outside.matchAll(/t\([^)]*\)\s*\|\|\s*'([^']{2,60})'/g)]
    .map(m => m[1]).filter(v => CYR.test(v));
  check('no Cyrillic inline fallbacks', fallbacks, []);
}

console.log('\nboth translation paths fall back to English:');
{
  // A key missing from a KNOWN language used to return the raw key, so the UI showed
  // "proj.empty" instead of the English string.
  const tFn = html.slice(html.indexOf('function t(key) {'));
  const tBody = tFn.slice(0, tFn.indexOf('\n}') + 2);
  check('t() prefers the language, then English, then the key',
    /TRANSLATIONS\[lang\]\?\.\[key\] \?\? TRANSLATIONS\.en\?\.\[key\] \?\? key/.test(tBody), true);
  const sl = html.slice(html.indexOf('function setLang(lang, persist = true) {'));
  const slBody = sl.slice(0, sl.indexOf('\n}') + 2);
  check('setLang() falls back per KEY, not per language',
    /TRANSLATIONS\.en\?\.\[k\]/.test(slBody), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
