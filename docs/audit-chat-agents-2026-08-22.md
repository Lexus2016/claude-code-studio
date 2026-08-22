# Аудит підсистем: візуалізація чатів, потік даних агент→чат, керування агентами з чатів

> Дата: 2026-08-22 · Метод: статичний аудит коду + прогін тестів · Scope: `public/index.html`, `server.js`, `claude-cli.js`, `claude-interactive.js`, `claude-ssh.js`, `db-adapter.js`, `terminal-bridge.js`, `agent-dag.js`, `multi-agent-result.js`, `test/`

---

## 1. Резюме

| Підсистема | Стан | Головний ризик |
|---|---|---|
| Візуалізація чатів | ✅ здорова, тести 19/19 PASS | Прогалини тестів: таблиці, XSS-e2e, WS-контракт |
| Потік даних агент→чат | ⚠️ працює, але є дірки | Crash посеред ходу втрачає стрімлений текст (subscription) |
| Керування агентами з чатів | ⚠️ ядро міцне | Нуль per-agent керування; немає лімітів плану/паралелізму |

---

## 2. Візуалізація чатів (public/index.html)

### Архітектура
Ключові функції: `escH` (:6391), `replaceMarkdownLinks` (:6479), `autolinkBareUrls` (:6591), `linkifyStandaloneButtons` (:6614), `parseAdmonitions` (:6624), `promoteStatusLine` (:6638), `parseKeyValueFacts` (:6669), `renderMd` (:6731), `renderStreaming` (:6881), `statusLineKind` (:6952).

### Порядок пайплайна renderMd (залочений, порушувати не можна)
1. Нормалізація `\r\n` → `\n`
2. **extractFences** — ПЕРШИМ, до list-normalizers (історичний баг: нормалізатори ламали нумерацію всередині фенсів і вставляли токени `\x06LB\x07` у `<code>`)
3. reformatInlineNumberedItems → normalizeListContinuations
4. **escH** — екранування HTML до будь-якого raw HTML
5. Витяг inline-code (run-length: `` ``a`b`` `` зберігає внутрішній бектік)
6. promoteStatusLine → parseKeyValueFacts
7. Блоки: заголовки h6→h1, hr, admonitions (до blockquote!), blockquote, списки
8. Таблиці: split inline-header (крок 3.4) → таблиці (крок 3.5)
9. Інлайн: bold/italic/strike → відновлення inline-code → replaceMarkdownLinks → autolinkBareUrls
10. Абзаци → linkifyStandaloneButtons → відновлення code-блоків (copy-кнопка + мовна мітка, повторне `escH(code)` :6869) → `dir="auto"` для RTL/LTR (:6874)

### Стрімінг
- Незакритий фенс → сирий `<pre>` **без** copy-кнопки + `STREAM_CURSOR`; фінальний `renderMd` на `done` додає кнопку (контракт CLAUDE.md збережено)
- Тротлінг `STREAM_RENDER_MS = 100` (~10 оновнень/с) через `setTimeout`, НЕ rAF — виміряно: rAF давав 639 рендерів на 639 delta і 71% зайнятості головного потоку; тротлінг — 12% (`index.html:6896-6945`)
- `_cancelStreamRender` обов'язковий перед будь-яким прямим записом `.msg` (done/error/reset/agent switch) — інакше таймер перетирає фінальну розмітку стрімінговою

### Безпека
- `escH` виконується на кроці 4 до будь-якої генерації raw HTML; code-блоки повторно екрануються при відновленні
- Посилання: `target="_blank" rel="noopener noreferrer"`; URL проходять `isSafeHref` (`javascript:alert(1)` → false, зафіксовано в `_load.selftest.mjs:6`)
- Знайдено: жодного шляху інжекції не виявлено, але див. прогалину тестів §4

---

## 3. Потік даних агент→чат

### Сильні сторони (зафіксувати)
- WAL + `busy_timeout` + `BEGIN IMMEDIATE` скрізь (`db-adapter.js:63-75, 117-123`)
- Cross-connection lock `activeChatSessions` + liveness-унія `isSessionLive()` (`server.js:1238, 1250`)
- WsProxy: ліміт буфера 1000 кадрів, чесний `stream_gap` при reattach (`2224-2251`)
- persist-before-enqueue черги + boot-restore (`10061, 10923`)
- Recovery як OFFER, а не авто-re-run (`1257-1284`)
- Виділений tmux-сокет `ccstudio` (`terminal-bridge.js:67`) — захист від чужого `kill-server`
- Дедуплікація за задумом: retry-прапорець пропускає повторну вставку user-повідомлення (`9575-9584`), черга видаляє рядок до запуску (`9929`)

### Знахідки
| # | Серйозність | Опис |
|---|---|---|
| 1 | **HIGH** | Немає симетричного лока «Kanban task ↔ веб-чат» на одній сесії → можливий подвійний `claude --resume`. Гонка не протестована — саме тому вона жива |
| 2 | **HIGH** | Crash процесу посеред ходу втрачає вже стрімлений текст; критично для subscription-двигуна без partial-персистенції |
| 3 | **MEDIUM** | Парсер `claude-ssh.js` розходиться з `claude-cli.js`: хвостовий рядок флешиться як текст, скидання буфера інше. Найпростіший швидкий фікс |
| 4 | **LOW** | `mcpConfigPath()` (`claude-interactive.js:232-244`) пропускає запис, якщо `/tmp/ccs-mcp-<hash>.json` уже існує — контрастує з `claude-cli.js:122-123`, який завжди перезаписує + `chmod 0600` |

### Прогалини тестів (потік даних)
`runCliSingle`/`runSshSingle` головний цикл (overload-backoff, rate-limit wait, session-reset replay, auto-continue бюджет) — не покритий поведінково; парсер claude-ssh.js — не тестований узагалі; гілки MAX_LINE_BUFFER overflow і malformed JSON — без тестів; subscription poll-loop таймінги (`paneBusy`/`quietPolls`/latch `endTurnSeen`) — не симулюються; crash-mid-turn → `GET /api/sessions/:id` має вертіти `partial_text` — не ассертиться; негативний шлях WS-upgrade з невалідним токеном (`server.js:9179`) — без прямого тесту; `gracefulShutdown` (`11036`) — не тестований; live browser path — визнаний непротестованим у CLAUDE.md.

---

## 4. Тестове покриття парсингу/відображення (перевірка на вимогу)

**Результат прогону:** `node --test test/render/*.test.mjs` → **19/19 PASS**.

Тести завантажують **справжні тіла функцій** з `public/index.html` через `_load.mjs` (loadFn витягує функцію по закривній дужці в колонці 0) — тестується реальний код, а не копії.

### Що покрито
- **fences.test.mjs** (21 assert) — найнебезпечніше місце парсера: згадка ``` ```json ``` посеред речення не відкриває блок (D1); вкладений ```` ``` ```` усередині 4-бектікного фенса зберігається дослівно (D2); довший закривний фенс закриває і не витікає (D2b, CommonMark); позиційно-незалежне парингування після «сирого» фенса (D3); гібридна мова `objective-c` (D4)
- Inline `` ``a`b`` ``; фенс усередині list item (без токенів продовження); фенс усередині blockquote
- Контракт CLAUDE.md: copy button + language label (`fences.test.mjs:76-81`)
- Стрімінг: незакритий блок → сирий `<pre>` без кнопки + курсор; згадка фенса нічого не відкриває
- Детермінізм `renderMd` (тротлінг 100 мс не впливає на результат)
- **integration.test.mjs** — повний пайплайн на реалістичному повідомленні аудиту: status pill, callout warn, kv-grid, автолінк bare URL, standalone кнопка, h1, регресія «немає фальшивого `<ol>`» від `(1)(2)(3)`
- autolink / standalone-links / kv / admonitions / status-badge / regression — по одному аспекту кожен
- activity.test.mjs — рендерери активності з i18n-стабом; subscribe-all-tabs — логіка підписок табів; ask-question.test.mjs — `_toolInputBrief` розбирає масив `{questions:[...]}` (issue #20); minimap — рейка крапок скролу

### Прогалини покриття
1. **Таблиці** — кроки 3.4/3.5 у `renderMd` (`index.html:6795-6828`) не мають жодного тесту (split inline-header і fallback-гілка separator-first рядка)
2. **Adversarial XSS e2e** — немає тесту `<script>` / `<img onerror>` крізь увесь `renderMd` (захист escH існує, але не зафіксований тестом)
3. **Inline-форматування** (bold/italic/strike, `index.html:6832-6840`) — без прямих тестів
4. **Клієнтський WS-контракт** (`text/tool_use/done/error/input_needed`) і рендер tool_use-бульок — поза render-тестами

---

## 5. Керування агентами з чатів (multi-agent)

### Сильні сторони
- Хвильовий DAG-планувальник з гарантією прогресу (`agent-dag.js` + `computeWaves`): лінійні ланцюги, діамант a→(b,c)→d, незалежність від порядку плану, self/mutual-цикли й ghost-залежності → `stuck`
- `buildDepContext`: маркування `[id]:`, truncation 2000 символів **на залежність**
- Строге трактування успіху (`multi-agent-result.js` `isAgentSuccess`): кадр result відсутній ≠ успіх; errored перемагає success-frame; матриця бюджету auto-continue
- Fork-володіння сесією: `_branchId !== currentSessionId` (`4197-4199`), break при `!agentOwnsSession` (`4205`)

### Відсутні функції керування з чату (розрив з канбаном)
| Функція | Статус | Доказ |
|---|---|---|
| Модель на агента | відсутня — один `msg.model` для всіх воркерів | `4023, 4174`; канбан має model/run_engine/effort (`10607-10612`), але чат-раннер ігнорує; у `planSchema` (`4043-4063`) полів model/effort немає — `a.effort \|\| effort` (`10611`) читає поле, якого схема ніколи не повертає (мертвий вхід) |
| Pause/resume | відсутня — тільки run/abort | grep — 0 збігів |
| Бюджет/ліміти на агента | часткова — глобальні maxTurns + `MULTI_AGENT_MAX_TURNS_CAP` (`4149`); `error_max_budget_usd` окремо не обробляється (канбан обробляє: `1760`) | — |
| Затвердження плану перед виконанням | відсутня — план виконується негайно; лише пост-фактум кнопка «📋 Kanban» (`8831`) | — |
| Метрики прогресу/витрат по агенту | відсутні — `onUsage` (`claude-cli.js:505`) не підключений у runMultiAgent | — |
| Зв'язок фінального результату з агентами | відсутній — summary персиститься як звичайний `'text'/summarizer` (`4269`) без посилань на agent_plan | — |

### Ризики
- **Немає лімітів масштабу**: розмір плану (>5 агентів) і паралелізм не капляться; краї валідації плану (1 агент, дублікати id) не оброблені й не протестовані
- **Діра в shutdown**: `gracefulShutdown` не зупиняє коректно фонових multi-agent воркерів
- **Асиметрія політики провалу** чат vs канбан (див. таблицю вище)
- Окрема реалізація DFS перевірки циклів у dispatch_plan (`10562-10570`) дублює логіку `computeWaves` — два джерела правди

### Прогалини тестів (multi-agent)
`runMultiAgent` як ціле ніколи не проганявся (модуль недосяжний — server слухає порт на require); гілка фолбеку в single (`4095-4101`); emission «Circular deps» (`4121-4122`); цикл авто-продовжень із fork-володінням (`4164-4215`) — найтонше місце ізоляції сесій, нуль покриття; **розбіжність тесту з продакшном**: `agent-dag.test.js:84` перевіряє, що *порожній* рядок dep не дає контексту, тоді як у продакшні впалий агент лишає *непорожній* текст із ⚠️-нотисом (`4225`), який ще й обрізається `substring(0,2000)`; сумаризатор (умови виклику, truncation 3000 симв./агент `4253`, skip-on-abort `4245`); stop-семантика для multi; правило «attachments лише перша хвиля» (`4170-4173`); UI-рендер картки команди `_atcRender`/`_atcUpdate` + reload path (`12025-12052`) — у test/render немає жодного atc-* тесту; WsProxy cap/stream_gap не входить у multi-agent сьюіти.

---

## 6. Пріоритети виправлень

1. **Тести таблиць + XSS-e2e** (§4) — найдешевші, закривають найбільшу прогалину парсера
2. **Парсер claude-ssh.js** — вирівняти з claude-cli.js (знахідка 3) — швидкий фікс
3. **Partial-персистенція стріму** ( знахідка 2) — усуває втрату тексту при crash
4. **Симетричний лок Kanban↔чат** (знахідка 1) + поведінковий тест на гонку
5. **Ліміти плану/паралелізму + обробка країв валідації** (§5)
6. Per-agent модель/метрики — продуктове рішення, узгодити з канбаном

---

## Підсумок

- **CHANGES MADE:** створено цей документ; нотатку handoff збережено в TQMemory
- **DIDN'T TOUCH:** код проєкту, git-стан, БД
- **POTENTIAL CONCERNS:** UI-поведінка (картка команди, reload) перевірена за кодом рендеру, але не в живому браузері; покриття канбан-воріт (`2066-2100`) не оцінювалося
