/**
 * Chat TUI — cgoose's own dialog renderer on top of @earendil-works/pi-tui.
 *
 * Talks to a spawned `goose acp` agent via AcpClient (JSON-RPC over stdio):
 *   initialize → session/new | session/load → session/prompt ⇄ session/update
 * Handles agent→client requests: session/request_permission (SelectList
 * overlay), fs/read_text_file, fs/write_text_file.
 *
 * Session sets in chat mode:
 *   - builtins → `goose acp --with-builtin …` on the agent command line
 *   - `_meta.enabledExtensions` (typed `GooseExtension[]`) → REPLACES the
 *     profile's extensions, i.e. the `--no-profile` semantics of classic mode
 *     (empty array = no profile; `{type:"mcp", server}` carries MCP servers)
 *   - stdio/http extensions are ALSO sent in `session/new.mcpServers`: goose
 *     ignores that field only when `enabledExtensions` is honoured, so old
 *     versions keep working
 *   - resume: `session/load` ignores both channels, so the loaded set is
 *     reconciled with `_goose/unstable/session/extensions/{list,add,remove}`
 *     — including Default, whose profile is rebuilt from config.yaml and
 *     reconciled the same way (otherwise a resumed `None` session would keep
 *     its empty set forever: goose has no "reset to profile" request)
 *   - system prompt → goose custom request `_goose/unstable/session/system-prompt/set`
 *   - provider/model → `session/set_config_option` (provider first, then the
 *     model it resets): works on both new and resumed sessions, unlike
 *     `_meta.provider` or the env alone (see ./session-config.ts)
 * The old blanket "profile is always loaded" warning is gone: the chat checks
 * the session's real extension list and warns only when the profile leaked in.
 * Two watchdogs bound a turn (idle + hard cap, see ./timeouts.ts).
 * On resume Goose restores the stored extension set; the *current* set's prompt
 * is re-applied (or explicitly cleared when no set).
 *
 * Live configuration (no restart needed, all through slash commands and the
 * `/config` SelectList menus):
 *   /provider · /model → `session/set_config_option` (provider first, then model)
 *   /set               → system prompt + extension reconciliation in place
 *   /session           → switch (session/load), new, rename, fork
 *   /rename · /fork    → session title / `session/fork` copy
 * Every switch re-applies the pair the wizard chose and reconciles extensions
 * against the selected set, so the set stays the single source of truth.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pc from "picocolors";

import {
  buildMcpServers,
  diffExtensions,
  extensionName,
  listedExtensionName,
  planGooseExtensions,
  planProfileExtensions,
} from "./extensions";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  IDLE_TIMEOUT_ENV,
  TURN_TIMEOUT_ENV,
  resolveTimeoutMs,
} from "./timeouts";
import {
  Container,
  Editor,
  Key,
  Loader,
  Markdown,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Spacer,
  Text,
  type SelectListLayoutOptions,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import { AcpClient } from "./client";
import {
  addSessionExtension,
  listSessionExtensions,
  removeSessionExtension,
  renameSession,
  setSessionSystemPrompt,
} from "./custom";
import { BorderBox, SearchableList } from "./overlay";
import { listSessionSets, type SessionSet } from "../cgoose-config";
import {
  addModelToCustomProviderJson,
  getConfigProviders,
  getDiscoveredCustomProviders,
  isModelInCustomProviderJson,
  type ProviderInfo,
} from "../config";
import { fetchModels, type ApiModelInfo } from "../models";
import { getAllSessions } from "../sessions";
import { formatNumber } from "../utils";
import { getProjectSessionDirs, isInsideGitRepo } from "../worktree";
import { buildExtensionArgs, listGooseExtensions } from "../goose-extensions";
import { newSessionMeta } from "./session-meta";
import { applySessionConfig, optionValue, type SessionConfig } from "./session-config";
import type {
  GooseExtension,
  PromptResponse,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from "./types";

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
  /** Builtin names resolved from the set + goose config.yaml. */
  agentBuiltins: string[];
  /** Raw stdio extension specs (`[name:]ENV=val cmd args...`) from the set. */
  stdioExtensionSpecs: string[];
  /** Streamable HTTP extension URIs (`url timeout=N`). */
  httpExtensionUris: string[];
}

// ─── Themes (pi-tui ships no default themes in its public exports) ──────────

const markdownTheme = {
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

const selectListTheme = {
  selectedPrefix: (s: string) => pc.green(s),
  selectedText: (s: string) => pc.bold(s),
  description: (s: string) => pc.dim(s),
  scrollInfo: (s: string) => pc.dim(s),
  noMatch: (s: string) => pc.yellow(s),
};

const editorTheme = {
  borderColor: (s: string) => pc.cyan(s),
  selectList: selectListTheme,
};

const dimMarkdownTheme = {
  ...markdownTheme,
  heading: (s: string) => pc.dim(s),
  bold: (s: string) => pc.bold(pc.dim(s)),
};

// ─── Chat session ────────────────────────────────────────────────────────────

/** Render an ACP `Cost` object (`{ amount, currency }`) for the status line. */
function formatCost(cost: any): string {
  if (!cost || typeof cost.amount !== "number") return "";
  const amount = cost.amount.toFixed(4);
  const currency = typeof cost.currency === "string" ? cost.currency : "";
  if (!currency) return ` · ${amount}`;
  return currency.toUpperCase() === "USD" ? ` · $${amount}` : ` · ${amount} ${currency}`;
}

interface ToolLine {
  component: Text;
  title: string;
  status: string;
}

const STATUS_ICON: Record<string, string> = {
  pending: "⏳",
  in_progress: "🔨",
  completed: "✅",
  failed: "❌",
};

/** ACP `fs/read_text_file` default window (the spec suggests 2000 lines). */
const DEFAULT_READ_LIMIT = 2000;

export async function runAcpChat(opts: AcpChatOptions): Promise<void> {
  // Keep the last stderr lines around so an agent crash can be explained.
  const stderrTail: string[] = [];
  let setupFailed = false;

  // Assigned once the UI exists: the agent may exit before that (spawn
  // failure), and touching TDZ variables from the transport would throw.
  let onAgentExit: (code: number | null) => void = () => {};

  const client = AcpClient.spawn({
    cwd: opts.cwd,
    env: opts.env,
    args: opts.agentBuiltins.length > 0
      ? ["--with-builtin", opts.agentBuiltins.join(",")]
      : [],
    onStderr: (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 20) stderrTail.shift();
      if (process.env.CGOOSE_DEBUG === "1") {
        process.stderr.write(`${pc.dim(line)}\n`);
      }
    },
    onExit: (code) => onAgentExit(code),
  });

  const terminal = new ProcessTerminal();
  // Chat renders into its own viewport (alternate screen): the transcript
  // scrolls *inside* the TUI — wheel, PgUp/PgDn, Ctrl+Shift+F search — and
  // streaming updates never drag the view back to the bottom. Only the
  // composer is pinned; the header scrolls with the conversation.
  // On exit pi-tui prints the final transcript to
  // the normal screen, so the conversation still lands in the scrollback.
  //
  // CGOOSE_CHAT_MAIN_SCREEN=1 restores the inline renderer, where the terminal
  // owns the scrollback: any repaint writes at the cursor and pulls the view
  // down, so reading history during a turn is best-effort there.
  const altScreen = process.env.CGOOSE_CHAT_MAIN_SCREEN !== "1";
  const tui: TUI = altScreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);

  const transcript = new Container();
  const statusLine = new Text("", 0, 0);
  const headerLine = new Text("", 1, 0);
  let currentMd: Markdown | null = null;
  let currentMessageId: string | null = null;
  let streamBuffer = "";
  let thoughtMd: Markdown | null = null;
  let thoughtBuffer = "";
  let userLine: Text | null = null;
  let userBuffer = "";
  let userMessageId: string | null = null;
  const toolLines = new Map<string, ToolLine>();
  let busy = false;
  let exiting = false;
  let agentDead = false;
  let lastFlush = 0;
  let sessionId: string | null = null;
  /** Config options goose resolved when the session was created (has the model). */
  let newSessionConfigOptions: SessionConfigOption[] | undefined;
  let sessionTitle: string | undefined = opts.sessionTitle;

  // ─── Mutable configuration ────────────────────────────────────────────────
  // The wizard's values seed the session; these locals make them changeable at
  // runtime (see the configuration commands further down).
  let currentProvider = opts.provider;
  let currentModel = opts.model;
  let currentSet: SessionSet | undefined = opts.set;
  let currentUseDefaultProfile = opts.useDefaultProfile;
  // Short form: the header already carries the cwd and the session title, so
  // the long "Default (goose config.yaml)" label would wrap the line.
  let currentSetLabel = opts.set?.title ?? (opts.useDefaultProfile ? "Default" : undefined);

  // Turn watchdogs (see ./timeouts.ts). `lastAgentActivity` is refreshed by
  // every session/update, so only a *silent* agent is cancelled by the idle
  // guard; the hard cap is the last-resort bound on one turn.
  const idleTimeout = resolveTimeoutMs(process.env[IDLE_TIMEOUT_ENV], DEFAULT_IDLE_TIMEOUT_MS, IDLE_TIMEOUT_ENV);
  const turnTimeout = resolveTimeoutMs(process.env[TURN_TIMEOUT_ENV], DEFAULT_TURN_TIMEOUT_MS, TURN_TIMEOUT_ENV);
  const timeoutWarnings = [idleTimeout.invalid, turnTimeout.invalid].filter((w): w is string => w !== null);
  let lastAgentActivity = 0;
  let cancelRequested = false;
  // The editor ignores Esc, so a non-empty draft would make it a dead key:
  // the first Esc arms the exit, the second performs it. Any other key disarms
  // it again (see the input listener).
  let escArmedExit = false;
  let exitHintShown = false;
  /** True while a configuration menu overlay is open. */
  let menuActive = false;

  // ─── Extension set ────────────────────────────────────────────────────────

  // Chat mode has no `--no-profile` flag, but goose's `_meta.enabledExtensions`
  // REPLACES the profile's extension list — an empty array therefore means
  // "no extensions at all", exactly like classic `--no-profile`. The Default
  // set opts out and lets goose load its profile.
  let plan = planGooseExtensions({
    builtins: opts.agentBuiltins,
    stdio: opts.stdioExtensionSpecs,
    http: opts.httpExtensionUris,
  });
  // Sent as well: goose ignores `mcpServers` only when it honours the typed
  // list, so older versions still receive the set's servers (additively).
  let mcpServers = buildMcpServers({
    stdio: opts.stdioExtensionSpecs,
    http: opts.httpExtensionUris,
  });
  // A spec with inline env values cannot be expressed through goose's extension
  // API, so such a set falls back to the additive behaviour.
  let exactSet = !opts.useDefaultProfile && plan.unsupported.length === 0;

  // Default on RESUME needs the same treatment even though a new Default session
  // simply lets goose load its profile: `session/load` restores the stored set
  // (say, the `None` the session was created with) and goose has no
  // "reset to profile" request. So the profile is rebuilt from config.yaml and
  // reconciled like an exact set — that is what makes switching a session to
  // Default actually bring the extensions back.
  //
  // The profile comes from config.yaml, not from
  // `_goose/unstable/config/extensions/list`: goose filters HIDDEN platform
  // extensions out of that listing (`is_hidden_extension`), and in 1.57 the
  // hidden ones are `scheduler` and `orchestrator`. Building Default from the
  // RPC would silently drop the scheduler on every switch.
  let profilePlan = opts.useDefaultProfile ? planProfileExtensions(listGooseExtensions()) : null;

  /** The extension list this session must end up with. */
  let desiredExtensions: GooseExtension[] = profilePlan ? profilePlan.extensions : plan.extensions;
  /** Enabled profile extensions ACP cannot carry (inline env): leave untouched. */
  let protectedNames = new Set((profilePlan?.unsupported ?? []).map((entry) => entry.name));
  const extensionWarnings = new Set<string>();

  interface ExtensionPlanState {
    plan: ReturnType<typeof planGooseExtensions>;
    mcpServers: ReturnType<typeof buildMcpServers>;
    exactSet: boolean;
    profilePlan: ReturnType<typeof planProfileExtensions> | null;
    desiredExtensions: GooseExtension[];
    protectedNames: Set<string>;
    /** Problems resolving the set's `extensions:` names against config.yaml. */
    warnings: string[];
  }

  /** Rebuild the whole extension plan for another set.
   *
   *  `buildExtensionArgs` resolves the `extensions:` names a set lists against
   *  config.yaml — the very same step the launcher performs at startup — so a
   *  live switch produces the list the session would have been created with. */
  function planForSet(set: SessionSet | undefined, useDefault: boolean): ExtensionPlanState {
    const extArgs = set
      ? buildExtensionArgs(set.extensions ?? [])
      : { builtins: [], stdio: [], http: [], warnings: [] };
    const builtins = [...new Set([...(set?.builtins ?? []), ...extArgs.builtins])];
    const stdio = [...(set?.stdioExtensions ?? []), ...extArgs.stdio];
    const http = [...extArgs.http];
    const nextPlan = planGooseExtensions({ builtins, stdio, http });
    const nextProfilePlan = useDefault ? planProfileExtensions(listGooseExtensions()) : null;
    return {
      plan: nextPlan,
      mcpServers: buildMcpServers({ stdio, http }),
      // Same rule as at startup: an inline-env stdio spec cannot be expressed
      // through goose's extension API, so such a set stays additive.
      exactSet: !useDefault && nextPlan.unsupported.length === 0,
      profilePlan: nextProfilePlan,
      desiredExtensions: nextProfilePlan ? nextProfilePlan.extensions : nextPlan.extensions,
      protectedNames: new Set((nextProfilePlan?.unsupported ?? []).map((entry) => entry.name)),
      warnings: extArgs.warnings,
    };
  }

  /** Make the new plan the one the session is reconciled against. Warnings are
   *  per-configuration, so they are dropped (a warning that still applies is
   *  reported again by the reconciliation that follows). */
  function applyExtensionPlan(next: ExtensionPlanState): void {
    plan = next.plan;
    mcpServers = next.mcpServers;
    exactSet = next.exactSet;
    profilePlan = next.profilePlan;
    desiredExtensions = next.desiredExtensions;
    protectedNames = next.protectedNames;
    extensionWarnings.clear();
  }

  /** Extensions the session MUST have (exactly what the set lists). */
  function requiredExtensions(): GooseExtension[] {
    return desiredExtensions;
  }

  /** Extensions the session is allowed to have on top. Some goose builds inject
   *  their own `developer` into an ACP session; it must not be reported as a
   *  profile leak, removed, or added when a set does not list it. */
  function allowedExtensionNames(): Set<string> {
    const allowed = new Set(desiredExtensions.map(extensionName));
    allowed.add("developer");
    return allowed;
  }

  function noteExtensionWarning(message: string): void {
    if (extensionWarnings.has(message)) return;
    extensionWarnings.add(message);
    transcript.addChild(new Text(pc.yellow(`⚠ ${message}`), 1, 0));
    tui.requestRender();
  }

  /** New session: did the agent actually apply the typed list? A version that
   *  ignores it loads the profile on top, which is exactly what the old blanket
   *  warning claimed for every set. Now the claim is checked, not assumed. */
  async function verifySessionExtensions(id: string): Promise<void> {
    let actual: Awaited<ReturnType<typeof listSessionExtensions>>;
    try {
      actual = await listSessionExtensions(client, id);
    } catch (error) {
      noteExtensionWarning(`cannot verify the session extension set: ${String((error as Error)?.message ?? error)}`);
      return;
    }
    const allowed = allowedExtensionNames();
    const required = new Set(requiredExtensions().map(extensionName));
    const present = new Set(
      actual.map(listedExtensionName).filter((name): name is string => name !== null),
    );
    const leaked = [...present].filter((name) => !allowed.has(name));
    const missing = [...required].filter((name) => !present.has(name));
    if (leaked.length > 0) {
      noteExtensionWarning(
        `this goose version ignored "enabledExtensions" — the default profile is loaded too (${leaked.join(", ")})`,
      );
    } else if (missing.length > 0) {
      noteExtensionWarning(`the agent did not load: ${missing.join(", ")}`);
    }
  }

  /** Resume: `session/load` restores the extension set stored in the session and
   *  ignores every extension channel, so the selected set is applied by diffing
   *  the live list and adding/removing the difference. Classic mode drops the
   *  extension flags on resume; chat mode makes the set authoritative. */
  async function reconcileSessionExtensions(id: string, context = "resumed session"): Promise<void> {
    let actual: Awaited<ReturnType<typeof listSessionExtensions>>;
    try {
      actual = await listSessionExtensions(client, id);
    } catch (error) {
      noteExtensionWarning(`cannot read the session's extensions: ${String((error as Error)?.message ?? error)}`);
      return;
    }
    // The desired list is compared as-is: adding an MCP server must send its
    // real `{type:"mcp", server}` shape, not a placeholder builtin with the
    // same name.
    const desired = requiredExtensions();
    const desiredNames = new Set(desired.map(extensionName));
    // `developer` counts as expected so reconciliation never removes it; it is
    // filtered out of the additions below, because a set that does not list it
    // must not gain it on resume (the profile, by contrast, lists it itself).
    const expected: GooseExtension[] = desiredNames.has("developer")
      ? desired
      : [...desired, { type: "builtin", name: "developer" }];
    // Profile entries ACP cannot express are left exactly as they are: not
    // re-added (impossible), not removed (that would silently drop them).
    const considered = actual.filter((entry) => {
      const name = listedExtensionName(entry);
      return name === null || !protectedNames.has(name);
    });
    const diff = diffExtensions(expected, considered);
    const add = diff.add.filter((extension) => desiredNames.has(extensionName(extension)));
    const remove = diff.remove;
    for (const entry of remove) {
      try {
        await removeSessionExtension(client, id, entry.key);
      } catch (error) {
        noteExtensionWarning(`could not remove extension "${entry.name}": ${String((error as Error)?.message ?? error)}`);
      }
    }
    for (const extension of add) {
      try {
        await addSessionExtension(client, id, extension);
      } catch (error) {
        noteExtensionWarning(
          `could not add extension "${extensionName(extension)}": ${String((error as Error)?.message ?? error)}`,
        );
      }
    }
    if (add.length > 0 || remove.length > 0) {
      const parts: string[] = [];
      if (add.length > 0) parts.push(`added ${add.map(extensionName).join(", ")}`);
      if (remove.length > 0) parts.push(`removed ${remove.map((entry) => entry.name).join(", ")}`);
      transcript.addChild(new Text(
        pc.yellow(
          `${profilePlan ? "default profile" : "set"} applied to the ${context}: ${parts.join("; ")}`,
        ),
        1, 0,
      ));
    }
  }

  // ─── Agent → client handlers ──────────────────────────────────────────────

  // Permission requests are queued: goose may ask about several tool calls in
  // parallel, while only one overlay can be visible at a time. Every pending
  // request must be answered, otherwise the agent waits forever.
  interface PendingPermission {
    params: any;
    resolve: (response: RequestPermissionResponse) => void;
  }
  const permissionQueue: PendingPermission[] = [];
  let activePermission: { finish: (response: RequestPermissionResponse) => void } | null = null;

  const cancelAllPermissions = (): void => {
    // Drain the queue first so `finish()` cannot pop a new overlay while we
    // are resolving the rest.
    const pending = permissionQueue.splice(0);
    const active = activePermission;
    activePermission = null;
    active?.finish({ outcome: { outcome: "cancelled" } });
    for (const entry of pending) {
      entry.resolve({ outcome: { outcome: "cancelled" } });
    }
  };

  /** Overlay frame: a titled border, so a menu does not blend into the chat
   *  behind it (pi-tui has no border primitive of its own). */
  const framed = (content: Component, title: string): BorderBox =>
    new BorderBox(content, { title: pc.bold(title), border: pc.dim });

  const showNextPermission = (): void => {
    if (activePermission || exiting || agentDead) return;
    const next = permissionQueue.shift();
    if (!next) return;

    const params = next.params;
    const options = Array.isArray(params?.options) ? params.options : [];
    const items = options.map((o: any) => ({
      value: o.optionId,
      label: o.name ?? o.optionId,
      description: o.description,
    }));
    const title = params?.toolCall?.title ?? "Permission required";
    const list = new SelectList(
      items.length > 0 ? items : [{ value: "cancel", label: "Cancel" }],
      6,
      selectListTheme,
    );
    let finished = false;
    const finish = (response: RequestPermissionResponse): void => {
      if (finished) return;
      finished = true;
      activePermission = null;
      tui.hideOverlay();
      tui.setFocus(editor);
      next.resolve(response);
      showNextPermission();
    };
    activePermission = { finish };
    list.onSelect = (item: any) => {
      finish(item.value === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: String(item.value) } });
    };
    list.onCancel = () => finish({ outcome: { outcome: "cancelled" } });
    tui.showOverlay(framed(list, `⚡ ${title}`), { width: 76 });
    tui.setFocus(list);
  };

  client.setPromptHandlers({
    requestPermission: (params) => new Promise<RequestPermissionResponse>((resolve) => {
      if (exiting || agentDead) {
        resolve({ outcome: { outcome: "cancelled" } });
        return;
      }
      permissionQueue.push({ params, resolve });
      showNextPermission();
    }),

    readTextFile: async (params) => {
      const content = await readFile(params.path as string, "utf-8");
      // ACP asks for a 1-based window (`line`, `limit`); the spec's default for
      // `limit` is 2000 lines, which also keeps a huge file from flooding the
      // model's context when the agent asks for everything.
      const line = Number(params.line ?? 0);
      const limit = Number(params.limit ?? 0);
      const start = Number.isFinite(line) && line > 0 ? line - 1 : 0;
      const count = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_READ_LIMIT;
      return { content: content.split("\n").slice(start, start + count).join("\n") };
    },

    writeTextFile: async (params) => {
      const filePath = params.path as string;
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, params.content as string, "utf-8");
      return {};
    },
  });

  // ─── Session update rendering ─────────────────────────────────────────────

  /** Close the current thought block so the next burst renders separately. */
  const closeThought = (): void => {
    if (thoughtMd) {
      thoughtMd.setText(thoughtBuffer);
      thoughtMd = null;
      thoughtBuffer = "";
    }
  };

  /** Close the replayed user message block (chunks of one message are merged). */
  const closeUser = (): void => {
    userLine = null;
    userBuffer = "";
    userMessageId = null;
  };

  /** Close the current agent message block (a tool call splits the answer). */
  const closeMessage = (): void => {
    if (currentMd) {
      flushStream(true);
      currentMd = null;
      streamBuffer = "";
    }
    currentMessageId = null;
  };

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushStream = (force = false): void => {
    if (force && flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const now = Date.now();
    if (!force && now - lastFlush < 50) {
      // Trailing flush: guarantee the buffer is painted even when chunks
      // arrive faster than the throttle window.
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushStream(true);
        }, 50);
      }
      return;
    }
    lastFlush = now;
    if (currentMd) {
      currentMd.setText(streamBuffer || "…");
      tui.requestRender();
    }
    if (thoughtMd) {
      thoughtMd.setText(thoughtBuffer);
      tui.requestRender();
    }
  };

  client.onUpdate((notification: SessionNotification) => {
    // Any agent update counts as progress: the idle watchdog is reset.
    lastAgentActivity = Date.now();
    const update = notification.update as any;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content?.type === "text") {
          closeUser();
          closeThought();
          // A new messageId means a new message (history replay relies on it).
          const messageId = typeof update.messageId === "string" ? update.messageId : null;
          if (messageId && messageId !== currentMessageId) closeMessage();
          if (messageId) currentMessageId = messageId;
          if (!currentMd) {
            currentMd = new Markdown("", 1, 0, markdownTheme);
            transcript.addChild(currentMd);
          }
          streamBuffer += update.content.text;
          flushStream();
        }
        break;
      }
      case "user_message_chunk": {
        if (update.content?.type === "text") {
          // A live turn already echoed the prompt locally; replay
          // (session/load) arrives while idle and must be rendered. Chunks of
          // one message are merged into a single line.
          if (busy) break;
          closeThought();
          closeMessage();
          const messageId = typeof update.messageId === "string" ? update.messageId : null;
          if (userLine && messageId && userMessageId && messageId !== userMessageId) {
            closeUser();
          }
          if (!userLine) {
            userLine = new Text("", 1, 0);
            transcript.addChild(userLine);
            userBuffer = "";
            userMessageId = messageId;
          }
          userBuffer += update.content.text;
          userLine.setText(pc.bold(`❯ ${userBuffer}`));
          tui.requestRender();
        }
        break;
      }
      case "agent_thought_chunk": {
        if (update.content?.type === "text") {
          if (!thoughtMd) {
            thoughtMd = new Markdown("", 1, 0, dimMarkdownTheme, { color: pc.dim });
            transcript.addChild(new Text(pc.dim("💭 thinking"), 1, 0));
            transcript.addChild(thoughtMd);
          }
          thoughtBuffer += update.content.text;
          flushStream();
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        closeUser();
        closeThought();
        closeMessage();
        const existing = toolLines.get(update.toolCallId);
        // Merge with the stored status: a partial `tool_call_update` without a
        // status must not demote an already finished line back to "in progress".
        const status = update.status ?? existing?.status ?? "";
        const icon = STATUS_ICON[status] ?? "🔨";
        const title = update.title ?? existing?.title ?? update.toolCallId;
        const line = `${icon} ${title}`;
        if (existing) {
          existing.title = title;
          existing.status = status;
          existing.component.setText(line);
        } else {
          const comp = new Text(line, 1, 0);
          toolLines.set(update.toolCallId, { component: comp, title, status });
          transcript.addChild(comp);
        }
        tui.requestRender();
        break;
      }
      case "usage_update": {
        usagePart = `tokens ${update.used}/${update.size}${formatCost(update.cost)}`;
        renderStatus();
        break;
      }
      case "session_info_update": {
        if (typeof update.title === "string" && update.title) {
          sessionTitle = update.title;
          renderHeader();
        }
        break;
      }
      default:
        break;
    }
  });

  // Status line: provider/model + token usage (kept as parts so usage updates
  // never wipe the model info).
  let usagePart = "";
  const renderStatus = (): void => {
    statusLine.setText([pc.dim(`${currentProvider}/${currentModel}`), usagePart ? pc.dim(usagePart) : ""]
      .filter(Boolean)
      .join(pc.dim("  ")));
    tui.requestRender();
  };
  const renderHeader = (): void => {
    const title = sessionTitle ? `  ${pc.dim(`· ${sessionTitle}`)}` : "";
    const setText = currentSetLabel ? `  ${pc.dim(`· set: ${currentSetLabel}`)}` : "";
    headerLine.setText(
      `${pc.green("🪿 cgoose chat")}  ${pc.dim(`${currentProvider}/${currentModel}  ${opts.cwd}`)}${title}${setText}`,
    );
    tui.requestRender();
  };

  // ─── Configuration commands ───────────────────────────────────────────────

  const showMenu = (
    title: string,
    items: Array<{ value: string; label: string; description?: string }>,
    onSelect: (value: string) => void | Promise<void>,
    options: { layout?: SelectListLayoutOptions; width?: number; searchable?: boolean } = {},
  ): void => {
    if (activePermission || menuActive) return; // don't stack overlays
    menuActive = true;
    const entries = items.length > 0 ? items : [{ value: "cancel", label: "Cancel" }];
    // Long lists (a provider can report 700+ models) need a filter; short ones
    // are quicker with the plain list.
    const list: SelectList | SearchableList = options.searchable
      ? new SearchableList(entries, selectListTheme, {
          maxVisible: 10,
          layout: options.layout,
          placeholder: "type to filter",
          searchStyle: pc.dim,
        })
      : new SelectList(entries, 10, selectListTheme, options.layout);
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      menuActive = false;
      tui.hideOverlay();
      tui.setFocus(editor);
    };
    list.onSelect = (item: any) => {
      finish();
      if (item.value === "cancel") return;
      void onSelect(String(item.value));
    };
    list.onCancel = () => finish();
    tui.showOverlay(framed(list, `⚙ ${title}`), { width: options.width ?? 76 });
    tui.setFocus(list);
  };

  const changeModel = async (newModel: string): Promise<void> => {
    if (!sessionId) return;
    const outcome = await applySessionConfig(
      client,
      sessionId,
      { provider: currentProvider, model: newModel },
      { provider: currentProvider, model: currentModel },
    );
    if (outcome.configOptions) newSessionConfigOptions = outcome.configOptions;
    if (outcome.warning) {
      transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
    } else {
      currentModel = outcome.model ?? newModel;
      transcript.addChild(new Text(pc.dim(`⚙ Model changed to ${currentModel}`), 1, 0));
      renderStatus();
      renderHeader();
    }
    tui.requestRender();
  };

  const changeProvider = async (newProvider: string): Promise<void> => {
    if (!sessionId) return;
    const outcome = await applySessionConfig(
      client,
      sessionId,
      { provider: newProvider, model: currentModel },
      { provider: currentProvider, model: currentModel },
    );
    if (outcome.configOptions) newSessionConfigOptions = outcome.configOptions;
    if (outcome.warning) {
      transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
    } else {
      currentProvider = outcome.provider ?? newProvider;
      currentModel = outcome.model ?? currentModel;
      transcript.addChild(new Text(pc.dim(`⚙ Provider changed to ${currentProvider}, model: ${currentModel}`), 1, 0));
      renderStatus();
      renderHeader();
    }
    tui.requestRender();
  };

  /** Switch the session to another set, live: the system prompt is replaced and
   *  the extension list is reconciled against the live session, so a set change
   *  takes effect without restarting the chat. */
  const changeSet = async (setName: string | undefined): Promise<void> => {
    if (!sessionId) return;
    if (busy) {
      transcript.addChild(new Text(pc.yellow("⚠ Cannot change the set while a turn is in progress."), 1, 0));
      tui.requestRender();
      return;
    }
    let newSet: SessionSet | undefined;
    let useDefault = false;
    let label: string | undefined;
    if (setName === "default") {
      useDefault = true;
      label = "Default (goose config.yaml)";
    } else if (setName === "none") {
      useDefault = false;
      label = "None";
    } else if (setName) {
      const sets = listSessionSets();
      newSet = sets[setName];
      if (!newSet) {
        transcript.addChild(new Text(pc.yellow(`⚠ Set "${setName}" not found.`), 1, 0));
        tui.requestRender();
        return;
      }
      useDefault = false;
      label = newSet.title;
    } else {
      transcript.addChild(new Text(pc.yellow("⚠ No set specified."), 1, 0));
      tui.requestRender();
      return;
    }

    // Resolve the new set before touching the session: a bad `extensions:` entry
    // must be reported, not half-applied.
    const next = planForSet(newSet, useDefault);
    for (const warning of next.warnings) noteExtensionWarning(warning);

    try {
      await setSessionSystemPrompt(client, sessionId, {
        mode: "set",
        key: "cgoose",
        text: newSet?.systemPrompt ?? "",
      });
      transcript.addChild(
        new Text(
          pc.dim(
            `⚙ Set changed to ${label ?? "None"}${newSet?.systemPrompt ? " (system prompt applied)" : " (system prompt cleared)"}`,
          ),
          1, 0,
        ),
      );
    } catch (error) {
      transcript.addChild(new Text(pc.yellow(`⚠ System prompt not applied: ${String((error as Error)?.message ?? error)}`), 1, 0));
    }

    // The reconciliation below diffs against the *new* plan, so it must be the
    // active one first.
    applyExtensionPlan(next);
    await reconcileSessionExtensions(sessionId, "running session");
    if (next.profilePlan && next.profilePlan.unsupported.length > 0) {
      noteExtensionWarning(
        `cannot apply through ACP, left as-is: ${next.profilePlan.unsupported
          .map((entry) => `${entry.name} (${entry.reason})`)
          .join(", ")}`,
      );
    }

    currentSet = newSet;
    currentUseDefaultProfile = useDefault;
    currentSetLabel = useDefault ? "Default" : label;

    renderHeader();
    tui.requestRender();
  };

  const changeSession = async (sessionNameOrId: string): Promise<void> => {
    if (!sessionId) return;
    if (busy) {
      transcript.addChild(new Text(pc.yellow("⚠ Cannot switch sessions while a turn is in progress."), 1, 0));
      tui.requestRender();
      return;
    }
    const sessions = getAllSessions();
    const target = sessions.find((s) => s.id === sessionNameOrId || s.name === sessionNameOrId);
    if (!target) {
      transcript.addChild(new Text(pc.yellow(`⚠ Session "${sessionNameOrId}" not found.`), 1, 0));
      tui.requestRender();
      return;
    }
    try {
      const loaded = await client.loadSession({ cwd: opts.cwd, sessionId: target.id, mcpServers: [] });
      sessionId = target.id;
      sessionTitle = target.name;
      if (loaded?.configOptions) newSessionConfigOptions = loaded.configOptions;
      transcript.addChild(new Text(pc.dim(`─── Switched to session: ${target.name} (${target.id}) ───`), 1, 0));
      // The wizard's provider/model pair survives the switch: applying it also
      // refreshes the config options for the menus.
      const outcome = await applySessionConfig(
        client,
        sessionId,
        { provider: currentProvider, model: currentModel },
        {},
      );
      if (outcome.configOptions) newSessionConfigOptions = outcome.configOptions;
      if (outcome.warning) {
        transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
      } else {
        currentProvider = outcome.provider ?? currentProvider;
        currentModel = outcome.model ?? currentModel;
      }
      // The set stays the source of truth: the target session's stored
      // extensions are brought in line with it, exactly like on resume.
      await reconcileSessionExtensions(sessionId, "switched session");
      renderHeader();
      tui.requestRender();
    } catch (error) {
      transcript.addChild(new Text(pc.yellow(`⚠ Failed to switch session: ${String((error as Error)?.message ?? error)}`), 1, 0));
      tui.requestRender();
    }
  };

  const newSession = async (): Promise<void> => {
    if (busy) {
      transcript.addChild(new Text(pc.yellow("⚠ Cannot start a new session while a turn is in progress."), 1, 0));
      tui.requestRender();
      return;
    }
    try {
      const response = await client.newSession({
        cwd: opts.cwd,
        mcpServers: [],
        _meta: newSessionMeta({
          sessionTitle: "New Chat",
          ...(currentSet && !currentUseDefaultProfile ? { enabledExtensions: plan.extensions } : {}),
        }),
      });
      sessionId = response.sessionId;
      newSessionConfigOptions = response.configOptions;
      sessionTitle = "New Chat";
      transcript.addChild(new Text(pc.dim(`─── New session started: ${sessionId} ───`), 1, 0));
      await applySessionConfig(client, sessionId, { provider: currentProvider, model: currentModel }, {});
      await setSessionSystemPrompt(client, sessionId, { mode: "set", key: "cgoose", text: currentSet?.systemPrompt ?? "" });
      renderHeader();
      tui.requestRender();
    } catch (error) {
      transcript.addChild(new Text(pc.yellow(`⚠ Failed to create new session: ${String((error as Error)?.message ?? error)}`), 1, 0));
      tui.requestRender();
    }
  };

  /** The editor `/edit` opens: `$VISUAL`, then `$EDITOR`, then `vi` — the same
   *  order git uses. */
  const externalEditorCommand = (): string =>
    process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "vi";

  /**
   * Compose the prompt in an external editor and send it on save.
   *
   * The chat owns the alternate screen, so the renderer has to let go of the
   * terminal while the editor runs: `tui.stop({ preserveScreen: true })` leaves
   * the alt screen without printing the transcript, the child gets the real
   * terminal (`stdio: "inherit"`), and `tui.start()` puts the chat back. The
   * draft in the composer seeds the buffer, so `/edit` is also "continue what I
   * was typing in vim".
   */
  const promptInEditor = async (): Promise<void> => {
    if (!sessionId) return;
    if (busy) {
      transcript.addChild(new Text(pc.yellow("⚠ Cannot open the editor while a turn is in progress."), 1, 0));
      tui.requestRender();
      return;
    }
    const command = externalEditorCommand();
    let dir: string;
    let file: string;
    try {
      dir = await mkdtemp(join(tmpdir(), "cgoose-edit-"));
      file = join(dir, "prompt.md");
      await writeFile(file, editor.getText(), "utf8");
    } catch (error) {
      transcript.addChild(new Text(pc.yellow(`⚠ Cannot prepare the editor buffer: ${String((error as Error)?.message ?? error)}`), 1, 0));
      tui.requestRender();
      return;
    }

    let exitCode = 0;
    try {
      tui.stop({ preserveScreen: true });
      exitCode = await new Promise<number>((resolve) => {
        let settled = false;
        const done = (code: number): void => {
          if (settled) return;
          settled = true;
          resolve(code);
        };
        // Through the shell: `$EDITOR` is commonly `code --wait` or `nvim -f`,
        // and `"$1"` keeps the path safe whatever it contains.
        const child = spawn(process.env.SHELL?.trim() || "/bin/sh", ["-c", `${command} "$1"`, "cgoose-edit", file], {
          stdio: "inherit",
          env: process.env,
        });
        child.on("error", () => done(-1));
        child.on("close", (code) => done(code ?? 0));
      });
    } finally {
      // Take the terminal back even if the spawn failed.
      tui.start();
    }

    let text = "";
    try {
      text = (await readFile(file, "utf8")).trim();
    } catch {
      // Fall through to the "empty" branch: nothing to send.
    }
    void rm(dir, { recursive: true, force: true }).catch(() => {});

    if (exitCode !== 0) {
      transcript.addChild(new Text(pc.yellow(`⚠ Editor "${command}" exited with code ${exitCode} — nothing sent.`), 1, 0));
      tui.requestRender();
      return;
    }
    if (!text) {
      transcript.addChild(new Text(pc.dim("Editor closed with an empty buffer — nothing sent."), 1, 0));
      tui.requestRender();
      return;
    }
    // The text becomes the prompt, so the composer's copy must not be sent twice.
    editor.setText("");
    await submitPrompt(text);
  };

  /** True while the composer collects a new session title (`/session rename`
   *  with no argument, or the menu entry). */
  let awaitingRename = false;

  const renameCurrentSession = async (title: string | undefined): Promise<void> => {
    if (!sessionId) return;
    const next = title?.trim();
    if (!next) {
      transcript.addChild(new Text(pc.yellow("⚠ Usage: /session rename <title>"), 1, 0));
      tui.requestRender();
      return;
    }
    try {
      await renameSession(client, sessionId, next);
      sessionTitle = next;
      transcript.addChild(new Text(pc.dim(`⚙ Session renamed to "${next}"`), 1, 0));
      renderHeader();
    } catch (error) {
      transcript.addChild(new Text(pc.yellow(`⚠ Rename failed: ${String((error as Error)?.message ?? error)}`), 1, 0));
    }
    tui.requestRender();
  };

  /** Ask the composer for a title (`session/rename` needs free text). */
  const promptRename = (): void => {
    if (!sessionId) return;
    awaitingRename = true;
    transcript.addChild(new Text(pc.dim("Type the new session title, Enter to apply (Esc to cancel)."), 1, 0));
    tui.setFocus(editor);
    tui.requestRender();
  };

  /** `session/fork` copies the conversation into a new session; cgoose then
   *  re-applies the current provider/model pair and reconciles the extensions
   *  against the current set, so the copy keeps the configuration on screen. */
  const forkCurrentSession = async (): Promise<void> => {
    if (!sessionId) return;
    if (busy) {
      transcript.addChild(new Text(pc.yellow("⚠ Cannot fork while a turn is in progress."), 1, 0));
      tui.requestRender();
      return;
    }
    try {
      const previousTitle = sessionTitle;
      const response = await client.forkSession({ sessionId, cwd: opts.cwd, mcpServers: [] });
      sessionId = response.sessionId;
      if (response.configOptions) newSessionConfigOptions = response.configOptions;
      const title = `${previousTitle || "Session"} (fork)`;
      try {
        await renameSession(client, sessionId, title);
      } catch {
        // Purely cosmetic: the fork exists either way.
      }
      sessionTitle = title;
      transcript.addChild(new Text(pc.dim(`─── Forked into a new session: ${title} (${sessionId}) ───`), 1, 0));
      const outcome = await applySessionConfig(
        client,
        sessionId,
        { provider: currentProvider, model: currentModel },
        {},
      );
      if (outcome.configOptions) newSessionConfigOptions = outcome.configOptions;
      if (outcome.warning) {
        transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
      } else {
        currentProvider = outcome.provider ?? currentProvider;
        currentModel = outcome.model ?? currentModel;
      }
      await reconcileSessionExtensions(sessionId, "forked session");
      renderHeader();
    } catch (error) {
      transcript.addChild(new Text(pc.yellow(`⚠ Fork failed: ${String((error as Error)?.message ?? error)}`), 1, 0));
    }
    tui.requestRender();
  };

  const showConfigMenu = (): void => {
    showMenu("Configuration", [
      { value: "provider", label: "Change Provider" },
      { value: "model", label: "Change Model" },
      { value: "set", label: "Change Set" },
      { value: "session", label: "Change Session" },
    ], (value) => {
      switch (value) {
        case "provider": showProviderMenu(); break;
        case "model": showModelMenu(); break;
        case "set": showSetMenu(); break;
        case "session": showSessionMenu(); break;
      }
    });
  };

  const showProviderMenu = (): void => {
    const options = newSessionConfigOptions?.find((o) => o.id === "provider")?.options ?? [];
    if (options.length === 0) {
      transcript.addChild(new Text(
        pc.yellow("⚠ No provider list available (config options missing). Use /provider <name> or restart."),
        1, 0,
      ));
      tui.requestRender();
      return;
    }
    const items = options.map((o) => ({ value: o.value, label: o.name ?? o.value }));
    items.push({ value: "cancel", label: "Cancel" });
    showMenu("Select Provider", items, (value) => {
      if (value !== "cancel") void changeProvider(value);
    });
  };

  /** The provider entry from config.yaml / custom_providers/*.json, which is
   *  what the HTTP model fetch needs (base_url + api key). */
  const currentProviderConfig = (): ProviderInfo | undefined => {
    const yamlProviders = getConfigProviders();
    return [...yamlProviders, ...getDiscoveredCustomProviders(yamlProviders)].find(
      (entry) => entry.name === currentProvider,
    );
  };

  const applyFetchedModel = async (model: ApiModelInfo, provider: ProviderInfo): Promise<void> => {
    await changeModel(model.id);
    // A model the provider JSON does not list has no context limit, and the
    // wizard would not offer it either — record it (the API's own limit when it
    // reports one) so both UIs see the same list.
    if (provider.name.startsWith("custom_") && !isModelInCustomProviderJson(provider.name, model.id)) {
      const contextLimit = model.contextLimit ?? 128_000;
      if (addModelToCustomProviderJson(provider.name, model.id, contextLimit)) {
        transcript.addChild(new Text(
          pc.dim(`⚙ Added "${model.id}" to ${provider.name} (context_limit: ${formatNumber(contextLimit)})`),
          1, 0,
        ));
      }
    }
    tui.requestRender();
  };

  /** Ask the provider's own /v1/models endpoint for its current model list — the
   *  list goose may not know until the model is added to the provider JSON. */
  const fetchModelsForCurrentProvider = async (): Promise<void> => {
    const provider = currentProviderConfig();
    if (!provider || !provider.baseUrl) {
      transcript.addChild(new Text(
        pc.yellow(`⚠ "${currentProvider}" is not an HTTP provider with a base_url — cannot fetch models. Use /model <name>.`),
        1, 0,
      ));
      tui.requestRender();
      return;
    }
    if (!provider.authToken) {
      const envHint = provider.apiKeyEnv || `${provider.name.replace(/^custom_/, "").toUpperCase()}_API_KEY`;
      transcript.addChild(new Text(
        pc.yellow(`⚠ No API key for "${provider.name}" — set $${envHint} and retry.`),
        1, 0,
      ));
      tui.requestRender();
      return;
    }
    transcript.addChild(new Text(pc.dim(`🔄 Fetching models from ${provider.baseUrl}…`), 1, 0));
    tui.requestRender();
    try {
      const models = await fetchModels(provider);
      if (models.length === 0) {
        transcript.addChild(new Text(pc.yellow("⚠ The API returned no models."), 1, 0));
        tui.requestRender();
        return;
      }
      transcript.addChild(new Text(pc.dim(`Found ${models.length} model(s) at ${provider.name}.`), 1, 0));
      showMenu(`Models from ${provider.name}`, models.map((model) => ({
        value: model.id,
        label: model.id,
        description: model.contextLimit
          ? `context: ${formatNumber(model.contextLimit)}`
          : "context: 128k default",
      })), (value) => {
        const picked = models.find((model) => model.id === value);
        if (picked) void applyFetchedModel(picked, provider);
      // Model ids are long (`~anthropic/claude-sonnet-latest`) and the context
      // limit needs its own room, so this menu is wider than the others; it is
      // also searchable, because the API can return hundreds of models.
      }, { width: 88, layout: { maxPrimaryColumnWidth: 52 }, searchable: true });
    } catch (error) {
      transcript.addChild(new Text(
        pc.yellow(`⚠ Failed to fetch models: ${String((error as Error)?.message ?? error)}`),
        1, 0,
      ));
    }
    tui.requestRender();
  };

  const showModelMenu = (): void => {
    const options = newSessionConfigOptions?.find((o) => o.id === "model")?.options ?? [];
    const items: Array<{ value: string; label: string; description?: string }> =
      options.map((o) => ({ value: o.value, label: o.name ?? o.value }));
    if (options.length === 0) {
      // No list from goose: the API fetch is the way out, so the menu stays open
      // instead of dead-ending in a warning.
      transcript.addChild(new Text(
        pc.dim("goose reported no model list for this session — fetch it from the provider, or use /model <name>."),
        1, 0,
      ));
    }
    items.push({
      value: "!fetch",
      label: "🔄 Fetch models from API",
      description: currentProvider,
    });
    items.push({ value: "cancel", label: "Cancel" });
    showMenu("Select Model", items, (value) => {
      if (value === "!fetch") void fetchModelsForCurrentProvider();
      else if (value !== "cancel") void changeModel(value);
    });
  };

  const showSetMenu = (): void => {
    const sets = listSessionSets();
    const items = Object.values(sets).map((s) => ({ value: s.name, label: s.title }));
    items.push({ value: "default", label: "Default (goose config.yaml)" });
    items.push({ value: "none", label: "None" });
    items.push({ value: "cancel", label: "Cancel" });
    showMenu("Select Set", items, (value) => {
      if (value !== "cancel") void changeSet(value);
    });
  };

  const showSessionMenu = (): void => {
    // Same project filter as the wizard: the whole sessions.db holds every
    // project the user ever ran, and switching into someone else's working
    // directory would put the agent in the wrong place.
    const dirs = new Set([opts.cwd]);
    if (isInsideGitRepo()) for (const dir of getProjectSessionDirs(opts.cwd)) dirs.add(dir);
    const sessions = getAllSessions().filter((s) => s.working_dir && dirs.has(s.working_dir));
    const items: Array<{ value: string; label: string; description?: string }> = sessions
      .filter((s) => s.id !== sessionId)
      .map((s) => ({
        value: s.id,
        label: s.name || s.id,
        description: `${s.message_count} msg · ${s.session_type ?? "user"}`,
      }));
    items.unshift(
      { value: "!rename", label: "✎ Rename current session" },
      { value: "!fork", label: "⑂ Fork current session" },
    );
    items.push({ value: "new", label: "＋ New Session" });
    items.push({ value: "cancel", label: "Cancel" });
    showMenu("Select Session", items, (value) => {
      if (value === "new") {
        void newSession();
      } else if (value === "!rename") {
        promptRename();
      } else if (value === "!fork") {
        void forkCurrentSession();
      } else if (value !== "cancel") {
        void changeSession(value);
      }
    });
  };

  const handleCommand = async (text: string): Promise<void> => {
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case "config":
      case "settings":
      case "setting":
        showConfigMenu();
        return;
      case "edit":
        await promptInEditor();
        return;
      case "fetch":
        await fetchModelsForCurrentProvider();
        return;
      case "model":
        if (args.length === 0) {
          showModelMenu();
        } else if (args[0] === "fetch") {
          await fetchModelsForCurrentProvider();
        } else {
          await changeModel(args.join(" "));
        }
        return;
      case "provider":
        if (args.length > 0) {
          await changeProvider(args.join(" "));
        } else {
          showProviderMenu();
        }
        return;
      case "set":
        if (args.length > 0) {
          await changeSet(args.join(" "));
        } else {
          showSetMenu();
        }
        return;
      case "session":
        if (args.length > 0) {
          switch (args[0]) {
            case "new":
              await newSession();
              break;
            case "rename":
              if (args.length > 1) await renameCurrentSession(args.slice(1).join(" "));
              else promptRename();
              break;
            case "fork":
              await forkCurrentSession();
              break;
            default:
              await changeSession(args.join(" "));
          }
        } else {
          showSessionMenu();
        }
        return;
      case "rename":
        if (args.length > 0) await renameCurrentSession(args.join(" "));
        else promptRename();
        return;
      case "fork":
        await forkCurrentSession();
        return;
      default:
        transcript.addChild(new Text(pc.yellow(`⚠ Unknown command: /${cmd}. Use /config to open the configuration menu.`), 1, 0));
        tui.requestRender();
        return;
    }
  };

  // ─── UI ───────────────────────────────────────────────────────────────────


  // In the inline renderer every repaint writes at the cursor (the last line)
  // and drags the terminal back to the bottom, so there the spinner must not
  // request renders: its ticks only advance the frame text and the next real
  // update paints it. With a viewport of our own the animation is harmless.
  const inertUi = { requestRender: () => {} } as unknown as TUI;
  const loader = new Loader(altScreen ? tui : inertUi, (s) => pc.cyan(s), (s) => pc.dim(s), "thinking…");
  // The constructor starts the animation; keep it idle until a turn runs.
  loader.stop();
  loader.setText("");

  const setLoader = (message: string | null): void => {
    if (message === null) {
      loader.stop();
      loader.setText("");
      tui.requestRender();
      return;
    }
    loader.setMessage(message);
    loader.start();
    tui.requestRender();
  };

  const editor = new Editor(tui, editorTheme, { paddingX: 1 });

  if (isViewportTUI(tui)) {
    // The header scrolls with the conversation (it is just the first lines of
    // the document), the composer stays pinned at the bottom. `follow: "end"`
    // auto-follows new content until the user scrolls up, and resumes when the
    // view is back at the bottom.
    const document = new Container();
    document.addChild(headerLine);
    document.addChild(new Spacer());
    document.addChild(transcript);

    const composer = new VStack([loader, new Spacer(), editor, statusLine]);
    tui.setLayoutRoot(new VStack([
      {
        component: new ScrollView(document, {
          follow: "end",
          primary: true,
          overscroll: "chain",
        }),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      { component: composer, basis: "auto", shrink: 1, minSize: 2 },
    ]));
  } else {
    tui.addChild(headerLine);
    tui.addChild(new Spacer());
    tui.addChild(transcript);
    tui.addChild(loader);
    tui.addChild(new Spacer());
    tui.addChild(editor);
    tui.addChild(statusLine);
  }
  editor.onSubmit = (value: string) => {
    const text = value.trim();
    if (awaitingRename) {
      awaitingRename = false;
      // A command typed at the title prompt is a command, not a title.
      if (text.startsWith("/")) {
        void handleCommand(text);
        return;
      }
      if (text) void renameCurrentSession(text);
      return;
    }
    if (!text) return;
    if (agentDead || client.closed) {
      transcript.addChild(new Text(pc.red("⚠ goose acp is not running — press Esc to exit."), 1, 0));
      tui.requestRender();
      return;
    }
    if (setupFailed || !sessionId) {
      transcript.addChild(new Text(pc.red("⚠ No ACP session — press Esc to exit."), 1, 0));
      tui.requestRender();
      return;
    }
    if (text.startsWith("/")) {
      void handleCommand(text);
      return;
    }
    if (busy) return;
    void submitPrompt(text);
  };

  const finishTurn = (turnError?: string): void => {
    busy = false;
    cancelRequested = false;
    setLoader(null);
    // A cancelled turn may leave permission requests hanging — resolve them so
    // the agent→client calls do not stay unanswered and the overlay closes.
    cancelAllPermissions();
    closeUser();
    closeThought();
    closeMessage();
    // When the agent itself died, onAgentExit already explained why — do not
    // tell the same story again with the transport error.
    if (turnError && !agentDead) {
      transcript.addChild(new Text(pc.red(`⚠ ${turnError}`), 1, 0));
    }
    thoughtMd = null;
    thoughtBuffer = "";
    tui.requestRender();
  };

  // A turn may run for a long time, but not forever: the idle watchdog cancels
  // a silent agent, and the hard cap bounds the whole turn (./timeouts.ts).

  async function submitPrompt(text: string): Promise<void> {
    if (!sessionId || busy) return;
    busy = true;
    cancelRequested = false;
    lastAgentActivity = Date.now();
    transcript.addChild(new Text(pc.bold(`❯ ${text}`), 1, 0));
    currentMd = null;
    currentMessageId = null;
    streamBuffer = "";
    thoughtMd = null;
    thoughtBuffer = "";
    closeUser();
    toolLines.clear();
    setLoader("thinking…");
    editor.disableSubmit = true;
    try {
      const result = (await client.prompt(
        sessionId,
        [{ type: "text", text }],
        turnTimeout.ms,
      )) as PromptResponse;
      finishTurn(result.stopReason && result.stopReason !== "end_turn" && result.stopReason !== "cancelled"
        ? `turn ended: ${result.stopReason}`
        : undefined);
    } catch (error) {
      finishTurn(String((error as Error)?.message ?? error));
    } finally {
      editor.disableSubmit = false;
    }
  }

  tui.addInputListener((data: string): { consume?: boolean } | undefined => {
    // A permission prompt owns the keyboard entirely: Esc/Ctrl+C reject the tool
    // call. Without this, Esc exited the whole chat while the prompt was open.
    if (activePermission) return undefined;
    if (tui.hasOverlay()) {
      // A menu owns Esc (it closes the menu), but Ctrl+C stays the unconditional
      // "get me out" key, as it is everywhere else in the chat.
      if (matchesKey(data, Key.ctrl("c"))) {
        void shutdown();
        return { consume: true };
      }
      return undefined;
    }
    // Quick keys. Ctrl+M cannot be used for the model menu: a terminal sends
    // Enter as CR, which *is* Ctrl+M, so the binding would fire on every
    // submitted prompt — Ctrl+O is the free equivalent.
    if (matchesKey(data, Key.ctrl("p"))) {
      escArmedExit = false;
      showConfigMenu();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      escArmedExit = false;
      showModelMenu();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("e"))) {
      escArmedExit = false;
      void promptInEditor();
      return { consume: true };
    }
    const escape = matchesKey(data, Key.escape);
    const ctrlC = matchesKey(data, Key.ctrl("c"));
    if (!escape && !ctrlC) {
      // Any other key means the user is still typing — disarm the exit.
      escArmedExit = false;
      return undefined;
    }

    if (agentDead || client.closed) {
      void shutdown();
      return { consume: true };
    }
    // Esc aborts the pending title prompt instead of exiting the chat.
    if (awaitingRename) {
      awaitingRename = false;
      editor.setText("");
      transcript.addChild(new Text(pc.dim("Rename cancelled."), 1, 0));
      tui.requestRender();
      return { consume: true };
    }
    if (busy && sessionId) {
      client.cancel(sessionId);
      setLoader("cancelling…");
      return { consume: true };
    }
    if (ctrlC) {
      // Ctrl+C is the "just get me out" key: it always exits.
      void shutdown();
      return { consume: true };
    }
    // Esc with the autocomplete menu open belongs to the editor (it closes the
    // menu) — the draft must survive that.
    if (editor.capturesViewportInput) return undefined;
    // The editor does not handle Esc itself, so a non-empty draft used to make
    // Esc a dead key. Require a second Esc instead of silently doing nothing.
    if (editor.getText().length > 0 && !escArmedExit) {
      escArmedExit = true;
      if (!exitHintShown) {
        exitHintShown = true;
        transcript.addChild(new Text(
          pc.dim("Esc again to exit (the draft will be lost) · Ctrl+C exits right away"),
          1, 0,
        ));
        tui.requestRender();
      }
      return { consume: true };
    }
    void shutdown();
    return { consume: true };
  });

  // Idle watchdog: a long but *live* turn must not be interrupted, a silent one
  // must not leave the UI stuck with `busy` forever (the request itself has no
  // deadline until the hard cap).
  if (idleTimeout.ms > 0) {
    const checkEvery = Math.max(1_000, Math.min(30_000, Math.floor(idleTimeout.ms / 4)));
    const idleTimer = setInterval(() => {
      if (!busy || !sessionId || exiting || agentDead || cancelRequested) return;
      const silentFor = Date.now() - lastAgentActivity;
      if (silentFor < idleTimeout.ms) return;
      cancelRequested = true;
      transcript.addChild(new Text(
        pc.yellow(`⚠ no agent activity for ${Math.round(silentFor / 60_000)} min — cancelling the turn`),
        1, 0,
      ));
      setLoader("cancelling…");
      client.cancel(sessionId);
      tui.requestRender();
    }, checkEvery);
    // Never keep the process alive by itself: the chat owns the lifetime.
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  async function shutdown(): Promise<void> {
    if (exiting) return;
    exiting = true;
    // Do not leave the agent waiting for a permission answer.
    cancelAllPermissions();
    setLoader(null);
    try {
      await client.stop();
    } finally {
      tui.stop();
      // On the alternate screen tui.stop() prints the final transcript back to
      // the normal screen; give stdout a moment to drain before exiting so the
      // tail of it is not truncated.
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        try { process.stdout.write("", done); } catch { done(); }
        const timer = setTimeout(done, 500);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      process.exit(0);
    }
  }

  // The agent may die at any moment: stop accepting prompts and say why.
  onAgentExit = () => {
    if (exiting || agentDead) return;
    agentDead = true;
    busy = false;
    setLoader(null);
    cancelAllPermissions();
    transcript.addChild(new Text(pc.red("⚠ goose acp exited unexpectedly"), 1, 0));
    for (const line of stderrTail.slice(-5)) {
      transcript.addChild(new Text(pc.dim(line), 1, 0));
    }
    transcript.addChild(new Text(pc.dim("Press Esc to exit."), 1, 0));
    tui.requestRender();
  };

  tui.start();
  tui.setFocus(editor);
  renderHeader();
  renderStatus();
  for (const warning of timeoutWarnings) {
    transcript.addChild(new Text(pc.yellow(`⚠ ${warning}`), 1, 0));
  }
  transcript.addChild(new Text(
    pc.dim(
      "Type /config to change provider, model, set or session live · Ctrl+P config · Ctrl+O model · Ctrl+E $EDITOR · /rename, /fork, /edit",
    ),
    1, 0,
  ));
  tui.requestRender();

  // ─── Initialize + session setup ───────────────────────────────────────────

  try {
    await client.initialize({
      fs: { readTextFile: true, writeTextFile: true },
      _meta: { goose: { customNotifications: true } },
    });

    if (opts.isNew) {
      const response = await client.newSession({
        cwd: opts.cwd,
        // Kept as a safety net: goose ignores `mcpServers` only when it honours
        // `enabledExtensions`, so a version without that support still gets the
        // set's MCP servers (additively, like before).
        mcpServers,
        // goose reads these keys at the TOP level of `_meta` (a nested
        // `_meta.goose` object is only understood for initialize capabilities).
        // `client` also marks the session as user-created, which makes it
        // appear in `goose session list` and resolvable by `--name`.
        // `provider` is left out on purpose — see `./session-meta.ts`.
        _meta: newSessionMeta({
          sessionTitle: opts.sessionTitle,
          ...(exactSet ? { enabledExtensions: plan.extensions } : {}),
        }),
      });
      sessionId = response.sessionId;
      newSessionConfigOptions = response.configOptions;
      if (exactSet) {
        await verifySessionExtensions(sessionId);
      } else if (!opts.useDefaultProfile && plan.unsupported.length > 0) {
        transcript.addChild(new Text(
          pc.yellow(
            "⚠ This set has extensions with inline env values, which goose cannot load through ACP: " +
            "the default profile is loaded too, and those servers come from `mcpServers`.",
          ),
          1, 0,
        ));
      }
      tui.requestRender();
    } else {
      if (!opts.resumeSessionId) throw new Error("resume requires a session id");
      if (!client.supportsLoadSession()) {
        throw new Error("this goose version cannot resume via ACP (no loadSession capability)");
      }
      const loadResponse = await client.loadSession({
        cwd: opts.cwd,
        sessionId: opts.resumeSessionId,
        mcpServers: [],
      });
      // The resume response carries the session's live `configOptions`
      // (provider/model/mode/thinking_effort) — keep them so the configuration
      // menus work on a resumed session instead of coming up empty.
      newSessionConfigOptions = loadResponse?.configOptions;
      sessionId = opts.resumeSessionId;
      // Replay arrived as session/update notifications; close the last block so
      // the next turn starts fresh.
      closeUser();
      closeMessage();
      closeThought();
      // `session/load` restores the extension set stored in the session, so the
      // selected set would be ignored on resume. Reconcile it instead: the set
      // (or, for Default, the profile rebuilt from config.yaml) is the source
      // of truth (classic mode cannot do that — it drops the extension flags on
      // resume).
      if (exactSet || profilePlan) {
        await reconcileSessionExtensions(sessionId);
        if (profilePlan && profilePlan.unsupported.length > 0) {
          noteExtensionWarning(
            "the default profile has extensions ACP cannot load, so they were left untouched: " +
            profilePlan.unsupported.map((entry) => `${entry.name} (${entry.reason})`).join(", "),
          );
        }
      }
      tui.requestRender();
    }

    // The wizard's provider/model are the source of truth, exactly like classic
    // mode's `--provider`/`--model` on both new and resumed sessions. `session/new`
    // resolves them from GOOSE_PROVIDER/GOOSE_MODEL, but `session/load` keeps the
    // pair stored in the session row and ignores the env — so the model picked on
    // resume would be lost. Applying them through `session/set_config_option`
    // (the ACP-native switch goose itself uses) fixes both cases and is also what
    // makes `_meta.provider` unnecessary. Non-fatal by design: a session with a
    // different model is still usable, so problems surface as a warning.
    if (sessionId) {
      const outcome = await applySessionConfig(
        client,
        sessionId,
        { provider: opts.provider, model: opts.model },
        opts.isNew
          ? {
              provider: optionValue(newSessionConfigOptions, "provider"),
              model: optionValue(newSessionConfigOptions, "model"),
            }
          : {
              provider: opts.resumeConfig?.provider ?? undefined,
              model: opts.resumeConfig?.model ?? undefined,
            },
      );
      if (outcome.configOptions) newSessionConfigOptions = outcome.configOptions;
      if (outcome.warning) {
        transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
      } else if (outcome.applied.length > 0) {
        transcript.addChild(new Text(
          pc.dim(`⚙ Applied ${outcome.applied.map((s) => s.configId).join("+")} via ACP: ${outcome.provider}/${outcome.model}`),
          1, 0,
        ));
      }
      tui.requestRender();
    }

    // The set is the source of truth for the system prompt — same semantics as
    // classic mode's `--system`: apply the current set's prompt, or explicitly
    // clear any previously stored one when no set is selected. This is a
    // version-sensitive `_goose/unstable/*` method: failing to apply the
    // prompt must not kill an otherwise working session.
    if (sessionId) {
      try {
        await setSessionSystemPrompt(client, sessionId, {
          mode: "set",
          key: "cgoose",
          text: opts.set?.systemPrompt ?? "",
        });
      } catch (error) {
        transcript.addChild(new Text(
          pc.yellow(`⚠ System prompt not applied: ${String((error as Error)?.message ?? error)}`),
          1, 0,
        ));
      }
    }
    tui.requestRender();
  } catch (error) {
    setupFailed = true;
    transcript.addChild(new Text(
      pc.red(`⚠ ACP setup failed: ${String((error as Error)?.message ?? error)}`),
      1, 0,
    ));
    transcript.addChild(new Text(
      pc.dim("Chat is unavailable — press Esc to exit (use classic mode instead)."),
      1, 0,
    ));
    tui.requestRender();
  }

  // Keep the process alive until the user exits; shutdown() exits the process.
  await new Promise<void>(() => {});
}
