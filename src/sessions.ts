/**
 * Session listing, deletion, and formatting
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Paths ───────────────────────────────────────────────────────────────────

// goose honours GOOSE_PATH_ROOT (data dir = $GOOSE_PATH_ROOT/data), so do the same
const GOOSE_DATA_DIR = process.env.GOOSE_PATH_ROOT
  ? join(process.env.GOOSE_PATH_ROOT, "data")
  : join(homedir(), ".local/share/goose");

const SESSIONS_DB = join(GOOSE_DATA_DIR, "sessions", "sessions.db");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GooseSession {
  id: string;
  name: string;
  working_dir: string;
  /** Goose session type: "user", "scheduled", "acp", … (see goose SessionType) */
  session_type?: string;
  provider_name: string | null;
  model_config: { model_name: string } | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

// ─── List sessions ───────────────────────────────────────────────────────────

/**
 * Session types rossii shows in the picker.
 *
 * `goose session list` only returns `user` + `scheduled` sessions
 * (see SessionStorage::list_sessions in goose). Sessions created through
 * ACP mode are stored with `session_type = 'acp'` and are therefore
 * invisible to the CLI — so we read them straight from the sqlite DB.
 */
const VISIBLE_SESSION_TYPES = ["user", "scheduled", "acp"];

export function getAllSessions(): GooseSession[] {
  const fromDb = getAllSessionsFromDb();
  if (fromDb !== null) return fromDb;
  // No sqlite3 available — degrade to what goose itself reports
  return getAllSessionsFromCli();
}

/** Read sessions directly from the goose sqlite DB.
 *  Returns null when the DB/sqlite3 isn't usable so the caller can fall back. */
function getAllSessionsFromDb(): GooseSession[] | null {
  if (!existsSync(SESSIONS_DB)) return null;

  // Mirrors goose's SessionStorage::list_sessions_matching:
  // - order by last (user-visible) message timestamp, falling back to updated_at
  // - count only messages that are user-visible
  const sql = `
SELECT
  s.id                                AS id,
  s.working_dir                       AS working_dir,
  COALESCE(NULLIF(s.name, ''), NULLIF(s.description, ''), '') AS name,
  s.session_type                      AS session_type,
  s.provider_name                     AS provider_name,
  s.model_config_json                 AS model_config_json,
  s.created_at                        AS created_at,
  s.updated_at                        AS updated_at,
  (
    SELECT COUNT(*) FROM messages m
    WHERE m.session_id = s.id
      AND COALESCE(json_extract(m.metadata_json, '$.userVisible'), 1) != 0
  )                                   AS message_count,
  COALESCE(
    (
      SELECT MAX(CASE WHEN m2.created_timestamp > 10000000000
                      THEN m2.created_timestamp / 1000
                      ELSE m2.created_timestamp END)
      FROM messages m2
      WHERE m2.session_id = s.id
    ),
    CAST(strftime('%s', s.updated_at) AS INTEGER),
    CAST(strftime('%s', s.created_at) AS INTEGER),
    0
  )                                   AS sort_ts
FROM sessions s
WHERE s.session_type IN (${VISIBLE_SESSION_TYPES.map((t) => `'${t}'`).join(", ")})
ORDER BY sort_ts DESC, s.id DESC;
`;

  try {
    const output = execSync(`sqlite3 -json "${SESSIONS_DB}"`, {
      input: sql,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = output.trim();
    if (!trimmed) return [];

    const rows = JSON.parse(trimmed) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let modelConfig: { model_name: string } | null = null;
      if (typeof row.model_config_json === "string" && row.model_config_json.trim()) {
        try {
          const parsed = JSON.parse(row.model_config_json) as { model_name?: string };
          modelConfig = parsed.model_name ? { model_name: parsed.model_name } : null;
        } catch {
          modelConfig = null;
        }
      }
      return {
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        working_dir: String(row.working_dir ?? ""),
        session_type: row.session_type ? String(row.session_type) : undefined,
        provider_name: row.provider_name ? String(row.provider_name) : null,
        model_config: modelConfig,
        created_at: toIsoUtc(String(row.created_at ?? "")),
        updated_at: toIsoUtc(String(row.updated_at ?? "")),
        message_count: Number(row.message_count ?? 0),
      };
    });
  } catch {
    return null;
  }
}

/** Fallback: ask the goose CLI (only reports user + scheduled sessions). */
function getAllSessionsFromCli(): GooseSession[] {
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

/** SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" in UTC; goose's JSON
 *  output uses RFC3339. Normalize so `new Date()` parses them correctly. */
function toIsoUtc(value: string): string {
  if (!value) return "";
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  if (m) return `${m[1]}T${m[2]}Z`;
  return value;
}

// ─── Delete session ──────────────────────────────────────────────────────────

/** Delete a session by ID from SQLite db, returns true on success */
export function deleteSessionById(sessionId: string): boolean {
  try {
    const escapedId = sessionId.replace(/'/g, "''");
    const sql = [
      "BEGIN;",
      `DELETE FROM messages WHERE session_id = '${escapedId}';`,
      `DELETE FROM usage_ledger WHERE session_id = '${escapedId}';`,
      `DELETE FROM sessions WHERE id = '${escapedId}';`,
      "COMMIT;",
    ].join("\n");
    execSync(`sqlite3 "${SESSIONS_DB}"`, {
      input: sql,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Read recipe from session ────────────────────────────────────────────────

/** Read the recipe instructions stored in a session's recipe_json.
 *  Returns null if the session has no recipe or no instructions. */
export function getSessionRecipeInstructions(sessionId: string): string | null {
  try {
    const escapedId = sessionId.replace(/'/g, "''");
    const sql = `SELECT recipe_json FROM sessions WHERE id = '${escapedId}';\n`;
    const output = execSync(`sqlite3 "${SESSIONS_DB}"`, {
      input: sql,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const trimmed = output.trim();
    if (!trimmed) return null;
    const recipe = JSON.parse(trimmed);
    return recipe.instructions ?? null;
  } catch {
    return null;
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
  // Non-user sessions (e.g. created through ACP mode) get a badge so it's
  // clear where they came from.
  const typeBadge = s.session_type && s.session_type !== "user" ? `[${s.session_type}] ` : "";
  const hint = typeBadge + dateStr + " " + prov + " " + modelShort + " " + msgHint;
  return { name: s.name || s.id, hint: hint.trim() };
}
