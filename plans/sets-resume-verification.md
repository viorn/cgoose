# Сеты в chat-режиме: результаты живой проверки

Дата: 2026-11-04 · goose 1.57.0 · cgoose 2.2.1 · Linux, tmux + sqlite3

Проверялось утверждение «сеты полностью работают» после фикса
«Default на resume применяет профиль» (`5983040`). Все прогоны — через реальный
TUI в tmux, **без отправки промптов** (токены не тратятся), контроль — по
`sessions.extension_data` в `~/.local/share/goose/sessions/sessions.db`.

## Матрица проверок

| Сценарий | Как проверяли | Результат |
|---|---|---|
| Новая сессия, сет `Test Set` (`developer, analyze, summon`) | мастер → set → launch | `builtin:developer, analyze, summon` |
| Новая сессия, сет с builtin + stdio MCP | сет `probe-mcp`: `developer` + `echo-mcp:/usr/bin/python3 …` | `builtin:developer` + `stdio:echo-mcp`; `_goose/unstable/tools/list` → `logmcp__echo` |
| Resume: `Test Set` → `Code Review` | выбрать сет на шаге set | `removed summon` → `analyze, developer` |
| Resume с `None` | выбрать None | удалено всё, `developer` оставлен |
| Resume с `Default` | выбрать Default | профиль из config.yaml: 9 расширений (включая `scheduler`) |
| Resume с MCP-сетом | вернуть `probe-mcp` | `added echo-mcp`, сервер поднялся |
| Мастер создания сета | name/title/desc/prompt/builtins | `wiz2.yaml`: `name`, `title`, `builtins: [developer, analyze]`, `systemPrompt: Be brief.`; сессия стартует ровно с этими двумя |

Сообщения в транскрипте, которые видит пользователь:

```
set applied to the resumed session: added developer, analyze, summon
set applied to the resumed session: removed summon
default profile applied to the resumed session: added analyze, apps, Extension Manager, …
```

## Найденные особенности goose 1.57 (важно для тестов и для кода)

### 1. MCP: обязательный `server/discover` (MCP draft 2026-07-28)

Перед `initialize` goose шлёт `server/discover`:

```json
{"jsonrpc":"2.0","id":0,"method":"server/discover",
 "params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                    "io.modelcontextprotocol/clientInfo":{"name":"goose-cli","version":"1.57.0"},
                    "io.modelcontextprotocol/clientCapabilities":{"extensions":{},"roots":{},"elicitation":{}}}}}
```

Ответ должен быть `DiscoverResult` (`rmcp` 3.x):

```json
{"resultType":"complete","supportedVersions":["2026-07-28","2025-11-25"],
 "capabilities":{"tools":{}},"ttlMs":0,"cacheScope":"public",
 "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"echo-mcp","version":"0.1.0"}}}
```

Если сервер отвечает пустым результатом — `extensions/add` падает с
`Internal error (code -32603): "process quit before initialization: stderr = …"`.
Старые серверы без discover на 1.57 не грузятся.

Асимметрия ошибок: на **новой** сессии упавший MCP-сервер проглатывается молча
(просто нет его инструментов), а `extensions/add` на resume сообщает ошибку.
Поэтому «нет ошибки» на старте ещё не значит «сервер работает» — проверять
`_goose/unstable/tools/list`.

### 2. Hidden-расширения не видны в `config/extensions/list`

`_goose/unstable/config/extensions/list` фильтрует `is_hidden_extension()`.
В 1.57 hidden-ы — `scheduler` и `orchestrator`, при этом оба есть в config.yaml,
а `scheduler` ещё и `default_enabled: true`. Отсюда: профиль для Default
пересобирается из config.yaml, а не из RPC.

### 3. Поля и формы, на которые легко наступить

- `session/extensions/list` → `GooseExtension[]` без ключей и без `enabled`:
  сравнивать только по **имени** (goose нормализует: `Extension Manager` →
  `extensionmanager`), удалять — по ключу.
- `session/extensions/remove`: 1.50/1.57 ждут `extensionKey`, main/2.0-rc — `name`
  (клиент пробует оба).
- `session/extensions/add` со stdio: `env` **обязателен**, но допускается только
  пустой массив (`env: []`); значения — лишь через `envKeys` из секретов goose.
  Без `env` — `data did not match any variant of untagged enum McpServer`.
- Сет с inline env (`K=V` в stdio-спеке) → fallback: `enabledExtensions` не
  отправляется, на resume набор не пересобирается.

### 4. Битый YAML сета исчезает молча

`description: live test: ...` без кавычек → `js-yaml` бросает
`bad indentation of a mapping entry`, `listSessionSets()` глотает исключение и
сет просто не появляется в списке. Кандидат на фикс: предупреждение при старте.

## Инструменты проверки

- TUI: `tmux new-session -d … 'CGOOSE_NO_WORKTREE=1 bun src/index.ts'`,
  `tmux send-keys`, `tmux capture-pane -p`. Пошагово, с паузами 2–3 с (см. скилл
  `.goose/skills/tmux-test-skill`).
- Сессии: `sqlite3 ~/.local/share/goose/sessions/sessions.db "select extension_data from sessions where id='…'"`.
- Протокол без TUI: `bun scripts/acp-probe.ts`, `bun scripts/acp-client-smoke.ts`.
- Чистка после тестов: удалить строки сессий из `sessions.db`, файлы сетов из
  `~/.config/cgoose/sets/`, метаданные проекта из `~/.config/cgoose/projects/`,
  временные каталоги.

## Итог

Сеты работают целиком: создание, применение на новой сессии, переключение на
resume (именованный сет / None / Default), MCP-расширения в сете (новые и при
resume), системный промпт. Открытые ограничения — inline env, classic-режим
(набор на resume не меняется) и молчаливое выпадение битых YAML-сетов.
