// bots.js — pure decision logic for the bots subsystem.
//
// No SQL, no sockets, no spawning: everything here is a pure function so it can be
// unit tested the way rate-limit-utils.js, multi-agent-result.js and
// terminal-session.js are. The side effects live in server.js.

// A handle must be safe to type after '@' and safe to use as a primary key.
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

function isValidHandle(handle) {
  return typeof handle === 'string' && HANDLE_RE.test(handle);
}

// Derive a handle from a human label: "Andrey the Analyst" -> "andrey-the-analyst".
// Cyrillic is transliterated so a Ukrainian/Russian label still yields a typeable
// handle — the composer's mention autocomplete is ASCII-driven.
const CYR = {
  а:'a', б:'b', в:'v', г:'h', ґ:'g', д:'d', е:'e', є:'ye', ж:'zh', з:'z', и:'y',
  і:'i', ї:'yi', й:'y', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s',
  т:'t', у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh', щ:'shch', ь:'', ю:'yu',
  я:'ya', ы:'y', э:'e', ё:'yo', ъ:'',
};

function handleFromLabel(label) {
  const lower = String(label || '').toLowerCase();
  const latin = lower.replace(/[а-яёіїєґ]/g, ch => (CYR[ch] !== undefined ? CYR[ch] : ''));
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!slug) return null;
  // A single leading character is legal but a 1-char handle is not (HANDLE_RE needs 2+).
  return isValidHandle(slug) ? slug : (isValidHandle(slug + '-bot') ? slug + '-bot' : null);
}

// Make a handle unique against those already taken: "analyst" -> "analyst-2".
function uniqueHandle(base, taken) {
  const used = new Set(taken || []);
  if (!isValidHandle(base)) return null;
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 28)}-${i}`;
    if (isValidHandle(candidate) && !used.has(candidate)) return candidate;
  }
  return null;
}

// Find bot mentions in a message.
//
// '@' is ALREADY the composer's file-attachment trigger, so a mention only counts
// when it names a REGISTERED handle — everything else is left alone and continues
// to mean "attach a file". That is why this takes the known set rather than
// matching any @word.
//
// Returns { handles, cleaned }:
//   handles — registered handles in first-appearance order, deduplicated
//   cleaned — the text with those mentions removed, for use as the actual prompt
//             (a bot should read "analyse this", not "@analyst analyse this")
function parseMentions(text, knownHandles) {
  const known = new Set((knownHandles || []).map(h => String(h).toLowerCase()));
  const src = String(text || '');
  const handles = [];
  const seen = new Set();
  // Preceded by start-or-whitespace so an e-mail address never reads as a mention.
  const re = /(^|\s)@([a-z0-9][a-z0-9_-]{1,31})\b/gi;
  let cleaned = src.replace(re, (whole, lead, name) => {
    const h = name.toLowerCase();
    if (!known.has(h)) return whole;       // not a bot — leave it for the file path
    if (!seen.has(h)) { seen.add(h); handles.push(h); }
    return lead;
  });
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').trim();
  return { handles, cleaned };
}

// The roster block injected into a bot's system prompt so it knows who else exists
// and can hand work over instead of doing someone else's job badly. `self` is
// excluded — a bot does not need to be told about itself.
function renderRoster(bots, selfHandle) {
  const others = (bots || []).filter(b => b && b.id && b.id !== selfHandle);
  if (!others.length) return '';
  const lines = others.map(b => `- @${b.id} (${b.label || b.id})${b.description ? ' — ' + b.description : ''}`);
  return `Other bots in this workspace:\n${lines.join('\n')}`;
}

// A bot's effective system prompt.
//
// The evidence clause is the highest-value line in this feature and is NOT optional:
// measured on this project, agent claims that cited a file or command output held up
// under checking, and claims that cited nothing did not. Whoever reads this bot's
// output next — a person or another bot — has to be able to tell the difference.
const EVIDENCE_CLAUSE =
  'State what each claim rests on: the file and line, the command and its output, or the source. '
  + 'When something is unverified or you are inferring, say so plainly instead of stating it as fact.';

function buildBotSystemPrompt(bot, allBots) {
  const parts = [];
  const own = String(bot?.system_prompt || '').trim();
  if (own) parts.push(own);
  parts.push(EVIDENCE_CLAUSE);
  const roster = renderRoster(allBots, bot?.id);
  if (roster) parts.push(roster);
  return parts.join('\n\n');
}

module.exports = {
  HANDLE_RE, EVIDENCE_CLAUSE,
  isValidHandle, handleFromLabel, uniqueHandle,
  parseMentions, renderRoster, buildBotSystemPrompt,
};
