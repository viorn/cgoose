/**
 * Collapsible thought / reasoning block rendered inside the ACP chat.
 *
 * The block that is currently streaming starts expanded, so the reasoning is
 * visible while the model is producing it (the pre-collapse behaviour). On
 * `setFinished()` it collapses to a single-line bar — unless the user toggled
 * it by hand or through `/think`, in which case that choice wins. A left click
 * (alternate screen) or `/think` expands it again.
 */

import pc from "picocolors";

import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { formatCharCount } from "../utils";

// ─── Constants ───────────────────────────────────────────────────────────────

const BAR_ICON = "💭";
const BAR_THINKING = "Thinking…";
const BAR_DONE = "Thought";

/** How to expand a block, depending on whether the renderer captures the mouse. */
const HINT_EXPAND_MOUSE = "click to expand";
const HINT_COLLAPSE_MOUSE = "click to collapse";
const HINT_EXPAND_KEYS = "/think expand";
const HINT_COLLAPSE_KEYS = "/think collapse";

/**
 * Left indent of every line — the column `Text`/`Markdown` blocks use, so the
 * block lines up with the rest of the transcript. The markdown body carries no
 * margin of its own (`paddingX: 0`), which puts the bar and the body in the
 * same column.
 */
const INDENT = 1;

/**
 * Light gray for thought text — distinguishable from white responses. Raw
 * escape codes (rather than pc.dim) because every part of the block shares this
 * one shade, but they still respect `NO_COLOR`/non-TTY output.
 */
const THOUGHT_COLOR = pc.isColorSupported ? "\x1b[38;5;248m" : "";
const RESET = pc.isColorSupported ? "\x1b[0m" : "";
const tint = (s: string): string => `${THOUGHT_COLOR}${s}${RESET}`;

/** Markdown theme for reasoning: everything in the same light gray. */
const thoughtMarkdownTheme: MarkdownTheme = {
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

/** The bits every bar line shares: icon, state, char count. */
function barLabel(finished: boolean, charCount: number): string {
  const state = finished ? BAR_DONE : BAR_THINKING;
  return `${BAR_ICON} ${state} · ${formatCharCount(charCount)} chars`;
}

// ─── The `/think` command ────────────────────────────────────────────────────

export type ThoughtAction = "toggle" | "expand" | "collapse";

export interface ThoughtCommand {
  action: ThoughtAction;
  /** Apply to every block in the conversation, not only the most recent one. */
  all: boolean;
}

/**
 * Parse `/think [toggle|expand|collapse] [all]`. An unknown word returns null so
 * the chat can report it instead of silently toggling the last block.
 */
export function parseThoughtCommand(args: readonly string[]): ThoughtCommand | null {
  let action: ThoughtAction = "toggle";
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

export interface ThoughtBlockOptions {
  /** Called when the block is expanded / collapsed. */
  onToggle?: (expanded: boolean) => void;
  /**
   * Whether the renderer captures the mouse. `TuiMainScreen` does not, so the
   * hint points at `/think` there instead of promising a click that never comes.
   */
  clickable?: boolean;
}

export class ThoughtBlock implements Component {
  /** Accumulated reasoning text (markdown). */
  private text = "";
  /** Reasoning length in code points (`.length` would count surrogate halves). */
  private chars = 0;
  /** Whether streaming is still producing chunks. */
  private finished = false;
  /** Whether the block is currently expanded (live blocks start expanded). */
  private expanded = true;
  /** A manual toggle outranks the automatic collapse on finish. */
  private userToggled = false;
  /** Live markdown view, created on the first chunk. */
  private md: Markdown | null = null;

  private onToggle?: (expanded: boolean) => void;
  private clickable: boolean;

  constructor(options?: ThoughtBlockOptions) {
    this.onToggle = options?.onToggle;
    this.clickable = options?.clickable ?? true;
  }

  /** Append a streaming chunk to the buffer and refresh the live markdown. */
  append(chunk: string): void {
    this.text += chunk;
    this.chars += [...chunk].length;
    if (!this.md) {
      // No markdown margin of its own: the block supplies the single-column
      // indent (`INDENT`), so the bar and the body start in the same column.
      this.md = new Markdown("", 0, 0, thoughtMarkdownTheme, { color: tint });
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

  /** Toggle expanded / collapsed (a user action). */
  toggle(): void {
    this.setExpanded(!this.expanded);
  }

  /**
   * Expand or collapse explicitly — `/think expand|collapse`. Like a click, it
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

  /** Current character count of the reasoning. */
  get charCount(): number {
    return this.chars;
  }

  /** Force a render refresh (after text changes). */
  invalidate(): void {
    this.md?.invalidate();
  }

  /**
   * Render the header plus the markdown while expanded, or a single-line bar
   * while collapsed. There is nothing to hide while streaming: expanded blocks
   * show the markdown they already have.
   */
  render(width: number): string[] {
    // Subtracting the indent keeps every line inside the viewport; a block with
    // no text yet still shows its bar, so it can be collapsed.
    const inner = Math.max(1, width - INDENT);
    const lines = this.expanded
      ? this.md
        ? [...this.renderHeader(inner), ...this.md.render(inner)]
        : this.renderHeader(inner)
      : this.renderBar(inner);
    const margin = " ".repeat(INDENT);
    return lines.map((line) => margin + line);
  }

  /** Header shown above the expanded markdown; doubles as the collapse bar. */
  private renderHeader(width: number): string[] {
    return [this.fitBar(`${barLabel(this.finished, this.chars)} · ${pc.dim(this.hint(false))}`, width)];
  }

  /** The single line a collapsed (or untouched, finished) block takes. */
  private renderBar(width: number): string[] {
    return [this.fitBar(`${barLabel(this.finished, this.chars)} · ${pc.dim(this.hint(true))}`, width)];
  }

  /** What the user can do with this block, given where it is rendered. */
  private hint(collapsed: boolean): string {
    if (!this.clickable) return collapsed ? HINT_EXPAND_KEYS : HINT_COLLAPSE_KEYS;
    return collapsed ? HINT_EXPAND_MOUSE : HINT_COLLAPSE_MOUSE;
  }

  /** Keep a bar inside the viewport without cutting the ANSI codes in half. */
  private fitBar(bar: string, width: number): string {
    return visibleWidth(bar) > width ? truncateToWidth(bar, width, "…", true) : bar;
  }

  /**
   * Handle mouse events — left click toggles the block.
   *
   * Only `click` is handled on purpose: an unhandled press keeps the press/release
   * gesture, so a primary-button drag inside the block still selects (and copies)
   * the reasoning text instead of being swallowed here.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;

    this.toggle();
    return { handled: true };
  }
}
