// Local harness for the Telegram-path fixes that need a running bot: routing,
// thread targeting, busy/queue behaviour, and the bot-mention path.
//
// NEVER touches the real Telegram API: `_callApi` is replaced with a recorder, so
// nothing leaves this process and no token is read.
// Run: node test/telegram-behaviour.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-tgtest-')), 'test.db');
const openDatabase = require('../db-adapter');
const db = openDatabase(dbPath);
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
const log = { info() {}, warn() {}, error() {}, debug() {} };
const bot = new TelegramBot(db, { log, lang: 'en' });

// Record every outbound API call instead of performing it.
const calls = [];
bot._callApi = async (method, params) => {
  calls.push({ method, ...params });
  if (method === 'sendMessage') return { message_id: calls.length, chat: { id: params.chat_id } };
  if (method === 'createForumTopic') return { message_thread_id: 900 + calls.length };
  return {};
};
// The Forum module got `callApi: this._callApi.bind(this)` at construction time, so it
// holds the ORIGINAL function — replacing bot._callApi alone leaves forum calls going to
// the real Telegram API. (Calls the forum makes through sendMessage were always caught,
// because _sendMessage looks up this._callApi dynamically; direct callApi ones were not.)
bot._forum._api.callApi = (method, params) => bot._callApi(method, params);
const sends = () => calls.filter(c => c.method === 'sendMessage');
const reset = () => { calls.length = 0; };

// Pair a device so authorization passes, and connect it to a forum supergroup.
const USER = 4242, PRIVATE_CHAT = 5555, FORUM_CHAT = -1001234;
db.prepare('INSERT INTO telegram_devices (telegram_user_id, telegram_chat_id, display_name, username) VALUES (?,?,?,?)')
  .run(USER, PRIVATE_CHAT, 'Tester', 'tester');
bot._stmts.setForumChatId.run(FORUM_CHAT, USER);
bot._stmts.addForumTopic.run(4, FORUM_CHAT, 'project', '/w/alpha');
bot._stmts.addForumTopic.run(5, FORUM_CHAT, 'project', '/w/beta');
bot._stmts.addForumTopic.run(6, FORUM_CHAT, 'tasks', null);
bot._forum._loadTopicsFromDb();

const mkSession = (id, workdir) => db.prepare(
  "INSERT INTO sessions (id, title, created_at, updated_at, workdir, model, engine) VALUES (?,?,datetime('now'),datetime('now'),?,'sonnet','cli')"
).run(id, 'S ' + id, workdir);
mkSession('a1', '/w/alpha');
mkSession('b1', '/w/beta');

const sent = [];
bot.on('send_message', (p) => { sent.push(p); if (p.callback) p.callback({ ok: true }); });

const msg = (over = {}) => ({
  message_id: 1, from: { id: USER }, chat: { id: FORUM_CHAT, type: 'supergroup', is_forum: true },
  text: 'hello', ...over,
});

(async () => {
  console.log('forum routing:');
  {
    reset(); sent.length = 0;
    // Telegram does NOT set is_topic_message for the General topic — gating on it
    // made General messages skip Forum Mode entirely.
    await bot._handleUpdate({ message: msg({ text: '/status', message_thread_id: undefined, is_topic_message: undefined }) });
    check('a General-topic command is handled by the forum path, not private chat',
      sends().some(s => String(s.chat_id) === String(FORUM_CHAT)), true);
  }
  {
    reset(); sent.length = 0;
    await bot._handleUpdate({ message: msg({ text: 'write a unit test for parser.js', message_thread_id: 4, is_topic_message: true }) });
    // "write..." used to be swallowed by a startsWith() keyboard-button match.
    check('a message merely STARTING with "write" reaches Claude', sent.length, 1);
    check('and carries its own topic', sent[0]?.threadId, 4);
  }
  {
    reset(); sent.length = 0;
    await bot._handleUpdate({ message: msg({ text: 'write', message_thread_id: 4, is_topic_message: true }) });
    check('the bare "write" keyboard label is still swallowed', sent.length, 0);
  }

  console.log('\ntopic-scoped session memory:');
  {
    sent.length = 0;
    await bot._handleUpdate({ message: msg({ text: 'first', message_thread_id: 4, is_topic_message: true }) });
    const s4 = sent.at(-1)?.sessionId;
    await bot._handleUpdate({ message: msg({ text: 'second', message_thread_id: 5, is_topic_message: true }) });
    const s5 = sent.at(-1)?.sessionId;
    await bot._handleUpdate({ message: msg({ text: 'third', message_thread_id: 4, is_topic_message: true }) });
    const s4again = sent.at(-1)?.sessionId;
    check('two topics use two different sessions', s4 !== s5, true);
    check('returning to a topic restores ITS session, not the most recent one', s4again, s4);
  }

  console.log('\nask_user interception is scoped to where the question was asked:');
  {
    sent.length = 0; reset();
    const ctx = bot._getContext(USER);
    ctx.state = 'AWAITING_ASK_RESPONSE';
    ctx.stateData = { askRequestId: 'REQ1', askChatId: FORUM_CHAT, askThreadId: 4 };
    let answered = null;
    bot.once('ask_user_response', (p) => { answered = p; });

    await bot._handleUpdate({ message: msg({ text: 'work on project B please', message_thread_id: 5, is_topic_message: true }) });
    check('typing in ANOTHER topic is not eaten as the answer', answered, null);
    check('and is dispatched as a normal message instead', sent.length, 1);

    await bot._handleUpdate({ message: msg({ text: 'yes do it', message_thread_id: 4, is_topic_message: true }) });
    check('typing in the asking topic answers the question', answered?.requestId, 'REQ1');
  }
  {
    sent.length = 0;
    const ctx = bot._getContext(USER);
    ctx.state = 'AWAITING_ASK_RESPONSE';
    ctx.stateData = { askRequestId: 'REQ2', askChatId: FORUM_CHAT, askThreadId: 4 };
    let answered = null;
    bot.once('ask_user_response', (p) => { answered = p; });
    await bot._handleUpdate({ message: msg({ text: '/stop', message_thread_id: 4, is_topic_message: true }) });
    check('a command is never swallowed as an answer', answered, null);
    bot._getContext(USER).state = 'IDLE';
    bot._getContext(USER).stateData = null;
  }

  console.log('\nforum attachments land in the forum-scoped store:');
  {
    reset();
    const fctx = bot._forum._getForumContext(FORUM_CHAT, 4, USER);
    fctx.pendingAttachments = [];
    const dctx = bot._getContext(USER);
    dctx.pendingAttachments = [];
    dctx.sessionId = 'a1';
    // Stub the file download so no network call happens.
    const preMediaCallApi = bot._callApi;
    bot._callApi = async (method, params) => {
      calls.push({ method, ...params });
      if (method === 'getFile') return { file_path: 'photos/x.jpg' };
      if (method === 'sendMessage') return { message_id: calls.length };
      return {};
    };
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    await bot._handleMediaMessage(msg({ text: undefined, photo: [{ file_id: 'F1' }], message_thread_id: 4 }));
    global.fetch = realFetch;
    bot._callApi = preMediaCallApi;
    check('a photo sent in a topic is stored for THAT topic', fctx.pendingAttachments.length, 1);
    check('and does not leak into the private-chat context', dctx.pendingAttachments.length, 0);
  }

  console.log('\nrate limiting tells the user instead of going silent:');
  {
    reset();
    bot._rateLimit.set(USER, { count: 999, resetAt: Date.now() + 60000, notified: false });
    await bot._handleUpdate({ message: msg({ text: 'hi', message_thread_id: 4, is_topic_message: true }) });
    check('the first dropped message is acknowledged', sends().length, 1);
    reset();
    await bot._handleUpdate({ message: msg({ text: 'hi again', message_thread_id: 4, is_topic_message: true }) });
    check('the notice itself does not become a flood', sends().length, 0);
    bot._rateLimit.delete(USER);
  }

  console.log('\nempty tasks-topic messages do not create empty tasks:');
  {
    reset();
    const before = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
    await bot._handleUpdate({ message: msg({ text: undefined, sticker: { file_id: 'S' }, message_thread_id: 6, is_topic_message: true }) });
    check('a sticker creates no task', db.prepare('SELECT COUNT(*) c FROM tasks').get().c, before);
    await bot._handleUpdate({ message: msg({ text: 'Real task title', message_thread_id: 6, is_topic_message: true }) });
    check('real text still creates one', db.prepare('SELECT COUNT(*) c FROM tasks').get().c, before + 1);
    check('and it has a title', db.prepare('SELECT title FROM tasks ORDER BY rowid DESC LIMIT 1').get().title, 'Real task title');
  }

  console.log('\n/bots lists the roster a mention can reach:');
  {
    // Mentions have worked from Telegram for a while; nothing here ever listed the
    // handles, so the roster was discoverable only from the web UI.
    const ROSTER = [
      { id: 'analyst', label: 'Market Analyst', avatar: '📈', model: 'opus', description: 'reads the tape' },
      { id: 'writer', label: 'Writer', avatar: '', model: null, description: '' },
    ];
    const withRoster = (over = {}) => {
      bot._getRoster = () => ({ bots: ROSTER, available: true, reason: null, projectName: 'Alpha', ...over });
    };
    const text = () => sends().map(s => s.text).join('\n');

    reset(); withRoster();
    await bot._handleUpdate({ message: msg({ text: '/bots', message_thread_id: 4, is_topic_message: true }) });
    check('every handle is listed in the doubled form the parser expects',
      /@@analyst/.test(text()) && /@@writer/.test(text()), true);
    check('a bot with no avatar still gets one', text().includes('🤖'), true);
    check('the model is shown when the bot pins one', text().includes('opus'), true);
    check('nothing about the engine is said when bots do run here',
      /API engine/.test(text()), false);

    reset(); withRoster({ available: false, reason: 'subscription' });
    await bot._handleUpdate({ message: msg({ text: '/bots', message_thread_id: 4, is_topic_message: true }) });
    check('a subscription chat is told bots will not run', /Subscription engine/.test(text()), true);
    check('…and is still shown the roster rather than an error',
      /@@analyst/.test(text()), true);

    reset(); withRoster({ available: false, reason: 'ssh' });
    await bot._handleUpdate({ message: msg({ text: '/bots', message_thread_id: 4, is_topic_message: true }) });
    check('an SSH chat names SSH, not the subscription engine',
      /remote \(SSH\) project/.test(text()), true);

    reset(); withRoster({ bots: [] });
    await bot._handleUpdate({ message: msg({ text: '/bots', message_thread_id: 4, is_topic_message: true }) });
    check('an empty roster says where to create one', /no bots yet/.test(text()), true);

    // Label, description AND avatar are all free user text rendered into an HTML
    // message — an unescaped one would break the message or inject markup.
    reset();
    bot._getRoster = () => ({
      bots: [{ id: 'evil', label: '<b>Bold</b>', avatar: '<i>x</i>', model: null, description: 'a & b' }],
      available: true, reason: null, projectName: null,
    });
    await bot._handleUpdate({ message: msg({ text: '/bots', message_thread_id: 4, is_topic_message: true }) });
    check('a label carrying markup is escaped', text().includes('&lt;b&gt;Bold&lt;/b&gt;'), true);
    check('an avatar carrying markup is escaped too', text().includes('&lt;i&gt;x&lt;/i&gt;'), true);
    check('an ampersand in a description is escaped', text().includes('a &amp; b'), true);

    // 40 bots (ROSTER_MAX) with descriptions overrun Telegram's 4096-char cap.
    reset();
    bot._getRoster = () => ({
      bots: Array.from({ length: 40 }, (_, i) => ({
        id: `bot-${i}`, label: `Bot number ${i}`, avatar: '🤖', model: 'sonnet',
        description: 'D'.repeat(180),
      })),
      available: true, reason: null, projectName: null,
    });
    await bot._handleUpdate({ message: msg({ text: '/bots', message_thread_id: 4, is_topic_message: true }) });
    check('a full roster is split instead of being rejected by the API', sends().length > 1, true);
    check('and no chunk exceeds the cap', sends().every(s => s.text.length <= 4000), true);

    // The callback is optional wiring: an older embedder that constructs TelegramBot
    // without it must get a message, not a TypeError.
    reset();
    bot._getRoster = null;
    await bot._handleUpdate({ message: msg({ text: '/bots', message_thread_id: 4, is_topic_message: true }) });
    check('with no roster callback wired, it says so instead of throwing',
      /unavailable/.test(text()), true);
  }

  console.log('\na bot topic addresses one bot without retyping the handle:');
  {
    // A bot topic is a project topic bound to a handle. Rather than a second execution
    // path, it prefixes '@@handle' and hands the message to the ordinary project flow —
    // so the SAME parser and the same runBotTurns dispatch serve both, and server.js
    // needs no bot-topic branch at all.
    const BOT_THREAD = 7;
    bot._stmts.addForumBotTopic.run(BOT_THREAD, FORUM_CHAT, 'bot', '/w/alpha', 'analyst');
    bot._forum._loadTopicsFromDb();

    reset(); sent.length = 0;
    await bot._handleUpdate({ message: msg({ text: 'review the parser', message_thread_id: BOT_THREAD, is_topic_message: true }) });
    check('plain text is addressed to the topic\'s bot',
      sent.some(s => s.text === '@@analyst review the parser'), true);
    check('and runs against the topic\'s project',
      sent.some(s => {
        const row = db.prepare('SELECT workdir FROM sessions WHERE id = ?').get(s.sessionId);
        return row?.workdir === '/w/alpha';
      }), true);

    // Typing the handle yourself must not double it — parseMentions dedupes handles, but
    // '@@analyst @@analyst x' would still leave a stray token in the cleaned prompt.
    reset(); sent.length = 0;
    await bot._handleUpdate({ message: msg({ text: '@@analyst already addressed', message_thread_id: BOT_THREAD, is_topic_message: true }) });
    check('an explicitly typed handle is not doubled',
      sent.some(s => s.text === '@@analyst already addressed'), true);

    // A peer named explicitly still reaches that peer: the topic's own bot is prefixed,
    // and the roster hand-off rules downstream decide the rest.
    reset(); sent.length = 0;
    await bot._handleUpdate({ message: msg({ text: '@@writer take this one', message_thread_id: BOT_THREAD, is_topic_message: true }) });
    check('another bot can still be addressed from a bot topic',
      sent.some(s => s.text === '@@analyst @@writer take this one'), true);

    // Commands are commands everywhere — prefixing would turn /stop into a prompt.
    reset(); sent.length = 0;
    await bot._handleUpdate({ message: msg({ text: '/status', message_thread_id: BOT_THREAD, is_topic_message: true }) });
    check('a command is not turned into a prompt', sent.length, 0);
    check('and is answered as a command', sends().length > 0, true);
  }

  console.log('\na bot-owned task reports into that bot\'s topic:');
  {
    // A task can be assigned to a bot (tasks.bot_id — the Kanban and Schedule editors
    // both offer the picker). Its result went to the shared Activity topic like every
    // other task, so a bot's own routine work was indistinguishable from anyone else's.
    const BOT_THREAD = 7;   // @analyst's topic, bound to /w/alpha above
    bot._stmts.addForumTopic.run(8, FORUM_CHAT, 'activity', null);
    bot._forum._loadTopicsFromDb();
    db.prepare('UPDATE telegram_devices SET notifications_enabled = 1, forum_chat_id = ? WHERE telegram_user_id = ?')
      .run(FORUM_CHAT, USER);
    // notifyTaskComplete returns early unless the bot considers itself running; nothing
    // else in this harness needs the flag, so it is set here rather than globally.
    bot.running = true;
    const unRateLimit = () => { bot._getContext(USER).lastNotifiedAt = 0; };
    const threadOf = (t) => sends().filter(s => s.text === t || /Nightly|Plain/.test(s.text)).map(s => s.message_thread_id);

    reset(); unRateLimit();
    await bot.notifyTaskComplete({
      sessionId: 'a1', title: 'Nightly digest', status: 'done', duration: 4000, botId: 'analyst',
    });
    check('the result lands in the bot\'s own topic', threadOf().includes(BOT_THREAD), true);
    check('and not in the shared Activity topic', threadOf().includes(8), false);

    // Unassigned tasks must keep their existing route exactly.
    reset(); unRateLimit();
    await bot.notifyTaskComplete({ sessionId: 'a1', title: 'Plain task', status: 'done', duration: 1000 });
    check('a task with no bot still goes to Activity', threadOf().includes(8), true);

    // A handle with no topic of its own falls back rather than going undelivered.
    reset(); unRateLimit();
    await bot.notifyTaskComplete({
      sessionId: 'a1', title: 'Nightly digest', status: 'done', duration: 1000, botId: 'nobody-home',
    });
    check('a bot with no topic falls back to Activity', threadOf().includes(8), true);

    // Failures must reach the bot's topic too — that is where someone watching this
    // bot is looking, and a silent failure there is worse than a noisy one.
    reset(); unRateLimit();
    await bot.notifyTaskComplete({
      sessionId: 'a1', title: 'Nightly digest', status: 'error', error: 'boom', botId: 'analyst',
    });
    const botMsgs = sends().filter(s => s.message_thread_id === BOT_THREAD);
    check('a failure reaches the bot\'s topic', botMsgs.length > 0, true);
    check('and carries the reason', /boom/.test(botMsgs.map(s => s.text).join('')), true);
  }

  console.log('\nopening a bot its own topic:');
  {
    const ROSTER2 = [{ id: 'scribe', label: 'Scribe', avatar: '✍️', model: null, description: '' }];
    bot._getRoster = () => ({ bots: ROSTER2, available: true, reason: null, projectName: 'Alpha' });
    let nextThread = 90;
    const origCall = bot._callApi;
    bot._callApi = async (method, params) => {
      if (method === 'createForumTopic') {
        calls.push({ method, ...params });
        return { message_thread_id: ++nextThread };
      }
      return origCall(method, params);
    };

    // /bots inside a Forum offers a button per bot; the same command in a private chat
    // must not, because the fb: callback has no topic to take a project from.
    reset();
    await bot._handleUpdate({ message: msg({ text: '/bots', message_thread_id: 4, is_topic_message: true }) });
    const kb = sends().map(s => s.reply_markup || '').join('');
    check('a Forum listing offers a topic button', kb.includes('fb:scribe'), true);

    reset();
    await bot._handleUpdate({ message: msg({
      text: '/bots', chat: { id: PRIVATE_CHAT, type: 'private' },
      message_thread_id: undefined, is_topic_message: undefined,
    }) });
    check('a private-chat listing does not', sends().map(s => s.reply_markup || '').join('').includes('fb:'), false);

    // Pressing it creates the topic and binds it to the project the button was in.
    reset();
    await bot._forum.handleBotTopicCallback(FORUM_CHAT, USER, 'fb:scribe', 4);
    const created = calls.find(c => c.method === 'createForumTopic');
    check('a topic is created', !!created, true);
    check('and is named after the bot', created?.name, '✍️ Scribe');
    const row = db.prepare("SELECT * FROM forum_topics WHERE type='bot' AND bot_id='scribe'").get();
    check('the row records the handle', row?.bot_id, 'scribe');
    check('and the project it was opened from', row?.workdir, '/w/alpha');

    // Telegram does not reject a duplicate topic name, so without an existence check a
    // second press would orphan the first topic's history behind an identical title.
    reset();
    await bot._forum.handleBotTopicCallback(FORUM_CHAT, USER, 'fb:scribe', 4);
    check('a second press creates nothing', calls.some(c => c.method === 'createForumTopic'), false);
    check('and points at the existing topic', sends().some(s => /already has a topic/.test(s.text)), true);

    // A handle no longer in the roster (deleted bot, or another project's) must not open
    // a topic that can never route anywhere.
    reset();
    await bot._forum.handleBotTopicCallback(FORUM_CHAT, USER, 'fb:ghost', 4);
    check('an unknown handle opens no topic', calls.some(c => c.method === 'createForumTopic'), false);
    check('and says so', sends().some(s => /no longer in this project/.test(s.text)), true);

    // Pressed from the tasks topic, which has no workdir.
    reset();
    await bot._forum.handleBotTopicCallback(FORUM_CHAT, USER, 'fb:scribe', 6);
    check('a topic with no project refuses', calls.some(c => c.method === 'createForumTopic'), false);
    check('and explains where to press it', sends().some(s => /from a project topic/.test(s.text)), true);

    bot._callApi = origCall;
  }

  console.log('\n/cancel is advertised in the native menu and must actually be handled:');
  {
    const privMsg = (over = {}) => ({
      message_id: 1, from: { id: USER }, chat: { id: PRIVATE_CHAT, type: 'private' }, text: '/cancel', ...over,
    });

    reset(); sent.length = 0;
    const ctx = bot._getContext(USER);
    ctx.sessionId = 'a1';
    ctx.pendingAttachments = [{ name: 'x.png' }];
    await bot._handleUpdate({ message: privMsg() });
    check('never falls through to "unknown command"', sends().some(s => /Unknown command/i.test(s.text || '')), false);
    check('clears pending attachments', ctx.pendingAttachments.length, 0);

    reset(); sent.length = 0;
    ctx.sessionId = null;
    await bot._handleUpdate({ message: privMsg() });
    check('with no active session, lands on the main menu, not an error', sends().some(s => /Unknown command/i.test(s.text || '')), false);
  }

  console.log('\na project added after /connect still gets a forum topic:');
  {
    reset();
    // No topic exists yet for /w/gamma in any forum.
    const before = db.prepare("SELECT * FROM forum_topics WHERE type='project' AND workdir='/w/gamma'").get();
    check('no topic exists yet', before, undefined);

    await bot.notifyProjectAdded('/w/gamma', 'Gamma');
    const created = calls.filter(c => c.method === 'createForumTopic');
    check('exactly one topic is created (one connected forum)', created.length, 1);
    const row = db.prepare("SELECT * FROM forum_topics WHERE type='project' AND workdir='/w/gamma'").get();
    check('and it is recorded against the workdir', row?.workdir, '/w/gamma');

    reset();
    await bot.notifyProjectAdded('/w/gamma', 'Gamma');
    check('a second registration creates no duplicate', calls.some(c => c.method === 'createForumTopic'), false);

    reset();
    await bot.notifyProjectAdded('', 'No workdir');
    check('an empty workdir is a no-op, not a crash', calls.some(c => c.method === 'createForumTopic'), false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
