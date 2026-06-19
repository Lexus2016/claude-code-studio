import assert from 'node:assert';
import { loadFn } from './_load.mjs';

// The activity renderers depend on a few globals/DOM helpers — inject light versions.
globalThis.escH = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Minimal i18n stub mirroring index.html TRANSLATIONS for the act.* keys.
const TR = {
  uk: { 'act.live': 'Активні', 'act.scheduled': 'Заплановані', 'act.recent': 'Нещодавні', 'act.empty': 'Немає активності', 'act.recovering': 'віднов.', 'act.now': 'зараз', 'act.in': 'за', 'act.u.s': 'с', 'act.u.m': 'хв', 'act.u.h': 'г', 'act.u.d': 'д' },
  en: { 'act.live': 'Active', 'act.scheduled': 'Scheduled', 'act.recent': 'Recent', 'act.empty': 'No activity', 'act.recovering': 'recovering', 'act.now': 'now', 'act.in': 'in', 'act.u.s': 's', 'act.u.m': 'm', 'act.u.h': 'h', 'act.u.d': 'd' },
};
let _lang = 'uk';
globalThis.t = (k) => (TR[_lang][k] ?? k);
const setLangTest = (l) => { _lang = l; };

globalThis._actAgo = loadFn('_actAgo');
globalThis._actTs = loadFn('_actTs');
globalThis._actElapsed = loadFn('_actElapsed');
globalThis._actSchedWhen = loadFn('_actSchedWhen');
globalThis._actItemHtml = loadFn('_actItemHtml');

// Minimal $i stub: one fake element per id capturing innerHTML/textContent.
const els = {};
globalThis.$i = id => (els[id] = els[id] || { innerHTML: '', textContent: '' });

const renderActivity = loadFn('renderActivity');

// _actTs must read SQLite's space-form datetime (UTC) as UTC — tz-independent of the test host.
assert.strictEqual(_actTs('2026-06-01 12:00:00'), Date.UTC(2026, 5, 1, 12, 0, 0), '_actTs: space-form parsed as UTC');
assert.strictEqual(_actTs('2026-06-01T12:00:00Z'), Date.UTC(2026, 5, 1, 12, 0, 0), '_actTs: ISO/Z parsed as-is');

const data = {
  live: [
    { kind: 'chat', session_id: 's1', title: 'Refactor auth', source: 'web', started_at: Date.now() - 130000, status: 'running', project_id: 'p1', project_name: 'proj-A' },
    { kind: 'task', session_id: null, task_id: 't9', title: 'Nightly report', source: 'scheduler', started_at: null, status: 'recovering', project_id: 'p2', project_name: 'proj-B' },
  ],
  scheduled: [
    { task_id: 't1', session_id: 's2', title: 'Digest', scheduled_at: Math.floor(Date.now() / 1000) + 3600, recurrence: '@daily', project_id: 'p2', project_name: 'proj-B' },
  ],
  recent: [
    { session_id: 's3', title: 'Update <README>', updated_at: new Date(Date.now() - 180000).toISOString().slice(0, 19).replace('T', ' '), project_id: 'p3', project_name: 'proj-C' },
  ],
};

// ── Flat mode ──
globalThis._activityGroupByProject = false;
renderActivity(data);
let html = els['activityList'].innerHTML;
assert.match(html, /🟢 Активні · 2/, 'live subheader + count');
assert.match(html, /⏰ Заплановані · 1/, 'scheduled subheader');
assert.match(html, /🕘 Нещодавні · 1/, 'recent subheader');
assert.match(html, /Refactor auth/, 'live title rendered');
assert.match(html, /act-dot run/, 'running dot');
assert.match(html, /act-dot recovering/, 'recovering dot');
assert.match(html, /activityOpen\('s1','p1'\)/, 'live row opens its session');
assert.match(html, /act-static/, 'recovering row without a session is non-clickable');
assert.ok(!/activityOpen\('null'/.test(html), 'no session => no null onclick');
assert.match(html, /↻/, 'recurrence marker on scheduled');
assert.match(html, /Update &lt;README&gt;/, 'titles are html-escaped');
assert.strictEqual(els['actLiveCount'].textContent, '2', 'live badge count');
// Recent "ago" must be minutes (proves UTC parse of the space-form datetime, tz-independent).
assert.match(html, /Update &lt;README&gt;<\/span><span class="act-proj">proj-C<\/span><span class="act-meta">\dхв<\/span>/, 'recent shows minutes-ago, not tz-skewed hours');

// ── Grouped-by-project mode ──
globalThis._activityGroupByProject = true;
renderActivity(data);
html = els['activityList'].innerHTML;
assert.match(html, /act-group-label">proj-A/, 'group label proj-A');
assert.match(html, /act-group-label">proj-B/, 'group label proj-B');

// ── Empty state ──
renderActivity({ live: [], scheduled: [], recent: [] });
assert.match(els['activityList'].innerHTML, /Немає активності/, 'empty state');

// ── Localization: switch to EN and re-render the same data ──
setLangTest('en');
globalThis._activityGroupByProject = false;
renderActivity(data);
const en = els['activityList'].innerHTML;
assert.match(en, /🟢 Active · 2/, 'EN live header');
assert.match(en, /⏰ Scheduled · 1/, 'EN scheduled header');
assert.match(en, /🕘 Recent · 1/, 'EN recent header');
assert.match(en, /act-meta">\dm<\/span>/, 'EN minutes unit (m)');
renderActivity({ live: [], scheduled: [], recent: [] });
assert.match(els['activityList'].innerHTML, /No activity/, 'EN empty state');
setLangTest('uk');

console.log('PASS activity');
