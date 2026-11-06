#!/usr/bin/env bun
/**
 * Unit tests for the model menu's entry list (src/acp/model-options.ts).
 *
 * Why this merge exists: goose's `configOptions.model.options` is rebuilt from an
 * in-process provider registry that only reloads when a provider is created,
 * updated or deleted over ACP. A model written into `custom_providers/<n>.json`
 * by `/model fetch` is invisible to it until goose restarts, so the menu unions
 * goose's list with the provider JSON's `models` array — the same source the
 * wizard's model step reads.
 *
 * What is pinned:
 * - goose's entries come first and keep their order and labels
 * - JSON-only models follow, deduplicated by id (a model goose already knows is
 *   never listed twice, whatever its label is)
 * - the JSON context limit becomes the entry's description; absent → no hint
 * - an empty goose list still yields the JSON models (goose may report none)
 *
 * Usage: bun run test:model-options   (or `bun run test`)
 */

import assert from "node:assert/strict";

import { mergeModelOptions, orderByUsage, orderModelMenu } from "../src/acp/model-options";

type Check = [name: string, run: () => void];

const checks: Check[] = [];

const ok = (name: string, run: () => void): void => {
  checks.push([name, run]);
};

// ─── precedence and order ───────────────────────────────────────────────────

ok("goose's entries come first, in goose's order", () => {
  const merged = mergeModelOptions(
    [
      { value: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { value: "qwen/qwen3.6-flash", name: "Qwen 3.6 Flash" },
    ],
    [{ name: "new-model" }],
  );
  assert.deepEqual(
    merged.map((item) => item.value),
    ["deepseek/deepseek-v4-flash", "qwen/qwen3.6-flash", "new-model"],
  );
});

ok("goose's label wins over the raw id", () => {
  const merged = mergeModelOptions([{ value: "id-1", name: "Nice Name" }], []);
  assert.equal(merged[0].label, "Nice Name");
});

ok("an entry without a name falls back to its id", () => {
  const merged = mergeModelOptions([{ value: "id-1" }], []);
  assert.equal(merged[0].label, "id-1");
});

// ─── deduplication ──────────────────────────────────────────────────────────

ok("a model goose already lists is not repeated from the JSON", () => {
  const merged = mergeModelOptions(
    [{ value: "qwen/qwen3.6-flash", name: "Qwen" }],
    [{ name: "qwen/qwen3.6-flash", contextLimit: 128_000 }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].label, "Qwen", "goose's label survives the merge");
});

ok("duplicates are matched by id, not by label", () => {
  const merged = mergeModelOptions(
    [{ value: "id-1", name: "Pretty" }],
    [{ name: "id-1" }, { name: "id-2" }],
  );
  assert.deepEqual(merged.map((item) => item.value), ["id-1", "id-2"]);
});

ok("a duplicate inside the JSON is listed once", () => {
  // `addModelToCustomProviderJson` guards this, but a hand-edited file may not.
  const merged = mergeModelOptions([], [{ name: "m" }, { name: "m" }]);
  assert.equal(merged.length, 1);
});

// ─── descriptions ───────────────────────────────────────────────────────────

ok("the JSON context limit becomes the description", () => {
  const merged = mergeModelOptions([], [{ name: "m", contextLimit: 131_072 }]);
  assert.equal(merged[0].description, "context: 131 072");
});

ok("a model without a context limit has no description", () => {
  const merged = mergeModelOptions([], [{ name: "m" }]);
  assert.equal(merged[0].description, undefined);
});

ok("goose's entries carry no description of their own", () => {
  const merged = mergeModelOptions([{ value: "id-1", name: "N" }], []);
  assert.equal(merged[0].description, undefined);
});

// ─── empty inputs ───────────────────────────────────────────────────────────

ok("no goose list still yields the JSON models", () => {
  // An older goose or a provider without config options reports nothing at all;
  // the custom provider's own list must still be selectable.
  const merged = mergeModelOptions([], [{ name: "a" }, { name: "b" }]);
  assert.deepEqual(merged.map((item) => item.value), ["a", "b"]);
});

ok("both sources empty gives an empty list", () => {
  assert.deepEqual(mergeModelOptions([], []), []);
});

ok("an empty JSON list leaves goose's entries untouched", () => {
  const goose = [{ value: "id-1", name: "N" }];
  assert.deepEqual(mergeModelOptions(goose, []), [{ value: "id-1", label: "N" }]);
});

// ─── usage history (the wizard's order, shared with the chat menus) ──────────

ok("orderByUsage: history entries come first, in history order", () => {
  const ordered = orderByUsage(
    [{ value: "a" }, { value: "b" }, { value: "c" }, { value: "d" }],
    ["c", "a"],
  );
  assert.deepEqual(ordered.map((item) => item.value), ["c", "a", "b", "d"]);
});

ok("orderByUsage: the tail keeps the caller's order (goose's)", () => {
  // Only the used entries move; goose's own ordering of the rest is not ours
  // to rewrite.
  const ordered = orderByUsage([{ value: "z" }, { value: "y" }, { value: "x" }], ["y"]);
  assert.deepEqual(ordered.map((item) => item.value), ["y", "z", "x"]);
});

ok("orderByUsage: no history leaves the list untouched", () => {
  const items = [{ value: "a" }, { value: "b" }];
  assert.deepEqual(orderByUsage(items, []).map((item) => item.value), ["a", "b"]);
});

ok("orderByUsage: a history entry that is not in the list is ignored", () => {
  const ordered = orderByUsage([{ value: "a" }, { value: "b" }], ["gone", "b"]);
  assert.deepEqual(ordered.map((item) => item.value), ["b", "a"]);
});

ok("orderByUsage: does not mutate the input", () => {
  const items = [{ value: "a" }, { value: "b" }];
  orderByUsage(items, ["b"]);
  assert.deepEqual(items.map((item) => item.value), ["a", "b"]);
});

ok("orderModelMenu: this provider's history first, then goose, then the JSON", () => {
  const merged = mergeModelOptions(
    [
      { value: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { value: "qwen/qwen3.6-flash", name: "Qwen 3.6 Flash" },
    ],
    [{ name: "json-only" }],
  );
  const ordered = orderModelMenu(merged, ["qwen/qwen3.6-flash"]);
  assert.deepEqual(
    ordered.map((item) => item.value),
    ["qwen/qwen3.6-flash", "deepseek/deepseek-v4-flash", "json-only"],
  );
  assert.equal(ordered[0].label, "Qwen 3.6 Flash", "the goose label survives reordering");
});

ok("orderModelMenu: history is ordered last-used first", () => {
  const merged = mergeModelOptions([
    { value: "a" },
    { value: "b" },
    { value: "c" },
  ], []);
  const ordered = orderModelMenu(merged, ["c", "a"]);
  assert.deepEqual(ordered.map((item) => item.value), ["c", "a", "b"]);
});

ok("orderModelMenu: a history-only model stays selectable", () => {
  // The wizard offers it too; goose may have stopped advertising a model the
  // project used last week, which must not hide it from the chat.
  const ordered = orderModelMenu(mergeModelOptions([{ value: "a" }], []), ["old-model"]);
  assert.deepEqual(ordered.map((item) => item.value), ["old-model", "a"]);
  assert.equal(ordered[0].description, "history");
});

ok("orderModelMenu: a history model goose also lists is not duplicated", () => {
  const ordered = orderModelMenu(mergeModelOptions([{ value: "a", name: "A" }], []), ["a"]);
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].label, "A");
  assert.equal(ordered[0].description, undefined);
});

ok("orderModelMenu: repeated history entries are listed once", () => {
  const ordered = orderModelMenu(mergeModelOptions([{ value: "a" }], []), ["a", "a"]);
  assert.deepEqual(ordered.map((item) => item.value), ["a"]);
});

ok("orderModelMenu: no history = the plain merge", () => {
  const merged = mergeModelOptions([{ value: "a", name: "A" }], [{ name: "b" }]);
  assert.deepEqual(orderModelMenu(merged, []), merged);
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
