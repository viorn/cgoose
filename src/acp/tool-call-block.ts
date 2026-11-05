/**
 * Collapsible tool call block rendered inside the ACP chat.
 *
 * A block that is currently streaming starts expanded so the tool output is
 * visible while it arrives. On `setFinished()` it collapses to a bar — unless
 * the user toggled it by hand or through `/tool`, in which case that choice
 * wins. A left click (alternate screen) or `/tool` expands it again.
 *
 * The bar carries only the "chrome" (`✅ · shell · 1.2k chars · click to
 * expand`); the command itself goes on the following line(s), wrapped. goose's
 * own `title` is cut at 57 characters, so the full command comes from the
 * call's `rawInput` (see ./tool-call-content.ts) — and the wrapped command is
 * capped at two lines while collapsed, with the whole text always available
 * once the block is expanded.
 */

import pc from "picocolors";

import {
  Markdown,
  replaceControlCharacters,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { formatCharCount } from "../utils";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Status icon mapping — the icon carries the status, the bar never repeats it. */
export const STATUS_ICON: Record<string, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
  failed: "❌",
};

/** How to expand/collapse a block, depending on mouse availability. */
const HINT_EXPAND_MOUSE = "click to expand";
const HINT_COLLAPSE_MOUSE = "click to collapse";
const HINT_EXPAND_KEYS = "/tool expand";
const HINT_COLLAPSE_KEYS = "/tool collapse";

/**
 * Left indent of every line — the column `Text`/`Markdown` blocks use, so the
 * block lines up with the rest of the transcript.
 */
const INDENT = 1;

/** Extra indent of the command and the output, so the bar reads as their header. */
const DETAIL_INDENT = 2;

/** Wrapped command lines shown while collapsed (expanded shows all of them). */
const DETAIL_MAX_COLLAPSED = 2;

/**
 * Light gray for tool text — distinguishable from white responses. Raw escape
 * codes (rather than pc.dim) because every part of the block shares this one
 * shade, but they still respect `NO_COLOR`/non-TTY output.
 */
const TOOL_COLOR = pc.isColorSupported ? "\x1b[38;5;248m" : "";
const RESET = pc.isColorSupported ? "\x1b[0m" : "";
const tint = (s: string): string => `${TOOL_COLOR}${s}${RESET}`;

/** Markdown theme for tool output: same light gray, code in yellow. */
const toolMarkdownTheme: MarkdownTheme = {
  heading: (s) => tint(pc.bold(s)),
  bold: (s) => tint(pc.bold(s)),
  italic: (s) => tint(pc.italic(s)),
  link: (s) => tint(pc.underline(s)),
  linkUrl: (s) => tint(pc.underline(s)),
  code: (s) => tint(pc.yellow(s)),
  codeBlock: tint,
  codeBlockBorder: tint,
  quote: (s) => tint(pc.italic(s)),
  quoteBorder: tint,
  hr: tint,
  listBullet: (s) => tint(pc.cyan(s)),
  strikethrough: (s) => tint(pc.strikethrough(s)),
  underline: (s) => tint(pc.underline(s)),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Status colour: green for success, red for failure, yellow/gray for others. */
function statusColor(status: string): (s: string) => string {
  switch (status) {
    case "completed": return pc.green;
    case "failed": return pc.red;
    case "in_progress": return pc.yellow;
    case "pending": return pc.dim;
    default: return pc.dim;
  }
}

/**
 * One line, without control characters: a command may contain ANSI escapes or
 * tabs, and either would break the width arithmetic of the bar.
 */
function oneLine(text: string): string {
  return replaceControlCharacters(text).trim();
}

// ─── The `/tool` command ─────────────────────────────────────────────────────

export type ToolAction = "toggle" | "expand" | "collapse";

export interface ToolCommand {
  action: ToolAction;
  /** Apply to every block in the conversation, not only the most recent one. */
  all: boolean;
}

/**
 * Parse `/tool [toggle|expand|collapse] [all]`. An unknown word returns null so
 * the chat can report it instead of silently toggling the last block.
 */
export function parseToolCommand(args: readonly string[]): ToolCommand | null {
  let action: ToolAction = "toggle";
  let all = false;
  for (const arg of args) {
    const word = arg.toLowerCase();
    if (word === "all") all = true;
    else if (word === "toggle" || word === "expand" || word === "collapse") action = word;
    else return null;
  }
  return { action, all };
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface ToolCallBlockOptions {
  /** Called when the block is expanded / collapsed. */
  onToggle?: (expanded: boolean) => void;
  /**
   * Whether the renderer captures the mouse. `TuiMainScreen` does not, so the
   * hint points at `/tool` there instead of promising a click that never comes.
   */
  clickable?: boolean;
}

export class ToolCallBlock implements Component {
  /** Accumulated output text (markdown). */
  private text = "";
  /** Output length in code points. */
  private chars = 0;
  /** Whether streaming is still producing chunks. */
  private finished = false;
  /** Whether the block is currently expanded (live blocks start expanded). */
  private expanded = true;
  /** A manual toggle outranks the automatic collapse on finish. */
  private userToggled = false;
  /** Live markdown view, created on the first chunk. */
  private md: Markdown | null = null;

  private _title = "";
  private _status: string = "";
  /** Full command / path from the call's raw arguments, when goose sent them. */
  private _detail?: string;
  private onToggle?: (expanded: boolean) => void;
  private clickable: boolean;

  constructor(options?: ToolCallBlockOptions) {
    this.onToggle = options?.onToggle;
    this.clickable = options?.clickable ?? true;
  }

  /** Set the tool title (`shell · <truncated command>`). */
  setTitle(title: string): void {
    this._title = title;
  }

  /** Set the tool status (pending / in_progress / completed / failed). */
  setStatus(status: string): void {
    this._status = status;
  }

  /**
   * Set the full command / path from `rawInput`. Ignored when `undefined`, so a
   * call without arguments keeps goose's (truncated) title as the detail.
   */
  setDetail(detail: string | undefined): void {
    if (detail === undefined) return;
    this._detail = detail;
  }

  /** Replace the whole buffer — the final `content` restates the full output. */
  setContent(text: string): void {
    this.text = text;
    this.chars = [...text].length;
    if (text) {
      if (!this.md) this.md = new Markdown("", 0, 0, toolMarkdownTheme, { color: tint });
      this.md.setText(text);
    }
  }

  /** Append a chunk to the buffer and refresh the live markdown. */
  appendContent(chunk: string): void {
    this.text += chunk;
    this.chars += [...chunk].length;
    if (!this.md) {
      this.md = new Markdown("", 0, 0, toolMarkdownTheme, { color: tint });
    }
    this.md.setText(this.text);
  }

  /**
   * Mark the block as finished (no more chunks coming). A block the user never
   * touched collapses now; the live-expanded default is not a user choice.
   */
  setFinished(): void {
    this.finished = true;
    if (!this.userToggled) this.expanded = false;
  }

  /** Whether the block has already been finished (a cancelled turn closes them all). */
  get isFinished(): boolean {
    return this.finished;
  }

  /** Toggle expanded / collapsed (a user action). */
  toggle(): void {
    this.setExpanded(!this.expanded);
  }

  /**
   * Expand or collapse explicitly — `/tool expand|collapse`. Like a click, it
   * counts as a user choice, so the auto-collapse on finish respects it.
   */
  setExpanded(expanded: boolean): void {
    this.userToggled = true;
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.onToggle?.(expanded);
  }

  /** Whether the block is currently expanded. */
  get isExpanded(): boolean {
    return this.expanded;
  }

  /** Current character count of the output. */
  get charCount(): number {
    return this.chars;
  }

  /** Status icon for this block's current status. */
  get statusIcon(): string {
    return STATUS_ICON[this._status] ?? "🔨";
  }

  /** Current title (for the chat's merge logic). */
  get title(): string {
    return this._title;
  }

  /** Current status (for the chat's merge logic). */
  get status(): string {
    return this._status;
  }

  /** Force a render refresh (after text changes). */
  invalidate(): void {
    this.md?.invalidate();
  }

  /**
   * The bar, the wrapped command and (when expanded) the output.
   *
   * Every line is kept inside `width`: the alternate screen clips an overlong
   * line at the right edge, which would eat the counters and the hint.
   */
  render(width: number): string[] {
    const inner = Math.max(1, width - INDENT);
    const bodyWidth = Math.max(1, inner - DETAIL_INDENT);
    const margin = " ".repeat(INDENT);
    const detail = this.detailLines(bodyWidth).map((line) => `${" ".repeat(DETAIL_INDENT)}${line}`);

    const lines = [this.renderBar(inner), ...detail];
    if (this.expanded && this.md) {
      lines.push(...this.md.render(bodyWidth).map((line) => `${" ".repeat(DETAIL_INDENT)}${line}`));
    }
    return lines.map((line) => margin + line);
  }

  /**
   * The one-line bar: icon (which carries the status), tool name, output size
   * (only when there is output) and what a click does. The status word is
   * deliberately absent — the icon already says it.
   */
  private renderBar(width: number): string {
    const colorFn = statusColor(this._status);
    const parts = [colorFn(this.statusIcon), this.toolName()];
    if (this.chars > 0) parts.push(`${formatCharCount(this.chars)} chars`);
    const hint = colorFn(this.hint(!this.expanded));
    const bar = `${parts.join(" · ")} · ${hint}`;
    return visibleWidth(bar) > width ? truncateToWidth(bar, width, "…", true) : bar;
  }

  /**
   * The command / path, wrapped. Collapsed blocks show at most
   * `DETAIL_MAX_COLLAPSED` lines (a long command must not push the rest of the
   * transcript away); an expanded block shows all of it.
   */
  private detailLines(width: number): string[] {
    const detail = this.detail();
    if (!detail) return [];
    // Newlines are meaningful in a command, so control characters are removed
    // per line rather than by flattening the whole text.
    const sanitized = detail.split(/\r?\n/).map(oneLine).join("\n");
    const wrapped = wrapTextWithAnsi(sanitized, width);
    if (this.expanded || wrapped.length <= DETAIL_MAX_COLLAPSED) return wrapped;
    const lines = wrapped.slice(0, DETAIL_MAX_COLLAPSED);
    const last = lines[DETAIL_MAX_COLLAPSED - 1]!;
    lines[DETAIL_MAX_COLLAPSED - 1] = `${truncateToWidth(last, Math.max(1, width - 1), "", true)}…`;
    return lines;
  }

  /** `shell · printf hi` → `shell`; goose flattens name and detail into one line. */
  private toolName(): string {
    const [name] = this._title.split(" · ");
    return name || this._title;
  }

  /** The full detail when goose sent the arguments, else its truncated title. */
  private detail(): string {
    if (this._detail !== undefined) return this._detail;
    const parts = this._title.split(" · ");
    return parts.length > 1 ? parts.slice(1).join(" · ") : "";
  }

  /** What the user can do with this block, given where it is rendered. */
  private hint(collapsed: boolean): string {
    if (!this.clickable) return collapsed ? HINT_EXPAND_KEYS : HINT_COLLAPSE_KEYS;
    return collapsed ? HINT_EXPAND_MOUSE : HINT_COLLAPSE_MOUSE;
  }

  /**
   * Handle mouse events — left click toggles the block.
   *
   * Only `click` is handled on purpose: an unhandled press keeps the press/release
   * gesture, so a primary-button drag inside the block still selects (and copies)
   * the tool output instead of being swallowed here.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.toggle();
    return { handled: true };
  }
}
