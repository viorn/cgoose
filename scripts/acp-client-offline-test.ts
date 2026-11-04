#!/usr/bin/env bun
/**
 * Offline regression tests for the ACP layer — no goose, no provider.
 *
 * Spawns a tiny fake ACP agent (written to a temp dir) and checks:
 *   - initialize / session/load replay ordering
 *   - usage_update cost shape
 *   - prompt timeout sends session/cancel
 *   - requests after stop() reject instead of hanging forever
 *   - stderr chunks are joined into whole lines
 *   - an agent that dies outside stop() cannot hang a request
 *   - chat watchdog timeouts (src/acp/timeouts.ts) honour 0 and warn on junk
 *   - the `session/new` meta stays flat on the wire (no `provider`, no `goose` wrapper)
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "../src/acp/client";
import { newSessionMeta } from "../src/acp/session-meta";
import { listSessionExtensions, removeSessionExtension } from "../src/acp/custom";
import { listedExtensionName } from "../src/acp/extensions";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  resolveTimeoutMs,
} from "../src/acp/timeouts";

assert.deepEqual(resolveTimeoutMs(undefined, 5, "X"), { ms: 5, invalid: null });
assert.deepEqual(resolveTimeoutMs("   ", 5, "X"), { ms: 5, invalid: null });
assert.deepEqual(resolveTimeoutMs("1500", 5, "X"), { ms: 1500, invalid: null });
assert.deepEqual(resolveTimeoutMs("0", 5, "X"), { ms: 0, invalid: null }, "0 disables the guard");
assert.equal(resolveTimeoutMs("-1", 5, "X").ms, 5, "a negative timeout is rejected");
const junk = resolveTimeoutMs("5m", 5, "CGOOSE_ACP_IDLE_TIMEOUT_MS");
assert.equal(junk.ms, 5, "junk falls back to the default");
assert.match(String(junk.invalid), /CGOOSE_ACP_IDLE_TIMEOUT_MS="5m"/, "junk is reported to the user");
assert.ok(
  DEFAULT_IDLE_TIMEOUT_MS > 0 && DEFAULT_TURN_TIMEOUT_MS > DEFAULT_IDLE_TIMEOUT_MS,
  "the idle guard must be the tighter of the two",
);
console.log("✅ watchdog timeouts: defaults, 0 disables, junk warns instead of disabling");

const AGENT_SOURCE = String.raw`
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const NL = String.fromCharCode(10);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + NL);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
let permissionId = 9000;
let pendingPrompt = null;
let pendingPermission = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id === pendingPermission) {
    // Permission answer from the client: finish the turn it was asked for.
    send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "end_turn" } });
    pendingPermission = null;
    pendingPrompt = null;
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/new") {
    // Report the meta back so the test can assert its shape on the wire.
    process.stderr.write("NEW_SESSION_META=" + JSON.stringify(msg.params._meta ?? null) + NL);
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
  } else if (msg.method === "session/load") {
    notify("session/update", { sessionId: "s1", update: { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "hello " } } });
    notify("session/update", { sessionId: "s1", update: { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "world" } } });
    notify("session/update", { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "first" } } });
    notify("session/update", { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", messageId: "a2", content: { type: "text", text: "second" } } });
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const text = msg.params.prompt?.[0]?.text ?? "";
    pendingPrompt = msg.id;
    if (text === "hang") return;
    if (text === "stderr-split") {
      // A stderr line split across two chunks — the client must join them.
      process.stderr.write("half");
      setTimeout(() => process.stderr.write("-line" + NL), 30);
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        pendingPrompt = null;
      }, 60);
      return;
    }
    notify("session/update", { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "pong" } } });
    notify("session/update", { sessionId: sid, update: { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.0123, currency: "USD" } } });
    if (text === "permission") {
      pendingPermission = permissionId;
      send({ jsonrpc: "2.0", id: permissionId++, method: "session/request_permission", params: { sessionId: sid, toolCall: { title: "run" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    pendingPrompt = null;
  } else if (msg.method === "_goose/unstable/session/extensions/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { extensions: [{ extension: { type: "platform", name: "developer" }, extensionKey: "developer" }] } });
  } else if (msg.method === "_goose/unstable/session/extensions/remove") {
    // Pretend to be a goose that renamed the field: only "name" is accepted,
    // so the client has to retry after the parameter error.
    if (msg.params && "extensionKey" in msg.params) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params", data: "missing field name" } });
    } else if (msg.params && msg.params.name) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
    }
  } else if (msg.method === "session/cancel") {
    process.stderr.write("cancelled" + String.fromCharCode(10));
    if (pendingPrompt !== null) {
      send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "cancelled" } });
      pendingPrompt = null;
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function makeFakeGoose(): string {
  const dir = mkdtempSync(join(tmpdir(), "cgoose-fake-acp-"));
  const agentPath = join(dir, "agent.mjs");
  const binPath = join(dir, "goose");
  writeFileSync(agentPath, AGENT_SOURCE);
  writeFileSync(binPath, `#!/bin/sh\nexec node "${agentPath}" "$@"\n`);
  chmodSync(binPath, 0o755);
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return binPath;
}

const bin = makeFakeGoose();
const stderr: string[] = [];
const client = AcpClient.spawn({ bin, onStderr: (line) => stderr.push(line) });

const updates: any[] = [];
client.onUpdate((n) => updates.push(n.update));
client.setPromptHandlers({
  requestPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" as const } }),
});

// initialize + capability negotiation
const info = await client.initialize({ fs: { readTextFile: true } });
assert.equal(info.agentCapabilities?.loadSession, true);
assert.equal(client.supportsLoadSession(), true);

// `session/new` meta must reach the agent flat and without `provider`: goose reads
// session fields at the top level of `_meta`, and `_meta.provider` would make it
// take the model from the provider registry instead of GOOSE_MODEL
// (see scripts/acp-session-meta-test.ts).
stderr.length = 0;
await client.newSession({
  cwd: process.cwd(),
  mcpServers: [],
  _meta: newSessionMeta({ sessionTitle: "wire-check" }),
});
await new Promise((resolve) => setTimeout(resolve, 80));
const metaLine = stderr.find((line) => line.startsWith("NEW_SESSION_META="));
assert.ok(metaLine, "the fake agent must report the session/new meta");
assert.deepEqual(
  JSON.parse(metaLine.slice("NEW_SESSION_META=".length)),
  { client: "cgoose", sessionTitle: "wire-check" },
);
console.log("✅ session/new meta is flat on the wire (client/sessionTitle, no provider)");

// session/load replays user and assistant messages with messageId boundaries
await client.loadSession({ cwd: process.cwd(), sessionId: "s1", mcpServers: [] });
assert.deepEqual(
  updates.map((u) => `${u.sessionUpdate}:${u.messageId ?? ""}:${u.content?.text ?? ""}`),
  [
    "user_message_chunk:u1:hello ",
    "user_message_chunk:u1:world",
    "agent_message_chunk:a1:first",
    "agent_message_chunk:a2:second",
  ],
);
console.log("✅ session/load replay carries user_message_chunk + messageId");

// prompt streams updates; cost follows the ACP { amount, currency } shape
updates.length = 0;
const result = await client.prompt("s1", [{ type: "text", text: "hi" }], 5_000);
assert.equal(result.stopReason, "end_turn");
assert.deepEqual(updates.find((u) => u.sessionUpdate === "usage_update")?.cost, {
  amount: 0.0123,
  currency: "USD",
});
console.log("✅ prompt result + usage_update.cost");

// A turn that asks for permission must resolve once the client answers
const permissionResult = await client.prompt("s1", [{ type: "text", text: "permission" }], 5_000);
assert.equal(permissionResult.stopReason, "end_turn");
console.log("✅ agent→client permission request is answered and the turn completes");

// stderr is reassembled per line, not per chunk
stderr.length = 0;
await client.prompt("s1", [{ type: "text", text: "stderr-split" }], 5_000);
await new Promise((resolve) => setTimeout(resolve, 100));
assert.deepEqual(stderr, ["half-line"], "both chunks must arrive as one line");
console.log("✅ stderr chunks are joined into whole lines");

// The set is reconciled through goose custom requests; the field name of
// `extensions/remove` differs between goose versions, so it must fall back.
const listed = await listSessionExtensions(client, "s1");
assert.deepEqual(listed.map(listedExtensionName), ["developer"]);
await removeSessionExtension(client, "s1", "todo");
console.log("✅ extension list parses, remove retries with the other field name");

// A timed-out prompt must reject and cancel the turn at the agent
await assert.rejects(
  () => client.prompt("s1", [{ type: "text", text: "hang" }], 300),
  /acp request timeout: session\/prompt/,
);
await new Promise((resolve) => setTimeout(resolve, 150));
assert.ok(stderr.some((line) => line.includes("cancelled")), "agent must receive session/cancel");
console.log("✅ prompt timeout rejects and sends session/cancel");

// After stop the transport is closed: nothing may hang on a dead agent
await client.stop();
assert.equal(client.closed, true);
await assert.rejects(() => client.request("session/new", {}), /transport closed/);
console.log("✅ closed transport rejects instead of hanging");

// An agent that dies on its own (crash, kill) must settle requests as well:
// this is the scenario that used to freeze the chat with `busy` forever.
let resolveDied: () => void = () => {};
const died = new Promise<void>((resolve) => { resolveDied = resolve; });
const dying = AcpClient.spawn({ bin, onExit: () => resolveDied() });
await dying.initialize({ fs: { readTextFile: true } });
process.kill((dying as unknown as { child: { pid: number } }).child.pid, "SIGKILL");
await died;
assert.equal(dying.closed, true, "exitCode/signalCode must mark the transport closed");
const settled = await Promise.race([
  dying.request("session/new", { cwd: process.cwd(), mcpServers: [] }).then(
    () => "resolved",
    (error: Error) => `rejected: ${error.message}`,
  ),
  new Promise((resolve) => setTimeout(() => resolve("hung"), 1_500)),
]);
assert.match(String(settled), /^rejected:/, `the request must settle, got: ${settled}`);
console.log(`✅ agent death outside stop() settles requests (${settled})`);
await dying.stop();

console.log("\n✅ client offline checks passed");
