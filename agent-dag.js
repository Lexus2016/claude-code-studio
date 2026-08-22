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
 * dependency that emitted no text does not inject an empty `[agent-1]:` header
 * that reads to the model like a real (and empty) result.
 *
 * Note what the cap does: it keeps the HEAD of the text. runMultiAgent therefore
 * PREFIXES its "did not finish / output is INCOMPLETE" warning onto results[] —
 * appending it, as it used to, meant any dependency longer than the cap handed
 * the dependent truncated work with the warning sliced off.
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

/**
 * Make a model-authored plan safe to execute. The JSON schema constrains what the
 * model is ASKED for; it does not constrain what actually reaches the scheduler,
 * because the plan is also recovered by regex when structured output is unavailable.
 *
 * Three edges this closes, each of which had a concrete failure:
 *   * duplicate ids — computeWaves runs both copies and results[id] is overwritten.
 *     Worse, the clean copy of `a` marks 'a' completed, which makes a second `a` that
 *     depends on itself runnable: the self-cycle guard never fires.
 *   * a depends_on naming an id that is not in the plan — pickRunnable can never
 *     satisfy it, so the ENTIRE plan reports "Circular deps" and no agent runs.
 *   * a self-dependency — same stall, from one bad edge.
 *   * plan length — an unbounded plan means unbounded concurrent `claude` subprocesses.
 *
 * Order is preserved; the first occurrence of an id wins.
 */
function sanitizePlan(agents, maxAgents) {
  const seen = new Set();
  const kept = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a.id !== 'string' || !a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    kept.push(a);
    if (kept.length >= maxAgents) break;
  }
  return kept.map(a => ({
    ...a,
    depends_on: (Array.isArray(a.depends_on) ? a.depends_on : [])
      .filter(d => typeof d === 'string' && d !== a.id && seen.has(d)),
  }));
}

module.exports = { pickRunnable, buildDepContext, computeWaves, sanitizePlan, DEP_CONTEXT_LIMIT };
