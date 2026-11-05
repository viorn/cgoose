#!/usr/bin/env bun
/**
 * Unit tests for the `/…` routing helpers (src/acp/slash-commands.ts).
 *
 * The announced list below is what goose 1.57.0 sends as `session/update` →
 * `available_commands_update` right after `session/new` (`list_acp_commands` in
 * crates/goose/src/slash_commands/slash_command.rs, whose own test pins exactly
 * these nine builtin names) — so these tests fail if goose's surface changes, not
 * just if the parsing code does something silly.
 *
 * Routing itself has no decision to test any more: everything rossii does not
 * implement is goose's. What is pinned here is what the *client* has to know
 * (which commands rewrite goose's conversation) and the parsing behind `/help`.
 *
 * Usage: bun run test:slash-commands   (or `bun run test`)
 */

import assert from "node:assert/strict";

import {
  HISTORY_REWRITE_COMMANDS,
  commandRewritesHistory,
  formatGooseCommandNames,
  normalizeCommandName,
  parseAvailableCommands,
} from "../src/acp/slash-commands";

type Check = [name: string, run: () => void];

const checks: Check[] = [];

const ok = (name: string, run: () => void): void => {
  checks.push([name, run]);
};

/** What goose 1.57.0 announces, verbatim (names + descriptions). */
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
]);

// ─── Names ──────────────────────────────────────────────────────────────────

ok("goose's announced list is parsed as name + description", () => {
  assert.equal(ANNOUNCED.length, 9);
  assert.deepEqual(ANNOUNCED.map((entry) => entry.name), [
    "prompts",
    "prompt",
    "compact",
    "clear",
    "skills",
    "doctor",
    "goal",
    "grind",
    "status",
  ]);
  assert.equal(ANNOUNCED[2].description, "Compact the conversation history");
});

ok("names are normalized the way goose normalizes them", () => {
  // slash_commands/util.rs: trim_start_matches('/') + to_lowercase.
  assert.equal(normalizeCommandName("/Compact"), "compact");
  assert.equal(normalizeCommandName("  /Review  "), "review");
  assert.equal(normalizeCommandName("compact"), "compact");
  assert.equal(normalizeCommandName("//x"), "x");
});

ok("a recipe announced as `/review` is stored without the slash", () => {
  // list_acp_commands merges recipes and skills; their names may carry the slash.
  const commands = parseAvailableCommands([{ name: "/review", description: "recipe" }]);
  assert.deepEqual(commands, [{ name: "review", description: "recipe" }]);
});

ok("malformed entries are dropped, not trusted", () => {
  const commands = parseAvailableCommands([
    { name: "compact" },
    { description: "no name" },
    { name: "   " },
    "compact",
    null,
    42,
  ]);
  assert.deepEqual(commands.map((entry) => entry.name), ["compact"]);
  assert.deepEqual(parseAvailableCommands(undefined), []);
  assert.deepEqual(parseAvailableCommands("compact"), []);
});

// ─── What the client must know itself ───────────────────────────────────────

ok("the commands that rewrite goose's conversation are known", () => {
  // goose: COMPACT_TRIGGERS.contains(..) || == "/clear" (agents/agent.rs).
  for (const text of ["/compact", "/clear", "/summarize"]) {
    assert.equal(commandRewritesHistory(text), true, text);
  }
  assert.ok(HISTORY_REWRITE_COMMANDS.has("summarize"));
});

ok("a command that only reports on the session does not claim a rewrite", () => {
  for (const text of ["/status", "/doctor", "/skills", "/goal ship it", "/prompts"]) {
    assert.equal(commandRewritesHistory(text), false, text);
  }
});

ok("the check tolerates case, spacing and arguments", () => {
  assert.equal(commandRewritesHistory("  /Compact  "), true);
  assert.equal(commandRewritesHistory("/CLEAR"), true);
  assert.equal(commandRewritesHistory("/compact now"), true);
  assert.equal(commandRewritesHistory("/compactness"), false);
  assert.equal(commandRewritesHistory("/clear-list"), false);
  assert.equal(commandRewritesHistory("/"), false);
  assert.equal(commandRewritesHistory("not a command"), false);
});

// ─── Help line ──────────────────────────────────────────────────────────────

ok("the help line lists the announced names", () => {
  assert.equal(
    formatGooseCommandNames(ANNOUNCED),
    "prompts, prompt, compact, clear, skills, doctor, goal, grind, status",
  );
  assert.equal(formatGooseCommandNames([]), "");
});

// ─── runner ─────────────────────────────────────────────────────────────────

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
