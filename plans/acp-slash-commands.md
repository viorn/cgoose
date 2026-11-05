# ACP: слэш-команды goose из чата rossii (`/compact` и остальные)

- **Дата:** 2026-11-06
- **Статус:** выполнено, проверено вживую
- **Проверено вживую:** goose **1.57.0** (`~/.local/bin/goose`), tmux-E2E на реальном
  провайдере
- **Задача (пользователь):** «сейчас невозможно вызвать `/compact`»

## 1. Почему `/compact` не работал

`/compact` — команда **самого goose**: текст промпта перехватывает
`Agent::execute_command()` (`crates/goose/src/agents/execute_commands.rs`) ещё до обычного
хода, и для `/compact` он сжимает хранимую беседу
(`compact_messages(..., is_manual_compact=true)` → `replace_conversation`), отвечая
ассистентским сообщением `Compaction complete`.

rossii же перехватывал **любой** ввод, начинающийся с `/`, ещё до отправки:

- `attachEditorSubmit` (`src/acp/chat-io.ts`) → `handleCommand` при `text.startsWith("/")`;
- `planSteer` (`src/acp/steer.ts`) возвращает `{ kind: "command" }` для любого `/…`
  (это правильно: goose считает команду только в **промпте** хода, не в steered-сообщении);
- в `handleCommand` (`src/acp/chat-config.ts`) команды `compact` в `switch` нет →
  `⚠ Unknown command: /compact. Use /config to open the configuration menu.`

То есть команда не доходила до агента вообще. Та же дыра у `/clear`, `/status`, `/doctor`,
`/goal`, `/grind`, `/prompts`, `/prompt`, `/skills` — и у слэш-команд рецептов/скиллов goose.

## 2. Что умеет goose (проверено по исходникам и вживую)

Встроенные команды (`list_builtin_commands` → `execute_commands::list_commands`):
`prompts`, `prompt`, `compact`, `clear`, `skills`, `doctor`, `goal`, `grind`, `status`.
Плюс скрытые синонимы компакта (`COMPACT_TRIGGERS`): `/summarize`,
`Please compact this conversation` (последний — не слэш-команда, идёт как обычный промпт).
Слэш-команды рецептов и скиллов goose добавляет к тому же списку
(`list_acp_commands` = builtin + recipe + skill; builtin побеждает при совпадении имён).

Список отдаётся клиенту двумя путями:

1. **`SessionUpdate::AvailableCommandsUpdate`** (`availableCommands: [{name, description}]`) —
   нотификация `session/update`, которую goose отправляет в
   `send_session_setup_notifications()` **сразу после `session/new`, `session/load` и
   `session/fork`**. Никакого лишнего RPC не нужно — rossii её до сих пор просто игнорировал
   (`default: break` в `handleSessionUpdate`).
2. `_goose/unstable/slash-commands/list` (запрос) — не понадобился.

Имена нормализуются goose как `trim_start_matches('/').to_lowercase()`
(`slash_commands/util.rs`), поэтому команда рецепта может прийти как `/review`.

**Чего goose клиенту не сообщает:** после сжатия/очистки он эмитит
`AgentEvent::HistoryReplaced`, но ACP-сервер его не форвардит
(`Ok(_) => {}` в `forward_agent_stream`), так что клиент не может перерисовать транскрипт по
нотификации — приходит только текст ответа (`Compaction complete`) и обновлённый
`usage_update` (он и виден в статусной строке: контекст схлопывается).

## 3. Решение

Правило ровно одно, как у самого goose: **что не реализует rossii — то goose**. Команды
чата (`/config`, `/model`, `/provider`, `/set`, `/session`, `/rename`, `/fork`, `/think`,
`/tool`, `/edit`, `/fetch`, `/help`) отвечает rossii; **любой другой ввод с `/` уходит
агенту обычным промптом**, дословно, и goose сам решает, его ли это команда
(`/compact`, `/clear`, `/status`, `/doctor`, `/goal`, `/grind`, `/prompts`, `/prompt`,
`/skills`, слэш-команды рецептов и скиллов).

Так делает и родной TUI goose: `handle_slash_command()` в
`crates/goose-cli/src/session/input.rs` возвращает `None` для неизвестного имени, и текст
отправляется как сообщение. Никакой проверки по объявленному списку нет — «отказывать в
том, чего клиент не знает» и было исходной ошибкой: **`/compact` не работал именно потому,
что перехватывалось всё, начинающееся с `/`**, а не потому, что не хватало списка.

| ситуация | что делает chat |
|---|---|
| имя реализует rossii | обрабатывает сам |
| всё остальное (включая опечатку, рецепт, скилл) | `submitPrompt` — goose сам разберётся |
| ход идёт (`busy`) | `queuePrompt` — команда ждёт конца хода (steering не годится: `execute_command` видит только промпт хода) |

Для `/compact`, `/clear` и `/summarize` перед отправкой печатается dim-строка: goose
переписывает свою беседу, а видимый транскрипт — клиентский лог и не обновляется (см.
`HistoryReplaced` выше). Набор «переписывающих историю» команд повторяет условие самого
goose (`COMPACT_TRIGGERS.contains(..) || == "/clear"` в `agents/agent.rs`).

Список команд goose (`available_commands_update`, см. выше) читается — но **только для
`/help`** и только для показа: он не гейтит ничего. Заодно это единственный способ узнать,
какие слэш-команды есть у рецептов и скиллов пользователя (живьём в списке видны
`pi-agent-rust`, `goose-doc-guide`, `web-search`).

## 4. Изменения

- `src/acp/slash-commands.ts` — **новый**: `normalizeCommandName`, `commandRewritesHistory`,
  `parseAvailableCommands`, `formatGooseCommandNames` (чистые функции, без состояния).
- `src/acp/chat-context.ts` — поле `gooseCommands` (для `/help`).
- `src/acp/chat-stream.ts` — обработка `available_commands_update`.
- `src/acp/chat-config.ts` — `default:` в `handleCommand` → `submitGooseCommand` (отправка
  промптом, очередь при занятом ходе, заметка про переписывание истории) плюс `/help`.
- `scripts/acp-slash-commands-test.ts` — **новый**, подключён в `bun run test`.
- `AGENTS.md`, `README.md`, `README.ru.md` — описание.

Нотификации goose `_goose/unstable/session/update` (`message_usage` с `is_compaction`,
`status_message`) rossii и дальше не читает: для отображения сжатия хватает ответа
`Compaction complete` и обновлённого `usage_update` (живьём после `/compact` в статусной
строке `tokens 1374` → `174`). Это отдельная задача, не нужная для того, чтобы команда
вызывалась.

## 5. Проверка

- `bun run check`, `bun run test` (новый набор тестов включён), `npx tsc --noUnusedLocals`
  (остаются только 4 прежних предупреждения в `scripts/acp-probe.ts`, `sessions-list-test.ts`,
  `recipes.ts`).
- tmux-E2E на goose 1.57.0 (`/tmp/rossii-compact-e2e`, изоляция через `ROSSII_PROJECTS_DIR`,
  провайдер `custom_kodik`, модель `deepseek/deepseek-v4.1-flash`):
  - `/help` → список команд goose (`prompts, prompt, compact, clear, skills, doctor, goal,
    grind, status` + скиллы `pi-agent-rust`, `goose-doc-guide`, `web-search`) — значит
    `available_commands_update` доехал;
  - реальный ход → `/compact` → заметка про переписывание, `❯ /compact`, ответ
    `Compaction complete`; в `sessions.db` вместо истории лежит `# Conversation Summary …`;
    статусная строка `tokens 1374/1048576` → `174`;
  - `/status` → отчёт goose (`Context: 174 / 1048576 tokens (0%)`);
  - `/summarize` → тоже компакт (скрытый синоним, goose его не объявляет) + заметка;
  - `/clear` → `Conversation cleared`, `tokens 0/1048576`, в БД остаётся только пара
    `/clear` + ответ;
  - `/compact` во время хода → заметка, «⧗ queued for after this turn: /compact», выполнение
    после хода;
  - опечатка `/modle` → уходит промптом (модель сама объяснила, что это похоже на опечатку) —
    так ведёт себя и родной TUI goose;
  - команды rossii (`/think expand|collapse all`) — по-прежнему обрабатываются чатом, без
    обращения к модели.
