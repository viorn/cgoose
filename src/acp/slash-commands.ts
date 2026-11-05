/**
 * Slash commands: what the chat answers itself and what belongs to goose.
 *
 * rossii owns a handful of UI commands — `/config`, `/model`, `/set`,
 * `/session`, `/think`, `/tool`, `/edit`, … — and `handleCommand` matches them.
 * **Everything else that starts with `/` is goose's** and goes to the agent as
 * an ordinary prompt, untouched, so goose's own `execute_command()`
 * (`crates/goose/src/agents/execute_commands.rs`) picks it up before the turn:
 * `/compact`, `/clear`, `/status`, `/doctor`, `/goal`, `/grind`, `/prompts`,
 * `/prompt`, `/skills`, and the slash commands goose builds from recipes and
 * skills.
 *
 * The chat cannot run any of those itself — they rewrite the conversation goose
 * stores (`/compact`, `/clear`) or report on it (`/status`, `/doctor`) — and it
 * does not try to guess which names are goose's: goose's own TUI does not either
 * (`handle_slash_command` in `crates/goose-cli/src/session/input.rs` returns
 * `None` for a name it does not know, and the text is submitted as a message).
 * Intercepting every `/…` and answering `Unknown command` is what used to make
 * `/compact` impossible to reach.
 *
 * What this module adds is the little the *client* knows and goose cannot tell
 * it: which commands rewrite goose's conversation, so the chat can say that its
 * own visible transcript is not being rewritten (goose emits
 * `AgentEvent::HistoryReplaced` after them and the ACP server drops it), plus
 * the parsing of the command list goose announces for `/help`.
 */

/** One entry of goose's `availableCommands` (ACP `available_commands_update`). */
export interface GooseCommand {
  name: string;
  description?: string;
}

/**
 * goose compares command names by trimming a leading `/` and lowercasing
 * (`normalize_command_name` in `crates/goose/src/slash_commands/util.rs`) — a
 * recipe command may be announced as `/review`, and `/Compact` reaches
 * `execute_command` as `compact`.
 */
export function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

/**
 * Commands that rewrite the conversation goose has stored. The chat prints a
 * note for them, because its own transcript is a client-side log: goose emits
 * `AgentEvent::HistoryReplaced` after them and the ACP server drops that event
 * (`Ok(_) => {}` in `forward_agent_stream`), so the visible history cannot be
 * refreshed — only the answer ("Compaction complete") and a smaller
 * `usage_update` arrive.
 *
 * Mirrors goose's own condition in `crates/goose/src/agents/agent.rs`:
 * `COMPACT_TRIGGERS.contains(message_text.trim()) || message_text.trim() == "/clear"`.
 * `/summarize` is one of those compact triggers. The set holds bare names;
 * `commandRewritesHistory` takes the whole `/command args` text and normalizes it.
 */
export const HISTORY_REWRITE_COMMANDS: ReadonlySet<string> = new Set([
  "compact",
  "summarize",
  "clear",
]);

/** Does this `/…` rewrite goose's stored conversation? (`text` may carry args.) */
export function commandRewritesHistory(text: string): boolean {
  const name = text.trim().split(/\s+/)[0] ?? "";
  return HISTORY_REWRITE_COMMANDS.has(normalizeCommandName(name));
}

/**
 * Read goose's list out of an `available_commands_update` payload. Used for
 * `/help` only — never to decide whether a command may run (see above). Malformed
 * entries are dropped rather than trusted: a broken entry must not crash an
 * update.
 */
export function parseAvailableCommands(value: unknown): GooseCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: GooseCommand[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { name, description } = entry as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || !name.trim()) continue;
    commands.push({
      name: normalizeCommandName(name),
      description: typeof description === "string" ? description : undefined,
    });
  }
  return commands;
}

/** One line listing goose's commands, for `/help`. */
export function formatGooseCommandNames(announced: readonly GooseCommand[]): string {
  return announced.map((entry) => entry.name).join(", ");
}
