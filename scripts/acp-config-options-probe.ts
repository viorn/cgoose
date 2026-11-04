#!/usr/bin/env bun
/**
 * Config options probe — where does goose expose `configOptions`?
 *
 * Spawns `goose acp` and checks three places without spending LLM tokens
 * (no session/prompt):
 *   1. session/new response
 *   2. session/load response
 *   3. a no-op session/set_config_option response
 *
 * Prints the option ids plus, for provider/model, how many values each offers.
 *
 * Usage: bun scripts/acp-config-options-probe.ts
 * Env:   ROSSII_ACP_BIN (default "goose"), ROSSII_ACP_ARGS
 */

import { spawn } from "node:child_process";

import { newSessionMeta } from "../src/acp/session-meta";

const BIN = process.env.ROSSII_ACP_BIN || "goose";
const EXTRA_ARGS = (process.env.ROSSII_ACP_ARGS || "").split(" ").filter(Boolean);
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

function startAgent(args: string[]): void {
  child = spawn(BIN, ["acp", ...args], {
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
  child.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) process.stdout.write(`[stderr] ${text.slice(0, 200)}\n`);
  });
  child.on("exit", (code) => process.stdout.write(`[agent exited: ${code}]\n`));
}

function summarize(label: string, options: any[] | undefined): void {
  if (!options) {
    process.stdout.write(`  ${label}: (no configOptions field)\n`);
    return;
  }
  process.stdout.write(`  ${label}: ${options.length} option(s)\n`);
  for (const option of options) {
    const values = Array.isArray(option.options) ? option.options.length : 0;
    process.stdout.write(
      `    - id=${option.id} type=${option.type ?? "?"} current=${JSON.stringify(option.currentValue ?? null)} values=${values}\n`,
    );
    if (option.id === "provider" || option.id === "model") {
      const sample = (option.options ?? []).slice(0, 6).map((o: any) => o.value);
      process.stdout.write(`      sample: ${sample.join(", ")}${values > 6 ? ", …" : ""}\n`);
    }
  }
}

async function main(): Promise<void> {
  startAgent(EXTRA_ARGS);
  const cwd = process.cwd();

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

  process.stdout.write("\n══ session/new ══\n");
  const created = await request("session/new", {
    cwd,
    mcpServers: [],
    _meta: newSessionMeta({ sessionTitle: "config-options-probe" }),
  });
  summarize("session/new", created.configOptions);
  const sessionId = created.sessionId as string;

  process.stdout.write("\n══ session/load (same session) ══\n");
  const loaded = await request("session/load", { cwd, sessionId, mcpServers: [] });
  summarize("session/load", loaded?.configOptions);

  const provider = created.configOptions?.find((o: any) => o.id === "provider")?.currentValue;
  const model = created.configOptions?.find((o: any) => o.id === "model")?.currentValue;
  process.stdout.write(`\n══ set_config_option no-op (provider=${provider}) ══\n`);
  try {
    const noop = await request("session/set_config_option", {
      sessionId,
      configId: "provider",
      value: provider,
    });
    summarize("set_config_option", noop?.configOptions);
  } catch (error) {
    process.stdout.write(`  FAILED: ${error}\n`);
  }

  process.stdout.write(`\n✅ probe complete, sessionId=${sessionId}, model=${model}\n`);
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
