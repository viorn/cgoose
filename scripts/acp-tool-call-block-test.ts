#!/usr/bin/env bun
/**
 * Unit tests for the collapsible tool call block (src/acp/tool-call-block.ts).
 *
 * Pins the behaviour the chat relies on: the block that is currently streaming
 * is expanded and shows the tool output live, finishing collapses it unless the
 * user toggled it by hand, and a left click toggles it.
 *
 * Usage: bun scripts/acp-tool-call-block-test.ts
 */

import assert from "node:assert/strict";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { ToolCallBlock, parseToolCommand, STATUS_ICON } from "../src/acp/tool-call-block";
import {
  liveOutputFromMeta,
  toolCallPayload,
  toolContentText,
  toolDetailFromRawInput,
} from "../src/acp/tool-call-content";

/** The bar is coloured, so checks that look at its start work on plain text. */
const plain = (line: string): string => stripTerminalSequences(line);

type Check = [name: string, run: () => void];

const checks: Check[] = [];
const ok = (name: string, fn: () => void) => checks.push([name, fn]);

/** A block with `chunk` already streamed into it. */
const streaming = (chunk: string): ToolCallBlock => {
  const block = new ToolCallBlock();
  block.setTitle("test_tool");
  block.setStatus("in_progress");
  block.appendContent(chunk);
  return block;
};

/** The same, but with the stream finished and completed status. */
const completed = (chunk: string): ToolCallBlock => {
  const block = streaming(chunk);
  block.setStatus("completed");
  block.setFinished();
  return block;
};

/** The same, but with failed status. */
const failedStatus = (chunk: string): ToolCallBlock => {
  const block = streaming(chunk);
  block.setStatus("failed");
  block.setFinished();
  return block;
};

// ─── STATUS_ICON ────────────────────────────────────────────────────────────

ok("STATUS_ICON maps all statuses", () => {
  assert.equal(STATUS_ICON.pending, "⏳");
  assert.equal(STATUS_ICON.in_progress, "🔄");
  assert.equal(STATUS_ICON.completed, "✅");
  assert.equal(STATUS_ICON.failed, "❌");
});

ok("unknown status falls back to 🔨 via statusIcon getter", () => {
  const block = new ToolCallBlock();
  block.setTitle("x");
  block.setStatus("bogus");
  assert.equal(block.statusIcon, "🔨");
});

// ─── The live block ─────────────────────────────────────────────────────────

ok("a streaming block is expanded and shows its output", () => {
  const lines = streaming("first **result**").render(80);
  assert.ok(lines.length > 1, "expanded block takes more than the bar line");
  assert.ok(lines[0].includes("🔄"));
  assert.ok(lines[0].includes("click to collapse"));
  assert.ok(lines.slice(1).join("\n").includes("result"), "output is rendered live");
});

ok("appended chunks reach the view", () => {
  const block = streaming("one");
  assert.ok(block.render(80).slice(1).join("\n").includes("one"));
  block.appendContent(" two");
  assert.ok(block.render(80).slice(1).join("\n").includes("two"), "late chunks are visible");
});

ok("the bar counts characters while streaming", () => {
  assert.ok(streaming("abcdefghij").render(80)[0].includes("10 chars"));
});

ok("the bar shows the tool title", () => {
  const block = streaming("data");
  block.setTitle("fs/read_text_file");
  assert.ok(block.render(80)[0].includes("fs/read_text_file"));
});

// ─── Finishing ──────────────────────────────────────────────────────────────

ok("an untouched block collapses on finish", () => {
  const block = streaming("some output");
  block.setStatus("completed");
  block.setFinished();
  const lines = block.render(80);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("✅"));
  assert.ok(lines[0].includes("click to expand"));
});

ok("a manual collapse survives the finish", () => {
  const block = streaming("output");
  block.toggle(); // user collapses the live block
  assert.equal(block.isExpanded, false);
  block.setStatus("completed");
  block.setFinished();
  assert.equal(block.isExpanded, false);
  assert.equal(block.render(80).length, 1);
});

ok("a manual expand survives the finish", () => {
  const block = streaming("output");
  block.toggle();
  block.toggle(); // collapsed and back open by hand
  block.setStatus("completed");
  block.setFinished();
  assert.equal(block.isExpanded, true);
  assert.ok(block.render(80).length > 1);
});

ok("a finished block expands on demand with the full text", () => {
  const block = completed("# Heading\n\nBody text");
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
    const bar = completed("x".repeat(5000)).render(width);
    assert.equal(bar.length, 1);
    assert.ok(visibleWidth(bar[0]) <= width, `bar fits ${width}`);
  }
});

ok("expanded body stays inside the viewport", () => {
  for (const width of [12, 30, 80]) {
    const lines = streaming("some long output " + "word ".repeat(30)).render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `line fits ${width}`);
  }
});

ok("the bar and the body share the transcript's one-column indent", () => {
  const indent = (line: string): number => line.length - line.trimStart().length;
  const lines = streaming("output").render(80);
  assert.equal(indent(lines[0]), 1, `bar is indented: ${JSON.stringify(lines[0])}`);
  assert.equal(indent(lines[1]!), 3, `body is indented under the bar: ${JSON.stringify(lines[1])}`);
  assert.equal(indent(completed("output").render(80)[0]), 1, "collapsed bar is indented too");
});

ok("the block without text yet still shows its (indented) bar", () => {
  const block = new ToolCallBlock();
  block.setTitle("empty_tool");
  block.setStatus("pending");
  const bar = plain(block.render(80)[0]!);
  assert.ok(bar.startsWith(" ⏳"), `empty block keeps its bar: ${JSON.stringify(bar)}`);
});

// ─── Toggle ─────────────────────────────────────────────────────────────────

ok("toggle flips the state both ways", () => {
  const block = streaming("output");
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
  const block = streaming("output");
  assert.equal(block.handleMouse(mouse("click", "left"))?.handled, true);
  assert.equal(block.isExpanded, false);
  block.handleMouse(mouse("click", "left"));
  assert.equal(block.isExpanded, true);
});

ok("a right click is ignored", () => {
  const block = streaming("output");
  assert.equal(block.handleMouse(mouse("click", "right")), undefined);
  assert.equal(block.isExpanded, true);
});

ok("press and drag are left to the renderer", () => {
  const block = streaming("output");
  assert.equal(block.handleMouse(mouse("press", "left")), undefined);
  assert.equal(block.handleMouse(mouse("drag", "left")), undefined);
  assert.equal(block.isExpanded, true);
});

ok("onToggle reports the new state", () => {
  const seen: boolean[] = [];
  const block = new ToolCallBlock({ onToggle: (expanded) => seen.push(expanded) });
  block.setTitle("tool");
  block.toggle();
  block.toggle();
  assert.deepEqual(seen, [false, true]);
});

ok("setExpanded only notifies when the state changes", () => {
  const seen: boolean[] = [];
  const block = new ToolCallBlock({ onToggle: (expanded) => seen.push(expanded) });
  block.setTitle("tool");
  block.setExpanded(false);
  block.setExpanded(false);
  assert.deepEqual(seen, [false]);
  assert.equal(block.isExpanded, false);
});

ok("setExpanded counts as a user choice (survives the finish)", () => {
  const block = streaming("output");
  block.setExpanded(false);
  block.setStatus("completed");
  block.setFinished();
  assert.equal(block.isExpanded, false);
  block.setExpanded(true);
  block.setFinished();
  assert.equal(block.isExpanded, true);
});

// ─── Hints ──────────────────────────────────────────────────────────────────

ok("the collapsed bar points at the mouse in the alternate screen", () => {
  const bar = completed("output").render(80)[0];
  assert.ok(bar.includes("click to expand"));
});

ok("without mouse support the bar points at /tool", () => {
  const block = completed("output");
  assert.ok(block.render(80)[0].includes("click to expand"));
  const noMouse = new ToolCallBlock({ clickable: false });
  noMouse.setTitle("tool");
  noMouse.setStatus("completed");
  noMouse.appendContent("output");
  noMouse.setFinished();
  assert.ok(noMouse.render(80)[0].includes("/tool expand"));
  noMouse.toggle();
  assert.ok(noMouse.render(80)[0].includes("/tool collapse"));
});

// ─── Status colours ─────────────────────────────────────────────────────────

ok("completed status bar shows ✅", () => {
  const bar = plain(completed("data").render(80)[0]!);
  assert.ok(bar.includes("✅"));
});

ok("failed status bar shows ❌", () => {
  const bar = plain(failedStatus("error").render(80)[0]!);
  assert.ok(bar.includes("❌"));
});

ok("pending status bar shows ⏳", () => {
  const block = new ToolCallBlock();
  block.setTitle("waiting");
  block.setStatus("pending");
  const bar = plain(block.render(80)[0]!);
  assert.ok(bar.includes("⏳"));
});

// ─── setTitle / setStatus ───────────────────────────────────────────────────

ok("setTitle updates the title in the bar", () => {
  const block = streaming("data");
  block.setTitle("new_name");
  const bar = block.render(80)[0];
  assert.ok(bar.includes("new_name"));
});

ok("setStatus updates the status in the bar", () => {
  const block = streaming("data");
  block.setStatus("completed");
  const bar = plain(block.render(80)[0]!);
  assert.ok(bar.includes("✅"));
  assert.ok(!bar.includes("completed"), "the icon carries the status, the word is not repeated");
});

ok("status change on a live block is reflected", () => {
  const block = streaming("data");
  block.setStatus("in_progress");
  assert.ok(plain(block.render(80)[0]!).includes("🔄"));
  block.setStatus("completed");
  assert.ok(plain(block.render(80)[0]!).includes("✅"));
});

// ─── `/tool` argument parsing ───────────────────────────────────────────────

ok("bare /tool toggles the most recent block", () => {
  assert.deepEqual(parseToolCommand([]), { action: "toggle", all: false });
});

ok("/tool all covers the whole conversation", () => {
  assert.deepEqual(parseToolCommand(["all"]), { action: "toggle", all: true });
});

ok("/tool expand|collapse, case-insensitive, with all", () => {
  assert.deepEqual(parseToolCommand(["expand"]), { action: "expand", all: false });
  assert.deepEqual(parseToolCommand(["Collapse", "ALL"]), { action: "collapse", all: true });
  assert.deepEqual(parseToolCommand(["toggle", "all"]), { action: "toggle", all: true });
});

ok("an unknown word is rejected instead of toggling", () => {
  assert.equal(parseToolCommand(["foo"]), null);
  assert.equal(parseToolCommand(["all", "foo"]), null);
});

// ─── Character counting ─────────────────────────────────────────────────────

ok("the count is code points, not UTF-16 halves", () => {
  const block = new ToolCallBlock();
  block.setTitle("tool");
  block.appendContent("🔨");
  block.appendContent("ab");
  assert.equal(block.charCount, 3);
});

ok("appendContent accumulates text", () => {
  const block = new ToolCallBlock();
  block.setTitle("tool");
  block.appendContent("hello");
  block.appendContent(" world");
  assert.equal(block.charCount, 11);
});

ok("charCount getter returns the count", () => {
  const block = new ToolCallBlock();
  block.setTitle("tool");
  assert.equal(block.charCount, 0);
  block.appendContent("abc");
  assert.equal(block.charCount, 3);
});

ok("isExpanded getter returns the state", () => {
  const block = streaming("data");
  assert.equal(block.isExpanded, true);
  block.toggle();
  assert.equal(block.isExpanded, false);
});

// ─── toolDetailFromRawInput ─────────────────────────────────────────────────

ok("toolDetailFromRawInput prefers the command", () => {
  assert.equal(
    toolDetailFromRawInput({ command: "ls -la", path: "/tmp" }),
    "ls -la",
  );
});

ok("toolDetailFromRawInput falls back through the key order", () => {
  assert.equal(toolDetailFromRawInput({ path: "/tmp/x" }), "/tmp/x");
  assert.equal(toolDetailFromRawInput({ query: "cats" }), "cats");
  assert.equal(toolDetailFromRawInput({ url: "https://x" }), "https://x");
});

ok("toolDetailFromRawInput skips empty values", () => {
  assert.equal(toolDetailFromRawInput({ command: "", path: "/tmp" }), "/tmp");
  assert.equal(toolDetailFromRawInput({ command: "   " }), undefined);
});

ok("toolDetailFromRawInput stringifies non-strings", () => {
  assert.equal(
    toolDetailFromRawInput({ command: { a: 1 } }),
    JSON.stringify({ a: 1 }),
  );
});

ok("toolDetailFromRawInput returns undefined for non-objects", () => {
  assert.equal(toolDetailFromRawInput(undefined), undefined);
  assert.equal(toolDetailFromRawInput(null), undefined);
  assert.equal(toolDetailFromRawInput("str"), undefined);
  assert.equal(toolDetailFromRawInput({}), undefined);
});

// ─── toolContentText ────────────────────────────────────────────────────────

ok("toolContentText unwraps the ACP content wrapper", () => {
  assert.equal(
    toolContentText({ type: "content", content: { type: "text", text: "hello" } }),
    "hello",
  );
});

ok("toolContentText renders an embedded resource uri", () => {
  assert.equal(
    toolContentText({ type: "content", content: { type: "resource", uri: "file:///x" } }),
    "📄 file:///x",
  );
  assert.equal(
    toolContentText({
      type: "content",
      content: { type: "resource", resource: { uri: "file:///y" } },
    }),
    "📄 file:///y",
  );
});

ok("toolContentText labels images and audio", () => {
  assert.equal(toolContentText({ type: "content", content: { type: "image" } }), "🖼 image");
  assert.equal(toolContentText({ type: "content", content: { type: "audio" } }), "🔊 audio");
});

ok("toolContentText renders a diff with its body", () => {
  assert.equal(
    toolContentText({ type: "diff", path: "/tmp/a.ts", newText: "line" }),
    "📝 /tmp/a.ts\nline",
  );
  assert.equal(toolContentText({ type: "diff", path: "/tmp/a.ts" }), "📝 /tmp/a.ts");
});

ok("toolContentText renders a terminal id", () => {
  assert.equal(toolContentText({ type: "terminal", terminalId: "term_1" }), "🖥 term_1");
});

ok("toolContentText ignores shapes it cannot render", () => {
  assert.equal(toolContentText(undefined), undefined);
  assert.equal(toolContentText({ type: "unknown" }), undefined);
});

// ─── liveOutputFromMeta ─────────────────────────────────────────────────────

ok("liveOutputFromMeta joins the live_output chunks", () => {
  const meta = {
    toolNotification: {
      type: "live_output",
      params: { sequence: 3, chunks: [{ output: "a\n" }, { output: "b\n" }] },
    },
  };
  assert.deepEqual(liveOutputFromMeta(meta), { text: "a\nb\n", sequence: 3 });
});

ok("liveOutputFromMeta omits the sequence when absent", () => {
  const meta = { toolNotification: { type: "live_output", params: { chunks: [{ output: "x" }] } } };
  assert.deepEqual(liveOutputFromMeta(meta), { text: "x" });
});

ok("liveOutputFromMeta ignores other notification kinds", () => {
  assert.equal(liveOutputFromMeta({ toolNotification: { type: "progress" } }), null);
  assert.equal(liveOutputFromMeta({}), null);
  assert.equal(liveOutputFromMeta(undefined), null);
});

ok("liveOutputFromMeta returns null for empty output", () => {
  const meta = { toolNotification: { type: "live_output", params: { chunks: [{ output: "" }] } } };
  assert.equal(liveOutputFromMeta(meta), null);
});

// ─── toolCallPayload ────────────────────────────────────────────────────────

ok("toolCallPayload replaces the buffer from final content", () => {
  const update = {
    content: [{ type: "content", content: { type: "text", text: "tick-1\ntick-2" } }],
  };
  assert.deepEqual(toolCallPayload(update), { replace: "tick-1\ntick-2" });
});

ok("toolCallPayload joins several content entries", () => {
  const update = {
    content: [
      { type: "content", content: { type: "text", text: "one" } },
      { type: "content", content: { type: "text", text: "two" } },
    ],
  };
  assert.deepEqual(toolCallPayload(update), { replace: "one\ntwo" });
});

ok("toolCallPayload appends the live output", () => {
  const update = {
    _meta: { toolNotification: { type: "live_output", params: { chunks: [{ output: "tick-1\n" }] } } },
  };
  assert.deepEqual(toolCallPayload(update), { append: "tick-1\n" });
});

ok("toolCallPayload carries both operations when goose sends both", () => {
  const update = {
    content: [{ type: "content", content: { type: "text", text: "full" } }],
    _meta: { toolNotification: { type: "live_output", params: { chunks: [{ output: "tail" }] } } },
  };
  assert.deepEqual(toolCallPayload(update), { replace: "full", append: "tail" });
});

ok("toolCallPayload is empty when there is nothing to render", () => {
  assert.deepEqual(toolCallPayload({}), {});
  assert.deepEqual(toolCallPayload({ content: [] }), {});
  assert.deepEqual(toolCallPayload({ content: [{ type: "unknown" }] }), {});
});

// ─── Run all checks ─────────────────────────────────────────────────────────

let passed = 0;
let failCount = 0;

for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ ${name}: ${err}`);
    failCount++;
  }
}

console.log(`\n${passed} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
