// Global workspace aggregation (#25) — /api/global/overview and /api/global/search.
//
// What is actually at risk here, and therefore what this asserts:
//   1. The rollup is one GROUP BY across every project. A regression that filters
//      to the "current" project, or drops projects with no tasks, is invisible in
//      a single-project setup — so the fixtures use two projects plus a task with
//      no workdir at all.
//   2. Due buckets are cut by SQL against a bound `now`/`dayEnd`. Off-by-one here
//      means a task silently lands in the wrong list. A dated task left in
//      `backlog` must NOT be listed as due: the scheduler only runs status='todo'
//      (see test/kanban-schedule.test.js), so calling it overdue promises a run
//      that will never happen.
//   3. LIKE wildcards in a user's query must be escaped. Without it "100%off"
//      matches "100% off" and every search silently means something else.
//   4. The project filter takes a project ID and resolves the workdir server-side.
//      An unknown id must be refused, not silently treated as "all projects".
//
// Every filter assertion is paired with a positive control — a function that
// returns nothing passes all of the negative ones.
//
// Runs against a REAL server on a THROWAWAY APP_DIR, never the developer's
// data/chats.db.
//
// Run: node test/global-workspace.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// 3991-3996 are claimed by the other suites in the chain.
const PORT = Number(process.env.TEST_PORT || 3997);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-global-'));
fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true });

// Generated per run so no credential literal ever lands in the repo.
const PW = crypto.randomBytes(18).toString('hex');
let TOKEN = null;
async function api(method, url, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (TOKEN) headers['x-auth-token'] = TOKEN;
  const r = await fetch(BASE + url, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await r.json(); } catch {}
  const setCookie = r.headers.get('set-cookie') || '';
  return { status: r.status, json, cookieToken: (setCookie.match(/(?:^|[;,\s])token=([^;,\s]+)/) || [])[1] || null };
}

// The parent shell of a Claude Code session exports CCS_DESKTOP=1 (which turns the
// auth wall off) and APP_DIR (which repoints data/ at the real user dir), so the
// child env is scrubbed rather than merely overridden.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.CCS_DESKTOP;
  for (const k of ['CCS_INTERRUPT_URL', 'CCS_INTERRUPT_SESSION', 'CCS_INTERRUPT_SECRET']) delete env[k];
  return env;
}

function canConnect(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = ok => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

// Poll instead of sleeping: a fixed wait passes on an idle laptop and lies on a
// loaded CI box. Same helper shape as test/path-guard.test.js.
async function waitFor(pred, { timeoutMs = 30000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v; try { v = await pred(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

const titles = rows => (rows || []).map(r => r.title).sort();

(async () => {
  if (await canConnect('127.0.0.1', PORT, 500)) {
    console.error(`port ${PORT} is already in use — refusing to run against someone else's server. Set TEST_PORT.`);
    process.exit(1);
  }

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: childEnv({ PORT: String(PORT), APP_DIR, WORKDIR: APP_DIR, HOST: '127.0.0.1', LOG_LEVEL: 'error' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d; });
  srv.stderr.on('data', d => { srvLog += d; });
  const stop = () => { try { srv.kill('SIGTERM'); } catch {} };
  process.on('exit', stop);

  try {
    const up = await waitFor(async () => {
      // setupDone===false identifies OUR freshly-seeded instance; a stray server on
      // this port answers 200 too and would pass half the asserts silently.
      const r = await api('GET', '/api/auth/status');
      return r.status === 200 && r.json?.setupDone === false;
    }, { timeoutMs: 30000, intervalMs: 250 });
    if (!up) { console.error('server never came up:\n' + srvLog); stop(); process.exit(1); }

    const setup = await api('POST', '/api/auth/setup', { password: PW, displayName: 'Owner' });
    TOKEN = setup.cookieToken || (await api('POST', '/api/auth/login', { password: PW })).cookieToken;
    check('authenticated for the global endpoints', typeof TOKEN === 'string' && TOKEN.length > 0, true);

    // ── fixtures: three projects, one of them deliberately empty ─────────────
    const wdA = path.join(APP_DIR, 'alpha'); fs.mkdirSync(wdA, { recursive: true });
    const wdB = path.join(APP_DIR, 'beta');  fs.mkdirSync(wdB, { recursive: true });
    const wdC = path.join(APP_DIR, 'gamma'); fs.mkdirSync(wdC, { recursive: true });
    const A = (await api('POST', '/api/projects', { name: 'Alpha', workdir: wdA })).json.id;
    const B = (await api('POST', '/api/projects', { name: 'Beta', workdir: wdB })).json.id;
    await api('POST', '/api/projects', { name: 'Gamma', workdir: wdC });   // no tasks at all
    check('three projects registered', [typeof A, typeof B], ['string', 'string']);

    const now = Math.floor(Date.now() / 1000);
    const mk = (t) => api('POST', '/api/tasks', t);
    // Scheduled fixtures are created as in_progress / far-future todo on purpose:
    // a past-due `todo` is picked up by processQueue within a tick and mutated
    // mid-assertion, which would make this suite depend on scheduler timing.
    await mk({ title: 'alpha backlog 100% off', workdir: wdA, status: 'backlog' });
    await mk({ title: 'alpha second backlog',   workdir: wdA, status: 'backlog' });
    await mk({ title: 'alpha overdue run',      workdir: wdA, status: 'in_progress', scheduled_at: now - 3600 });
    await mk({ title: 'beta done item',         workdir: wdB, status: 'done' });
    await mk({ title: 'beta due later today',   workdir: wdB, status: 'in_progress', scheduled_at: now + 30 });
    await mk({ title: 'beta upcoming next week', workdir: wdB, status: 'todo', scheduled_at: now + 86400 * 7 });
    // The negative control for the "dated backlog never fires" rule.
    await mk({ title: 'beta dated but parked',  workdir: wdB, status: 'backlog', scheduled_at: now - 7200 });
    // A task with no workdir at all — predates the column; must still be counted.
    await mk({ title: 'orphan with no project', status: 'backlog' });

    // ── /api/global/overview: the rollup ─────────────────────────────────────
    console.log('\n— overview: one rollup across every project —');
    const ov = (await api('GET', '/api/global/overview')).json;

    check('totals count every task in every project',
      [ov.total, ov.totals.backlog, ov.totals.todo, ov.totals.in_progress, ov.totals.done],
      [8, 4, 1, 2, 1]);

    const byName = Object.fromEntries((ov.projects || []).map(p => [p.project_name, p]));
    check('per-project rows carry the project name, not a path',
      (ov.projects || []).map(p => p.project_name).filter(Boolean).sort(), ['Alpha', 'Beta', 'Gamma']);
    check('Alpha rolls up its own tasks only',
      [byName.Alpha.total, byName.Alpha.backlog, byName.Alpha.in_progress], [3, 2, 1]);
    check('Beta rolls up its own tasks only',
      [byName.Beta.total, byName.Beta.done, byName.Beta.todo, byName.Beta.in_progress, byName.Beta.backlog],
      [4, 1, 1, 1, 1]);
    // Positive control for "the rollup is not just the active project".
    check('a project with zero tasks is still listed', [byName.Gamma?.total, byName.Gamma?.backlog], [0, 0]);
    const orphan = (ov.projects || []).find(p => p.project_id === null);
    check('a task with no workdir gets its own row rather than vanishing',
      [orphan?.total, orphan?.project_name], [1, null]);
    check('per-project totals add up to the global total',
      (ov.projects || []).reduce((n, p) => n + p.total, 0), ov.total);

    // ── /api/global/overview: the due buckets ────────────────────────────────
    console.log('\n— overview: due buckets are cut by SQL, not guessed —');
    check('overdue holds only what is already past',  titles(ov.due.overdue),  ['alpha overdue run']);
    check('today holds only what is due before midnight', titles(ov.due.today), ['beta due later today']);
    check('upcoming holds only what is past midnight', titles(ov.due.upcoming), ['beta upcoming next week']);
    // The rule from test/kanban-schedule.test.js, asserted from the other end.
    const allDue = [...ov.due.overdue, ...ov.due.today, ...ov.due.upcoming].map(t => t.title);
    check('a dated task parked in backlog is not reported as due',
      allDue.includes('beta dated but parked'), false);
    check('due rows carry their project badge',
      ov.due.overdue[0]?.project_name, 'Alpha');
    check('due rows expose the task id so the board can be opened',
      typeof ov.due.overdue[0]?.task_id, 'string');

    // ── /api/global/search ───────────────────────────────────────────────────
    console.log('\n— search: one UNION over tasks + chat titles, all projects —');
    const search = async (qs) => (await api('GET', '/api/global/search?' + qs)).json;

    const sAlpha = await search('q=alpha');
    check('finds tasks by title across projects', titles(sAlpha.results).includes('alpha backlog 100% off'), true);
    const sBoth = await search('q=beta');
    check('a query matching several projects returns all of them',
      titles(sBoth.results).filter(t => t.startsWith('beta')).length >= 3, true);
    check('results carry the project name', sBoth.results.every(r => r.project_name === 'Beta'), true);
    check('results are tagged task or chat',
      [...new Set(sBoth.results.map(r => r.kind))].sort().every(k => k === 'task' || k === 'chat'), true);

    // Description text, not just the title.
    await mk({ title: 'plain title', description: 'mentions xyzzy inside', workdir: wdA, status: 'backlog' });
    check('search reaches the task description too', titles((await search('q=xyzzy')).results), ['plain title']);

    // Chat titles.
    const sess = (await api('POST', '/api/sessions', { title: 'quuxsearch chat', workdir: wdB })).json;
    check('a chat session was created for the chat half of the union', typeof sess?.id, 'string');
    const sChat = await search('q=quuxsearch');
    check('search finds a chat by title', titles(sChat.results), ['quuxsearch chat']);
    check('a chat hit is openable — it carries its session id',
      sChat.results[0]?.session_id, sess.id);
    check('a chat hit is tagged as a chat', sChat.results[0]?.kind, 'chat');

    // LIKE wildcard escaping. The positive control comes first: without it, a
    // search function that always returned [] would pass the negative assertion.
    console.log('\n— search: LIKE wildcards in the query are literal —');
    check('a literal percent sign matches the task containing it',
      titles((await search('q=' + encodeURIComponent('100%'))).results), ['alpha backlog 100% off']);
    check('% is not treated as a wildcard',
      titles((await search('q=' + encodeURIComponent('100%off'))).results), []);
    check('_ is not treated as a wildcard',
      titles((await search('q=' + encodeURIComponent('alpha_backlog'))).results), []);
    check('the plain text around the wildcard still matches',
      titles((await search('q=' + encodeURIComponent('alpha backlog'))).results), ['alpha backlog 100% off']);

    // Project filter — by ID, never by a client-supplied path.
    console.log('\n— search: the project filter takes an id, resolved server-side —');
    const inA = await search('q=alpha&project=' + encodeURIComponent(A));
    check('filtering to Alpha keeps Alpha rows', titles(inA.results).includes('alpha backlog 100% off'), true);
    const inB = await search('q=alpha&project=' + encodeURIComponent(B));
    check('filtering to Beta drops Alpha rows', titles(inB.results), []);
    // Positive control: Beta really does have matches, so the empty list above is
    // the filter working and not the endpoint being broken.
    check('the same filter still returns Beta rows for a Beta query',
      (await search('q=beta&project=' + encodeURIComponent(B))).results.length > 0, true);
    check('an unknown project id is refused, not read as "all projects"',
      (await api('GET', '/api/global/search?q=beta&project=no-such-project')).status, 400);
    check('a workdir PATH is not accepted as a project id',
      (await api('GET', '/api/global/search?q=beta&project=' + encodeURIComponent(wdB))).status, 400);

    // Bounds.
    console.log('\n— search: bounds —');
    check('a one-character query is refused rather than dumping the table',
      (await search('q=a')).results, []);
    check('an empty query returns nothing', (await search('q=')).results, []);
    const lim = await search('q=alpha&limit=1');
    check('limit is honoured', lim.results.length, 1);
    check('and the caller is told the list was cut off', lim.truncated, true);
    check('an uncut list is not flagged as truncated', (await search('q=xyzzy')).truncated, false);

    // The clamp had no assertion until a mutation run walked straight through it:
    // replacing it with a bare parseInt broke nothing. An authenticated client could
    // then dictate the page size, and `?limit=999999` is one query that returns the
    // whole tasks+sessions join — the endpoint, not the client, decides how much of
    // the database leaves the process in one response.
    //
    // Of the three, only the NEGATIVE case actually flips under that mutation: with a
    // bare parseInt, `-5` reaches SQLite as `LIMIT -4` and the result comes back empty.
    // `limit=0` is falsy and falls through to the 40 default either way, and this
    // fixture set is smaller than 100, so the upper bound cannot be observed here
    // without seeding 100+ rows. They stay as readable boundary checks — but the
    // mutation evidence for the clamp rests on the negative case alone.
    check('an absurd limit is clamped, not honoured',
      (await search('q=alpha&limit=999999')).results.length <= 100, true);
    check('a zero limit still returns a row rather than an empty page',
      (await search('q=alpha&limit=0')).results.length >= 1, true);
    check('a negative limit is clamped up, not passed to SQLite',
      (await search('q=alpha&limit=-5')).results.length >= 1, true);
  } finally {
    stop();
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
