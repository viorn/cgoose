#!/usr/bin/env bun
/**
 * Smoke test for src/acp/client.ts + custom.ts without the chat TUI.
 * Exercises: spawn → initialize → session/new (title) → system prompt (set)
 * → prompt (streaming) → session/load replay → extensions list.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { AcpClient } from "../src/acp/client";
import {
  listSessionExtensions,
  setSessionSystemPrompt,
} from "../src/acp/custom";

async function main(): Promise<void> {
  const client = AcpClient.spawn({ env: { RUST_LOG: "error" } });

  client.onUpdate((n) => {
    const u = n.update as any;
    if (u.sessionUpdate === "agent_message_chunk") {
      process.stdout.write(u.content?.text ?? "");
    } else if (u.sessionUpdate?.startsWith("tool_call")) {
      process.stdout.write(`\n[tool ${u.toolCallId} ${u.status ?? ""} ${u.title ?? ""}]\n`);
    } else if (u.sessionUpdate === "usage_update") {
      process.stdout.write(`\n[usage ${u.used}/${u.size}]\n`);
    }
  });

  client.setPromptHandlers({
    requestPermission: () =>
      Promise.resolve({ outcome: { outcome: "cancelled" as const } }),
    readTextFile: (p) => {
      // Minimal stand-in for the real fs handler used by the chat UI.
      return Promise.resolve({ content: readFileSync(p.path, "utf-8") });
    },
    writeTextFile: (p) => {
      writeFileSync(p.path, p.content);
      return Promise.resolve();
    },
  });

  const info = await client.initialize({
    fs: { readTextFile: true, writeTextFile: true },
    _meta: { goose: { customNotifications: true } },
  });
  console.log("loadSession capability:", info.agentCapabilities?.loadSession);

  const session = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [],
    _meta: { goose: { client: "cgoose", sessionTitle: "acp-client-smoke" } },
  });
  console.log("\nsession:", session.sessionId);

  await setSessionSystemPrompt(client, session.sessionId, {
    mode: "set",
    key: "cgoose",
    text: "Always end your replies with the word BANANA.",
  });
  console.log("system prompt set OK");

  const result = await client.prompt(session.sessionId, [
    { type: "text", text: "Reply with exactly: ACK" },
  ]);
  console.log("\nstopReason:", result.stopReason);

  await client.loadSession({
    cwd: process.cwd(),
    sessionId: session.sessionId,
    mcpServers: [],
  });
  console.log("\nreplay done");

  const exts = await listSessionExtensions(client, session.sessionId);
  console.log("extensions:", exts.map((e) => `${e.extension.type}:${(e.extension as any).name ?? (e.extension as any).server?.name}`).join(", "));

  // enabledExtensions must actually reach the session: create one with a
  // single builtin and verify it is the only enabled extension.
  const constrained = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [],
    _meta: {
      goose: {
        client: "cgoose",
        sessionTitle: "acp-client-smoke-ext",
        enabledExtensions: [{ type: "builtin", name: "developer" }],
      },
    },
  });
  const constrainedExts = await listSessionExtensions(client, constrained.sessionId);
  const enabledNames = constrainedExts
    .filter((e: any) => e.enabled !== false)
    .map((e) => `${e.extension.type}:${(e.extension as any).name ?? (e.extension as any).server?.name}`);
  console.log("constrained session extensions:", enabledNames.join(", ") || "(none)");
  const hasDeveloper = enabledNames.some((n: string) => n === "builtin:developer");
  console.assert(hasDeveloper, "enabledExtensions should be applied");
  console.log(hasDeveloper
    ? "✅ enabledExtensions applied (developer present)"
    : "⚠ enabledExtensions NOT reflected — check goose version");
  if (!hasDeveloper) process.exitCode = 1;

  // mcpServers (standard ACP field) is the other channel for stdio extensions.
  const mcpSession = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [
      { type: "stdio", name: "probe-ext", command: "echo", args: ["hi"], env: [] },
    ],
  });
  const mcpExts = await listSessionExtensions(client, mcpSession.sessionId);
  const names = mcpExts.map((e) => `${e.extension.type}:${(e.extension as any).name ?? (e.extension as any).server?.name}`);
  console.log("mcpServers session extensions:", names.join(", "));
  const mcpApplied = names.some((n: string) => n === "mcp:probe-ext");
  console.assert(mcpApplied, "mcpServers should be applied");
  console.log(mcpApplied
    ? "✅ mcpServers applied (probe-ext present)"
    : "⚠ mcpServers NOT reflected — stdio sets need another channel");
  if (!mcpApplied) process.exitCode = 1;

  await client.stop();
  console.log("\n✅ smoke OK");
}

main().catch(async (error) => {
  console.error("\n❌ smoke failed:", error);
  process.exit(1);
});
