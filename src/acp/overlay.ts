/**
 * Framed container for chat overlays.
 *
 * pi-tui has no border primitive — `Box` only pads and paints a background — so
 * the `SelectList` overlays (configuration menus, permission prompts) used to be
 * drawn straight on top of the transcript and blended into it. `BorderBox`
 * draws a rounded box around its child and puts the title in the top edge,
 * which also saves the separate header line the overlays used to own.
 *
 * Pure rendering (no TUI state), so it is unit-tested in
 * `scripts/acp-overlay-test.ts`.
 */

import {
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

export interface BorderBoxOptions {
  /** Text drawn into the top edge, e.g. `⚙ Configuration`. Styled by caller. */
  title?: string;
  /** Blank columns between the border and the child (default 1). */
  paddingX?: number;
  /** Style for the box glyphs only (default: identity). */
  border?: (text: string) => string;
}

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

export class BorderBox implements Component {
  private readonly child: Component;
  private readonly options: BorderBoxOptions;

  constructor(child: Component, options: BorderBoxOptions = {}) {
    this.child = child;
    this.options = options;
  }

  invalidate(): void {
    this.child.invalidate();
  }

  render(width: number): string[] {
    const border = this.options.border ?? ((text: string) => text);
    const padX = Math.max(0, this.options.paddingX ?? 1);
    const inner = Math.max(1, width - 2 - padX * 2);
    const edgeWidth = inner + padX * 2;

    // The title lives in the top edge: truncate it first so an over-long title
    // cannot push the frame past the requested width.
    const title = this.options.title ? ` ${this.options.title} ` : "";
    const titleText = title ? truncateToWidth(title, edgeWidth, "…", false) : "";
    const top =
      border(TOP_LEFT) +
      titleText +
      border(HORIZONTAL.repeat(Math.max(0, edgeWidth - visibleWidth(titleText)))) +
      border(TOP_RIGHT);

    const padding = " ".repeat(padX);
    const lines = this.child.render(inner).map((line) => {
      const body = line.length === 0 ? " ".repeat(inner) : truncateToWidth(line, inner, "…", true);
      return border(VERTICAL) + padding + body + padding + border(VERTICAL);
    });

    return [top, ...lines, border(BOTTOM_LEFT) + border(HORIZONTAL.repeat(edgeWidth)) + border(BOTTOM_RIGHT)];
  }
}

export interface SearchableListOptions {
  maxVisible?: number;
  layout?: SelectListLayoutOptions;
  /** Placeholder shown when the filter is empty. */
  placeholder?: string;
  /** Style for the search line (default: identity). */
  searchStyle?: (text: string) => string;
}

/**
 * `SelectList` plus a filter line.
 *
 * The stock list only filters through `setFilter()` (prefix match, no UI), which
 * is useless for the 700+ model ids a provider may return. This wrapper keeps
 * the item array, rebuilds the inner list on every keystroke with a **substring**
 * match, and forwards the navigation keys — so typing narrows the list and
 * arrows/Enter behave exactly as before.
 *
 * Styled like `BorderBox`: no TUI state, unit-tested.
 */
export class SearchableList implements Component {
  readonly capturesViewportInput = true;
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;

  private readonly items: SelectItem[];
  private readonly theme: SelectListTheme;
  private readonly options: SearchableListOptions;
  private filter = "";
  private list: SelectList;

  constructor(items: SelectItem[], theme: SelectListTheme, options: SearchableListOptions = {}) {
    this.items = items;
    this.theme = theme;
    this.options = options;
    this.list = this.buildList(items);
  }

  /** Current filter text (exposed for tests). */
  get filterText(): string {
    return this.filter;
  }

  get visibleItems(): SelectItem[] {
    return this.matching(this.filter);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const style = this.options.searchStyle ?? ((text: string) => text);
    const label = this.filter ? `${this.filter}▏` : (this.options.placeholder ?? "");
    const search = style(`Search: ${label}`);
    return [truncateToWidth(search, width, "…", true), ...this.list.render(width)];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
      this.setFilter(this.filter.slice(0, -1));
      return;
    }
    if (this.isNavigationKey(data)) {
      this.list.handleInput(data);
      return;
    }
    if (this.isPrintable(data)) {
      this.setFilter(this.filter + data);
      return;
    }
    this.list.handleInput(data);
  }

  private setFilter(filter: string): void {
    this.filter = filter;
    this.list = this.buildList(this.matching(filter));
  }

  private matching(filter: string): SelectItem[] {
    const needle = filter.trim().toLowerCase();
    if (!needle) return this.items;
    return this.items.filter((item) => `${item.value} ${item.label}`.toLowerCase().includes(needle));
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(
      items.length > 0 ? items : [],
      this.options.maxVisible ?? 10,
      this.theme,
      this.options.layout,
    );
    list.onSelect = (item) => this.onSelect?.(item);
    list.onCancel = () => this.onCancel?.();
    return list;
  }

  private isNavigationKey(data: string): boolean {
    return [
      Key.up,
      Key.down,
      Key.pageUp,
      Key.pageDown,
      Key.home,
      Key.end,
      Key.enter,
      Key.return,
      Key.tab,
    ].some((key) => matchesKey(data, key));
  }

  /** A single printable character or a pasted run of them, but not a key code. */
  private isPrintable(data: string): boolean {
    if (data.length === 0) return false;
    // Escape sequences (arrows, function keys, Alt+…) start with ESC.
    if (data.charCodeAt(0) === 0x1b) return false;
    return ![...data].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
  }
}
