#!/usr/bin/env bun
/**
 * Steering probe — live verification for "send context while the model works".
 *
 * Flow: initialize → session/new → session/prompt (fire and forget) →
 * the first `session/update` carrying `_meta.goose.activeRunId` →
 * `_goose/unstable/session/steer` with that run id → observe
 * `_meta.goose.queuedSteer` (ack) and the picked-up `user_message_chunk`
 * (with `_meta.goose.steer: true`) → cancel → exit.
 *
 * Costs a couple of tokens (one tiny prompt, cancelled right after the steer is
 * picked up). No other side effects: the session is left in `sessions.db` as a
 * normal `rossii-steer-probe` session.
 *
 * Usage: bun scripts/acp-steer-probe.ts [--timeout-ms 30000]
 * Env:   ROSSII_ACP_BIN (default "goose"), ROSSII_ACP_ARGS
 */

import { spawn } from "node:child_process";

const BIN = process.env.ROSSII_ACP_BIN || "goose";
const EXTRA_ARGS = (process.env.ROSSII_ACP_ARGS || "").split(" ").filter(Boolean);
const TIMEOUT_MS = (() => {
  const i = process.argv.indexOf("--timeout-ms");
  return i !== -1 ? Number(process.argv[i + 1]) : 30_000;
})();

let nextId = 1;
let buffer = "";
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let sessionId = "";
let runId = "";
let steerSent = false;
let queuedAck = "";
let pickedUp = "";

const child = spawn(BIN, ["acp", ...EXTRA_ARGS], {
  cwd: process.cwd(),
  env: { ...process.env, RUST_LOG: "error" },
  stdio: ["pipe", "pipe", "pipe"],
});

function send(msg: Record<string, unknown>): void {
  child.stdin!.write(JSON.stringify(msg) + "\n");
}

function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timeout (client)`));
    }, 30_000);
  });
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

/** `_meta.goose.activeRunId` — set when a run starts, `null` when it ends. */
function activeRunIdFrom(meta: any): string | null | undefined {
  const goose = meta?.goose;
  if (!goose || !("activeRunId" in goose)) return undefined;
  return typeof goose.activeRunId === "string" || goose.activeRunId === null
    ? goose.activeRunId
    : undefined;
}

/** `_meta.goose.queuedSteer.messageId` — ack that the steer was queued. */
function queuedSteerIdFrom(meta: any): string | undefined {
  const q = meta?.goose?.queuedSteer;
  return typeof q?.messageId === "string" ? q.messageId : undefined;
}

/** A picked-up steer echoes as a user chunk flagged `_meta.goose.steer`. */
function steerChunkFrom(update: any): string | undefined {
  const goose = update?._meta?.goose;
  if (goose?.steer !== true || typeof goose.messageId !== "string") return undefined;
  return goose.messageId;
}

async function trySteer(): Promise<void> {
  if (steerSent || !runId || !sessionId) return;
  steerSent = true;
  try {
    const result = await request("_goose/unstable/session/steer", {
      sessionId,
      prompt: [{ type: "text", text: "ADDITIONAL CONTEXT: also reply with STEERED-OK" }],
      expectedRunId: runId,
    });
    console.log(`>>> steer ACCEPTED: ${JSON.stringify(result)}`);
  } catch (error) {
    console.log(`>>> steer REJECTED: ${error}`);
  }
  // Give the agent a moment to pick the steer up at the turn boundary, then
  // stop the turn: the probe must not burn a full conversation.
  setTimeout(() => {
    console.log(">>> cancelling the run");
    notify("session/cancel", { sessionId });
  }, 8_000);
}

child.stdout!.setEncoding("utf-8");
child.stdout!.on("data", (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log(`⚠ non-JSON: ${line.slice(0, 150)}`);
      continue;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error
          ? p.reject(new Error(`${msg.error.message} :: ${JSON.stringify(msg.error.data)}`))
          : p.resolve(msg.result);
      }
      continue;
    }
    if (msg.method === "session/request_permission") {
      const allow = (msg.params?.options ?? []).find((o: any) => o.kind === "allow_once");
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" },
      });
      continue;
    }
    if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      continue;
    }
    if (msg.method !== "session/update") continue;

    const update = msg.params?.update ?? {};
    const meta = update._meta ?? msg.params?._meta;
    const text = update.content?.type === "text" ? update.content.text.slice(0, 60) : "";
    if (meta) console.log(`  ← ${update.sessionUpdate} ${text} || _meta=${JSON.stringify(meta)}`);

    const run = activeRunIdFrom(meta);
    if (typeof run === "string" && !runId) {
      runId = run;
      console.log(`\n>>> activeRunId observed: ${run}`);
      void trySteer();
    } else if (run === null) {
      console.log(">>> activeRunId cleared (run finished)");
    }
    const ack = queuedSteerIdFrom(meta);
    if (ack && !queuedAck) {
      queuedAck = ack;
      console.log(`>>> queuedSteer ack: ${ack}`);
    }
    const picked = steerChunkFrom(update);
    if (picked && !pickedUp) {
      pickedUp = picked;
      console.log(`>>> steer picked up as user_message_chunk: ${picked}`);
    }
  }
});
child.stderr!.setEncoding("utf-8");
child.stderr!.on("data", (c: string) => process.stdout.write(`[stderr] ${c.slice(0, 200)}\n`));
child.on("exit", (code) => console.log(`[agent exited ${code}]`));

const timer = setTimeout(finish, TIMEOUT_MS);

function finish(): void {
  clearTimeout(timer);
  console.log("\n═══ result ═══");
  console.log(`activeRunId seen: ${runId || "NO"}`);
  console.log(`steer accepted:   ${steerSent ? "YES" : "NO"}`);
  console.log(`queuedSteer ack:  ${queuedAck || "NO"}`);
  console.log(`steer picked up:  ${pickedUp || "NO (turn ended before the pickup point)"}`);
  console.log(`ids match:        ${queuedAck && queuedAck === pickedUp ? "YES" : "NO"}`);
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  process.exit(0);
}

// ─── run ─────────────────────────────────────────────────────────────────────

const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  _meta: { goose: { customNotifications: true } },
});
console.log(`goose: ${JSON.stringify(init.agentInfo)}`);

const created = await request("session/new", {
  cwd: process.cwd(),
  mcpServers: [],
  _meta: { sessionTitle: "rossii-steer-probe", client: "rossii" },
});
sessionId = created.sessionId;
console.log(`session: ${sessionId}`);

console.log(">>> prompting (cheap, cancelled right after the steer is picked up)");
void request("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: "Reply with the single word PINEAPPLE." }],
}).then(
  (r) => console.log(`>>> prompt resolved: ${JSON.stringify(r)}`),
  (e) => console.log(`>>> prompt failed: ${e}`),
);
