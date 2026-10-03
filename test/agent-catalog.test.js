'use strict';
// Model / effort catalogs for external agents (issue #123).
//
// The Delegate dialog showed empty Model and Effort selects for every provider
// except Claude. Root cause: the catalogs exist on the agent record and the modal
// reads them (`_dlgFillTuning(cfg?.models / cfg?.efforts)`), but the agent editor
// had NO field to enter them, and POST /api/external-agents dropped whatever the
// client sent — so only the built-in `claude` default, seeded with both, ever had
// a catalog. The fix is a field the browser can write and an endpoint that stores
// it; this test pins BOTH halves, because either one failing alone recreates #123.
//
// Run: node test/agent-catalog.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('External-agent model/effort catalogs (#123)');

const { sanitizeAgentCatalog, parseAgentCatalogInput, MAX_ENTRIES } = require('../agent-catalog');

// ── The pure sanitiser ───────────────────────────────────────────────────────
check('a valid list is kept as-is', () => {
  assert.deepStrictEqual(sanitizeAgentCatalog(['low', 'medium', 'high']), ['low', 'medium', 'high']);
});
check('entries are trimmed and de-duplicated', () => {
  assert.deepStrictEqual(sanitizeAgentCatalog([' opus ', 'opus', 'sonnet']), ['opus', 'sonnet']);
});
check('non-strings and blanks are dropped, not coerced', () => {
  assert.deepStrictEqual(sanitizeAgentCatalog(['opus', 42, null, '', '   ', {}]), ['opus']);
});
check('a non-array is empty (the endpoint refuses it separately)', () => {
  assert.deepStrictEqual(sanitizeAgentCatalog('opus'), []);
  assert.deepStrictEqual(sanitizeAgentCatalog(undefined), []);
});
check('the list is bounded', () => {
  const many = Array.from({ length: 500 }, (_, i) => `m${i}`);
  assert.strictEqual(sanitizeAgentCatalog(many).length, MAX_ENTRIES);
});
check('an over-long entry is dropped', () => {
  assert.deepStrictEqual(sanitizeAgentCatalog(['x'.repeat(65), 'ok']), ['ok']);
});

check('an entry that looks like an option is dropped', () => {
  assert.deepStrictEqual(sanitizeAgentCatalog(['--dangerously-skip-permissions', '-c', 'gpt-6', ' -x']), ['gpt-6']);
});

// ── The browser-side parser must agree with the server ───────────────────────
check('comma input parses like the server sanitiser', () => {
  assert.deepStrictEqual(parseAgentCatalogInput(' haiku, sonnet ,opus,haiku '), ['haiku', 'sonnet', 'opus']);
  assert.deepStrictEqual(parseAgentCatalogInput(''), []);
  assert.deepStrictEqual(parseAgentCatalogInput('  '), []);
  assert.deepStrictEqual(parseAgentCatalogInput(undefined), []);
});
check('the browser cap matches the server cap', () => {
  const csv = Array.from({ length: 500 }, (_, i) => `m${i}`).join(',');
  assert.strictEqual(parseAgentCatalogInput(csv).length, MAX_ENTRIES);
});

// ── The endpoint stores what the modal reads ─────────────────────────────────
const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('POST /api/external-agents accepts models and efforts', () => {
  assert.ok(
    srvSrc.includes('const { id, label, template, interactive, newIdFlag, resume, resumeLast, models, efforts } = req.body;'),
    'the endpoint does not destructure models/efforts — every catalog the UI sends is dropped'
  );
});
check('a non-array catalog is refused, an empty one clears', () => {
  assert.ok(srvSrc.includes("`${k} must be an array of strings`"),
    'a non-array catalog is not rejected');
  assert.ok(srvSrc.includes('next[k] = sanitizeAgentCatalog(v);'),
    'POST /api/external-agents stores the raw body instead of the sanitised list');
});
// A clear must be stored as [] — deleting the key lets mergeAgentDefaults() re-seed
// the built-in `claude` catalog on the very next loadConfig(), so the clear is lost.
check('a cleared catalog survives the defaults merge', () => {
  const { mergeAgentDefaults } = require('../terminal-session');
  const defaults = { claude: { label: 'Claude Code', models: ['opus'], efforts: ['high'] } };
  const stored = { externalAgents: { claude: { label: 'Claude Code', models: sanitizeAgentCatalog([]), efforts: sanitizeAgentCatalog(['', ' ']) } } };
  const { config } = mergeAgentDefaults(stored, defaults);
  assert.deepStrictEqual(config.externalAgents.claude.models, [], 'a cleared models catalog was re-seeded');
  assert.deepStrictEqual(config.externalAgents.claude.efforts, [], 'a cleared efforts catalog was re-seeded');
  assert.ok(!/delete next\[k\][^\n]*\n[^\n]*\n?\s*\}\s*\n\s*config\.externalAgents\[id\] = next/.test(srvSrc) || srvSrc.includes('next[k] = sanitizeAgentCatalog(v);'),
    'the endpoint deletes a cleared catalog instead of storing []');
});
check('the endpoint imports the shared module', () => {
  assert.ok(srvSrc.includes("require('./agent-catalog')"),
    'server.js does not use the shared sanitizer — the API and the browser could drift');
});

// ── The editor exposes fields the catalogs can actually be typed into ────────
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
check('the agent editor has Models and Efforts inputs', () => {
  assert.ok(html.includes('id="agentModels"'), 'no #agentModels field — a non-Claude catalog cannot be entered');
  assert.ok(html.includes('id="agentEfforts"'), 'no #agentEfforts field — a non-Claude catalog cannot be entered');
});
check('the editor loads a catalog into the fields when editing', () => {
  assert.ok(html.includes("$i('agentModels').value = Array.isArray(cfg?.models)"),
    'openAgentForm does not populate #agentModels');
  assert.ok(html.includes("$i('agentEfforts').value = Array.isArray(cfg?.efforts)"),
    'openAgentForm does not populate #agentEfforts');
});
check('saveAgent sends the parsed catalogs', () => {
  assert.ok(html.includes('const models = _parseAgentCatalog($i(\'agentModels\').value);'),
    'saveAgent does not parse #agentModels');
  assert.ok(html.includes('body: JSON.stringify({ id, label, ...fields, models, efforts })'),
    'saveAgent does not send models/efforts — the field would be write-only');
});
check('saveAgent mirrors the server merge (empty clears to [])', () => {
  assert.ok(html.includes('next.models = models;'),
    'the local mirror does not store the parsed models');
  assert.ok(html.includes('next.efforts = efforts;'),
    'the local mirror does not store the parsed efforts');
  assert.ok(!html.includes('delete next.models') && !html.includes('delete next.efforts'),
    'the local mirror deletes a cleared catalog, the server stores []');
});
// The browser cannot require() server code, so _parseAgentCatalog is a mirror of
// the module. Pin that it still splits on commas AND caps, the two rules that make
// the local copy agree with what the endpoint stores.
// Run the REAL browser function against the module on the same inputs, so a rule
// added to one side and not the other fails here instead of drifting silently.
check('the browser parser behaves exactly like the shared one', () => {
  const m = html.match(/function _parseAgentCatalog\(value\) \{[\s\S]*?\n\}/);
  assert.ok(m, '_parseAgentCatalog not found in index.html');
  const browserParse = new Function(m[0] + '\nreturn _parseAgentCatalog;')();
  const inputs = [
    '', '  ', ' haiku, sonnet ,opus,haiku ', 'x'.repeat(65) + ',ok', '--dangerously-skip-permissions, -c, gpt-6',
    Array.from({ length: 500 }, (_, i) => `m${i}`).join(','),
  ];
  for (const v of inputs) assert.deepStrictEqual(browserParse(v), parseAgentCatalogInput(v), `diverges on ${JSON.stringify(v).slice(0, 60)}`);
});

if (failed) { console.log(`\n${failed} test(s) failed`); process.exit(1); }
console.log('\nAll agent-catalog tests passed');
