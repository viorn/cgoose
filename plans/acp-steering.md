# Chat mode: steering — доп. контекст во время хода модели

- **Дата:** 2026-11-05
- **Статус:** исследование завершено вживую, план работ готов, реализация **не начата**
- **Проверено вживую:** goose **1.57.0** (`~/.local/bin/goose`), скрипт `scripts/acp-steer-probe.ts`
  (полный трейс ниже). Сверено с исходниками `~/sources/goose` (тег `v1.57.0`):
  `crates/goose/src/acp/server.rs`, `crates/goose-sdk-types/src/custom_requests.rs`,
  `crates/goose/src/agents/state_machine/ops_steer.rs`
- **Эталон UX у goose:** десктоп-клиент — `ui/desktop/src/acp/sessionNotificationAdapter.ts`,
  `ui/desktop/src/acp/chatSessionStore.ts` (`pendingLocalSteerMessageIds`), `ui/desktop/src/hooks/useChatSession.ts`
  (`onSteerQueuedMessage`), `ui/desktop/src/acp/prompt.ts` (`acpSteerSession`)

## Проблема

Сегодня во время хода композер мёртв: `submitPrompt` ставит `editor.disableSubmit = true`
(`src/acp/chat.ts:1712`), и `Editor` на Enter просто `return` — draft остаётся в поле, но отправить его
нельзя. Чтобы передать модели дополнительный контекст (например, «не трогай файл X», «вот вывод
тестов»), пользователь жмёт **Esc** (это `session/cancel`, ход выбрасывается вместе с уже сделанной
работой) и отправляет текст как новый промпт, который с нуля перечитывает контекст.

Goose умеет это правильно: **steering** — добавление пользовательского сообщения в *идущий* ход,
без нового `session/prompt` и без отмены.

## Что подтверждено вживую (goose 1.57.0)

`bun scripts/acp-steer-probe.ts` (фрагмент вывода):

```
>>> activeRunId observed: run_3940b6e2-1b40-4ca3-8cf5-63eaed21b9b0
>>> steer ACCEPTED: {"runId":"run_3940b6e2…","messageId":"steer_c1bb6831…"}
  ← session_info_update || _meta={"goose":{"queuedSteer":{"messageId":"steer_c1bb6831…","runId":"run_3940b6e2…"}}}
  ← agent_message_chunk PINEAPPLE || _meta={"goose":{"created":…,"messageId":"gen-…"}}
  ← user_message_chunk ADDITIONAL CONTEXT: also reply with STEERED-OK
       || _meta={"goose":{"created":…,"messageId":"steer_c1bb6831…","steer":true}}
  ← agent_thought_chunk … (ход продолжился, новая инференция)
>>> prompt resolved: {"stopReason":"end_turn", …}
═══ result ═══
steer accepted: YES · queuedSteer ack: steer_c1bb6831… · steer picked up: steer_c1bb6831… · ids match: YES
```

| Шаг | Канал |
|---|---|
| id идущего хода | `session/update` → `session_info_update`, `_meta.goose.activeRunId` (строка на старте, `null` в конце) |
| отправка | `_goose/unstable/session/steer` `{sessionId, prompt: ContentBlock[], expectedRunId}` → `{runId, messageId}` |
| подтверждение постановки в очередь | `session_info_update`, `_meta.goose.queuedSteer = {messageId, runId}` |
| момент доставки | `user_message_chunk` с `_meta.goose = {messageId: "steer_…", steer: true}` — на границе хода, перед следующей инференцией |
| конец хода | тот же `session/prompt` резолвится как обычно (`stopReason: end_turn`) — steer **не** создаёт новый ход |

## Семантика (по исходникам v1.57.0)

- **Steer ≠ «прервать генерацию».** `SteerOperation` (`state_machine/ops_steer.rs`) срабатывает, когда
  ход дошёл до границы: последнее сообщение — финальный assistant-message (`ends_turn`) или результат
  инструмента. Очередь FIFO, все накопленные steer-сообщения вливаются перед следующей инференцией.
  Если модель как раз стримит длинный ответ, steer попадёт только после него — это надо честно писать в доке.
- **Steer не завершает ход:** постановка сообщения в очередь сбрасывает `exit_chat` в false, поэтому
  goose делает ещё одну инференцию в рамках того же `session/prompt`
  (`crates/goose/tests/acp_custom_requests_test.rs::test_steer_session_adds_input_to_active_prompt`).
- **Steer переживает компакцию контекста:** текст steer попадает и в запрос саммаризации
  (`state_machine/tests/steering_lifecycle.rs`).
- **«Принято» ≠ «доставлено».** При завершении/отмене хода goose вызывает
  `agent.discard_pending_steers(session_id)` (`clear_active_run`, `ActiveRunDropGuard::drop`) — не
  выбранные steer-сообщения выбрасываются. В ACP-режиме это и на отмене (Esc): steer, отправленный
  за миллисекунду до конца хода, может быть принят (200 OK) и потерян. Поэтому корреляция по
  `messageId` обязательна: `queuedSteer` = «в очереди», `user_message_chunk` со `steer: true` =
  «доставлено». *(В state-machine без ACP steer, наоборот, переживает отмену и применяется при
  resume — на ACP-путь это не распространяется.)*
- **Второй `session/prompt` в идущий ход отклоняется** с
  ``session already has active run `run_…`; use _goose/unstable/session/steer`` — при гонке (наш
  `busy` уже false, а ход ещё жив) это надо ловить и превращать в фоллбек, а не в ошибку на экране.
- **Пустой prompt → ошибка** `prompt must not be empty`; без активного хода → `no active run to steer`;
  чужой `expectedRunId` → `invalid params` с `expectedRunId`/`actualRunId` в `data`.
- **Replay стирает флаг:** при `session/load` чанки идут через `message_meta_without_steer`
  (`server.rs`, ветка истории) — после resume steer-сообщение выглядит как обычное пользовательское.
  Бейдж «steer» между запусками не сохраняется (и это ок).
- **Совместимость:** метод есть уже в `v1.50.0` (проверено `git show v1.50.0:…/custom_requests.rs`),
  т.е. на обеих версиях, которые rossii сегодня поддерживает. Но версия goose у пользователя — любая:
  отсутствие метода (`-32601 method not found`) должно деградировать в предупреждение, а не в поломку.

## Предлагаемое поведение в rossii

### Основное

1. **Enter при идущем ходе = steer**, а не тишина. Текст уходит `_goose/unstable/session/steer`,
   активный `session/prompt` не трогается, ход продолжается.
2. **Esc остаётся отменой хода**, но с явной подсказкой, что очередь steer'ов будет выброшена.
3. Транскрипт:
   - сразу при отправке — приглушённая строка `⤴ steering: <текст>`;
   - по `queuedSteer`-ack — та же строка → `⤴ steered (queued)`;
   - когда приходит `user_message_chunk` со `steer: true` — приглушённую строку убираем
     (`Container.removeChild`) и рисуем настоящую `❯ <текст>` в точке доставки, как обычное
     пользовательское сообщение (перед этим `closeMessage()`/`closeThought()` — steer разрезает
     стримящийся ответ, как это делает tool call);
   - если ход закончился, а доставки не было — жёлтая пометка `⚠ steer не доставлен (ход завершился)`
     и текст возвращается в композер, если он пуст (не теряем ввод).
4. Лоадер во время хода: `thinking…  · Enter — дополнить ход · Esc — отменить`.

### Фоллбеки (без них фича «иногда молча ничего не делает»)

| Ситуация | Поведение |
|---|---|
| `busy`, но `activeRunId` пока нет (гонка старта/финиша) | текст в one-slot очередь `pendingPrompt`, отправить обычным промптом из `finishTurn` |
| goose без поддержки steer (`-32601`) | один раз предупредить `⚠ steering недоступен в этом goose`, дальше — как сегодня (Enter = no-op, hint про Esc); при `busy` тот же фоллбек в очередь |
| `no active run to steer` / несовпадение run id | тот же фоллбек в очередь |
| ход отменён/завершился между отправкой и доставкой | пометка «не доставлено» + draft обратно в композер |
| текст начинается с `/` во время хода | относится к слэш-командам, а не к steer (см. решение №2) |

### Чего сознательно **не** делаем

- Не интерпретируем Enter-во-время-хода как «отменить и отправить» (сегодняшний ручной флоу) — это
  потеря уже сделанной работы; для этого остаётся Esc + Enter.
- Не отправляем steer-сообщение, когда ход не идёт (это обычный промпт).
- Не пытаемся «ускорить» доставку — goose решает сам, на границе хода.
- Classic-режим (`goose session`) не трогаем: там вводом владеет goose.

## Решения по умолчанию (взяты для плана работ, можно поменять)

| № | Вопрос | Решение по умолчанию |
|---|---|---|
| 1 | Очередь при неудачном steer | **да**, one-slot `pendingPrompt` (иначе гонки выглядят как «ничего не произошло») |
| 2 | Слэш-команды во время хода | **да, разрешить**: `handleCommand` и так защищает несовместимые команды («Cannot … while a turn is in progress») |
| 3 | `/edit` (Ctrl+E) во время хода | **да, вторым шагом**: результат редактора уходит тем же путём, что и Enter (steer либо очередь) |
| 4 | Выключатель | **да**, `ROSSII_ACP_STEER=0` (через `env()`), плюс авто-деградация по `-32601` |
| 5 | Метка «ход продолжается после steer» | **нет** — лишний шум, ack в транскрипте достаточно |
| 6 | Длинный/многострочный steer | одним `text`-блоком; `/edit` как опция (п. 3) |

## План работ по шагам

### Шаг 1. Чистый модуль `src/acp/steer.ts` (без TUI, без goose)

Новый файл в стиле `extensions.ts` / `session-meta.ts` — вся логика разбора меты и выбора поведения,
чтобы её можно было тестировать без агента:

```ts
/** `_meta.goose.activeRunId`: строка на старте хода, null в конце, undefined — меты нет. */
export function activeRunIdFromMeta(meta: unknown): string | null | undefined;
/** `_meta.goose.queuedSteer.messageId` — ack постановки steer'а в очередь. */
export function queuedSteerIdFromMeta(meta: unknown): string | undefined;
/** id доставленного steer'а: user_message_chunk c `_meta.goose.steer === true`. */
export function steerChunkId(update: unknown): string | undefined;

export type SteerPlan =
  | { kind: "steer"; expectedRunId: string }
  | { kind: "queue"; reason: "no-active-run" | "unsupported" }
  | { kind: "command" }  // «/…» во время хода
  | { kind: "idle" };    // ход не идёт — обычный промпт

export function planSteer(input: {
  busy: boolean;
  runId: string | null;
  steerSupported: boolean;
  text: string;
}): SteerPlan;
```

**Приёмка:** `bun run check` чистый; руками проверено, что при `busy=true, runId=null` возвращается
`queue/no-active-run`, при `steerSupported=false` — `queue/unsupported`, при `/think` — `command`.

### Шаг 2. Типы и custom-запрос

- `src/acp/types.ts`: `SteerSessionRequest` `{sessionId, prompt: ContentBlock[], expectedRunId}`,
  `SteerSessionResponse` `{runId, messageId}`; `SessionInfoUpdate._meta` остаётся
  `Record<string, unknown>` (парсинг идёт через `steer.ts`).
- `src/acp/custom.ts`: `steerSession(client, sessionId, text, expectedRunId)` рядом с остальными
  `_goose/*`, таймаут 30 с. Константа `GOOSE_METHODS.steer` уже есть и пока не используется.

**Приёмка:** `bun run check`; `scripts/acp-steer-probe.ts` всё ещё проходит (он использует сырой JSON-RPC).

### Шаг 3. Состояние и разбор уведомлений в `src/acp/chat.ts`

- рядом с `let busy = false` (`:296`):
  ```ts
  let activeRunId: string | null = null;
  let steerSupported = true;                        // false после -32601
  const pendingSteers = new Map<string, { text: string; line: Text }>();  // messageId → строка-заглушка
  const steerAcks = new Set<string>();              // ack получен, доставки ещё нет
  let pendingPrompt: string | null = null;          // one-slot очередь
  ```
- `case "session_info_update"` (`:835`): читать `activeRunIdFromMeta(update._meta)` — строка → запомнить,
  `null` → сбросить; `queuedSteerIdFromMeta` → перевести заглушку в `⤴ steered (queued)` и добавить id в
  `steerAcks`. Существующая обработка `update.title` не трогается.
- `case "user_message_chunk"` (`:766`): **до** проверки `if (busy) break;` добавить ветку `steerChunkId(update)`:
  убрать заглушку (`transcript.removeChild`), `closeUser(); closeMessage(); closeThought();`, затем
  отрисовать `❯ <текст>` как обычную пользовательскую строку (переиспользовать `userLine`/`userBuffer`).

**Приёмка:** на живом ходе (probe через chat) в транскрипте видно `⤴ steering` → `⤴ steered (queued)` →
`❯ …` на месте доставки.

### Шаг 4. Отправка: `submitSteer` и точка входа `editor.onSubmit`

- `submitSteer(text)`: оптимистичная строка `⤴ steering: …` → `client.request(GOOSE_METHODS.steer, …)`
  через `steerSession()`; по ответу связать `response.messageId` с заглушкой; на ошибке — классифицировать
  (`-32601` → `steerSupported = false` + одноразовое предупреждение; `no active run` / run id → очередь;
  прочее → `⚠ steer отклонён: …` + текст обратно в композер).
- `editor.onSubmit` (`:1645`): убрать `if (busy) return;`, вызвать `planSteer`:
  `steer` → `submitSteer`, `queue` → `pendingPrompt`, `command` → `handleCommand`, `idle` → `submitPrompt`.
- `submitPrompt` (`:1697`): убрать `editor.disableSubmit = true/false` (`:1712`, `:1725`) и сбрасывать
  `activeRunId = null` перед запросом (run id придёт уведомлением).

**Приёмка:** во время хода текст уходит как steer и не запускает второй промпт; после хода Enter работает
как раньше; в `sessions.db` у сообщения `metadata.steer = true`.

### Шаг 5. Завершение хода и недоставленное

- `finishTurn` (`:1676`): `activeRunId = null`; для каждого id из `steerAcks` без доставки — жёлтая
  пометка `⚠ steer не доставлен (ход завершился)`, текст обратно в композер, если он пуст
  (`editor.getText() === ""`), карту/сет очистить; затем, если есть `pendingPrompt` — забрать его в
  локальную переменную, обнулить и вызвать `submitPrompt` (защита от рекурсии — именно через локальную).
- Подсказки: `setLoader("thinking… · Enter — дополнить ход · Esc — отменить")` (`:1711`) — при
  `steerSupported === false` без части про Enter; в стартовую строку-помощь добавить про steering.

**Приёмка:** Esc после steer → пометка «не доставлен», текст в композере, `busy` корректно снят;
`pendingPrompt` уходит одним промптом и не зацикливается при ошибке.

### Шаг 6. `/edit` во время хода (опционально, решение №3)

`promptInEditor` (`:1184`, отказ при `busy` — `:1187`) сейчас отказывает при `busy`; результат редактора должен уходить через тот же
`planSteer`-путь, что и Enter (а не напрямую в `submitPrompt`).

### Шаг 7. Флаг `ROSSII_ACP_STEER` (решение №4)

`env("ACP_STEER") !== "0"` → стартовое значение `steerSupported`; при `0` поведение как сегодня
(Enter = no-op, hint про Esc). Значение вне `0/1` — предупреждение в чате, как это делают таймауты.

### Шаг 8. Тесты и доки

- `scripts/acp-steer-test.ts` — unit на `steer.ts` (мета, `planSteer`, границы `busy`/run id), по образцу
  `scripts/acp-session-meta-test.ts`; подключить в `package.json` (`test` и `test:steer`).
- `README.md` / `README.ru.md` — в разделе chat-режима (там же, где Esc/Ctrl+P): «Enter во время хода
  дополняет текущий ход (steer), Esc его отменяет»; и в `AGENTS.md`, в блок про chat mode.

## Проверка

1. **Unit:** `bun run test` — парсинг меты, `planSteer`, фоллбеки, восстановление draft.
2. **Live (probe, уже проходит):** `bun scripts/acp-steer-probe.ts` — run id, accept, ack, pickup, `ids match: YES`.
3. **Live (tmux, без LLM-токенов на длинную сессию):** запустить ход с инструментом, во время него набрать
   текст + Enter → в транскрипте `⤴ steering` → `❯ …` в точке доставки; проверить в
   `~/.local/share/goose/sessions/sessions.db`, что сообщение есть в conversation с `metadata.steer = true`;
   Esc после steer → пометка «не доставлено» и текст в композере; обычный Enter после конца хода работает.
4. **Деградация:** прогон против goose без steer (или одноразовый стаб-бинарь, отвечающий
   `method not found` на steer) — предупреждение, Enter снова no-op, промпт после хода уходит.
5. **`bun run check`** — типы.

## Оценка объёма

~120–180 строк в `chat.ts`, ~60 строк `steer.ts`, ~40 строк типов/`custom.ts`, тесты и probe,
абзац в двух README и в `AGENTS.md`. Основная сложность — не протокол (он простой и уже проверен),
а аккуратные состояния: ack / доставка / недоставленное и фоллбеки на гонках.
