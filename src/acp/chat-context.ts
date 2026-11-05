/**
 * Chat context — types, constants, themes, and the ChatContext factory.
 *
 * Shared across all `src/acp/chat-*.ts` modules so every function operates on
 * the same mutable state without closures.
 */

import pc from "picocolors";

import { env, formatCharCount } from "../utils";

import type {
  GooseExtension,
  RequestPermissionResponse,
  SessionConfigOption,
} from "./types";
import type { Container, Editor, Loader, Markdown, Text, TUI } from "@earendil-works/pi-tui";
import type { AcpClient } from "./client";
import type { SessionSet } from "../rossii-config";
import { DEFAULT_PROFILE_SENTINEL } from "../rossii-config";
import type { ThoughtBlock } from "./thought";
import type { ToolCallBlock } from "./tool-call-block";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  IDLE_TIMEOUT_ENV,
  TURN_TIMEOUT_ENV,
  resolveTimeoutMs,
} from "./timeouts";

// ─── PendingSteer ────────────────────────────────────────────────────────────

/**
 * A steer sent into the running turn. goose answers with a `messageId`, acked
 * (queued) by `_meta.goose.queuedSteer`, and delivers it as a
 * `user_message_chunk` carrying the same id — the three points where this
 * entry changes state.
 */
export interface PendingSteer {
  text: string;
  /** The provisional `⤴ steering: …` line, replaced by the real user message
   *  when the steer lands, or dropped when it never does. */
  line: Text;
  /** Assigned when the steer request answers (the ack can arrive first). */
  messageId?: string;
  /** True once goose acked the queueing. */
  acked: boolean;
  /**
   * True once the turn's end (or a dead agent) took the entry down and handed
   * the text back: a late response for it must not queue the text a second time
   * or restore it over what the user is typing.
   */
  abandoned?: boolean;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface AcpChatOptions {
  cwd: string;
  env: Record<string, string>;
  isNew: boolean;
  /** On resume: goose session id (same ids as `goose session list`). */
  resumeSessionId?: string;
  /** Session title for session/new (`_meta.sessionTitle`, top level). */
  sessionTitle?: string;
  provider: string;
  model: string;
  /**
   * On resume: the provider/model the session row currently holds. Both are
   * then applied through `session/set_config_option`, which sends a request
   * only when the wizard's choice actually differs (see ./session-config.ts).
   */
  resumeConfig?: SessionConfig;
  /** Resolved session set (undefined = None / Default). */
  set?: SessionSet;
  /** True when no set means "load goose's default profile" (`__default__`). */
  useDefaultProfile: boolean;
  /**
   * Set key exactly as stored in the project meta's `setHistory`: a set's name,
   * "" (None) or the `__default__` sentinel. The chat persists it back when the
   * configuration changes live, so the wizard's next run starts from what the
   * chat is actually using. Optional: when omitted it is derived from `set` and
   * `useDefaultProfile`.
   */
  setKey?: string;
  /** Builtin names resolved from the set + goose config.yaml. */
  agentBuiltins: string[];
  /** Raw stdio extension specs (`[name:]ENV=val cmd args...`) from the set. */
  stdioExtensionSpecs: string[];
  /** Streamable HTTP extension URIs (`url timeout=N`). */
  httpExtensionUris: string[];
}

/** Options carried into ChatContext so modules can access them without `opts`. */
export interface ChatContextOptions {
  env: Record<string, string>;
  isNew: boolean;
  resumeSessionId?: string;
  resumeConfig?: SessionConfig;
  agentBuiltins: string[];
  stdioExtensionSpecs: string[];
  httpExtensionUris: string[];
}

// ─── SessionConfig (imported shape, re-exported for convenience) ─────────────

export type { SessionConfig };

import type { SessionConfig } from "./session-config";

// ─── Extension plan state ────────────────────────────────────────────────────

import type {
  GooseExtensionsPlan,
  McpServer,
  ProfileExtensionsPlan,
} from "./extensions";

export interface ExtensionPlanState {
  plan: GooseExtensionsPlan;
  mcpServers: McpServer[];
  exactSet: boolean;
  profilePlan: ProfileExtensionsPlan | null;
  desiredExtensions: GooseExtension[];
  protectedNames: Set<string>;
  /** Problems resolving the set's `extensions:` names against config.yaml. */
  warnings: string[];
}

// ─── Permission queue ────────────────────────────────────────────────────────

export interface PendingPermission {
  params: any;
  resolve: (response: RequestPermissionResponse) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** ACP `fs/read_text_file` default window (the spec suggests 2000 lines). */
export const DEFAULT_READ_LIMIT = 2000;

/**
 * Session-prompt key in goose's `system_prompt_extras` map. It doubles as the
 * project's history: sessions created as `cgoose` keep their prompt under that
 * key, and `applySystemPrompt()` clears it when the new one is set.
 */
export const PROMPT_KEY = "rossii";
export const LEGACY_PROMPT_KEY = "cgoose";

// ─── Themes ──────────────────────────────────────────────────────────────────

export const markdownTheme = {
  heading: (s: string) => pc.bold(pc.cyan(s)),
  link: (s: string) => pc.blue(s),
  linkUrl: (s: string) => pc.dim(pc.blue(s)),
  code: (s: string) => pc.yellow(s),
  codeBlock: (s: string) => s,
  codeBlockBorder: (s: string) => pc.dim(s),
  quote: (s: string) => pc.italic(s),
  quoteBorder: (s: string) => pc.dim(s),
  hr: (s: string) => pc.dim(s),
  listBullet: (s: string) => pc.cyan(s),
  bold: (s: string) => pc.bold(s),
  italic: (s: string) => pc.italic(s),
  strikethrough: (s: string) => pc.strikethrough(s),
  underline: (s: string) => pc.underline(s),
};

export const selectListTheme = {
  selectedPrefix: (s: string) => pc.green(s),
  selectedText: (s: string) => pc.bold(s),
  description: (s: string) => pc.dim(s),
  scrollInfo: (s: string) => pc.dim(s),
  noMatch: (s: string) => pc.yellow(s),
};

export const editorTheme = {
  borderColor: (s: string) => pc.cyan(s),
  selectList: selectListTheme,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Render an ACP `Cost` object (`{ amount, currency }`) for the status line. */
export function formatCost(cost: any): string {
  if (!cost || typeof cost.amount !== "number") return "";
  const amount = cost.amount.toFixed(4);
  const currency = typeof cost.currency === "string" ? cost.currency : "";
  if (!currency) return ` · ${amount}`;
  return currency.toUpperCase() === "USD" ? ` · $${amount}` : ` · ${amount} ${currency}`;
}

/**
 * Header of a streaming answer. The character count mirrors the thought bar
 * (`💭 Thought · N chars`), so both live blocks report their size the same way —
 * and both bars are unstyled, so neither outshines the other.
 */
export function answerLabel(chars: number): string {
  return `❮ Answer · ${formatCharCount(chars)} chars`;
}

// ─── ChatContext ─────────────────────────────────────────────────────────────

export interface ChatContext {
  // ── Core flags ──
  busy: boolean;
  exiting: boolean;
  agentDead: boolean;
  setupFailed: boolean;
  cancelRequested: boolean;

  // ── Session ──
  sessionId: string | null;
  sessionTitle: string | undefined;
  currentProvider: string;
  currentModel: string;
  currentSet: SessionSet | undefined;
  currentUseDefaultProfile: boolean;
  currentSetLabel: string | undefined;
  currentSetKey: string;
  newSessionConfigOptions: SessionConfigOption[] | undefined;

  // ── UI components (built by chat-ui.ts) ──
  tui: TUI;
  transcript: Container;
  statusLine: Text;
  headerLine: Text;
  editor: Editor;
  loader: Loader;

  // ── Streaming state ──
  currentMd: Markdown | null;
  currentMessageId: string | null;
  streamBuffer: string;
  /** Label of the block being streamed (`❮ Answer · N chars`), null when idle. */
  answerLabelLine: Text | null;
  answerChars: number;
  currentThought: ThoughtBlock | null;
  thoughtBlocks: ThoughtBlock[];
  userLine: Text | null;
  userBuffer: string;
  userMessageId: string | null;
  toolCallBlocks: Map<string, ToolCallBlock>;
  toolBlocks: ToolCallBlock[];

  // ── Steering ──
  activeRunId: string | null;
  steerSupported: boolean;
  steerSetting: string | undefined;
  steeringEnabled: boolean;
  steeringWarning: string | null;
  steerDisabledHintShown: boolean;
  steerUnsupportedWarned: boolean;
  steerEntries: PendingSteer[];
  steerAckIds: Set<string>;
  pendingPrompt: string | null;

  // ── Configuration ──
  idleTimeout: { ms: number; invalid: string | null };
  turnTimeout: { ms: number; invalid: string | null };
  lastAgentActivity: number;
  escArmedExit: boolean;
  exitHintShown: boolean;
  menuActive: boolean;

  // ── Extension plan ──
  plan: GooseExtensionsPlan;
  mcpServers: McpServer[];
  exactSet: boolean;
  profilePlan: ProfileExtensionsPlan | null;
  desiredExtensions: GooseExtension[];
  protectedNames: Set<string>;
  extensionWarnings: Set<string>;

  // ── ACP client ──
  client: AcpClient;
  cwd: string;

  // ── Prompt handlers ──
  awaitingRename: boolean;

  // ── External editor ──
  externalEditorCommand(): string;

  // ── Permission queue (set by chat-handlers.ts) ──
  permissionQueue: PendingPermission[];
  activePermission: { finish: (response: RequestPermissionResponse) => void } | null;

  // ── UI flags ──
  /** False when ROSSII_CHAT_MAIN_SCREEN=1 asks for the inline renderer. */
  altScreen: boolean;

  // ── Agent process ──
  /** Last stderr lines of the agent, so a crash can be explained. */
  stderrTail: string[];
  /**
   * Called when `goose acp` exits. Assigned by `attachAgentExit()` once the
   * transcript exists: the agent may die before that (a spawn failure), and
   * touching components that are not there yet would throw from the transport
   * callback.
   */
  onAgentExit(code: number | null): void;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createChatContext(opts: AcpChatOptions): ChatContext {
  // `ROSSII_ACP_STEER=0` restores the pre-steering behaviour (Enter during a
  // turn does nothing, Esc is the way to add context). Anything but 0/1 warns,
  // exactly like the watchdogs: a typo must not silently change what Enter does.
  const steerSetting = env("ACP_STEER");
  return {
    // Core flags
    busy: false,
    exiting: false,
    agentDead: false,
    setupFailed: false,
    cancelRequested: false,

    // Session
    sessionId: null,
    sessionTitle: opts.sessionTitle,
    currentProvider: opts.provider,
    currentModel: opts.model,
    currentSet: opts.set,
    currentUseDefaultProfile: opts.useDefaultProfile,
    currentSetLabel: opts.set?.title ?? (opts.useDefaultProfile ? "Default" : undefined),
    currentSetKey:
      opts.setKey ?? (opts.useDefaultProfile ? DEFAULT_PROFILE_SENTINEL : opts.set?.name ?? ""),
    newSessionConfigOptions: undefined,

    // UI (placeholders — chat-ui.ts fills these in before anything renders)
    tui: null as unknown as TUI,
    transcript: null as unknown as Container,
    statusLine: null as unknown as Text,
    headerLine: null as unknown as Text,
    editor: null as unknown as Editor,
    loader: null as unknown as Loader,

    // Streaming (initialized by chat-stream.ts)
    currentMd: null,
    currentMessageId: null,
    streamBuffer: "",
    answerLabelLine: null,
    answerChars: 0,
    currentThought: null,
    thoughtBlocks: [],
    userLine: null,
    userBuffer: "",
    userMessageId: null,
    toolCallBlocks: new Map(),
    toolBlocks: [],

    // Steering
    activeRunId: null,
    steerSupported: true,
    steerSetting,
    steeringEnabled: steerSetting !== "0",
    steeringWarning:
      steerSetting !== undefined && steerSetting !== "0" && steerSetting !== "1"
        ? `ROSSII_ACP_STEER="${steerSetting}" is not 0 or 1 — steering stays enabled`
        : null,
    steerDisabledHintShown: false,
    steerUnsupportedWarned: false,
    steerEntries: [],
    steerAckIds: new Set(),
    pendingPrompt: null,

    // Configuration (watchdogs; the invalid-value warnings are printed by
    // chat-ui on start). `lastAgentActivity` is refreshed by every
    // session/update, so only a *silent* agent is cancelled by the idle guard.
    idleTimeout: resolveTimeoutMs(env("ACP_IDLE_TIMEOUT_MS"), DEFAULT_IDLE_TIMEOUT_MS, IDLE_TIMEOUT_ENV),
    turnTimeout: resolveTimeoutMs(env("ACP_PROMPT_TIMEOUT_MS"), DEFAULT_TURN_TIMEOUT_MS, TURN_TIMEOUT_ENV),
    lastAgentActivity: 0,
    escArmedExit: false,
    exitHintShown: false,
    menuActive: false,

    // Extension plan (initialized by chat-extensions.ts)
    plan: { extensions: [], unsupported: [] } as GooseExtensionsPlan,    mcpServers: [] as McpServer[],
    exactSet: true,
    profilePlan: null,
    desiredExtensions: [],
    protectedNames: new Set(),
    extensionWarnings: new Set(),

    // ACP client (set by chat.ts)
    client: null as unknown as AcpClient,
    cwd: opts.cwd,

    // Prompt handlers
    awaitingRename: false,

    // Permission queue
    permissionQueue: [],
    activePermission: null,

    // UI flags
    altScreen: env("CHAT_MAIN_SCREEN") !== "1",

    // Agent process
    stderrTail: [],
    onAgentExit(): void {
      // Replaced by `setupUi()`; before that there is nothing to report to.
    },

    // External editor
    externalEditorCommand(): string {
      return (
        process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "vi"
      );
    },
  };
}
