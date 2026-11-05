# План: разворачиваемые/сворачиваемые блоки инструментов

## Цель

Заменить текущие однострочные строки-статусы инструментов на разворачиваемые/сворачиваемые блоки, аналогично `ThoughtBlock` из `src/acp/thought.ts`.

---

## Текущее состояние

**`src/acp/chat.ts` (строки 806–828):**
- `tool_call` / `tool_call_update` создают `new Text(line, 1, 0)` — одна строка
- Карта `toolLines: Map<string, { component: Text; title; status }>` хранит ссылку на `Text`
- Вывод инструмента (`update.content` из `ToolCallUpdate`) **игнорируется**

**`src/acp/types.ts` (строки 234–245):**
- `ToolCallUpdate` содержит `content?: ContentBlock[]` — это результат выполнения
- `status` может быть `"pending" | "in_progress" | "completed" | "failed"`

**`src/acp/thought.ts`:**
- Референс: `ThoughtBlock` — компонент с `append()`, `setFinished()`, `toggle()`, `setExpanded()`, `render()`, `handleMouse()`
- Развёрнутый: заголовок-бар + markdown-тело
- Свёрнутый: одна строка-бар с иконкой, статусом, счётчиком символов

---

## Шаги

### 1. Создать `src/acp/tool-call-block.ts`

Новый компонент, аналогичный `ThoughtBlock`, но для инструментов.

**Структура:**

```typescript
export interface ToolCallBlockOptions {
  onToggle?: (expanded: boolean) => void;
  clickable?: boolean;
}

export class ToolCallBlock implements Component {
  // Состояние
  private title = "";
  private status: string = "";
  private text = "";           // accumulated content blocks (markdown text)
  private chars = 0;
  private finished = false;
  private expanded = true;     // streaming blocks start expanded
  private userToggled = false;
  private md: Markdown | null = null;

  // Методы
  setTitle(title: string): void;
  setStatus(status: string): void;
  appendContent(chunk: string): void;   // аналог ThoughtBlock.append()
  setFinished(): void;
  toggle(): void;
  setExpanded(expanded: boolean): void;
  get isExpanded(): boolean;
  get charCount(): number;
  get statusIcon(): string;              // "🔨" / "✅" / "❌" и т.д.
  render(width: number): string[];
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}
```

**Детали реализации:**

- **Иконки статусов** — вынести в константу `STATUS_ICON` (та же карта, что в `chat.ts`):
  ```typescript
  const STATUS_ICON: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔄",
    completed: "✅",
    failed: "❌",
  };
  ```

- **Цвет заголовка** — цвет зависит от статуса:
  - `completed` → зелёный
  - `failed` → красный
  - `in_progress` / `pending` → жёлтый/серый

- **Счётчик** — `formatCharCount(chars) chars` (как в ThoughtBlock)

- **Подсказка** — "click to expand/collapse" или `/tool expand/collapse`

- **Тема markdown** — использовать ту же `thoughtMarkdownTheme` или свою с нейтральным цветом

- **`render()`** — развёрнутый: бар + markdown-тело; свёрнутый: одна строка-бар

- **`handleMouse()`** — левый клик = toggle (как в ThoughtBlock)

### 2. Изменить обработку `tool_call` / `tool_call_update` в `src/acp/chat.ts`

**Было:**
```typescript
case "tool_call":
case "tool_call_update": {
  closeUser(); closeThought(); closeMessage();
  const existing = toolLines.get(update.toolCallId);
  const status = update.status ?? existing?.status ?? "";
  const icon = STATUS_ICON[status] ?? "🔨";
  const title = update.title ?? existing?.title ?? update.toolCallId;
  const line = `${icon} ${title}`;
  if (existing) {
    existing.title = title; existing.status = status;
    existing.component.setText(line);
  } else {
    const comp = new Text(line, 1, 0);
    toolLines.set(update.toolCallId, { component: comp, title, status });
    transcript.addChild(comp);
  }
  tui.requestRender();
  break;
}
```

**Станет:**
```typescript
case "tool_call":
case "tool_call_update": {
  closeUser(); closeThought(); closeMessage();
  const existing = toolCallBlocks.get(update.toolCallId);
  const status = update.status ?? existing?.status ?? "";
  const title = update.title ?? existing?.title ?? update.toolCallId;

  if (existing) {
    existing.setTitle(title);
    existing.setStatus(status);
    // Accumulate content from updates
    if (update.content) {
      for (const c of update.content) {
        if (c.type === "text") existing.appendContent(c.text);
      }
    }
    existing.setStatus(status);
    if (status === "completed" || status === "failed") existing.setFinished();
  } else {
    const block = new ToolCallBlock({
      onToggle: () => tui.requestRender(),
      clickable: altScreen,
    });
    block.setTitle(title);
    block.setStatus(status);
    if (update.content) {
      for (const c of update.content) {
        if (c.type === "text") block.appendContent(c.text);
      }
    }
    toolCallBlocks.set(update.toolCallId, block);
    transcript.addChild(block);
  }
  tui.requestRender();
  break;
}
```

**Переименование:**
- `toolLines: Map<string, { component: Text; title; status }>` → `toolCallBlocks: Map<string, ToolCallBlock>`
- Убрать поле `component` — блок сам рендерится

### 3. Добавить `/tool` slash-команду (опционально, но полезно)

Аналог `/think` для блоков инструментов:
- `/tool toggle` — toggle последнего блока
- `/tool expand [all]` — expand всех / последнего
- `/tool collapse [all]` — collapse всех / последнего

Место: рядом с `toggleAllThoughts` в `chat.ts`.

### 4. Обработка `content` из `tool_call_update`

`ToolCallUpdate.content` — это `ContentBlock[]`. На практике:
- Первый `tool_call` может не содержать `content` (только заголовок)
- `tool_call_update` с `status: "completed"`/`"failed"` содержит `content` с результатом

Нужно аккумулировать `content` по мере прихода обновлений. Если `content` приходит в `tool_call` (первое сообщение), сразу добавляем. Если приходит позже в `tool_call_update` — дописываем.

### 5. Обновить `/think` команду

Команда `/think` работает по `thoughtBlocks` и `currentThought`. Для `/tool` — аналогичная логика, но отдельная:
- `toolCallBlocks` — массив/Map всех блоков
- `/tool` без аргументов → toggle последнего
- `/tool all` → toggle всех

### 6. Единицы тестирования

- Unit-тесты для `ToolCallBlock`: toggle, expand/collapse, render (expanded + collapsed), mouse handling
- Аналогично тестам `ThoughtBlock` в `src/acp/__tests__/thought.test.ts`

---

## Файлы для изменения

| Файл | Действие |
|------|----------|
| `src/acp/tool-call-block.ts` | **Создать** — новый компонент |
| `src/acp/chat.ts` | Изменить обработку `tool_call`/`tool_call_update`, добавить `/tool` команду |
| `src/acp/__tests__/tool-call-block.test.ts` | **Создать** — unit-тесты |

## Зависимости

- Нет новых зависимостей — используется тот же `@earendil-works/pi-tui` и `picocolors`
- Экспорт `ToolCallBlock` из `tool-call-block.ts` (как `ThoughtBlock` из `thought.ts`)
