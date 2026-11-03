#!/usr/bin/env bun
/**
 * ACP probe — Phase 0 verification for cgoose ACP mode.
 *
 * Spawns `goose acp` and exercises the protocol end-to-end:
 *   initialize → session/new (_meta: client/sessionTitle) →
 *   _goose system-prompt/set → session/prompt (collect session/update) →
 *   session/load (replay check)
 *
 * Usage: bun scripts/acp-probe.ts [--timeout-ms 120000]
 * Env:   CGOOSE_ACP_BIN (default "goose"), CGOOSE_ACP_ARGS (e.g. "--with-builtin developer")
 */

import { spawn } from "node:child_process";

// ─── Config ──────────────────────────────────────────────────────────────────

const BIN = process.env.CGOOSE_ACP_BIN || "goose";
const EXTRA_ARGS = (process.env.CGOOSE_ACP_ARGS || "")
  .split(" ")
  .filter(Boolean);
const TIMEOUT_MS = (() => {
  const idx = process.argv.indexOf("--timeout-ms");
  return idx !== -1 ? Number(process.argv[idx + 1]) : 120_000;
})();

let nextId = 1;
let child: ReturnType<typeof spawn> | null = null;
let buffer = "";
const pending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: any) => void }
>();
let onNotification: ((m: any) => void) | null = null;
let onServerRequest: ((m: any) => Promise<any> | any) | null = null;

// ─── Transport ───────────────────────────────────────────────────────────────

function send(msg: Record<string, unknown>): void {
  const line = JSON.stringify(msg);
  process.stdout.write(`→ ${line.slice(0, 200)}${line.length > 200 ? "…" : ""}\n`);
  child!.stdin!.write(line + "\n");
}

function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

function handleMessage(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stdout.write(`⚠ non-JSON stderr-ish line: ${trimmed.slice(0, 120)}\n`);
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code}) ${msg.error.data ?? ""}`));
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.method?.startsWith("session/") || msg.method?.includes("/")) {
    // Server request (fs/*, session/request_permission, …) — auto-respond
    if (msg.id !== undefined && onServerRequest) {
      Promise.resolve(onServerRequest(msg))
        .then((result) => send({ jsonrpc: "2.0", id: msg.id, result }))
        .catch((error) =>
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(error) } }),
        );
      return;
    }
    if (onNotification) {
      onNotification(msg);
      return;
    }
  }
  process.stdout.write(`? ${JSON.stringify(msg).slice(0, 300)}\n`);
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
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleMessage(line);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    process.stdout.write(`[stderr] ${chunk.toString().slice(0, 300)}\n`);
  });
  child.on("exit", (code) => {
    process.stdout.write(`[agent exited: ${code}]\n`);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UPDATE_KINDS: Record<string, (p: any) => string> = {
  agent_message_chunk: (p) => `text:${JSON.stringify(p.content?.text ?? "").slice(0, 60)}`,
  agent_thought_chunk: () => "thought",
  tool_call: (p) => `tool:${p.title ?? p.toolCallId ?? "?"} [${p.status ?? "?"}]`,
  tool_call_update: (p) => `tool-update:${p.toolCallId} [${p.status ?? "?"}]`,
  plan: () => "plan",
  user_message_chunk: () => "user-chunk",
};

function describeUpdate(u: any): string {
  const [kind] = Object.keys(u.sessionUpdate ? { [u.sessionUpdate]: 1 } : u);
  const sessionUpdate = u.sessionUpdate ?? kind;
  const detail = UPDATE_KINDS[sessionUpdate]?.(u) ?? Object.keys(u).join(",");
  return `${sessionUpdate}: ${detail}`;
}

async function withDeadline<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: any;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Probe steps ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  startAgent(EXTRA_ARGS);
  const cwd = process.cwd();
  let sessionId: string | null = null;

  onServerRequest = (msg) => {
    if (msg.method === "session/request_permission") {
      const options = (msg.params?.options ?? []).map((o: any) => `${o.optionId}:${o.name}`);
      process.stdout.write(`  ⚡ permission request: ${options.join(", ")} → allowing once\n`);
      const allowOnce = (msg.params.options ?? []).find(
        (o: any) => o.kind === "allow_once",
      );
      return {
        outcome: allowOnce
          ? { outcome: "selected", optionId: allowOnce.optionId }
          : { outcome: "cancelled" },
      };
    }
    if (msg.method === "fs/read_text_file") {
      process.stdout.write(`  📖 fs/read_text_file ${msg.params.path}\n`);
      return { content: "" };
    }
    process.stdout.write(`  ? server request: ${msg.method}\n`);
    return {};
  };

  onNotification = (msg) => {
    if (msg.method === "session/update") {
      process.stdout.write(`  ← ${describeUpdate(msg.params.update)}\n`);
    } else {
      process.stdout.write(`  ← notify ${msg.method} ${JSON.stringify(msg.params).slice(0, 150)}\n`);
    }
  };

  // 1) initialize
  const init = await withDeadline("initialize", request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    _meta: { goose: { customNotifications: true } },
  }));
  process.stdout.write("\n══ initialize ══\n");
  console.dir(init, { depth: 6, colors: true, maxArrayLength: 40 });

  // 2) session/new
  const newSession = await withDeadline("session/new", request("session/new", {
    cwd,
    mcpServers: [],
    _meta: {
      goose: { client: "cgoose", sessionTitle: "acp-probe" },
    },
  }));
  sessionId = newSession.sessionId;
  process.stdout.write("\n══ session/new ══\n");
  console.dir(newSession, { depth: 6, colors: true, maxArrayLength: 40 });

  // 3) system prompt (goose custom)
  try {
    const r = await withDeadline("system-prompt/set", request(
      "_goose/unstable/session/system-prompt/set",
      { sessionId, mode: "append", key: "cgoose-probe", text: "Always end your replies with the word COCONUT." },
    ));
    process.stdout.write(`\n══ system-prompt/set OK: ${JSON.stringify(r)} ══\n`);
  } catch (error) {
    process.stdout.write(`\n══ system-prompt/set FAILED: ${error} ══\n`);
  }

  // 4) session/prompt
  process.stdout.write("\n══ session/prompt (streaming) ══\n");
  const promptResult = await withDeadline("session/prompt", request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: PONG" }],
  }));
  process.stdout.write(`prompt result: ${JSON.stringify(promptResult)}\n`);

  // 5) session/load (replay)
  process.stdout.write("\n══ session/load (replay) ══\n");
  const loadResult = await withDeadline("session/load", request("session/load", {
    cwd,
    sessionId,
    mcpServers: [],
  }));
  process.stdout.write(
    `load OK: modes=${!!loadResult.modes} configOptions=${!!loadResult.configOptions} meta-keys=${Object.keys(loadResult.meta ?? {})}\n`,
  );

  // 6) goose custom: session extensions list
  try {
    const exts = await withDeadline("session/extensions/list", request(
      "_goose/unstable/session/extensions/list",
      { sessionId },
    ));
    process.stdout.write(
      `\n══ session extensions: ${JSON.stringify((exts.extensions ?? []).map((e: any) => e.extension?.type + ":" + (e.extension?.name ?? e.extension?.server?.name))).slice(0, 300)} ══\n`,
    );
  } catch (error) {
    process.stdout.write(`\n══ session extensions/list FAILED: ${error} ══\n`);
  }

  process.stdout.write(`\n✅ probe complete, sessionId=${sessionId}\n`);
}

main()
  .then(() => {
    child?.kill("SIGTERM");
    setTimeout(() => process.exit(0), 300);
  })
  .catch((error) => {
    process.stderr.write(`\n❌ probe failed: ${error}\n`);
    child?.kill("SIGTERM");
    setTimeout(() => process.exit(1), 300);
  });
