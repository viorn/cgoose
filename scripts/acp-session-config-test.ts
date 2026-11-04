#!/usr/bin/env bun
/**
 * Unit tests for applying the wizard's provider/model via ACP
 * (src/acp/session-config.ts).
 *
 * `session/new` resolves the pair from GOOSE_PROVIDER/GOOSE_MODEL, but
 * `session/load` keeps whatever the session row holds, so the ACP-native
 * `session/set_config_option` is the only channel that works on BOTH. These
 * checks pin the ordering rule (provider resets the model, so provider goes
 * first), the idempotence, and the "degrade into a warning, never throw"
 * contract that keeps an older goose usable.
 *
 * Usage: bun run test   (or `bun scripts/acp-session-config-test.ts`)
 */

import assert from "node:assert/strict";
import { applySessionConfig, optionValue, planSessionConfig } from "../src/acp/session-config";
import type { AcpClient } from "../src/acp/client";

type Check = [name: string, run: () => void | Promise<void>];

/** A fake AcpClient that records the requests and answers with canned options. */
function fakeClient(
  respond?: (configId: string, value: string) => unknown,
): { client: AcpClient; calls: Array<{ method: string; params: any }> } {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      return respond ? respond(params.configId, params.value) : { configOptions: [] };
    },
  } as unknown as AcpClient;
  return { client, calls };
}

const checks: Check[] = [
  ["nothing to do when the session already runs the selected pair", () => {
    assert.deepEqual(
      planSessionConfig(
        { provider: "p", model: "m" },
        { provider: "p", model: "m" },
      ),
      [],
    );
  }],

  ["a provider switch is sent first, then the model (the switch resets it)", () => {
    // Live 1.57: setting `provider` makes goose pick that provider's default
    // model, so a model applied before it would be thrown away.
    assert.deepEqual(
      planSessionConfig(
        { provider: "new", model: "m" },
        { provider: "old", model: "m" },
      ),
      [
        { configId: "provider", value: "new" },
        { configId: "model", value: "m" },
      ],
    );
  }],

  ["only the model is sent when the provider is unchanged", () => {
    assert.deepEqual(
      planSessionConfig(
        { provider: "p", model: "new-model" },
        { provider: "p", model: "old-model" },
      ),
      [{ configId: "model", value: "new-model" }],
    );
  }],

  ["a missing current pair means both are applied (resume without row data)", () => {
    assert.deepEqual(
      planSessionConfig({ provider: "p", model: "m" }),
      [
        { configId: "provider", value: "p" },
        { configId: "model", value: "m" },
      ],
    );
  }],

  ["absent desired values never produce a request", () => {
    assert.deepEqual(planSessionConfig({}, { provider: "p", model: "m" }), []);
    assert.deepEqual(planSessionConfig({ provider: null, model: null }, {}), []);
  }],

  ["optionValue reads the current value out of configOptions", () => {
    const options = [
      { id: "provider", currentValue: "custom_kodik" },
      { id: "model", currentValue: "qwen/qwen3.6-flash" },
    ];
    assert.equal(optionValue(options, "model"), "qwen/qwen3.6-flash");
    assert.equal(optionValue(options, "nope"), undefined);
    assert.equal(optionValue(undefined, "model"), undefined);
  }],

  ["the wire request is a bare string value, in provider→model order", async () => {
    const { client, calls } = fakeClient((configId, value) => ({
      configOptions: [{ id: configId, currentValue: value }],
    }));
    const outcome = await applySessionConfig(
      client,
      "sid",
      { provider: "custom_kodik", model: "qwen/qwen3.6-flash" },
      { provider: "custom_openintegration", model: "deepseek/deepseek-v4-flash" },
    );

    assert.deepEqual(calls.map((c) => c.method), ["session/set_config_option", "session/set_config_option"]);
    assert.deepEqual(
      calls.map((c) => c.params),
      [
        { sessionId: "sid", configId: "provider", value: "custom_kodik" },
        { sessionId: "sid", configId: "model", value: "qwen/qwen3.6-flash" },
      ],
      "value must be a bare string: an object makes goose fail deserialization",
    );
    assert.deepEqual(outcome.applied, [
      { configId: "provider", value: "custom_kodik" },
      { configId: "model", value: "qwen/qwen3.6-flash" },
    ]);
    assert.equal(outcome.warning, undefined);
    assert.deepEqual([outcome.provider, outcome.model], ["custom_kodik", "qwen/qwen3.6-flash"]);
  }],

  ["an unchanged pair sends no request at all", async () => {
    const { client, calls } = fakeClient();
    const outcome = await applySessionConfig(
      client,
      "sid",
      { provider: "p", model: "m" },
      { provider: "p", model: "m" },
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(outcome.applied, []);
    assert.equal(outcome.warning, undefined);
  }],

  ["an unsupported config option degrades into a warning, not a failure", async () => {
    // Goose answers an unknown configId with `Invalid params: Unsupported
    // config option: …`; an older goose without the method answers
    // `Method not found`. Both must leave the session usable.
    const { client, calls } = fakeClient(() => {
      throw new Error('Invalid params (code -32602): "Unsupported config option: model"');
    });
    const outcome = await applySessionConfig(client, "sid", { model: "m" }, {});
    assert.equal(calls.length, 1);
    assert.match(outcome.warning ?? "", /Unsupported config option/);
    assert.match(outcome.warning ?? "", /set_config_option/);
    assert.deepEqual(outcome.applied, [], "a failed request is not reported as applied");
  }],

  ["a failure on the second step keeps the first one's effect", async () => {
    const { client, calls } = fakeClient((configId) => {
      if (configId === "model") throw new Error("Method not found");
      return { configOptions: [{ id: "provider", currentValue: "new" }] };
    });
    const outcome = await applySessionConfig(client, "sid", { provider: "new", model: "m" }, { provider: "old" });
    assert.deepEqual(calls.map((c) => c.params.configId), ["provider", "model"]);
    assert.deepEqual(outcome.applied, [{ configId: "provider", value: "new" }]);
    assert.equal(outcome.provider, "new");
    assert.match(outcome.warning ?? "", /model/);
  }],

  ["a silent mismatch between request and effective value is reported", async () => {
    // No error, but goose ended up elsewhere (e.g. the provider's own default
    // model won): the wizard promised something the session does not run.
    const { client } = fakeClient(() => ({
      configOptions: [{ id: "model", currentValue: "deepseek/deepseek-v4-flash" }],
    }));
    const outcome = await applySessionConfig(client, "sid", { model: "qwen/qwen3.6-flash" }, { model: "old" });
    assert.match(outcome.warning ?? "", /deepseek\/deepseek-v4-flash/);
    assert.match(outcome.warning ?? "", /qwen\/qwen3\.6-flash/);
  }],

  ["a response without configOptions trusts the requested value", async () => {
    const { client } = fakeClient(() => ({ configOptions: undefined }));
    const outcome = await applySessionConfig(client, "sid", { provider: "p", model: "m" }, {});
    assert.equal(outcome.warning, undefined);
    assert.deepEqual([outcome.provider, outcome.model], ["p", "m"]);
  }],
];

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
