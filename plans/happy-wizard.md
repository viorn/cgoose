# Чередующиеся фоны по типу сообщения в чате rossii

## Идея

Каждый **новый тип** сообщения получает фон, чередующийся между двумя цветами.
Один и тот же тип подряд — **тот же фон** (не переключается).

Типы сообщений: `user` → `thought` → `tool` → `model` → `user` → ...

```
вопрос         → фон1 (тип: user)
размышления    → фон2 (сменился тип → переключили)
инструмент     → фон1 (сменился тип → переключили)
инструмент     → фон1 (тот же тип → НЕ переключили)
размышления    → фон2 (сменился тип → переключили)
ответ модели   → фон1 (сменился тип → переключили)
```

## Конфиг

Новые поля в `~/.config/rossii/config.json` (hex-цвета):

```json
{
  "default_mode": "no-worktree",
  "firstBackground": "#1e1f2e",
  "secondBackground": null
}
```

- `firstBackground` — фон для нечётных переключений типа. Hex-строка (например `"#1e1f2e"`) или `null` = прозрачный.
- `secondBackground` — фон для чётных переключений типа. `null` = прозрачный (по умолчанию).

По умолчанию: `firstBackground: "#1e1f2e"` (тёмно-серый), `secondBackground: null` (прозрачный).

## Логика

```typescript
let lastType: string | null = null;
let currentBg: 'first' | 'second' | null = 'first';

function bgForType(newType: string): 'first' | 'second' | null {
  if (lastType !== newType) {
    // Новый тип — переключаем фон
    currentBg = currentBg === 'first' ? 'second' : 'first';
    lastType = newType;
  }
  // Тот же тип — фон не меняем
  return currentBg;
}
```

Применение:

```
submitPrompt()         → bgForType("user") → first
agent_thought_chunk    → bgForType("thought") → second
tool_call              → bgForType("tool") → first
tool_call_update       → bgForType("tool") → first (тот же)
agent_message_chunk    → bgForType("model") → second
agent_thought_chunk    → bgForType("thought") → first
agent_message_chunk    → bgForType("model") → second
user_message_chunk     → bgForType("user") → first
submitPrompt()         → bgForType("user") → first (тот же)
```

## Структура компонентов

Каждый тип сообщения оборачивается в `BgBox`:

```
BgBox(Container)       — ответ модели (currentMdBg)
  ├─ Text("❮ Answer")  — label
  └─ Markdown(...)     — контент
BgBox(ThoughtBlock)    — размышления (currentThoughtBg)
BgBox(Container)       — инструменты (toolBox)
BgBox(Text)            — пользователь (userLineBg)
```

При смене типа создаётся **новый** `BgBox` с новым `bgFn`.
При том же типе — используется **тот же** `BgBox` (или новый с тем же `bgFn`, если блок закрылся).

### Ответ модели (❮ Answer)

Вместо отдельного `Text("❮")` — `Container` с двумя дочерними:
1. `Text(pc.cyan("❮ Answer"), 1, 0)` — label
2. `Markdown(...)` — контент

Всё в одном `BgBox`, label не перерисовывается при стриминге.

## Реализация

### Шаг 1: Конфиг (`src/rossii-config.ts`)

Добавить в `RossiiConfig`:
```typescript
firstBackground?: string | null;
secondBackground?: string | null;
```

По умолчанию:
```typescript
firstBackground: "#1e1f2e",
secondBackground: null,
```

Обновить `readRossiiConfig()` — парсить hex-цвета, валидировать формат `^#[0-9a-fA-F]{6}$`.

### Шаг 2: BgBox компонент (`src/acp/overlay.ts`)

Создать компонент `BgBox` — обёртка над child-компонентом с фоном.

```typescript
export class BgBox implements Component {
  constructor(
    private child: Component,
    private bgFn: ((text: string) => string) | undefined,
  ) {}
  
  addChild(component: Component): void {
    this.child.addChild(component);
  }
  
  invalidate(): void { this.child.invalidate(); }
  
  render(width: number): string[] {
    const lines = this.child.render(width);
    if (!this.bgFn) return lines;
    return lines.map(line => this.bgFn(line));
  }
}
```

`bgFn` — функция, которая принимает строку и возвращает строку с ANSI background кодом.
Если `bgFn` — `undefined`, фон не применяется (прозрачный).

### Шаг 3: Чат (`src/acp/chat.ts`)

Добавить в `AcpChatOptions`:
```typescript
firstBackground: string | null;
secondBackground: string | null;
```

В `runAcpChat`:

```typescript
// Состояние фона
let lastType: string | null = null;
let currentBg: 'first' | 'second' | null = 'first';

function bgForType(newType: string): 'first' | 'second' | null {
  if (lastType !== newType) {
    // Закрываем toolBox при смене типа с tool на что-то другое
    if (lastType === "tool") {
      toolBox = null;
    }
    currentBg = currentBg === 'first' ? 'second' : 'first';
    lastType = newType;
  }
  // Тот же тип — фон не меняем
  return currentBg;
}
  return currentBg;
}

function makeBgFn(color: string | null): ((s: string) => string) | undefined {
  if (!color) return undefined;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return (text: string) => `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
}

// Обёртки
let currentMdBg: BgBox | null = null;
let currentThoughtBg: BgBox | null = null;
let toolBox: BgBox | null = null;
let userLineBg: BgBox | null = null;
```

**Пользовательское сообщение** (`submitPrompt`):
```typescript
const bg = bgForType("user");
transcript.addChild(new BgBox(
  new Text(pc.bold(`❯ ${text}`), 1, 0),
  makeBgFn(bg === 'first' ? firstBackground : bg === 'second' ? secondBackground : null),
));
```

**User message chunk replay** (`user_message_chunk`):
```typescript
if (!userLine) {
  const bg = bgForType("user");
  userLine = new Text("", 1, 0);
  userLineBg = new BgBox(userLine, makeBgFn(bg === 'first' ? firstBackground : bg === 'second' ? secondBackground : null));
  transcript.addChild(userLineBg);
}
```

**Thought block** (`agent_thought_chunk`):
```typescript
if (!currentThought) {
  const bg = bgForType("thought");
  currentThought = new ThoughtBlock({...});
  currentThoughtBg = new BgBox(currentThought, makeBgFn(bg === 'first' ? firstBackground : bg === 'second' ? secondBackground : null));
  transcript.addChild(currentThoughtBg);
}
```

**Tool calls** (`tool_call`/`tool_call_update`):
```typescript
const bg = bgForType("tool");
if (!toolBox) {
  toolBox = new BgBox(new Container(), makeBgFn(bg === 'first' ? firstBackground : bg === 'second' ? secondBackground : null));
  transcript.addChild(toolBox);
}
// Добавляем Text внутрь toolBox
toolBox.addChild(comp);
```

**Model response** (`agent_message_chunk`):
```typescript
if (!currentMd) {
  const bg = bgForType("model");
  // Container: label + markdown, all inside one BgBox
  const container = new Container();
  container.addChild(new Text(pc.cyan("❮ Answer"), 1, 0));
  currentMd = new Markdown("", 1, 0, markdownTheme);
  container.addChild(currentMd);
  currentMdBg = new BgBox(container, makeBgFn(bg === 'first' ? opts.firstBackground : bg === 'second' ? opts.secondBackground : null));
  transcript.addChild(currentMdBg);
}
```

### Шаг 4: Обновление `closeMessage`, `closeUser`, `closeThought`

При закрытии блока сбрасываем обёртку:
```typescript
const closeMessage = (): void => {
  if (currentMd) {
    flushStream(true);
    currentMd = null;
    streamBuffer = "";
  }
  currentMessageId = null;
  currentResponsePrefix = null;
};
```

При `closeMessage()` — если приходит новый `agent_message_chunk` с другим `messageId`, создаётся **новый** `BgBox` с тем же `bgFn` (тот же тип `model`). Container не удаляется, `currentMdBg` сбрасывается — при следующем `agent_message_chunk` создаётся новый `Container` + `BgBox`.

### Шаг 5: Передача из launcher

`src/launcher.ts` — передать `firstBackground`/`secondBackground` в `AcpChatOptions`.

## Файлы для изменения

1. **`src/rossii-config.ts`** — добавить `firstBackground`/`secondBackground` в `RossiiConfig`, `DEFAULT_CONFIG`, `readRossiiConfig()`
2. **`src/acp/overlay.ts`** — добавить `BgBox` компонент
3. **`src/acp/chat.ts`** — добавить `BgBox` обёртки, логику `bgForType`, `makeBgFn`
4. **`src/launcher.ts`** — передать `firstBackground`/`secondBackground` в `AcpChatOptions`

## Риски

- `BgBox` рендерит весь child целиком — если child динамически растёт (Markdown во время стриминга), фон перерисовывается каждый раз. Это корректно, но может быть медленно при очень длинных ответах.
- ANSI background код `\x1b[48;2;R;G;Bm` — truecolor. Работает в современных терминалах. В 256-color терминалах fallback на палитру.
- `Box` из pi-tui уже поддерживает `setBgFn`, но он — контейнер для layout. `BgBox` — проще, рендерит child и применяет фон к каждой строке.
- `secondBackground: null` — прозрачный. `BgBox` при `undefined` bgFn возвращает lines как есть — без изменений.
