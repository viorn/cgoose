# cgoose — Контекст для агентов

> **⚠ Протестировано только на Linux.** Может работать на macOS. Windows не поддерживается.

## Обзор

cgoose — TUI-обёртка над CLI `goose session`. Он запускает Goose — а не заменяет его.

## Ключевые факты для агентов

- Живёт в рабочей директории пользователя, запоминает настройки **по директории** (`~/.config/cgoose/projects/<dir>-<hash>.json`)
- Читает `~/.config/goose/config.yaml` для включённых провайдеров
- Читает `~/.config/goose/custom_providers/*.json` для кастомных провайдеров (engine, baseUrl, authToken)
- **Session set'ы** (`~/.config/cgoose/sets/<name>.json`) заменяют рецепты как основной способ объединения системного промпта + встроенных расширений. Рецепты по-прежнему находятся через `goose recipe list --format json`, но cgoose всегда запускает через `goose session` (никогда `goose run --recipe`)
- История set'ов хранится по проектам (как история провайдеров/моделей), последний использованный показывается сверху
- Системные промпты сессий сохраняются по сессиям в project meta (`sessionPrompts`), поэтому при resume всегда используется *оригинальный* промпт, с которым сессия была создана — даже если определение set'а позже изменилось
- При новой сессии промпт set'а передаётся через `--system`, builtins через `--with-builtin` + `--no-profile`
- Секреты разрешаются из: env vars → системная связка ключей → `~/.config/goose/secrets.yaml` → JSON-конфиги
- Конфиг: `~/.config/cgoose/config.json` — поддерживает `default_mode` (`"worktree"` или `"no-worktree"`)

## Workflow визарда (6 шагов)

Визард TUI имеет 6 шагов, каждый с `initialValue` = последнему использованному:

1. **session** — выбрать существующую сессию или создать новую. `initialValue` на последнюю-новую
2. **session_name** — ввести имя (Enter = авто-имя из сгенерированного префикса)
3. **set** — последний использованный set **первым** (`❶`), затем None, затем история + по алфавиту, плюс опции создания/управления set'ами. `initialValue: lastSet`
4. **provider** — отсортирован по истории, затем по алфавиту. `initialValue: lastProviderRaw`
5. **model** — последняя использованная (`✦`), затем история, настроенные модели, ручной ввод/fetch. `initialValue: lastModel / defaultModel`
6. **launch** — подтверждение сводки

**Enter на каждом шаге = resume с теми же set/провайдером/моделью, что и последняя сессия.**

Если project meta ещё нет, выбирается первый вариант (None → первый провайдер → первая модель).

## Session Set'ы

Session set — JSON-файл в `~/.config/cgoose/sets/<name>.json`:

```json
{
  "title": "My Set",
  "systemPrompt": "Инструкции для агента...",
  "builtins": ["developer", "analyze", "memory"]
}
```

- `systemPrompt` → передаётся Goose через `--system`
- `builtins` → передаётся через `--with-builtin <через,запятую>` плюс `--no-profile` (set полностью определяет тулсет)
- Создаются/управляются через TUI: **Set → ⚙️ Создать новый set...** / **Управление set'ами...**, или вручную в `~/.config/cgoose/sets/`

### Сохранение промпта при resume

`--system` работает только в памяти (не хранится в БД сессий), поэтому при resume cgoose:
1. Ищет *оригинальный* промпт в project meta `sessionPrompts[<имя-сессии>]`
2. Если сохранённого промпта нет (старая сессия) — использует текущий `systemPrompt` из set'а

Это гарантирует, что возобновлённая сессия сохранит свои исходные инструкции, даже если set позже отредактировали.

## Интеграция с git worktree

При создании новой сессии внутри git-репозитория:

1. Worktree в `<repo>/.worktree/<sanitized-name>` с одноимённой веткой
2. Goose запускается внутри этого worktree — изолированно от основных веток
3. При resume находит и переиспользует существующий worktree
4. При удалении сессии чистит worktree и ветку

Управление:
- `CGOOSE_NO_WORKTREE=1` — пропустить создание worktree
- `CGOOSE_FORCE_WORKTREE=1` — принудительный worktree (перекрывает вышеуказанное)
- `-m` CLI флаг отключает worktree (по умолчанию)
- `-w` CLI флаг включает worktree
- Конфиг `~/.config/cgoose/config.json`: `{ "default_mode": "worktree" }` — изменить дефолт на worktree режим

## Расположение данных

| Что | Путь |
|-----|------|
| Память по проектам | `~/.config/cgoose/projects/<dir>-<hash>.json` |
| Session set'ы | `~/.config/cgoose/sets/*.json` |
| Конфиг cgoose | `~/.config/cgoose/config.json` |
| Конфиги провайдеров | `~/.config/goose/custom_providers/*.json` |
| Конфиг Goose | `~/.config/goose/config.yaml` |
| Сессии Goose | `~/.local/share/goose/sessions/sessions.db` |

## Локальные переопределения конфига

cgoose ищет `.goose/config.yaml` в worktree сессии (или корне проекта):

- Устанавливает `GOOSE_ADDITIONAL_CONFIG_FILES`, чтобы Goose подключал его вместе с основным конфигом
- Разрешает `${VARIABLE}` / `$VARIABLE` из секретов Goose и инжектит в окружение сессии

## Частые задачи

### Добавить модель кастомному провайдеру
Добавьте в массив `models` в `~/.config/goose/custom_providers/<name>.json`:
```json
{ "name": "model-id", "context_limit": 128000 }
```

### Создать session set вручную
Напишите `~/.config/cgoose/sets/<name>.json` в форме выше, или используйте визард в TUI.

### Сбросить историю проекта
Удалите соответствующий файл в `~/.config/cgoose/projects/`.

## Навигация

- **Esc** на любом промпте: шаг назад
- **Ctrl+C**: полный выход