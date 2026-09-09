/**
 * cgoose configuration file (~/.config/cgoose/config.json)
 *
 * Currently supported settings:
 *   default_mode — "no-worktree" (default) | "worktree"
 *
 * Session sets are stored as individual files in:
 *   ~/.config/cgoose/sets/<name>.json
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Paths ───────────────────────────────────────────────────────────────────

const CGOOSE_CONFIG_DIR = join(homedir(), ".config", "cgoose");
const CGOOSE_CONFIG_PATH = join(CGOOSE_CONFIG_DIR, "config.json");
const CGOOSE_SETS_DIR = join(CGOOSE_CONFIG_DIR, "sets");

// ─── Types ───────────────────────────────────────────────────────────────────

export type DefaultMode = "worktree" | "no-worktree";

/**
 * A named session set — bundles a system prompt with extensions.
 * Used as a lightweight alternative to Goose recipes, always launched
 * via `goose session` (never `goose run`).
 *
 * Stored as ~/.config/cgoose/sets/<name>.json
 */
export interface SessionSet {
  /** Unique name/slug (also used as filename) */
  name: string;
  /** Human-readable title */
  title: string;
  /** Optional description */
  description?: string;
  /** System prompt text to add (written to .goosehints before launch) */
  systemPrompt: string;
  /** Builtin extensions to enable (e.g., "developer", "analyze") */
  builtins: string[];
}

export interface CgooseConfig {
  /** Default worktree mode for new sessions */
  default_mode: DefaultMode;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CgooseConfig = {
  default_mode: "no-worktree",
};

// ─── Read ─────────────────────────────────────────────────────────────────────

/** Read cgoose configuration, returns defaults if file doesn't exist */
export function readCgooseConfig(): CgooseConfig {
  if (!existsSync(CGOOSE_CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(CGOOSE_CONFIG_PATH, "utf-8"));
    return {
      default_mode: raw.default_mode === "no-worktree" ? "no-worktree" : "worktree",
    };
  } catch {
    // If file is corrupt, fall back to defaults
    return { ...DEFAULT_CONFIG };
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

/** Write cgoose configuration, creating parent directories if needed */
export function writeCgooseConfig(config: CgooseConfig): void {
  if (!existsSync(CGOOSE_CONFIG_DIR)) {
    mkdirSync(CGOOSE_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CGOOSE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ─── Session Set Management (stored as ~/.config/cgoose/sets/<name>.json) ────

/** Ensure the sets directory exists */
function ensureSetsDir(): void {
  if (!existsSync(CGOOSE_SETS_DIR)) {
    mkdirSync(CGOOSE_SETS_DIR, { recursive: true });
  }
}

/** Read all session sets from the sets directory */
export function listSessionSets(): Record<string, SessionSet> {
  const sets: Record<string, SessionSet> = {};
  if (!existsSync(CGOOSE_SETS_DIR)) return sets;

  for (const file of readdirSync(CGOOSE_SETS_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(readFileSync(join(CGOOSE_SETS_DIR, file), "utf-8"));
      if (data && data.name) {
        sets[data.name] = data as SessionSet;
      }
    } catch {
      // skip corrupt files
    }
  }
  return sets;
}

/** Get a single session set by name */
export function getSessionSet(name: string): SessionSet | undefined {
  const filePath = join(CGOOSE_SETS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as SessionSet;
  } catch {
    return undefined;
  }
}

/** Create or update a session set */
export function saveSessionSet(set: SessionSet): void {
  ensureSetsDir();
  const filePath = join(CGOOSE_SETS_DIR, `${set.name}.json`);
  writeFileSync(filePath, JSON.stringify(set, null, 2) + "\n");
}

/** Delete a session set by name. Returns true if deleted, false if not found. */
export function deleteSessionSet(name: string): boolean {
  const filePath = join(CGOOSE_SETS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}