# Milestones

## v1.0 Telegram UX Redesign (Shipped: 2026-06-17)

**Phases completed:** 4 phases, 11 plans, 20 tasks

**Key accomplishments:**

- BOT_I18N translation object (784 lines, 3 locales x 217 keys) extracted from telegram-bot.js into standalone CommonJS module telegram-bot-i18n.js
- Replaced 3 ad-hoc state flags (pendingInput, pendingAskRequestId, composing) with explicit FSM enum (ctx.state + ctx.stateData) across telegram-bot.js and server.js, with auto-migration and answerCallbackQuery in finally block
- SCREENS registry with 11 entries and parent chain, CALLBACK_TO_SCREEN map with 12 prefix mappings, editMsgId-based screen handlers replacing ctx.screenMsgId global slot
- sendMessageDraft replaces editMessageText for Claude response streaming with 500ms debounce and automatic legacy fallback
- SCREEN_TO_CALLBACK reverse map, _buildContextHeader utility, and auto-generated Back buttons on all 11 screen methods with i18n keys in 3 locales
- Dynamic context-aware persistent keyboard with project/chat labels, prefix-based button matching, and minimal setMyCommands
- Navigation slash commands marked legacy + _handleWriteButton auto-selection for single project/chat achieving 2-tap-or-fewer flow
- TelegramBotForum extracted to telegram-bot-forum.js (1002 lines) via composition facade, with forum-scoped state and explicit threadId parameters
- Inline action keyboards on all forum interaction points with i18n, setMyCommands scoping, and activity notification action buttons
- Guided 3-step forum setup replacing text wall, plus per-task inline buttons replacing /start #id and /done #id slash commands

---
