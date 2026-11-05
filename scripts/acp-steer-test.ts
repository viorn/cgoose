#!/usr/bin/env bun
/**
 * Unit tests for steering (src/acp/steer.ts).
 *
 * The payloads below are copied from a live goose 1.57.0 trace
 * (`bun scripts/acp-steer-probe.ts`), so the tests fail if goose's meta shape
 * changes — not just if the parsing code does something silly.
 *
 * Usage: bun run test:steer   (or `bun run test`)
 */

import assert from "node:assert/strict";

import {
  activeRunIdFromMeta,
  classifySteerError,
  planSteer,
  queuedSteerIdFromMeta,
  steerChunkId,
} from "../src/acp/steer";

type Check = [name: string, run: () => void];

const checks: Check[] = [];

const ok = (name: string, run: () => void): void => {
  checks.push([name, run]);
};

// ─── The run id ─────────────────────────────────────────────────────────────

ok("`activeRunId` is the id of the running turn", () => {
  // session_info_update on start (live 1.57):
  // _meta={"goose":{"activeRunId":"run_3940b6e2-…"}}
  assert.equal(
    activeRunIdFromMeta({ goose: { activeRunId: "run_3940b6e2-1b40" } }),
    "run_3940b6e2-1b40",
  );
});

ok("`activeRunId: null` means the turn is over, absent means 'no news'", () => {
  // The difference matters: null clears the remembered id, undefined (an
  // update that carries no steering meta at all — a title change, a usage
  // update) must not clear it.
  assert.equal(activeRunIdFromMeta({ goose: { activeRunId: null } }), null);
  assert.equal(activeRunIdFromMeta({ goose: { title: "x" } }), undefined);
  assert.equal(activeRunIdFromMeta({}), undefined);
  assert.equal(activeRunIdFromMeta(undefined), undefined);
  assert.equal(activeRunIdFromMeta(null), undefined);
});

ok("a malformed `activeRunId` is ignored, not trusted", () => {
  assert.equal(activeRunIdFromMeta({ goose: { activeRunId: 42 } }), undefined);
  assert.equal(activeRunIdFromMeta({ goose: "run_x" }), undefined);
});

// ─── The ack ────────────────────────────────────────────────────────────────

ok("`queuedSteer.messageId` is the ack of a queued steer", () => {
  // live: _meta={"goose":{"queuedSteer":{"messageId":"steer_c1bb6831…","runId":"run_…"}}}
  assert.equal(
    queuedSteerIdFromMeta({
      goose: { queuedSteer: { messageId: "steer_c1bb6831", runId: "run_3940" } },
    }),
    "steer_c1bb6831",
  );
});

ok("an update without `queuedSteer` is not an ack", () => {
  assert.equal(queuedSteerIdFromMeta({ goose: { activeRunId: "run_x" } }), undefined);
  assert.equal(queuedSteerIdFromMeta({ goose: { queuedSteer: {} } }), undefined);
  assert.equal(queuedSteerIdFromMeta({ goose: { queuedSteer: { messageId: 7 } } }), undefined);
  assert.equal(queuedSteerIdFromMeta(undefined), undefined);
});

// ─── The delivery ───────────────────────────────────────────────────────────

ok("a `user_message_chunk` flagged `steer` is the delivery", () => {
  // live: user_message_chunk "ADDITIONAL CONTEXT: …"
  //       _meta={"goose":{"created":…,"messageId":"steer_c1bb6831…","steer":true}}
  assert.equal(
    steerChunkId({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "ADDITIONAL CONTEXT" },
      _meta: { goose: { messageId: "steer_c1bb6831", steer: true } },
    }),
    "steer_c1bb6831",
  );
});

ok("an ordinary user message is not a steer", () => {
  assert.equal(
    steerChunkId({ _meta: { goose: { messageId: "gen_1" } } }),
    undefined,
    "no `steer: true` means a normal message (the replay of a steer loses the flag too)",
  );
  assert.equal(steerChunkId({ _meta: { goose: { steer: false, messageId: "x" } } }), undefined);
  assert.equal(
    steerChunkId({ _meta: { goose: { steer: true } } }),
    undefined,
    "an id is required to correlate ack and delivery",
  );
});

// ─── Errors ─────────────────────────────────────────────────────────────────

ok("`-32601` is an old goose, not a broken steer", () => {
  // The client formats the code into the message: `… (code -32601)`.
  assert.equal(classifySteerError("Method not found (code -32601)"), "unsupported");
  assert.equal(
    classifySteerError("method not found: _goose/unstable/session/steer (code -32601)"),
    "unsupported",
  );
});

ok("a turn that ended under us falls back to a normal prompt", () => {
  assert.equal(classifySteerError("no active run to steer (code -32603)"), "no-active-run");
  assert.equal(
    classifySteerError(
      'invalid params: expectedRunId does not match (code -32602): {"expectedRunId":"run_a","actualRunId":"run_b"}',
    ),
    "no-active-run",
  );
  assert.equal(
    classifySteerError("session already has active run `run_3940`; use _goose/unstable/session/steer (code -32602)"),
    "no-active-run",
  );
});

ok("anything else is a real error worth showing", () => {
  assert.equal(classifySteerError("prompt must not be empty (code -32602)"), "other");
  assert.equal(classifySteerError("goose acp exited (code 1)"), "other");
});

// ─── The plan ───────────────────────────────────────────────────────────────

const plan = (input: Partial<Parameters<typeof planSteer>[0]> = {}) =>
  planSteer({ busy: false, runId: null, steerSupported: true, text: "hello", ...input });

ok("while a turn runs, Enter steers it (pinned to the run id)", () => {
  assert.deepEqual(plan({ busy: true, runId: "run_1" }), { kind: "steer", expectedRunId: "run_1" });
});

ok("a turn whose run id has not arrived yet queues instead of dropping", () => {
  assert.deepEqual(plan({ busy: true, runId: null }), {
    kind: "queue",
    reason: "no-active-run",
  });
});

ok("a goose without steering queues too (never a silent no-op)", () => {
  assert.deepEqual(plan({ busy: true, runId: "run_1", steerSupported: false }), {
    kind: "queue",
    reason: "unsupported",
  });
});

ok("idle Enter is an ordinary prompt", () => {
  assert.deepEqual(plan(), { kind: "idle" });
  assert.deepEqual(plan({ runId: "run_stale" }), { kind: "idle" });
});

ok("a slash command belongs to the chat, mid-turn or not", () => {
  assert.deepEqual(plan({ text: "/think expand" }), { kind: "command" });
  assert.deepEqual(plan({ busy: true, runId: "run_1", text: "/think expand" }), {
    kind: "command",
  });
  assert.deepEqual(plan({ busy: true, runId: "run_1", steerSupported: false, text: "/config" }), {
    kind: "command",
  });
});

ok("only a leading slash makes it a command", () => {
  assert.deepEqual(plan({ busy: true, runId: "run_1", text: " not a command" }), {
    kind: "steer",
    expectedRunId: "run_1",
  });
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
