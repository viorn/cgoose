# Chat mode: точный набор расширений без `--no-profile`

- **Дата:** 2026-11-04
- **Статус:** реализовано (`src/acp/extensions.ts`, `src/acp/chat.ts`, `src/acp/custom.ts`, тесты, доки)
- **Проверено вживую:** goose **1.50.0** и **1.57.0** (сверено с исходниками `~/sources/goose`, ветка 2.0-rc)
- **Перепроверка на 1.57.0 (2026-11-04, после обновления goose):** все выводы ниже подтвердились — `[]` → ни одного
  расширения, typed builtins+mcp → ровно они (28 инструментов через `tools/list`), `mcpServers` игнорируется при
  наличии `enabledExtensions`, вложенный `_meta.goose.*` по-прежнему игнорируется, inline env по-прежнему
  отклоняется, `extensions/remove` ждёт `extensionKey` (на `name` — `missing field \`extensionKey\``),
  `session/load` по-прежнему игнорирует `enabledExtensions`

## Проблема

`goose acp` не имеет `--no-profile`, поэтому сет в chat-режиме загружался поверх профиля
(в classic-режиме `--no-profile` грузит **только** сет). Раньше cgoose просто предупреждал
об этом и не пытался исправить.

## Что выяснено экспериментом

1. **`session/new._meta.enabledExtensions` заменяет профиль, а не дополняет его.**

   | запрос | реально загружено |
   |---|---|
   | без `enabledExtensions` | профиль: `todo, skills, apps, analyze, developer, tom, summon, Extension Manager` |
   | `enabledExtensions: []` | *(ничего)* |
   | `[{type:"builtin",name:"developer"},{type:"builtin",name:"analyze"},{type:"mcp",server:{…}}]` | ровно эти три |

   Активация настоящая: `_goose/unstable/tools/list` вернул 29 инструментов, включая
   `analyze`, `edit` и `probe-mcp__*`.

2. **Ключи `_meta` читаются на верхнем уровне**, а не в `_meta.goose` (там только
   initialize-capabilities вроде `customNotifications`). Проверено:

   | meta | имя сессии | тип |
   |---|---|---|
   | `_meta.goose.sessionTitle/client` | `New Chat` | `acp` |
   | `_meta.sessionTitle/client` | `TOPLEVEL-title` | `user` |

   То есть старый код cgoose (всё внутри `_meta.goose`) **молча терял** и `sessionTitle`,
   и `client` — сессии назывались «New Chat» и были типа `acp`.

3. **`mcpServers` игнорируется, если `enabledExtensions` присутствует** (ветки в
   `initial_session_extensions` эксклюзивны) → MCP-серверы едут внутри typed-списка
   как `{type:"mcp", server}`. Дополнительно слать `mcpServers` безопасно: он нужен как
   канал совместимости для версий, которые typed-список игнорируют.

4. **inline env невыразим**: `{type:"mcp", server:{env:[{name,value}]}}` отклоняется с
   `extension env values must be passed via envKeys referencing stored secrets, not inline env`
   (и в `session/new`, и в `extensions/add`). `envKeys` разрешаются из хранилища секретов goose
   (`Configuration value not found` при отсутствии). Поэтому сет с `KEY=value` в stdio-спеке
   остаётся в fallback-режиме: `enabledExtensions` не отправляется, профиль грузится, сервер
   приходит через `mcpServers`.

5. **`session/load` игнорирует и `enabledExtensions`, и `mcpServers`** — набор берётся из
   `sessions.extension_data`. Зато на живой сессии работают:
   - `_goose/unstable/session/extensions/list {sessionId}` → `[{extension:{…}, extensionKey}]`
   - `extensions/add {sessionId, extension}` (builtin и mcp)
   - `extensions/remove {sessionId, extensionKey}` — на 1.50.0 поле `extensionKey`, в 2.0-rc `name`;
     клиент повторяет запрос при ошибке параметров.

## Реализация

- `planGooseExtensions()` (чистая функция) — строит typed-список: builtins → `{type:"builtin"}`,
  MCP → `{type:"mcp", server}`, с уникальными именами; `unsupported[]` — спеки с inline env.
- `chat.ts`:
  - **новая сессия**: `enabledExtensions = plan.extensions` (None → `[]`), `mcpServers` — всегда
    (страховка); Default-сет поле не отправляет;
  - **самопроверка** после создания: `extensions/list` сравнивается с ожидаемым; предупреждение
    только если профиль протёк или чего-то не хватает (вместо прежнего «профиль всегда грузится»);
  - **resume**: `extensions/list` → `diffExtensions` → `add`/`remove`, то есть сет применяется и
    к возобновляемой сессии (classic так не умеет). Изменения печатаются в транскрипте.
  - **resume с Default**: `session/load` возвращает сохранённый набор, а запроса «сбросить на
    профиль» у goose нет, поэтому профиль пересобирается из `config.yaml`
    (`listGooseExtensions()` → `planProfileExtensions()`) и применяется тем же diff'ом. Иначе
    сессия, созданная с None, при выборе Default оставалась без расширений.
- `developer` считается «разрешённым»: не добавляется, не удаляется и не считается утечкой.
- Сопоставление в diff — по **имени** расширения: goose нормализует ключи
  (`{type:"platform", name:"Extension Manager"}` → ключ `extensionmanager`), поэтому сравнение
  по ключу заново добавляло бы такую запись на каждом resume. Удаление — по ключу (имя поля
  отличается между версиями, см. `removeSessionExtension`).

## Побочный фикс

`_meta.sessionTitle`/`client` на верхнем уровне → сессии получают осмысленное имя и тип `user`
(видны в `goose session list`, резолвятся `--name`).

Ещё попутно: `readSetFile` в `src/cgoose-config.ts` требовал поле `name` в файле сета, хотя
документированный YAML его не содержит — теперь имя берётся из имени файла.

## Проверки

- `bun run check`, `bun run test` — зелёные (27 + 11 проверок, включая plan/diff/remove-fallback,
  пересборку профиля и сопоставление по имени).
- Живой прогон на goose 1.57.0 (проверено сценарием «None → resume → Default»):
  `new` с `[]` → `(none)`, `load` → `(none)`, diff профиля → добавлены все 9
  (`Extension Manager, analyze, apps, developer, scheduler, skills, summon, todo, tom`),
  повторный diff — no-op, обратно в None — удалены все, снова Default — добавлены все.
- TUI (tmux, без отправки промпта): сессия, созданная с None, после resume с Default печатает
  «default profile applied to the resumed session: added …», и в `sessions.extension_data`
  оказываются те же 9 расширений; resume с None удаляет всё, кроме `developer`.
- Живые прогоны через TUI (pty): None → сессия **без расширений**; сет `analyze + stdio-mcp` →
  ровно `builtin:analyze, stdio:e2e-mcp`; resume профильной сессии с None → 7 расширений удалено (после теста набор восстановлен).
- `bun run acp:smoke` обновлён: пустой `enabledExtensions` = «профиль не протёк».

## Осталось

- Проверить на goose, где `extensions/remove` ждёт `name` (2.0-rc): фолбэк покрыт offline-тестом,
  на живом 2.0-rc не прогонялся.
- Сеты с inline env по-прежнему живут в fallback-режиме; если понадобится — писать значения в
  секреты goose нельзя (чужое хранилище), остаётся вариант «пробрасывать env агент-процессу».
