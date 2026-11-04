/**
 * Watchdog configuration for a chat turn.
 *
 * A `session/prompt` has no natural deadline — the agent may legitimately work
 * for a long time — so the chat runs two independent guards instead of one
 * wall-clock timer on the whole request:
 *
 *  - **idle** (`ROSSII_ACP_IDLE_TIMEOUT_MS`, default 5 min): no `session/update`
 *    from the agent for this long → the turn is cancelled with `session/cancel`.
 *    A long but *live* turn is never interrupted.
 *  - **hard** (`ROSSII_ACP_PROMPT_TIMEOUT_MS`, default 4 h): absolute cap on a
 *    single turn — the last resort against an agent that keeps streaming
 *    updates forever without finishing. Passing it to `AcpClient.prompt` also
 *    makes the client send `session/cancel` on timeout.
 *
 * For both, an explicit `0` disables the guard. A malformed value (e.g. a typo
 * like `ROSSII_ACP_IDLE_TIMEOUT_MS=5m`) falls back to the default **and returns
 * a warning** — the chat shows it, instead of silently disabling the guard.
 */

export const IDLE_TIMEOUT_ENV = "ROSSII_ACP_IDLE_TIMEOUT_MS";
export const TURN_TIMEOUT_ENV = "ROSSII_ACP_PROMPT_TIMEOUT_MS";

/** Silence from the agent after which the current turn is cancelled. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Absolute cap on a single turn (does not reset on activity). */
export const DEFAULT_TURN_TIMEOUT_MS = 4 * 60 * 60_000;

export interface ResolvedTimeout {
  /** Milliseconds; `0` means "no limit". */
  ms: number;
  /** Human-readable warning when the environment value was unusable, else null. */
  invalid: string | null;
}

/** Parse a timeout from the environment, falling back with a warning. */
export function resolveTimeoutMs(
  raw: string | undefined,
  fallbackMs: number,
  envName: string,
): ResolvedTimeout {
  const value = raw?.trim();
  if (!value) return { ms: fallbackMs, invalid: null };

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      ms: fallbackMs,
      invalid: `${envName}="${raw}" is not a non-negative number — using ${fallbackMs} ms`,
    };
  }
  return { ms: parsed, invalid: null };
}
