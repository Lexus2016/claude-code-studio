# Claude Code Chat v4.0

Веб-інтерфейс для роботи з Claude Code. Підтримує CLI (Max підписка) та SDK (API ключ) режими.

## 🎯 Можливості

| Функція | Опис |
|---------|------|
| 🖥 CLI Mode | Працює через `claude` CLI з Max підпискою (безкоштовно) |
| 🔌 SDK Mode | Працює через API ключ (платно за токени) |
| 💬 Chat | Текстовий діалог з Claude Code через WebSocket |
| 📁 Files | Файловий браузер workspace з прев'ю |
| ⚡ MCP | Підключення MCP серверів (готові + ручні) |
| 🧠 Skills | Завантаження skill файлів (.md) |
| 🔄 Modes | Auto / Planning / Task режими роботи |
| 👥 Multi-Agent | Оркестрація команди агентів |
| 💎 Models | Opus 4.6 / Sonnet 4.5 / Haiku 4.5 |
| 📋 History | Збереження сесій в SQLite |
| 📋 Copy | Копіювання повідомлень в буфер |
| ⚙️ Config Editor | Редагування config.json, CLAUDE.md, settings.json, .env |
| 🔒 Auth | Авторизація з setup wizard при першому запуску |
| 🐳 Docker | Dockerfile + docker-compose |

## 🚀 Швидкий старт

### Без Docker (з Max підпискою):
```bash
# 1. Встановити залежності
npm install

# 2. Переконатися що claude CLI авторизований
claude --version

# 3. Запустити
node server.js

# 4. Відкрити http://localhost:3000
# Перший запуск — створити пароль
```

### Без Docker (з API ключем):
```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
node server.js
```

### Docker:
```bash
# 1. Налаштувати .env
cp .env.example .env
# Відредагувати .env

# 2. Запустити
docker-compose up -d --build

# 3. Логи
docker-compose logs -f
```

## 📂 Структура
```
claude-code-chat/
├── server.js          # Node.js backend (Express + WebSocket)
├── auth.js            # Авторизація (bcrypt + tokens)
├── claude-cli.js      # CLI wrapper з підтримкою сесій
├── config.json        # MCP сервери + skills конфіг
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env               # Змінні оточення
├── public/
│   ├── index.html     # Головний UI
│   └── auth.html      # Login / Setup сторінка
├── skills/            # Skill файли (.md)
│   ├── trading-bot.md
│   ├── pinescript.md
│   └── code-review.md
├── data/              # SQLite DB + auth (persistent)
└── workspace/         # Робоча директорія Claude Code
```

## 🖥 CLI vs SDK

| | CLI (Max) | SDK (API) |
|---|---|---|
| Оплата | Max підписка | За токени |
| Сесії | `--session-id --resume` | SDK session |
| Streaming | stdout parsing | Native |
| Стабільність | Залежить від CLI output | Стабільне |
| Multi-Agent | ✅ | ✅ |

## ⚙️ Налаштування

### Додавання MCP серверів
1. Ліва панель → ⚡ MCP → "+ Додати MCP"
2. Або редагувати `config.json` через ⚙️ → config.json

### Додавання Skills
1. Ліва панель → 🧠 Skills → "+ Upload .md"
2. Або додати файл в `skills/` та оновити `config.json`

### Конфігурація Claude Code
⚙️ Config Editor:
- `config.json` — MCP + Skills конфіг
- `CLAUDE.md` — System prompt для workspace
- `.claude/settings.json` — Глобальні налаштування Claude Code
- `.env` — API ключі та змінні оточення

## 🔒 Безпека

- Пароль хешується через bcrypt (12 rounds)
- Auth токени 30 днів, зберігаються server-side
- WebSocket авторизація через cookie
- API ключі ніколи не передаються на фронтенд
