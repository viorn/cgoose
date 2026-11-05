/**
 * Utility functions for rossii
 */

import { basename, resolve } from "node:path";

// ─── Environment ─────────────────────────────────────────────────────────────

/**
 * Read a `ROSSII_*` setting, falling back to the pre-rename `CGOOSE_*` spelling.
 *
 * The project was called cgoose until 3.0.0, and shell profiles, recipes and CI
 * files still export the old names. Honouring both means the rename does not
 * silently switch a watchdog off (a malformed timeout warns, but an *ignored*
 * variable is invisible).
 */
export function env(name: string): string | undefined {
  return process.env[`ROSSII_${name}`] ?? process.env[`CGOOSE_${name}`];
}

/** True when the setting is present under either spelling. */
export function hasEnv(name: string): boolean {
  return env(name) !== undefined;
}

/** Set a setting under the new spelling and drop the legacy one. */
export function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[`ROSSII_${name}`];
    delete process.env[`CGOOSE_${name}`];
  } else {
    process.env[`ROSSII_${name}`] = value;
    delete process.env[`CGOOSE_${name}`];
  }
}

export function getCurrentDirName(): string {
  return basename(resolve("."));
}

/**
 * Group thousands with plain ASCII spaces: `1000000` → `"1 000 000"`.
 *
 * `toLocaleString("ru-RU")` inserts U+00A0 / U+202F here. Terminals handle those
 * fine, but some renderers reach for a fallback font and draw a box instead —
 * agg (the GIF recorder) does — so keep the digits and spaces boring.
 */
export function formatNumber(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Threshold at which a character count switches from raw digits to the k suffix. */
const CHAR_COUNT_THRESHOLD = 1000;

/**
 * Compact character count: `1234` → `"1.2k"`.
 *
 * Shared by the streaming blocks that show their size live — the thought bar
 * (`💭 Thought · N chars`) and the answer label (`❮ Answer · N chars`) — so both
 * counters read the same way.
 */
export function formatCharCount(chars: number): string {
  if (chars < CHAR_COUNT_THRESHOLD) return chars.toString();
  const thousands = chars / CHAR_COUNT_THRESHOLD;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

export function generateSessionName(prefix: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
}