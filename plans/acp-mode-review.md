# cgoose ACP Mode — результаты ревью правок

> Дата: 2026-11-03
> Состояние дерева: `main` = `fd00988` (v1.10.0), ACP-режим целиком в незакоммиченных
> изменениях (`src/acp/*`, `scripts/*`, `plans/acp-mode-plan.md`, `tsconfig.json` — untracked).
> Проверка типов: `bun run check` (`tsc -p tsconfig.json`) — **проходит без ошибок**.
> Версия goose на машине: **1.57.0** (`goose acp --help` отвечает).

Ревью покрывает диффы `src/index.ts`, `src/launcher.ts`, `src/provider-creator.ts`,
`AGENTS.md`, `package.json` и новые файлы `src/acp/{client,custom,types,chat}.ts`,
`scripts/acp-{probe,client-smoke}.ts`.

---

## 🔴 Критично (функциональные баги)

### 1. Выбор provider/model в чате игнорируется
`NewSessionRequest` в `types.ts` поддерживает `_meta.goose.provider`, но `chat.ts:425-435`
передаёт только `client`, `sessionTitle`, `enabledExtensions`. `opts.provider`/`opts.model`
используются **только в заголовке** (`chat.ts:318`). Итог: провайдер/модель, выбранные в
wizard'е, не доезжают до `goose acp` — сессия работает с дефолтом из config.yaml.
План это предусматривал (`plans/acp-mode-plan.md:47,111`), но реализация не донесена.
Модель вообще не передаётся: предполагался путь через `configOptions`/`session/set_mode`
из ответа `session/new` (не реализовано).

### 2. «None» в чат-режиме = Default-профиль, а не «без расширений»
`prepareLaunch()` даёт `set = undefined` для `""` (None) и для `__default__` одинаково.
В классическом режиме это компенсировано веткой
`else if (!useDefaultProfile) args.push("--no-profile")` (`launcher.ts:243-245`).
В `launchGooseAcp` такой ветки нет: `buildEnabledExtensions` при `!opts.set` возвращает
`undefined` → goose грузит дефолтный профиль. Т.е. `cgoose c` с выбранным «None»
подтягивает расширения из `config.yaml`, ломая семантику «set — источник истины».

**Фикс:** пробрасывать `prepared.useDefaultProfile` в `AcpChatOptions`; при `None`
передавать `enabledExtensions: []` вместо `undefined`.

### 3. `enabledExtensions` ни разу не проверен вживую
И `scripts/acp-probe.ts`, и `scripts/acp-client-smoke.ts` создают сессию **без**
`_meta.goose.enabledExtensions`. Вся передача builtin/mcp в чат-режиме держится на
предположении, что goose 1.57 понимает builtin-записи в этом поле. Проверка
`_goose/unstable/session/extensions/list` в probe есть, но после сессии без extensions.
Нужен прогон с реальным списком, иначе расширения могут молча не работать.

### 4. Esc во время permission-промпта отменяет весь ход, оверлей не закрывается
Подтверждено по исходникам pi-tui: `handleTerminalInput` перебирает `inputListeners`
**до** фокусированного компонента и при `{consume:true}` делает `return`
(`node_modules/@earendil-works/pi-tui/dist/tui.js:719-725`). Глобальный листенер в
`chat.ts:379-399` перехватывает Esc/Ctrl+C раньше `SelectList`, поэтому `onCancel`
списка никогда не вызывается. Последствия:

- нельзя «отклонить конкретный tool call» — только отменить ход целиком;
- `finishTurn` (`chat.ts:347-360`) **не вызывает** `tui.hideOverlay()`
  (единственный вызов — внутри `finish()` обработчика permission, `chat.ts:210`),
  поэтому после отмены оверлей остаётся висеть;
- pending `request_permission` promise не резолвится — agent→client запрос остаётся
  без ответа.

**Фикс:** флаг `permissionActive`; в листенере при нём не консьюмить Esc, а отдавать в
фокус; в `finishTurn` — `tui.hideOverlay()` + резолв permission как `cancelled`.

### 5. Нет обработки `error` у child-процесса → падение при отсутствии goose
`AcpClient.spawn` подписан только на `exit` (`client.ts:104-113`). Если бинаря `goose`
нет (ENOENT), Node бросает uncaught `'error'` event → стектрейс вместо сообщения.
Классический режим ведёт себя так же, но для ACP это критичнее.
**Фикс:** `child.on("error", ...)` → `failPending(new Error(...))`.

---

## 🟠 Существенно

### 6. Заявленный «fallback на классику» не реализован
`AGENTS.md` утверждает: «classic mode is the fallback on older versions». В коде нет ни
проверки версии, ни `goose acp --help`, ни try/catch с откатом. При старом goose
пользователь получит «goose acp exited» в транскрипте. Либо реализовать проверку
(`goose acp --help` / version gate), либо убрать обещание из доков.

### 7. Флаги `ac/nc/sc/ca/cn/cs` не работают как заявлено
`isChatMode` их ловит (`index.ts:385-387`), но блок выбора `mode` (`index.ts:417-437`)
их не знает → все падают в `"full"`. Т.е. `cgoose ac` не даёт quick-resume, хотя по
мнемонике должен. Нужно добавить ветки или пересмотреть схему флагов и задокументировать.

### 8. «Мёртвый UI» при сбое setup
При ошибке `initialize`/`session/new` (`chat.ts:458-464`) сообщение печатается, но
`sessionId` остаётся `null`, и `submitPrompt` молча игнорирует любой ввод
(`chat.ts:357`). Пользователь видит живой интерфейс, который ничего не делает.
Нужно явно писать «чат недоступен, Esc для выхода» либо останавливать TUI.

### 9. Нет уведомления о падении агента
`AcpClient.spawn` принимает `onExit`, но `chat.ts:171-175` его не передаёт; stderr
глушится без `CGOOSE_DEBUG=1`. Если `goose acp` падает, UI замирает до таймаута запроса.
Стоит буферизовать последние строки stderr и показывать их в транскрипте при exit.

### 10. Утечка `toolLines` между ходами
`Map` не чистится в `finishTurn`; `tool_call_update` из нового хода с тем же id обновит
старую строку, карта растёт. Добавить `toolLines.clear()` в `finishTurn`.

### 11. `session/load` без проверки capability
`supportsLoadSession()` есть (`client.ts:264`), но `chat.ts:439` вызывает `loadSession`
безусловно. При отсутствии поддержки — просто «ACP setup failed». Лучше явное
сообщение/фолбэк на новую сессию.

### 12. Синхронный fs в async-обработчиках блокирует TUI
`chat.ts:227-235`: `readFileSync`/`writeFileSync` внутри async-обработчиков. Для больших
файлов интерфейс подвиснет. Стоит `await fs.promises` + создание parent-директорий для write.

---

## 🟡 Мелочи / чистота

### 13. Мёртвая ветка `setLabel`
`chat.ts:332`:
```ts
const setLabel = opts.set?.title ?? (opts.set === undefined && opts.agentBuiltins.length === 0 ? undefined : "Default");
```
По построению `agentBuiltins` пуст ровно тогда, когда `set === undefined`, значит
`"Default"` никогда не выводится. Проще: `opts.set?.title`.

### 14. Комментарий врёт про `--with-builtin`
`launcher.ts:312-313` обещает «Builtins go on the agent command line», но
`runAcpChat` → `AcpClient.spawn({cwd, env, onStderr})` без `args`; builtin'ы идут через
`_meta`. Debug-строка в `printSummary` (`launcher.ts:321`) показывает команду, которая
не выполняется. Либо передавать `args: ["--with-builtin", ...]`, либо поправить
комментарий/вывод.

### 15. Приоритет операторов в `client.ts:133`
```ts
if ("id" in msg && (msg as any).result !== undefined || (msg as any).error !== undefined)
```
Парсится как `(id && result) || error`. Для валидного JSON-RPC работает, но читается
плохо и уязвимо к сообщению с `error` без `id` — обернуть в скобки.

### 16. `timeout` и headers http-спеки теряются
`parseHttpSpec` (`chat.ts:129-134`) отбрасывает `timeout=N` и выводит имя из URL.
Для CLI-формата это неизбежно, но для ACP можно нести полноценный объект server
(url/headers/timeout) из config.yaml — сейчас headers/авторизация теряются.

### 17. `AGENTS.md` утверждает больше, чем есть
Пункты «pending permissions are re-asked» и «classic mode is the fallback» не
подтверждены кодом; «empty list → no extensions at all» неверно для выбора None (п.2).

### 18. `tsconfig.json` вне git
На него опирается `bun run check`, но файл untracked — новый клон/CI останется без
проверки типов. Добавить в коммит.

### 19. Lockfile-гигиена
`bun.lock` в `.gitignore`, а трекается `package-lock.json` при bun-проекте;
`package.json` теперь требует `@earendil-works/pi-tui` — убедиться, что трекаемый
lockfile содержит зависимость (иначе `npm ci` сломается). Бамп `@types/node` 22→26
без изменения версии пакета.

### 20. `provider-creator.ts`
Правка по сути верная (защита от не-string результата `password()`), но
`typeof result !== "string"` избыточен после `isCancel`; не критично.

---

## Что проверить перед коммитом

1. `bun scripts/acp-probe.ts` и `bun scripts/acp-client-smoke.ts` — оба должны пройти
   на goose 1.57.
2. Ручной сценарий: `cgoose c` → Enter по всем шагам → проверить, что сессия создаётся
   с выбранным провайдером и set'ом (`session extensions/list`), затем:
   Esc во время генерации, Esc на permission-промпте, resume после перезапуска.
3. Добавить в probe кейс с `_meta.goose.enabledExtensions` (builtin + mcp) и проверкой,
   что они реально появились в сессии.
4. Закоммитить `tsconfig.json` и обновить README (сейчас про ACP/`-c` там ничего).

---

## Рекомендуемый порядок исправлений

1. **Корректность и не-зависающий UI:** п.2 (None), п.4 (Esc/overlay), п.5 (`error` handler).
2. **Функциональный паритет:** п.1 (provider/model в `session/new`).
3. **Наблюдаемость:** п.8, п.9, п.11.
4. **Гигиена:** п.6, п.7, п.10, п.12-п.20 (доки, lockfile, tsconfig).
