/**
 * Per-project meta — remembers last used provider/model
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ─── Paths ───────────────────────────────────────────────────────────────────

const CGOOSE_PROJECTS_DIR = join(homedir(), ".config", "cgoose", "projects");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectMeta {
  provider: string;
  /** History of models used per provider (first = last used) */
  modelHistory: Record<string, string[]>;
  /** History of providers used in this project (first = last used) */
  providerHistory: string[];
}

// ─── Project key ─────────────────────────────────────────────────────────────

/** Get a stable project key: dirname + short hash of the full path */
function getProjectKey(): string {
  const dir = resolve(".");
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `${basename(dir)}-${hash}`;
}

function getProjectMetaPath(): string {
  return join(CGOOSE_PROJECTS_DIR, `${getProjectKey()}.json`);
}

// ─── Read / Write ────────────────────────────────────────────────────────────

export function readProjectMeta(): ProjectMeta | null {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Migrate old format: { provider, model } → { provider, modelHistory }
    if (raw.model && !raw.modelHistory) {
      raw.modelHistory = { [raw.provider]: [raw.model] };
    }
    // Migrate: ensure providerHistory exists
    if (!raw.providerHistory && raw.provider) {
      raw.providerHistory = [raw.provider];
    } else if (!raw.providerHistory) {
      raw.providerHistory = [];
    }
    return raw as ProjectMeta;
  } catch { return null; }
}

export function writeProjectMeta(provider: string, model: string): void {
  const dir = CGOOSE_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  // Merge with existing meta to preserve model history
  const existing = existsSync(path)
    ? (() => { try { return JSON.parse(readFileSync(path, "utf-8")) as ProjectMeta; } catch { return null; } })()
    : null;

  const modelHistory: Record<string, string[]> = existing?.modelHistory ?? {};
  const prevList = (modelHistory[provider] ?? []).filter((m) => m !== model);
  modelHistory[provider] = [model, ...prevList].slice(0, 10); // keep max 10 per provider

  // Track provider history (most recent first, max 10)
  const providerHistory = existing?.providerHistory ?? [];
  const filteredProvHistory = providerHistory.filter((p) => p !== provider);
  const newProviderHistory = [provider, ...filteredProvHistory].slice(0, 10);

  writeFileSync(path, JSON.stringify({ provider, modelHistory, providerHistory: newProviderHistory }, null, 2) + "\n");
}