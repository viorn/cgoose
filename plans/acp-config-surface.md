# ACP: поверхность конфигурации goose 1.57.0

- **Дата:** 2026-11-04
- **Статус:** исследование завершено, список собран (реализация TUI-переключения — следующий этап)
- **Проверено вживую:** goose **1.57.0** (бинарь `~/.local/bin/goose`), скрипты
  `scripts/acp-config-options-probe.ts` и `scripts/acp-config-surface-probe.ts` (без LLM-токенов)
- **Контекст:** нужно дать cgoose возможность менять сессию, провайдера, модель и набор прямо
  во время ACP-сессии через TUI. Для этого выяснялось, какие конфиги вообще доступны через ACP.

## 1. Конфиги уровня сессии (стандартный ACP, `configOptions`)

Единственные параметры, которые goose отдаёт как `configOptions` и меняет через
`session/set_config_option`. Проверено живьём (`scripts/acp-config-options-probe.ts`):

| id | тип | категория | значений | что это |
|---|---|---|---|---|
| `provider` | select | — | 88 | провайдер (ваш конфиг + каталог) |
| `model` | select | `model` | зависит от провайдера | модель текущего провайдера |
| `mode` | select | `mode` | 4 | режим работы (auto и др.) |
| `thinking_effort` | select | `thought_level` | 5 | глубина размышлений |

`configOptions` приходят в ответе на:
- `session/new` — ✅ (4 опции);
- `session/load` — ✅ (те же 4; cgoose раньше выбрасывал этот ответ, из-за чего меню пустело);
- `session/set_config_option` — ✅ (обновлённые опции; после смены провайдера список моделей другой).

Стандартный ACP также имеет `session/set_mode` (в строках бинаря есть и он, и `set_config_option`).

## 2. Кастомные RPC goose (`_goose/unstable/...`)

### Расширения
- `config/extensions/list` — все платформенные расширения + `enabled` + `configKey`.
- `config/extensions/add`, `config/extensions/remove`, `config/extensions/set-enabled`.
- `session/extensions/list` — набор расширений конкретной сессии.
- `session/extensions/add`, `session/extensions/remove`.

### Промпты / персона
- `config/prompts/list` — шаблоны (`system.md` и др.) с `defaultContent`.
- `config/prompts/get`, `config/prompts/save`, `config/prompts/reset`.
- `session/system-prompt/set` — уже используется cgoose.

### Провайдеры и модели
- `providers/catalog/list` — 88 провайдеров: id, name, format, apiUrl, modelCount, docUrl, envVar.
- `providers/setup/catalog/list` — каталог для UI настройки: category, setupMethod, fields, aliases.
- `providers/config/status` — по каждому провайдеру `isConfigured`.
- `providers/config/read` — конфиг провайдера (требует параметры).
- `providers/config/save`, `providers/config/delete`, `providers/config/authenticate`.
- `providers/custom/create`, `read`, `update`, `delete`.
- `providers/secrets/list`, `providers/secrets/delete`.
- `providers/supported-models/list` — модели провайдера (требует параметры).
- `providers/readiness/check` — проверка готовности (требует параметры).
- `providers/inventory/refresh`, `providers/canonical-model-info`.
- `providers/authentication/device-code`.

### Пользовательские предпочтения
- `preferences/read` — `autoCompactThreshold`, `gooseThinkingEffort`, `voiceAutoSubmitPhrases`,
  `voiceDictationProvider`, `voiceDictationPreferredMic`.
- Метода записи в строках бинаря нет — похоже, только чтение; запись через конфиг-файл.

### Права инструментов
- `tools/permissions/set` (требует параметры).

### Состояние сессии (не только configOptions)
- `session/working-dir/update`, `session/project/update`, `session/update`, `session/steer`.
- `session/conversation/truncate`, `session/unarchive`, `session/recipe/request-params`.
- `session/live-voice/start`, `stop`, `availability`.

### Локальный инференс
- `local-inference/models/list`, `download`, `download/progress`, `download/cancel`, `delete`, `evict`.
- `local-inference/models/settings/read`, `settings/update`.
- `local-inference/huggingface/search`, `huggingface/repo/variants`.
- `local-inference/chat-templates/builtin/list`.

### Диктовка
- `dictation/models/list`, `download`, `download/progress`, `cancel`, `delete`.
- `dictation/transcribe`.

### Расписания
- `schedules/run-now`, `unpause`, `running-job/inspect`, `running-job/kill`, `sessions/list`.

### Онбординг / импорт
- `onboarding/import/scan`, `onboarding/import/apply`.

### Команды и упоминания
- `slash-commands/list` — доступные слэш-команды (prompts, compact, clear, skills, doctor…).
- `agent-mentions/list` — агенты для упоминаний (в пробе пусто).
- `recipes/slash-command`.

## 3. Жизненный цикл сессий (стандартный ACP)

`session/new`, `session/load`, `session/list`, `session/delete`, `session/fork`, `session/resume`,
`session/close`, `session/export`, `session/rename`, `session/archive`,
`session/chat_history_search`, `session/import_formats/{mod,pi}`.

## 4. Конфиги на диске

| Путь | Содержимое |
|---|---|
| `~/.config/goose/config.yaml` | расширения (`extensions.*.enabled`) и их настройки |
| `~/.config/goose/permission.yaml` | разрешения инструментов (`user.always_allow/ask_before/never_allow`) |
| `~/.config/goose/secrets.yaml` | секреты провайдеров (`CUSTOM_KODIKROUTER_API_KEY` и т.п.) |
| `~/.config/goose/custom_providers/*.json` | кастомные провайдеры |
| `~/.config/cgoose/config.json` | настройки cgoose (`default_mode`) |
| `~/.config/cgoose/sets/*.yaml` | наборы cgoose (system prompt + extensions) |
| `~/.config/cgoose/projects/*.json` | память по директориям |

## 5. Что нужно для TUI-фичи «менять всё в чате»

- **Провайдер/модель/mode/thinking_effort** → `session/set_config_option`.
  Уже реализовано в cgoose, включая обновление `configOptions` после смены.
- **Набор** → в ACP нет единого «set», это композиция:
  - `session/system-prompt/set` — промпт (уже реализовано);
  - `session/extensions/list` + `add`/`remove` — расширения;
  - `config/extensions/list` — что вообще доступно.
  Реконсиляция через `session/extensions/*` реализована: `planForSet()` пересобирает набор
  (включая `extensions:` из config.yaml через `buildExtensionArgs`) и применяет разницу.
- **Сессия** → `session/list`/`load`/`new`/`rename`/`fork` — всё реализовано;
  fork возвращает `NewSessionResponse` (проверено `scripts/acp-fork-probe.ts`).
- **Список провайдеров для меню** → `providers/config/status` (88 провайдеров с `isConfigured`)
  или `configOptions.provider.options`.
- **Список моделей для меню** → `configOptions.model.options` (текущий провайдер) или
  `providers/supported-models/list` (требует параметры).

## 6. Чем проверять

```bash
bun scripts/acp-config-options-probe.ts   # configOptions в new/load/set_config_option
bun scripts/acp-config-surface-probe.ts   # живые ответы кастомных config-методов
```

Оба скрипта не вызывают `session/prompt`, поэтому не тратят LLM-токены.
