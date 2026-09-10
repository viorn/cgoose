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
  /** History of models used per provider (first = last used) */
  modelHistory: Record<string, string[]>;
  /** History of providers used in this project (first = last used) */
  providerHistory: string[];
  /** History of recipes used in this project (first = last used; "" = no recipe) */
  recipeHistory: string[];
  /** History of session sets used in this project (first = last used; "" = none) */
  setHistory: string[];
  /** Maps session name → worktree path (created via cgoose git worktree integration) */
  worktrees?: Record<string, string>;
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
    // Also handles the case where `model` is "" but modelHistory exists
    if (!raw.modelHistory) {
      raw.modelHistory = raw.model ? { [raw.provider ?? ""]: [raw.model] } : {};
    }
    // Migrate: ensure providerHistory exists (clean empty strings)
    if (!raw.providerHistory) {
      raw.providerHistory = raw.provider ? [raw.provider] : [];
    }
    // Migrate: ensure recipe history exists (clean empty strings)
    // "" (no recipe) is a valid recipeHistory entry, preserve it
    if (!raw.recipeHistory) {
      raw.recipeHistory = (raw.recipe !== undefined && raw.recipe !== null)
        ? [raw.recipe]
        : [];
    }
// Migrate: ensure setHistory exists
    if (!raw.setHistory) {
      raw.setHistory = [];
    }
    // Sanitize: remove empty strings from providerHistory
    raw.providerHistory = raw.providerHistory.filter(Boolean);
    return raw as ProjectMeta;
  } catch { return null; }
}

/**
 * Save provider + model + set selection to project meta.
 * Memory is per-project, not per-session.
 * recipe history is kept in ProjectMeta for backwards compatibility with
 * existing project files but is no longer actively tracked.
 */
export function writeProjectMeta(provider: string, model: string, sessionSet?: string): void {
  const dir = CGOOSE_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  // Merge with existing meta to preserve history
  const existing = existsSync(path)
    ? (() => { try { return JSON.parse(readFileSync(path, "utf-8")) as ProjectMeta; } catch { return null; } })()
    : null;

  const modelHistory: Record<string, string[]> = existing?.modelHistory ?? {};
  const prevList = (modelHistory[provider] ?? []).filter((m) => m !== model);
  modelHistory[provider] = [model, ...prevList].slice(0, 10); // keep max 10 per provider

  // Track provider history (most recent first, max 10)
  // Filter out empty strings to prevent corrupted entries
  const providerHistory = (existing?.providerHistory ?? []).filter(Boolean);
  const filteredProvHistory = providerHistory.filter((p) => p !== provider);
  const newProviderHistory = [provider, ...filteredProvHistory].slice(0, 10);

  // Track session set history (most recent first, max 10).
  // "" (none) is a legitimate choice.
  const effectiveSet = sessionSet !== undefined ? sessionSet : (existing?.setHistory?.[0] ?? "");
  const setHistory = existing?.setHistory ?? [];
  const filteredSetHistory = setHistory.filter((s) => s !== effectiveSet);
  const newSetHistory = [effectiveSet, ...filteredSetHistory].slice(0, 10);

  // Preserve existing worktree mappings when merging
  const worktrees = existing?.worktrees ?? {};
  
  writeFileSync(path, JSON.stringify({
    modelHistory,
    providerHistory: newProviderHistory,
    setHistory: newSetHistory,
    worktrees,
  }, null, 2) + "\n");
}

// ─── Worktree mapping ─────────────────────────────────────────────────────────

/** Save a session-to-worktree mapping in the project meta */
export function saveWorktreeMapping(sessionName: string, worktreePath: string): void {
  const dir = CGOOSE_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = getProjectMetaPath();

  let meta: Record<string, any> = {};
  if (existsSync(path)) {
    try { meta = JSON.parse(readFileSync(path, "utf-8")); } catch { meta = {}; }
  }

  if (!meta.worktrees) meta.worktrees = {};
  meta.worktrees[sessionName] = worktreePath;

  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n");
}

/** Remove a session-to-worktree mapping from the project meta */
export function removeWorktreeMapping(sessionName: string): void {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return;

  try {
    const meta = JSON.parse(readFileSync(path, "utf-8"));
    if (meta.worktrees?.[sessionName]) {
      delete meta.worktrees[sessionName];
      writeFileSync(path, JSON.stringify(meta, null, 2) + "\n");
    }
  } catch { /* ignore */ }
}

/** Get all worktree mappings for this project: { sessionName → worktreePath } */
export function getWorktreeMappings(): Record<string, string> {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return {};
  try {
    const meta = JSON.parse(readFileSync(path, "utf-8"));
    return meta.worktrees ?? {};
  } catch { return {}; }
}