// Dev aid: render representative messages through the REAL renderMd + REAL app CSS
// into a standalone page, so the new visual hierarchy can be screenshotted without
// standing up the authenticated app. Run: node test/render/preview.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { loadFn } from './_load.mjs';

globalThis.LIST_CONTINUATION_TOKEN = '\x06LB\x07';
globalThis.t = (k) => ({ 'copy.code': 'copy' }[k] || k);
globalThis.copyCode = () => {};
for (const fn of ['escH', '_lineIndent', 'isSafeHref', 'reformatInlineNumberedItems',
  'normalizeListContinuations', 'parseListBlock', 'replaceMarkdownLinks',
  'promoteStatusLine', 'parseKeyValueFacts', 'parseAdmonitions', 'autolinkBareUrls',
  'linkifyStandaloneButtons']) {
  globalThis[fn] = loadFn(fn);
}
const renderMd = loadFn('renderMd');

const src = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const css = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');

const messages = [
  [
    '# Аудит підсистеми чату завершено',
    '**Файл:** public/index.html',
    '**Рядок:** 4626 — reformatInlineNumberedItems',
    '**Спосіб:** негативний lookbehind',
    '',
    '## Що зроблено',
    'Розділювач між текстовими блоками виправлено в корені — лагодить і живий рендер, і збережену копію. Це звичайний спокійний абзац-опис, який не конкурує з важливим.',
    '',
    '> [!TIP]',
    '> Голі посилання тепер активні: https://core.telegram.org/bots/api',
    '',
    '> [!WARNING]',
    '> Перевірити в браузері наживо ще треба.',
    '',
    '> [!CAUTION]',
    '> Не вгадувати «важливість» із прози — це дало два баги.',
    '',
    '[Відкрити застосунок](http://localhost:3000)',
    '',
    '---',
    '✅ Done — закомічено 6ad6928, 9/10',
  ].join('\n'),
  [
    'А ось як виглядає звичайна відповідь без жодних спецумовностей — просто текст, '
    + 'списки й код, як завжди:',
    '',
    '- перший пункт',
    '- другий пункт із `inline-кодом`',
    '',
    'І перелік у дужках лишається інлайновим: (1) аудит, (2) ресерч, (3) рекомендації.',
  ].join('\n'),
  [
    // Reproduction of the long status line that previously became a giant pill.
    'Коротка відповідь зі справжнім (довгим) статус-рядком, як я зазвичай пишу:',
    '',
    '---',
    '✅ Done — Electron уже несе нові зміни (нічого створювати не треба), додав '
    + 'dev-хелпер `demoMessages()` для миттєвого тесту, закомічено (`f5f6115`). '
    + 'Запускайте `npm run electron:dev` і кличте `demoMessages()` у DevTools.',
  ].join('\n'),
];

const body = messages.map(m =>
  `<div class="mw assistant"><div class="msg">${renderMd(m)}</div></div>`).join('\n');

const html = `<!DOCTYPE html><html><head><meta charset="utf8">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${css}</style></head>
<body style="background:var(--bg);padding:40px 0;display:block;height:auto;overflow:auto">
<div style="max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:18px">${body}</div>
</body></html>`;

writeFileSync('/tmp/ccs-preview.html', html);
console.log('wrote /tmp/ccs-preview.html');
