/**
 * ACP (Agent Client Protocol) wire types — minimal subset needed by cgoose.
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
  _meta?: {
    goose?: {
      /** Marks the session as user-created (SessionType::User). */
      client?: string;
      /** Client-supplied session name; goose will not regenerate it. */
      sessionTitle?: string;
      /** Requested provider (resolved against goose config). */
      provider?: string;
      /**
       * Goose-specific extension list. Ignored by goose 1.57 and not sent by
       * cgoose (extensions go through `mcpServers` + `--with-builtin`).
       */
      enabledExtensions?: GooseExtension[];
      projectId?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

export interface NewSessionResponse {
  sessionId: string;
  modes?: unknown;
  configOptions?: unknown;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LoadSessionRequest {
  cwd: string;
  sessionId: string;
  mcpServers?: unknown[];
  _meta?: { goose?: { replayTail?: number } & Record<string, unknown> };
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

export interface ToolCallUpdate {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  title?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  content?: ContentBlock[];
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
