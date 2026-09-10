/**
 * cgoose configuration file (~/.config/cgoose/config.json)
 *
 * Currently supported settings:
 *   default_mode — "no-worktree" (default) | "worktree"
 *
 * Session sets are stored as individual files in:
 *   ~/.config/cgoose/sets/<name>.json   (legacy)
 *   ~/.config/cgoose/sets/<name>.yaml   (preferred)
 *   ~/.config/cgoose/sets/<name>.yml    (alt)
 *
 * Reading supports all three formats; the TUI wizard saves as YAML.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, parse } from "node:path";
import { homedir } from "node:os";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";

// ─── Paths ───────────────────────────────────────────────────────────────────

const CGOOSE_CONFIG_DIR = join(homedir(), ".config", "cgoose");
const CGOOSE_CONFIG_PATH = join(CGOOSE_CONFIG_DIR, "config.json");
const CGOOSE_SETS_DIR = join(CGOOSE_CONFIG_DIR, "sets");

/** Supported file extensions for session set files (ordered by preference) */
const SET_EXTENSIONS = [".yaml", ".yml", ".json"] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export type DefaultMode = "worktree" | "no-worktree";

/**
 * A named session set — bundles a system prompt with extensions.
 * Used as a lightweight alternative to Goose recipes, always launched
 * via `goose session` (never `goose run`).
 *
 * Stored as ~/.config/cgoose/sets/<name>.yaml (or .json for legacy sets)
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

// ─── Session Set Management (stored as ~/.config/cgoose/sets/<name>.{yaml,yml,json}) ────

/** Ensure the sets directory exists */
function ensureSetsDir(): void {
  if (!existsSync(CGOOSE_SETS_DIR)) {
    mkdirSync(CGOOSE_SETS_DIR, { recursive: true });
  }
}

/**
 * Find the path to a session set file by name, trying all supported extensions.
 * Returns the first match, or the YAML path if no existing file is found.
 */
function getSetFilePath(name: string): { path: string; ext: string } | undefined {
  for (const ext of SET_EXTENSIONS) {
    const filePath = join(CGOOSE_SETS_DIR, `${name}${ext}`);
    if (existsSync(filePath)) {
      return { path: filePath, ext };
    }
  }
  return undefined;
}

/**
 * Read a session set file in any supported format (JSON or YAML).
 * Returns parsed SessionSet or undefined on failure.
 */
function readSetFile(filePath: string): SessionSet | undefined {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const ext = parse(filePath).ext.toLowerCase();

    let data: any;
    if (ext === ".json") {
      data = JSON.parse(raw);
    } else {
      // YAML / YML
      data = yamlLoad(raw);
    }

    if (data && typeof data === "object" && data.name) {
      // Normalize: YAML may use camelCase or snake_case variants
      return {
        name: data.name,
        title: data.title ?? data.name,
        description: data.description ?? undefined,
        systemPrompt: data.systemPrompt ?? data.system_prompt ?? "",
        builtins: data.builtins ?? data.builtin_extensions ?? [],
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read all session sets from the sets directory (supports .json, .yaml, .yml) */
export function listSessionSets(): Record<string, SessionSet> {
  const sets: Record<string, SessionSet> = {};
  if (!existsSync(CGOOSE_SETS_DIR)) return sets;

  for (const file of readdirSync(CGOOSE_SETS_DIR)) {
    const ext = parse(file).ext.toLowerCase();
    if (!(SET_EXTENSIONS as readonly string[]).includes(ext)) continue;

    try {
      const data = readSetFile(join(CGOOSE_SETS_DIR, file));
      if (data) {
        sets[data.name] = data;
      }
    } catch {
      // skip corrupt files
    }
  }
  return sets;
}

/** Get a single session set by name (tries .yaml, .yml, .json) */
export function getSessionSet(name: string): SessionSet | undefined {
  const found = getSetFilePath(name);
  if (!found) return undefined;
  return readSetFile(found.path);
}

/** Create or update a session set. Saves as YAML (preferred format). */
export function saveSessionSet(set: SessionSet): void {
  ensureSetsDir();
  const filePath = join(CGOOSE_SETS_DIR, `${set.name}.yaml`);

  // YAML format mirrors the JSON shape but is more human-friendly
  const yamlObj: Record<string, any> = {
    name: set.name,
    title: set.title,
    builtins: set.builtins,
  };

  if (set.description) yamlObj.description = set.description;
  if (set.systemPrompt) yamlObj.systemPrompt = set.systemPrompt;

  const yaml = yamlDump(yamlObj, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  writeFileSync(filePath, yaml);
}

/** Delete a session set by name (removes .yaml, .yml, or .json). Returns true if deleted. */
export function deleteSessionSet(name: string): boolean {
  const found = getSetFilePath(name);
  if (!found) return false;
  try {
    unlinkSync(found.path);
    // Also clean up any other extension that might exist for the same name
    for (const ext of SET_EXTENSIONS) {
      if (ext === found.ext) continue;
      const altPath = join(CGOOSE_SETS_DIR, `${name}${ext}`);
      if (existsSync(altPath)) {
        try { unlinkSync(altPath); } catch { /* best-effort */ }
      }
    }
    return true;
  } catch {
    return false;
  }
}