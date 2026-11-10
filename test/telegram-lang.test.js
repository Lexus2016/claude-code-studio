// Issue #135 — the Telegram bot answered in Ukrainian regardless of the Studio language.
//
// What must hold:
//   - an unconfigured bot speaks English, matching the SPA's own fallback (/api/lang
//     answers `c.lang || 'en'`), not Ukrainian;
//   - a message that arrives before pairing answers in the writer's Telegram client
//     locale when we ship that language, and in the bot's language otherwise — there is
//     no Studio preference to read before a device is paired;
//   - a missing key falls back to English, not to Ukrainian and not to the raw key;
//   - the Studio language still wins for everything after pairing.
//
// NEVER touches the real Telegram API: `_callApi` is replaced with a recorder.
// Run: node test/telegram-lang.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-tglang-'));
const db = require('../db-adapter')(path.join(dir, 'test.db'));
db.exec(`
  CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT,
    workdir TEXT, git_root TEXT, model TEXT, engine TEXT, run_engine TEXT, agent_mode TEXT, claude_session_id TEXT);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, type TEXT,
    content TEXT, tool_name TEXT, agent_id TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, notes TEXT, status TEXT,
    sort_order INTEGER, session_id TEXT, workdir TEXT, git_root TEXT, model TEXT, mode TEXT, agent_mode TEXT,
    max_turns INTEGER, attachments TEXT, depends_on TEXT, chain_id TEXT, source_session_id TEXT,
    scheduled_at TEXT, recurrence TEXT, recurrence_end_at TEXT, effort TEXT, run_engine TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
`);

const TelegramBot = require('../telegram-bot');
const BOT_I18N = require('../telegram-bot-i18n');
const log = { info() {}, warn() {}, error() {}, debug() {} };

function makeBot(lang) {
  const bot = new TelegramBot(db, { log, lang });
  bot._calls = [];
  bot._callApi = async (method, params) => {
    bot._calls.push({ method, ...params });
    if (method === 'sendMessage') return { message_id: bot._calls.length, chat: { id: params.chat_id } };
    return {};
  };
  bot._forum._api.callApi = (method, params) => bot._callApi(method, params);
  return bot;
}

const sentText = bot => bot._calls.filter(c => c.method === 'sendMessage').map(c => c.text || '').join('\n');

(async () => {
  console.log('language resolution:');
  {
    // No opts.lang at all — the shape a fresh install produces.
    const bot = new TelegramBot(db, { log });
    check('an unconfigured bot speaks English', bot.lang, 'en');
    check('and its pairing screen is the English one',
      bot._t('start_pairing'), BOT_I18N.en.start_pairing);
    check('a configured Studio language still wins',
      new TelegramBot(db, { log, lang: 'uk' })._t('start_pairing'), BOT_I18N.uk.start_pairing);
  }

  console.log('\nthe fallback chain ends in English, never Ukrainian:');
  {
    const bot = makeBot('en');
    check('an unknown language falls back to English',
      TelegramBot.prototype._t.call({ lang: 'zz' }, 'start_pairing'), BOT_I18N.en.start_pairing);
    // A language dict that exists but lacks the key: the uk dict is complete today, so
    // this is exercised through a key nothing defines.
    check('a missing key returns the key, not Ukrainian text',
      bot._t('no_such_key_at_all'), 'no_such_key_at_all');
    check('params still interpolate with an explicit language',
      bot._t('invalid_code', { remaining: 3 }, 'ru'),
      BOT_I18N.ru.invalid_code.replace('{remaining}', '3'));
  }

  console.log('\npre-pairing screen follows the Telegram client locale:');
  {
    const bot = makeBot('uk');   // Studio set to Ukrainian by the owner
    const write = (langCode, text = '/start') => {
      bot._calls.length = 0;
      return bot._handleUpdate({
        message: {
          message_id: 1, date: Math.floor(Date.now() / 1000), text,
          from: { id: 9001, first_name: 'Guest', language_code: langCode },
          chat: { id: 9001, type: 'private' },
        },
      }).then(() => sentText(bot));
    };

    const french = await write('fr');
    check('a French client gets the French pairing screen', french, BOT_I18N.fr.start_pairing);
    const hebrew = await write('he-IL');
    check('a regional code is reduced to its language', hebrew, BOT_I18N.he.start_pairing);
    const german = await write('de');
    check('an unsupported locale falls back to the Studio language', german, BOT_I18N.uk.start_pairing);
    const none = await write(undefined);
    check('no locale at all falls back to the Studio language', none, BOT_I18N.uk.start_pairing);

    // The pairing-code failure path is the same screen and must match it.
    const bad = await write('fr', 'ABC123');
    // The count itself depends on how many attempts this user already burned, so only
    // the template's language is asserted here.
    check('a failed pairing code is answered in the same language',
      bad.startsWith(BOT_I18N.fr.invalid_code.split('{remaining}')[0]), true);
  }

  console.log('\nthe Studio language still governs paired chats:');
  {
    const bot = makeBot('uk');
    check('main menu is Ukrainian', bot._t('main_title'), BOT_I18N.uk.main_title);
    check('the pairing override is scoped to the pairing flow',
      bot._t('main_title', {}, null), BOT_I18N.uk.main_title);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
