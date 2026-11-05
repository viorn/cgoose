#!/usr/bin/env bun
/**
 * Unit tests for the composer's `/…` completion (src/acp/command-complete.ts).
 *
 * The list goose announces is pinned in scripts/acp-slash-commands-test.ts; here
 * it only has to be *merged* correctly. What is pinned:
 *
 * - the two sources and their precedence (the chat's command wins on a collision,
 *   because `handleCommand` runs before goose sees the text)
 * - when the menu opens at all: a single `/token` on the first line, with no
 *   arguments yet and no prose before the slash
 * - the `prefix` handed back to the editor: the typed token *with* its slash,
 *   which is what makes Enter apply **and submit** (`prefix.startsWith("/")`)
 * - what `applyCompletion` writes into the line: the picked name, the space for
 *   its arguments, and no leftover of the token the cursor sat in the middle of
 *
 * Usage: bun run test:command-complete   (or `bun run test`)
 */

import assert from "node:assert/strict";

import {
  CHAT_COMMANDS,
  applyCommandCompletion,
  buildCommandItems,
  commandSuggestions,
  createCommandCompleter,
} from "../src/acp/command-complete";
import { parseAvailableCommands } from "../src/acp/slash-commands";

type Check = [name: string, run: () => void];

const checks: Check[] = [];

const ok = (name: string, run: () => void): void => {
  checks.push([name, run]);
};

/** What goose 1.57.0 announces, plus the two commands of the live probe run. */
const ANNOUNCED = parseAvailableCommands([
  { name: "prompts", description: "List available prompt templates" },
  { name: "prompt", description: "Load a prompt template" },
  { name: "compact", description: "Compact the conversation history" },
  { name: "clear", description: "Clear the conversation history" },
  { name: "skills", description: "List available skills" },
  { name: "doctor", description: "Run diagnostics" },
  { name: "goal", description: "Set a goal for the agent" },
  { name: "grind", description: "Work on a goal" },
  { name: "status", description: "Show session status" },
  { name: "pi-agent-rust", description: "Run the skill" },
  { name: "model", description: "goose's own model switch" },
]);

const ITEMS = buildCommandItems(ANNOUNCED);

/** The names a menu shows for this text — the helper every case below reads. */
const namesFor = (text: string): string[] =>
  (commandSuggestions(text, ITEMS)?.items ?? []).map((item) => item.value);

// ─── The list ───────────────────────────────────────────────────────────────

ok("the chat's commands come first, goose's follow", () => {
  assert.equal(ITEMS[0].value, "config");
  assert.deepEqual(
    ITEMS.slice(0, CHAT_COMMANDS.length).map((item) => item.value),
    CHAT_COMMANDS.map((item) => item.value),
  );
  assert.deepEqual(ITEMS.slice(CHAT_COMMANDS.length).map((item) => item.value), [
    "prompts",
    "prompt",
    "compact",
    "clear",
    "skills",
    "doctor",
    "goal",
    "grind",
    "status",
    "pi-agent-rust",
    // "model" is dropped: the chat answers it itself
  ]);
});

ok("a name the chat implements is not listed twice", () => {
  assert.equal(ITEMS.filter((item) => item.value === "model").length, 1);
  assert.equal(ITEMS.find((item) => item.value === "model")?.description, CHAT_COMMANDS[1].description);
});

ok("goose's descriptions come through", () => {
  assert.equal(
    ITEMS.find((item) => item.value === "compact")?.description,
    "Compact the conversation history",
  );
});

ok("the list is built from nothing without goose's announcement", () => {
  assert.deepEqual(buildCommandItems().map((item) => item.value), CHAT_COMMANDS.map((item) => item.value));
  // Malformed entries are already dropped by the parser, and a duplicate
  // announcement is dropped here.
  const repeated = buildCommandItems(parseAvailableCommands([{ name: "/Compact" }, { name: "compact" }, { name: 7 }]));
  assert.equal(repeated.filter((item) => item.value === "compact").length, 1);
});

// ─── When the menu opens ────────────────────────────────────────────────────

ok("`/` offers everything, chat's first", () => {
  assert.equal(namesFor("/")[0], "config");
  assert.ok(namesFor("/").includes("compact"));
  assert.equal(commandSuggestions("/", ITEMS)?.prefix, "/");
});

ok("typing narrows by prefix, then by substring", () => {
  assert.deepEqual(namesFor("/co"), ["config", "compact"]);
  // `clear` has the prefix; `doctor` only contains it — later, never mixed in.
  assert.deepEqual(namesFor("/cl"), ["clear"]);
  assert.deepEqual(namesFor("/do"), ["doctor"]);
  // A one-letter query still lists the prefix matches first; `fetch` and
  // `doctor` merely contain the letter.
  assert.deepEqual(namesFor("/c"), ["config", "compact", "clear", "fetch", "doctor"]);
});

ok("matching is case-insensitive and the prefix is what was typed", () => {
  assert.deepEqual(namesFor("/CO"), ["config", "compact"]);
  // The prefix keeps the case and the slash: it is a slice of the line, and
  // `applyCompletion` measures the token by its length.
  assert.equal(commandSuggestions("/Co", ITEMS)?.prefix, "/Co");
  assert.equal(commandSuggestions("  /do", ITEMS)?.prefix, "/do");
});

ok("arguments mean no name completion", () => {
  assert.equal(commandSuggestions("/model ", ITEMS), null);
  assert.equal(commandSuggestions("/set my-set", ITEMS), null);
  assert.equal(commandSuggestions("/compact  ", ITEMS), null);
});

ok("only a `/…` token at the start opens the menu", () => {
  assert.equal(commandSuggestions("hello", ITEMS), null);
  assert.equal(commandSuggestions("hello /co", ITEMS), null);
  assert.equal(commandSuggestions("", ITEMS), null);
  assert.equal(commandSuggestions("/nope", ITEMS), null);
  // Leading whitespace is how the composer indents, not prose.
  assert.deepEqual((commandSuggestions("  /do", ITEMS)?.items ?? []).map((i) => i.value), ["doctor"]);
});

ok("a recipe or skill command completes like a builtin", () => {
  assert.deepEqual(namesFor("/pi"), ["pi-agent-rust"]);
});

// ─── What Enter writes ──────────────────────────────────────────────────────

const complete = (line: string, cursorCol: number, value: string): { line: string; cursorCol: number } => {
  const suggestions = commandSuggestions(line.slice(0, cursorCol), ITEMS);
  assert.ok(suggestions, `no suggestions for ${JSON.stringify(line)}`);
  const item = suggestions.items.find((entry) => entry.value === value);
  assert.ok(item, `${value} is not among the suggestions for ${line}`);
  const result = applyCommandCompletion([line], 0, cursorCol, item, suggestions.prefix);
  return { line: result.lines[0], cursorCol: result.cursorCol };
};

ok("a completed command keeps its slash and gets a space for arguments", () => {
  assert.deepEqual(complete("/co", 3, "compact"), { line: "/compact ", cursorCol: 9 });
  assert.deepEqual(complete("/", 1, "config"), { line: "/config ", cursorCol: 8 });
  // The cursor lands after the space, ready for the argument.
  assert.deepEqual(complete("  /mo", 5, "model"), { line: "  /model ", cursorCol: 9 });
});

ok("completing from the middle of a token does not leave its tail", () => {
  assert.deepEqual(complete("/comp", 5, "compact"), { line: "/compact ", cursorCol: 9 });
  assert.deepEqual(complete("/compact", 8, "compact"), { line: "/compact ", cursorCol: 9 });
});

// ─── The provider the editor gets ───────────────────────────────────────────

/** The editor always passes an abort signal and, on Tab, `force`. */
const request = { signal: new AbortController().signal };

ok("the provider reads the list per keystroke", async () => {
  let announced: Parameters<typeof buildCommandItems>[0] = [];
  const provider = createCommandCompleter(() => buildCommandItems(announced));
  const first = await provider.getSuggestions(["/pi"], 0, 3, request);
  assert.equal(first, null, "nothing before goose announces anything");
  announced = ANNOUNCED;
  const second = await provider.getSuggestions(["/pi"], 0, 3, request);
  assert.deepEqual(second?.items.map((item) => item.value), ["pi-agent-rust"]);
});

ok("the provider says nothing outside a `/…` token", async () => {
  const provider = createCommandCompleter(() => ITEMS);
  assert.equal(await provider.getSuggestions(["hello"], 0, 5, request), null);
  assert.equal(await provider.getSuggestions(["@src/index.ts"], 0, 14, { ...request, force: true }), null);
  assert.equal(
    await provider.getSuggestions(["hello", "/co"], 1, 3, request),
    null,
    "the slash menu is the first line only",
  );
});

ok("the prefix keeps the slash the editor's Enter behaviour keys on", async () => {
  const provider = createCommandCompleter(() => ITEMS);
  const suggestions = await provider.getSuggestions(["/mo"], 0, 3, request);
  assert.equal(suggestions?.prefix, "/mo");
});

ok("the provider applies a pick exactly like the pure helper", async () => {
  const provider = createCommandCompleter(() => ITEMS);
  const suggestions = await provider.getSuggestions(["/co"], 0, 3, request);
  assert.ok(suggestions);
  const result = provider.applyCompletion(["/co"], 0, 3, suggestions.items[0], suggestions.prefix);
  assert.equal(result.lines[0], "/config ");
  assert.equal(result.cursorCol, 8);
});

// ─── runner ─────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, run] of checks) {
  try {
    await run();
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
