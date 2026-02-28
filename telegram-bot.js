// ─── Telegram Bot Module for Claude Code Studio ─────────────────────────────
// Long-polling bot that runs alongside the main server.
// No external dependencies — uses Node 20 built-in fetch.
// Security: Telegram User ID whitelist via pairing codes, content sanitization.
'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');

const TELEGRAM_API = 'https://api.telegram.org/bot';
const PAIRING_CODE_TTL = 5 * 60 * 1000; // 5 minutes
const PAIRING_CODE_LENGTH = 6;
const MAX_FAILED_ATTEMPTS = 3;
const BLOCK_DURATION = 15 * 60 * 1000; // 15 minutes after too many wrong codes
const POLL_TIMEOUT = 30; // seconds (Telegram long-polling)
const MAX_MESSAGE_LENGTH = 4000; // Telegram max ~4096, keep margin
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30; // commands per minute

// Patterns that indicate sensitive content — never sent through Telegram
const SENSITIVE_FILE_PATTERNS = [
  /\.env$/i, /\.env\.\w+$/i,
  /auth\.json$/i, /sessions-auth\.json$/i,
  /config\.json$/i,
  /credentials/i, /secrets?\./i,
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
  /id_rsa/i, /id_ed25519/i,
];

const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*['"]?[\w\-\.]{8,}/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /glpat-[a-zA-Z0-9\-_]{20,}/g,
  /xoxb-[a-zA-Z0-9\-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[a-zA-Z0-9\-_.~+/]{20,}/g,
];

// ─── Bot Internationalization ───────────────────────────────────────────────

const BOT_I18N = {
  uk: {
    // Pairing & auth
    'rate_limit': '⚠️ Забагато запитів. Зачекайте хвилину.',
    'notif_on': '🔔 Сповіщення увімкнено',
    'notif_off': '🔕 Сповіщення вимкнено',
    'blocked': '🔒 Забагато невдалих спроб. Спробуйте через 15 хвилин.',
    'new_conn_disabled': '🔒 Нові підключення зараз вимкнено.\n\nЗверніться до адміністратора для активації режиму підключення.',
    'start_pairing': '👋 <b>Claude Code Studio</b>\n\nДля підключення введіть 6-символьний код з панелі налаштувань вашого Studio.\n\n💡 Код має вигляд: <code>XXX·XXX</code>',
    'new_conn_off': '🔒 Нові підключення вимкнено.',
    'already_paired': '✅ Цей пристрій вже підключено!',
    'paired_ok': '✅ <b>Пристрій підключено!</b>\n\n📱 {name}\n\nТепер ви будете отримувати сповіщення та зможете керувати Studio віддалено.\n\nВведіть /help для списку команд.',
    'use_menu': '🏠 Використовуйте меню нижче або кнопки в повідомленнях.',
    'invalid_code': '❌ Невірний або прострочений код.\n\nЗалишилось спроб: {remaining}',

    // Keyboard buttons (persistent)
    'kb_menu': '🏠 Меню',
    'kb_status': '📊 Статус',

    // Main menu
    'main_title': '🤖 <b>Claude Code Studio</b>',
    'main_project': '📁 Проект: <code>{name}</code>',
    'main_chat': '💬 Чат: {title}',
    'main_choose': '\nОберіть дію:',
    'btn_projects': '📁 Проекти',
    'btn_chats': '💬 Чати',
    'btn_tasks': '📋 Задачі',
    'btn_status': '📊 Статус',
    'btn_settings': '⚙ Налаштування',
    'btn_back': '← Назад',
    'btn_back_menu': '← Меню',
    'btn_back_projects': '← Проекти',
    'btn_back_chats': '← Чати',
    'btn_back_overview': '← Огляд',
    'btn_next': 'Далі →',
    'btn_write': '📝 Написати',
    'btn_all_messages': '📜 Всі повідомлення',
    'btn_cancel': '❌ Скасувати',
    'btn_write_chat': '✉ Написати в чат',
    'btn_refresh': '🔄 Оновити',
    'btn_full_msg': '📄 Повне повідомлення',
    'btn_more': '📜 Ще більше',
    'btn_full_response': '📄 Повна відповідь',
    'btn_main_menu': '← Головне меню',
    'btn_parent_dir': '↑ Батьківська папка',
    'btn_all_tasks': '🌍 Всі задачі',
    'btn_disable_notif': '🔕 Вимкнути сповіщення',
    'btn_enable_notif': '🔔 Увімкнути сповіщення',
    'btn_unlink_device': '🔓 Відключити пристрій',
    'btn_confirm_unlink': '✅ Так, відключити',

    // Projects
    'projects_title': '📁 <b>Проекти</b> ({count})',
    'projects_empty': '📁 Немає проектів з чатами.',
    'project_not_found': '❌ Проект не знайдено.',
    'project_choose': '\n\nОберіть розділ:',
    'project_set': '✅ Проект: <code>{name}</code>\n\nВведіть /chats для перегляду чатів.',
    'project_invalid': '❌ Невірний номер. Спочатку виконайте /projects',
    'project_current': '📁 Поточний проект: <code>{name}</code>',
    'project_hint': '💡 Спочатку виконайте /projects, потім /project <code><номер></code>',
    'project_chats_label': '{count} чатів',
    'project_select_hint': '💡 /project <code><номер></code> — вибрати проект',

    // Chats
    'chats_title_project': '💬 <b>Чати</b> — {project}',
    'chats_title_all': '💬 <b>Всі чати</b>',
    'chats_empty': '💬 Немає чатів.',
    'chat_untitled': 'Без назви',
    'chat_not_found': '❌ Чат не знайдено.',
    'session_not_found': '❌ Сесію не знайдено.',
    'chat_messages': '{count} повідомлень',
    'chat_no_messages': '📭 Немає повідомлень в цьому чаті.',
    'chat_active': '💬 Активний чат: {title}',
    'chat_hint': '💡 Спочатку /chats, потім /chat <code><номер></code>',
    'chat_select_hint': '💡 /chat <code><номер></code> — відкрити чат',
    'chat_invalid': '❌ Невірний номер. Спочатку виконайте /chats',
    'chat_select_hint2': '💡 Спочатку виберіть чат: /chats → /chat <code><n></code>',

    // Dialog
    'dialog_messages': '📄 {count} повідомлень',
    'dialog_page': '📄 {count} повідомлень | Сторінка {page}/{total}',
    'dialog_page_short': '📄 Сторінка {page}/{total} | {count} повідомлень',
    'dialog_separator': '· · ·  <i>{count} повідомлень</i>  · · ·',
    'dialog_truncated': '...скорочено',

    // Compose
    'compose_mode': '✉ <b>Режим відправки</b>\n\nВведіть повідомлення — воно буде відправлене в чат Claude.\n\n<i>Будь-який текст без / піде як повідомлення.</i>',
    'compose_hint': '📝 Пишіть повідомлення — воно піде в цей чат',
    'compose_no_session': 'Після цього просто пишіть повідомлення — вони будуть відправлені в чат.',
    'compose_select_first': '💡 Спочатку виберіть чат:\n/projects → /project <code><n></code> → /chats → /chat <code><n></code>\n\nПісля цього просто пишіть повідомлення — вони будуть відправлені в чат.',
    'compose_sent': '⏳ Повідомлення відправлено{note}. Чекаю відповідь...',

    // Tasks
    'tasks_title': '📋 <b>Задачі</b> ({count})',
    'tasks_empty': '📋 Немає задач.',

    // Status
    'status_title': '📊 <b>Studio Status</b>',
    'status_uptime': '⏱ Аптайм: {hours}h {mins}m',
    'status_sessions': '💬 Сесій: {count}',
    'status_messages': '📝 Повідомлень: {count}',
    'status_tasks_count': '📋 Задач: {count}',
    'status_tasks_heading': '<b>Задачі:</b>',
    'status_devices': '📱 Підключених пристроїв: {count}',
    'status_new_conn': '🔒 Нові підключення: {status}',
    'status_conn_on': 'увімкнено',
    'status_conn_off': 'вимкнено',
    'status_devices_short': '📱 Пристроїв: {count}',
    'status_tasks_label': '📋 <b>Задачі</b>',
    'status_updated': '<i>Оновлено: {time}</i>',

    // Settings
    'settings_title': '⚙ <b>Налаштування</b>',
    'settings_paired': '📅 Підключено: {date}',
    'settings_notif': '🔔 Сповіщення: <b>{status}</b>',
    'settings_unlink_confirm': '⚠️ <b>Відключити пристрій?</b>\n\nВи більше не зможете керувати Studio з цього акаунту.\nДля повторного підключення знадобиться новий код.',
    'settings_unlinked': '🔓 Пристрій відключено.\n\nДля повторного підключення знадобиться новий код.',
    'unlink_done': '🔓 Пристрій відключено від Studio.\n\nДля повторного підключення знадобиться новий код.',
    'unlink_admin': '🔓 Ваш пристрій було відключено адміністратором.',

    // Files
    'files_denied': '🔒 Доступ заборонено.',
    'files_denied_workspace': '🔒 Доступ заборонено — шлях поза межами workspace.',
    'files_sensitive': '🔒 Цей файл містить конфіденційні дані і не може бути переглянутий через Telegram.',
    'files_sensitive_short': '🔒 Файл містить конфіденційні дані.',
    'files_empty_dir': '📂 Порожня директорія.',
    'files_empty_label': '<i>(порожня)</i>',
    'files_truncated': '✂️ <i>(скорочено, {len} символів)</i>',
    'files_truncated_short': '✂️ <i>(скорочено)</i>',

    // Errors
    'error_prefix': '❌ Помилка: {msg}',
    'error_unknown_cmd': '❓ Невідома команда: <code>{cmd}</code>\n\nВведіть /help для списку команд.',

    // Time
    'time_ago_now': 'щойно',
    'time_ago_min': '{n} хв тому',
    'time_ago_hour': '{n} год тому',
    'time_ago_day': '{n} д тому',
    'time_ago_long': 'давно',

    // Help
    'help_text': '📖 <b>Команди Claude Code Studio</b>\n\n<b>Навігація:</b>\n/projects — список проектів\n/project <code><n></code> — вибрати проект\n/chats — чати поточного проекту\n/chat <code><n></code> — відкрити чат\n/back — повернутися назад\n\n<b>Перегляд:</b>\n/last <code>[n]</code> — останні N повідомлень (5)\n/full — повна остання відповідь\n/tasks — задачі (Kanban)\n/files <code>[path]</code> — файли в workspace\n/cat <code><file></code> — вміст файлу\n/diff — git diff в workspace\n/log <code>[n]</code> — останні git коміти\n\n<b>Дії:</b>\n/new <code>[title]</code> — нова сесія\n/stop — зупинити поточну задачу\n\n<b>Налаштування:</b>\n/status — стан Studio\n/notify <code>on/off</code> — сповіщення\n/unlink — відключити цей пристрій',

    // Back navigation
    'back_to_chats': '↩️ Повернулися до списку чатів. Введіть /chats',
    'back_to_projects': '↩️ Повернулися до списку проектів. Введіть /projects',
    'back_at_top': '📍 Ви на верхньому рівні. Введіть /projects',

    // Notify
    'notify_on': '🔔 Сповіщення увімкнено.',
    'notify_off': '🔕 Сповіщення вимкнено.',
    'notify_current': '🔔 Сповіщення: <b>{status}</b>\n\n💡 /notify <code>on</code> або /notify <code>off</code>',

    // Git
    'git_no_changes': '📊 Немає змін або не git-репозиторій.',
    'git_not_repo': '📊 Не git-репозиторій.',
    'git_last_commits': '📜 <b>Останні {n} комітів</b>',

    // Misc
    'no_responses': '📭 Немає відповідей в цьому чаті.',
    'select_chat_first': '💡 Спочатку виберіть чат.',
    'select_chat_hint': '💡 Спочатку виберіть чат: /chats → /chat <code><n></code>',
    'cat_usage': '💡 Використання: /cat <code><файл></code>',
    'msg_full_hint': '📎 /full — повна остання відповідь',
    'msg_compose_hint': '📝 Пишіть повідомлення — воно піде в цей чат',

    // Attach
    'attach_cleared': '🗑 Вкладення очищено.',
  },
  en: {
    'rate_limit': '⚠️ Too many requests. Please wait a minute.',
    'notif_on': '🔔 Notifications enabled',
    'notif_off': '🔕 Notifications disabled',
    'blocked': '🔒 Too many failed attempts. Try again in 15 minutes.',
    'new_conn_disabled': '🔒 New connections are currently disabled.\n\nContact the administrator to enable connection mode.',
    'start_pairing': '👋 <b>Claude Code Studio</b>\n\nEnter the 6-character code from your Studio settings panel to connect.\n\n💡 Code format: <code>XXX·XXX</code>',
    'new_conn_off': '🔒 New connections disabled.',
    'already_paired': '✅ This device is already connected!',
    'paired_ok': '✅ <b>Device connected!</b>\n\n📱 {name}\n\nYou will now receive notifications and can control Studio remotely.\n\nType /help for a list of commands.',
    'use_menu': '🏠 Use the menu below or inline buttons.',
    'invalid_code': '❌ Invalid or expired code.\n\nAttempts remaining: {remaining}',

    'kb_menu': '🏠 Menu',
    'kb_status': '📊 Status',

    'main_title': '🤖 <b>Claude Code Studio</b>',
    'main_project': '📁 Project: <code>{name}</code>',
    'main_chat': '💬 Chat: {title}',
    'main_choose': '\nChoose an action:',
    'btn_projects': '📁 Projects',
    'btn_chats': '💬 Chats',
    'btn_tasks': '📋 Tasks',
    'btn_status': '📊 Status',
    'btn_settings': '⚙ Settings',
    'btn_back': '← Back',
    'btn_back_menu': '← Menu',
    'btn_back_projects': '← Projects',
    'btn_back_chats': '← Chats',
    'btn_back_overview': '← Overview',
    'btn_next': 'Next →',
    'btn_write': '📝 Write',
    'btn_all_messages': '📜 All messages',
    'btn_cancel': '❌ Cancel',
    'btn_write_chat': '✉ Write to chat',
    'btn_refresh': '🔄 Refresh',
    'btn_full_msg': '📄 Full message',
    'btn_more': '📜 Load more',
    'btn_full_response': '📄 Full response',
    'btn_main_menu': '← Main menu',
    'btn_parent_dir': '↑ Parent directory',
    'btn_all_tasks': '🌍 All tasks',
    'btn_disable_notif': '🔕 Disable notifications',
    'btn_enable_notif': '🔔 Enable notifications',
    'btn_unlink_device': '🔓 Unlink device',
    'btn_confirm_unlink': '✅ Yes, unlink',

    'projects_title': '📁 <b>Projects</b> ({count})',
    'projects_empty': '📁 No projects with chats.',
    'project_not_found': '❌ Project not found.',
    'project_choose': '\n\nChoose a section:',
    'project_set': '✅ Project: <code>{name}</code>\n\nType /chats to view chats.',
    'project_invalid': '❌ Invalid number. Run /projects first.',
    'project_current': '📁 Current project: <code>{name}</code>',
    'project_hint': '💡 Run /projects first, then /project <code><number></code>',
    'project_chats_label': '{count} chats',
    'project_select_hint': '💡 /project <code><number></code> — select project',

    'chats_title_project': '💬 <b>Chats</b> — {project}',
    'chats_title_all': '💬 <b>All chats</b>',
    'chats_empty': '💬 No chats.',
    'chat_untitled': 'Untitled',
    'chat_not_found': '❌ Chat not found.',
    'session_not_found': '❌ Session not found.',
    'chat_messages': '{count} messages',
    'chat_no_messages': '📭 No messages in this chat.',
    'chat_active': '💬 Active chat: {title}',
    'chat_hint': '💡 Run /chats first, then /chat <code><number></code>',
    'chat_select_hint': '💡 /chat <code><number></code> — open chat',
    'chat_invalid': '❌ Invalid number. Run /chats first.',
    'chat_select_hint2': '💡 Select a chat first: /chats → /chat <code><n></code>',

    'dialog_messages': '📄 {count} messages',
    'dialog_page': '📄 {count} messages | Page {page}/{total}',
    'dialog_page_short': '📄 Page {page}/{total} | {count} messages',
    'dialog_separator': '· · ·  <i>{count} messages</i>  · · ·',
    'dialog_truncated': '...truncated',

    'compose_mode': '✉ <b>Compose mode</b>\n\nType your message — it will be sent to the Claude chat.\n\n<i>Any text without / will be sent as a message.</i>',
    'compose_hint': '📝 Type a message — it will be sent to this chat',
    'compose_no_session': 'Now just type messages — they will be sent to the chat.',
    'compose_select_first': '💡 Select a chat first:\n/projects → /project <code><n></code> → /chats → /chat <code><n></code>\n\nThen just type messages — they will be sent to the chat.',
    'compose_sent': '⏳ Message sent{note}. Waiting for response...',

    'tasks_title': '📋 <b>Tasks</b> ({count})',
    'tasks_empty': '📋 No tasks.',

    'status_title': '📊 <b>Studio Status</b>',
    'status_uptime': '⏱ Uptime: {hours}h {mins}m',
    'status_sessions': '💬 Sessions: {count}',
    'status_messages': '📝 Messages: {count}',
    'status_tasks_count': '📋 Tasks: {count}',
    'status_tasks_heading': '<b>Tasks:</b>',
    'status_devices': '📱 Connected devices: {count}',
    'status_new_conn': '🔒 New connections: {status}',
    'status_conn_on': 'enabled',
    'status_conn_off': 'disabled',
    'status_devices_short': '📱 Devices: {count}',
    'status_tasks_label': '📋 <b>Tasks</b>',
    'status_updated': '<i>Updated: {time}</i>',

    'settings_title': '⚙ <b>Settings</b>',
    'settings_paired': '📅 Connected: {date}',
    'settings_notif': '🔔 Notifications: <b>{status}</b>',
    'settings_unlink_confirm': '⚠️ <b>Unlink device?</b>\n\nYou will no longer be able to control Studio from this account.\nA new code will be required to reconnect.',
    'settings_unlinked': '🔓 Device unlinked.\n\nA new code will be required to reconnect.',
    'unlink_done': '🔓 Device unlinked from Studio.\n\nA new code will be required to reconnect.',
    'unlink_admin': '🔓 Your device has been unlinked by the administrator.',

    'files_denied': '🔒 Access denied.',
    'files_denied_workspace': '🔒 Access denied — path outside workspace.',
    'files_sensitive': '🔒 This file contains sensitive data and cannot be viewed via Telegram.',
    'files_sensitive_short': '🔒 File contains sensitive data.',
    'files_empty_dir': '📂 Empty directory.',
    'files_empty_label': '<i>(empty)</i>',
    'files_truncated': '✂️ <i>(truncated, {len} characters)</i>',
    'files_truncated_short': '✂️ <i>(truncated)</i>',

    'error_prefix': '❌ Error: {msg}',
    'error_unknown_cmd': '❓ Unknown command: <code>{cmd}</code>\n\nType /help for a list of commands.',

    'time_ago_now': 'just now',
    'time_ago_min': '{n}m ago',
    'time_ago_hour': '{n}h ago',
    'time_ago_day': '{n}d ago',
    'time_ago_long': 'long ago',

    'help_text': '📖 <b>Claude Code Studio Commands</b>\n\n<b>Navigation:</b>\n/projects — list projects\n/project <code><n></code> — select project\n/chats — chats of current project\n/chat <code><n></code> — open chat\n/back — go back\n\n<b>View:</b>\n/last <code>[n]</code> — last N messages (5)\n/full — full last response\n/tasks — tasks (Kanban)\n/files <code>[path]</code> — files in workspace\n/cat <code><file></code> — file contents\n/diff — git diff in workspace\n/log <code>[n]</code> — recent git commits\n\n<b>Actions:</b>\n/new <code>[title]</code> — new session\n/stop — stop current task\n\n<b>Settings:</b>\n/status — Studio status\n/notify <code>on/off</code> — notifications\n/unlink — unlink this device',

    'back_to_chats': '↩️ Back to chat list. Type /chats',
    'back_to_projects': '↩️ Back to project list. Type /projects',
    'back_at_top': '📍 You are at the top level. Type /projects',

    'notify_on': '🔔 Notifications enabled.',
    'notify_off': '🔕 Notifications disabled.',
    'notify_current': '🔔 Notifications: <b>{status}</b>\n\n💡 /notify <code>on</code> or /notify <code>off</code>',

    'git_no_changes': '📊 No changes or not a git repository.',
    'git_not_repo': '📊 Not a git repository.',
    'git_last_commits': '📜 <b>Last {n} commits</b>',

    'no_responses': '📭 No responses in this chat.',
    'select_chat_first': '💡 Select a chat first.',
    'select_chat_hint': '💡 Select a chat first: /chats → /chat <code><n></code>',
    'cat_usage': '💡 Usage: /cat <code><file></code>',
    'msg_full_hint': '📎 /full — full last response',
    'msg_compose_hint': '📝 Type a message — it will be sent to this chat',

    'attach_cleared': '🗑 Attachments cleared.',
  },
  ru: {
    'rate_limit': '⚠️ Слишком много запросов. Подождите минуту.',
    'notif_on': '🔔 Уведомления включены',
    'notif_off': '🔕 Уведомления отключены',
    'blocked': '🔒 Слишком много неудачных попыток. Попробуйте через 15 минут.',
    'new_conn_disabled': '🔒 Новые подключения сейчас отключены.\n\nОбратитесь к администратору для активации режима подключения.',
    'start_pairing': '👋 <b>Claude Code Studio</b>\n\nДля подключения введите 6-символьный код из панели настроек вашего Studio.\n\n💡 Код имеет вид: <code>XXX·XXX</code>',
    'new_conn_off': '🔒 Новые подключения отключены.',
    'already_paired': '✅ Это устройство уже подключено!',
    'paired_ok': '✅ <b>Устройство подключено!</b>\n\n📱 {name}\n\nТеперь вы будете получать уведомления и сможете управлять Studio удалённо.\n\nВведите /help для списка команд.',
    'use_menu': '🏠 Используйте меню внизу или кнопки в сообщениях.',
    'invalid_code': '❌ Неверный или просроченный код.\n\nОсталось попыток: {remaining}',

    'kb_menu': '🏠 Меню',
    'kb_status': '📊 Статус',

    'main_title': '🤖 <b>Claude Code Studio</b>',
    'main_project': '📁 Проект: <code>{name}</code>',
    'main_chat': '💬 Чат: {title}',
    'main_choose': '\nВыберите действие:',
    'btn_projects': '📁 Проекты',
    'btn_chats': '💬 Чаты',
    'btn_tasks': '📋 Задачи',
    'btn_status': '📊 Статус',
    'btn_settings': '⚙ Настройки',
    'btn_back': '← Назад',
    'btn_back_menu': '← Меню',
    'btn_back_projects': '← Проекты',
    'btn_back_chats': '← Чаты',
    'btn_back_overview': '← Обзор',
    'btn_next': 'Далее →',
    'btn_write': '📝 Написать',
    'btn_all_messages': '📜 Все сообщения',
    'btn_cancel': '❌ Отмена',
    'btn_write_chat': '✉ Написать в чат',
    'btn_refresh': '🔄 Обновить',
    'btn_full_msg': '📄 Полное сообщение',
    'btn_more': '📜 Ещё больше',
    'btn_full_response': '📄 Полный ответ',
    'btn_main_menu': '← Главное меню',
    'btn_parent_dir': '↑ Родительская папка',
    'btn_all_tasks': '🌍 Все задачи',
    'btn_disable_notif': '🔕 Отключить уведомления',
    'btn_enable_notif': '🔔 Включить уведомления',
    'btn_unlink_device': '🔓 Отключить устройство',
    'btn_confirm_unlink': '✅ Да, отключить',

    'projects_title': '📁 <b>Проекты</b> ({count})',
    'projects_empty': '📁 Нет проектов с чатами.',
    'project_not_found': '❌ Проект не найден.',
    'project_choose': '\n\nВыберите раздел:',
    'project_set': '✅ Проект: <code>{name}</code>\n\nВведите /chats для просмотра чатов.',
    'project_invalid': '❌ Неверный номер. Сначала выполните /projects',
    'project_current': '📁 Текущий проект: <code>{name}</code>',
    'project_hint': '💡 Сначала выполните /projects, потом /project <code><номер></code>',
    'project_chats_label': '{count} чатов',
    'project_select_hint': '💡 /project <code><номер></code> — выбрать проект',

    'chats_title_project': '💬 <b>Чаты</b> — {project}',
    'chats_title_all': '💬 <b>Все чаты</b>',
    'chats_empty': '💬 Нет чатов.',
    'chat_untitled': 'Без названия',
    'chat_not_found': '❌ Чат не найден.',
    'session_not_found': '❌ Сессия не найдена.',
    'chat_messages': '{count} сообщений',
    'chat_no_messages': '📭 Нет сообщений в этом чате.',
    'chat_active': '💬 Активный чат: {title}',
    'chat_hint': '💡 Сначала /chats, потом /chat <code><номер></code>',
    'chat_select_hint': '💡 /chat <code><номер></code> — открыть чат',
    'chat_invalid': '❌ Неверный номер. Сначала выполните /chats',
    'chat_select_hint2': '💡 Сначала выберите чат: /chats → /chat <code><n></code>',

    'dialog_messages': '📄 {count} сообщений',
    'dialog_page': '📄 {count} сообщений | Страница {page}/{total}',
    'dialog_page_short': '📄 Страница {page}/{total} | {count} сообщений',
    'dialog_separator': '· · ·  <i>{count} сообщений</i>  · · ·',
    'dialog_truncated': '...сокращено',

    'compose_mode': '✉ <b>Режим отправки</b>\n\nВведите сообщение — оно будет отправлено в чат Claude.\n\n<i>Любой текст без / пойдёт как сообщение.</i>',
    'compose_hint': '📝 Пишите сообщение — оно пойдёт в этот чат',
    'compose_no_session': 'Теперь просто пишите сообщения — они будут отправлены в чат.',
    'compose_select_first': '💡 Сначала выберите чат:\n/projects → /project <code><n></code> → /chats → /chat <code><n></code>\n\nТеперь просто пишите сообщения — они будут отправлены в чат.',
    'compose_sent': '⏳ Сообщение отправлено{note}. Ожидаю ответ...',

    'tasks_title': '📋 <b>Задачи</b> ({count})',
    'tasks_empty': '📋 Нет задач.',

    'status_title': '📊 <b>Studio Status</b>',
    'status_uptime': '⏱ Аптайм: {hours}h {mins}m',
    'status_sessions': '💬 Сессий: {count}',
    'status_messages': '📝 Сообщений: {count}',
    'status_tasks_count': '📋 Задач: {count}',
    'status_tasks_heading': '<b>Задачи:</b>',
    'status_devices': '📱 Подключённых устройств: {count}',
    'status_new_conn': '🔒 Новые подключения: {status}',
    'status_conn_on': 'включены',
    'status_conn_off': 'отключены',
    'status_devices_short': '📱 Устройств: {count}',
    'status_tasks_label': '📋 <b>Задачи</b>',
    'status_updated': '<i>Обновлено: {time}</i>',

    'settings_title': '⚙ <b>Настройки</b>',
    'settings_paired': '📅 Подключено: {date}',
    'settings_notif': '🔔 Уведомления: <b>{status}</b>',
    'settings_unlink_confirm': '⚠️ <b>Отключить устройство?</b>\n\nВы больше не сможете управлять Studio с этого аккаунта.\nДля повторного подключения понадобится новый код.',
    'settings_unlinked': '🔓 Устройство отключено.\n\nДля повторного подключения понадобится новый код.',
    'unlink_done': '🔓 Устройство отключено от Studio.\n\nДля повторного подключения понадобится новый код.',
    'unlink_admin': '🔓 Ваше устройство было отключено администратором.',

    'files_denied': '🔒 Доступ запрещён.',
    'files_denied_workspace': '🔒 Доступ запрещён — путь вне workspace.',
    'files_sensitive': '🔒 Этот файл содержит конфиденциальные данные и не может быть просмотрен через Telegram.',
    'files_sensitive_short': '🔒 Файл содержит конфиденциальные данные.',
    'files_empty_dir': '📂 Пустая директория.',
    'files_empty_label': '<i>(пусто)</i>',
    'files_truncated': '✂️ <i>(сокращено, {len} символов)</i>',
    'files_truncated_short': '✂️ <i>(сокращено)</i>',

    'error_prefix': '❌ Ошибка: {msg}',
    'error_unknown_cmd': '❓ Неизвестная команда: <code>{cmd}</code>\n\nВведите /help для списка команд.',

    'time_ago_now': 'только что',
    'time_ago_min': '{n} мин назад',
    'time_ago_hour': '{n} ч назад',
    'time_ago_day': '{n} д назад',
    'time_ago_long': 'давно',

    'help_text': '📖 <b>Команды Claude Code Studio</b>\n\n<b>Навигация:</b>\n/projects — список проектов\n/project <code><n></code> — выбрать проект\n/chats — чаты текущего проекта\n/chat <code><n></code> — открыть чат\n/back — вернуться назад\n\n<b>Просмотр:</b>\n/last <code>[n]</code> — последние N сообщений (5)\n/full — полный последний ответ\n/tasks — задачи (Kanban)\n/files <code>[path]</code> — файлы в workspace\n/cat <code><file></code> — содержимое файла\n/diff — git diff в workspace\n/log <code>[n]</code> — последние git коммиты\n\n<b>Действия:</b>\n/new <code>[title]</code> — новая сессия\n/stop — остановить текущую задачу\n\n<b>Настройки:</b>\n/status — состояние Studio\n/notify <code>on/off</code> — уведомления\n/unlink — отключить это устройство',

    'back_to_chats': '↩️ Вернулись к списку чатов. Введите /chats',
    'back_to_projects': '↩️ Вернулись к списку проектов. Введите /projects',
    'back_at_top': '📍 Вы на верхнем уровне. Введите /projects',

    'notify_on': '🔔 Уведомления включены.',
    'notify_off': '🔕 Уведомления отключены.',
    'notify_current': '🔔 Уведомления: <b>{status}</b>\n\n💡 /notify <code>on</code> или /notify <code>off</code>',

    'git_no_changes': '📊 Нет изменений или не git-репозиторий.',
    'git_not_repo': '📊 Не git-репозиторий.',
    'git_last_commits': '📜 <b>Последние {n} коммитов</b>',

    'no_responses': '📭 Нет ответов в этом чате.',
    'select_chat_first': '💡 Сначала выберите чат.',
    'select_chat_hint': '💡 Сначала выберите чат: /chats → /chat <code><n></code>',
    'cat_usage': '💡 Использование: /cat <code><файл></code>',
    'msg_full_hint': '📎 /full — полный последний ответ',
    'msg_compose_hint': '📝 Пишите сообщение — оно пойдёт в этот чат',

    'attach_cleared': '🗑 Вложения очищены.',
  },
};


class TelegramBot extends EventEmitter {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} opts
   * @param {object} opts.log - Logger instance { info, warn, error, debug }
   */
  constructor(db, opts = {}) {
    super();
    this.db = db;
    this.log = opts.log || console;
    this.token = null;
    this.running = false;
    this._pollTimer = null;
    this._offset = 0;
    this._acceptNewConnections = true;
    this.lang = opts.lang || 'uk';

    // In-memory state
    this._pairingCodes = new Map();  // code → { createdAt, expiresAt }
    this._failedAttempts = new Map(); // telegramUserId → { count, blockedUntil }
    this._userContext = new Map();    // telegramUserId → { sessionId, projectWorkdir }
    this._rateLimit = new Map();     // telegramUserId → { count, resetAt }

    // DB setup
    this._initDb();
    this._prepareStmts();
  }

  // ─── i18n ─────────────────────────────────────────────────────────────────

  _t(key, params = {}) {
    const dict = BOT_I18N[this.lang] || BOT_I18N.uk;
    let text = dict[key] || BOT_I18N.uk[key] || key;
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return text;
  }

  // ─── Database ──────────────────────────────────────────────────────────────

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL UNIQUE,
        telegram_chat_id INTEGER NOT NULL,
        display_name TEXT,
        username TEXT,
        paired_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active TEXT,
        notifications_enabled INTEGER DEFAULT 1
      );
    `);

    // Phase 2: session persistence columns
    try { this.db.exec("ALTER TABLE telegram_devices ADD COLUMN last_session_id TEXT"); } catch(e) {}
    try { this.db.exec("ALTER TABLE telegram_devices ADD COLUMN last_workdir TEXT"); } catch(e) {}
  }

  _prepareStmts() {
    this._stmts = {
      getDevice:       this.db.prepare('SELECT * FROM telegram_devices WHERE telegram_user_id = ?'),
      getAllDevices:    this.db.prepare('SELECT * FROM telegram_devices ORDER BY paired_at DESC'),
      addDevice:       this.db.prepare('INSERT INTO telegram_devices (telegram_user_id, telegram_chat_id, display_name, username) VALUES (?, ?, ?, ?)'),
      removeDevice:    this.db.prepare('DELETE FROM telegram_devices WHERE id = ?'),
      removeByUserId:  this.db.prepare('DELETE FROM telegram_devices WHERE telegram_user_id = ?'),
      updateLastActive: this.db.prepare('UPDATE telegram_devices SET last_active = datetime(\'now\') WHERE telegram_user_id = ?'),
      getDeviceById:   this.db.prepare('SELECT * FROM telegram_devices WHERE id = ?'),
      updateNotifications: this.db.prepare('UPDATE telegram_devices SET notifications_enabled = ? WHERE telegram_user_id = ?'),
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the bot with the given token.
   * @param {string} botToken
   */
  async start(botToken) {
    if (this.running) return;
    this.token = botToken;
    if (!this.token) throw new Error('Bot token is required');

    // Validate token and ensure clean polling state
    try {
      const me = await this._callApi('getMe');
      this._botInfo = me;

      // Delete any stale webhook — Telegram ignores getUpdates if webhook is set
      await this._callApi('deleteWebhook', { drop_pending_updates: false });

      this.log.info(`[telegram] Bot started: @${me.username} (${me.first_name})`);
    } catch (err) {
      this.log.error(`[telegram] Invalid bot token: ${err.message}`);
      throw new Error(`Invalid bot token: ${err.message}`);
    }

    this.running = true;
    this._poll();

    // Periodic cleanup of in-memory Maps to prevent unbounded growth
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this._pairingCodes) if (now > v.expiresAt) this._pairingCodes.delete(k);
      for (const [k, v] of this._failedAttempts) if (now > v.blockedUntil) this._failedAttempts.delete(k);
      for (const [k, v] of this._rateLimit) if (now > v.resetAt) this._rateLimit.delete(k);
    }, 10 * 60 * 1000); // every 10 minutes

    return this._botInfo;
  }

  stop() {
    this.running = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.log.info('[telegram] Bot stopped');
  }

  isRunning() { return this.running; }

  getBotInfo() { return this._botInfo || null; }

  // ─── Lock Mode ─────────────────────────────────────────────────────────────

  get acceptNewConnections() { return this._acceptNewConnections; }
  set acceptNewConnections(val) {
    this._acceptNewConnections = !!val;
    if (!val) {
      // Clear all pending pairing codes when locking
      this._pairingCodes.clear();
    }
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  async _poll() {
    if (!this.running) return;
    try {
      const updates = await this._callApi('getUpdates', {
        offset: this._offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: JSON.stringify(['message', 'callback_query']),
      });

      if (updates && updates.length > 0) {
        for (const update of updates) {
          this._offset = update.update_id + 1;
          try {
            await this._handleUpdate(update);
          } catch (err) {
            this.log.error(`[telegram] Error handling update: ${err.message}`);
          }
        }
      }
    } catch (err) {
      // Network errors — retry after delay
      if (!err.message?.includes('Invalid bot token')) {
        this.log.warn(`[telegram] Poll error (retrying in 5s): ${err.message}`);
        this._pollTimer = setTimeout(() => this._poll(), 5000);
        return;
      }
      this.log.error(`[telegram] Fatal poll error: ${err.message}`);
      this.stop();
      return;
    }

    // Schedule next poll immediately (long-polling handles the wait)
    if (this.running) {
      this._pollTimer = setTimeout(() => this._poll(), 100);
    }
  }

  // ─── Telegram API ──────────────────────────────────────────────────────────

  async _callApi(method, params = {}) {
    const url = `${TELEGRAM_API}${this.token}/${method}`;

    const body = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) body[k] = v;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POLL_TIMEOUT * 1000 + 10000), // poll timeout + margin
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || `Telegram API error: ${method}`);
    }
    return data.result;
  }

  async _sendMessage(chatId, text, options = {}) {
    // Truncate long messages
    let safeText = text;
    if (safeText.length > MAX_MESSAGE_LENGTH) {
      safeText = safeText.substring(0, MAX_MESSAGE_LENGTH) + '\n\n' + this._t('files_truncated_short');
    }

    const params = {
      chat_id: chatId,
      text: safeText,
      parse_mode: 'HTML',
      ...options,
    };

    try {
      return await this._callApi('sendMessage', params);
    } catch (err) {
      // Retry without parse_mode if HTML parsing fails
      if (err.message?.includes("can't parse")) {
        params.parse_mode = undefined;
        return await this._callApi('sendMessage', params);
      }
      throw err;
    }
  }

  async _editScreen(chatId, msgId, text, keyboard) {
    if (!msgId) {
      // No message to edit — send a new one
      return this._showScreen(chatId, null, text, keyboard);
    }

    const params = {
      chat_id: chatId,
      message_id: msgId,
      text: text.length > MAX_MESSAGE_LENGTH ? text.substring(0, MAX_MESSAGE_LENGTH) + '\n\n' + this._t('files_truncated_short') : text,
      parse_mode: 'HTML',
    };
    if (keyboard) params.reply_markup = JSON.stringify({ inline_keyboard: keyboard });

    try {
      return await this._callApi('editMessageText', params);
    } catch (err) {
      if (err.message?.includes('message is not modified')) return null;
      if (err.message?.includes("can't parse")) {
        params.parse_mode = undefined;
        try { return await this._callApi('editMessageText', params); } catch { /* fall through */ }
      }
      // Any edit failure — fall back to sending a new message
      this.log.warn(`[telegram] editScreen fallback to new message: ${err.message}`);
      return this._showScreen(chatId, null, text, keyboard);
    }
  }

  async _showScreen(chatId, userId, text, keyboard) {
    const params = {};
    if (keyboard) params.reply_markup = JSON.stringify({ inline_keyboard: keyboard });
    const sent = await this._sendMessage(chatId, text, params);
    if (sent && userId !== null) {
      const ctx = this._getContext(userId);
      ctx.screenMsgId = sent.message_id;
      ctx.screenChatId = chatId;
    }
    return sent;
  }

  async _answerCallback(callbackQueryId, text) {
    try {
      await this._callApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
    } catch {}
  }

  // ─── Pairing ───────────────────────────────────────────────────────────────

  /**
   * Generate a new 6-character pairing code.
   * @returns {{ code: string, formattedCode: string, expiresAt: number } | { error: string }}
   */
  generatePairingCode() {
    if (!this._acceptNewConnections) {
      return { error: 'New connections are disabled' };
    }
    if (!this.running) {
      return { error: 'Bot is not running' };
    }

    // Clear expired codes
    const now = Date.now();
    for (const [code, data] of this._pairingCodes) {
      if (now > data.expiresAt) this._pairingCodes.delete(code);
    }

    // Generate unique code
    let code;
    do {
      code = crypto.randomBytes(4).toString('hex').substring(0, PAIRING_CODE_LENGTH).toUpperCase();
    } while (this._pairingCodes.has(code));

    const expiresAt = now + PAIRING_CODE_TTL;
    this._pairingCodes.set(code, { createdAt: now, expiresAt });

    // Format as "XXX·XXX"
    const formattedCode = `${code.slice(0, 3)}·${code.slice(3)}`;

    return { code, formattedCode, expiresAt };
  }

  /**
   * Validate a pairing code submitted by a Telegram user.
   * @returns {boolean}
   */
  _validatePairingCode(code) {
    const clean = code.replace(/[\s·\-\.]/g, '').toUpperCase();
    const data = this._pairingCodes.get(clean);
    if (!data) return false;
    if (Date.now() > data.expiresAt) {
      this._pairingCodes.delete(clean);
      return false;
    }
    // One-time use
    this._pairingCodes.delete(clean);
    return true;
  }

  // ─── Rate Limiting ─────────────────────────────────────────────────────────

  _checkRateLimit(userId) {
    const now = Date.now();
    const entry = this._rateLimit.get(userId);
    if (!entry || now > entry.resetAt) {
      this._rateLimit.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
  }

  _isBlocked(userId) {
    const entry = this._failedAttempts.get(userId);
    if (!entry) return false;
    if (Date.now() > entry.blockedUntil) {
      this._failedAttempts.delete(userId);
      return false;
    }
    return entry.count >= MAX_FAILED_ATTEMPTS;
  }

  _recordFailedAttempt(userId) {
    const entry = this._failedAttempts.get(userId) || { count: 0, blockedUntil: 0 };
    entry.count++;
    if (entry.count >= MAX_FAILED_ATTEMPTS) {
      entry.blockedUntil = Date.now() + BLOCK_DURATION;
    }
    this._failedAttempts.set(userId, entry);
    return entry.count;
  }

  // ─── Authorization ─────────────────────────────────────────────────────────

  _isAuthorized(userId) {
    const device = this._stmts.getDevice.get(userId);
    return !!device;
  }

  // ─── Content Security ──────────────────────────────────────────────────────

  _isSensitiveFile(filePath) {
    return SENSITIVE_FILE_PATTERNS.some(p => p.test(filePath));
  }

  _sanitize(text) {
    if (!text) return '';
    let safe = String(text);
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0; // safety: reset stale state from global regex
      safe = safe.replace(pattern, '[REDACTED]');
    }
    return safe;
  }

  // ─── Update Handler ────────────────────────────────────────────────────────

  async _handleUpdate(update) {
    // Handle callback queries (inline button taps)
    if (update.callback_query) {
      await this._handleCallback(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg) return;

    const userId = msg.from?.id;
    const chatId = msg.chat?.id;
    if (!userId || !chatId) return;

    // Handle media messages (photos, documents, files)
    if (msg.photo || msg.document) {
      if (!this._isAuthorized(userId)) return;
      if (!this._checkRateLimit(userId)) return;
      this._stmts.updateLastActive.run(userId);
      this._restoreDeviceContext(userId);
      return this._handleMediaMessage(msg);
    }

    if (!msg.text) return;

    const text = msg.text.trim();

    // Rate limiting for authorized users
    if (this._isAuthorized(userId) && !this._checkRateLimit(userId)) {
      await this._sendMessage(chatId, this._t('rate_limit'));
      return;
    }

    // If user is not authorized — only handle pairing
    if (!this._isAuthorized(userId)) {
      await this._handleUnauthorized(msg);
      return;
    }

    // Update last active
    this._stmts.updateLastActive.run(userId);

    // Restore persisted context on first interaction
    this._restoreDeviceContext(userId);

    // Persistent keyboard buttons
    if (text === this._t('kb_menu')) { return this._screenMainMenu(chatId, userId); }
    if (text === this._t('kb_status')) { return this._cmdStatus(chatId); }
    if (text === '🔔') {
      const device = this._stmts.getDevice.get(userId);
      const newVal = device?.notifications_enabled ? 0 : 1;
      this._stmts.updateNotifications.run(newVal, userId);
      return this._sendMessage(chatId, newVal ? this._t('notif_on') : this._t('notif_off'));
    }

    // Route commands
    if (text.startsWith('/')) {
      await this._handleCommand(msg);
    } else {
      // Free text — send to active chat session
      await this._handleTextMessage(msg);
    }
  }

  // ─── Unauthorized User (Pairing Flow) ──────────────────────────────────────

  async _handleUnauthorized(msg) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Check if blocked
    if (this._isBlocked(userId)) {
      await this._sendMessage(chatId, this._t('blocked'));
      return;
    }

    // /start command
    if (text === '/start') {
      if (!this._acceptNewConnections) {
        await this._sendMessage(chatId, this._t('new_conn_disabled'));
        return;
      }
      await this._sendMessage(chatId, this._t('start_pairing'));
      return;
    }

    // Anything else — treat as pairing code attempt
    if (!this._acceptNewConnections) {
      await this._sendMessage(chatId, this._t('new_conn_off'));
      return;
    }

    // Validate pairing code
    const isValid = this._validatePairingCode(text);
    if (isValid) {
      // Register device
      const displayName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Unknown';
      const username = msg.from.username || null;

      try {
        this._stmts.addDevice.run(userId, chatId, displayName, username);
      } catch (err) {
        // UNIQUE constraint — user already paired (shouldn't happen, but handle gracefully)
        if (err.message?.includes('UNIQUE')) {
          await this._sendMessage(chatId, this._t('already_paired'));
          return;
        }
        throw err;
      }

      // Reset failed attempts
      this._failedAttempts.delete(userId);

      this.log.info(`[telegram] Device paired: ${displayName} (@${username || 'no-username'}) [${userId}]`);

      await this._sendMessage(chatId, this._t('paired_ok', { name: this._escHtml(displayName) }));

      // Set persistent Reply Keyboard
      await this._callApi('sendMessage', {
        chat_id: chatId,
        text: this._t('use_menu'),
        reply_markup: JSON.stringify({
          keyboard: [[{ text: this._t('kb_menu') }, { text: this._t('kb_status') }, { text: '🔔' }]],
          resize_keyboard: true,
          is_persistent: true,
        }),
      });

      // Emit event so UI can update in real-time
      this.emit('device_paired', {
        telegram_user_id: userId,
        telegram_chat_id: chatId,
        display_name: displayName,
        username,
      });

    } else {
      const attempts = this._recordFailedAttempt(userId);
      const remaining = MAX_FAILED_ATTEMPTS - attempts;

      if (remaining <= 0) {
        await this._sendMessage(chatId, this._t('blocked'));
      } else {
        await this._sendMessage(chatId, this._t('invalid_code', { remaining }));
      }
    }
  }

  // ─── Command Router ────────────────────────────────────────────────────────

  async _handleCommand(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@\w+$/, ''); // strip @botname

    switch (cmd) {
      case '/help':    return this._cmdHelp(chatId);
      case '/start':   return this._screenMainMenu(chatId, userId); // already authorized
      case '/projects':return this._cmdProjects(chatId, userId);
      case '/project': return this._cmdProject(chatId, userId, args);
      case '/chats':   return this._cmdChats(chatId, userId);
      case '/chat':    return this._cmdChat(chatId, userId, args);
      case '/last':    return this._cmdLast(chatId, userId, args);
      case '/full':    return this._cmdFull(chatId, userId);
      case '/status':  return this._cmdStatus(chatId);
      case '/tasks':   return this._cmdTasks(chatId, userId);
      case '/files':   return this._cmdFiles(chatId, userId, args);
      case '/cat':     return this._cmdCat(chatId, userId, args);
      case '/diff':    return this._cmdDiff(chatId, userId);
      case '/log':     return this._cmdLog(chatId, userId, args);
      case '/notify':  return this._cmdNotify(chatId, userId, args);
      case '/stop':    return this._cmdStop(chatId, userId);
      case '/new':     return this._cmdNew(chatId, userId, args.join(' '));
      case '/back':    return this._cmdBack(chatId, userId);
      case '/unlink':  return this._cmdUnlink(chatId, userId);
      default:
        await this._sendMessage(chatId, this._t('error_unknown_cmd', { cmd }));
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  async _cmdHelp(chatId) {
    await this._sendMessage(chatId, this._t('help_text'));
  }

  async _cmdProjects(chatId, userId) {
    try {
      const rows = this.db.prepare(`
        SELECT workdir, COUNT(*) as chat_count, MAX(updated_at) as last_active
        FROM sessions
        WHERE workdir IS NOT NULL AND workdir != ''
        GROUP BY workdir
        ORDER BY last_active DESC
        LIMIT 20
      `).all();

      if (rows.length === 0) {
        await this._sendMessage(chatId, this._t('projects_empty'));
        return;
      }

      const lines = rows.map((r, i) => {
        const name = r.workdir.split('/').filter(Boolean).pop() || r.workdir;
        const ago = this._timeAgo(r.last_active);
        return `${i + 1}. 📁 \`${name}\`\n   ${this._t('project_chats_label', { count: r.chat_count })}, ${ago}`;
      });

      await this._sendMessage(chatId,
        `${this._t('projects_title', { count: rows.length })}\n\n${lines.join('\n\n')}\n\n` +
        this._t('project_select_hint'));

      // Store project list in context for /project command
      const ctx = this._getContext(userId);
      ctx.projectList = rows.map(r => r.workdir);
    } catch (err) {
      await this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(err.message) }));
    }
  }

  async _cmdProject(chatId, userId, args) {
    const ctx = this._getContext(userId);

    if (args.length === 0) {
      if (ctx.projectWorkdir) {
        const name = this._escHtml(ctx.projectWorkdir.split('/').filter(Boolean).pop());
        await this._sendMessage(chatId, this._t('project_current', { name }));
      } else {
        await this._sendMessage(chatId, this._t('project_hint'));
      }
      return;
    }

    const idx = parseInt(args[0], 10) - 1;
    if (!ctx.projectList || idx < 0 || idx >= ctx.projectList.length) {
      await this._sendMessage(chatId, this._t('project_invalid'));
      return;
    }

    ctx.projectWorkdir = ctx.projectList[idx];
    ctx.sessionId = null; // reset chat context
    const name = this._escHtml(ctx.projectWorkdir.split('/').filter(Boolean).pop());
    await this._sendMessage(chatId, this._t('project_set', { name }));
  }

  async _cmdChats(chatId, userId) {
    const ctx = this._getContext(userId);
    const workdir = ctx.projectWorkdir;

    try {
      let rows;
      if (workdir) {
        rows = this.db.prepare(`
          SELECT s.id, s.title, s.updated_at, s.model, s.mode,
                 COUNT(m.id) as msg_count
          FROM sessions s
          LEFT JOIN messages m ON m.session_id = s.id
          WHERE s.workdir = ?
          GROUP BY s.id
          ORDER BY s.updated_at DESC
          LIMIT 15
        `).all(workdir);
      } else {
        rows = this.db.prepare(`
          SELECT s.id, s.title, s.updated_at, s.model, s.mode,
                 COUNT(m.id) as msg_count
          FROM sessions s
          LEFT JOIN messages m ON m.session_id = s.id
          GROUP BY s.id
          ORDER BY s.updated_at DESC
          LIMIT 15
        `).all();
      }

      if (rows.length === 0) {
        await this._sendMessage(chatId, this._t('chats_empty'));
        return;
      }

      const lines = rows.map((r, i) => {
        const ago = this._timeAgo(r.updated_at);
        const title = (r.title || this._t('chat_untitled')).substring(0, 40);
        return `${i + 1}. 💬 ${this._escHtml(title)}\n   ${this._t('chat_messages', { count: r.msg_count })}, ${ago}`;
      });

      const header = workdir
        ? this._t('chats_title_project', { project: this._escHtml(workdir.split('/').filter(Boolean).pop()) })
        : this._t('chats_title_all');

      await this._sendMessage(chatId,
        `${header} (${rows.length})\n\n${lines.join('\n\n')}\n\n` +
        this._t('chat_select_hint'));

      ctx.chatList = rows.map(r => r.id);
    } catch (err) {
      await this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(err.message) }));
    }
  }

  async _cmdChat(chatId, userId, args) {
    const ctx = this._getContext(userId);

    if (args.length === 0) {
      if (ctx.sessionId) {
        const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
        await this._sendMessage(chatId, this._t('chat_active', { title: this._escHtml(sess?.title || ctx.sessionId) }));
      } else {
        await this._sendMessage(chatId, this._t('chat_hint'));
      }
      return;
    }

    const idx = parseInt(args[0], 10) - 1;
    if (!ctx.chatList || idx < 0 || idx >= ctx.chatList.length) {
      await this._sendMessage(chatId, this._t('chat_invalid'));
      return;
    }

    ctx.sessionId = ctx.chatList[idx];

    // Show last 3 messages
    await this._showMessages(chatId, ctx.sessionId, 3);
  }

  async _cmdLast(chatId, userId, args) {
    const ctx = this._getContext(userId);
    if (!ctx.sessionId) {
      await this._sendMessage(chatId, this._t('select_chat_hint'));
      return;
    }

    const n = Math.min(parseInt(args[0], 10) || 5, 20);
    await this._showMessages(chatId, ctx.sessionId, n);
  }

  async _cmdFull(chatId, userId) {
    const ctx = this._getContext(userId);
    if (!ctx.sessionId) {
      await this._sendMessage(chatId, this._t('select_chat_first'));
      return;
    }

    try {
      const lastMsg = this.db.prepare(`
        SELECT content FROM messages
        WHERE session_id = ? AND role = 'assistant' AND type = 'text'
        ORDER BY id DESC LIMIT 1
      `).get(ctx.sessionId);

      if (!lastMsg) {
        await this._sendMessage(chatId, this._t('no_responses'));
        return;
      }

      const sanitized = this._sanitize(lastMsg.content);

      // Split into multiple messages if too long
      const chunks = this._chunkForTelegram(sanitized, MAX_MESSAGE_LENGTH - 100);
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `📄 <i>(${i + 1}/${chunks.length})</i>\n\n` : '';
        await this._sendMessage(chatId, prefix + chunks[i]);
      }
    } catch (err) {
      await this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(err.message) }));
    }
  }

  async _cmdStatus(chatId) {
    try {
      const sessionCount = this.db.prepare('SELECT COUNT(*) as n FROM sessions').get().n;
      const messageCount = this.db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
      const taskCount = this.db.prepare('SELECT COUNT(*) as n FROM tasks').get().n;
      const tasksByStatus = this.db.prepare(`
        SELECT status, COUNT(*) as n FROM tasks GROUP BY status
      `).all();

      const devices = this._stmts.getAllDevices.all();
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);

      let taskStatusLine = '';
      if (tasksByStatus.length > 0) {
        const icons = { backlog: '📋', todo: '📝', in_progress: '🔄', done: '✅', blocked: '🚫' };
        taskStatusLine = tasksByStatus.map(t => `${icons[t.status] || '•'} ${t.status}: ${t.n}`).join('\n');
      }

      await this._sendMessage(chatId,
        this._t('status_title') + '\n\n' +
        this._t('status_uptime', { hours, mins }) + '\n' +
        this._t('status_sessions', { count: sessionCount }) + '\n' +
        this._t('status_messages', { count: messageCount }) + '\n' +
        this._t('status_tasks_count', { count: taskCount }) + '\n' +
        (taskStatusLine ? `\n${this._t('status_tasks_heading')}\n${taskStatusLine}\n` : '') +
        '\n' + this._t('status_devices', { count: devices.length }) + '\n' +
        this._t('status_new_conn', { status: this._acceptNewConnections ? this._t('status_conn_on') : this._t('status_conn_off') }));
    } catch (err) {
      await this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(err.message) }));
    }
  }

  async _cmdTasks(chatId, userId) {
    try {
      const ctx = this._getContext(userId);
      const workdir = ctx.projectWorkdir;

      let rows;
      if (workdir) {
        rows = this.db.prepare(`
          SELECT id, title, status, updated_at FROM tasks
          WHERE workdir = ? ORDER BY sort_order ASC, created_at ASC LIMIT 20
        `).all(workdir);
      } else {
        rows = this.db.prepare(`
          SELECT id, title, status, updated_at FROM tasks
          ORDER BY sort_order ASC, created_at ASC LIMIT 20
        `).all();
      }

      if (rows.length === 0) {
        await this._sendMessage(chatId, this._t('tasks_empty'));
        return;
      }

      const icons = { backlog: '📋', todo: '📝', in_progress: '🔄', done: '✅', blocked: '🚫' };
      const lines = rows.map(r => {
        const icon = icons[r.status] || '•';
        const title = (r.title || this._t('chat_untitled')).substring(0, 50);
        return `${icon} ${this._escHtml(title)}`;
      });

      await this._sendMessage(chatId,
        `${this._t('tasks_title', { count: rows.length })}\n\n${lines.join('\n')}`);
    } catch (err) {
      await this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(err.message) }));
    }
  }

  async _cmdFiles(chatId, userId, args) {
    const ctx = this._getContext(userId);
    const fs = require('fs');
    const pathMod = require('path');

    const baseDir = ctx.projectWorkdir || process.env.WORKDIR || pathMod.join(process.cwd(), 'workspace');
    const subPath = args.join(' ') || '';
    const targetDir = pathMod.resolve(baseDir, subPath);

    // Security: ensure path is within workspace
    if (!targetDir.startsWith(baseDir)) {
      await this._sendMessage(chatId, this._t('files_denied_workspace'));
      return;
    }

    try {
      const items = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(d => !d.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 30);

      if (items.length === 0) {
        await this._sendMessage(chatId, this._t('files_empty_dir'));
        return;
      }

      const lines = items.map(d => {
        const icon = d.isDirectory() ? '📁' : '📄';
        return `${icon} <code>${this._escHtml(d.name)}</code>`;
      });

      const relPath = subPath || '.';
      await this._sendMessage(chatId,
        `📂 <b>${this._escHtml(relPath)}</b>\n\n${lines.join('\n')}`);
    } catch (err) {
      await this._sendMessage(chatId, `❌ ${this._escHtml(err.message)}`);
    }
  }

  async _cmdCat(chatId, userId, args) {
    const ctx = this._getContext(userId);
    const fs = require('fs');
    const pathMod = require('path');

    if (args.length === 0) {
      await this._sendMessage(chatId, this._t('cat_usage'));
      return;
    }

    const baseDir = ctx.projectWorkdir || process.env.WORKDIR || pathMod.join(process.cwd(), 'workspace');
    const filePath = pathMod.resolve(baseDir, args.join(' '));

    // Security: path traversal check
    if (!filePath.startsWith(baseDir)) {
      await this._sendMessage(chatId, this._t('files_denied'));
      return;
    }

    // Security: sensitive file check
    if (this._isSensitiveFile(filePath)) {
      await this._sendMessage(chatId, this._t('files_sensitive'));
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const sanitized = this._sanitize(content);
      const ext = pathMod.extname(filePath).slice(1) || 'txt';
      const name = pathMod.basename(filePath);

      if (sanitized.length > MAX_MESSAGE_LENGTH - 200) {
        const truncated = sanitized.substring(0, MAX_MESSAGE_LENGTH - 200);
        await this._sendMessage(chatId,
          `📄 <b>${this._escHtml(name)}</b>\n\n<pre><code class="language-${ext}">${this._escHtml(truncated)}</code></pre>\n\n${this._t('files_truncated', { len: content.length })}`);
      } else {
        await this._sendMessage(chatId,
          `📄 <b>${this._escHtml(name)}</b>\n\n<pre><code class="language-${ext}">${this._escHtml(sanitized)}</code></pre>`);
      }
    } catch (err) {
      await this._sendMessage(chatId, `❌ ${this._escHtml(err.message)}`);
    }
  }

  async _cmdDiff(chatId, userId) {
    const ctx = this._getContext(userId);
    const { execSync } = require('child_process');

    const workdir = ctx.projectWorkdir || process.env.WORKDIR || require('path').join(process.cwd(), 'workspace');

    try {
      const diff = execSync('git diff --stat HEAD 2>/dev/null || echo "Not a git repository"', {
        cwd: workdir, encoding: 'utf-8', timeout: 5000,
      }).trim();

      if (!diff || diff === 'Not a git repository') {
        await this._sendMessage(chatId, this._t('git_no_changes'));
        return;
      }

      await this._sendMessage(chatId,
        `📊 <b>Git Diff</b>\n\n<pre><code>${this._escHtml(this._sanitize(diff))}</code></pre>`);
    } catch (err) {
      await this._sendMessage(chatId, `❌ ${this._escHtml(err.message)}`);
    }
  }

  async _cmdLog(chatId, userId, args) {
    const ctx = this._getContext(userId);
    const { execSync } = require('child_process');

    const n = Math.min(parseInt(args[0], 10) || 5, 15);
    const workdir = ctx.projectWorkdir || process.env.WORKDIR || require('path').join(process.cwd(), 'workspace');

    try {
      const log = execSync(`git log --oneline -${n} 2>/dev/null || echo "Not a git repository"`, {
        cwd: workdir, encoding: 'utf-8', timeout: 5000,
      }).trim();

      if (!log || log === 'Not a git repository') {
        await this._sendMessage(chatId, this._t('git_not_repo'));
        return;
      }

      await this._sendMessage(chatId,
        `${this._t('git_last_commits', { n })}\n\n<pre><code>${this._escHtml(log)}</code></pre>`);
    } catch (err) {
      await this._sendMessage(chatId, `❌ ${this._escHtml(err.message)}`);
    }
  }

  async _cmdNotify(chatId, userId, args) {
    const val = args[0]?.toLowerCase();
    if (val === 'on' || val === 'off') {
      this._stmts.updateNotifications.run(val === 'on' ? 1 : 0, userId);
      await this._sendMessage(chatId,
        val === 'on' ? this._t('notify_on') : this._t('notify_off'));
    } else {
      const device = this._stmts.getDevice.get(userId);
      const current = device?.notifications_enabled ? this._t('status_conn_on') : this._t('status_conn_off');
      await this._sendMessage(chatId, this._t('notify_current', { status: current }));
    }
  }

  async _cmdBack(chatId, userId) {
    const ctx = this._getContext(userId);
    if (ctx.sessionId) {
      ctx.sessionId = null;
      await this._sendMessage(chatId, this._t('back_to_chats'));
    } else if (ctx.projectWorkdir) {
      ctx.projectWorkdir = null;
      ctx.chatList = null;
      await this._sendMessage(chatId, this._t('back_to_projects'));
    } else {
      await this._sendMessage(chatId, this._t('back_at_top'));
    }
  }

  async _cmdUnlink(chatId, userId) {
    this._stmts.removeByUserId.run(userId);
    this._userContext.delete(userId);

    await this._sendMessage(chatId, this._t('unlink_done'));

    this.emit('device_removed', { telegram_user_id: userId });
  }

  // ─── Text Messages (Send to Chat) ─────────────────────────────────────────

  async _handleTextMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const ctx = this._getContext(userId);

    // Reset compose mode after sending
    if (ctx.composing) {
      ctx.composing = false;
    }

    if (!ctx.sessionId) {
      await this._sendMessage(chatId, this._t('compose_select_first'));
      return;
    }

    // Collect any pending attachments
    const attachments = ctx.pendingAttachments || [];
    ctx.pendingAttachments = []; // Clear after use

    // Emit event for server.js to handle (send message to Claude)
    this.emit('send_message', {
      sessionId: ctx.sessionId,
      text: msg.text,
      userId,
      chatId,
      attachments,
      callback: async (result) => {
        if (result.error) {
          await this._sendMessage(chatId, `❌ ${result.error}`);
        } else {
          const attachNote = attachments.length > 0 ? ` (+ ${attachments.length} file${attachments.length > 1 ? 's' : ''})` : '';
          await this._sendMessage(chatId, this._t('compose_sent', { note: attachNote }));
        }
      },
    });

    // Persist context after sending
    this._saveDeviceContext(userId);
  }

  // ─── Notifications (called from server.js) ────────────────────────────────

  /**
   * Send a notification to all paired devices with notifications enabled.
   * @param {string} text - HTML-formatted message
   */
  async notifyAll(text) {
    if (!this.running) return;
    const devices = this._stmts.getAllDevices.all().filter(d => d.notifications_enabled);

    for (const device of devices) {
      try {
        await this._sendMessage(device.telegram_chat_id, text);
      } catch (err) {
        this.log.warn(`[telegram] Failed to notify ${device.display_name}: ${err.message}`);
      }
    }
  }

  /**
   * Send a notification to a specific user.
   */
  async notifyUser(userId, text) {
    if (!this.running) return;
    const device = this._stmts.getDevice.get(userId);
    if (!device || !device.notifications_enabled) return;

    try {
      await this._sendMessage(device.telegram_chat_id, text);
    } catch (err) {
      this.log.warn(`[telegram] Failed to notify ${device.display_name}: ${err.message}`);
    }
  }

  // ─── Device Management ────────────────────────────────────────────────────

  getDevices() {
    return this._stmts.getAllDevices.all();
  }

  removeDevice(id) {
    const device = this._stmts.getDeviceById.get(id);
    if (!device) return false;

    this._stmts.removeDevice.run(id);
    this._userContext.delete(device.telegram_user_id);
    this.emit('device_removed', { telegram_user_id: device.telegram_user_id, id });

    // Notify the user their device was unlinked
    this._sendMessage(device.telegram_chat_id, this._t('unlink_admin')).catch(() => {});

    return true;
  }

  // ─── Inline Keyboard Navigation ───────────────────────────────────────────

  async _handleCallback(cbq) {
    const userId = cbq.from.id;
    const chatId = cbq.message?.chat?.id;
    const msgId = cbq.message?.message_id;
    const data = cbq.data || '';

    // Always answer to remove spinner
    this._answerCallback(cbq.id);

    if (!chatId || !this._isAuthorized(userId)) return;
    if (!this._checkRateLimit(userId)) return;
    this._stmts.updateLastActive.run(userId);

    // Update screen reference
    const ctx = this._getContext(userId);
    ctx.screenMsgId = msgId;
    ctx.screenChatId = chatId;

    try {
      // Route by prefix
      if (data === 'm:menu')       return this._screenMainMenu(chatId, userId);
      if (data === 'm:status')     return this._screenStatus(chatId, userId);
      if (data === 'm:noop')       return;
      if (data === 'p:list' || data.startsWith('p:list:')) return this._screenProjects(chatId, userId, data);
      if (data.startsWith('p:sel:'))  return this._screenProjectSelect(chatId, userId, data);
      if (data.startsWith('pm:'))     return this._routeProjectMenu(chatId, userId, data);
      if (data.startsWith('c:list:')) return this._screenChats(chatId, userId, data);
      if (data.startsWith('ch:'))     return this._screenChatSelect(chatId, userId, data);
      if (data.startsWith('cm:'))     return this._routeChatMenu(chatId, userId, data);
      if (data.startsWith('d:'))      return this._routeDialog(chatId, userId, data);
      if (data.startsWith('f:'))      return this._screenFiles(chatId, userId, data);
      if (data === 't:list' || data === 't:all') return this._screenTasks(chatId, userId, data);
      if (data === 's:menu')       return this._screenSettings(chatId, userId);
      if (data.startsWith('s:'))   return this._routeSettings(chatId, userId, data);
    } catch (err) {
      this.log.error(`[telegram] Callback error: ${err.message}`);
      await this._editScreen(chatId, msgId, this._t('error_prefix', { msg: this._escHtml(err.message) }), [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
    }
  }

  // ─── Screens ─────────────────────────────────────────────────────────────

  async _screenMainMenu(chatId, userId) {
    const ctx = this._getContext(userId);
    const lines = [this._t('main_title') + '\n'];

    if (ctx.projectWorkdir) {
      const pName = this._escHtml(ctx.projectWorkdir.split('/').filter(Boolean).pop());
      lines.push(this._t('main_project', { name: pName }));
    }
    if (ctx.sessionId) {
      const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
      if (sess) lines.push(this._t('main_chat', { title: this._escHtml((sess.title||'').substring(0,30)) }));
    }
    lines.push(this._t('main_choose'));

    const keyboard = [
      [{ text: this._t('btn_projects'), callback_data: 'p:list' }, { text: this._t('btn_chats'), callback_data: 'c:list:0' }],
      [{ text: this._t('btn_tasks'), callback_data: 't:list' }, { text: this._t('btn_status'), callback_data: 'm:status' }],
      [{ text: this._t('btn_settings'), callback_data: 's:menu' }],
    ];

    if (ctx.screenMsgId && ctx.screenChatId === chatId) {
      await this._editScreen(chatId, ctx.screenMsgId, lines.join('\n'), keyboard);
    } else {
      await this._showScreen(chatId, userId, lines.join('\n'), keyboard);
    }
  }

  async _screenProjects(chatId, userId, data) {
    const page = parseInt(data.split(':')[2] || '0', 10) || 0;
    const perPage = 5;
    const ctx = this._getContext(userId);

    try {
      const rows = this.db.prepare(`
        SELECT workdir, COUNT(*) as chat_count, MAX(updated_at) as last_active
        FROM sessions WHERE workdir IS NOT NULL AND workdir != ''
        GROUP BY workdir ORDER BY last_active DESC LIMIT 30
      `).all();

      ctx.projectList = rows.map(r => r.workdir);

      if (rows.length === 0) {
        return this._editScreen(chatId, ctx.screenMsgId, this._t('projects_empty'),
          [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
      }

      const totalPages = Math.ceil(rows.length / perPage);
      const pageRows = rows.slice(page * perPage, (page + 1) * perPage);

      const keyboard = pageRows.map((r, i) => {
        const idx = page * perPage + i;
        const name = r.workdir.split('/').filter(Boolean).pop() || '...';
        const label = `📁 ${name}  ·  ${this._t('project_chats_label', { count: r.chat_count })}  ·  ${this._timeAgo(r.last_active)}`;
        return [{ text: label.substring(0, 60), callback_data: `p:sel:${idx}` }];
      });

      // Pagination row
      if (totalPages > 1) {
        const navRow = [];
        if (page > 0) navRow.push({ text: this._t('btn_back'), callback_data: `p:list:${page-1}` });
        navRow.push({ text: `${page+1}/${totalPages}`, callback_data: 'm:noop' });
        if (page < totalPages - 1) navRow.push({ text: this._t('btn_next'), callback_data: `p:list:${page+1}` });
        keyboard.push(navRow);
      }

      keyboard.push([{ text: this._t('btn_main_menu'), callback_data: 'm:menu' }]);

      await this._editScreen(chatId, ctx.screenMsgId, this._t('projects_title', { count: rows.length }), keyboard);
    } catch (err) {
      await this._editScreen(chatId, ctx.screenMsgId, `❌ ${this._escHtml(err.message)}`,
        [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
    }
  }

  async _screenProjectSelect(chatId, userId, data) {
    const idx = parseInt(data.split(':')[2], 10);
    const ctx = this._getContext(userId);

    if (!ctx.projectList || idx < 0 || idx >= ctx.projectList.length) {
      return this._editScreen(chatId, ctx.screenMsgId, this._t('project_not_found'),
        [[{ text: this._t('btn_back_projects'), callback_data: 'p:list' }]]);
    }

    ctx.projectWorkdir = ctx.projectList[idx];
    ctx.sessionId = null;
    ctx.chatPage = 0;
    const name = ctx.projectWorkdir.split('/').filter(Boolean).pop();

    const keyboard = [
      [{ text: this._t('btn_chats'), callback_data: 'c:list:0' }, { text: '📁 Files', callback_data: 'f:.' }],
      [{ text: '📜 Git Log', callback_data: 'pm:git' }, { text: '📊 Diff', callback_data: 'pm:diff' }],
      [{ text: this._t('btn_tasks'), callback_data: 't:list' }],
      [{ text: this._t('btn_back_projects'), callback_data: 'p:list' }],
    ];

    await this._editScreen(chatId, ctx.screenMsgId, `📁 <b>${this._escHtml(name)}</b>${this._t('project_choose')}`, keyboard);
  }

  async _routeProjectMenu(chatId, userId, data) {
    const action = data.split(':')[1];
    const ctx = this._getContext(userId);

    if (action === 'git') {
      // Send git log as NEW message, keep screen
      await this._cmdLog(chatId, userId, ['5']);
    } else if (action === 'diff') {
      await this._cmdDiff(chatId, userId);
    } else if (action === 'back') {
      return this._screenProjects(chatId, userId, 'p:list:0');
    }
  }

  async _screenChats(chatId, userId, data) {
    const page = parseInt(data.split(':')[2] || '0', 10) || 0;
    const perPage = 5;
    const ctx = this._getContext(userId);
    const workdir = ctx.projectWorkdir;

    try {
      let rows;
      if (workdir) {
        rows = this.db.prepare(`
          SELECT s.id, s.title, s.updated_at, COUNT(m.id) as msg_count
          FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
          WHERE s.workdir = ? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 50
        `).all(workdir);
      } else {
        rows = this.db.prepare(`
          SELECT s.id, s.title, s.updated_at, COUNT(m.id) as msg_count
          FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
          GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 50
        `).all();
      }

      ctx.chatList = rows.map(r => r.id);

      if (rows.length === 0) {
        const backBtn = workdir ? 'pm:back' : 'm:menu';
        return this._editScreen(chatId, ctx.screenMsgId, this._t('chats_empty'),
          [[{ text: this._t('btn_back'), callback_data: backBtn }]]);
      }

      const totalPages = Math.ceil(rows.length / perPage);
      const pageRows = rows.slice(page * perPage, (page + 1) * perPage);

      const header = workdir
        ? this._t('chats_title_project', { project: this._escHtml(workdir.split('/').filter(Boolean).pop()) })
        : this._t('chats_title_all');

      const keyboard = pageRows.map((r, i) => {
        const globalIdx = page * perPage + i;
        const title = (r.title || this._t('chat_untitled')).substring(0, 35);
        const ago = this._timeAgo(r.updated_at);
        return [{ text: `💬 ${title}  ·  ${r.msg_count}  ·  ${ago}`, callback_data: `ch:${globalIdx}` }];
      });

      if (totalPages > 1) {
        const navRow = [];
        if (page > 0) navRow.push({ text: this._t('btn_back'), callback_data: `c:list:${page-1}` });
        navRow.push({ text: `${page+1}/${totalPages}`, callback_data: 'm:noop' });
        if (page < totalPages - 1) navRow.push({ text: this._t('btn_next'), callback_data: `c:list:${page+1}` });
        keyboard.push(navRow);
      }

      const backBtn = workdir ? 'pm:back' : 'm:menu';
      keyboard.push([{ text: this._t('btn_back'), callback_data: backBtn }]);

      await this._editScreen(chatId, ctx.screenMsgId, `${header} (${rows.length})`, keyboard);
    } catch (err) {
      await this._editScreen(chatId, ctx.screenMsgId, `❌ ${this._escHtml(err.message)}`,
        [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
    }
  }

  async _screenChatSelect(chatId, userId, data) {
    const idx = parseInt(data.split(':')[1], 10);
    const ctx = this._getContext(userId);

    if (!ctx.chatList || idx < 0 || idx >= ctx.chatList.length) {
      return this._editScreen(chatId, ctx.screenMsgId, this._t('chat_not_found'),
        [[{ text: this._t('btn_back_chats'), callback_data: 'c:list:0' }]]);
    }

    ctx.sessionId = ctx.chatList[idx];
    ctx.dialogPage = 0;
    this._saveDeviceContext(userId);
    return this._screenDialog(chatId, userId);
  }

  async _screenDialog(chatId, userId, { mode = 'overview' } = {}) {
    const ctx = this._getContext(userId);
    const sid = ctx.sessionId;
    if (!sid) return this._screenChats(chatId, userId, 'c:list:0');

    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!session) {
      return this._editScreen(chatId, ctx.screenMsgId, this._t('session_not_found'),
        [[{ text: this._t('btn_back_chats'), callback_data: 'c:list:0' }]]);
    }

    // Get all non-tool messages
    const allMsgs = this.db.prepare(
      "SELECT * FROM messages WHERE session_id = ? AND type != 'tool' ORDER BY created_at ASC"
    ).all(sid);

    // Build context info
    const title = session.title || 'Untitled';
    const projectName = (session.workdir || ctx.projectWorkdir || '').split('/').filter(Boolean).pop() || '';
    const projectLine = projectName ? `📁 ${this._escHtml(projectName)} → ` : '';

    // Delete old screen message
    if (ctx.screenMsgId && ctx.screenChatId === chatId) {
      try {
        await this._callApi('deleteMessage', { chat_id: chatId, message_id: ctx.screenMsgId });
      } catch (e) { /* ignore */ }
      ctx.screenMsgId = null;
    }

    if (mode === 'all') {
      // ── Full paginated view ──
      return this._screenDialogFull(chatId, userId, allMsgs, { title, projectLine });
    }

    // ── Overview mode: first msg + ... + last question + last answer ──

    // Select which messages to show
    const showMsgs = [];

    if (allMsgs.length <= 4) {
      // Few messages — show all, no separator
      showMsgs.push(...allMsgs.map(m => ({ msg: m })));
    } else {
      // First message
      showMsgs.push({ msg: allMsgs[0] });

      // Separator
      const skipped = allMsgs.length - 3; // first + last user + last assistant
      showMsgs.push({ separator: true, count: skipped });

      // Find last user message and last assistant message
      let lastUser = null, lastAssistant = null;
      for (let i = allMsgs.length - 1; i >= 1; i--) {
        if (!lastAssistant && allMsgs[i].role === 'assistant') lastAssistant = allMsgs[i];
        if (!lastUser && allMsgs[i].role === 'user') lastUser = allMsgs[i];
        if (lastUser && lastAssistant) break;
      }

      if (lastUser) showMsgs.push({ msg: lastUser });
      if (lastAssistant) showMsgs.push({ msg: lastAssistant });
    }

    // ── Header ──
    const headerLines = [
      `${projectLine}💬 <b>${this._escHtml(title)}</b>`,
      `${'─'.repeat(25)}`,
      this._t('dialog_messages', { count: allMsgs.length }),
    ];
    await this._sendMessage(chatId, headerLines.join('\n'), { parse_mode: 'HTML' }).catch(() =>
      this._sendMessage(chatId, headerLines.join('\n').replace(/<[^>]+>/g, ''))
    );

    // ── Bubbles ──
    for (const item of showMsgs) {
      if (item.separator) {
        await this._sendMessage(chatId, this._t('dialog_separator', { count: item.count }), { parse_mode: 'HTML' });
        continue;
      }

      await this._sendBubble(chatId, item.msg);
    }

    // ── Footer ──
    const footerText = `${projectLine}💬 <b>${this._escHtml(title)}</b>`;

    const keyboard = [
      [{ text: this._t('btn_write'), callback_data: 'cm:compose' }, { text: this._t('btn_all_messages'), callback_data: 'd:all:0' }],
      [{ text: '🔄', callback_data: 'd:overview' }, { text: this._t('btn_back_chats'), callback_data: 'c:list:0' }, { text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ];

    await this._showScreen(chatId, userId, footerText, keyboard);
  }

  async _screenDialogFull(chatId, userId, allMsgs, { title, projectLine }) {
    const ctx = this._getContext(userId);

    const PAGE_SIZE = 5;
    const totalPages = Math.max(1, Math.ceil(allMsgs.length / PAGE_SIZE));
    const page = Math.min(ctx.dialogPage || 0, totalPages - 1);
    const offset = page * PAGE_SIZE;
    const msgs = allMsgs.slice(offset, offset + PAGE_SIZE);

    // ── Header ──
    const headerLines = [
      `${projectLine}💬 <b>${this._escHtml(title)}</b>`,
      `${'─'.repeat(25)}`,
      this._t('dialog_page', { count: allMsgs.length, page: page + 1, total: totalPages }),
    ];
    await this._sendMessage(chatId, headerLines.join('\n'), { parse_mode: 'HTML' }).catch(() =>
      this._sendMessage(chatId, headerLines.join('\n').replace(/<[^>]+>/g, ''))
    );

    // ── Bubbles ──
    for (const msg of msgs) {
      await this._sendBubble(chatId, msg);
    }

    // ── Footer ──
    const footerText = this._t('dialog_page_short', { page: page + 1, total: totalPages, count: allMsgs.length });

    const navRow = [];
    if (page > 0) navRow.push({ text: '⬅️', callback_data: `d:all:${page - 1}` });
    navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'm:noop' });
    if (page < totalPages - 1) navRow.push({ text: '➡️', callback_data: `d:all:${page + 1}` });

    const keyboard = [
      navRow,
      [{ text: this._t('btn_write'), callback_data: 'cm:compose' }, { text: '🔄', callback_data: `d:all:${page}` }],
      [{ text: this._t('btn_back_overview'), callback_data: 'd:overview' }, { text: this._t('btn_back_chats'), callback_data: 'c:list:0' }, { text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ];

    await this._showScreen(chatId, userId, footerText, keyboard);
  }

  async _sendBubble(chatId, msg) {
    const icon = msg.role === 'user' ? '👤' : '🤖';
    const time = new Date(msg.created_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    const source = msg.source === 'telegram' ? ' 📱' : '';

    let content = msg.content || '';
    content = this._sanitize(content);
    content = this._mdToHtml(content);

    let truncated = false;
    if (content.length > 3500) {
      content = content.slice(0, 3500) + '\n\n<i>' + this._t('dialog_truncated') + '</i>';
      truncated = true;
    }

    const formatted = `${icon} <b>${this._escHtml(msg.role)}</b>${source} | ${time}\n\n${content}`;

    const msgKeyboard = truncated ? {
      inline_keyboard: [[{ text: this._t('btn_full_msg'), callback_data: `d:full:${msg.id}` }]]
    } : undefined;

    await this._sendMessage(chatId, formatted.slice(0, 4096), {
      parse_mode: 'HTML',
      reply_markup: msgKeyboard ? JSON.stringify(msgKeyboard) : undefined,
    }).catch(() => {
      return this._sendMessage(chatId, formatted.replace(/<[^>]+>/g, '').slice(0, 4096), {
        reply_markup: msgKeyboard ? JSON.stringify(msgKeyboard) : undefined,
      });
    });
  }

  async _showFullMessage(chatId, msgId) {
    const msg = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    if (!msg) return this._sendMessage(chatId, '❌ Message not found');

    const icon = msg.role === 'user' ? '👤' : '🤖';
    let content = this._sanitize(msg.content || '');
    content = this._mdToHtml(content);

    const chunks = this._chunkForTelegram(`${icon} <b>${this._escHtml(msg.role)}</b>\n\n${content}`, MAX_MESSAGE_LENGTH - 100);
    for (const chunk of chunks) {
      await this._sendMessage(chatId, chunk, { parse_mode: 'HTML' }).catch(() => {
        return this._sendMessage(chatId, chunk.replace(/<[^>]+>/g, ''));
      });
    }
  }

  async _routeDialog(chatId, userId, data) {
    const ctx = this._getContext(userId);

    // Overview mode (default entry / back from full view)
    if (data === 'd:overview') {
      ctx.dialogPage = 0;
      return this._screenDialog(chatId, userId, { mode: 'overview' });
    }

    // Full paginated view
    if (data.startsWith('d:all:')) {
      const page = parseInt(data.split(':')[2]) || 0;
      ctx.dialogPage = page;
      return this._screenDialog(chatId, userId, { mode: 'all' });
    }

    // Legacy pagination (kept for compatibility)
    if (data.startsWith('d:page:')) {
      const page = parseInt(data.split(':')[2]) || 0;
      ctx.dialogPage = page;
      return this._screenDialog(chatId, userId, { mode: 'all' });
    }

    // Show full message
    if (data.startsWith('d:full:')) {
      const msgId = parseInt(data.split(':')[2]);
      return this._showFullMessage(chatId, msgId);
    }

    // Clear pending attachments
    if (data === 'd:clear_attach') {
      ctx.pendingAttachments = [];
      return this._sendMessage(chatId, this._t('attach_cleared'));
    }

    // View session dialog (from notifications)
    if (data.startsWith('d:view:')) {
      const sid = data.split(':')[2];
      ctx.sessionId = sid;
      ctx.dialogPage = 0;
      this._saveDeviceContext(userId);
      return this._screenDialog(chatId, userId, { mode: 'overview' });
    }

    // Compose in session
    if (data.startsWith('d:compose:')) {
      const sid = data.split(':')[2];
      ctx.sessionId = sid;
      ctx.composing = true;
      this._saveDeviceContext(userId);
      return this._sendMessage(chatId, '📝 Send your message:');
    }
  }

  async _routeChatMenu(chatId, userId, data) {
    const action = data.split(':')[1];
    const ctx = this._getContext(userId);

    if (action === 'more') {
      if (!ctx.sessionId) return;
      const offset = (ctx.chatOffset || 3) + 3;
      ctx.chatOffset = offset;

      const msgs = this.db.prepare(`
        SELECT role, content FROM messages
        WHERE session_id = ? AND (type IS NULL OR type != 'tool')
        ORDER BY id DESC LIMIT ?
      `).all(ctx.sessionId, offset).reverse();

      const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(ctx.sessionId);
      const title = sess?.title || this._t('chat_untitled');

      let text = `💬 <b>${this._escHtml(title)}</b> (${this._t('chat_messages', { count: msgs.length })})\n${'─'.repeat(20)}\n\n`;
      text += msgs.map(r => {
        const icon = r.role === 'user' ? '👤' : '🤖';
        const content = this._escHtml(this._sanitize(r.content || '').substring(0, 200));
        const trunc = (r.content?.length || 0) > 200 ? '...' : '';
        return `${icon} ${content}${trunc}`;
      }).join('\n\n');

      const keyboard = [
        [{ text: this._t('btn_more'), callback_data: 'cm:more' }, { text: this._t('btn_full_response'), callback_data: 'cm:full' }],
        [{ text: this._t('btn_write_chat'), callback_data: 'cm:compose' }],
        [{ text: this._t('btn_back_chats'), callback_data: 'c:list:0' }],
      ];

      await this._editScreen(chatId, ctx.screenMsgId, text, keyboard);

    } else if (action === 'full') {
      // Send as new message, keep screen
      await this._cmdFull(chatId, userId);

    } else if (action === 'compose') {
      ctx.composing = true;
      await this._editScreen(chatId, ctx.screenMsgId,
        this._t('compose_mode'),
        [[{ text: this._t('btn_cancel'), callback_data: 'cm:cancel' }]]
      );

    } else if (action === 'cancel') {
      ctx.composing = false;
      ctx.pendingAttachments = [];
      // Re-show dialog overview
      if (ctx.sessionId) {
        return this._screenDialog(chatId, userId, { mode: 'overview' });
      }
      return this._screenMainMenu(chatId, userId);

    } else if (action === 'back') {
      return this._screenChats(chatId, userId, 'c:list:0');
    }
  }

  async _screenFiles(chatId, userId, data) {
    const ctx = this._getContext(userId);
    const fs = require('fs');
    const pathMod = require('path');

    const baseDir = ctx.projectWorkdir || process.env.WORKDIR || pathMod.join(process.cwd(), 'workspace');

    let subPath;
    if (data.startsWith('f:c:')) {
      // Cached path lookup for long paths
      const key = parseInt(data.split(':')[2], 10);
      subPath = ctx.filePathCache?.get(key) || '.';
    } else {
      subPath = data.substring(2) || '.'; // strip "f:" prefix
    }

    const targetDir = pathMod.resolve(baseDir, subPath);
    if (!targetDir.startsWith(baseDir)) {
      return this._editScreen(chatId, ctx.screenMsgId, this._t('files_denied'),
        [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
    }

    try {
      const stat = fs.statSync(targetDir);

      // If it's a file, show content as new message
      if (stat.isFile()) {
        if (this._isSensitiveFile(targetDir)) {
          return this._sendMessage(chatId, this._t('files_sensitive_short'));
        }
        const content = fs.readFileSync(targetDir, 'utf-8');
        const sanitized = this._sanitize(content);
        const ext = pathMod.extname(targetDir).slice(1) || 'txt';
        const name = pathMod.basename(targetDir);
        const display = sanitized.length > MAX_MESSAGE_LENGTH - 200
          ? sanitized.substring(0, MAX_MESSAGE_LENGTH - 200) + '\n\n' + this._t('files_truncated_short')
          : sanitized;
        await this._sendMessage(chatId, `📄 <b>${this._escHtml(name)}</b>\n\n<pre><code class="language-${ext}">${this._escHtml(display)}</code></pre>`);
        return; // Keep the file browser screen as is
      }

      // Directory listing
      const items = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(d => !d.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 20);

      ctx.filePath = subPath;
      if (!ctx.filePathCache) ctx.filePathCache = new Map();
      let cacheCounter = ctx.filePathCache.size;

      const keyboard = items.map(d => {
        const icon = d.isDirectory() ? '📁' : '📄';
        const rel = pathMod.join(subPath, d.name);
        let cbData;
        if (rel.length <= 61) { // 64 - "f:" prefix - margin
          cbData = `f:${rel}`;
        } else {
          cacheCounter++;
          ctx.filePathCache.set(cacheCounter, rel);
          cbData = `f:c:${cacheCounter}`;
        }
        return [{ text: `${icon} ${d.name}`, callback_data: cbData }];
      });

      // Parent directory button (if not at root)
      if (subPath !== '.' && subPath !== '') {
        const parent = pathMod.dirname(subPath);
        const parentCb = parent.length <= 61 ? `f:${parent || '.'}` : (() => {
          cacheCounter++;
          ctx.filePathCache.set(cacheCounter, parent);
          return `f:c:${cacheCounter}`;
        })();
        keyboard.push([{ text: this._t('btn_parent_dir'), callback_data: parentCb }]);
      }

      const backBtn = ctx.projectWorkdir ? 'pm:back' : 'm:menu';
      keyboard.push([{ text: this._t('btn_back'), callback_data: backBtn }]);

      const relDisplay = subPath === '.' ? '/' : subPath;
      const text = items.length > 0
        ? `📂 <b>${this._escHtml(relDisplay)}</b>`
        : `📂 <b>${this._escHtml(relDisplay)}</b>\n\n${this._t('files_empty_label')}`;

      await this._editScreen(chatId, ctx.screenMsgId, text, keyboard);
    } catch (err) {
      await this._editScreen(chatId, ctx.screenMsgId, `❌ ${this._escHtml(err.message)}`,
        [[{ text: this._t('btn_back'), callback_data: ctx.projectWorkdir ? 'pm:back' : 'm:menu' }]]);
    }
  }

  async _screenTasks(chatId, userId, data) {
    const ctx = this._getContext(userId);
    const showAll = data === 't:all';
    const workdir = showAll ? null : ctx.projectWorkdir;

    try {
      let rows;
      if (workdir) {
        rows = this.db.prepare(`
          SELECT title, status FROM tasks WHERE workdir = ?
          ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 WHEN 'blocked' THEN 3 WHEN 'done' THEN 4 END, sort_order ASC LIMIT 25
        `).all(workdir);
      } else {
        rows = this.db.prepare(`
          SELECT title, status FROM tasks
          ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 WHEN 'blocked' THEN 3 WHEN 'done' THEN 4 END, sort_order ASC LIMIT 25
        `).all();
      }

      if (rows.length === 0) {
        const back = ctx.projectWorkdir && !showAll ? 'pm:back' : 'm:menu';
        return this._editScreen(chatId, ctx.screenMsgId, this._t('tasks_empty'),
          [[{ text: this._t('btn_back'), callback_data: back }]]);
      }

      const icons = { backlog: '📋', todo: '📝', in_progress: '🔄', done: '✅', blocked: '🚫' };
      const grouped = {};
      for (const r of rows) {
        if (!grouped[r.status]) grouped[r.status] = [];
        grouped[r.status].push(r);
      }

      let text = `${this._t('tasks_title', { count: rows.length })}\n\n`;
      for (const [status, items] of Object.entries(grouped)) {
        text += `${icons[status] || '•'} <b>${this._escHtml(status)}</b> (${items.length})\n`;
        text += items.map(t => `  · ${this._escHtml((t.title||'').substring(0, 45))}`).join('\n') + '\n\n';
      }

      const keyboard = [];
      if (ctx.projectWorkdir && !showAll) {
        keyboard.push([{ text: this._t('btn_all_tasks'), callback_data: 't:all' }]);
      }
      const back = ctx.projectWorkdir && !showAll ? 'pm:back' : 'm:menu';
      keyboard.push([{ text: this._t('btn_back'), callback_data: back }]);

      await this._editScreen(chatId, ctx.screenMsgId, text, keyboard);
    } catch (err) {
      await this._editScreen(chatId, ctx.screenMsgId, `❌ ${this._escHtml(err.message)}`,
        [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
    }
  }

  async _screenStatus(chatId, userId) {
    const ctx = this._getContext(userId);

    try {
      const sessionCount = this.db.prepare('SELECT COUNT(*) as n FROM sessions').get().n;
      const messageCount = this.db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
      const tasksByStatus = this.db.prepare('SELECT status, COUNT(*) as n FROM tasks GROUP BY status').all();
      const devices = this._stmts.getAllDevices.all();
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);

      let text = this._t('status_title') + '\n──────────────────\n' +
        this._t('status_uptime', { hours, mins }) + '\n' +
        this._t('status_sessions', { count: sessionCount }) + '\n' +
        this._t('status_messages', { count: messageCount }) + '\n';

      if (tasksByStatus.length > 0) {
        const icons = { backlog: '📋', todo: '📝', in_progress: '🔄', done: '✅', blocked: '🚫' };
        text += '\n' + this._t('status_tasks_label') + '\n' + tasksByStatus.map(t => `  ${icons[t.status]||'•'} ${t.status}: ${t.n}`).join('\n') + '\n';
      }

      text += '\n' + this._t('status_devices_short', { count: devices.length });
      text += '\n' + this._t('status_new_conn', { status: this._acceptNewConnections ? this._t('status_conn_on') : this._t('status_conn_off') });
      text += '\n' + this._t('status_updated', { time: new Date().toLocaleTimeString() });

      const keyboard = [
        [{ text: this._t('btn_refresh'), callback_data: 'm:status' }, { text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
      ];

      await this._editScreen(chatId, ctx.screenMsgId, text, keyboard);
    } catch (err) {
      await this._editScreen(chatId, ctx.screenMsgId, `❌ ${this._escHtml(err.message)}`,
        [[{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }]]);
    }
  }

  async _screenSettings(chatId, userId) {
    const ctx = this._getContext(userId);
    const device = this._stmts.getDevice.get(userId);
    if (!device) return;

    const notif = device.notifications_enabled;
    const pairedDate = device.paired_at ? new Date(device.paired_at + 'Z').toLocaleDateString() : '—';

    let text = this._t('settings_title') + '\n\n' +
      `📱 ${this._escHtml(device.display_name)}` + (device.username ? ` · @${this._escHtml(device.username)}` : '') + '\n' +
      this._t('settings_paired', { date: pairedDate }) + '\n' +
      this._t('settings_notif', { status: notif ? this._t('status_conn_on') : this._t('status_conn_off') });

    const keyboard = [
      [{ text: notif ? this._t('btn_disable_notif') : this._t('btn_enable_notif'), callback_data: notif ? 's:notify:off' : 's:notify:on' }],
      [{ text: this._t('btn_unlink_device'), callback_data: 's:unlink' }],
      [{ text: this._t('btn_back_menu'), callback_data: 'm:menu' }],
    ];

    await this._editScreen(chatId, ctx.screenMsgId, text, keyboard);
  }

  async _routeSettings(chatId, userId, data) {
    const ctx = this._getContext(userId);

    if (data === 's:notify:on' || data === 's:notify:off') {
      const val = data === 's:notify:on' ? 1 : 0;
      this._stmts.updateNotifications.run(val, userId);
      return this._screenSettings(chatId, userId); // Re-render settings

    } else if (data === 's:unlink') {
      await this._editScreen(chatId, ctx.screenMsgId,
        this._t('settings_unlink_confirm'),
        [
          [{ text: this._t('btn_confirm_unlink'), callback_data: 's:unlink:yes' }],
          [{ text: this._t('btn_cancel'), callback_data: 's:menu' }],
        ]
      );

    } else if (data === 's:unlink:yes') {
      this._stmts.removeByUserId.run(userId);
      this._userContext.delete(userId);
      this.emit('device_removed', { telegram_user_id: userId });

      // Can't edit the screen anymore (no longer authorized), send final message
      await this._sendMessage(chatId, this._t('settings_unlinked'), {
        reply_markup: JSON.stringify({ remove_keyboard: true }),
      });
    }
  }

  // ─── Media Handling ────────────────────────────────────────────────────────

  async _handleMediaMessage(msg) {
    const userId = msg.from?.id;
    const chatId = msg.chat?.id;
    if (!userId || !chatId) return;

    const ctx = this._getContext(userId);

    try {
      let fileId, fileName, mimeType;

      if (msg.photo) {
        // Get largest photo
        const photo = msg.photo[msg.photo.length - 1];
        fileId = photo.file_id;
        fileName = `photo_${Date.now()}.jpg`;
        mimeType = 'image/jpeg';
      } else if (msg.document) {
        fileId = msg.document.file_id;
        fileName = msg.document.file_name || `file_${Date.now()}`;
        mimeType = msg.document.mime_type || 'application/octet-stream';

        // Size check (10MB limit)
        if (msg.document.file_size && msg.document.file_size > 10 * 1024 * 1024) {
          return this._sendMessage(chatId, '❌ File too large (max 10MB)');
        }
      }

      // Download file from Telegram
      const fileInfo = await this._callApi('getFile', { file_id: fileId });
      if (!fileInfo || !fileInfo.file_path) {
        return this._sendMessage(chatId, '❌ Cannot download file');
      }

      const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) {
        return this._sendMessage(chatId, '❌ Download failed');
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');

      const attachment = {
        type: mimeType,
        name: fileName,
        base64: base64,
      };

      // If there's a caption, treat it as text + attachment
      const caption = msg.caption || '';

      if (caption && ctx.sessionId) {
        // Send immediately with caption as text
        this.emit('send_message', {
          sessionId: ctx.sessionId,
          text: caption,
          userId,
          chatId,
          attachments: [attachment],
          callback: (err) => {
            if (err) this._sendMessage(chatId, `❌ ${this._escHtml(err.message || 'Send failed')}`);
          }
        });
      } else if (ctx.composing && ctx.sessionId) {
        // In compose mode, attach to pending
        ctx.pendingAttachments = ctx.pendingAttachments || [];
        ctx.pendingAttachments.push(attachment);
        await this._sendMessage(chatId,
          `📎 <b>${this._escHtml(fileName)}</b> attached (${Math.round(buffer.length / 1024)}KB)\nSend a text message to include it, or send more files.`,
          { parse_mode: 'HTML' }
        );
      } else if (ctx.sessionId) {
        // Has active session, store as pending
        ctx.pendingAttachments = ctx.pendingAttachments || [];
        ctx.pendingAttachments.push(attachment);
        await this._sendMessage(chatId,
          `📎 <b>${this._escHtml(fileName)}</b> attached\nNow send a text message with your question about this file.`,
          {
            parse_mode: 'HTML',
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: '❌ Cancel', callback_data: 'd:clear_attach' },
              ]],
            }),
          }
        );
      } else {
        await this._sendMessage(chatId, '❌ Select a chat session first, then send a file.\n\nUse 🏠 Menu → Projects → select a chat.');
      }
    } catch (err) {
      this.log.error(`[telegram] Media handling error: ${err.message}`);
      await this._sendMessage(chatId, '❌ Failed to process file');
    }
  }

  // ─── Send Files to Telegram ─────────────────────────────────────────────

  async sendDocument(chatId, buffer, fileName, opts = {}) {
    const url = `${TELEGRAM_API}${this.token}/sendDocument`;
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('document', new Blob([buffer]), fileName);
    if (opts.caption) formData.append('caption', opts.caption);
    if (opts.parse_mode) formData.append('parse_mode', opts.parse_mode);
    if (opts.reply_markup) formData.append('reply_markup', typeof opts.reply_markup === 'string' ? opts.reply_markup : JSON.stringify(opts.reply_markup));

    try {
      const res = await fetch(url, { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.ok) this.log.error(`[telegram] sendDocument error: ${data.description}`);
      return data.result;
    } catch (err) {
      this.log.error(`[telegram] sendDocument failed: ${err.message}`);
      return null;
    }
  }

  async sendPhoto(chatId, buffer, opts = {}) {
    const url = `${TELEGRAM_API}${this.token}/sendPhoto`;
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('photo', new Blob([buffer]), opts.fileName || 'photo.jpg');
    if (opts.caption) formData.append('caption', opts.caption);
    if (opts.parse_mode) formData.append('parse_mode', opts.parse_mode);
    if (opts.reply_markup) formData.append('reply_markup', typeof opts.reply_markup === 'string' ? opts.reply_markup : JSON.stringify(opts.reply_markup));

    try {
      const res = await fetch(url, { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.ok) this.log.error(`[telegram] sendPhoto error: ${data.description}`);
      return data.result;
    } catch (err) {
      this.log.error(`[telegram] sendPhoto failed: ${err.message}`);
      return null;
    }
  }

  // ─── Push Notifications ─────────────────────────────────────────────────

  async notifyTaskComplete({ sessionId, title, status, duration, error }) {
    if (!this.running) return;

    const devices = this.db.prepare(
      'SELECT * FROM telegram_devices WHERE notifications_enabled = 1'
    ).all();

    if (!devices.length) return;

    let icon, statusText;
    if (status === 'done') {
      icon = '✅';
      statusText = 'Completed';
    } else if (status === 'error') {
      icon = '❌';
      statusText = 'Failed';
    } else {
      icon = 'ℹ️';
      statusText = status;
    }

    let durationText = '';
    if (duration) {
      const secs = Math.round(duration / 1000);
      if (secs < 60) durationText = `${secs}s`;
      else if (secs < 3600) durationText = `${Math.floor(secs / 60)}m ${secs % 60}s`;
      else durationText = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
    }

    const text = [
      `${icon} <b>${this._escHtml(title || 'Task')}</b>`,
      `Status: ${statusText}`,
      durationText ? `Duration: ${durationText}` : '',
      error ? `Error: ${this._escHtml(error.slice(0, 200))}` : '',
    ].filter(Boolean).join('\n');

    const keyboard = {
      inline_keyboard: [[
        { text: '💬 View', callback_data: `d:view:${sessionId}` },
        { text: '📝 Continue', callback_data: `d:compose:${sessionId}` },
        { text: '🏠 Menu', callback_data: 'm:menu' },
      ]],
    };

    for (const device of devices) {
      // Rate limit: max 1 notification per device per 5 seconds
      const ctx = this._getContext(device.telegram_user_id);
      const now = Date.now();
      if (now - (ctx.lastNotifiedAt || 0) < 5000) continue;
      ctx.lastNotifiedAt = now;

      try {
        await this._sendMessage(device.telegram_chat_id, text, {
          parse_mode: 'HTML',
          reply_markup: JSON.stringify(keyboard),
        });
      } catch (err) {
        this.log.warn(`[telegram] Notify failed for ${device.telegram_user_id}: ${err.message}`);
      }
    }
  }

  // ─── Stop / New Commands ────────────────────────────────────────────────

  async _cmdStop(chatId, userId) {
    const ctx = this._getContext(userId);
    if (!ctx.sessionId) {
      return this._sendMessage(chatId, '❌ No active session selected');
    }

    this.emit('stop_task', { sessionId: ctx.sessionId, chatId });
    await this._sendMessage(chatId, '🛑 Stop signal sent...');
  }

  async _cmdNew(chatId, userId, args) {
    const ctx = this._getContext(userId);
    const workdir = ctx.projectWorkdir || process.env.WORKDIR || './workspace';

    // Generate text ID matching server.js genId() format
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    // Create new session in DB with proper text ID
    this.db.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at, workdir, model, engine) VALUES (?, ?, datetime('now'), datetime('now'), ?, 'sonnet', 'cli')"
    ).run(id, args || 'Telegram Session', workdir);

    ctx.sessionId = id;
    ctx.composing = true;
    ctx.dialogPage = 0;
    this._saveDeviceContext(userId);

    await this._sendMessage(chatId,
      `✅ <b>New session created</b> (#${this._escHtml(id)})\n\nSend your message:`,
      { parse_mode: 'HTML' }
    );
  }

  // ─── Session Persistence ────────────────────────────────────────────────

  _saveDeviceContext(userId) {
    const ctx = this._getContext(userId);
    try {
      this.db.prepare(
        'UPDATE telegram_devices SET last_session_id = ?, last_workdir = ? WHERE telegram_user_id = ?'
      ).run(ctx.sessionId || null, ctx.projectWorkdir || null, userId);
    } catch(e) {}
  }

  _restoreDeviceContext(userId) {
    const ctx = this._getContext(userId);
    // Only restore if context is completely empty (fresh process or after restart)
    if (ctx.sessionId != null && ctx.projectWorkdir != null) return;
    try {
      const device = this.db.prepare(
        'SELECT last_session_id, last_workdir FROM telegram_devices WHERE telegram_user_id = ?'
      ).get(userId);
      if (device) {
        if (device.last_session_id) ctx.sessionId = device.last_session_id;
        if (device.last_workdir) ctx.projectWorkdir = device.last_workdir;
      }
    } catch(e) {}
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async _showMessages(chatId, sessionId, limit) {
    try {
      const rows = this.db.prepare(`
        SELECT role, type, content, tool_name, created_at
        FROM messages
        WHERE session_id = ? AND (type IS NULL OR type != 'tool')
        ORDER BY id DESC
        LIMIT ?
      `).all(sessionId, limit).reverse();

      if (rows.length === 0) {
        await this._sendMessage(chatId, this._t('chat_no_messages'));
        return;
      }

      const sess = this.db.prepare('SELECT title FROM sessions WHERE id=?').get(sessionId);
      const title = sess?.title || this._t('chat_untitled');

      const lines = rows.map(r => {
        const icon = r.role === 'user' ? '👤' : '🤖';
        const content = this._escHtml(this._sanitize(r.content || '').substring(0, 300));
        const truncated = (r.content?.length || 0) > 300 ? '...' : '';
        return `${icon} ${content}${truncated}`;
      });

      await this._sendMessage(chatId,
        `💬 <b>${this._escHtml(title)}</b>\n${'─'.repeat(20)}\n\n${lines.join('\n\n')}\n\n` +
        this._t('msg_full_hint') + '\n' +
        this._t('msg_compose_hint'));
    } catch (err) {
      await this._sendMessage(chatId, this._t('error_prefix', { msg: this._escHtml(err.message) }));
    }
  }

  _getContext(userId) {
    if (!this._userContext.has(userId)) {
      this._userContext.set(userId, {
        sessionId: null,
        projectWorkdir: null,
        projectList: null,
        chatList: null,
        screenMsgId: null,      // THE message being edited in place
        screenChatId: null,     // chat where screen lives
        chatPage: 0,            // pagination for chat list
        filePath: null,         // current dir in file browser
        filePathCache: new Map(), // int key → absolute path
        composing: false,       // "write to chat" mode
        // Phase 2 fields
        dialogPage: 0,           // dialog pagination offset
        pendingAttachments: [],   // files waiting for text message
        isStreaming: false,       // whether a response is currently streaming
        streamMsgId: null,        // message ID of streaming progress
        lastNotifiedAt: 0,        // rate limiting for notifications
      });
    }
    return this._userContext.get(userId);
  }

  _timeAgo(isoDate) {
    if (!isoDate) return this._t('time_ago_long');
    const diff = Date.now() - new Date(isoDate).getTime();
    if (diff < 60000) return this._t('time_ago_now');
    if (diff < 3600000) return this._t('time_ago_min', { n: Math.floor(diff / 60000) });
    if (diff < 86400000) return this._t('time_ago_hour', { n: Math.floor(diff / 3600000) });
    return this._t('time_ago_day', { n: Math.floor(diff / 86400000) });
  }

  /** HTML-escape for Telegram HTML parse mode */
  _escHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Convert Markdown to Telegram HTML */
  _mdToHtml(text) {
    if (!text) return '';
    const parts = [];
    let lastEnd = 0;
    const fenceRe = /```(\w*)\n([\s\S]*?)(?:```|$)/g;
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
      const pre = text.slice(lastEnd, m.index);
      if (pre) parts.push(this._inlineToHtml(pre));
      const lang = (m[1] || '').trim();
      const code = this._escHtml(m[2].replace(/\n+$/, ''));
      parts.push(lang
        ? `<pre><code class="language-${lang}">${code}</code></pre>`
        : `<pre><code>${code}</code></pre>`);
      lastEnd = m.index + m[0].length;
    }
    const tail = text.slice(lastEnd);
    if (tail) parts.push(this._inlineToHtml(tail));
    return parts.join('');
  }

  /** Convert inline Markdown to Telegram HTML (no code fences) */
  _inlineToHtml(text) {
    // 0. Tables → readable text
    text = this._mdTableToText(text);

    // 0b. Headers → placeholder markers (before HTML escape)
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '\x02B\x02$1\x02/B\x02');

    // 0c. Save Markdown links [text](url) → placeholders
    const links = [];
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
      links.push([t, u]);
      return `\x01L${links.length - 1}\x01`;
    });

    // 0d. List markers → bullets
    text = text.replace(/^[\t ]*[-*]\s+/gm, '\u2022 ');

    // 0e. Checkboxes → bullets
    text = text.replace(/^(\s*)- \[[ x]\] /gm, '$1\u2022 ');

    // 0f. Blockquotes → bar
    text = text.replace(/^>\s?(.*)$/gm, '\u258e $1');

    // 0g. Horizontal rules
    text = text.replace(/^-{3,}$/gm, '\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014');

    // 1. Save inline `code` → placeholders (HTML-escaped inside)
    const codes = [];
    text = text.replace(/`([^`\n]+?)`/g, (_, c) => {
      codes.push(this._escHtml(c));
      return `\x01C${codes.length - 1}\x01`;
    });

    // 2. HTML-escape the rest
    text = this._escHtml(text);

    // 3. Inline formatting
    text = text.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>');
    text = text.replace(/__(.+?)__/gs, '<b>$1</b>');
    text = text.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
    text = text.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');
    text = text.replace(/~~(.+?)~~/gs, '<s>$1</s>');

    // 4. Restore inline code
    for (let i = 0; i < codes.length; i++) {
      text = text.replace(`\x01C${i}\x01`, `<code>${codes[i]}</code>`);
    }

    // 5. Restore links
    for (let i = 0; i < links.length; i++) {
      const [lt, lu] = links[i];
      text = text.replace(`\x01L${i}\x01`, `<a href="${this._escHtml(lu)}">${this._escHtml(lt)}</a>`);
    }

    // 6. Restore header markers
    text = text.replace(/\x02B\x02/g, '<b>').replace(/\x02\/B\x02/g, '</b>');

    return text;
  }

  /** Convert Markdown tables to readable plain text */
  _mdTableToText(text) {
    const lines = text.split('\n');
    const result = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (line.startsWith('|') && line.endsWith('|') && (line.match(/\|/g) || []).length >= 3) {
        const tableRows = [];
        while (i < lines.length) {
          const row = lines[i].trim();
          if (row.startsWith('|') && row.endsWith('|') && (row.match(/\|/g) || []).length >= 3) {
            const cells = row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
            if (!cells.every(c => /^[-:]+$/.test(c))) {
              tableRows.push(cells);
            }
            i++;
          } else {
            break;
          }
        }
        if (tableRows.length) {
          const headers = tableRows[0];
          if (tableRows.length > 1 && headers.length >= 2) {
            for (let r = 1; r < tableRows.length; r++) {
              const parts = tableRows[r].map((cell, j) =>
                j < headers.length && headers[j] ? `${headers[j]}: ${cell}` : cell
              );
              result.push('\u25aa ' + parts.join(' | '));
            }
          } else {
            for (const row of tableRows) {
              result.push('\u25aa ' + row.join(' | '));
            }
          }
        }
      } else {
        result.push(lines[i]);
        i++;
      }
    }
    return result.join('\n');
  }

  /** Split text into Telegram-safe chunks with code-fence awareness */
  _chunkForTelegram(text, limit = MAX_MESSAGE_LENGTH) {
    text = (text || '').trim();
    if (!text || text.length <= limit) return text ? [text] : [];

    const result = [];
    let pos = 0;
    let str = text;

    while (pos < str.length) {
      if (str.length - pos <= limit) {
        const tail = str.slice(pos).trim();
        if (tail) result.push(tail);
        break;
      }

      const window = str.slice(pos, pos + limit);

      // Count ``` — odd means we'd split inside an open fence
      const fences = [];
      let fi = -1;
      while ((fi = window.indexOf('```', fi + 1)) !== -1) fences.push(fi);

      if (fences.length % 2 === 1) {
        const lastOpen = fences[fences.length - 1];

        if (lastOpen > limit / 3) {
          // Enough content before code block — split before it
          const pre = window.slice(0, lastOpen).trimEnd();
          const splitAt = this._findSplit(pre, pre.length);
          result.push(str.slice(pos, pos + splitAt).trimEnd());
          pos += splitAt;
          while (pos < str.length && ' \t\n'.includes(str[pos])) pos++;
        } else {
          // Code block too early — split at newline inside it
          const nl = window.lastIndexOf('\n');
          const langM = window.slice(lastOpen).match(/^```(\w*)/);
          const lang = langM ? langM[1] : '';

          if (nl > limit / 4) {
            let chunk = str.slice(pos, pos + nl).trimEnd();
            if (!chunk.endsWith('```')) chunk += '\n```';
            result.push(chunk);
            pos += nl + 1;
          } else {
            result.push(str.slice(pos, pos + limit).trimEnd() + '\n```');
            pos += limit;
          }
          // Reopen fence for next chunk
          str = str.slice(0, pos) + '```' + lang + '\n' + str.slice(pos);
        }
      } else {
        // Standard split — no open code fence
        const splitAt = this._findSplit(window, limit);
        const chunk = str.slice(pos, pos + splitAt).trimEnd();
        if (chunk) result.push(chunk);
        pos += splitAt;
        while (pos < str.length && ' \t\n'.includes(str[pos])) pos++;
      }
    }

    return result.filter(c => c.trim());
  }

  /** Find the best split point within a text window */
  _findSplit(text, limit) {
    if (text.length <= limit) return text.length;
    const window = text.slice(0, limit);

    // Priority 1: paragraph boundary (double newline) — at least 1/3 into window
    let idx = window.lastIndexOf('\n\n');
    if (idx >= limit / 3) return idx;

    // Priority 2: single newline — at least 1/4 into window
    idx = window.lastIndexOf('\n');
    if (idx >= limit / 4) return idx + 1;

    // Priority 3: sentence end
    for (const marker of ['. ', '! ', '? ']) {
      idx = window.lastIndexOf(marker);
      if (idx >= limit / 5) return idx + marker.length;
    }

    // Priority 4: word boundary
    idx = window.lastIndexOf(' ');
    if (idx > 0) return idx + 1;

    return limit; // hard cut
  }
}

module.exports = TelegramBot;
