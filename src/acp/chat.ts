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
 *   - stdio/http extensions → standard ACP `session/new.mcpServers`
 *   - system prompt → goose custom request `_goose/unstable/session/system-prompt/set`
 * On goose 1.57 the default profile is always loaded (`goose acp` has no
 * `--no-profile`), so set extensions are additive to it — the chat says so.
 * Two watchdogs bound a turn (idle + hard cap, see ./timeouts.ts).
 * On resume Goose restores the stored extension set; the *current* set's prompt
 * is re-applied (or explicitly cleared when no set).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pc from "picocolors";

import { buildMcpServers } from "./extensions";
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
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";

import { AcpClient } from "./client";
import { setSessionSystemPrompt } from "./custom";
import type { SessionSet } from "../cgoose-config";
import type {
  PromptResponse,
  RequestPermissionResponse,
  SessionNotification,
} from "./types";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface AcpChatOptions {
  cwd: string;
  env: Record<string, string>;
  isNew: boolean;
  /** On resume: goose session id (same ids as `goose session list`). */
  resumeSessionId?: string;
  /** Session title for session/new (`_meta.goose.sessionTitle`). */
  sessionTitle?: string;
  provider: string;
  model: string;
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
  // streaming updates never drag the view back to the bottom. The header and
  // the composer stay pinned. On exit pi-tui prints the final transcript to
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
  let sessionTitle: string | undefined = opts.sessionTitle;

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
    const header = new Text(pc.bold(`⚡ ${title}`), 1, 0);
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
    const box = new Container();
    box.addChild(header);
    box.addChild(list);
    tui.showOverlay(box, { width: 72 });
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
    statusLine.setText([pc.dim(`${opts.provider}/${opts.model}`), usagePart ? pc.dim(usagePart) : ""]
      .filter(Boolean)
      .join(pc.dim("  ")));
    tui.requestRender();
  };
  const renderHeader = (): void => {
    const title = sessionTitle ? `  ${pc.dim(`· ${sessionTitle}`)}` : "";
    headerLine.setText(
      `${pc.green("🪿 cgoose chat")}  ${pc.dim(`${opts.provider}/${opts.model}  ${opts.cwd}`)}${title}`,
    );
    tui.requestRender();
  };

  // ─── UI ───────────────────────────────────────────────────────────────────

  const setLabel = opts.set?.title ?? (opts.useDefaultProfile ? "Default (goose config.yaml)" : undefined);

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
    // Header pinned on top, composer pinned at the bottom, transcript scrolls
    // in between with `follow: "end"` (auto-follow stops as soon as the user
    // scrolls up and resumes at the bottom).
    const header = new VStack([
      headerLine,
      ...(setLabel !== undefined ? [new Text(pc.dim(`set: ${setLabel}`), 1, 0)] : []),
    ]);
    const composer = new VStack([loader, new Spacer(), editor, statusLine]);
    tui.setLayoutRoot(new VStack([
      { component: header, basis: "auto", shrink: 0 },
      {
        component: new ScrollView(transcript, {
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
    if (setLabel !== undefined) {
      tui.addChild(new Text(pc.dim(`set: ${setLabel}`), 1, 0));
    }
    tui.addChild(new Spacer());
    tui.addChild(transcript);
    tui.addChild(loader);
    tui.addChild(new Spacer());
    tui.addChild(editor);
    tui.addChild(statusLine);
  }
  editor.onSubmit = (value: string) => {
    const text = value.trim();
    if (!text || busy) return;
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
    // While the permission overlay is open, Esc/Ctrl+C belong to the SelectList
    // (reject this tool call) — do not intercept them here.
    if (activePermission) return undefined;
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
        mcpServers: buildMcpServers({
          stdio: opts.stdioExtensionSpecs,
          http: opts.httpExtensionUris,
        }),
        _meta: {
          goose: {
            client: "cgoose",
            sessionTitle: opts.sessionTitle,
            provider: opts.provider,
          },
        },
      });
      sessionId = response.sessionId;
      // goose 1.57 has no `--no-profile` for `goose acp` and ignores
      // `_meta.goose.enabledExtensions`, so the default profile is always
      // loaded: a set's extensions are added on top of it, not instead of it.
      if (!opts.useDefaultProfile) {
        transcript.addChild(new Text(
          pc.yellow("⚠ This goose version always loads the default profile in chat mode: set extensions are added on top of it."),
          1, 0,
        ));
      }
    } else {
      if (!opts.resumeSessionId) throw new Error("resume requires a session id");
      if (!client.supportsLoadSession()) {
        throw new Error("this goose version cannot resume via ACP (no loadSession capability)");
      }
      await client.loadSession({
        cwd: opts.cwd,
        sessionId: opts.resumeSessionId,
        mcpServers: [],
      });
      sessionId = opts.resumeSessionId;
      // Replay arrived as session/update notifications; close the last block so
      // the next turn starts fresh.
      closeUser();
      closeMessage();
      closeThought();
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
