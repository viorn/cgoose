/**
 * Steering — handing the model extra context while its turn is still running.
 *
 * goose's `_goose/unstable/session/steer` adds a user message to the prompt
 * that is already in flight: no second `session/prompt`, no cancel, no lost
 * work. The wire dance (verified live on goose 1.57.0 with
 * `scripts/acp-steer-probe.ts`, and present since 1.50.0):
 *
 *   session_info_update `_meta.goose.activeRunId`   → id of the running turn
 *   → `_goose/unstable/session/steer {sessionId, prompt, expectedRunId}`
 *   → `{runId, messageId}`                          → accepted, *not* delivered
 *   session_info_update `_meta.goose.queuedSteer`   → ack for that messageId
 *   user_message_chunk  `_meta.goose.steer: true`   → picked up at a turn
 *                                                     boundary, same messageId
 *
 * "Accepted" is not "delivered": goose drains the queue on a turn boundary
 * (after a finished assistant message or a tool result) and *discards* what is
 * left when the run ends or is cancelled (`discard_pending_steers`). Matching
 * the `messageId` is therefore what separates "queued" from "the model has it".
 *
 * Everything in this module is pure — the chat owns the state, this file owns
 * the rules (and the unit tests in `scripts/acp-steer-test.ts`).
 */

/** `_meta.goose.activeRunId`: a string while a turn runs, `null` once it ends,
 *  `undefined` when the update carries no such key at all. */
export function activeRunIdFromMeta(meta: unknown): string | null | undefined {
  const goose = (meta as { goose?: unknown } | undefined)?.goose;
  if (!goose || typeof goose !== "object" || !("activeRunId" in goose)) return undefined;
  const value = (goose as { activeRunId?: unknown }).activeRunId;
  if (typeof value === "string") return value;
  return value === null ? null : undefined;
}

/** `_meta.goose.queuedSteer.messageId` — goose accepted the steer into the
 *  running turn's queue. */
export function queuedSteerIdFromMeta(meta: unknown): string | undefined {
  const queued = (meta as { goose?: { queuedSteer?: unknown } } | undefined)?.goose?.queuedSteer;
  if (!queued || typeof queued !== "object") return undefined;
  const messageId = (queued as { messageId?: unknown }).messageId;
  return typeof messageId === "string" ? messageId : undefined;
}

/** The messageId of a `user_message_chunk` that goose echoed back as a *steer*
 *  — i.e. the running turn picked the message up at a turn boundary. */
export function steerChunkId(update: unknown): string | undefined {
  const goose = (update as { _meta?: { goose?: unknown } } | undefined)?._meta?.goose;
  if (!goose || typeof goose !== "object") return undefined;
  const { steer, messageId } = goose as { steer?: unknown; messageId?: unknown };
  return steer === true && typeof messageId === "string" ? messageId : undefined;
}

/**
 * Why a steer was refused, from the JSON-RPC error the client throws (its
 * message already carries the code: `… (code -32601)`).
 *
 * "no-active-run" also covers a stale `expectedRunId` (goose answers
 * `invalid params` with the expected/actual ids) and the `session already has
 * active run` refusal of a *prompt* — in all three cases the right fallback is
 * "send it as the next normal prompt", not an error.
 */
export type SteerErrorKind = "unsupported" | "no-active-run" | "other";

export function classifySteerError(message: string): SteerErrorKind {
  if (/method not found|code -32601/i.test(message)) return "unsupported";
  if (/no active run/i.test(message)) return "no-active-run";
  if (/expectedrunid|actualrunid/i.test(message)) return "no-active-run";
  if (/already has active run/i.test(message)) return "no-active-run";
  return "other";
}

export type SteerPlan =
  /** Steer into the running turn, pinned to the run id we saw. */
  | { kind: "steer"; expectedRunId: string }
  /** Cannot steer: send it as the next normal prompt instead. */
  | { kind: "queue"; reason: "no-active-run" | "unsupported" }
  /** A slash command — it belongs to the chat, not to the model. */
  | { kind: "command" }
  /** No turn is running: an ordinary prompt. */
  | { kind: "idle" };

/**
 * What Enter (or `/edit`) should do with `text` right now.
 *
 * Deliberately *not* a plan for "cancel and send": cancelling throws away the
 * work the turn has already done, and Esc is still there for that.
 */
export function planSteer(input: {
  /** A turn is running (`session/prompt` has not resolved yet). */
  busy: boolean;
  /** `activeRunId` of that turn, when goose has announced it yet. */
  runId: string | null;
  /** False once goose answered `-32601` to a steer (an older build). */
  steerSupported: boolean;
  text: string;
}): SteerPlan {
  if (input.text.startsWith("/")) return { kind: "command" };
  if (!input.busy) return { kind: "idle" };
  // A turn that has started but whose run id has not arrived yet is the same
  // race as a goose without steering: queue it, never drop it.
  if (!input.steerSupported) return { kind: "queue", reason: "unsupported" };
  if (!input.runId) return { kind: "queue", reason: "no-active-run" };
  return { kind: "steer", expectedRunId: input.runId };
}
