# Ревью: фича «ACP + TUI» (chat mode) — консолидированное

- **Дата:** 2026-11-04
- **База:** `HEAD = eaec49e` (после v1.11.1 + chat-фиксы), `bun run check` на HEAD — **зелёный**
- **Рабочее дерево:** незакоммиченный рефакторинг `src/acp/extensions.ts` + правки `src/acp/chat.ts`.
  На момент ревью `bun run check` **падает**:
  `src/acp/chat.ts(491,31): error TS2552: Cannot find name 'buildEnabledExtensions'`
- **Сверено с:** `plans/acp-mode-review.md` (v1), `plans/acp-mode-review2.md`, `plans/acp-mode-review3.md`
- **Живой goose:** 1.57.0 (`goose acp --help` поддерживает только `--with-builtin` и `--enable-scheduler`)
- **Проверено:** чтение `src/acp/*`, `launcher.ts`, `index.ts`, `scripts/*`; ACP-схема
  (agentclientprotocol.com); API `@earendil-works/pi-tui@1.5.0`; `goose session --help` /
  `goose acp --help`; `tsc`. Живые прогоны `acp-probe` / `acp-client-smoke` **не запускались**
  (создают сессии и тратят токены) — пункты, требующие runtime-подтверждения, помечены 🧪.

---

## 1. Сверка с `acp-mode-review3.md`

| # | Находка review3 | Статус на HEAD | Комментарий |
|---|---|---|---|
| 1 | `Loader` не добавлен в дерево, крутит лишний рендер | **Актуально** | `chat.ts:463` создаёт `Loader`; `tui.addChild(loader)` нет ни на HEAD, ни в рабочем дереве. Конструктор вызывает `setIndicator()` → `start()` → `setInterval(80ms)` + `requestRender()` |
| 2 | `parseStdioSpec` выбрасывает специи без `name:` | **Актуально** | `chat.ts:112-114` (`if (colonIdx === -1) return null`). Имя в `--with-extension` опционально — подтверждено `goose session --help`. В незакоммиченном `extensions.ts` исправляется, но с новыми дефектами (см. §5) |
| 3 | Текст, разорванный tool-call'ом, склеивается | **Исправлено** | `closeMessage()` (`chat.ts:304-311`) + вызов в `tool_call`/`tool_call_update` (`chat.ts:371`) |
| 4 | `user_message_chunk` не обрабатывается | **Актуально** | Ветки нет в `switch` (`chat.ts:343-400`), хотя тип есть в `types.ts:151`. Дополнительно: не читается `messageId`, из-за чего при replay склеиваются и сообщения ассистента |
| 5 | Esc при пустом вводе завершает чат, теряя черновик | **Актуально** | `chat.ts:489-500`; глобальный input-listener срабатывает раньше `Editor`, поэтому не закрывается и автокомплит |
| 6 | `finishTurn` может выполниться дважды | **Не подтверждается** | `finish()` сам обнуляет `permissionActive` и `cancelPendingPermission` (`chat.ts:212-218`), а `SelectList` вызывает либо `onSelect`, либо `onCancel`. Двойного резолва нет |
| 7 | stderr парсится по чанкам, рвёт строки | **Актуально** | `client.ts:105-109` |
| 8 | Таймаут запроса не шлёт `session/cancel` | **Актуально** | `client.ts:235-243` |
| 9 | Двойная передача расширений (`mcpServers` + `enabledExtensions`) | **Актуально на HEAD** | `chat.ts:543` + `chat.ts:549`. В рефакторинге `enabledExtensions` убирают — надо не потерять канал для будущих goose |
| 10 | Мёртвый API в `custom.ts` | **Актуально** | `add/removeSessionExtension`, `renameSession`, `truncateSessionConversation` не используются. `removeSessionExtension` пригодился бы для принудительной семантики сета |
| 11 | Мелочи `chat.ts` (мёртвый guard, `parseHttpSpec` без `timeout`, `ToolLine.status`, thought без render) | **Актуально** | `chat.ts:211`, `132-137`, `132-134`, `288-290` |
| 12 | `fs/write_text_file` без песочницы | **Актуально** | `chat.ts:286-291` |
| 13 | README/README.ru не описывают chat mode | **Актуально** | `grep` по README — ни одного упоминания ACP/`-c` |
| 14 | Шапка флагов в `index.ts` без `c/mc/wc/ac/nc/sc` | **Устарело** | Шапка уже содержит chat-флаги: `index.ts:22-29` (добавлено в 492e119) |
| 15 | Нет автотестов, парсеры не экспортированы | **Частично** | В рефакторинге `extensions.ts` экспортирует парсеры, но `scripts/acp-extensions-test.ts`, на который ссылается шапка файла, отсутствует |

**Вывод по review3:** 10 из 15 находок актуальны, одна (№3) исправлена, одна (№6) не подтверждается,
одна (№14) устарела, одна (№15) закрыта частично. Главные пропуски review3 — завершение агента
(§2.1), семантика сетов на 1.57 для **любого** сета (§2.3) и сценарий worktree+quick-new (§3.8).

---

## 2. Блокирующие

### 2.1. После падения агента чат превращается в ловушку

`chat.ts:209-220` (`onExit`) ставит `busy = false` и печатает сообщение, но не помечает агент мёртвым
и не выключает ввод. Далее:

- отправка → `submitPrompt` (`chat.ts:465`) → `client.prompt`;
- `client.ts:286-289` вызывает `request(..., timeoutMs = 0)` — таймаута нет;
- `client.ts:212-215` (`send`) пишет в уничтоженный `stdin`, ошибка никуда не пробрасывается
  (проверено: запись в stdin завершившегося child не бросает и не вызывает `error`);
- промис не резолвится → `busy` навсегда `true`, `editor.disableSubmit = true` (`chat.ts:476`);
- Esc/Ctrl+C при `busy` вызывают только `client.cancel` → снова мёртвый stdin.

Выход — только `kill` процесса снаружи.

**Фикс:** флаг `agentDead` в `onExit`; отказ в `onSubmit`; проверка
`exiting || child.exitCode !== null || !child.stdin?.writable` в `send()` с reject;
Esc завершает чат при `agentDead` независимо от `busy`; watchdog на `prompt`.

### 2.2. Resume не восстанавливает историю корректно

`session/load` по ACP-спеке стримит всю историю через `session/update`, включая сообщения
пользователя. В `switch` (`chat.ts:343-400`) ветки `user_message_chunk` нет (`types.ts:151`):

- реплики пользователя не отображаются;
- все `agent_message_chunk` реплея попадают в один `currentMd` (сбрасывается только в
  `finishTurn`, которого при replay нет) → сообщения ассистента склеиваются;
- `messageId` («change in messageId indicates a new message has started») не читается.

**Фикс:** ветка `user_message_chunk` (закрывать текущий блок, рендерить реплику пользователя),
закрытие `currentMd` при смене `messageId`, визуальные разделители ходов. 🧪 проверить на длинной
сессии.

### 2.3. В chat mode сет не является source of truth на goose 1.57

`goose acp --help` на 1.57.0 **не поддерживает `--no-profile`** — только `--with-builtin`.
`_meta.goose.enabledExtensions` на 1.57 игнорируется. Следствия:

- «None» не скрывает расширения профиля;
- сет с `builtins`/`stdio` работает **аддитивно** к профилю, а не вместо него;
- расходится с classic-режимом и с разделом «Session Sets» в `AGENTS.md`
  («Any set (and None) is launched with --no-profile: only what the set lists is loaded»).

Код предупреждает только про None (`chat.ts:557-562`), хотя проблема касается **любого**
не-Default сета.

**Фикс:** либо честное предупреждение для всех не-Default сетов + правка доков, либо
принудительное приведение сессии к сету через `listSessionExtensions` +
`removeSessionExtension` (`custom.ts:59-77`, уже реализовано, не используется). Второй путь 🧪.

### 2.4. stdio-специи без имени молча теряются (HEAD)

`chat.ts:112-114` требует `name:`, хотя:

- `goose session --help`: «Format: `'[name:]ENV1=val1 … command args...'`» — имя опционально;
- cgoose сам документирует формат без имени: `src/cgoose-config.ts:59`,
  `src/index.ts:265` (placeholder `mcpls --trust-project-config, npx -y @some/mcp-server`),
  `AGENTS.md`.

В classic такие специи работают, в chat — тихо не попадают ни в один канал. Плюс при `:` в
аргументе (URL/порт) «именем» станет всё до двоеточия.

---

## 3. Существенные

### 3.1. Спиннер `thinking…` невидим и крутит лишний рендер
`chat.ts:463` — `Loader` не добавлен в дерево; `start()` вызывается из конструктора.
**Фикс:** `tui.addChild(loader)` + ленивый запуск, либо `loader.stop()` сразу после создания.

### 3.2. Сбой опционального system-prompt убивает чат
`chat.ts:580-585` внутри общего `try`; `catch` (`:587`) ставит `setupFailed = true`. Метод
`_goose/unstable/*` версионно-чувствителен: сессия создана и работоспособна, но пользователь видит
«ACP setup failed» и не может писать.
**Фикс:** отдельный `try/catch` — предупредить и продолжить.

### 3.3. Permission-запросы обрабатываются в один слот
`chat.ts:241-242`: один `permissionActive` и один `cancelPendingPermission`. При двух
`session/request_permission` второй перезапишет оверлей и колбэк; первый промис останется без
ответа. `onExit` не резолвит висящий permission и не прячет оверлей.
**Фикс:** очередь/стек pending-permission, резолв всех при `finishTurn`/`onExit`/`shutdown`.

### 3.4. Esc выходит из чата с черновиком и открытым автокомплитом
`chat.ts:489-500`: при `!busy` любой Esc → `shutdown()`. Глобальный listener срабатывает раньше
фокусированного `Editor` (`tui.js:719-734`), поэтому меню автокомплита не закрывается, а черновик
теряется. Ctrl+C перехвачен глобально — редактор его никогда не получает.
**Фикс:** выходить только при пустом редакторе и закрытом автокомплите (или двойной Esc).

### 3.5. `fs/read_text_file` игнорирует `line`/`limit`
`chat.ts:281-284` читает файл целиком; ограничения размера нет. 🧪
**Фикс:** реализовать диапазон и верхний лимит.

### 3.6. Таймауты и отмена запросов
`newSession`/`loadSession` — 60 с (`client.ts:277,281`): при нескольких MCP-серверах (npx/uvx
download) или длинном replay может не хватить. `prompt` без watchdog. По таймауту `session/cancel`
не отправляется (`client.ts:235-243`) → агент может продолжать работу.
**Фикс:** увеличить/сделать настраиваемыми setup-таймауты, отменять при таймауте, watchdog на prompt.

### 3.7. `usage_update.cost` читается не по спеке
`chat.ts:388-393`: `update.cost?.total ?? update.cost?.totalCost`, но в ACP `Cost` — это
`{ amount: number, currency: string }`. Стоимость не отображается никогда; `$` захардкожен.
**Фикс:** `cost.amount` + `cost.currency`; типизировать `UsageUpdate.cost` (`types.ts:198`).

### 3.8. Worktree и resume для quick-new (`nc`/`cn`)
`index.ts:487`: в `mode === "new"` `sessionName` пустой. `prepareLaunch` создаёт worktree под
сгенерированным cgoose именем, goose авто-именует сессию (`sessionTitle: undefined`,
`launcher.ts:358`). На resume `sessionDisplayName` — имя goose → `getSessionWorktreePath()` не
находит worktree, и `session/load` получает `cwd` = корень репозитория.
Pre-existing для classic, но в chat опаснее: `session/load` принимает `cwd`, инструменты могут
работать не там. 🧪
**Фикс:** генерировать имя в quick-new и передавать его и в worktree, и в `sessionTitle`.

### 3.9. Гонка в `AcpClient.stop()`
`client.ts:292-302`: проверка `exitCode` → `stdin.end()` → регистрация `once("exit")`. Если процесс
умрёт между проверкой и подпиской, событие потеряется и `await exited` повиснет.
**Фикс:** регистрировать промис до `stdin.end()` и повторно проверять `exitCode`.

### 3.10. Безопасность `fs`-хендлеров
`chat.ts:281-291`: чтение любого пути, запись любого пути с созданием каталогов. Для ACP ожидаемо
(клиент доверенный), но cgoose рекламирует `fs.*`, и при prompt injection через MCP агент может
читать/писать вне worktree. Как минимум — зафиксировать в доках; лучше — ограничить `cwd`/worktree
или спрашивать подтверждение на запись вне него.

### 3.11. `wc` и конфиг `default_mode: "no-worktree"`
`index.ts:383` не учитывает `wc` в `forceWorktree`. Ветка `wc` (`:408`) ставит
`CGOOSE_FORCE_WORKTREE=1`, но проверка конфига (`:414-418`) при `forceWorktree = false` и
`noWorktree = false` снова выставляет `CGOOSE_NO_WORKTREE=1` и `noWorktree = true`. `prepareLaunch`
force уважает (worktree создастся), но локальный `noWorktree` останется `true` → список сессий не
учитывает worktree-каталоги (`inRepo = !noWorktree`).
**Фикс:** включить `wc` в первичное определение `forceWorktree` либо пропускать config-ветку при
`CGOOSE_FORCE_WORKTREE=1`.

---

## 4. Мелочи и гигиена

- **stderr по чанкам** (`client.ts:105-109`): нет line-buffer, диагностика падения агента может врать.
- **`auth_required` не обрабатывается:** `initialize` игнорирует `authMethods`, метода
  `authenticate` нет. Для OAuth-провайдеров — общий «ACP setup failed».
- **`protocolVersion` не валидируется** (`client.ts:261-267`): по спеке клиент должен отключиться
  при несовместимой версии.
- **`customNotifications: true`** рекламируется (`chat.ts:536`), но уведомления кроме
  `session/update` отбрасываются (`client.ts:163-170`). Убрать capability или обрабатывать.
- **`closeThought()` не флашит буфер** (`chat.ts:297-302`) — последние ~50 мс thinking теряются;
  `flushStream` не вызывает `requestRender` при обновлении только thought-блока (`chat.ts:288-290`).
  Сейчас маскируется тиками `Loader`'а; после починки §3.1 станет видно.
- **`turnError` теряется**, если уже есть `currentMd` (`chat.ts:449-452`).
- **`ToolLine.status`** хранится, но не используется; `session_info_update` (`chat.ts:395`) вызывает
  `renderStatus`, хотя title нигде не отображается.
- **TDZ-риск в `onExit`:** `chat.ts:209-219` ссылается на `tui`/`loader`/`busy` до их объявления.
  Безопасно только потому, что до первого `await` события не приходят; guard `if (!tui …)` мёртвый
  (реальное срабатывание дало бы `ReferenceError`). Вынести создание UI до `spawn`.
- **`runAcpChat` завершается `await new Promise(() => {})`** (`chat.ts:601`): при EOF терминала без
  `shutdown()` процесс повиснет и оставит агента.
- **`gooseAcpSupported()`** — синхронный `execSync` до 5 с (`launcher.ts:295-306`), фриз после
  подтверждения запуска.
- **Производительность:** `Markdown.setText()` перепарсивает весь текст на каждый flush (O(n²) на
  длинном ответе); `transcript` растёт без ограничений.
- **Smoke-тест `enabledExtensions`** (`scripts/acp-client-smoke.ts:77-100`) не изолирует канал:
  проверяется только наличие `developer`, который может быть в дефолтном профиле; комментарий
  обещает «only enabled extension». Нужен builtin, отсутствующий в профиле, и проверка отсутствия
  профильных. Smoke/probe создают сессии и не удаляют их.
- **Доки:** `AGENTS.md:102`, `launcher.ts:12,335`, `chat.ts:10` всё ещё описывают отправку
  `_meta.goose.enabledExtensions`; `README.md`/`README.ru.md` не описывают chat mode и флаги
  `c/ac/nc/sc/mc/wc`; раздел «Session Sets» в `AGENTS.md` обещает `--no-profile` для любого сета —
  для chat mode неверно.
- **Версия:** `package.json` = `1.11.0`, хотя коммит `492e119` назван `v1.11.1`.
- **Нет автотестов:** `extensions.ts` — чистые функции, идеальны для юнит-тестов.

---

## 5. Незакоммиченный рефакторинг `src/acp/extensions.ts`

Направление верное (парсинг вынесен из UI, имя стало опциональным), но в текущем виде коммитить
нельзя:

1. **Не компилируется:** `chat.ts:491` вызывает удалённый `buildEnabledExtensions`.
   Нужно убрать вызов и `enabledExtensions` из `newSession` либо вернуть функцию.
2. **Эвристика `!trimmed.includes("://")` слишком широкая** (`extensions.ts:38`): спека
   `fetch:uvx mcp-server-fetch --url https://…` содержит `://` → имя `fetch` не распознается,
   командой станет `fetch:uvx`. Проверять надо, что именно двоеточие не начало `://`.
3. **`commandToName` для URL даёт последний сегмент пути** (`extensions.ts:16-20`):
   `https://a.com/mcp` и `https://b.com/mcp` → оба `mcp`. Для HTTP лучше host+path (как на HEAD)
   или стабильный суффикс.
4. **Коллизии имён для stdio:** `npx -y server-a` и `npx -y server-b` → оба `npx`; то же для
   `uvx`, `python`, `docker`. Goose в classic различает по полной командной строке. Нужен dedup в
   `buildMcpServers`.
5. **Удаление `enabledExtensions`** требует синхронного обновления `AGENTS.md`, шапок
   `launcher.ts`/`chat.ts` и smoke-теста.
6. **Шапка `extensions.ts` ссылается на несуществующий** `scripts/acp-extensions-test.ts`.

---

## 6. Что проверить вживую 🧪

1. `bun scripts/acp-client-smoke.ts` на goose 1.57 — реально ли `mcpServers` поднимает stdio/http;
   переписать проверку `enabledExtensions` так, чтобы она не проходила за счёт профиля.
2. Resume длинной сессии: видны ли реплики пользователя, разделены ли сообщения ассистента.
3. Сет с builtin/stdio на 1.57: `extensions/list` — только сет или профиль + сет.
4. `nc` → выйти → `ac`: резюмится ли сессия в worktree, а не в корне репозитория.
5. Permission: два параллельных tool call — не зависает ли один запрос.
6. `kill` процесса `goose acp` → можно ли выйти из TUI, не виснет ли ввод.

---

## 7. Порядок исправлений

1. **Не-зависающий UI:** §2.1 (agent exit), §3.1 (loader), §3.4 (Esc), §3.3 (permission-очередь).
2. **Корректность истории и сетов:** §2.2 (replay/`user_message_chunk`), §2.3 (семантика сета на
   1.57 + предупреждение), §2.4 (специи без имени).
3. **Довести рефакторинг:** §5 п.1-4, зелёный `bun run check`, юнит-тесты `extensions.ts`.
4. **Функциональные детали:** §3.2, §3.5-§3.11.
5. **Гигиена:** §4 (доки, smoke, версия, README).
