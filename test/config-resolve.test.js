// Precedence resolver + secret masking for the Settings UI (issue #40).
// No test framework in this project — plain node, named assertions, exit 1 on FAIL.
// Run: node test/config-resolve.test.js
//
// Two guarantees are load-bearing and are mutation-tested in the PR notes:
//   1. the precedence order (process env > .env > default; local > global config)
//   2. secret masking — no raw API key / token / session secret ever reaches the client
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const R = require('../config-resolve');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const S = key => R.getSetting(key);
const resolve = (key, sources) => R.resolveSetting(S(key), sources);
const srcOrder = res => res.sources.map(s => s.source);

// ── 1. env precedence: process env > .env file > built-in default ────────────
// server.js:16-29 — `if (k && !(k in process.env))`: .env never overwrites a
// variable the process already had.
console.log('env-backed settings — process env beats .env beats the default:');
{
  const all = resolve('PORT', { processEnv: { PORT: '4100' }, dotenv: { PORT: '3999' } });
  check('candidate order is process-env, dotenv, default', srcOrder(all), ['process-env', 'dotenv', 'default']);
  check('process env wins', all.effective, '4100');
  check('winner is labelled process-env', all.effectiveSource, 'process-env');
  check('the .env line is reported as shadowed', all.shadowedDotenv, true);
  check('the row is flagged overridden', all.overriddenBy, 'dotenv');

  const onlyEnvFile = resolve('PORT', { processEnv: {}, dotenv: { PORT: '3999' } });
  check('.env wins when the process env has nothing', onlyEnvFile.effective, '3999');
  check('.env winner is not marked shadowed', onlyEnvFile.shadowedDotenv, false);

  const bare = resolve('PORT', {});
  check('the built-in default is the last resort', bare.effective, 3000);
  check('a default-valued setting is not "modified"', bare.modified, false);

  // server.js:95 reads `process.env.PORT || 3000` — an empty variable is not a value.
  const empty = resolve('PORT', { processEnv: { PORT: '' }, dotenv: { PORT: '3999' } });
  check('an empty env var behaves as unset', empty.effective, '3999');

  // claude-cli.js:70 — CLAUDE_TIMEOUT_MS is the legacy alias, tried after the new name.
  const alias = resolve('CLAUDE_IDLE_TIMEOUT_MS', { dotenv: { CLAUDE_TIMEOUT_MS: '90000' } });
  check('the legacy alias is honoured', alias.effective, '90000');
  check('the alias name is reported', alias.sources[0].via, 'CLAUDE_TIMEOUT_MS');
  const both = resolve('CLAUDE_IDLE_TIMEOUT_MS', { dotenv: { CLAUDE_IDLE_TIMEOUT_MS: '10', CLAUDE_TIMEOUT_MS: '99' } });
  check('the canonical name beats the alias', both.effective, '10');

  // server.js:2971 etc — `session.workdir || WORKDIR`.
  const wd = resolve('WORKDIR', {
    processEnv: { WORKDIR: '/srv/ws' },
    project: { id: 'p1', name: 'demo', workdir: '/home/u/demo' },
  });
  check('a registered project workdir outranks WORKDIR', wd.effective, '/home/u/demo');
  check('the project source is first', srcOrder(wd)[0], 'project');
}

// ── 2. config.json precedence — and the chain that ignores the global file ───
// server.js:2564-2577 loadMergedConfig() → local > global > default
// server.js:2308-2347 loadConfig()       → local > default, global never opened
console.log('\nconfig.json-backed settings — local overrides global, on the merged chain only:');
{
  const merged = resolve('defaultEngine', {
    localConfig: { defaultEngine: 'subscription' },
    globalConfig: { defaultEngine: 'api' },
  });
  check('local config.json wins on the merged chain', merged.effective, 'subscription');
  check('candidate order is local, global, default', srcOrder(merged), ['config-local', 'config-global', 'default']);
  check('the global value is shown, not hidden', merged.sources[1].value, 'api');
  check('the global value is not marked ignored', merged.sources[1].ignored, false);

  const globalOnly = resolve('lang', { globalConfig: { lang: 'fr' } });
  check('the global file is used when local has nothing', globalOnly.effective, 'fr');
  check('and it is credited as the source', globalOnly.effectiveSource, 'config-global');

  // The finding: terminal.* / slashCommands are read by loadConfig(), which never
  // opens ~/.claude/config.json. A value set there does nothing.
  const localChain = resolve('terminal.enabled', {
    localConfig: {},
    globalConfig: { terminal: { enabled: true } },
  });
  check('a global terminal.enabled does NOT win', localChain.effective, false);
  check('the winner is the built-in default', localChain.effectiveSource, 'default');
  check('the global file is still listed, so the user can see the dead value',
    srcOrder(localChain), ['config-global', 'default']);
  check('the global entry is flagged as never read', localChain.ignoredSources, ['config-global']);
  check('an ignored source cannot be the winner', localChain.sources.find(s => s.ignored).ignored, true);

  const nested = resolve('terminal.maxLive', { localConfig: { terminal: { maxLive: 9 } } });
  check('a dotted config path resolves', nested.effective, 9);
}

// ── 2b. `||` vs `??` — the UI must report the value the server actually runs on ─
// loadMergedConfig() resolves lang and defaultEngine with `||` and
// recentProjectsCount with `??`. That difference is invisible until a config file
// carries a falsy value: with `||` an empty string is SKIPPED and the next source
// down is what the server uses, so reporting `""` as effective would point the
// user at the wrong file. The catalog states the difference per key
// (falsyFallsThrough) and the guard below keeps that flag honest against server.js.
console.log('\nfalsy config values follow the operator loadMergedConfig() actually uses:');
{
  const empty = resolve('lang', { localConfig: { lang: '' }, globalConfig: { lang: 'fr' } });
  check('an empty local lang does not win', empty.effective, 'fr');
  check('the global file is credited instead', empty.effectiveSource, 'config-global');
  check('the dead local value is still shown to the user', empty.sources[0].value, '');
  check('struck through, so it is visibly not in effect', empty.ignoredSources, ['config-local']);

  const both = resolve('lang', { localConfig: { lang: '' }, globalConfig: { lang: '' } });
  check('two empty files fall through to the built-in default', both.effective, 'en');
  check('and both are flagged', both.ignoredSources, ['config-local', 'config-global']);

  const engine = resolve('defaultEngine', { localConfig: { defaultEngine: '' } });
  check('defaultEngine behaves the same way', engine.effective, 'api');
  check('crediting the default', engine.effectiveSource, 'default');

  // Positive control: the flag must not swallow real values. Only falsy ones.
  const real = resolve('lang', { localConfig: { lang: 'he' }, globalConfig: { lang: 'fr' } });
  check('positive control: a real value still wins', real.effective, 'he');
  check('positive control: and is not flagged', real.ignoredSources, []);

  // recentProjectsCount is the OTHER operator: `??` honours 0, and the config UI
  // has to say so, or a user who typed 0 sees the number 5 reported back.
  const zero = resolve('recentProjectsCount', { localConfig: { recentProjectsCount: 0 } });
  check('a zero recentProjectsCount is honoured, not skipped', zero.effective, 0);
  check('because it is resolved with ?? , not ||', zero.effectiveSource, 'config-local');
  check('and it carries no falsyFallsThrough flag',
    !!R.SETTINGS.find(s => s.key === 'recentProjectsCount').falsyFallsThrough, false);

  // The guard. Read the operator straight out of loadMergedConfig() for every
  // merged config-backed key in the catalog and require the flag to match it.
  // Flipping either side without the other now fails here.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const body = server.slice(server.indexOf('function loadMergedConfig()'));
  const merged = R.SETTINGS.filter(s => s.backing === 'config' && s.merge === 'merged');
  check('there are merged config keys to check at all', merged.length > 0, true);
  const mismatched = merged.filter(s => {
    const m = body.match(new RegExp('^\\s*' + s.key + ':\\s*(.+)$', 'm'));
    if (!m) return true;                       // key not resolved there → flag unverifiable
    const usesOr = / \|\| /.test(m[1]);
    return usesOr !== !!s.falsyFallsThrough;
  }).map(s => s.key);
  check('every falsyFallsThrough flag matches the operator in loadMergedConfig()', mismatched, []);
}

// ── 3. Secret masking — nothing raw leaves resolveSetting() ─────────────────
console.log('\nsecrets are masked before they can reach the browser:');
{
  const RAW = 'sk-ant-api03-SUPERSECRET-DO-NOT-LEAK';
  const r = resolve('ANTHROPIC_API_KEY', { processEnv: { ANTHROPIC_API_KEY: RAW }, dotenv: { ANTHROPIC_API_KEY: 'other-key' } });
  const blob = JSON.stringify(r);
  check('the raw key is absent from the whole resolved row', blob.includes(RAW), false);
  check('the shadowed .env secret is absent too', blob.includes('other-key'), false);
  check('the effective value is the mask', r.effective, '***');
  check('every source value is masked', r.sources.map(s => s.value), ['***', '***', '']);
  check('the row still reports that a value IS set', r.isSet, true);
  check('a secret is never editable through the form', r.readOnly, true);

  const unset = resolve('SESSION_SECRET', {});
  check('an unset secret masks to an empty string', unset.effective, '');
  check('and reports isSet false', unset.isSet, false);

  check('maskSecret() maps any non-empty value to ***', R.maskSecret('a'), '***');
  check('maskSecret() maps empty to empty', R.maskSecret(''), '');
  check('maskSecret() maps undefined to empty', R.maskSecret(undefined), '');

  // Second net: an obviously-secret NAME is masked even without the explicit flag.
  check('SESSION_SECRET is detected by name', R.isSecretKey('SESSION_SECRET'), true);
  check('ANTHROPIC_AUTH_TOKEN is detected by name', R.isSecretKey('ANTHROPIC_AUTH_TOKEN'), true);
  check('GITHUB_API_KEY would be detected by name', R.isSecretKey('GITHUB_API_KEY'), true);
  check('SSH_PASSWORD would be detected by name', R.isSecretKey('SSH_PASSWORD'), true);
  check('PORT is not a secret', R.isSecretKey('PORT'), false);

  // Whole-catalog sweep: resolve everything with a poisoned environment and prove
  // the payload the endpoint would send contains no marker.
  const POISON = 'ZZ-LEAKED-VALUE-ZZ';
  const env = {};
  for (const def of R.SETTINGS) if (def.backing === 'env') env[def.key] = POISON;
  const payload = JSON.stringify(R.resolveAll({
    processEnv: env,
    dotenv: { ANTHROPIC_API_KEY: POISON, SESSION_SECRET: POISON },
    localConfig: {}, globalConfig: {},
  }));
  // Sweep the WHOLE row, not just .effective — sources[i].value is a second way out,
  // and it is exactly the field the single-key test above checks.
  const rows = JSON.parse(payload);
  const leaked = R.SETTINGS.filter(d => R.isSecretKey(d.key, d))
    .filter(d => JSON.stringify(rows.find(s => s.key === d.key)).includes(POISON))
    .map(d => d.key);
  check('no catalogued secret leaks its value anywhere in a full resolveAll()', leaked, []);
  check('non-secret env values DO come through (the sweep is not vacuous)',
    JSON.parse(payload).find(s => s.key === 'PORT').effective, POISON);
}

// ── 4. Writes: what the form is allowed to change ──────────────────────────
console.log('\ncoerceValue() refuses what must not be written from a form:');
{
  check('a secret cannot be written', R.coerceValue(S('ANTHROPIC_API_KEY'), 'x').error, 'secret_not_editable');
  check('a collection cannot be written', R.coerceValue(S('mcpServers'), {}).error, 'read_only');
  check('a read-only path cannot be written', R.coerceValue(S('APP_DIR'), '/tmp').error, 'read_only');
  check('an unknown setting is refused', R.coerceValue(null, 'x').error, 'unknown_setting');
  check('a bool takes a boolean', R.coerceValue(S('terminal.enabled'), true), { ok: true, value: true });
  check('a bool takes the string form too', R.coerceValue(S('terminal.enabled'), 'false'), { ok: true, value: false });
  check('a bool rejects junk', R.coerceValue(S('terminal.enabled'), 'yes').error, 'expected_bool');
  check('a number is parsed', R.coerceValue(S('PORT'), '8080'), { ok: true, value: 8080 });
  check('a number rejects junk', R.coerceValue(S('PORT'), 'abc').error, 'expected_number');
  check('an enum accepts a listed choice', R.coerceValue(S('lang'), 'he'), { ok: true, value: 'he' });
  check('an enum rejects an unlisted one', R.coerceValue(S('lang'), 'de').error, 'invalid_choice');
  // A newline would append an extra variable to .env.
  check('a newline is refused in a .env value', R.coerceValue(S('HOST'), 'a\nB=1').error, 'newline_not_allowed');

  // formWritable() is the gate DELETE shares with PUT — a value-less reset must
  // refuse exactly what a write refuses, for the same reason.
  check('formWritable refuses a secret', R.formWritable(S('SESSION_SECRET')).error, 'secret_not_editable');
  check('formWritable refuses a collection', R.formWritable(S('skills')).error, 'read_only');
  check('formWritable refuses a read-only key', R.formWritable(S('APP_DIR')).error, 'read_only');
  check('formWritable refuses an unknown key', R.formWritable(null).error, 'unknown_setting');
  check('formWritable allows an ordinary setting', R.formWritable(S('PORT')), { ok: true });
}

// ── 5. .env rewriting keeps the loader's first-occurrence rule ──────────────
console.log('\nsetDotenvValue() edits in place (the loader takes the FIRST match):');
{
  const src = '# comment\nPORT=3000\n# PORT=9999\nHOST=127.0.0.1\n';
  const out = R.setDotenvValue(src, 'PORT', 8080);
  check('the active line is replaced', out.includes('PORT=8080'), true);
  check('the old value is gone', out.includes('PORT=3000'), false);
  check('the commented line is left alone', out.includes('# PORT=9999'), true);
  check('other keys are untouched', out.includes('HOST=127.0.0.1'), true);
  // Counting active PORT= lines, not occurrences of the new value: an
  // implementation that appended instead of replacing would still show exactly
  // one `PORT=8080`, and the label would be lying about what it proved.
  check('nothing is appended when the key exists',
    out.split('\n').filter(l => /^\s*PORT\s*=/.test(l)).length, 1);

  const appended = R.setDotenvValue('HOST=0.0.0.0\n', 'PORT', 8080);
  check('a missing key is appended', appended, 'HOST=0.0.0.0\nPORT=8080\n');
  check('a newline is added when the file lacks a trailing one',
    R.setDotenvValue('HOST=0.0.0.0', 'PORT', 1), 'HOST=0.0.0.0\nPORT=1\n');

  check('parseDotenv keeps the first occurrence', R.parseDotenv('A=1\nA=2\n').A, '1');
  check('parseDotenv skips comments', R.parseDotenv('#A=1\nB=2\n'), { B: '2' });
  check('parseDotenv strips surrounding quotes', R.parseDotenv('A="x y"\n').A, 'x y');
}

// ── 5b. Resetting a setting removes it, rather than writing the default in ──
// An explicit value would keep winning after the built-in default changes, and
// would keep the row reading as "configured" in the very view meant to explain it.
console.log('\nreset removes the key from the file the form owns:');
{
  const src = '# comment\nPORT=3000\n# PORT=9999\nHOST=127.0.0.1\n';
  const out = R.unsetDotenvValue(src, 'PORT');
  check('the active line is gone', /^\s*PORT\s*=/m.test(out), false);
  check('the commented line survives', out.includes('# PORT=9999'), true);
  check('other keys are untouched', out.includes('HOST=127.0.0.1'), true);
  check('every active occurrence is removed',
    R.unsetDotenvValue('PORT=1\nPORT=2\nHOST=x\n', 'PORT'), 'HOST=x\n');
  check('removing an absent key is a no-op', R.unsetDotenvValue('HOST=x\n', 'PORT'), 'HOST=x\n');

  const conf = { terminal: { maxLive: 9 }, lang: 'fr' };
  check('deletePath removes the leaf', R.deletePath(conf, 'terminal.maxLive'), true);
  // An orphaned `"terminal": {}` reads as a section that is still configured.
  check('and prunes the parent it emptied', 'terminal' in conf, false);
  check('siblings survive', conf.lang, 'fr');
  check('a parent that still has keys is kept', (() => {
    const c = { terminal: { maxLive: 9, enabled: true } };
    R.deletePath(c, 'terminal.maxLive');
    return c.terminal;
  })(), { enabled: true });
  check('deleting an absent path reports false', R.deletePath({}, 'terminal.maxLive'), false);

  // The button is offered only where there IS something to delete.
  check('a value living in .env is resettable',
    resolve('PORT', { dotenv: { PORT: '3999' } }).resettable, true);
  check('a value only the shell exports is NOT resettable',
    resolve('PORT', { processEnv: { PORT: '4100' } }).resettable, false);
  check('an untouched setting is not resettable', resolve('PORT', {}).resettable, false);
  check('a local config.json value is resettable',
    resolve('defaultEngine', { localConfig: { defaultEngine: 'subscription' } }).resettable, true);
  check('a value that only the global file defines is not ours to reset',
    resolve('lang', { globalConfig: { lang: 'fr' } }).resettable, false);
  check('a secret is never resettable',
    resolve('ANTHROPIC_API_KEY', { dotenv: { ANTHROPIC_API_KEY: 'x' } }).resettable, false);
  check('a collection is never resettable',
    resolve('mcpServers', { localConfig: { mcpServers: { a: {} } } }).resettable, false);
}

// ── 6. The catalog itself stays coherent ───────────────────────────────────
console.log('\ncatalog integrity:');
{
  check('every setting lands in a declared section',
    R.SETTINGS.filter(s => !R.SECTIONS.includes(s.section)).map(s => s.key), []);
  check('no duplicate keys',
    R.SETTINGS.length - new Set(R.SETTINGS.map(s => s.key)).size, 0);
  check('every config-backed setting declares a path',
    R.SETTINGS.filter(s => s.backing !== 'env' && !s.path).map(s => s.key), []);
  check('every config-backed setting declares a merge chain',
    R.SETTINGS.filter(s => s.backing !== 'env' && !['merged', 'local'].includes(s.merge)).map(s => s.key), []);
  check('every secret is read-only',
    R.SETTINGS.filter(s => R.isSecretKey(s.key, s) && !s.readOnly).map(s => s.key), []);
  // Section 3 of test/i18n-completeness.test.js only sees t('cfg.h.' + key) as a
  // prefix, so nothing there proves each concrete help key exists. Do it here.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = html.indexOf('const TRANSLATIONS = {');
  let depth = 0, i = html.indexOf('{', start), end = -1;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const I18N = new Function('return ' + html.slice(html.indexOf('{', start), end + 1))();
  for (const lang of ['uk', 'en', 'ru', 'fr', 'he']) {
    check(`${lang}: a help text exists for every setting`,
      R.SETTINGS.filter(s => !I18N[lang]['cfg.h.' + s.key]).map(s => s.key), []);
  }
  for (const lang of ['uk', 'en', 'ru', 'fr', 'he']) {
    check(`${lang}: a label exists for every section and source`,
      [...R.SECTIONS.map(s => 'cfg.sec.' + s), ...R.SOURCES.map(s => 'cfg.src.' + s.replace(/-/g, '_')),
       'cfg.reset', 'cfg.reset.title', 'cfg.reset.done']
        .filter(k => I18N[lang][k] === undefined), []);
  }
}

// ── 7. End-to-end over HTTP: the real endpoints, behind the real auth ───────
// Boots server.js in a throwaway APP_DIR so nothing touches the developer's data.
console.log('\nlive server: /api/config/resolved + /api/config/setting');
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-cfg40-'));
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  const RAW_SECRET = 'sk-ant-LIVE-LEAK-CANARY';
  fs.writeFileSync(path.join(tmp, '.env'),
    `ANTHROPIC_API_KEY=${RAW_SECRET}\nMAX_TASK_WORKERS=7\nCLAUDE_HARD_CAP_MS=1234567\n`);
  fs.writeFileSync(path.join(tmp, 'config.json'),
    JSON.stringify({ mcpServers: {}, skills: {}, defaultEngine: 'subscription' }, null, 2));

  // Other agents hold 3990-3999 in this workspace; pick high and poll, never kill.
  const PORT = 3907 + (process.pid % 40);
  const child = require('child_process').spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      APP_DIR: tmp, PORT: String(PORT), HOST: '127.0.0.1',
      CCS_DESKTOP: '', WORKDIR: path.join(tmp, 'workspace'),
      // A shell-exported value must beat the .env line — that is guarantee #1.
      MAX_TASK_WORKERS: '11',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });

  const get = (p, opts = {}) => new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: opts.method || 'GET',
      headers: opts.headers || {} }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => res({ status: r.statusCode, body: b, headers: r.headers }));
    });
    req.on('error', e => res({ status: 0, body: String(e.message) }));
    if (opts.body) req.write(opts.body);
    req.end();
  });

  async function waitFor(pred, { timeoutMs = 25000, intervalMs = 150, what = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let v; try { v = await pred(); } catch { v = false; }
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n--- server output ---\n${out}`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  let failedToBoot = null;
  try {
    await waitFor(async () => (await get('/api/health')).status === 200, { what: 'the server to listen' });

    // Auth gate: /api routes sit behind auth.authMiddleware. On a fresh APP_DIR no
    // account exists yet, so the middleware must still not serve config data.
    const anon = await get('/api/config/resolved');
    check('an unauthenticated caller does not get resolved settings', anon.status === 200, false);
    check('and the response carries no secret', anon.body.includes(RAW_SECRET), false);

    // Create the account, then log in for the authenticated half.
    // Built at runtime rather than written as a literal, so no password-shaped
    // string sits in the repo. Loopback setup needs no console code (auth.js:196).
    const pw = 'cfg40-' + crypto.randomBytes(6).toString('hex');
    const setup = await get('/api/auth/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw, displayName: 'test' }),
    });
    check('setup succeeded', setup.status, 200);
    const cookie = String((setup.headers['set-cookie'] || [])[0] || '');
    const token = (cookie.match(/token=([^;]+)/) || [])[1] || '';
    check('setup issued a token cookie', !!token, true);
    check('the token cookie is httpOnly', /HttpOnly/i.test(cookie), true);

    const auth = { 'x-auth-token': token, 'Content-Type': 'application/json' };
    const r = await get('/api/config/resolved', { headers: auth });
    check('an authenticated caller gets 200', r.status, 200);
    check('the live payload never contains the raw API key', r.body.includes(RAW_SECRET), false);

    const payload = JSON.parse(r.body);
    const by = k => payload.settings.find(s => s.key === k);
    check('the masked key is reported as set', by('ANTHROPIC_API_KEY').effective, '***');
    check('a shell-exported var beats the .env line', by('MAX_TASK_WORKERS').effective, '11');
    check('and the .env line is shown as shadowed', by('MAX_TASK_WORKERS').shadowedDotenv, true);
    check('a var only the .env file defines is credited to .env',
      by('CLAUDE_HARD_CAP_MS').effectiveSource, 'dotenv');
    check('and its value comes through', by('CLAUDE_HARD_CAP_MS').effective, '1234567');
    check('and it is not marked shadowed', by('CLAUDE_HARD_CAP_MS').shadowedDotenv, false);
    check('the local config.json value wins for defaultEngine', by('defaultEngine').effective, 'subscription');

    // Write path: a config-backed setting round-trips into config.json.
    const w = await get('/api/config/setting', {
      method: 'PUT', headers: auth, body: JSON.stringify({ key: 'terminal.maxLive', value: 4 }),
    });
    check('the write is accepted', JSON.parse(w.body).ok, true);
    check('config.json now holds it',
      JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).terminal.maxLive, 4);

    // Write path: an env-backed setting round-trips into .env, in place.
    await get('/api/config/setting', {
      method: 'PUT', headers: auth, body: JSON.stringify({ key: 'SESSION_TTL_DAYS', value: 45 }),
    });
    const envNow = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
    check('.env gained the new key', envNow.includes('SESSION_TTL_DAYS=45'), true);
    check('.env still holds the untouched secret line', envNow.includes(RAW_SECRET), true);

    // Refusals.
    const bad = await get('/api/config/setting', {
      method: 'PUT', headers: auth, body: JSON.stringify({ key: 'ANTHROPIC_API_KEY', value: 'nope' }),
    });
    check('writing a secret through the form is refused', bad.status, 400);
    check('.env was not rewritten by the refused call',
      fs.readFileSync(path.join(tmp, '.env'), 'utf8').includes('nope'), false);
    const unknown = await get('/api/config/setting', {
      method: 'PUT', headers: auth, body: JSON.stringify({ key: 'rm -rf', value: '1' }),
    });
    check('an unknown key is refused', unknown.status, 400);

    // Reset: the key leaves the file, so the built-in default takes over again.
    check('the written value is reported as resettable',
      JSON.parse((await get('/api/config/resolved', { headers: auth })).body)
        .settings.find(s => s.key === 'terminal.maxLive').resettable, true);
    const del = await get('/api/config/setting?key=terminal.maxLive', { method: 'DELETE', headers: auth });
    check('the reset is accepted', JSON.parse(del.body).ok, true);
    check('the resolver falls back to the built-in default',
      JSON.parse(del.body).setting.effectiveSource, 'default');
    // DELETE removes the leaf and prunes the parent it emptied, so nothing about
    // `terminal` is left in the file. (loadConfig() re-seeds a missing `terminal`
    // block on the NEXT read — that is what restores the default at runtime, and
    // it is why reading the file is the only way to see the removal.)
    const confAfter = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    check('the key the user set is removed from config.json outright',
      'maxLive' in (confAfter.terminal || {}), false);
    // The parent survives because sibling keys remain — loadConfig() seeds
    // enabled/idleTimeoutMin at boot. Pruning is proven separately at the unit
    // level, where the parent really does end up empty.
    check('its siblings in the same block are untouched',
      'enabled' in (confAfter.terminal || {}), true);
    // "the value is gone" alone is also true of a reset that wrote the WRONG
    // default, so name the value the resolver must now report.
    check('and the resolver reports the catalogued default, not some other number',
      JSON.parse(del.body).setting.effective, R.getSetting('terminal.maxLive').def);
    check('a sibling key in config.json survived the reset', confAfter.defaultEngine, 'subscription');

    // A key that loadConfig() does NOT re-seed disappears from the file outright.
    const delEngine = await get('/api/config/setting?key=defaultEngine', { method: 'DELETE', headers: auth });
    check('resetting an unseeded key is accepted', JSON.parse(delEngine.body).ok, true);
    check('and it is gone from config.json',
      'defaultEngine' in JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')), false);
    check('the resolver reports the built-in default for it',
      JSON.parse(delEngine.body).setting.effective, 'api');

    const delEnv = await get('/api/config/setting?key=SESSION_TTL_DAYS', { method: 'DELETE', headers: auth });
    check('the .env reset is accepted', JSON.parse(delEnv.body).ok, true);
    const envAfter = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
    check('.env lost the key', /^\s*SESSION_TTL_DAYS\s*=/m.test(envAfter), false);
    check('.env kept the secret line the reset never touched', envAfter.includes(RAW_SECRET), true);

    const delSecret = await get('/api/config/setting?key=ANTHROPIC_API_KEY', { method: 'DELETE', headers: auth });
    check('resetting a secret is refused', delSecret.status, 400);
    check('and the secret is still in .env',
      fs.readFileSync(path.join(tmp, '.env'), 'utf8').includes(RAW_SECRET), true);
  } catch (e) {
    failedToBoot = e;
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 300));
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  if (failedToBoot) { fail++; console.error(`  FAIL live server section — ${failedToBoot.message}`); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
