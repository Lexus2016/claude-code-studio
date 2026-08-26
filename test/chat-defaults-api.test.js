// Global chat defaults + per-project overrides over HTTP — issue #58.
//
// test/chat-defaults.test.js pins the resolver in isolation. This one boots a real
// server in a throwaway APP_DIR and drives the three endpoints the SPA calls, plus
// the settings-form path that owns the global half. What it is here to catch:
//
//   - "the global half is edited through the ordinary settings form" — if the
//     catalog entries were dropped, PUT /api/config/setting would 400 and the
//     Settings section would render empty with no other test noticing.
//   - "a PUT touches only the keys it names" — the bug that would otherwise ship
//     is pinning Model and silently unpinning Turns.
//   - "an invalid value is refused, not trimmed" — a trimmed key looks exactly
//     like a save that worked.
//   - the stored object stays SPARSE, so an unpinned dial keeps following the
//     global. A five-key snapshot passes every other assertion here and still
//     breaks the feature.
//
// Run: node test/chat-defaults-api.test.js   (TEST_PORT=<n> to move off the default)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = Number(process.env.TEST_PORT || 4537);
const BASE = `http://127.0.0.1:${PORT}`;

const APP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-cd58-app-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-cd58-home-'));
process.on('exit', () => { for (const d of [APP_DIR, HOME_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });
const WORKDIR = path.join(APP_DIR, 'workspace');
const PROJ_A = path.join(WORKDIR, 'alpha');
const PROJ_B = path.join(WORKDIR, 'beta');
fs.mkdirSync(PROJ_A, { recursive: true });
fs.mkdirSync(PROJ_B, { recursive: true });

// Both config layers are seeded, so the very first answer has to come from the
// merge chain rather than from the built-ins. `agent` is the interesting pair:
// the GLOBAL file pins a real value and the LOCAL one carries an empty string.
// Spread the two raw and the '' masks 'multi', then sanitising drops it to the
// built-in 'single' — a value neither file ever named. Sanitising per layer is
// what makes the empty local fall through to the global instead.
fs.mkdirSync(path.join(HOME_DIR, '.claude'), { recursive: true });
fs.writeFileSync(path.join(HOME_DIR, '.claude', 'config.json'),
  JSON.stringify({ chatDefaults: { agent: 'multi' } }, null, 2));
fs.writeFileSync(path.join(APP_DIR, 'config.json'),
  JSON.stringify({ mcpServers: {}, skills: {}, chatDefaults: { mode: 'task', agent: '' } }, null, 2));

let srvLog = '';
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), CCS_DESKTOP: '1', APP_DIR, WORKDIR, HOME: HOME_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false;
child.on('exit', () => { exited = true; });
child.stdout.on('data', d => { srvLog += d; });
child.stderr.on('data', d => { srvLog += d; });

let cleanedUp = false;
function cleanup() { if (cleanedUp) return; cleanedUp = true; if (!exited) { try { child.kill('SIGTERM'); } catch {} } }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(1); });
function die(msg) { console.error(msg); if (srvLog) console.error(srvLog.slice(-2000)); cleanup(); process.exit(1); }

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const defaultsOf = async id => (await api('GET', '/api/chat-defaults' + (id ? '?projectId=' + encodeURIComponent(id) : ''))).json;
const storedDefaults = id => {
  const raw = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'data', 'projects.json'), 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.projects || []);
  return (list.find(p => p.id === id) || {}).defaults;
};

(async () => {
  let up = false;
  for (let i = 0; i < 80 && !exited; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (exited) die(`server exited before it became ready — port ${PORT} collision or startup crash`);
  if (!up) die(`server on port ${PORT} did not start`);
  if (!(srvLog.includes('server started') && new RegExp(`"port":\\s*"?${PORT}"?`).test(srvLog))) {
    die(`something answers /api/health on ${PORT} but our server never logged "server started"`);
  }

  const a = await api('POST', '/api/projects', { name: 'alpha', workdir: PROJ_A });
  const b = await api('POST', '/api/projects', { name: 'beta', workdir: PROJ_B });
  if (a.status !== 200 || !a.json?.id || b.status !== 200) die(`could not create the projects: ${a.text} / ${b.text}`);
  const A = a.json.id, B = b.json.id;

  console.log('\n— the global half —');
  const bare = await defaultsOf('');
  check('a value already in the local config.json is what a chat opens on', bare.effective.mode, 'task');
  check('an empty LOCAL value falls through to the global, not to the built-in',
    bare.effective.agent, 'multi');
  check('the keys neither file names fall back to the built-ins',
    [bare.effective.model, bare.effective.effort, bare.effective.turns], ['sonnet', 'auto', 50]);
  // Back to the built-in agent for the rest of the file — as a real local pin,
  // which also proves a VALID local value still outranks the global.
  check('a valid local value wins over the global',
    (await api('PUT', '/api/config/setting', { key: 'chatDefaults.agent', value: 'single' })).json?.setting?.effective,
    'single');

  // The settings form owns the global half. If the catalog entries went missing
  // this is the assertion that says so.
  const setModel = await api('PUT', '/api/config/setting', { key: 'chatDefaults.model', value: 'opus' });
  check('the settings form accepts chatDefaults.model', setModel.status, 200);
  check('and reports it as effective', setModel.json?.setting?.effective, 'opus');
  const setTurns = await api('PUT', '/api/config/setting', { key: 'chatDefaults.turns', value: '5' });
  check('the settings form accepts chatDefaults.turns', setTurns.status, 200);
  check('a turns value outside #maxTurns’ own range is refused',
    (await api('PUT', '/api/config/setting', { key: 'chatDefaults.turns', value: 9999 })).status, 400);
  check('a model outside the CLI aliases is refused',
    (await api('PUT', '/api/config/setting', { key: 'chatDefaults.model', value: 'gpt-4' })).status, 400);
  // The settings row and the toolbar must coerce turns the SAME way, or the two
  // show different limits for one dial.
  check('the settings row refuses a numeric prefix the way the resolver does',
    (await api('PUT', '/api/config/setting', { key: 'chatDefaults.turns', value: '12px' })).status, 400);
  check('and truncates a float instead of storing it',
    (await api('PUT', '/api/config/setting', { key: 'chatDefaults.turns', value: 7.9 })).json?.setting?.effective, 7);
  await api('PUT', '/api/config/setting', { key: 'chatDefaults.turns', value: 5 });
  const afterGlobal = await defaultsOf('');
  check('the refused writes changed nothing', [afterGlobal.effective.model, afterGlobal.effective.turns], ['opus', 5]);

  console.log('\n— the project half —');
  const gotGlobal = await defaultsOf(A);
  check('a project that pinned nothing inherits every dial',
    gotGlobal.effective, { mode: 'task', agent: 'single', model: 'opus', effort: 'auto', turns: 5 });
  check('and reports nothing as overridden', gotGlobal.overridden, []);

  const pin = await api('PUT', `/api/projects/${A}/defaults`, { model: 'sonnet', turns: 10 });
  check('pinning is accepted', pin.status, 200);
  // The exact table from the issue body.
  check('the effective config is the issue’s worked example',
    pin.json.effective, { mode: 'task', agent: 'single', model: 'sonnet', effort: 'auto', turns: 10 });
  check('exactly the pinned dials are reported as overridden', pin.json.overridden, ['model', 'turns']);
  // The whole feature rests on this: a snapshot would pass every check above.
  check('only the pinned keys reach projects.json', storedDefaults(A), { model: 'sonnet', turns: 10 });
  check('the other project is untouched', storedDefaults(B), undefined);
  check('and still inherits', (await defaultsOf(B)).effective.model, 'opus');

  // Sparseness is what makes an unpinned dial follow the global later.
  await api('PUT', '/api/config/setting', { key: 'chatDefaults.mode', value: 'planning' });
  check('an unpinned dial follows the global when it changes', (await defaultsOf(A)).effective.mode, 'planning');
  check('a pinned one does not', (await defaultsOf(A)).effective.model, 'sonnet');

  console.log('\n— what a partial write may touch —');
  const partial = await api('PUT', `/api/projects/${A}/defaults`, { agent: 'multi' });
  check('naming one dial pins it', partial.json.effective.agent, 'multi');
  check('and leaves the dials it did not name alone', storedDefaults(A), { model: 'sonnet', turns: 10, agent: 'multi' });
  const unpin = await api('PUT', `/api/projects/${A}/defaults`, { agent: null });
  check('sending a dial as null unpins just that one', storedDefaults(A), { model: 'sonnet', turns: 10 });
  check('and it goes back to inheriting', unpin.json.effective.agent, 'single');

  const wrapped = await api('PUT', `/api/projects/${A}/defaults`, { defaults: { effort: 'xhigh' } });
  check('a {defaults:{...}} envelope is accepted too', wrapped.json.effective.effort, 'xhigh');
  await api('PUT', `/api/projects/${A}/defaults`, { effort: null });

  console.log('\n— refusals —');
  const bad = await api('PUT', `/api/projects/${A}/defaults`, { model: 'gpt-4', turns: 10 });
  check('an invalid value is refused', bad.status, 400);
  check('and the offending key is named', bad.json.keys, ['model']);
  check('nothing was written by the refused call', storedDefaults(A), { model: 'sonnet', turns: 10 });
  check('a key outside the five is refused', (await api('PUT', `/api/projects/${A}/defaults`, { engine: 'api' })).status, 400);
  // Sending an unknown key as null used to slip past as an unpin and answer 200.
  check('an unknown key sent as null is still refused',
    (await api('PUT', `/api/projects/${A}/defaults`, { notADial: null })).status, 400);
  // A 200 here reads exactly like a reset that worked. Reset is the DELETE.
  check('a null body is refused rather than answered as a no-op',
    (await api('PUT', `/api/projects/${A}/defaults`, { defaults: null })).status, 400);
  check('and so is a body that is not an object at all',
    (await api('PUT', `/api/projects/${A}/defaults`, 'sonnet')).status, 400);
  check('turns above the input’s own max is refused',
    (await api('PUT', `/api/projects/${A}/defaults`, { turns: 9999 })).status, 400);
  check('an unknown project is 404, not 500', (await api('PUT', '/api/projects/proj-nope/defaults', { model: 'opus' })).status, 404);
  check('and so is a reset on one', (await api('DELETE', '/api/projects/proj-nope/defaults')).status, 404);
  // A stale projectId answered 200 with an empty `overridden`, which the SPA
  // cannot tell apart from a project that genuinely pinned nothing.
  check('reading an unknown project is 404 too', (await api('GET', '/api/chat-defaults?projectId=proj-nope')).status, 404);
  check('but no projectId at all is still the global row',
    (await api('GET', '/api/chat-defaults')).status, 200);

  console.log('\n— reset to defaults —');
  const reset = await api('DELETE', `/api/projects/${A}/defaults`);
  check('the reset is accepted', reset.status, 200);
  check('every pin is gone from projects.json', storedDefaults(A), undefined);
  check('and the project is back on the global row', reset.json.effective, reset.json.global);
  check('with nothing left marked as overridden', reset.json.overridden, []);
  check('resetting a project that pinned nothing is still fine',
    (await api('DELETE', `/api/projects/${B}/defaults`)).status, 200);

  // The global half resets through the same form row, by removing the key rather
  // than writing the built-in in as an explicit value.
  await api('DELETE', '/api/config/setting?key=chatDefaults.model');
  check('resetting the global row falls back to the built-in', (await defaultsOf(A)).effective.model, 'sonnet');
  check('and the key is gone from config.json',
    JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8')).chatDefaults.model, undefined);
  check('while its siblings in the same block survive',
    JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8')).chatDefaults.turns, 5);

  console.log('\n— what /api/projects hands the browser —');
  await api('PUT', `/api/projects/${A}/defaults`, { model: 'haiku' });
  const list = await api('GET', '/api/projects');
  const listed = list.json.find(p => p.id === A);
  check('the project row carries its overrides so the UI can badge them', listed.defaults, { model: 'haiku' });
  check('and still carries no password field', 'password' in listed, false);

  // The Settings UI renders whatever the resolver reports; an entry missing from
  // the response is a section that silently loses a row.
  const resolved = await api('GET', '/api/config/resolved');
  check('the resolver reports all five rows',
    resolved.json.settings.filter(s => s.section === 'defaults').map(s => s.key),
    ['chatDefaults.mode', 'chatDefaults.agent', 'chatDefaults.model', 'chatDefaults.effort', 'chatDefaults.turns']);
  check('and the section itself is declared', resolved.json.sections.includes('defaults'), true);

  console.log('\n— the chain reaches session creation, not just the toolbar —');
  // POST /api/sessions is the second door to an interactive chat (the WS `chat`
  // frame is the first). Before this it fell to its own literals — 'sonnet' /
  // 'auto' / 'single' — so an API client or an older cached SPA created a chat on
  // values nobody had configured, while the browser's toolbar showed the resolved
  // ones. `mode` here comes from the LOCAL config.json and `agent_mode` from the
  // GLOBAL one, so a single row also re-proves the per-layer sanitising: spread
  // the two files raw and the local `agent:''` masks the global 'multi'.
  // Asserted against what the resolver reports RIGHT HERE rather than against the
  // seeded literals: earlier blocks in this file deliberately rewrite the global
  // row, and the property worth pinning is "the created row equals the chain",
  // whatever the chain currently says.
  const chainB = (await defaultsOf(B)).effective;
  const sessB = await api('POST', '/api/sessions', { workdir: PROJ_B });
  check('an omitted mode is seeded from the resolved chain', sessB.json.mode, chainB.mode);
  check('and so is an omitted agent mode', sessB.json.agent_mode, chainB.agent);
  check('and an omitted model', sessB.json.model, chainB.model);
  // A pinned {model:'haiku'} a few assertions above; B pinned nothing.
  const chainA = (await defaultsOf(A)).effective;
  check('the two projects really do resolve differently', chainA.model === chainB.model, false);
  const sessA = await api('POST', '/api/sessions', { workdir: PROJ_A });
  check('a project override wins over both config layers', sessA.json.model, 'haiku');
  check('while the dials it did not pin still follow the global', sessA.json.mode, chainB.mode);
  const sessX = await api('POST', '/api/sessions', { workdir: PROJ_A, model: 'opus', mode: 'plan' });
  check('an explicit value still beats the whole chain', [sessX.json.model, sessX.json.mode], ['opus', 'plan']);

  console.log('\n— the unattended channels deliberately do NOT inherit —');
  // Telegram and the scheduler are execution channels, not chat creation. A
  // scheduled job that silently inherited someone\'s turns=200 would burn a budget
  // nobody was watching, and every existing install would have jumped 30 -> 50 on
  // upgrade without being asked. The decision is recorded as a named constant, so
  // a bare 30 reappearing next to a runner is a review signal rather than noise.
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('the unattended budget is declared exactly once',
    (srvSrc.match(/^const UNATTENDED_MAX_TURNS = \d+;$/m) || []).length, 1);
  check('and it is still 30 — changing it changes every install on upgrade',
    /^const UNATTENDED_MAX_TURNS = 30;$/m.test(srvSrc), true);
  check('the scheduled-task runner uses it',
    /const effectiveTaskMaxTurns = task\.max_turns \|\| UNATTENDED_MAX_TURNS;/.test(srvSrc), true);
  check('the Telegram path uses it', /maxTurns: UNATTENDED_MAX_TURNS,/.test(srvSrc), true);
  // The WS `chat` frame is the interactive door, so it must NOT carry a private
  // literal set any more.
  const wsLine = srvSrc.split('\n').find(l => l.includes('const { text:userMessage, attachments=[]'));
  check('the WS chat frame no longer defaults turns to a literal', /maxTurns=\d/.test(wsLine), false);
  check('it resolves them from the chain instead', /maxTurns=_cd\.turns/.test(wsLine), true);
  check('and the same for mode, agent and model',
    ['mode=_cd.mode', 'agentMode=_cd.agent', 'model=_cd.model'].every(f => wsLine.includes(f)), true);
  // The stored row and the run have to agree: `_cd` is hoisted above the INSERT.
  check('the resolved defaults are hoisted above the session INSERT',
    srvSrc.indexOf('const _cd = chatDefaultsForWorkdir(msg.workdir')
      < srvSrc.indexOf('stmts.createSession.run(localSessionId'), true);

  // ── An existing chat must not show the markup's turns (#81) ──────────────
  // Reported as "Kanban chats ignore the default Max Turns", but the Kanban part
  // was incidental: a task's chat is just an existing chat, and the sessions table
  // stored neither `max_turns` nor `effort`. Opening ANY existing chat therefore
  // left the toolbar on whatever the markup shipped (value="50") or on whatever the
  // previously opened chat had put there — never on the configured default.
  console.log('\nper-chat turns and effort are stored, and default when absent:');
  {
    const SPA = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    check('the sessions table stores max_turns',
      /ALTER TABLE sessions ADD COLUMN max_turns/.test(srvSrc), true);
    check('and effort', /ALTER TABLE sessions ADD COLUMN effort/.test(srvSrc), true);

    // They ride the same statement the other dials do — written on every turn.
    const stmt = /updateConfig: db\.prepare\(`([^`]+)`/.exec(srvSrc);
    check('updateConfig writes them', !!stmt && /max_turns=\?,effort=\?/.test(stmt[1]), true);
    // A placeholder/argument mismatch here throws on every chat message, so it is
    // worth counting — but count ARGUMENTS, not commas: the call spans lines and
    // carries comments, and a comma inside one made this pin fail on itself.
    const call = /stmts\.updateConfig\.run\(([\s\S]*?)\);/.exec(srvSrc)[1]
      .replace(/\/\/[^\n]*/g, '')      // line comments
      .replace(/\/\*[\s\S]*?\*\//g, ''); // block comments
    let depth = 0, args = 1;
    for (const ch of call) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) args++;
    }
    check('its placeholders and arguments still match', (stmt[1].match(/\?/g) || []).length, args);

    // The client half: restore what was stored, otherwise fall back to the DEFAULT
    // rather than to whatever the previously opened chat left in the field.
    const lsBody = SPA.slice(SPA.indexOf('async function loadSess'), SPA.indexOf('async function loadSess') + 9000);
    check('loadSess restores a stored max_turns', /d\.max_turns != null/.test(lsBody), true);
    check('and falls back to the configured default, not the field value',
      /_cd \? _cd\.turns : mt\.value/.test(lsBody), true);
    check('effort follows the same rule', /d\.effort != null/.test(lsBody), true);
    // 'auto' is the spelled-out no-flag sentinel; the toolbar spells it ''.
    check('the effort sentinel is translated for the toolbar',
      /_cd\.effort === 'auto' \? '' : _cd\.effort/.test(lsBody), true);

    // Review found three ways the first cut still failed. Each is pinned.
    //
    // 1. The defaults are fetched, and at boot that fetch races connect() and the
    //    first loadSess(). Reading them unawaited leaves the fallback on mt.value —
    //    the markup's 50 — and #81 reproduces exactly as reported.
    check('loadSess awaits the defaults before using them',
      /await loadChatDefaults\(_sessProj\)/.test(lsBody), true);
    // …and against the SESSION's project, not whatever was open before it:
    // curProjectId is assigned further down from d.workdir, so reading it here
    // would apply the previous chat's project overrides to this one.
    // Compared against what the CACHE IS FOR, not against curProjectId: both are
    // null for a session with no workdir, and delProject() clears curProjectId while
    // leaving the cache — so a legacy chat opened afterwards inherited the deleted
    // project's dials.
    check('resolved against the project the cache belongs to',
      /_chatDefaultsProj !== _sessProj/.test(lsBody), true);
    check('and the cache key is written wherever the cache is',
      (SPA.match(/_chatDefaults = /g) || []).length,
      (SPA.match(/_chatDefaultsProj = /g) || []).length);

    // 2. Replaying a turn must not re-dial the chat. Both replay paths call
    //    processChat, whose destructuring falls back to the configured defaults —
    //    and updateConfig then writes those over what the chat was set to.
    check('the idle-interrupt replay carries the stored dials',
      /_isess\?\.max_turns != null \? \{ maxTurns/.test(srvSrc), true);
    check('the interrupted-recovery replay carries them too',
      /sess\.max_turns != null \? \{ maxTurns/.test(srvSrc), true);

    // 3. NULL means "never stored", which is what makes the default fallback work —
    //    so an explicit Auto has to be stored as the spelled-out sentinel, or a chat
    //    deliberately on Auto silently changes when the default does.
    check('an explicit Auto effort is stored as a sentinel, not NULL',
      /\(effort === '' \|\| effort == null\) \? 'auto'/.test(srvSrc), true);
    check('and the client honours a stored auto',
      /d\.effort === 'auto' \? '' : d\.effort/.test(lsBody), true);
    // The client must SEND it too. An omitted key lets the server's destructuring
    // default fill in the current global default, and the next message persists
    // that over the chat's stored 'auto' — the same drift, one layer up.
    check('the chat frame sends auto explicitly, never undefined',
      /effort: curEffort \|\| 'auto'/.test(SPA), true);
    // Stored value and CLI flag are different things: the CLI gets no flag for auto,
    // while the row keeps 'auto' so "chose Auto" stays distinct from "never chose".
    check('the run receives the flag, not the stored sentinel',
      /effort: _effortFlag/.test(srvSrc), true);
    check('and the flag is derived once, from the stored value',
      /const _effortFlag = chatDefaults\.effortToFlag\(effort\)/.test(srvSrc), true);

    // createSession copies only mode/agent/model, so a chat that CONTINUES another
    // one had to carry these two itself or it opened on the default instead.
    const forkBody = srvSrc.slice(srvSrc.indexOf("app.post('/api/sessions/:id/fork'"), srvSrc.indexOf("app.post('/api/sessions/:id/fork'") + 2000);
    check('a fork inherits the dials it forked from',
      /UPDATE sessions SET max_turns=\?, effort=\?/.test(forkBody), true);
    // Every await added inside loadSess needs its own tab re-check: the two guards
    // near the top ran BEFORE it, so a switch during the fetch would let the rest —
    // toolbar, curProjectId, the transcript render, and the resume_task frame — run
    // for a session that is no longer active.
    // Index comparison, not a window: the explanation between the two lines is
    // longer than any window worth hard-coding, and a window that is too small
    // fails on the comment rather than on the code.
    const awaitAt = lsBody.indexOf('await loadChatDefaults(_sessProj)');
    const recheckAt = lsBody.indexOf('if (id !== activeTabId) return;', awaitAt);
    check('the added await re-checks the tab afterwards',
      awaitAt !== -1 && recheckAt > awaitAt, true);

    const compactAt = srvSrc.indexOf('const compactTitle');
    const compactBody = srvSrc.slice(compactAt - 600, compactAt + 1600);
    check('a compact keeps them as well',
      /UPDATE sessions SET max_turns=\?, effort=\?/.test(compactBody), true);
    const importAt = srvSrc.indexOf("String(session.title || 'Imported session')");
    check('and an import carries what it was exported with',
      /UPDATE sessions SET max_turns=\?, effort=\?/.test(srvSrc.slice(importAt, importAt + 1200)), true);
  }

  cleanup();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => die(String(e && e.stack || e)));
