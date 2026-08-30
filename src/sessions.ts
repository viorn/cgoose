/**
 * Session listing, deletion, and formatting
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Paths ───────────────────────────────────────────────────────────────────

const SESSIONS_DB = join(homedir(), ".local/share/goose/sessions/sessions.db");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GooseSession {
  id: string;
  name: string;
  working_dir: string;
  provider_name: string | null;
  model_config: { model_name: string } | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

// ─── List sessions ───────────────────────────────────────────────────────────

export function getAllSessions(): GooseSession[] {
  try {
    const output = execSync("goose session list --format json", {
      encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const jsonStart = output.indexOf("[");
    const jsonEnd = output.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd === -1) return [];
    return JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as GooseSession[];
  } catch { return []; }
}

// ─── Delete session ──────────────────────────────────────────────────────────

/** Delete a session by ID via `goose session remove`, returns true on success */
export function deleteSessionById(sessionId: string): boolean {
  try {
    execSync(`goose session remove --session-id "${sessionId}"`, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Format for display ──────────────────────────────────────────────────────

/** Format a session for display */


export function formatSessionHint(s: GooseSession): { name: string; hint: string } {
  const prov = s.provider_name ?? "—";
  const model = s.model_config?.model_name ?? "—";
  const modelShort = model.length > 30 ? model.slice(0, 27) + "…" : model;
  const dateStr = s.created_at
    ? new Date(s.created_at).toLocaleDateString("ru-RU", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "—";
  const msgHint = s.message_count > 0 ? "(" + s.message_count + " msgs)" : "";
  const hint = dateStr + " " + prov + " " + modelShort + " " + msgHint;
  return { name: s.name || s.id, hint: hint.trim() };
}