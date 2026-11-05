#!/usr/bin/env bun
/**
 * Unit tests for the collapsible thought block (src/acp/thought.ts).
 *
 * Pins the behaviour the chat relies on: the block that is currently streaming
 * is expanded and shows its reasoning live, finishing collapses it unless the
 * user toggled it by hand, and a left click toggles it.
 *
 * Usage: bun scripts/acp-thought-test.ts
 */

import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import { ThoughtBlock, parseThoughtCommand } from "../src/acp/thought";

type Check = [name: string, run: () => void];

const checks: Check[] = [];
const ok = (name: string, fn: () => void) => checks.push([name, fn]);

/** A block with `chunk` already streamed into it. */
const streaming = (chunk: string): ThoughtBlock => {
  const block = new ThoughtBlock();
  block.append(chunk);
  return block;
};

/** The same, but with the stream finished. */
const finished = (chunk: string): ThoughtBlock => {
  const block = streaming(chunk);
  block.setFinished();
  return block;
};

// ─── The live block ─────────────────────────────────────────────────────────

ok("a streaming block is expanded and shows its reasoning", () => {
  const lines = streaming("first **thought**").render(80);
  assert.ok(lines.length > 1, "expanded block takes more than the bar line");
  assert.ok(lines[0].includes("Thinking…"));
  assert.ok(lines[0].includes("click to collapse"));
  assert.ok(lines.slice(1).join("\n").includes("thought"), "reasoning is rendered live");
});

ok("appended chunks reach the view", () => {
  const block = streaming("one");
  assert.ok(block.render(80).slice(1).join("\n").includes("one"));
  block.append(" two");
  assert.ok(block.render(80).slice(1).join("\n").includes("two"), "late chunks are visible");
});

ok("the bar counts characters while streaming", () => {
  assert.ok(streaming("abcdefghij").render(80)[0].includes("10 chars"));
});

// ─── Finishing ──────────────────────────────────────────────────────────────

ok("an untouched block collapses on finish", () => {
  const lines = finished("some reasoning text").render(80);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("Thought"));
  assert.ok(lines[0].includes("click to expand"));
});

ok("a manual collapse survives the finish", () => {
  const block = streaming("reasoning");
  block.toggle(); // user collapses the live block
  assert.equal(block.isExpanded, false);
  block.setFinished();
  assert.equal(block.isExpanded, false);
  assert.equal(block.render(80).length, 1);
});

ok("a manual expand survives the finish", () => {
  const block = streaming("reasoning");
  block.toggle();
  block.toggle(); // collapsed and back open by hand
  block.setFinished();
  assert.equal(block.isExpanded, true);
  assert.ok(block.render(80).length > 1);
});

ok("a finished block expands on demand with the full text", () => {
  const block = finished("# Heading\n\nBody text");
  block.toggle();
  const lines = block.render(80);
  const body = lines.slice(1).join("\n");
  assert.ok(lines[0].includes("click to collapse"));
  assert.ok(body.includes("Heading"));
  assert.ok(body.includes("Body text"));
});

// ─── Character count formatting ─────────────────────────────────────────────

ok("raw count below 1000", () => {
  assert.ok(streaming("a".repeat(500)).render(80)[0].includes("500 chars"));
});

ok("K suffix from 1000", () => {
  assert.ok(streaming("a".repeat(1500)).render(80)[0].includes("1.5k"));
});

ok("rounded K from 10000", () => {
  assert.ok(streaming("a".repeat(12000)).render(80)[0].includes("12k"));
});

// ─── Width ──────────────────────────────────────────────────────────────────

ok("bars stay inside the viewport", () => {
  for (const width of [12, 30, 80]) {
    const bar = finished("x".repeat(5000)).render(width);
    assert.equal(bar.length, 1);
    assert.ok(visibleWidth(bar[0]) <= width, `bar fits ${width}`);
  }
});

ok("expanded body stays inside the viewport", () => {
  for (const width of [12, 30, 80]) {
    const lines = streaming("some long reasoning sentence " + "word ".repeat(30)).render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `line fits ${width}`);
  }
});

ok("the bar and the body share the transcript's one-column indent", () => {
  // `Text`/`Markdown` blocks sit at column 1; the thought block indents itself,
  // and the markdown body carries no margin of its own, so the bar and the body
  // start in the same column instead of the body hanging one step to the right.
  const indent = (line: string): number => line.length - line.trimStart().length;
  const lines = streaming("reasoning").render(80);
  assert.equal(indent(lines[0]), 1, `bar is indented: ${JSON.stringify(lines[0])}`);
  assert.equal(indent(lines[1]!), 1, `body is indented: ${JSON.stringify(lines[1])}`);
  assert.equal(indent(finished("reasoning").render(80)[0]), 1, "collapsed bar is indented too");
});

ok("the block without text yet still shows its (indented) bar", () => {
  const bar = new ThoughtBlock().render(80)[0];
  assert.ok(bar.startsWith(" 💭"), `empty block keeps its bar: ${JSON.stringify(bar)}`);
});

// ─── Toggle ─────────────────────────────────────────────────────────────────

ok("toggle flips the state both ways", () => {
  const block = streaming("reasoning");
  assert.equal(block.isExpanded, true);
  block.toggle();
  assert.equal(block.isExpanded, false);
  block.toggle();
  assert.equal(block.isExpanded, true);
});

// ─── Mouse ──────────────────────────────────────────────────────────────────

const mouse = (type: string, button: string) => ({
  type,
  button,
  x: 0,
  y: 0,
  screenX: 10,
  screenY: 10,
  width: 80,
  height: 1,
  shift: false,
  alt: false,
  ctrl: false,
}) as never;

ok("a left click toggles and is handled", () => {
  const block = streaming("reasoning");
  assert.equal(block.handleMouse(mouse("click", "left"))?.handled, true);
  assert.equal(block.isExpanded, false);
  block.handleMouse(mouse("click", "left"));
  assert.equal(block.isExpanded, true);
});

ok("a right click is ignored", () => {
  const block = streaming("reasoning");
  assert.equal(block.handleMouse(mouse("click", "right")), undefined);
  assert.equal(block.isExpanded, true);
});

ok("press and drag are left to the renderer", () => {
  const block = streaming("reasoning");
  assert.equal(block.handleMouse(mouse("press", "left")), undefined);
  assert.equal(block.handleMouse(mouse("drag", "left")), undefined);
  assert.equal(block.isExpanded, true);
});

ok("onToggle reports the new state", () => {
  const seen: boolean[] = [];
  const block = new ThoughtBlock({ onToggle: (expanded) => seen.push(expanded) });
  block.toggle();
  block.toggle();
  assert.deepEqual(seen, [false, true]);
});

ok("setExpanded only notifies when the state changes", () => {
  const seen: boolean[] = [];
  const block = new ThoughtBlock({ onToggle: (expanded) => seen.push(expanded) });
  block.setExpanded(false);
  block.setExpanded(false);
  assert.deepEqual(seen, [false]);
  assert.equal(block.isExpanded, false);
});

ok("setExpanded counts as a user choice (survives the finish)", () => {
  const block = streaming("reasoning");
  block.setExpanded(false);
  block.setFinished();
  assert.equal(block.isExpanded, false);
  block.setExpanded(true);
  block.setFinished();
  assert.equal(block.isExpanded, true);
});

// ─── Hints ──────────────────────────────────────────────────────────────────

ok("the collapsed bar points at the mouse in the alternate screen", () => {
  const bar = finished("reasoning").render(80)[0];
  assert.ok(bar.includes("click to expand"));
});

ok("without mouse support the bar points at /think", () => {
  const block = finished("reasoning");
  const noMouse = new ThoughtBlock({ clickable: false });
  noMouse.append("reasoning");
  noMouse.setFinished();
  assert.ok(block.render(80)[0].includes("click to expand"));
  assert.ok(noMouse.render(80)[0].includes("/think expand"));
  noMouse.toggle();
  assert.ok(noMouse.render(80)[0].includes("/think collapse"));
});

// ─── `/think` argument parsing ──────────────────────────────────────────────

ok("bare /think toggles the most recent block", () => {
  assert.deepEqual(parseThoughtCommand([]), { action: "toggle", all: false });
});

ok("/think all covers the whole conversation", () => {
  assert.deepEqual(parseThoughtCommand(["all"]), { action: "toggle", all: true });
});

ok("/think expand|collapse, case-insensitive, with all", () => {
  assert.deepEqual(parseThoughtCommand(["expand"]), { action: "expand", all: false });
  assert.deepEqual(parseThoughtCommand(["Collapse", "ALL"]), { action: "collapse", all: true });
  assert.deepEqual(parseThoughtCommand(["toggle", "all"]), { action: "toggle", all: true });
});

ok("an unknown word is rejected instead of toggling", () => {
  assert.equal(parseThoughtCommand(["foo"]), null);
  assert.equal(parseThoughtCommand(["all", "foo"]), null);
});

// ─── Character counting ─────────────────────────────────────────────────────

ok("the count is code points, not UTF-16 halves", () => {
  const block = new ThoughtBlock();
  block.append("💭");
  block.append("ab");
  assert.equal(block.charCount, 3);
});


ok("append accumulates text", () => {
  const block = new ThoughtBlock();
  block.append("hello");
  block.append(" world");
  assert.equal(block.charCount, 11);
});

// ─── Run all checks ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ ${name}: ${err}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
