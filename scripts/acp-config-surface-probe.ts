#!/usr/bin/env bun
/**
 * ACP config surface probe — which configuration RPCs actually answer.
 *
 * Spawns `goose acp`, creates a session (no prompt, no LLM tokens), then calls
 * the configuration-related methods one by one and prints either the result
 * (trimmed) or the error. This is how the "what can be configured via ACP"
 * list in the docs was produced.
 *
 * Usage: bun scripts/acp-config-surface-probe.ts
 */

import { spawn } from "node:child_process";
import { newSessionMeta } from "../src/acp/session-meta";

const BIN = process.env.ROSSII_ACP_BIN || "goose";
const TIMEOUT_MS = 120_000;
let nextId = 1;
let child: ReturnType<typeof spawn> | null = null;
let buffer = "";
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let onNotification: ((m: any) => void) | null = null;
let onServerRequest: ((m: any) => Promise<any> | any) | null = null;

function send(msg: Record<string, unknown>): void {
  child!.stdin!.write(JSON.stringify(msg) + "\n");
}

function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function handleMessage(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.id !== undefined && onServerRequest) {
    Promise.resolve(onServerRequest(msg))
      .then((result) => send({ jsonrpc: "2.0", id: msg.id, result }))
      .catch((error) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(error) } }));
    return;
  }
  if (onNotification) onNotification(msg);
}

function startAgent(): void {
  child = spawn(BIN, ["acp"], {
    cwd: process.cwd(),
    env: { ...process.env, RUST_LOG: "error" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      handleMessage(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  });
  child.stderr!.on("data", () => {});
  child.on("exit", () => {});
}

function show(label: string, value: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length > 600) text = text.slice(0, 600) + "…";
  process.stdout.write(`  ${label}: ${text}\n`);
}

async function main(): Promise<void> {
  startAgent();
  onServerRequest = (msg) => {
    if (msg.method === "fs/read_text_file") return { content: "" };
    return {};
  };
  onNotification = () => {};

  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    _meta: { goose: { customNotifications: true } },
  });

  const created = await request("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
    _meta: newSessionMeta({ sessionTitle: "config-surface-probe" }),
  });
  const sessionId = created.sessionId as string;

  process.stdout.write("\n══ configOptions (session/new) ══\n");
  for (const option of created.configOptions ?? []) {
    process.stdout.write(
      `  ${option.id} (type=${option.type ?? "?"}, category=${option.category ?? "?"}) current=${JSON.stringify(option.currentValue ?? null)} values=${Array.isArray(option.options) ? option.options.length : 0}\n`,
    );
  }

  const probes: Array<[string, unknown]> = [
    ["_goose/unstable/config/extensions/list", {}],
    ["_goose/unstable/session/extensions/list", { sessionId }],
    ["_goose/unstable/preferences/read", {}],
    ["_goose/unstable/providers/config/read", {}],
    ["_goose/unstable/providers/config/status", {}],
    ["_goose/unstable/providers/catalog/list", {}],
    ["_goose/unstable/providers/setup/catalog/list", {}],
    ["_goose/unstable/providers/supported-models/list", {}],
    ["_goose/unstable/providers/readiness/check", {}],
    ["_goose/unstable/slash-commands/list", { sessionId }],
    ["_goose/unstable/agent-mentions/list", { sessionId }],
    ["_goose/unstable/config/prompts/list", {}],
    ["_goose/unstable/tools/permissions/set", { sessionId }],
  ];

  process.stdout.write("\n══ custom config methods ══\n");
  for (const [method, params] of probes) {
    try {
      const result = await request(method, params);
      show(method, result);
    } catch (error) {
      show(method, `ERROR: ${error}`);
    }
  }

  process.stdout.write(`\n✅ probe complete, sessionId=${sessionId}\n`);
}

const timer = setTimeout(() => {
  process.stdout.write("⏱ probe timed out\n");
  child?.kill("SIGTERM");
  process.exit(1);
}, TIMEOUT_MS);
timer.unref?.();

main()
  .then(() => {
    child?.kill("SIGTERM");
    setTimeout(() => process.exit(0), 300);
  })
  .catch((error) => {
    process.stdout.write(`❌ ${error}\n`);
    child?.kill("SIGTERM");
    process.exit(1);
  });
