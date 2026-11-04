/**
 * Parsing of goose extension specs into ACP MCP-server objects.
 *
 * Pure functions, exported for unit testing (scripts/acp-extensions-test.ts).
 *
 * Classic `goose session --with-extension` accepts `[name:]ENV=val cmd args…`
 * where the `name:` prefix is OPTIONAL (the launcher command's basename is
 * used when absent). Specs without a name must still work in chat mode, so
 * `parseStdioSpec` derives the name from the command when the prefix is
 * missing.
 *
 * The ACP `McpServer` objects produced here travel in the standard
 * `session/new.mcpServers` field — the channel verified to work on goose 1.57.
 */

// ─── ACP McpServer shapes (subset of the ACP schema) ─────────────────────────

export interface McpEnvVariable {
  name: string;
  value: string;
}

export interface McpServerStdio {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env: McpEnvVariable[];
}

export interface McpServerHttp {
  type: "http";
  name: string;
  url: string;
  headers?: Array<{ name: string; value: string }>;
}

export type McpServer = McpServerStdio | McpServerHttp;

// ─── Naming helpers ──────────────────────────────────────────────────────────

/** Sanitize a human-readable string into an MCP server name. */
function sanitizeName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** Derive an MCP server name from a command path (basename, sanitized). */
export function commandToName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return sanitizeName(base) || "extension";
}

/**
 * Derive an MCP server name from a URL. Uses host + path so that two servers
 * on different hosts do not collide on the last path segment.
 */
export function httpToName(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return sanitizeName(`${parsed.host}${path}`) || "http-extension";
  } catch {
    return commandToName(url);
  }
}

/**
 * Split the optional `name:` prefix off a stdio spec.
 *
 * The prefix is recognised only when the text before the first colon looks
 * like a bare identifier. A colon that is part of a URL scheme (`https://`) or
 * a Windows drive path (`C:\`) is not treated as a name separator, and a
 * colon inside the arguments (where the prefix would contain whitespace) is
 * left alone.
 */
export function splitNamePrefix(spec: string): { name: string | null; rest: string } {
  const colonIdx = spec.indexOf(":");
  if (colonIdx <= 0) return { name: null, rest: spec };

  const prefix = spec.slice(0, colonIdx);
  const after = spec.slice(colonIdx + 1);

  // URL scheme (`https://…`) — never a name.
  if (after.startsWith("//")) return { name: null, rest: spec };
  // Windows drive path (`C:\…` / `C:/…`) — a single-letter "name" is a drive.
  if (prefix.length === 1 && (after.startsWith("\\") || after.startsWith("/"))) {
    return { name: null, rest: spec };
  }
  // The prefix must be a bare identifier (no spaces/slashes/braces).
  if (!/^[\w.-]+$/.test(prefix)) return { name: null, rest: spec };

  return { name: prefix, rest: after.trim() };
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Parse a goose stdio spec `[name:]ENV=val cmd args...`.
 * Leading `KEY=value` tokens are env vars (values with spaces are not
 * supported — the same limitation as the classic CLI spec format).
 */
export function parseStdioSpec(spec: string): McpServerStdio | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  const { name, rest } = splitNamePrefix(trimmed);
  const tokens = rest.split(/\s+/).filter(Boolean);
  const env: McpEnvVariable[] = [];
  let i = 0;
  while (i < tokens.length && /^\w+=/.test(tokens[i])) {
    const eq = tokens[i].indexOf("=");
    env.push({ name: tokens[i].slice(0, eq), value: tokens[i].slice(eq + 1) });
    i++;
  }
  if (i >= tokens.length) return null;

  const command = tokens[i];
  return {
    type: "stdio",
    name: name ?? commandToName(command),
    command,
    args: tokens.slice(i + 1),
    env,
  };
}

/**
 * Parse a goose streamable-http spec `url timeout=N`. `timeout` has no
 * representation in an ACP `McpServerHttp` object and is ignored.
 */
export function parseHttpSpec(spec: string): McpServerHttp | null {
  const url = spec.trim().split(/\s+/)[0];
  if (!url) return null;
  return { type: "http", name: httpToName(url), url };
}

// ─── Building the `mcpServers` array ─────────────────────────────────────────

/** Ensure a server name is unique inside `used`, adding `-2`, `-3`, … */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let suffix = 2;
  while (used.has(`${name}-${suffix}`)) suffix++;
  const result = `${name}-${suffix}`;
  used.add(result);
  return result;
}

/**
 * Build the ACP `session/new.mcpServers` payload from raw set specs.
 *
 * Names are made unique: `npx -y server-a` and `npx -y server-b` both derive
 * `npx` from the launcher command, and two MCP servers with the same name
 * would collide inside goose.
 */
export function buildMcpServers(specs: {
  stdio?: string[];
  http?: string[];
}): McpServer[] {
  const used = new Set<string>();
  const servers: McpServer[] = [];

  for (const spec of specs.stdio ?? []) {
    const server = parseStdioSpec(spec);
    if (!server) continue;
    servers.push({ ...server, name: uniqueName(server.name, used) });
  }
  for (const spec of specs.http ?? []) {
    const server = parseHttpSpec(spec);
    if (!server) continue;
    servers.push({ ...server, name: uniqueName(server.name, used) });
  }

  return servers;
}

