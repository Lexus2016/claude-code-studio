// Settings catalog + precedence resolver for the Settings UI (issue #40).
//
// This module is deliberately pure: it takes plain objects for every
// configuration source and returns what the UI renders. No fs, no require of
// server.js, no side effects — so the precedence rules can be unit-tested
// without booting a server.
//
// ── The precedence this file encodes is NOT invented ──────────────────────────
// It is what server.js actually does, read off these lines:
//
//  env-backed settings
//    server.js:16-29   the .env loader — `if (k && !(k in process.env))`.
//                      A variable already present in the real process
//                      environment is NEVER overwritten by .env. So:
//                          process env  >  .env file  >  hardcoded default
//    server.js:95      `process.env.PORT || 3000`      — '' falls through
//    server.js:64      `process.env.LOG_LEVEL || 'info'`
//                      → an empty value behaves as unset, hence EMPTY_IS_UNSET.
//
//  config.json-backed settings — TWO different chains, and they disagree:
//    server.js:2564-2577  loadMergedConfig(): `l.lang || g.lang || 'en'`
//                          → local config.json > ~/.claude/config.json > default
//    server.js:2308-2347  loadConfig(): reads CONFIG_PATH only
//                          → local config.json > default. The global file is
//                            never consulted, so a value set there is IGNORED.
//                      `terminal.*`, `externalAgents` and `slashCommands` live
//                      on this second chain (server.js:2332, 2564-2577).
//
//  workdir
//    server.js:2971, 3529, 6359, 7243 … `session.workdir || WORKDIR`
//                      → the workdir of the project registered in
//                        data/projects.json wins over WORKDIR for that session.
//
// Anything a source defines but the server never reads is emitted with
// `ignored: true` instead of being hidden — surfacing the inconsistency is the
// point of the feature.

'use strict';

// Sources, most-significant first. Ordering here IS the precedence contract;
// resolve() walks candidates in the order it builds them, not in this order,
// but the UI uses these ids for badges and the tests pin both.
const SOURCES = ['project', 'process-env', 'dotenv', 'config-local', 'config-global', 'default'];

const SECTIONS = ['engine', 'agents', 'workspace', 'mcp', 'server', 'security', 'data', 'ui', 'advanced'];

// Keys whose value must never reach the browser. The explicit flag in the
// catalog is authoritative; this pattern is a second net so that a key added
// later with an obviously-secret name is masked even if the flag is forgotten.
const SECRET_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY)/i;

/** Repo convention (server.js:6919, 6987): a set secret is '***', an unset one ''. */
function maskSecret(value) {
  return (value === undefined || value === null || value === '') ? '' : '***';
}

function isSecretKey(key, def) {
  if (def && def.secret === true) return true;
  return SECRET_NAME_RE.test(String(key || ''));
}

/** The settings catalog.
 *  backing: 'env'        — read from process.env at startup
 *           'config'     — read from config.json
 *           'collection' — a keyed collection in config.json (counted, not edited here)
 *  merge:   'merged'     — loadMergedConfig(): local overrides global
 *           'local'      — loadConfig(): local only, global silently ignored
 *  readOnly — the form refuses to write it (the raw-file tabs still can)
 *  restart  — takes effect only after a server restart
 */
const SETTINGS = [
  // ── AI models & engine ────────────────────────────────────────────────────
  { key: 'defaultEngine', section: 'engine', backing: 'config', merge: 'merged', path: 'defaultEngine',
    type: 'enum', choices: ['api', 'subscription'], def: 'api', src: 'server.js:2574' },
  { key: 'ANTHROPIC_BASE_URL', section: 'engine', backing: 'env', type: 'string', def: '', restart: true,
    src: '.env.example / claude-cli.js env passthrough' },
  { key: 'ANTHROPIC_API_KEY', section: 'engine', backing: 'env', type: 'string', def: '', secret: true,
    readOnly: true, restart: true, src: '.env.example' },
  { key: 'ANTHROPIC_AUTH_TOKEN', section: 'engine', backing: 'env', type: 'string', def: '', secret: true,
    readOnly: true, restart: true, src: '.env.example' },
  { key: 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', section: 'engine', backing: 'env', type: 'string', def: '',
    restart: true, src: '.env.example' },

  // ── Agents & run limits ───────────────────────────────────────────────────
  { key: 'CLAUDE_IDLE_TIMEOUT_MS', section: 'agents', backing: 'env', type: 'number', def: 600000,
    aliases: ['CLAUDE_TIMEOUT_MS'], restart: true, src: 'claude-cli.js:70' },
  { key: 'CLAUDE_HARD_CAP_MS', section: 'agents', backing: 'env', type: 'number', def: 0, restart: true,
    src: 'claude-cli.js:73' },
  { key: 'CLAUDE_PROMPT_GRACE_MS', section: 'agents', backing: 'env', type: 'number', def: 300000, restart: true,
    src: 'claude-interactive.js:66' },
  { key: 'TASK_DISCONNECT_TIMEOUT_MS', section: 'agents', backing: 'env', type: 'number', def: 1800000,
    restart: true, src: 'server.js:1090' },
  { key: 'MAX_TASK_WORKERS', section: 'agents', backing: 'env', type: 'number', def: 5, restart: true,
    src: 'server.js:1279' },
  { key: 'MULTI_AGENT_MAX_TURNS_CAP', section: 'agents', backing: 'env', type: 'number', def: 200, restart: true,
    src: 'server.js:3513' },

  // ── Workspace ─────────────────────────────────────────────────────────────
  { key: 'WORKDIR', section: 'workspace', backing: 'env', type: 'path', def: '', restart: true,
    projectOverride: true, src: 'server.js:105' },
  { key: 'APP_DIR', section: 'workspace', backing: 'env', type: 'path', def: '', readOnly: true, restart: true,
    src: 'server.js:104' },
  { key: 'recentProjectsCount', section: 'workspace', backing: 'config', merge: 'merged',
    path: 'recentProjectsCount', type: 'number', def: 5, src: 'server.js:2575' },

  // ── MCP, skills, commands (collections) ───────────────────────────────────
  { key: 'mcpServers', section: 'mcp', backing: 'collection', merge: 'merged', path: 'mcpServers',
    readOnly: true, src: 'server.js:2572' },
  { key: 'skills', section: 'mcp', backing: 'collection', merge: 'merged', path: 'skills',
    readOnly: true, src: 'server.js:2573' },
  { key: 'slashCommands', section: 'mcp', backing: 'collection', merge: 'local', path: 'slashCommands',
    readOnly: true, src: 'server.js:2574' },
  { key: 'externalAgents', section: 'mcp', backing: 'collection', merge: 'local', path: 'externalAgents',
    readOnly: true, src: 'server.js:2313' },

  // ── Server / network ──────────────────────────────────────────────────────
  { key: 'PORT', section: 'server', backing: 'env', type: 'number', def: 3000, restart: true, src: 'server.js:95' },
  { key: 'HOST', section: 'server', backing: 'env', type: 'string', def: '127.0.0.1', restart: true,
    src: 'server.js:100' },
  { key: 'TRUST_PROXY', section: 'server', backing: 'env', type: 'bool', def: false, restart: true,
    src: 'server.js:117' },

  // ── Security ──────────────────────────────────────────────────────────────
  { key: 'SESSION_SECRET', section: 'security', backing: 'env', type: 'string', def: '', secret: true,
    readOnly: true, restart: true, src: 'auth.js:98' },
  { key: 'terminal.enabled', section: 'security', backing: 'config', merge: 'local', path: 'terminal.enabled',
    type: 'bool', def: false, src: 'server.js:2332' },
  { key: 'terminal.idleTimeoutMin', section: 'security', backing: 'config', merge: 'local',
    path: 'terminal.idleTimeoutMin', type: 'number', def: 30, src: 'server.js:10040' },
  { key: 'terminal.maxLive', section: 'security', backing: 'config', merge: 'local', path: 'terminal.maxLive',
    type: 'number', def: 3, src: 'server.js:10041' },
  { key: 'CCS_SSH_HOST_KEY_POLICY', section: 'security', backing: 'env', type: 'string', def: '', restart: true,
    src: 'claude-ssh.js:100' },

  // ── Data retention ────────────────────────────────────────────────────────
  { key: 'SESSION_TTL_DAYS', section: 'data', backing: 'env', type: 'number', def: 30, restart: true,
    src: 'server.js:358' },
  { key: 'CLEANUP_INTERVAL_HOURS', section: 'data', backing: 'env', type: 'number', def: 24, restart: true,
    src: 'server.js:359' },

  // ── Interface ─────────────────────────────────────────────────────────────
  { key: 'lang', section: 'ui', backing: 'config', merge: 'merged', path: 'lang', type: 'enum',
    choices: ['uk', 'en', 'ru', 'fr', 'he'], def: 'en', src: 'server.js:2574' },

  // ── Advanced ──────────────────────────────────────────────────────────────
  { key: 'LOG_LEVEL', section: 'advanced', backing: 'env', type: 'enum',
    choices: ['error', 'warn', 'info', 'debug'], def: 'info', restart: true, src: 'server.js:64' },
  { key: 'NODE_ENV', section: 'advanced', backing: 'env', type: 'string', def: 'development', restart: true,
    src: 'server.js:65' },
];

const BY_KEY = new Map(SETTINGS.map(s => [s.key, s]));
function getSetting(key) { return BY_KEY.get(key) || null; }

function getPath(obj, dotted) {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Env values are read as `process.env.X || fallback` all over server.js, so an
 *  empty string behaves exactly like an unset variable. Mirror that. */
function envIsUnset(v) { return v === undefined || v === null || v === ''; }

function sizeOf(v) {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

/** Build the ordered candidate list for one setting. Index 0 is the winner
 *  unless it is `ignored`. */
function candidatesFor(def, sources) {
  const s = sources || {};
  const out = [];

  if (def.backing === 'env') {
    // A registered project's workdir beats the env for that session.
    if (def.projectOverride && s.project && s.project.workdir) {
      out.push({ source: 'project', value: s.project.workdir, label: s.project.name || s.project.id || '' });
    }
    for (const name of [def.key, ...(def.aliases || [])]) {
      const pv = getPath(s.processEnv, name);
      if (!envIsUnset(pv)) out.push({ source: 'process-env', value: pv, via: name });
      const dv = getPath(s.dotenv, name);
      if (!envIsUnset(dv)) out.push({ source: 'dotenv', value: dv, via: name });
    }
  } else if (def.backing === 'config' || def.backing === 'collection') {
    const lv = getPath(s.localConfig, def.path);
    if (lv !== undefined) out.push({ source: 'config-local', value: lv });
    const gv = getPath(s.globalConfig, def.path);
    if (gv !== undefined) {
      // merge:'local' means loadConfig() never opens ~/.claude/config.json, so a
      // value living there does nothing. Show it, struck through, instead of
      // pretending the file is not there.
      if (def.merge === 'merged') out.push({ source: 'config-global', value: gv });
      else out.push({ source: 'config-global', value: gv, ignored: true });
    }
  }

  // Two defaults (WORKDIR, APP_DIR) are computed from __dirname at boot and
  // cannot be written into a static catalog. The caller passes them in.
  const rd = s.runtimeDefaults && Object.prototype.hasOwnProperty.call(s.runtimeDefaults, def.key)
    ? s.runtimeDefaults[def.key] : undefined;
  const dflt = rd !== undefined ? rd : def.def;
  out.push({ source: 'default', value: dflt === undefined ? null : dflt });
  return out;
}

/** Resolve one setting into what the UI renders. Secrets are masked here — the
 *  raw value never leaves this function. */
function resolveSetting(def, sources) {
  const cands = candidatesFor(def, sources);
  const live = cands.filter(c => !c.ignored);
  const winner = live[0];
  const secret = isSecretKey(def.key, def);
  const isCollection = def.backing === 'collection';

  const view = cands.map(c => {
    const entry = { source: c.source, ignored: !!c.ignored };
    if (c.via && c.via !== def.key) entry.via = c.via;
    if (c.label) entry.label = c.label;
    if (isCollection) entry.count = sizeOf(c.value);
    else if (secret) entry.value = maskSecret(c.value);
    else entry.value = c.value;
    return entry;
  });

  // A source lost to a higher-precedence one → the user is looking at a value
  // that is not the one they last edited. That is the case worth a badge.
  const overriddenBy = live.length > 1 && live[1].source !== 'default' ? live[1].source : null;
  const shadowedDotenv = live.some(c => c.source === 'dotenv') && winner.source === 'process-env';

  const res = {
    key: def.key,
    section: def.section,
    backing: def.backing,
    type: def.type || 'string',
    merge: def.merge || null,
    secret,
    readOnly: !!def.readOnly || isCollection,
    restart: !!def.restart,
    choices: def.choices || null,
    codeRef: def.src || '',
    sources: view,
    effectiveSource: winner.source,
    modified: winner.source !== 'default',
    overriddenBy,
    shadowedDotenv,
    // A "reset to default" only makes sense when there is something in a file we
    // own to remove. If PORT is exported by the shell, deleting the .env line
    // changes nothing — offering the button there would be a lie.
    resettable: !def.readOnly && !secret && !isCollection && cands.some(c =>
      c.source === (def.backing === 'env' ? 'dotenv' : 'config-local')),
    ignoredSources: cands.filter(c => c.ignored).map(c => c.source),
  };

  if (isCollection) {
    // Effective collection size = what loadMergedConfig()/loadConfig() ends up with.
    const l = getPath(sources && sources.localConfig, def.path);
    const g = getPath(sources && sources.globalConfig, def.path);
    if (def.merge === 'merged' && !Array.isArray(l) && !Array.isArray(g)) {
      res.count = Object.keys({ ...(g || {}), ...(l || {}) }).length;
    } else {
      res.count = sizeOf(l !== undefined ? l : (def.merge === 'merged' ? g : undefined));
    }
    res.effective = null;
  } else {
    res.effective = secret ? maskSecret(winner.value) : winner.value;
    if (secret) res.isSet = !envIsUnset(winner.value);
  }
  return res;
}

function resolveAll(sources) {
  return SETTINGS.map(def => resolveSetting(def, sources));
}

/** Parse a .env file body into { key: value } using the exact rules of the
 *  loader in server.js:16-29 (first occurrence wins, `#` comments, quote strip). */
function parseDotenv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

/** Rewrite one KEY in a .env body. The loader takes the FIRST uncommented
 *  occurrence, so appending next to an existing active line would be a silent
 *  no-op — replace in place, and only append when the key is absent.
 *  Commented `# KEY=` lines are documentation and are left alone. */
function setDotenvValue(text, key, value) {
  const body = String(text || '');
  const lines = body.split('\n');
  const re = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { lines[i] = `${key}=${value}`; return lines.join('\n'); }
  }
  const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n';
  return body + sep + `${key}=${value}\n`;
}

/** Remove every ACTIVE `KEY=` line from a .env body. Commented `# KEY=` lines are
 *  documentation and stay — deleting them would silently erase the hint that the
 *  variable exists at all. */
function unsetDotenvValue(text, key) {
  const re = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
  const kept = String(text || '').split('\n').filter(l => !re.test(l));
  return kept.join('\n');
}

/** Delete a dotted path, then drop the parent objects it leaves empty — an
 *  orphaned `"terminal": {}` in config.json reads as a setting that is still
 *  configured. */
function deletePath(obj, dotted) {
  const parts = String(dotted).split('.');
  const chain = [obj];
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return false;
    cur = cur[part];
    chain.push(cur);
  }
  if (!cur || typeof cur !== 'object') return false;
  const leaf = parts[parts.length - 1];
  if (!(leaf in cur)) return false;
  delete cur[leaf];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length) break;
    delete chain[i - 1][parts[i - 1]];
  }
  return true;
}

/** Validate + normalise a value the browser sent for `key`.
 *  Returns { ok, value } or { ok:false, error }. */
function formWritable(def) {
  if (!def) return { ok: false, error: 'unknown_setting' };
  // Secret first: it is the more specific reason (every secret is also readOnly),
  // and it is what the UI must tell the user.
  if (isSecretKey(def.key, def)) return { ok: false, error: 'secret_not_editable' };
  if (def.readOnly || def.backing === 'collection') return { ok: false, error: 'read_only' };
  return { ok: true };
}

function coerceValue(def, raw) {
  const w = formWritable(def);
  if (!w.ok) return w;
  switch (def.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
      return { ok: false, error: 'expected_bool' };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
      if (!Number.isFinite(n)) return { ok: false, error: 'expected_number' };
      return { ok: true, value: n };
    }
    case 'enum': {
      const v = String(raw);
      if (!(def.choices || []).includes(v)) return { ok: false, error: 'invalid_choice' };
      return { ok: true, value: v };
    }
    default: {
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
        return { ok: false, error: 'expected_scalar' };
      }
      const v = String(raw);
      // A .env value is a single line by construction; a newline would inject
      // an extra variable into the file.
      if (/[\r\n]/.test(v)) return { ok: false, error: 'newline_not_allowed' };
      return { ok: true, value: v };
    }
  }
}

module.exports = {
  SOURCES, SECTIONS, SETTINGS,
  getSetting, getPath, maskSecret, isSecretKey,
  candidatesFor, resolveSetting, resolveAll,
  parseDotenv, setDotenvValue, unsetDotenvValue, deletePath, coerceValue, formWritable,
  SECRET_NAME_RE,
};
