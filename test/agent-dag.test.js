// Multi-agent plan → DAG execution. The orchestrator turns a model-authored plan
// into waves: every agent whose depends_on is satisfied runs concurrently, the wave
// is awaited, then the next wave is picked. Nothing tested that until now — the
// logic sat inline in runMultiAgent(), wrapped around live `claude` subprocesses.
//
// It is now agent-dag.js, and this file tests the real functions server.js calls.
// Every expectation below is derived from the plan by hand, not by re-running the
// implementation's own expression.
//
// Run: node test/agent-dag.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pickRunnable, buildDepContext, computeWaves, sanitizePlan, DEP_CONTEXT_LIMIT } = require('../agent-dag');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const A = (id, ...deps) => ({ id, role: id, task: `do ${id}`, depends_on: deps });

console.log('\n— server.js uses these functions, not a copy of them —');
// Without this the whole file could pass against a module nothing imports.
const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('server.js imports agent-dag', /require\('\.\/agent-dag'\)/.test(srv), true);
check('and calls pickRunnable in the wave loop', /const runnable = pickRunnable\(remaining, completed\)/.test(srv), true);
check('and buildDepContext for the worker prompt', /const depCtx = buildDepContext\(agent, results\)/.test(srv), true);
check('the old inline filter is gone', /remaining\.filter\(a => \(a\.depends_on/.test(srv), false);

console.log('\n— a plan with no dependencies is one wave —');
check('three independent agents run together',
  computeWaves([A('a'), A('b'), A('c')]), { waves: [['a', 'b', 'c']], stuck: [] });
check('a missing depends_on key is treated as no dependency',
  computeWaves([{ id: 'a', task: 'x' }, { id: 'b', task: 'y' }]), { waves: [['a', 'b']], stuck: [] });
check('so is an explicitly empty one',
  computeWaves([A('a'), A('b', ...[])]), { waves: [['a', 'b']], stuck: [] });

console.log('\n— a linear chain is one agent per wave —');
check('a → b → c serialises',
  computeWaves([A('a'), A('b', 'a'), A('c', 'b')]), { waves: [['a'], ['b'], ['c']], stuck: [] });
check('plan order does not decide execution order',
  computeWaves([A('c', 'b'), A('b', 'a'), A('a')]), { waves: [['a'], ['b'], ['c']], stuck: [] });

console.log('\n— fan-out and fan-in —');
// a → (b, c) → d: the diamond. b and c must share a wave, d must wait for both.
check('a diamond runs b and c concurrently, then d',
  computeWaves([A('a'), A('b', 'a'), A('c', 'a'), A('d', 'b', 'c')]),
  { waves: [['a'], ['b', 'c'], ['d']], stuck: [] });
check('an agent waiting on two deps does not start when only one is done',
  pickRunnable([A('d', 'b', 'c')], new Set(['b'])), []);
check('and does once both are',
  pickRunnable([A('d', 'b', 'c')], new Set(['b', 'c'])).map(a => a.id), ['d']);
check('a deep dep already satisfied does not hold anyone back',
  computeWaves([A('a'), A('b', 'a'), A('c', 'a', 'b')]),
  { waves: [['a'], ['b'], ['c']], stuck: [] });

console.log('\n— plans that cannot progress —');
// The orchestrator reports "Circular deps" and breaks. What matters here is that
// the scheduler reports it rather than looping forever or silently dropping agents.
check('a self-cycle is stuck, not runnable',
  computeWaves([A('a', 'a')]), { waves: [], stuck: ['a'] });
check('a mutual cycle is stuck',
  computeWaves([A('a', 'b'), A('b', 'a')]), { waves: [], stuck: ['a', 'b'] });
check('a dependency on an id that is not in the plan is stuck',
  computeWaves([A('a', 'ghost')]), { waves: [], stuck: ['a'] });
check('the agents before the cycle still run, the cycle does not',
  computeWaves([A('a'), A('b', 'a'), A('x', 'y'), A('y', 'x')]),
  { waves: [['a'], ['b']], stuck: ['x', 'y'] });
// Positive control: "stuck" must not be what this scheduler answers for everything.
check('positive control: a healthy plan reports nothing stuck',
  computeWaves([A('a'), A('b', 'a')]).stuck, []);

console.log('\n— dependency context handed to a worker —');
const results = { 'agent-1': 'FIRST', 'agent-2': 'SECOND' };
check('no deps means no context', buildDepContext(A('x'), results), '');
check('one dep is labelled with its id', buildDepContext(A('x', 'agent-1'), results), '\n[agent-1]:FIRST');
check('two deps arrive in depends_on order',
  buildDepContext(A('x', 'agent-2', 'agent-1'), results), '\n[agent-2]:SECOND\n[agent-1]:FIRST');
// A dep with NO entry contributes nothing — emitting `\n[agent-9]:` would read to the
// model as a real result that happened to be empty. Note this is NOT the failed-agent
// case: runMultiAgent always writes an entry for a failed agent (its partial text plus
// a warning), so that path is covered by the truncation contract below, not here.
check('a dep that produced nothing contributes nothing',
  buildDepContext(A('x', 'agent-9'), results), '');
check('and does not disturb the deps around it',
  buildDepContext(A('x', 'agent-1', 'agent-9', 'agent-2'), results),
  '\n[agent-1]:FIRST\n[agent-2]:SECOND');

console.log('\n— per-dependency truncation —');
const huge = 'z'.repeat(DEP_CONTEXT_LIMIT + 500);
const ctx = buildDepContext(A('x', 'big'), { big: huge });
check('the limit is the documented 2000', DEP_CONTEXT_LIMIT, 2000);
check('an oversized result is cut to the limit', ctx.length, DEP_CONTEXT_LIMIT + '\n[big]:'.length);
check('positive control: a short result is not cut',
  buildDepContext(A('x', 'small'), { small: 'ok' }), '\n[small]:ok');
// The cap is PER dependency, not per prompt — three big deps mean three cuts, and
// the worker prompt can legitimately carry 6000 chars of context.
const three = buildDepContext(A('x', 'p', 'q', 'r'), { p: huge, q: huge, r: huge });
check('the cap applies per dependency, not to the joined string',
  three.length, 3 * (DEP_CONTEXT_LIMIT + '\n[p]:'.length));

console.log('\n— pickRunnable does not mutate its inputs —');
const remaining = [A('a'), A('b', 'a')];
const before = JSON.stringify(remaining);
const completed = new Set(['a']);
pickRunnable(remaining, completed);
check('the remaining list is untouched', JSON.stringify(remaining), before);
check('the completed set is untouched', [...completed], ['a']);
// The caller splices out of `remaining` itself, so pickRunnable must return the
// same object identities — filtering into copies would make indexOf() fail there.
const picked = pickRunnable(remaining, completed);
check('both agents are runnable once a is complete', picked.map(a => a.id), ['a', 'b']);
check('it returns the original objects, not copies',
  [picked[0] === remaining[0], picked[1] === remaining[1]], [true, true]);


console.log('\n— truncation keeps the HEAD, so a failure warning must be a PREFIX —');
// The bug this pins: runMultiAgent used to APPEND "did not finish / output is
// incomplete" to the agent's text before storing it in results. buildDepContext keeps
// the first DEP_CONTEXT_LIMIT characters, so for any agent whose output exceeded the
// cap the warning was sliced clean off — the dependent received truncated work with
// nothing marking it as truncated, and the summarizer then reported success.
const longFail = 'y'.repeat(DEP_CONTEXT_LIMIT + 500);
const appended = buildDepContext(A('x', 'f'), { f: longFail + '\n\n⚠️ **f** did not finish' });
check('appending the warning to a long result loses it entirely',
  /did not finish/.test(appended), false);
const prefixed = buildDepContext(A('x', 'f'), { f: '⚠️ **f** did not finish — INCOMPLETE\n\n' + longFail });
check('prefixing it survives the same truncation',
  /did not finish/.test(prefixed), true);
check('and the prefixed context is still capped',
  prefixed.length, DEP_CONTEXT_LIMIT + '\n[f]:'.length);
// Guard the production side too: the module cannot import server.js, so assert the
// shape of the line that builds results[].
check('server.js stores the notice as a prefix, not a suffix',
  /results\[agent\.id\] = depNotice \+ agentText;/.test(srv), true);

console.log('\n— sanitizePlan: the edges an unvalidated plan used to reach the scheduler with —');
check('a clean plan is passed through unchanged',
  sanitizePlan([A('a'), A('b', 'a')], 8).map(a => [a.id, a.depends_on]),
  [['a', []], ['b', ['a']]]);
// Duplicate ids masked a self-cycle: the clean `a` marked 'a' completed, so the
// self-dependent duplicate became runnable and the cycle guard never fired.
check('a duplicate id is dropped, first occurrence wins',
  sanitizePlan([A('a'), A('a', 'a')], 8).map(a => a.id), ['a']);
check('and the self-cycle it used to smuggle in is gone with it',
  computeWaves(sanitizePlan([A('a'), A('a', 'a')], 8)), { waves: [['a']], stuck: [] });
check('a self-dependency is dropped rather than stalling the plan',
  sanitizePlan([A('a', 'a')], 8), [{ id: 'a', role: 'a', task: 'do a', depends_on: [] }]);
// A ghost dep stalled the WHOLE plan: pickRunnable could never satisfy it, so the
// chat path reported "Circular deps" and ran nothing at all.
check('a dependency on an id not in the plan is dropped',
  sanitizePlan([A('a', 'ghost'), A('b')], 8).map(a => [a.id, a.depends_on]),
  [['a', []], ['b', []]]);
check('...and the plan then runs instead of stalling',
  computeWaves(sanitizePlan([A('a', 'ghost'), A('b')], 8)).stuck, []);
check('positive control: without sanitising, that same plan stalls',
  computeWaves([A('a', 'ghost'), A('b')]).stuck, ['a']);
check('the plan is capped to maxAgents',
  sanitizePlan([A('a'), A('b'), A('c'), A('d')], 2).map(a => a.id), ['a', 'b']);
check('deps pointing past the cap are dropped with it',
  sanitizePlan([A('a'), A('b', 'd'), A('c'), A('d')], 2).map(a => a.depends_on), [[], []]);
check('junk entries are skipped, not crashed on',
  sanitizePlan([null, { role: 'no id' }, { id: '' }, A('a')], 8).map(a => a.id), ['a']);
check('a non-array plan yields an empty plan', sanitizePlan(undefined, 8), []);
check('a non-array depends_on is normalised to []',
  sanitizePlan([{ id: 'a', depends_on: 'b' }], 8)[0].depends_on, []);
check('the input objects are not mutated',
  (() => { const orig = A('a', 'ghost'); sanitizePlan([orig], 8); return orig.depends_on; })(), ['ghost']);

console.log('\n— server.js wires the caps and the shared cycle check —');
check('server.js imports sanitizePlan', /sanitizePlan/.test(srv), true);
check('and calls it on the parsed plan', /plan\.agents = sanitizePlan\(plan\.agents, MULTI_AGENT_MAX_PLAN\)/.test(srv), true);
check('the wave is bounded by MULTI_AGENT_CONCURRENCY',
  /Math\.min\(MULTI_AGENT_CONCURRENCY, runnable\.length\)/.test(srv), true);
check('the bare unbounded Promise.all over a wave is gone',
  /await Promise\.all\(runnable\.map\(/.test(srv), false);
// dispatch_plan had its own DFS that disagreed with computeWaves on ghost deps:
// DFS saw no cycle and let the plan through, then .filter(Boolean) silently dropped
// the edge, so the task ran as if it had never had a dependency.
check('dispatch_plan uses computeWaves, not a private DFS',
  /const \{ stuck \} = computeWaves\(finalAgents\)/.test(srv), true);
check('the private DFS is gone', /function _cyc\(n\)/.test(srv), false);
// The Kanban round-trip carries depends_on: the button echoes the agent_plan payload
// back as dispatch_plan, and a stripped payload flattened every chain into a free-for-all.
check('the agent_plan payload keeps depends_on',
  /depends_on: a\.depends_on \|\| \[\]/.test(srv), true);
check('no agent_plan payload strips it any more',
  /agents: (?:plan|finalAgents)\.agents?\.map\(a => \(\{ id: a\.id, role: a\.role, task: a\.task \}\)\)/.test(srv), false);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
