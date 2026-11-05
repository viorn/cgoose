/**
 * Goose custom ACP requests (`_goose/unstable/...`).
 *
 * Method names verified against goose 1.50.0/2.0-rc via scripts/acp-probe.ts and
 * goose source: crates/goose-sdk-types/src/custom_requests.rs.
 * These are version-sensitive — probe before relying on new ones.
 */

import type { AcpClient } from "./client";
import type {
  GooseExtension,
  SetSessionSystemPromptRequest,
  SessionExtensionEntry,
  SteerSessionRequest,
  SteerSessionResponse,
} from "./types";

export const GOOSE_METHODS = {
  setSystemPrompt: "_goose/unstable/session/system-prompt/set",
  addSessionExtension: "_goose/unstable/session/extensions/add",
  removeSessionExtension: "_goose/unstable/session/extensions/remove",
  listSessionExtensions: "_goose/unstable/session/extensions/list",
  listConfigExtensions: "_goose/unstable/config/extensions/list",
  renameSession: "_goose/unstable/session/rename",
  archiveSession: "_goose/unstable/session/archive",
  truncateConversation: "_goose/unstable/session/conversation/truncate",
  sessionInfo: "_goose/unstable/session/info",
  exportSession: "_goose/unstable/session/export",
  updateWorkingDir: "_goose/unstable/session/working-dir/update",
  steer: "_goose/unstable/session/steer",
  contextReport: "_goose/unstable/context/report",
  listProviders: "_goose/unstable/providers/list",
  listProviderModels: "_goose/unstable/providers/supported-models/list",
  readDefaults: "_goose/unstable/defaults/read",
} as const;

/** Set (mode="set") or append (mode="append") a system prompt for the session.
 *  Empty `text` clears the entry for the given key/mode. */
export async function setSessionSystemPrompt(
  client: AcpClient,
  sessionId: string,
  opts: { mode?: "set" | "append"; key?: string; text: string },
): Promise<void> {
  const req: SetSessionSystemPromptRequest = {
    sessionId,
    mode: opts.mode ?? "append",
    key: opts.key,
    text: opts.text,
  };
  await client.request(GOOSE_METHODS.setSystemPrompt, req, 30_000);
}

export async function addSessionExtension(
  client: AcpClient,
  sessionId: string,
  extension: GooseExtension,
): Promise<void> {
  await client.request(GOOSE_METHODS.addSessionExtension, { sessionId, extension }, 30_000);
}

export async function removeSessionExtension(
  client: AcpClient,
  sessionId: string,
  extensionKey: string,
): Promise<void> {
  // Goose versions disagree on the field name: 1.50 wants `extensionKey`,
  // 2.0-rc accepts `name`. Retry once on a parameter-shape error only, so a
  // genuine failure ("unknown extension") is not hidden by a second attempt.
  try {
    await client.request(GOOSE_METHODS.removeSessionExtension, { sessionId, extensionKey }, 30_000);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (!/missing field|invalid params/i.test(message)) throw error;
    await client.request(GOOSE_METHODS.removeSessionExtension, { sessionId, name: extensionKey }, 30_000);
  }
}

export async function listSessionExtensions(
  client: AcpClient,
  sessionId: string,
): Promise<SessionExtensionEntry[]> {
  const result = (await client.request(
    GOOSE_METHODS.listSessionExtensions,
    { sessionId },
    30_000,
  )) as { extensions?: SessionExtensionEntry[] };
  return result.extensions ?? [];
}

/**
 * Add a user message to the turn that is already running (goose "steering").
 *
 * The answer is only an *ack* (`{runId, messageId}`): goose picks the message
 * up at a turn boundary and drops it if the run ends first — see
 * `src/acp/steer.ts`. `expectedRunId` is required by goose and keeps the
 * message out of a turn that has not started yet.
 */
export async function steerSession(
  client: AcpClient,
  sessionId: string,
  text: string,
  expectedRunId: string,
): Promise<SteerSessionResponse> {
  const request: SteerSessionRequest = {
    sessionId,
    prompt: [{ type: "text", text }],
    expectedRunId,
  };
  return (await client.request(GOOSE_METHODS.steer, request, 30_000)) as SteerSessionResponse;
}

export async function renameSession(
  client: AcpClient,
  sessionId: string,
  title: string,
): Promise<void> {
  await client.request(GOOSE_METHODS.renameSession, { sessionId, title }, 30_000);
}

export async function truncateSessionConversation(
  client: AcpClient,
  sessionId: string,
  truncateFrom: number,
): Promise<void> {
  await client.request(
    GOOSE_METHODS.truncateConversation,
    { sessionId, truncateFrom },
    30_000,
  );
}
