# Рефакторинг крупных файлов: chat.ts (2376) и index.ts (1234)

> **Цель:** разбить две монолитные функции (`runAcpChat` ~2100 строк, `main` ~1170 строк)
> на модули по единой ответственности. Публичный API не меняется: `runAcpChat(opts)`
> и поведение CLI остаются прежними, `launcher.ts` правок не требует.
>
> **Механика:** вместо замыканий над ~45 локальными переменными — общий объект
> `ChatContext` (интерфейс с полями), создаваемый один раз; все функции-модули
> принимают `ctx`. Для wizard-файлов состояние передаётся явными параметрами.
>
> **Статус: выполнено.** Все пункты ниже закрыты; результат проверен `tsc`, юнит-тестами
> и живым прогоном в tmux (см. «Проверка»).

## src/acp/chat.ts → 8 модулей

- [x] Создать `src/acp/chat-context.ts` — интерфейс `ChatContext` (все ~45 мут ируемых локалей `runAcpChat` становятся полями), типы `PendingSteer` / `AcpChatOptions` / `ExtensionPlanState`, темы markdown/selectList/editor, константы (`PROMPT_KEY`, `DEFAULT_READ_LIMIT`), хелперы `answerLabel` / `formatCost`, фабрика `createChatContext(opts)`
- [x] Создать `src/acp/chat-extensions.ts` — `initExtensionPlan`, `planForSet`, `applyExtensionPlan`, `requiredExtensions`, `allowedExtensionNames`, `noteExtensionWarning`, `verifySessionExtensions`, `reconcileSessionExtensions`, `applySystemPrompt`
- [x] Создать `src/acp/chat-handlers.ts` — обработчики agent→client: очередь permission-запросов, `cancelAllPermissions`, `showNextPermission`, `framed()`, регистрация `setPromptHandlers` с `readTextFile`/`writeTextFile`
- [x] Создать `src/acp/chat-stream.ts` — `closeThought` / `closeToolBlocks` / `closeUser` / `closeMessage`, throttled `flushStream` / `flushThought`, `handleSessionUpdate` (бывший клиентский `onUpdate`), `renderHeader` / `renderStatus`, `toggleAllThoughts` / `toggleAllTools`
- [x] Создать `src/acp/chat-session.ts` — `setupSession` (initialize + `session/new` | `session/load` + применение конфига и системного промпта), `changeSet`, `changeSession`, `newSession`, `forkCurrentSession`, `renameCurrentSession`, `promptRename`
- [x] Создать `src/acp/chat-config.ts` — `showMenu`, `changeProvider`, `changeModel`, `currentProviderConfig`, `fetchModelsForCurrentProvider`, `applyFetchedModel`, `showConfigMenu` / `showProviderMenu` / `showModelMenu` / `showSetMenu` / `showSessionMenu`, `handleCommand` (`persistSelection` остался в `chat-extensions.ts`, рядом с планом расширений)
- [x] Создать `src/acp/chat-io.ts` — `attachEditorSubmit` (`editor.onSubmit`), `dispatchPrompt`, `submitPrompt`, `submitSteer`, `queuePrompt`, `restoreDraft`, `abandonPendingSteers`, `finishTurn`, `steerHint`, `setLoader`, `promptInEditor` + `externalEditorCommand`
- [x] Создать `src/acp/chat-ui.ts` — `setupUi` (loader/editor/layout, alt-screen vs main-screen), `startChat` (старт + подсказки), `attachInputListener` (Ctrl+P/O/E, Esc-arming, Ctrl+C), `startIdleWatchdog`, `attachAgentExit`, `shutdown`
- [x] Переработать `src/acp/chat.ts` — `runAcpChat` остаётся тонким оркестратором: spawn клиента, `createChatContext`, подключение `onUpdate`/input, `setupSession`, keep-alive (117 строк)

## src/index.ts → 3 модуля

- [x] Создать `src/wizard-sessions.ts` — `handleDeleteSessions`, `createSessionSetWizard`, `manageSessionSets` (304 строки)
- [x] Создать `src/wizard-steps.ts` — шаги 1-5: `stepSession`, `stepSessionName`, `stepSet`, `stepProvider`, `stepModel` (759 строк), helper `resolveChatMode` / `LEGACY_CHAT_ALIASES`, типы `Step` / `LaunchMode` / `WizardState`
- [x] Создать `src/wizard-launch.ts` — `stepLaunch` (результат, коллэк к launcher), `resolveLaunchMode`, helper `formatSetLine` (201 строка)
- [x] Переработать `src/index.ts` — `main()` остаётся тонким: CLI parsing, resolve modes, loop over steps from wizard-steps, launch from wizard-launch (166 строк)

## Проверка и документация

- [x] Проверить сборку и тесты: `bun run check` (tsc) и `bun run test`
- [x] Обновить документацию: `AGENTS.md` (раздел Chat Mode) и таблицы файлов `src/acp/*` в `README.md` и `README.ru.md`

## Отклонения от плана (осознанные)

- `planForSet(set, useDefault)` — без `ctx`: функция чистая (строит новый план и
  возвращает его, применяет `applyExtensionPlan`). Единственный вызывающий —
  `changeSet` в `chat-session.ts`.
- `chat-context.ts` отвечает не только за состояние, но и за инициализацию окружения:
  `altScreen` (`ROSSII_CHAT_MAIN_SCREEN`), `stderrTail`, `onAgentExit` (no-op до
  `setupUi`), а также вотчдоги и `ROSSII_ACP_STEER` — так порядок «настройки раньше
  первого рендера» сохраняется без отдельных вызовов в оркестраторе.
- `usagePart` (строка статуса) и throttle-таймеры `flushStream`/`flushThought` — на
  уровне модуля `chat-stream.ts`, а не в `ctx`: чат в процессе всегда один.
- `editor.onSubmit` — `attachEditorSubmit(ctx)` в `chat-io.ts` (как в плане), но сама
  вёрстка/старт — в `chat-ui.ts`; `chat-io` импортирует `renameCurrentSession`, а
  `chat-config` ↔ `chat-io` связаны циклом импортов (только функции, вызовы в рантайме).
- `src/wizard-steps.ts`: `case`-блоки исходного `switch` завернуты в `do { … } while (false)`,
  `step = "X"; continue;` → `return "X"`, а состояние — в `WizardState` (по плану).
  Мёртвая строка `const setKeys = Object.keys(allSets)` (была неиспользуемой и в
  оригинале) удалена.

## Проверка (как именно проверялось)

- `npx tsc -p tsconfig.json` — чисто; `bun run test` — 29 + 60 passed, 0 failed.
- Живой прогон в tmux (`goose` 1.57.0, временный каталог `/tmp/rossii-e2e`):
  полный визард (session → name → set → provider → model → сводка) с запуском чата;
  чат: `/set` Sigma → Default → None со сверкой расширений (включая скрытый `scheduler`),
  `/model` + смена модели с записью в project meta, `/think expand|collapse all`,
  `/tool`, `/session` (меню, rename, fork), `Ctrl+P` (меню конфигурации), Esc-arming и
  Ctrl+C с печатью транскрипта обратно на нормальный экран, реальный ход с вызовом
  инструмента и работой steering, `rossii a` — резюм сессии со сверкой расширений сета,
  диалог удаления сессий (`Done: 2 deleted, 0 failed`). Тестовые сессии и каталог удалены.

## Ожидаемый результат

| Файл | Было | Стало |
|------|------|-------|
| `src/acp/chat.ts` | 2376 | 117 (оркестратор) + 8 модулей 121–421 |
| `src/index.ts` | 1234 | 166 (оркестратор) + 3 модуля 201–759 |
