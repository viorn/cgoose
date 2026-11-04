# Ревью: фича «ACP + TUI» (chat mode)

- **Дата:** 2026-11-03
- **Область:** `src/acp/{client,custom,types,chat}.ts`, `src/launcher.ts` (`launchGooseAcp`),
  `src/index.ts` (флаги `c/mc/wc/ac/nc/sc/ca/cn/cs`), `scripts/acp-{probe,client-smoke}.ts`
- **Статус:** только анализ, код не менялся (рабочее дерево идентично HEAD).

## Как проверялось
- `bun run check` (tsc strict) — проходит.
- Установленный goose — **1.57.0**; подтверждены `goose acp --with-builtin` и формат
  `--with-extension '[name:]ENV=val cmd args…'` (имя опционально, при отсутствии берётся
  имя команды-лаунчера).

## Сильные стороны
- Транспорт `client.ts` корректен: NDJSON с буфером, pending-мапа с таймаутами, разбор
  response/request/notification, `failPending` при exit/error, `stop()` с graceful shutdown + SIGKILL
  fallback, обработка `spawn error`.
- Чистое разделение слоёв: `client.ts` / `custom.ts` / `chat.ts` / `types.ts`;
  `prepareLaunch()` шарится между classic и ACP режимами.
- «Сет — source of truth» для промпта: на resume переприменяется текущий сет, «None» чистит
  через `mode:"set", text:""` — консистентно с classic `--system ""`.
- Честное предупреждение, что на 1.57 `enabledExtensions` игнорируется и «None» не скрывает
  расширения профиля.
- Фолбэк на classic TUI при отсутствии `goose acp`; проверка `supportsLoadSession()` перед resume.

---

## Находки

### Высокий приоритет

1. **Спиннер `thinking…` не рендерится и крутит лишний рендер.**
   `chat.ts:437` создаёт `Loader`, но он **не добавлен в дерево** (`tui.addChild(loader)`
   отсутствует) → невидим (в pi-tui компонент рендерится только как child). При этом конструктор
   `Loader` вызывает `setIndicator()` → `start()` → `setInterval(80ms)` + `ui.requestRender()` на
   каждом тике; `stop()` зовётся только в `finishTurn`/`onExit`/`shutdown`. Итог: индикатора нет,
   а приложение холостым ходом ре-рендерится ~12×/с до первого сообщения.

2. **`parseStdioSpec` молча выбрасывает stdio-специи без `name:`.**
   `chat.ts:112`: `if (colonIdx === -1) return null`. Но имя в `--with-extension` опционально,
   и визард сам подсказывает формат без имени (`index.ts` placeholder
   `"mcpls --trust-project-config, npx -y @some/mcp-server"`, пример в `AGENTS.md`). В classic
   такие специи работают, в chat — не попадают ни в `enabledExtensions`, ни в `mcpServers`, т.е.
   **расширение тихо не поднимается**. Парсер также хрупок: при `:` в самой команде (URL/порт)
   «именем» станет всё до двоеточия.

3. **Текст ассистента, разорванный tool-call’ом, склеивается в неправильном порядке.**
   В ветках `tool_call`/`tool_call_update` (`chat.ts:344`) вызывается только `closeThought()`,
   а `currentMd` не сбрасывается. Текст до и после tool-call пишется в один блок, добавленный в
   дерево **до** tool-строки → пост-tool текст визуально оказывается **выше** самого tool-call.

4. **`user_message_chunk` не обрабатывается — resume не восстанавливает реплики пользователя.**
   В `switch` (`chat.ts:319`) нет этой ветки. При `session/load` goose реплеит историю, и
   сообщения пользователя теряются (в `scripts/acp-probe.ts` `user_message_chunk` уже в
   `UPDATE_KINDS`). Дополнительно: `currentMd`/`streamBuffer` сбрасываются только в `finishTurn`,
   которого при resume нет, — текст ассистента склеится в один блок без разделителей.
   (Стоит подтвердить на реальном resume.)

5. **Esc при незанятом вводе безусловно завершает чат.**
   `chat.ts:462-473`: при `!busy` любой Esc → `shutdown()`. Esc во время набора (и когда открыт
   autocomplete Editor) не закрывает меню, а **выходит и теряет черновик**.

### Средний / низкий приоритет

6. **`finishTurn` может выполниться дважды**: `finish()` вызывается и из `onSelect`, и из
   `cancelPendingPermission` (если turn завершился при открытом permission-overlay).
   `resolve`/`hideOverlay`/`setFocus` идемпотентны, но стоит защитить флагом.
7. **Разбор stderr по чанкам** (`client.ts:105`): `chunk.split("\n")` без буфера рвёт строки на
   границе событий → обрывки в `stderrTail` (диагностика «агент упал» может врать).
8. **Таймаут запроса не шлёт cancel** (`client.ts:234`): по истечении 30с просто `reject`, без
   `session/cancel`.
9. **Двойная передача расширений**: stdio/http идут и в `mcpServers`, и в
   `_meta.goose.enabledExtensions`. На 1.57 второе игнорируется — ок, но на новых версиях это
   потенциальный дубль-регистр.
10. **Мёртвый API в `custom.ts`**: `addSessionExtension`/`removeSessionExtension`/`renameSession`/
    `truncateSessionConversation` не используются нигде, `listSessionExtensions` — только в
    smoke-скрипте.
11. **Мелочи `chat.ts`**: `if (!tui || exiting)` — `tui` всегда truthy (мёртвый гвард);
    `parseHttpSpec` игнорирует `timeout=`; `ToolLine.status` не читается; `flushStream` не дёргает
    `requestRender` при обновлении thought-блока.
12. **Безопасность `fs/write_text_file`** (`chat.ts:286`): запись по любому пути, который попросит
    агент, без песочницы — при prompt-injection агент может писать вне worktree (для ACP ожидаемо,
    но стоит зафиксировать в доках).

### Документация и тесты

13. **README / README.ru не описывают chat mode вообще** (при подробном разделе в `AGENTS.md`).
14. **Шапка CLI-флагов в `src/index.ts:5-19` не содержит `c`/`mc`/`wc`/`ac`/`nc`/`sc`** —
    единственный перечень флагов устарел.
15. **Нет автотестов** — только ручные `scripts/acp-*.ts`, требующие живого goose+провайдера.
    Наиболее тестируемые юниты (`parseStdioSpec`, `buildEnabledExtensions`, `buildMcpServers`)
    не экспортированы.

---

## Рекомендации (по возрастанию объёма)
- Показывать спиннер: добавить `Loader` в дерево **или** не создавать его до первого промпта
  (устраняет и находку 1).
- Починить `parseStdioSpec`: имя опционально, выводить из basename команды (находка 2).
- Ввести `closeMessage()` и звать его в `tool_call`/`tool_call_update` (находка 3).
- Обрабатывать `user_message_chunk` (находка 4).
- Esc не завершать при непустом черновике/открытом автокомплите (находка 5).
- Вынести чистые функции парсинга/сборки расширений в отдельный модуль и покрыть юнит-тестами.

## Итог
Архитектура и транспорт — на хорошем уровне, критичных гонок/утечек не видно; основные проблемы
сосредоточены в UI-слое `chat.ts` (рендер транскрипта, спиннер, обработка Esc) и в парсере
stdio-специй.
