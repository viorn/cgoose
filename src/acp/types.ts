/**
 * ACP (Agent Client Protocol) wire types — minimal subset needed by rossii.
 *
 * Protocol: JSON-RPC 2.0 over stdio, newline-delimited JSON (one message per line).
 * Reference: https://agentclientprotocol.com/protocol/overview
 * Goose specifics: crates/goose/src/acp/ (method names `_goose/unstable/...`).
 */

// ─── JSON-RPC envelope ───────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── Content blocks ──────────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export type ContentBlock = TextContent | ImageContent;

// ─── initialize ──────────────────────────────────────────────────────────────

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  _meta?: Record<string, unknown>;
}

export interface InitializeRequest {
  protocolVersion: number | string;
  clientCapabilities: ClientCapabilities;
}

/** Loose — the agent advertises far more than we consume. */
export interface InitializeResponse {
  protocolVersion: number | string;
  agentCapabilities?: {
    loadSession?: boolean;
    prompts?: { listAvailable?: boolean };
    _meta?: Record<string, unknown>;
    [key: string]: unknown;
  };
  authMethods?: unknown[];
  [key: string]: unknown;
}

// ─── session/new & session/load ──────────────────────────────────────────────

export interface NewSessionRequest {
  cwd: string;
  mcpServers?: unknown[];
  _meta?: NewSessionMeta;
}

/**
 * goose reads every session field at the TOP level of `_meta`; only the
 * initialize capabilities live under `_meta.goose`. Built as a whole by
 * `session-meta.ts` (which is unit-tested).
 */
export interface NewSessionMeta {
  /** Marks the session as user-created (SessionType::User). */
  client?: string;
  /** Client-supplied session name; goose will not regenerate it. */
  sessionTitle?: string;
  /**
   * Requested provider. Deliberately **not** sent by rossii: with the key
   * present goose resolves the model through the provider registry's default
   * model and ignores `GOOSE_MODEL`, so the model picked in the wizard was
   * silently replaced. `GOOSE_PROVIDER`/`GOOSE_MODEL` (set by `launcher.ts`)
   * cover both provider and model.
   */
  provider?: string;
  /**
   * Goose-specific extension list. When present it REPLACES the profile's
   * extensions (an empty array = none at all); goose ignores `mcpServers`
   * in that case.
   */
  enabledExtensions?: GooseExtension[];
  projectId?: string;
  [key: string]: unknown;
}

export interface NewSessionResponse {
  sessionId: string;
  modes?: unknown;
  configOptions?: SessionConfigOption[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * `session/fork` copies an existing conversation into a NEW session and answers
 * with the same shape as `session/new` (verified live on goose 1.57).
 */
export interface ForkSessionRequest {
  sessionId: string;
  cwd: string;
  mcpServers?: unknown[];
  _meta?: NewSessionMeta;
}

// ─── session/set_config_option (SACP 11) ─────────────────────────────────────

/**
 * One config option a session exposes. goose returns them with `session/new`
 * (`configOptions`) and after every `session/set_config_option`; the model,
 * provider, mode and thinking effort are all options, so switching the model is
 * `set_config_option("model", …)` — there is no model field in `_meta`.
 */
export interface SessionConfigOption {
  /** `model`, `provider`, `mode`, `thinking_effort`, … */
  id: string;
  name?: string;
  type?: string;
  category?: string;
  /** The currently selected value, e.g. the model id. */
  currentValue?: string;
  options?: Array<{ value: string; name?: string }>;
}

export interface SetSessionConfigOptionRequest {
  sessionId: string;
  configId: string;
  /**
   * A bare value id on goose 1.57 — the SDK's `SessionConfigOptionValue` is an
   * untagged enum, so `{configId: "model", value: "qwen/qwen3.6-flash"}` is the
   * wire form (a `{valueId: …}`/`{type: "value_id", …}` object is rejected with
   * "data did not match any variant of untagged enum SessionConfigOptionValue").
   */
  value: string;
}

export interface SetSessionConfigOptionResponse {
  configOptions?: SessionConfigOption[];
}

export interface LoadSessionRequest {
  cwd: string;
  sessionId: string;
  mcpServers?: unknown[];
  /** `replayTail` lives at the top level of `_meta` too (goose 1.57). */
  _meta?: { replayTail?: number } & Record<string, unknown>;
}

/**
 * `session/load` answers with the same shape as `session/new`, including the
 * refreshed `configOptions` (verified live on goose 1.57: provider/model/mode/
 * thinking_effort are all there). rossii used to discard this response and lose
 * the model list on every resume — that is why the configuration menus had
 * nothing to show for a resumed session.
 */
export interface LoadSessionResponse {
  modes?: unknown;
  configOptions?: SessionConfigOption[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── session/prompt ──────────────────────────────────────────────────────────

export interface PromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | string;

export interface PromptResponse {
  stopReason: StopReason;
  usage?: { totalTokens: number; inputTokens: number; outputTokens: number };
  [key: string]: unknown;
}

// ─── session/update notifications ────────────────────────────────────────────

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
  /** Chunks with the same id belong to one message; a change starts a new one. */
  messageId?: string;
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
  messageId?: string;
}

export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
  messageId?: string;
}

/**
 * One entry of a tool call's `content`. ACP wraps every result in this union —
 * the text lives one level deeper (`{type:"content", content:{type:"text",…}}`),
 * which is why `content?: ContentBlock[]` was wrong and the tool blocks counted
 * zero characters.
 */
export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string }
  | ({ type: string } & Record<string, unknown>);

export interface ToolCallUpdate {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  title?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  content?: ToolCallContent[];
  locations?: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
  kind?: string;
  _meta?: Record<string, unknown>;
}

export interface PlanUpdate {
  sessionUpdate: "plan";
  entries: Array<{
    content: string;
    priority?: string;
    status?: "pending" | "in_progress" | "completed";
  }>;
}

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: Array<{ name: string; description?: string }>;
}

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
}

export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Cumulative session cost: `amount` in `currency` (ISO 4217 or e.g. "credits"). */
export interface Cost {
  amount: number;
  currency: string;
}

export interface UsageUpdate {
  sessionUpdate: "usage_update";
  used: number;
  size: number;
  cost?: Cost | null;
  [key: string]: unknown;
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | UserMessageChunkUpdate
  | ToolCallUpdate
  | PlanUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | SessionInfoUpdate
  | UsageUpdate
  | ({ sessionUpdate: string } & Record<string, unknown>);

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
  _meta?: Record<string, unknown>;
}

// ─── agent → client requests ─────────────────────────────────────────────────

export interface PermissionOption {
  optionId: string;
  name: string;
  kind:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always"
    | string;
  description?: string;
}

export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: unknown;
  options: PermissionOption[];
  _meta?: Record<string, unknown>;
}

export interface RequestPermissionResponse {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
}

export interface FsReadTextFileRequest {
  path: string;
  line?: number;
  limit?: number;
}

export interface FsReadTextFileResponse {
  content: string;
}

export interface FsWriteTextFileRequest {
  path: string;
  content: string;
}

// ─── goose custom extensions ─────────────────────────────────────────────────

/** Discriminated union mirroring `goose_sdk_types::GooseExtension`. */
export type GooseExtension =
  | {
      type: "builtin";
      name: string;
      availableTools?: string[];
      [key: string]: unknown;
    }
  | {
      type: "platform";
      name: string;
      availableTools?: string[];
      [key: string]: unknown;
    }
  | {
      type: "mcp";
      server: unknown; // ACP McpServer object
      envKeys?: string[];
      [key: string]: unknown;
    };

export interface SetSessionSystemPromptRequest {
  sessionId: string;
  /** "set" replaces the base prompt; "append" adds under "Additional Instructions". */
  mode: "set" | "append";
  /** Reusing a key replaces the previous value for that mode/key. */
  key?: string;
  /** Empty text clears the entry. */
  text: string;
}

export interface SessionExtensionEntry {
  extension: GooseExtension;
  extensionKey: string;
}

/**
 * `_goose/unstable/session/steer` — add a user message to the turn that is
 * already running (`crates/goose/src/agents/state_machine/ops_steer.rs`).
 *
 * `expectedRunId` pins the request to the turn we saw start, so a message sent
 * while the previous turn finishes cannot land in the next one.
 */
export interface SteerSessionRequest {
  sessionId: string;
  prompt: ContentBlock[];
  expectedRunId: string;
}

/**
 * The steer is *queued*, not delivered: goose drains the queue on a turn
 * boundary and discards it when the run ends. Correlate `messageId` with the
 * `user_message_chunk` that echoes the same id (with `_meta.goose.steer: true`)
 * to know it actually reached the model.
 */
export interface SteerSessionResponse {
  runId: string;
  messageId: string;
}
