#!/usr/bin/env bun
/**
 * Unit tests for the framed overlay component (src/acp/overlay.ts).
 *
 * pi-tui has no border primitive, so `BorderBox` draws one itself: every line it
 * returns must be exactly `width` columns wide (a wider line wraps the terminal
 * and corrupts the whole alternate screen), the title must sit in the top edge,
 * and ANSI styling inside the child must not confuse the padding maths.
 *
 * Usage: bun run test   (or `bun scripts/acp-overlay-test.ts`)
 */

import assert from "node:assert/strict";
import { visibleWidth, type Component, type SelectListTheme } from "@earendil-works/pi-tui";

import { BorderBox, SearchableList } from "../src/acp/overlay";

const identity = (text: string): string => text;
const theme: SelectListTheme = {
  selectedPrefix: identity,
  selectedText: identity,
  description: identity,
  scrollInfo: identity,
  noMatch: identity,
};

type Check = [name: string, run: () => void];

/** A child that renders whatever lines it is given, ignoring width. */
function fixed(lines: string[]): Component {
  return {
    render: () => lines,
    invalidate: () => {},
  };
}

const checks: Check[] = [
  ["frames the child and fills every line to the requested width", () => {
    const box = new BorderBox(fixed(["one", "two"]), { title: "Title" });
    const lines = box.render(40);
    assert.equal(lines.length, 4, "top + 2 body lines + bottom");
    for (const line of lines) {
      assert.equal(visibleWidth(line), 40, `line is not 40 columns: ${JSON.stringify(line)}`);
    }
    assert.match(lines[0]!, /^╭ Title ─+╮$/u);
    assert.match(lines[1]!, /^│ one +│$/u);
    assert.equal(lines[3], `╰${"─".repeat(38)}╯`);
  }],

  ["an untitled box has a plain top edge", () => {
    const [top] = new BorderBox(fixed(["x"]), {}).render(10);
    assert.equal(top, `╭${"─".repeat(8)}╮`);
  }],

  ["an over-long title is truncated instead of widening the frame", () => {
    const lines = new BorderBox(fixed(["x"]), { title: "a-very-long-title" }).render(12);
    for (const line of lines) assert.equal(visibleWidth(line), 12);
    assert.ok(lines[0]!.includes("…"), "title should be elided");
  }],

  ["a long child line is truncated to the inner width", () => {
    const lines = new BorderBox(fixed(["0123456789abcdef"]), {}).render(10);
    assert.equal(visibleWidth(lines[1]!), 10);
    assert.ok(lines[1]!.includes("…"));
  }],

  ["ANSI styling in the child does not break the padding", () => {
    const styled = "\u001b[31mred\u001b[0m";
    const lines = new BorderBox(fixed([styled, ""]), {}).render(20);
    for (const line of lines) assert.equal(visibleWidth(line), 20);
    assert.ok(lines[1]!.includes("\u001b[31mred"));
  }],

  ["paddingX widens the blank margin on both sides", () => {
    const none = new BorderBox(fixed(["abc"]), { paddingX: 0 }).render(10);
    const two = new BorderBox(fixed(["abc"]), { paddingX: 2 }).render(10);
    assert.equal(none[1], "│abc     │");
    assert.equal(two[1], "│  abc   │");
    // The child is asked to render narrower by the same amount.
    assert.equal(visibleWidth(two[1]!), 10);
  }],

  ["a searchable list narrows by substring, not just prefix", () => {
    const list = new SearchableList(
      [
        { value: "~deepseek/deepseek-v4-flash-latest", label: "~deepseek/deepseek-v4-flash-latest" },
        { value: "~anthropic/claude-sonnet-latest", label: "~anthropic/claude-sonnet-latest" },
        { value: "~google/gemini-pro-latest", label: "~google/gemini-pro-latest" },
      ],
      theme,
    );
    for (const char of "claude") list.handleInput(char);
    assert.deepEqual(list.visibleItems.map((item) => item.value), ["~anthropic/claude-sonnet-latest"]);
    assert.equal(list.filterText, "claude");
    // Backspace widens the match again.
    list.handleInput("\x7f");
    list.handleInput("\x7f");
    assert.equal(list.filterText, "clau");
    for (let i = 0; i < 4; i++) list.handleInput("\x7f");
    assert.equal(list.filterText, "");
    assert.equal(list.visibleItems.length, 3);
  }],

  ["the search line shows the filter and pads to the width", () => {
    const list = new SearchableList([{ value: "abc", label: "abc" }], theme);
    list.handleInput("a");
    const [search] = list.render(30);
    assert.match(search!, /^Search: a▏ +$/u);
    assert.equal(visibleWidth(search!), 30);
  }],

  ["Enter selects the filtered item, Escape cancels", () => {
    const list = new SearchableList(
      [{ value: "alpha", label: "alpha" }, { value: "beta", label: "beta" }],
      theme,
    );
    const picked: string[] = [];
    let cancelled = 0;
    list.onSelect = (item) => picked.push(item.value);
    list.onCancel = () => cancelled++;
    list.handleInput("b");
    list.handleInput("e");
    list.handleInput("\r");
    assert.deepEqual(picked, ["beta"]);
    list.handleInput("\x1b");
    assert.equal(cancelled, 1);
  }],

  ["arrow keys move the selection instead of typing into the filter", () => {
    const list = new SearchableList(
      [{ value: "one", label: "one" }, { value: "two", label: "two" }],
      theme,
    );
    const picked: string[] = [];
    list.onSelect = (item) => picked.push(item.value);
    list.handleInput("\x1b[B"); // Down: an escape sequence must not enter the filter
    assert.equal(list.filterText, "");
    list.handleInput("\r");
    assert.deepEqual(picked, ["two"]);
  }],

  ["a filter with no matches leaves an empty list, not a crash", () => {
    const list = new SearchableList([{ value: "abc", label: "abc" }], theme);
    for (const char of "zzz") list.handleInput(char);
    assert.deepEqual(list.visibleItems, []);
    assert.ok(list.render(20).length >= 1);
  }],

  ["the border style function only touches the frame glyphs", () => {
    const styled = new BorderBox(fixed(["body"]), { title: "T", border: (text) => `<${text}>` }).render(12);
    assert.ok(styled[0]!.startsWith("<╭>"));
    assert.ok(styled[1]!.includes("body"), "body text must stay unstyled");
  }],
];

let failed = 0;
for (const [name, run] of checks) {
  try {
    run();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\n✅ ${checks.length} checks passed`);
