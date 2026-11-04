#!/usr/bin/env bun
/**
 * Fork probe — does `session/fork` exist and what does it return?
 *
 * Spawns `goose acp`, creates a session, forks it, then renames the fork.
 * No `session/prompt`, so no LLM tokens are spent.
 *
 * Usage: bun scripts/acp-fork-probe.ts
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
  // Answer anything the agent asks the client, so it never blocks.
  if (msg.id !== undefined) {
    let result: unknown = {};
    if (msg.method === "fs/read_text_file") result = { content: "" };
    send({ jsonrpc: "2.0", id: msg.id, result });
  }
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

async function main(): Promise<void> {
  startAgent(EXTRA_ARGS);
  const cwd = process.cwd();

  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    _meta: { goose: { customNotifications: true } },
  });

  const created = await request("session/new", {
    cwd,
    mcpServers: [],
    _meta: newSessionMeta({ sessionTitle: "fork-probe-origin" }),
  });
  const originId = created.sessionId as string;
  process.stdout.write(`session/new → ${originId}\n`);

  let forkId: string | null = null;
  for (const params of [
    { sessionId: originId, cwd, mcpServers: [] },
    { sessionId: originId, cwd, mcpServers: [], _meta: newSessionMeta({ sessionTitle: "fork-probe-copy" }) },
  ]) {
    try {
      const forked = await request("session/fork", params);
      forkId = (forked?.sessionId as string) ?? null;
      process.stdout.write(
        `session/fork (${"_meta" in params ? "with _meta" : "plain"}) → ${JSON.stringify(forked).slice(0, 400)}\n`,
      );
      break;
    } catch (error) {
      process.stdout.write(`session/fork FAILED: ${error}\n`);
    }
  }

  const renameTarget = forkId ?? originId;
  try {
    const renamed = await request("_goose/unstable/session/rename", {
      sessionId: renameTarget,
      title: "fork-probe-renamed",
    });
    process.stdout.write(`rename → ${JSON.stringify(renamed ?? null)}\n`);
  } catch (error) {
    process.stdout.write(`rename FAILED: ${error}\n`);
  }

  process.stdout.write(`\n✅ probe complete, forkId=${forkId}\n`);
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
