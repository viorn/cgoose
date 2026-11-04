#!/usr/bin/env bun
/**
 * Unit tests for src/acp/extensions.ts (no goose process required).
 *
 * Usage: bun run test   (or `bun scripts/acp-extensions-test.ts`)
 */

import assert from "node:assert/strict";
import {
  buildMcpServers,
  commandToName,
  diffExtensions,
  extensionName,
  httpToName,
  listedExtensionName,
  parseHttpSpec,
  parseStdioSpec,
  planGooseExtensions,
  splitNamePrefix,
} from "../src/acp/extensions";
import type { GooseExtension } from "../src/acp/types";

type Check = [name: string, run: () => void];

const checks: Check[] = [
  ["commandToName: basename of a path", () => {
    assert.equal(commandToName("/usr/bin/python3"), "python3");
    assert.equal(commandToName("npx"), "npx");
  }],

  ["splitNamePrefix: named spec", () => {
    assert.deepEqual(splitNamePrefix("fetch:uvx mcp-server-fetch"), {
      name: "fetch",
      rest: "uvx mcp-server-fetch",
    });
  }],

  ["splitNamePrefix: unnamed spec", () => {
    assert.deepEqual(splitNamePrefix("npx -y @scope/server"), {
      name: null,
      rest: "npx -y @scope/server",
    });
  }],

  ["splitNamePrefix: URL inside args is not a name", () => {
    const { name, rest } = splitNamePrefix("uvx server --url https://example.com/sse");
    assert.equal(name, null);
    assert.equal(rest, "uvx server --url https://example.com/sse");
  }],

  ["parseStdioSpec: name is optional", () => {
    const server = parseStdioSpec("mcpls --trust-project-config");
    assert.ok(server);
    assert.equal(server.type, "stdio");
    assert.equal(server.name, "mcpls");
    assert.equal(server.command, "mcpls");
    assert.deepEqual(server.args, ["--trust-project-config"]);
    assert.deepEqual(server.env, []);
  }],

  ["parseStdioSpec: explicit name + env", () => {
    const server = parseStdioSpec("fetch:UV=1 uvx mcp-server-fetch --url https://example.com/sse");
    assert.ok(server);
    assert.equal(server.name, "fetch");
    assert.equal(server.command, "uvx");
    assert.deepEqual(server.args, ["mcp-server-fetch", "--url", "https://example.com/sse"]);
    assert.deepEqual(server.env, [{ name: "UV", value: "1" }]);
  }],

  ["parseStdioSpec: unnamed spec with URL argument keeps the launcher name", () => {
    const server = parseStdioSpec("uvx mcp-server-fetch --url https://example.com/sse");
    assert.ok(server);
    assert.equal(server.name, "uvx");
    assert.equal(server.command, "uvx");
    assert.deepEqual(server.args, ["mcp-server-fetch", "--url", "https://example.com/sse"]);
  }],

  ["parseStdioSpec: absolute command path", () => {
    const server = parseStdioSpec("/opt/tools/server --stdio");
    assert.ok(server);
    assert.equal(server.name, "server");
    assert.equal(server.command, "/opt/tools/server");
  }],

  ["parseStdioSpec: empty / env-only specs are rejected", () => {
    assert.equal(parseStdioSpec(""), null);
    assert.equal(parseStdioSpec("   "), null);
    assert.equal(parseStdioSpec("only-env:ENV=1"), null);
  }],

  ["httpToName: host + path", () => {
    assert.equal(httpToName("https://mcp.example.com/sse"), "mcp.example.com-sse");
    assert.equal(httpToName("https://example.com"), "example.com");
  }],

  ["parseHttpSpec: url and timeout", () => {
    const server = parseHttpSpec("https://mcp.example.com/sse timeout=30");
    assert.ok(server);
    assert.equal(server.type, "http");
    assert.equal(server.url, "https://mcp.example.com/sse");
    assert.equal(server.name, "mcp.example.com-sse");
  }],

  ["buildMcpServers: dedupes names derived from launchers", () => {
    const servers = buildMcpServers({
      stdio: ["npx -y server-a", "npx -y server-b"],
    });
    assert.equal(servers.length, 2);
    assert.deepEqual(servers.map((s) => s.name), ["npx", "npx-2"]);
  }],

  ["buildMcpServers: distinct HTTP hosts do not collide", () => {
    const servers = buildMcpServers({
      http: ["https://a.example.com/mcp", "https://b.example.com/mcp"],
    });
    assert.equal(servers.length, 2);
    assert.notEqual(servers[0].name, servers[1].name);
  }],

  ["buildMcpServers: mixed stdio + http with duplicate name", () => {
    const servers = buildMcpServers({
      stdio: ["server:cmd"],
      http: ["https://example.com/server"],
    });
    assert.equal(servers.length, 2);
    assert.notEqual(servers[0].name, servers[1].name);
  }],

  ["buildMcpServers: empty input", () => {
    assert.deepEqual(buildMcpServers({}), []);
    assert.deepEqual(buildMcpServers({ stdio: [], http: [] }), []);
  }],

  ["planGooseExtensions: empty set means \"no profile\"", () => {
    const plan = planGooseExtensions({});
    assert.deepEqual(plan.extensions, []);
    assert.deepEqual(plan.unsupported, []);
    assert.equal(Array.isArray(plan.extensions), true, "an empty array must still be sent");
  }],

  ["planGooseExtensions: builtins become typed entries", () => {
    const plan = planGooseExtensions({ builtins: ["developer", "analyze"] });
    assert.deepEqual(plan.extensions, [
      { type: "builtin", name: "developer" },
      { type: "builtin", name: "analyze" },
    ]);
  }],

  ["planGooseExtensions: MCP servers travel as {type:\"mcp\"}", () => {
    const plan = planGooseExtensions({
      builtins: ["developer"],
      stdio: ["fetch:uvx mcp-server-fetch"],
      http: ["https://mcp.example.com/sse"],
    });
    assert.deepEqual(plan.extensions.map(extensionName), ["developer", "fetch", "mcp.example.com-sse"]);
    const mcp = plan.extensions[1] as { type: string; server: { command: string; env: unknown[] } };
    assert.equal(mcp.type, "mcp");
    assert.equal(mcp.server.command, "uvx");
    assert.deepEqual(mcp.server.env, []);
  }],

  ["planGooseExtensions: inline env is unsupported (falls back to mcpServers)", () => {
    const plan = planGooseExtensions({
      builtins: ["developer"],
      stdio: ["fetch:GITHUB_TOKEN=t0ken uvx mcp-server-fetch"],
    });
    assert.deepEqual(plan.extensions, [{ type: "builtin", name: "developer" }]);
    assert.equal(plan.unsupported.length, 1);
    assert.match(plan.unsupported[0], /GITHUB_TOKEN/);
  }],

  ["planGooseExtensions: duplicate names are collapsed", () => {
    const plan = planGooseExtensions({
      builtins: ["npx"],
      stdio: ["npx -y server-a", "npx -y server-b"],
    });
    assert.deepEqual(plan.extensions.map(extensionName), ["npx", "npx-2", "npx-3"]);
  }],

  ["listedExtensionName: version differences", () => {
    assert.equal(listedExtensionName({ extensionKey: "todo", extension: { name: "todo" } }), "todo");
    assert.equal(listedExtensionName({ extension: { name: "analyze" } }), "analyze");
    assert.equal(listedExtensionName({ extension: { server: { name: "fetch" } } }), "fetch");
    assert.equal(listedExtensionName({ name: "legacy" }), "legacy");
    assert.equal(listedExtensionName({}), null);
  }],

  ["diffExtensions: missing and extra extensions", () => {
    const expected: GooseExtension[] = [
      { type: "builtin", name: "developer" },
      { type: "builtin", name: "analyze" },
      { type: "mcp", server: { type: "stdio", name: "fetch" } },
    ];
    const actual = [
      { extensionKey: "developer", extension: { type: "platform", name: "developer" } },
      { extensionKey: "todo", extension: { type: "platform", name: "todo" } },
    ];
    const { add, remove } = diffExtensions(expected, actual);
    assert.deepEqual(add.map(extensionName), ["analyze", "fetch"]);
    assert.deepEqual(remove, ["todo"]);
  }],

  ["diffExtensions: identical sets are a no-op", () => {
    const expected: GooseExtension[] = [{ type: "builtin", name: "developer" }];
    const { add, remove } = diffExtensions(expected, [{ extensionKey: "developer" }]);
    assert.deepEqual(add, []);
    assert.deepEqual(remove, []);
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
