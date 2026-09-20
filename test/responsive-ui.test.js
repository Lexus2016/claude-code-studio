'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('Responsive UI improvements (#106)');

const idxPath = path.join(__dirname, '..', 'public', 'index.html');
const idxSrc = fs.readFileSync(idxPath, 'utf8');

const kbPath = path.join(__dirname, '..', 'public', 'kanban.html');
const kbSrc = fs.readFileSync(kbPath, 'utf8');

check('index.html constrains dir-modal and ssh-host-modal with max-width', () => {
  assert.ok(/\.dir-modal\s*\{[^}]*max-width:\s*calc\(100vw\s*-\s*24px\)/.test(idxSrc), 'dir-modal lacks max-width constraint');
  assert.ok(/\.ssh-host-modal\s*\{[^}]*max-width:\s*calc\(100vw\s*-\s*24px\)/.test(idxSrc), 'ssh-host-modal lacks max-width constraint');
});

check('index.html mobile media query overrides modal and cfgModal constraints', () => {
  const mediaBlock = idxSrc.slice(idxSrc.indexOf('@media (max-width: 800px)'));
  assert.ok(/\.modal\s*\{[\s\S]*?max-width:\s*calc\(100vw\s*-\s*24px\)\s*!important/.test(mediaBlock), 'missing modal max-width in mobile media query');
  assert.ok(/#cfgModal\s+\.modal\s*\{[\s\S]*?min-width:\s*0\s*!important/.test(mediaBlock), 'missing cfgModal min-width:0 override in mobile media query');
});

check('kanban.html constrains modal width on tablet and mobile', () => {
  const media800 = kbSrc.slice(kbSrc.indexOf('@media (max-width: 800px)'));
  assert.ok(/\.modal\s*\{[\s\S]*?max-width:\s*calc\(100vw\s*-\s*16px\)\s*!important/.test(media800), 'missing modal max-width in kanban 800px query');

  const media480 = kbSrc.slice(kbSrc.indexOf('@media (max-width: 480px)'));
  assert.ok(/\.modal\s*\{[\s\S]*?max-width:\s*100vw\s*!important/.test(media480), 'missing bottom-sheet modal in kanban 480px query');
  assert.ok(/\.ov\s*\{[\s\S]*?align-items:\s*flex-end/.test(media480), 'missing bottom-sheet alignment in kanban 480px query');
});

check('kanban.html card actions and badges wrap gracefully on narrow viewports', () => {
  assert.ok(/\.card-actions\{[^}]*flex-wrap:\s*wrap/.test(kbSrc), 'card-actions should wrap');
  assert.ok(/\.badge-muted\{[^}]*text-overflow:\s*ellipsis/.test(kbSrc), 'badge-muted should truncate with ellipsis');
});

check('project dropdown buttons set title attribute for full name tooltips', () => {
  assert.ok(/ddName\.title\s*=\s*activeProj\.name/.test(idxSrc), 'index.html should set title on project name');
  assert.ok(/ddName\.title\s*=\s*fullName/.test(kbSrc), 'kanban.html should set title on project name');
});

if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nAll responsive-ui tests passed');
