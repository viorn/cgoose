/**
 * Read extensions declared in ~/.config/goose/config.yaml.
 *
 * cgoose sets launch Goose with `--no-profile`, which means the extensions from
 * the default profile are NOT loaded. To make a set able to use extensions that
 * are already configured in Goose (e.g. `fetch` = `uvx mcp-server-fetch`), a set
 * can reference them by name (`extensions: [fetch]`) and we translate those
 * entries into the matching CLI flags:
 *
 *   - builtin / platform        → --with-builtin <name>
 *   - stdio                     → --with-extension '<name>:ENV=val cmd args...'
 *   - streamable_http           → --with-streamable-http-extension <uri>
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";

const CONFIG_PATH = join(homedir(), ".config", "goose", "config.yaml");

export interface GooseExtension {
  /** Key in the `extensions:` map of config.yaml — this is what sets reference */
  key: string;
  /** Human-friendly display name (`name:` field), falls back to the key */
  name: string;
  /** builtin | platform | stdio | streamable_http */
  type: string;
  description?: string;
  enabled: boolean;
  cmd?: string;
  args?: string[];
  envs?: Record<string, string>;
  uri?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** List all extensions declared in Goose's config.yaml (enabled first, then alphabetical) */
export function listGooseExtensions(): GooseExtension[] {
  if (!existsSync(CONFIG_PATH)) return [];

  let doc: Record<string, any> | undefined;
  try {
    doc = yamlLoad(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, any>;
  } catch {
    return [];
  }
  if (!isPlainObject(doc) || !isPlainObject(doc.extensions)) return [];

  const result: GooseExtension[] = [];
  for (const [key, raw] of Object.entries(doc.extensions as Record<string, any>)) {
    if (!isPlainObject(raw)) continue;
    const args = Array.isArray(raw.args) ? raw.args.map((a: unknown) => String(a)) : undefined;
    result.push({
      key,
      name: typeof raw.name === "string" && raw.name ? raw.name : key,
      type: typeof raw.type === "string" ? raw.type : "stdio",
      description: typeof raw.description === "string" ? raw.description : undefined,
      enabled: raw.enabled !== false,
      cmd: typeof raw.cmd === "string" ? raw.cmd : undefined,
      args,
      envs: isPlainObject(raw.envs)
        ? Object.fromEntries(Object.entries(raw.envs).map(([k, v]) => [k, String(v)]))
        : undefined,
      uri: typeof raw.uri === "string" ? raw.uri : undefined,
      headers: isPlainObject(raw.headers)
        ? Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, String(v)]))
        : undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    });
  }

  return result.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

/** Look up one extension by its config.yaml key */
export function getGooseExtension(key: string): GooseExtension | undefined {
  return listGooseExtensions().find((e) => e.key === key);
}

export interface ExtensionArgs {
  /** Names to pass via --with-builtin */
  builtins: string[];
  /** Command specs to pass via --with-extension */
  stdio: string[];
  /** URLs to pass via --with-streamable-http-extension */
  http: string[];
  /** Problems encountered while resolving (unknown/unsupported extensions) */
  warnings: string[];
}

/** Build a `goose --with-extension` spec: `name:ENV=val cmd args...` */
function stdioSpec(ext: GooseExtension): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ext.envs ?? {})) {
    // Goose CLI splits the spec on whitespace, so values with spaces are not supported
    // (same limitation as typing the command yourself).
    parts.push(`${k}=${v}`);
  }
  parts.push(ext.cmd ?? ext.key, ...(ext.args ?? []));
  return `${ext.key}:${parts.join(" ")}`;
}

/**
 * Resolve a list of config.yaml extension keys into Goose CLI flag values.
 * Unknown or unsupported entries end up in `warnings` and are skipped.
 */
export function buildExtensionArgs(keys: string[]): ExtensionArgs {
  const out: ExtensionArgs = { builtins: [], stdio: [], http: [], warnings: [] };
  if (keys.length === 0) return out;

  const all = listGooseExtensions();
  const byKey = new Map(all.map((e) => [e.key, e] as const));

  for (const key of keys) {
    const ext = byKey.get(key);
    if (!ext) {
      out.warnings.push(`extension "${key}" not found in ${CONFIG_PATH}`);
      continue;
    }

    switch (ext.type) {
      case "builtin":
      case "platform":
        out.builtins.push(key);
        break;
      case "stdio":
        if (!ext.cmd) {
          out.warnings.push(`extension "${key}" has no "cmd" — skipped`);
          break;
        }
        out.stdio.push(stdioSpec(ext));
        break;
      case "streamable_http":
      case "streamable-http":
        if (!ext.uri) {
          out.warnings.push(`extension "${key}" has no "uri" — skipped`);
          break;
        }
        if (ext.headers && Object.keys(ext.headers).length > 0) {
          out.warnings.push(
            `extension "${key}" uses HTTP headers, which --with-streamable-http-extension cannot pass — ` +
            `use the Default profile for it or provide the token via env`,
          );
        }
        out.http.push(ext.timeout ? `${ext.uri} timeout=${ext.timeout}` : ext.uri);
        break;
      default:
        out.warnings.push(`extension "${key}" has unsupported type "${ext.type}" — skipped`);
    }
  }

  return out;
}
