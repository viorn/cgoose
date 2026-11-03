# Review: ACP + TUI

## 1. Архитектура и модульность

### Плюсы
- Чёткое разделение: `client.ts` (транспорт/JSON-RPC), `custom.ts` (goose-specific методы), `chat.ts` (UI), `types.ts` (wire types)
- `prepareLaunch()` шарится между classic и ACP режимами
- `AcpClient` инкапсулирует весь JSON-RPC 2.0 over stdio

### Вопросы
- `chat.ts` (573 строки) делает слишком много: UI setup, prompt handlers, session update rendering, status line, input listeners, shutdown. Стоит выделить `renderSessionUpdate()` и `setupUI()`
- `buildEnabledExtensions()` и `buildMcpServers()` — дублируют парсинг stdio/http spec. Можно объединить

---

## 2. JSON-RPC клиент (`client.ts`)

### Плюсы
- Корректный NDJSON фрейминг с буферизацией
- `failPending()` при exit/error — правильно прокидывает ошибку всем ожидающим промисам
- Graceful shutdown с SIGKILL fallback

### Баги / риски

**[Medium] Line 143 — ложный match response**
```ts
if ("id" in msg && ((msg as any).result !== undefined || (msg as any).error !== undefined))
```
Если агент шлёт request с `id` и `result` (маловероятно в ACP, но возможно в будущем), он будет ошибочно обработан как response. Паттерн должен быть: `("result" in msg) || ("error" in msg)`.

**[High] Line 161 — пустой catch глотает ошибки**
```ts
this.handleServerRequest(msg).catch(() => { /* handler already sent an error response */ });
```
Если `requestPermission` хендлер кинет async ошибку *до* `respond()`, агент зависнет без ответа. Нужно:
```ts
catch((e) => this.respond(msg.id, undefined, { code: ERR.INTERNAL, message: String(e.message) }));
```

**[Low] Line 231 — нет timeout на `prompt()`**
`prompt()` вызывает `request()` с `timeoutMs = 0` (бесконечно). Если агент зависнет — только kill процесса.

---

## 3. Session update rendering (`chat.ts`)

### Плюсы
- `flushStream()` с debounce 50ms — не флудит рендер
- Thought chunks отдельно с `dimMarkdownTheme`
- Tool calls обновляются инлайн через `Map<toolCallId, ToolLine>`

### Баги / риски

**[High] Line 306 — debounce никогда не сбрасывается при частых чанках**
```ts
if (!force && now - lastFlush < 50) return;
lastFlush = now;
```
Если агент шлёт чанки каждые 40ms, debounce всегда возвращает `false` и буфер никогда не флешится. Debounce должен сбрасываться только от *успешного* flush, а не от каждого вызова.

**[Low] Line 318 — `as any` вместо discriminated union**
`types.ts` определяет `SessionUpdate` как discriminated union, но везде `as any`. Можно использовать `switch (update.sessionUpdate)` с proper narrowing.

**[Medium] Line 433 — `toolLines.clear()` скрывает tool calls при cancel**
При отмене turn tool lines удаляются, хотя уже отрендерены. При cancel лучше сохранить их.

---

## 4. Permission overlay (`chat.ts` lines 244-279)

### Плюсы
- SelectList overlay с `tui.showOverlay()` — корректная изоляция ввода
- `permissionActive` + `cancelPendingPermission` — обработка Esc

### Баги / риски

**[Medium] Line 245 — промис может висеть вечно**
`requestPermission` возвращает Promise, но если TUI закроется целиком (Ctrl+C), промис не будет разрешён. `finishTurn()` (line 423) пытается исправить через `cancelPendingPermission?.()`, но только при завершении turn, не при shutdown.

---

## 5. Extension mapping

### Плюсы
- `parseStdioSpec()` корректно парсит `name:ENV=val cmd args...`
- `buildMcpServers()` — правильный канал для stdio extensions
- `buildEnabledExtensions()` — goose-specific `_meta.goose.enabledExtensions`

### Баги / риски

**[Low] Line 143-144 — честный коммент, но misleading код**
```ts
// goose 1.57 ignores this field (verified via acp-client-smoke)
```
Код отправляет `enabledExtensions`, но goose 1.57 это игнорирует. Создается ложное ощущение, что это работает.

**[Low] Line 119 — env var regex не учитывает кавычки**
```ts
while (i < tokens.length && /^\w+=/.test(tokens[i]))
```
Не парсит `KEY='value with spaces'`, хотя это ограничение Goose CLI (указано в комменте `goose-extensions.ts` line 104).

---

## 6. System prompt на resume

### Плюсы
- `setSessionSystemPrompt()` с `mode: "set"`, `key: "cgoose"`, `text: ""` для очистки
- `key: "cgoose"` позволяет нескольким клиентам иметь свои entries

### Баги / риски

**[Low] Line 550-555 — prompt меняется при смене set'а**
На resume `setSessionSystemPrompt` вызывается каждый раз. Если пользователь сменил set между запусками, prompt изменится. Это "set is source of truth" поведение, но может быть сюрпризом.

---

## 7. CLI flags (`index.ts` lines 385-404)

### Плюсы
- Хорошее покрытие: `c`, `mc`, `wc`, `ac`, `nc`, `sc`, `ca`, `cn`, `cs`
- Composed mode resolution (w*/m*)

### Баги / риски

**[Low] Line 386-387 — алиасы не задокументированы**
`ac`/`nc`/`sc`/`ca`/`cn`/`cs` появляются только в коде, не в JSDoc (lines 5-19).

**[Low] Line 419-443 — chain if/else тяжело читать**
Можно использовать Map или более декларативный подход.

---

## 8. Smoke test (`acp-client-smoke.ts`)

### Плюсы
- Покрытие всего основного флоу
- Отдельная проверка `enabledExtensions` и `mcpServers` каналов
- `constrained` session проверка

### Баги / риски

**[Low] Line 33-34 — `require("node:fs")` внутри handler**
Bun-specific. Сломается при запуске через `node`.

**[Low] Нет assertions**
Smoke test полагается на human reading console output. Стоит добавить `console.assert` или `try/catch` с exit code.

---

## 9. Итог

### Критические (High)
1. **client.ts:161** — Глотание ошибок в `handleServerRequest` может привести к зависанию агента без ответа
2. **chat.ts:306** — Debounce bug: буфер может никогда не флешиться при частых чанках

### Medium
3. **chat.ts:433** — `toolLines.clear()` скрывает tool calls при cancel
4. **chat.ts:245** — Promise `requestPermission` может висеть вечно при закрытии TUI

### Low
5. **client.ts:143** — Ложный match response на request с `id` + `result`
6. **chat.ts:318** — `as any` вместо discriminated union narrowing
7. **chat.ts:143-144** — Misleading код при известном игнорировании goose
8. **index.ts:386-387** — Недокументированные CLI алиасы
9. **acp-client-smoke.ts:33** — Bun-specific `require()`
10. **acp-client-smoke.ts** — Нет assertions

### Рекомендации по рефакторингу
1. Вынести `buildEnabledExtensions` / `buildMcpServers` в утилитарную функцию с одним парсером
2. Заменить `as any` на proper discriminated union narrowing
3. Исправить debounce flush (сбрасывать только от успешного flush)
4. Заменить пустой catch на корректный error response
5. Задокументировать все CLI алиасы в JSDoc
6. Добавить assertions в smoke test
7. Выделить UI-логику из `chat.ts` в отдельный модуль
