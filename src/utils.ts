/**
 * Utility functions for cgoose
 */

import { basename, resolve } from "node:path";

export function getCurrentDirName(): string {
  return basename(resolve("."));
}

export function generateSessionName(prefix: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
}