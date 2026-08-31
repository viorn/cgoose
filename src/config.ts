/**
 * Provider configuration — parse YAML, enrich from custom_providers, load env vars
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { load as yamlLoad } from "js-yaml";

// ─── Paths ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "goose", "config.yaml");
const CUSTOM_PROVIDERS_DIR = join(homedir(), ".config", "goose", "custom_providers");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProviderInfo {
  name: string;
  model: string;
  engine?: string;
  baseUrl?: string;
  authToken?: string;
  apiKeyEnv?: string; // name of the env var that holds the API key (from custom_providers JSON)
}

// ─── Config parsing ──────────────────────────────────────────────────────────

function parseYamlProviders(raw: string): ProviderInfo[] {
  try {
    const doc = yamlLoad(raw) as Record<string, any>;
    if (!doc?.providers || typeof doc.providers !== "object") return [];

    const providers: ProviderInfo[] = [];
    for (const [name, config] of Object.entries(doc.providers)) {
      const cfg = config as any;
      if (cfg && cfg.enabled === true && cfg.model) {
        providers.push({ name, model: cfg.model });
      }
    }
    return providers;
  } catch {
    return [];
  }
}

/**
 * Read Goose secrets from all possible storage backends.
 *
 * Goose supports two secret storage modes:
 * 1. **System Keyring** (default) — secrets stored in OS keychain via libsecret as JSON
 * 2. **File-based Storage** — secrets stored in ~/.config/goose/secrets.yaml
 *    (used when GOOSE_DISABLE_KEYRING=true, or `system-keyring` feature is disabled)
 *
 * Returns a map of env var name → secret value.
 * The map is cached after the first read.
 */
let gooseSecretsCache: Record<string, string> | null = null;

function readGooseSecrets(): Record<string, string> {
  if (gooseSecretsCache !== null) return gooseSecretsCache;
  gooseSecretsCache = {};
  const secretsPath = join(homedir(), ".config", "goose", "secrets.yaml");

  // 1) Try system keyring via libsecret (GNOME Keyring, KDE Wallet, KeePassXC, etc.)
  try {
    const output = execSync("secret-tool search --all service goose", {
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = output.match(/secret\s*=\s*(\{.*\})/s);
    if (match) {
      const parsed = JSON.parse(match[1]);
      let found = false;
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val === "string" && val.length > 0) {
          gooseSecretsCache[key] = val;
          found = true;
        }
      }
      if (found) return gooseSecretsCache; // keyring has data — authoritative
    }
  } catch {
    // secret-tool not available or no secrets stored
  }

  // 2) Try file-based storage (~/.config/goose/secrets.yaml)
  try {
    if (existsSync(secretsPath)) {
      const raw = readFileSync(secretsPath, "utf-8");
      // secrets.yaml contains YAML key: value pairs
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        let val = trimmed.slice(colonIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key && val) {
          gooseSecretsCache[key] = val;
        }
      }
    }
  } catch {
    // corrupt or unreadable file
  }

  return gooseSecretsCache;
}

/** Enrich providers with engine/base_url/auth from custom_providers JSON files */
function enrichProviders(providers: ProviderInfo[]): ProviderInfo[] {
  if (!existsSync(CUSTOM_PROVIDERS_DIR)) return providers;
  for (const file of readdirSync(CUSTOM_PROVIDERS_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(readFileSync(join(CUSTOM_PROVIDERS_DIR, file), "utf-8"));
      const p = providers.find((x) => x.name === data.name);
      if (!p) continue;
      const authHeader = data.headers?.Authorization || data.headers?.authorization || "";
      const envKey = data.api_key_env || "";
      const secretKey = data.secrets?.api_key || data.secrets?.API_KEY || "";
      p.engine = data.engine || "openai";
      p.baseUrl = data.base_url || "";
      p.authToken = authHeader.replace(/^Bearer\s+/i, "") || (envKey ? process.env[envKey] || readGooseSecrets()[envKey] || "" : "") || secretKey;
      if (envKey) p.apiKeyEnv = envKey;
    } catch { /* skip corrupt files */ }
  }
  return providers;
}

export function getConfigProviders(): ProviderInfo[] {
  if (!existsSync(CONFIG_PATH)) return [];

  // Read names of all custom provider JSON files
  const customNames = new Set<string>();
  if (existsSync(CUSTOM_PROVIDERS_DIR)) {
    for (const file of readdirSync(CUSTOM_PROVIDERS_DIR).filter((f) => f.endsWith(".json"))) {
      try {
        const data = JSON.parse(readFileSync(join(CUSTOM_PROVIDERS_DIR, file), "utf-8"));
        if (data.name) customNames.add(data.name);
      } catch { /* skip corrupt files */ }
    }
  }

  const providers = enrichProviders(parseYamlProviders(readFileSync(CONFIG_PATH, "utf-8")));

  // Only keep providers that:
  // - are built-in (not starting with "custom_"), OR
  // - have a corresponding JSON file in custom_providers/
  return providers.filter((p) => {
    if (!p.name.startsWith("custom_")) return true; // built-in (e.g. "local")
    return customNames.has(p.name); // custom → needs JSON file
  });
}

/**
 * Discover custom providers from JSON files that aren't referenced in config.yaml.
 * These are providers created via `goose configure` or via cgoose's own creator.
 * Returns ProviderInfo entries suitable for listing in the provider picker.
 */
export function getDiscoveredCustomProviders(yamlProviders: ProviderInfo[]): ProviderInfo[] {
  const discovered: ProviderInfo[] = [];
  if (!existsSync(CUSTOM_PROVIDERS_DIR)) return discovered;

  const yamlNames = new Set(yamlProviders.map((p) => p.name));

  for (const file of readdirSync(CUSTOM_PROVIDERS_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(readFileSync(join(CUSTOM_PROVIDERS_DIR, file), "utf-8"));
      const name: string = data.name;
      if (!name) continue;
      // Skip if already in config.yaml enriched providers (they'll show up normally)
      if (yamlNames.has(name)) continue;

      // Extract auth info
      const authHeader = data.headers?.Authorization || data.headers?.authorization || "";
      const envKey = data.api_key_env || "";
      const secretKey = data.secrets?.api_key || data.secrets?.API_KEY || "";
      const authToken = authHeader.replace(/^Bearer\s+/i, "")
        || (envKey ? process.env[envKey] || readGooseSecrets()[envKey] || "" : "")
        || secretKey;

      // Pick first model as default, or empty string
      const firstModel = Array.isArray(data.models) && data.models.length > 0
        ? (typeof data.models[0] === "string" ? data.models[0] : data.models[0]?.name ?? "")
        : "";

      discovered.push({
        name,
        model: firstModel,
        engine: typeof data.engine === "string" ? data.engine : "openai",
        baseUrl: data.base_url || "",
        authToken,
        apiKeyEnv: envKey || undefined,
      });
    } catch {
      /* skip corrupt files */
    }
  }
  return discovered;
}
export function isModelInCustomProviderJson(providerName: string, modelName: string): boolean {
  const filePath = join(CUSTOM_PROVIDERS_DIR, `${providerName}.json`);
  if (!existsSync(filePath)) return false;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!Array.isArray(data.models)) return false;
    return data.models.some((m: any) => {
      if (typeof m === "string") return m === modelName;
      return m?.name === modelName;
    });
  } catch {
    return false;
  }
}

/**
 * Add a model to the custom provider's JSON file models list (if not already present).
 * @param contextLimit - Optional context window size. If not provided, defaults to 128000.
 * Returns true if added, false if already present or on error.
 */
export function addModelToCustomProviderJson(providerName: string, modelName: string, contextLimit?: number): boolean {
  const filePath = join(CUSTOM_PROVIDERS_DIR, `${providerName}.json`);
  if (!existsSync(filePath)) return false;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!Array.isArray(data.models)) {
      data.models = [];
    }
    // Check if already present (by name for objects, directly for strings)
    const already = data.models.some((m: any) => {
      if (typeof m === "string") return m === modelName;
      return m?.name === modelName;
    });
    if (already) return false;

    data.models.push({ name: modelName, context_limit: contextLimit ?? 128000 });
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read all models from a custom provider's JSON file.
 * Returns empty array if the file doesn't exist or has no models.
 */
export interface CustomProviderModel {
  name: string;
  contextLimit?: number;
}

export function getCustomProviderModels(providerName: string): CustomProviderModel[] {
  const filePath = join(CUSTOM_PROVIDERS_DIR, `${providerName}.json`);
  if (!existsSync(filePath)) return [];
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!Array.isArray(data.models)) return [];
    return data.models.map((m: any) => {
      if (typeof m === "string") return { name: m, contextLimit: undefined };
      return { name: m.name, contextLimit: m.context_limit ?? undefined };
    });
  } catch {
    return [];
  }
}

/**
 * Read context_limit for a model from a custom provider's JSON file.
 * Returns undefined if the model/limit is not configured.
 */
/** Read all Goose secrets from keyring and file-based storage */
export function getGooseSecrets(): Record<string, string> {
  return readGooseSecrets();
}

export function getModelContextLimit(providerName: string, modelName: string): number | undefined {
  const filePath = join(CUSTOM_PROVIDERS_DIR, `${providerName}.json`);
  if (!existsSync(filePath)) return undefined;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!Array.isArray(data.models)) return undefined;
    for (const m of data.models) {
      const name = typeof m === "string" ? m : m?.name;
      if (name === modelName) {
        const limit = typeof m === "object" && m !== null ? m.context_limit : undefined;
        return limit !== undefined && limit !== null ? Number(limit) : undefined;
      }
    }
  } catch {
    /* corrupt file */
  }
  return undefined;
}

/** Set top-level env vars from config.yaml on process.env so child processes inherit them */
export function loadConfigEnvVars(): void {
  if (!existsSync(CONFIG_PATH)) return;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const doc = yamlLoad(raw) as Record<string, any>;
    if (!doc || typeof doc !== "object") return;

    for (const [key, val] of Object.entries(doc)) {
      if (key === "providers") continue;
      // Only set primitive values (strings, numbers, booleans), not objects/arrays
      if (val !== null && val !== undefined && !(key in process.env)) {
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
          process.env[key] = String(val);
        }
      }
    }
  } catch {
    // ignore parse errors
  }
}