/**
 * ACP tool-call payloads → the text the chat renders.
 *
 * Kept pure (no TUI, no transport) so the wire shapes goose actually sends can
 * be pinned by unit tests. The first version of the tool block checked
 * `content[].type === "text"` and therefore never matched anything: ACP wraps
 * every result in `ToolCallContent`, i.e. `{type:"content", content:{type:"text",
 * text}}`, so the blocks stayed at "0 chars" while still being clickable.
 * Verified live on goose 1.57.0 (`scripts/acp-tool-probe.ts`):
 *
 *   ← tool_call          … title="shell · cd /… && sed -n 205...…"
 *                          rawInput: {"command":"cd /… && sed -n 205,215p src/acp/chat.ts"}
 *   ← tool_call_update   … _meta.toolNotification = {type:"live_output", params:{…}}
 *   ← tool_call_update   … status=completed
 *                          content: [{"type":"content","content":{"type":"text","text":"…"}}]
 *
 * Two consequences the chat has to respect:
 *  - the live output arrives on its own channel (`_meta.toolNotification`), and
 *    the final `content` restates the *whole* output, so it must REPLACE the
 *    buffer instead of being appended to it;
 *  - goose's `title` is truncated to the first line, 57 chars + "…", so the
 *    full command has to come from `rawInput`.
 */

/**
 * Argument keys goose picks the human-meaningful bit of a call from, in goose's
 * own priority order (`default_tool_title`): for the shell the command matters
 * most, for the rest the path/query.
 */
const DETAIL_KEYS = [
  "command",
  "path",
  "file",
  "query",
  "url",
  "uri",
  "name",
  "pattern",
  "source",
] as const;

/** Full detail of a tool call (`command`, `path`, …) from its raw arguments. */
export function toolDetailFromRawInput(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const args = rawInput as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text && text.trim()) return text;
  }
  return undefined;
}

/**
 * Text of one `ToolCallContent` entry. `undefined` for shapes we cannot render
 * as text (images, audio) — the caller then simply shows nothing.
 */
export function toolContentText(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const entry = content as Record<string, any>;
  switch (entry.type) {
    case "content": {
      const block = entry.content;
      if (!block || typeof block !== "object") return undefined;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      // An embedded resource / link: the uri is the useful part, the body is
      // the model's business.
      const uri = typeof block.uri === "string" ? block.uri : block.resource?.uri;
      if (typeof uri === "string") return `📄 ${uri}`;
      if (block.type === "image") return "🖼 image";
      if (block.type === "audio") return "🔊 audio";
      return undefined;
    }
    case "diff": {
      // goose sends this for the client-side file writes it performs itself
      // (ACP-aware tools get no `content` on the response update at all).
      const path = typeof entry.path === "string" ? entry.path : "diff";
      const next = typeof entry.newText === "string" ? entry.newText : "";
      return next ? `📝 ${path}\n${next}` : `📝 ${path}`;
    }
    case "terminal":
      return typeof entry.terminalId === "string" ? `🖥 ${entry.terminalId}` : undefined;
    default:
      return undefined;
  }
}

/** Live output goose streams while a tool runs (`_meta.toolNotification`). */
export interface ToolLiveOutput {
  text: string;
  /** goose's monotonic counter, when it sends one. */
  sequence?: number;
}

/**
 * `_meta.toolNotification` of a `tool_call_update`, when it carries live output
 * (currently the developer shell extension). Other notification kinds
 * (`message`, `progress`, `platform_event`) are not output and are ignored.
 */
export function liveOutputFromMeta(meta: unknown): ToolLiveOutput | null {
  const notification = (meta as Record<string, any> | undefined)?.toolNotification;
  if (!notification || notification.type !== "live_output") return null;
  const params = notification.params ?? {};
  const chunks = Array.isArray(params.chunks) ? params.chunks : [];
  const text = chunks
    .map((chunk: any) => (typeof chunk?.output === "string" ? chunk.output : ""))
    .join("");
  if (!text) return null;
  return typeof params.sequence === "number" ? { text, sequence: params.sequence } : { text };
}

/** What one tool-call update does to the block's buffer. */
export interface ToolCallPayload {
  /** Replace the buffer: goose restates the complete output on the final update. */
  replace?: string;
  /** Append: live output, arriving chunk by chunk. */
  append?: string;
}

/** Read one `tool_call` / `tool_call_update` into buffer operations. */
export function toolCallPayload(update: { content?: unknown; _meta?: unknown }): ToolCallPayload {
  const payload: ToolCallPayload = {};
  const content = update?.content;
  if (Array.isArray(content)) {
    const text = content
      .map(toolContentText)
      .filter((entry): entry is string => typeof entry === "string")
      .join("\n");
    if (text) payload.replace = text;
  }
  const live = liveOutputFromMeta(update?._meta);
  if (live) payload.append = live.text;
  return payload;
}
