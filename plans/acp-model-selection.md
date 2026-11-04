# Chat mode: выбор модели — env + фиксация через `session/set_config_option`

- **Дата:** 2026-11-04
- **Статус:** реализовано (`src/acp/session-meta.ts`, `src/acp/session-config.ts`, `src/acp/chat.ts`,
  `src/acp/types.ts`, `src/launcher.ts`, `src/index.ts`, тесты, доки)
- **Проверено вживую:** goose **1.57.0** (готовый бинарь) + исходники (`crates/goose/src/acp/server/new_session.rs`,
  `crates/goose/src/acp/server/dispatch.rs`, `crates/goose/src/model_config.rs` тега `v1.57.0`)
- **Контекст:** найдено при разборе «ACP-сессии не видны в cgoose» (сам баг закрыт в `v2.0.1`/`v2.2.x`;
  здесь — остаток: `_meta.provider` был перенесён на верхний уровень и вместе с остальными ключами
  начал действовать, а `session/load` вообще игнорирует env)

## Проблема 1: `_meta.provider` подменял модель

`session/new` отправлял `_meta.provider = <выбранный провайдер>`. Пока ключ лежал вложенным в
`_meta.goose`, goose его игнорировал и модель бралась из `GOOSE_MODEL` (env). После перехода на
плоский `_meta` ключ включился — и **модель, выбранная в wizard'е, молча подменялась дефолтной
моделью провайдера**.

### Почему так происходит (goose 1.57)

`new_session.rs:145` → `resolve_provider_and_model_config(config, requested_provider, recipe_settings)`,
`model_config.rs:33-44`:

```rust
let (provider, model) = match explicit_provider {          // recipe.provider ИЛИ _meta.provider
    Some(provider) => (provider, get_from_registry(&provider).await?.metadata().default_model),
    None => (config.get_goose_provider()?, config.get_goose_model()?),   // читает GOOSE_PROVIDER/GOOSE_MODEL
};
```

То есть при наличии `_meta.provider` (и отсутствии `goose_model` в рецепте) `GOOSE_MODEL`
**не читается вообще**. Ключа `_meta.model`/`_meta.modelConfig` в 1.57 не существует
(проверено `git grep` по `acp/`), модель в `session/new` живёт только в env/config и recipe-settings.

### Эксперимент

Установленный goose 1.57, `GOOSE_PROVIDER=custom_kodik`, `GOOSE_MODEL=qwen/qwen3.6-flash`
(у `custom_kodik` дефолт реестра — первый в JSON: `deepseek/deepseek-v4-flash`), сессия через
`src/acp/client.ts`, затем чтение `sessions.db`:

| `_meta` | `provider_name` | `model_name` в сессии |
|---|---|---|
| `{client, sessionTitle, provider: "custom_kodik"}` | `custom_kodik` | `deepseek/deepseek-v4-flash` ❌ подмена |
| `{client, sessionTitle}` | `custom_kodik` | `qwen/qwen3.6-flash` ✅ |
| `{client, sessionTitle}` + `GOOSE_PROVIDER=custom_openintegration`, `GOOSE_MODEL=Qwen3-Coder-480B-A35B-Instruct` | `custom_openintegration` | `Qwen3-Coder-480B-A35B-Instruct` ✅ |

Последняя строка — контрольная: без `_meta.provider` **оба** значения берутся из env, то есть
отказ от ключа не ломает выбор провайдера.

## Проблема 2: `session/load` игнорирует env, поэтому resume терял выбор

На resume модель сессии остаётся той, что записана в строке `sessions`; `GOOSE_MODEL` агенту,
загрузившему сессию, не применяется:

```
load response keys: []            # configOptions в ответе нет
db after load (GOOSE_MODEL=deepseek/deepseek-v4-pro): qwen/qwen3.6-flash
```

То есть при resume выбранная в wizard'е модель либо терялась, либо (если сессия создана с
подменой из проблемы 1) оставалась неверной навсегда.

## Решение

### 1. `_meta.provider` не отправляется

`session/new._meta` собирает чистая `newSessionMeta()` (`src/acp/session-meta.ts`):
`client: "cgoose"` + необязательные `sessionTitle` и `enabledExtensions`. Провайдер и модель
попадают к агенту через `GOOSE_PROVIDER`/`GOOSE_MODEL` (их выставляет `launcher.ts` — стандартный
путь goose, на него же опирается classic-режим).

### 2. Пара фиксируется запросом `session/set_config_option`

`session/set_config_option` — ACP-нативный способ сменить провайдера/модель у живой сессии
(SACP 11); goose реализует его для `provider`, `model`, `mode`, `thinking_effort`
(`acp/server/dispatch.rs`) и **пишет результат в `sessions.db`**. Именно так работает встроенный
ACP-клиент goose для агентов, у которых модель — config option
(`crates/goose/src/acp/provider.rs`, `apply_model_if_changed`).

`src/acp/session-config.ts`:

- `planSessionConfig(desired, current)` — чистая функция: **provider первым, затем model**
  (смена провайдера перебрасывает модель на его дефолтную: live `custom_openintegration` →
  `deepseek/deepseek-v4-flash`; если provider изменился, model отправляется даже когда выглядит
  неизменной);
- `applySessionConfig(client, sessionId, desired, current)` — не бросает исключений: ошибка
  запроса и «тихое» расхождение итоговой пары с выбранной становятся предупреждением в чате;
- текущая пара берётся из ответа `session/new` (`configOptions`, есть всегда) — для новой сессии,
  и из строки сессии (`provider_name` + `model_config_json`, передаются как `resumeConfig`) — для
  resume. `_goose/unstable/session/info` не используется: его нет в goose 1.50.

Живая проверка (goose 1.57, `bun /tmp/e2e-session-config.ts`):

```
A new            → 20261104_14 | db: custom_kodik/qwen/qwen3.6-flash
A apply(same)    → applied=[]                    (идемпотентно, запросов нет)
A apply(switch)  → applied=[provider,model] | db: custom_openintegration/Qwen3-Coder-480B-A35B-Instruct
B load           → db after load: custom_openintegration/Qwen3-Coder-480B-A35B-Instruct
B apply(same)    → applied=[] | db: custom_openintegration/Qwen3-Coder-480B-A35B-Instruct
B apply(switch)  → applied=[provider,model] | db: custom_kodik/qwen/qwen3.6-flash
```

Формы, которые goose отвергает (verbatim из живой ошибки): `value: {valueId}`,
`{type:"value_id",value}`, `{type:"valueId",value}` → `data did not match any variant of untagged
enum SessionConfigOptionValue`. Работает **голая строка** (`value: '<id>'`).

Поведение на старых goose: неизвестный `configId` → `Invalid params: "Unsupported config option: …"`,
отсутствие метода → `Method not found`; в обоих случаях `applySessionConfig` возвращает warning,
сессия остаётся рабочей (`session/set_config_option` есть уже в 1.50, `_goose/unstable/session/info` — нет).

Заодно: в `types.ts` у `provider` стоит пометка «не отправлять и почему», а
`LoadSessionRequest._meta.replayTail` переехал на верхний уровень (goose читает
`m.get("replayTail")`, `load_session.rs:103`) — cgoose его не отправляет, но тип не должен
подсказывать неверную форму.

## Тесты

- `scripts/acp-session-meta-test.ts` (6 проверок, без goose): плоские ключи, отсутствие `provider`,
  отсутствие null/undefined вместо опциональных полей, сохранение **пустого** `enabledExtensions`
  (пустой массив = «без расширений вообще»), pass-through набора расширений, форма payload.
- `scripts/acp-session-config-test.ts` (12 проверок, без goose): порядок provider→model, no-op на
  неизменной паре, отсутствие запросов при пустых desired, форма `value` (голая строка),
  идемпотентность, warning на unsupported/method-not-found, сохранение эффекта первого шага при
  падении второго, warning на расхождение итоговой пары, доверие запрошенному значению без
  `configOptions`.
- `scripts/acp-client-offline-test.ts`: фейковый агент возвращает `_meta` из `session/new` —
  проверка, что по проводу уходит ровно `{client, sessionTitle}`.
- `bun run test` — 27 + 6 + 12 + 11 + offline, `bun run check` зелёный.
