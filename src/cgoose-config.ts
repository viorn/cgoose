/**
 * cgoose configuration file (~/.config/cgoose/config.json)
 *
 * Currently supported settings:
 *   default_mode — "worktree" (default) | "no-worktree"
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Paths ───────────────────────────────────────────────────────────────────

const CGOOSE_CONFIG_DIR = join(homedir(), ".config", "cgoose");
const CGOOSE_CONFIG_PATH = join(CGOOSE_CONFIG_DIR, "config.json");

// ─── Types ───────────────────────────────────────────────────────────────────

export type DefaultMode = "worktree" | "no-worktree";

export interface CgooseConfig {
  /** Default worktree mode for new sessions */
  default_mode: DefaultMode;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CgooseConfig = {
  default_mode: "worktree",
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