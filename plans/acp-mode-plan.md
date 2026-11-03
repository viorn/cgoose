# cgoose ACP Mode — детализированный план

> Новый режим работы cgoose: вместо `spawn("goose", ["session", ...])` cgoose сам
> становится ACP-клиентом (Agent Client Protocol), запускает `goose acp` и рендерит
> диалог с агентом собственным TUI. Классический режим сохраняется как фолбэк.

## 0. Контекст и факты (подтверждено исходниками goose)

- ACP = JSON-RPC 2.0 поверх stdio (NDJSON, по одному сообщению на строку).
- `goose-acp` — отдельный lean-бинарь (`crates/goose/src/bin/goose-acp.rs`),
  принимает только `--with-builtin <NAME,...>`, запускает `goose::acp::server::run()`.
  Есть и сабкоманда `goose acp` в CLI.
- ACP-сессии создаются в **общем `SessionManager`** → попадают в `sessions.db`
  и видны через `goose session list` (шаг wizard'а «session» работает без изменений).
- `session/new` принимает `_meta`: `provider`, `sessionTitle`, `enabledExtensions`,
  `recipe` (instructions → системный промпт), `recipeParameterScopeId`, `projectId`,
  `client`, `hidden`; плюс стандартные `cwd` и `mcpServers`.
- Goose-кастомные запросы (методы `_goose/...` — точные имена см. `goose_sdk_types::custom_requests`):
  - `SetSessionSystemPromptRequest` — системный промпт сессии (аналог `--system`)
  - `AddSessionExtensionRequest` / `RemoveSessionExtensionRequest` / `GetSessionExtensionsRequest`
  - `RenameSessionRequest`, `ArchiveSessionRequest`, `GetSessionInfoRequest`
  - `TruncateSessionConversationRequest` — аналог режима `-e` (rollback)
  - `ListProvidersRequest`, `ProviderSupportedModelsListRequest`, `RefreshProviderInventoryRequest`
  - `SteerSessionRequest`, `ListSlashCommandsRequest`, `GetToolsRequest`, `SetToolPermissionsRequest`
  - `ContextReportRequest` — отчёт о контексте
- `session/load` — полный replay истории: agent/user chunks, thoughts, tool calls
  с заголовками и `toolChainSummary`, usage через goose custom notifications;
  опция `_meta.replayTail`; возобновляет ожидающие permission-запросы.
- Agent → Client запросы, которые клиент обязан обрабатывать:
  - `session/request_permission` (опции allow_once / allow_always / reject_once / reject_always / cancel)
  - `fs/read_text_file`, `fs/write_text_file` (по capability)
  - `terminal/create|output|wait_for_exit|kill|release` (по capability)
  - `elicitation/create` (опционально)
- Agent → Client уведомления: `session/update` (agent_message_chunk,
  agent_thought_chunk, tool_call, tool_call_update, plan, available_commands_update,
  user_message_chunk, session_notice, …) + goose custom notifications (usage и др.)
  при объявлении capability `goose.customNotifications`.

## 1. Матрица паритета

| Функция cgoose сейчас | ACP-эквивалент | Статус |
|---|---|---|
| Wizard 6 шагов | без изменений (cgoose-side) | ✅ |
| `goose session list` | те же ACP-сессии в sessions.db | ✅ |
| Worktree / cwd | spawn goose-acp с cwd + `session/new { cwd }` | ✅ |
| Env: OPENAI_BASE_URL, ключи, GOOSE_CONTEXT_LIMIT, GOOSE_ADDITIONAL_CONFIG_FILES | тот же env процесса | ✅ |
| `--provider` / `--model` | `_meta.provider` + config; модель через configOptions/session modes | ✅ |
| `--name` | `_meta.sessionTitle` / `RenameSessionRequest` | ✅ |
| `--system` (set.systemPrompt) | `SetSessionSystemPromptRequest` | ✅ |
| `--with-builtin` | флаг `--with-builtin` при старте goose-acp | ✅ |
| `--with-extension` / `--with-streamable-http-extension` | `_meta.enabledExtensions` / `mcpServers` / `AddSessionExtensionRequest` | ✅ |
| `--no-profile` (set = None) | не передавать enabledExtensions/builtins; проверить поведение default-профиля на Phase 0 | ⚠️ |
| `__default__` (Default set) | не задавать extensions → профиль из config.yaml | ⚠️ уточнить |
| Resume + история | `session/load` | ✅ |
| Режим `-e` (rollback) | `TruncateSessionConversationRequest` | ✅ |
| Ctrl+C / Esc во время генерации | `session/cancel` | ✅ |

Единственная версия-зависимость: всё выше — из текущей main-ветки goose.
Phase 0 проверяет локально установленную версию.

## 2. Архитектура

```
src/
  launcher.ts                  // существующий классический запуск
  acp/
    transport.ts               // NDJSON JSON-RPC 2.0 over stdio (spawn, парсинг, ошибки)
    types.ts                   // типы ACP (initialize, session/new|load|prompt, updates, ...)
    client.ts                  // AcpClient: request/notification API, pending-request map,
                               // router входящих сообщений, обработка agent→client
    custom.ts                  // goose-кастомные запросы (typed wrappers)
    handlers/
      permissions.ts           // session/request_permission → UI-промпт
      fs.ts                    // fs/read_text_file, fs/write_text_file (прямой доступ к диску)
      terminal.ts              // terminal/* — фаза 2 (можно объявить только нужные capability)
    session-mapper.ts          // маппинг GooseSession (sessions.db) → session id для load
  tui/
    chat.ts                    // главный цикл chat TUI
    render.ts                  // рендер: markdown, tool calls, thoughts, plan
    input.ts                   // raw-mode ввод (многострочный, история, Esc/Ctrl+C)
    state.ts                   // модель состояния диалога (событийная, append-only)
```

### 2.1 Подготовка запуска (общая с классическим режимом)

Вынести из [`launchGoose()`](../src/launcher.ts) в `prepareLaunch()`:
worktree создание/поиск, `GOOSE_ADDITIONAL_CONFIG_FILES` + резолв секретов,
env кастомного провайдера, `GOOSE_CONTEXT_LIMIT`. Оба лаунчера используют
`prepareLaunch()`, различается только команда и способ ведения диалога.

### 2.2 ACP-клиент (`src/acp/client.ts`)

- `AcpClient.spawn(opts)` — spawn `goose acp [--with-builtin ...]`, stdin/stdout
  подключены к транспорту, stderr → в лог-файл (или `~/.config/cgoose/logs/`).
- Формат кадра: одна строка JSON = одно сообщение. Разделение: `\n`.
- Механика:
  - `request(method, params) → Promise<result>` (map id→resolver, timeout, error→throw)
  - `notify(method, params)`
  - входящие `request` → обработчики handlers/, ответ через `respond(id, result|error)`
  - входящие `notification` → колбэки UI (`onSessionUpdate`, ...)
- Инициализация: `initialize { protocolVersion, clientCapabilities }`.
  Клиентские capabilities, которые объявляет cgoose:
  - `fs: { readTextFile: true, writeTextFile: true }`
  - терминал — НЕ объявляем на фазе 1 (developer builtin выполняет команды сам)
  - `goose.customNotifications` — для usage-метрик
- Жизненный цикл: initialize → new/load → prompt ⇄ updates → cancel → exit.

### 2.3 Сценарии

**Новая сессия:**
1. `session/new { cwd: worktree|., mcpServers: [], _meta: { provider, sessionTitle, client: "cgoose", enabledExtensions } }`
2. `SetSessionSystemPromptRequest` (если set.systemPrompt задан)
3. цикл `session/prompt` / `session/update`
4. `session/cancel` при Esc/Ctrl+C

**Resume:**
1. `session/load { cwd, sessionId }` — получение replay → отрисовать историю
2. далее как выше.

**Выбор модели после создания сессии** — через `session/set_mode` / configOptions
из ответа `session/new` (фаза 2, опционально).

### 2.4 Chat TUI — на базе [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi)

Решение: НЕ пишем собственный рендерер, берём MIT-пакет `@earendil-works/pi-tui`
(TUI-фреймворк из агента pi, автор Mario Zechner; добавляется в `package.json`).

Почему подходит:
- Дифференциальный рендеринг + synchronized output (CSI 2026) — стриминг без мерцания
- Два режима: `TuiMainScreen` (сохраняет scrollback терминала — как обычный CLI-чат)
  и `TuiAltScreen` (viewport со скроллом, мышью, поиском)
- Готовые компоненты закрывают все потребности:
  - `Markdown` — рендер ответов агента (с подсветкой кода через `highlightCode`)
  - `Editor` — многострочный ввод (Enter — отправка, Shift+Enter — новая строка),
    автокомплит slash-команд (`/`) через `CombinedAutocompleteProvider`,
    обработка больших paste (`[paste #1 +50 lines]`)
  - `SelectList` — permission-промпты из `session/request_permission`
    (allow once/always, reject once/always, cancel)
  - `Loader` / `CancellableLoader` — спиннер во время генерации, Esc → abort
  - `TruncatedText` — статусная строка (модель/провайдер/set/worktree/токены)
  - Overlays — модальные диалоги (удаление сессии и т.п.)
  - `matchesKey`/`Key` — унифицированный ввод (Esc, Ctrl+C, стрелки)
- Референс: `packages/tui/test/chat-simple.ts` в репо pi — готовый пример
  chat-интерфейса (Markdown + Editor + Loader + Spacer)

Структура `src/tui/`:
  - chat.ts     — сборка: TUI, transcript-Container, Editor, статус, обработка
                  session/update → обновление компонентов
  - stream.ts   — буфер стриминга: накапливает чанки, throttle-обновляет
                  Markdown-компонент текущего сообщения (~30fps)
  - toolview.ts — компонент tool call: заголовок + статус + свёрнутый вывод,
                  разворот по клавише `o` (обёртка над Container)
  - prompts.ts  — SelectList-обёртки: permission-промпт, подтверждения

Клавиатура: Enter — отправка, Esc — `session/cancel` / назад,
Ctrl+C — отмена генерации (или выход, если неактивна), `o` — разворот tool call.

Совместимость: пакет требует Node >= 22.19, зависимости — `marked` +
`get-east-asian-width`; cgoose работает под Bun → проверить raw-mode stdin и
native-части (clipboard — опциональны) в Phase 1, при проблемах — vendor-копия
исходников `packages/tui/src` в репозиторий (лицензия MIT это позволяет).

### 2.5 Интеграция с wizard'ом

- Новый шаг/вариант на шаге «launch»: режим по умолчанию из
  `~/.config/cgoose/config.json` (`"ui": "classic" | "chat"`), CLI-флаг
  `-C`/`--chat` (в духе существующих однобуквенных флагов).
- Шаги wizard'а не меняются; launch step вызывает `launchGooseAcp()`.

## 3. Фазы

- **Phase 0 — верификация локального окружения**
  - `goose acp --help` / `goose-acp --version`; проверить наличие сабкоманды
  - probe-скрипт (node/bun): initialize → session/new (`_meta` с provider/title) →
    SetSessionSystemPrompt → session/prompt → сбор session/update → session/load
    → проверить, что сессия появилась в `goose session list`
  - Проверить поведение без `_meta.enabledExtensions` (default-профиль? `--no-profile`?)
  - Выход: чек-лист «что поддерживает установленная версия»
- **Phase 1 — транспорт и клиент** (`src/acp/`) + probe через собственный клиент
- **Phase 2 — интеграция лаунчера**: `prepareLaunch()`-рефакторинг, `launchGooseAcp()`,
  headless-режим чата (минимальный readline-диалог) для сквозной проверки
- **Phase 3 — Chat TUI на pi-tui** (`src/tui/`): интеграция `@earendil-works/pi-tui`
  (Markdown, Editor, SelectList, Loader), стриминг-буфер, permission-промпты, cancel;
  проверка совместимости с Bun → при проблемах vendor-копия исходников (MIT)
- **Phase 4 — паритет и полировка**: session/load replay, `-e` через Truncate,
  usage-метрики, режим в config.json + CLI-флаг, README/AGENTS.md

## 4. Риски

1. Версия goose на машине пользователя может не иметь части кастомных запросов →
   детект capability и graceful degradation (или запрет ACP-режима с понятной ошибкой).
2. `stderr` goose-acp: логирование не должно попадать в TUI → уводить в файл.
3. Совместимость `@earendil-works/pi-tui` с Bun (raw-mode stdin, native clipboard)
   — проверяется в Phase 1; fallback — vendor-копия `packages/tui/src` (MIT).
3a. Markdown-рендер в терминале — компромисс по полноте (таблицы/код-блоки).
4. Если goose переименует кастомные запросы — привязка к `goose_sdk_types`,
   поэтому Phase 0 фиксирует фактические имена методов для установленной версии.
5. Широкие capability (terminal/*) намеренно не включаем в фазе 1 — меньше поверхность.

## 5. Критерии готовности

- Enter на всех шагах wizard'а → новая ACP-сессия с last set/provider/model, окно чата
- Resume любой сессии из списка → полная история отрисована, продолжение работает
- Set: системный промпт и расширения применяются (проверяется probe + поведенчески)
- Worktree создаётся/находится как в классическом режиме
- Esc отменяет генерацию; permission-запросы работают; `-e`-rollback через Truncate
- Классический режим остаётся дефолтным до явного включения
