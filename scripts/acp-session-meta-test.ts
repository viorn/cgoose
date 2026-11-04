#!/usr/bin/env bun
/**
 * Unit tests for the `session/new` meta cgoose sends (src/acp/session-meta.ts).
 *
 * These pin the deliberate *omissions* as much as the keys: a nested
 * `_meta.goose` object is invisible to goose, and `_meta.provider` silently
 * replaces the model picked in the wizard.
 *
 * Usage: bun run test   (or `bun scripts/acp-session-meta-test.ts`)
 */

import assert from "node:assert/strict";
import { newSessionMeta } from "../src/acp/session-meta";

type Check = [name: string, run: () => void];

const checks: Check[] = [
  ["keys are top-level, never wrapped in `goose`", () => {
    const meta = newSessionMeta({ sessionTitle: "my-session" });
    assert.equal(meta.goose, undefined, "a `goose` wrapper is invisible to the agent");
    assert.equal(meta.client, "cgoose", "`client` is what stores SessionType::User");
    assert.equal(meta.sessionTitle, "my-session");
  }],

  ["`provider` is never sent: goose would ignore GOOSE_MODEL", () => {
    // With `_meta.provider` goose uses the provider registry's default model
    // (live 1.57: custom_kodik + GOOSE_MODEL=qwen/qwen3.6-flash produced
    // deepseek/deepseek-v4-flash), replacing the wizard's choice.
    assert.equal(newSessionMeta({}).provider, undefined);
    assert.equal(newSessionMeta({ sessionTitle: "s", enabledExtensions: [] }).provider, undefined);
    assert.equal("provider" in newSessionMeta({}), false);
  }],

  ["optional keys are omitted, not sent as null/undefined", () => {
    assert.deepEqual(newSessionMeta({}), { client: "cgoose" });
    assert.deepEqual(Object.keys(newSessionMeta({})), ["client"]);
    assert.equal(JSON.parse(JSON.stringify(newSessionMeta({}))).sessionTitle, undefined);
  }],

  ["an empty extension list survives: it means `no extensions at all`", () => {
    const meta = newSessionMeta({ enabledExtensions: [] });
    assert.deepEqual(meta.enabledExtensions, []);
    assert.equal("enabledExtensions" in meta, true, "None must not degrade into the profile");
    assert.deepEqual(
      JSON.parse(JSON.stringify(meta)).enabledExtensions,
      [],
      "an empty array must reach goose as an empty array",
    );
  }],

  ["an extension set is passed through untouched", () => {
    const extensions = [
      { type: "builtin" as const, name: "developer" },
      { type: "mcp" as const, name: "fetch", server: { type: "stdio" as const, name: "fetch", command: "uvx", args: [] } },
    ];
    assert.deepEqual(newSessionMeta({ enabledExtensions: extensions }).enabledExtensions, extensions);
  }],

  ["the wire payload carries exactly the flat keys", () => {
    const payload = JSON.parse(JSON.stringify({
      cwd: "/repo",
      mcpServers: [],
      _meta: newSessionMeta({ sessionTitle: "wire-check" }),
    }));
    assert.deepEqual(Object.keys(payload._meta).sort(), ["client", "sessionTitle"]);
    assert.deepEqual(Object.keys(payload), ["cwd", "mcpServers", "_meta"]);
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
