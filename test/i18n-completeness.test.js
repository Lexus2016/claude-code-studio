// i18n completeness audit — run before a release.
//
// Two sources of translated strings must stay in sync across every language:
//   1. telegram-bot-i18n.js — the bot's dictionaries
//   2. public/index.html    — the SPA's inline I18N object
// and every key the UI actually asks for (`t('key')`, `data-i18n`,
// `data-i18n-title`, `data-i18n-ph`) must exist in ALL of them, or that language
// silently renders the raw key.
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
  // t('key') / t("key") — the runtime lookup
  for (const m of html.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.\-]+)['"]/g)) referenced.add(m[1]);
  // data-i18n="key", data-i18n-title="key", data-i18n-ph="key" — markup lookups
  for (const m of html.matchAll(/data-i18n(?:-title|-ph)?="([a-zA-Z0-9_.\-]+)"/g)) referenced.add(m[1]);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
