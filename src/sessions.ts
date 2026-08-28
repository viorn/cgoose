/**
 * Session listing, deletion, and formatting
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

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

/** Delete a session by ID from SQLite db, returns true on success */
export function deleteSessionById(sessionId: string): boolean {
  try {
    const sql = [
      "BEGIN;",
      `DELETE FROM messages WHERE session_id = '${sessionId}';`,
      `DELETE FROM usage_ledger WHERE session_id = '${sessionId}';`,
      `DELETE FROM sessions WHERE id = '${sessionId}';`,
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

// ─── Format for display ──────────────────────────────────────────────────────

/** Format a session for display */
// ─── User message types ───────────────────────────────────────────────────────

interface UserMessagePreview {
  /** Message auto-increment primary key from messages table */
  id: number;
  /** Extracted text content (first N chars) */
  text: string;
  /** Raw content_json for reference */
  rawText: string;
  /** Message-id from Goose */
  messageId: string;
  /** Timestamp */
  createdAt: string;
  /** Number of tool-call/tool-response pairs since last user text (for context) */
  turnIndex: number;
}

/**
 * Get user text messages from a session (filtering out toolResponse).
 * Only returns messages with role='user' that contain type='text' content.
 * Each message's text is truncated to displayLimit chars.
 */
export function getUserMessages(sessionId: string, displayLimit = 100): UserMessagePreview[] {
  try {
    // Write a temporary SQL script for sqlite3 -json to read
    const escapedId = sessionId.replace(/'/g, "''");
    const sql = `SELECT id, message_id, content_json, created_timestamp
                 FROM messages
                 WHERE session_id = '${escapedId}' AND role = 'user'
                 ORDER BY created_timestamp, id;`;

    // Use input: pipe instead of echo pipe to avoid shell escaping issues
    const output = execSync(`sqlite3 -json "${SESSIONS_DB}"`, {
      input: sql,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rows: any[] = JSON.parse(output);
    const results: UserMessagePreview[] = [];
    let turnIndex = 0;

    for (const row of rows) {
      const id = Number(row.id);
      const messageId = String(row.message_id || "");
      const contentJson = String(row.content_json || "[]");
      const ts = Number(row.created_timestamp || 0);

      // Parse content_json to find text messages (not toolResponse)
      let parsed: any[];
      try { parsed = JSON.parse(contentJson); } catch { parsed = []; }

      let userText = "";
      let isToolResponse = false;

      for (const part of parsed) {
        if (part.type === "text" && part.text) {
          userText = part.text;
        }
        if (part.type === "toolResponse") {
          isToolResponse = true;
        }
      }

      // Skip tool responses — only show actual user text messages
      if (!userText || isToolResponse) continue;

      const truncated = userText.length > displayLimit
        ? userText.slice(0, displayLimit) + "…"
        : userText;

      // Handle both seconds and milliseconds timestamps
      const date = new Date(ts > 10000000000 ? ts : ts * 1000);
      const dateStr = date.toLocaleString("ru-RU", {
        day: "2-digit", month: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });

      results.push({
        id,
        text: truncated.replace(/\n/g, " "),
        rawText: userText,
        messageId,
        createdAt: dateStr,
        turnIndex,
      });
      turnIndex++;
    }

    return results;
  } catch {
    return [];
  }
}

// ─── Rollback session (in-place edit) ────────────────────────────────────────

/**
 * Rollback a session at a specific user message boundary.
 *
 * Deletes ALL messages (user + assistant) with created_timestamp >= the
 * selected user message's timestamp. This effectively "undoes" everything
 * from that point forward.
 *
 * Usage ledger entries with created_timestamp >= target are also removed.
 *
 * The session itself is preserved — ID, name, provider, model all stay.
 *
 * Returns true on success, false on failure.
 */
export function rollbackSession(
  sessionId: string,
  targetUserMsgId: number,
): boolean {
  try {
    const escapedId = sessionId.replace(/'/g, "''");

    // 1) Get the target user message's created_timestamp
    const tsQuery = `SELECT created_timestamp FROM messages WHERE id = ${targetUserMsgId} AND session_id = '${escapedId}'`;
    const tsOutput = execSync(`sqlite3 "${SESSIONS_DB}"`, {
      input: tsQuery,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const targetTs = Number(tsOutput.trim());
    if (!targetTs || isNaN(targetTs)) return false;

    // 2) Delete messages from this point forward
    // We use (created_timestamp >= targetTs AND NOT the first user message with that ts)
    // Actually, we want to delete messages with created_timestamp >= targetTs,
    // but if the target message shares the same timestamp with a previous assistant
    // message, we also delete that. So: created_timestamp >= targetTs,
    // and if created_timestamp == targetTs, also delete messages where id >= targetUserMsgId
    // (to handle same-timestamp boundary correctly)
    const deleteSql = [
      "BEGIN;",
      `DELETE FROM messages
       WHERE session_id = '${escapedId}'
         AND (created_timestamp > ${targetTs}
              OR (created_timestamp = ${targetTs} AND id >= ${targetUserMsgId}));`,
      `DELETE FROM usage_ledger
       WHERE session_id = '${escapedId}'
         AND created_timestamp >= ${targetTs};`,
      "COMMIT;",
    ].join("\n");

    execSync(`sqlite3 "${SESSIONS_DB}"`, {
      input: deleteSql,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return true;
  } catch (err) {
    console.error("Rollback failed:", err);
    return false;
  }
}

// ─── Fork session (copy to new) ──────────────────────────────────────────────

/**
 * Fork a session at a specific message boundary.
 *
 * Creates a NEW session containing all messages (from both user AND assistant)
 * with created_timestamp < the selected user message's first message timestamp.
 *
 * The original session is preserved — this is a non-destructive fork.
 *
 * Returns the new session ID on success, null on failure.
 */
export function forkSession(
  sourceSessionId: string,
  targetUserMsgId: number,
  newSessionName: string,
  projectDir: string,
): string | null {
  try {
    // 1) Get the target user message's created_timestamp
    const tsQuery = `SELECT created_timestamp FROM messages WHERE id = ${targetUserMsgId} AND session_id = '${sourceSessionId.replace(/'/g, "''")}'`;
    const tsOutput = execSync(`echo "${tsQuery}" | sqlite3 "${SESSIONS_DB}"`, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const targetTs = Number(tsOutput.trim());
    if (!targetTs) return null;

    // 2) Also find the message_id of the target for reference
    const msgIdQuery = `SELECT message_id FROM messages WHERE id = ${targetUserMsgId}`;
    const msgIdOutput = execSync(`echo "${msgIdQuery}" | sqlite3 "${SESSIONS_DB}"`, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const targetMessageId = msgIdOutput.trim();

    // 3) Get source session info for copying
    const sessionQuery = `SELECT json_object(
      'working_dir', working_dir,
      'provider_name', provider_name,
      'model_config_json', model_config_json,
      'goose_mode', goose_mode,
      'extension_data', extension_data,
      'recipe_json', recipe_json,
      'user_recipe_values_json', user_recipe_values_json
    ) FROM sessions WHERE id = '${sourceSessionId.replace(/'/g, "''")}'`;
    
    const sessionOutput = execSync(`echo "${sessionQuery}" | sqlite3 "${SESSIONS_DB}"`, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const sessionInfo = JSON.parse(sessionOutput.trim());
    const newSessionId = randomUUID();

    // 4) Insert new session (copy from original + set parent_session_id)
    const insertSession = [
      "BEGIN;",
      `INSERT INTO sessions (
        id, name, description, user_set_name, session_type,
        working_dir, created_at, updated_at, extension_data,
        provider_name, model_config_json, goose_mode, parent_session_id
      ) VALUES (
        '${newSessionId}',
        '${newSessionName.replace(/'/g, "''")}',
        'Fork of ${sourceSessionId} up to msg ${targetMessageId || "#" + targetUserMsgId}',
        1, 'user',
        '${(sessionInfo.working_dir || projectDir).replace(/'/g, "''")}',
        datetime('now'), datetime('now'),
        '${(sessionInfo.extension_data || "{}").replace(/'/g, "''")}',
        ${sessionInfo.provider_name ? `'${sessionInfo.provider_name.replace(/'/g, "''")}'` : "NULL"},
        ${sessionInfo.model_config_json ? `'${sessionInfo.model_config_json.replace(/'/g, "''")}'` : "NULL"},
        '${(sessionInfo.goose_mode || "auto").replace(/'/g, "''")}',
        '${sourceSessionId.replace(/'/g, "''")}'
      );`,
      "COMMIT;",
    ].join("\n");

    execSync(`sqlite3 "${SESSIONS_DB}"`, {
      input: insertSession,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 5) Copy messages with created_timestamp < targetTs (not including the target message)
    // Also don't include messages with same timestamp that are ID >= targetUserMsgId
    const copyMessages = [
      "BEGIN;",
      `INSERT INTO messages (session_id, message_id, role, content_json, created_timestamp, tokens, metadata_json)
       SELECT
         '${newSessionId}' AS session_id,
         message_id, role, content_json, created_timestamp, tokens, metadata_json
       FROM messages
       WHERE session_id = '${sourceSessionId.replace(/'/g, "''")}'
         AND (created_timestamp < ${targetTs}
              OR (created_timestamp = ${targetTs} AND id < ${targetUserMsgId}))
       ORDER BY created_timestamp, id;`,
      "COMMIT;",
    ].join("\n");

    execSync(`sqlite3 "${SESSIONS_DB}"`, {
      input: copyMessages,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 6) Copy usage_ledger entries for copied messages (approximate: copy entries with timestamps <= target)
    const copyUsage = [
      "BEGIN;",
      `INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens,
        cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction)
       SELECT
         '${newSessionId}' AS session_id,
         created_timestamp, model, input_tokens, output_tokens, total_tokens,
         cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction
       FROM usage_ledger
       WHERE session_id = '${sourceSessionId.replace(/'/g, "''")}'
         AND created_timestamp <= ${targetTs};`,
      "COMMIT;",
    ].join("\n");

    execSync(`sqlite3 "${SESSIONS_DB}"`, {
      input: copyUsage,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return newSessionId;
  } catch (err) {
    console.error("Fork failed:", err);
    return null;
  }
}

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