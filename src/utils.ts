/**
 * Utility functions for cgoose
 */

import { basename, resolve } from "node:path";

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

export function generateSessionName(prefix: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
}