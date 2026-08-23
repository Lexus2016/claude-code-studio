// Global chat defaults + per-project overrides — issue #58.
//
// Before this, every new chat opened on values hardcoded in the SPA: newTab()
// assigned curMode='auto' / curAgent='single' literally, the model carried over
// from whatever tab was open last, and the turns box shipped value="50" in the
// markup. A user who always works on Opus / Task retyped that on every chat.
//
// The chain is two links, and it is deliberately SPARSE at the project link:
//
//     project override  >  global default (config.json)  >  BUILTIN
//
// A project stores only the keys it pins. That is what makes "inherited" a real
// state rather than a snapshot: change the global model and every project that
// never pinned one follows, which is the whole point of the request. Storing a
// full five-key object per project would silently freeze each project at the
// global value that happened to be current when it was created.
//
// This module is pure — no fs, no require of server.js — so the precedence and
// the validation can be unit-tested without booting anything.
'use strict';

/** The five dials, in the order the toolbar shows them. */
const KEYS = ['mode', 'agent', 'model', 'effort', 'turns'];

/** Allowed values. These are not free choices — each list is the `data-v` set of
 *  the matching toolbar group in public/index.html, and `model` is MODEL_MAP in
 *  claude-cli.js. A value that is not here would render as "no button selected". */
const CHOICES = {
  mode:   ['auto', 'planning', 'task'],
  agent:  ['single', 'multi', 'dispatch', 'conversation'],
  model:  ['haiku', 'sonnet', 'opus', 'fable'],
  // 'auto' is the sentinel for "pass no --effort flag at all", which the SPA and
  // the CLI both spell as the empty string. It is spelled out here because an
  // empty string in a config file is indistinguishable from an unset key once it
  // has been through `||` — and loadMergedConfig() uses `||`.
  effort: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
};

/** Matches the min/max on #maxTurns in the toolbar. */
const TURNS_MIN = 1;
const TURNS_MAX = 200;

/** What the UI did before this module existed. Changing any of these changes the
 *  behaviour of every install that never opened the settings form. */
const BUILTIN = Object.freeze({
  mode: 'auto',
  agent: 'single',
  model: 'sonnet',
  effort: 'auto',
  turns: 50,
});

/** The SPA and the CLI want '' where the catalog wants 'auto'. One place. */
function effortToFlag(effort) {
  return effort === 'auto' || !effort ? '' : String(effort);
}

/** Validate one key/value pair.
 *  @returns {{ok:true, value:*}|{ok:false, error:string}} */
function coerce(key, raw) {
  if (!KEYS.includes(key)) return { ok: false, error: 'unknown_key' };
  if (key === 'turns') {
    const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n)) return { ok: false, error: 'expected_number' };
    if (n < TURNS_MIN || n > TURNS_MAX) return { ok: false, error: 'out_of_range' };
    return { ok: true, value: Math.trunc(n) };
  }
  const v = String(raw);
  if (!CHOICES[key].includes(v)) return { ok: false, error: 'invalid_choice' };
  return { ok: true, value: v };
}

/** Keep the valid pairs, name the rest.
 *
 *  Both halves are used: reading config.json takes `value` and ignores `invalid`
 *  (a typo in a hand-edited file must not blank the other four dials), while the
 *  write endpoint refuses the request when `invalid` is non-empty — silently
 *  dropping a key the user just clicked would read as the save having worked.
 *
 *  @returns {{value:Object, invalid:string[]}} */
function sanitize(raw) {
  const value = {}, invalid = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value, invalid };
  for (const [k, v] of Object.entries(raw)) {
    // An explicit null/undefined means "stop pinning this key", not "invalid".
    if (v === null || v === undefined || v === '') continue;
    const c = coerce(k, v);
    if (c.ok) value[k] = c.value; else invalid.push(k);
  }
  return { value, invalid };
}

/** Resolve the effective dials for one project.
 *  @param globalRaw  config.chatDefaults from loadMergedConfig() (may be absent)
 *  @param projectRaw project.defaults from data/projects.json (may be absent)
 *  @returns {{effective:Object, global:Object, overrides:Object, overridden:string[]}}
 *           `overrides` holds ONLY the keys the project pins — that sparseness is
 *           what the UI draws its "overridden" badges from. */
function resolveChatDefaults(globalRaw, projectRaw) {
  const g = { ...BUILTIN, ...sanitize(globalRaw).value };
  const overrides = sanitize(projectRaw).value;
  return {
    effective: { ...g, ...overrides },
    global: g,
    overrides,
    overridden: KEYS.filter(k => k in overrides),
  };
}

module.exports = {
  KEYS, CHOICES, BUILTIN, TURNS_MIN, TURNS_MAX,
  coerce, sanitize, resolveChatDefaults, effortToFlag,
};
