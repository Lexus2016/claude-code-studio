// The wave scheduler behind multi-agent mode. It lived inline in runMultiAgent(),
// where nothing could reach it: the loop is wrapped around live `claude` subprocesses,
// so testing the dependency logic meant either spawning the CLI or reimplementing the
// filter in the test — and a test that reimplements its subject proves nothing.
//
// Both functions here are pure and are the SAME expressions runMultiAgent() used
// before the extraction, moved verbatim. server.js calls them; agent-dag.test.js
// tests them.
'use strict';

const DEP_CONTEXT_LIMIT = 2000;

/**
 * The agents whose dependencies are all satisfied, in plan order.
 * An empty result with agents still remaining means the plan cannot progress —
 * a cycle, or a dependency on an id that is not in the plan. The caller reports
 * that as "Circular deps" and stops; it must not be read as "nothing to do".
 */
function pickRunnable(remaining, completed) {
  return remaining.filter(a => (a.depends_on || []).every(d => completed.has(d)));
}

/**
 * The dependency output a worker is given as context, capped per dependency.
 * A dependency that produced nothing contributes nothing — deliberately, so a
 * failed upstream agent does not inject an empty `[agent-1]:` header that reads
 * to the model like a real (and empty) result.
 */
function buildDepContext(agent, results) {
  return (agent.depends_on || [])
    .map(d => (results[d] ? `\n[${d}]:${String(results[d]).substring(0, DEP_CONTEXT_LIMIT)}` : ''))
    .join('');
}

/**
 * Drain a plan into the waves runMultiAgent() would execute, assuming every agent
 * succeeds. Test-facing: it repeats the loop's own drain semantics — pickRunnable,
 * run the whole wave, mark it complete — so a change to pickRunnable shows up here.
 * `stuck` holds whatever could never run.
 */
function computeWaves(agents) {
  const remaining = [...agents];
  const completed = new Set();
  const waves = [];
  while (remaining.length) {
    const runnable = pickRunnable(remaining, completed);
    if (!runnable.length) break;
    for (const a of runnable) remaining.splice(remaining.indexOf(a), 1);
    for (const a of runnable) completed.add(a.id);
    waves.push(runnable.map(a => a.id));
  }
  return { waves, stuck: remaining.map(a => a.id) };
}

module.exports = { pickRunnable, buildDepContext, computeWaves, DEP_CONTEXT_LIMIT };
