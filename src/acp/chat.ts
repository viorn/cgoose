/**
 * Chat TUI — cgoose's own dialog renderer on top of @earendil-works/pi-tui.
 *
 * Talks to a spawned `goose acp` agent via AcpClient (JSON-RPC over stdio):
 *   initialize → session/new | session/load → session/prompt ⇄ session/update
 * Handles agent→client requests: session/request_permission (SelectList
 * overlay), fs/read_text_file, fs/write_text_file.
 *
 * Session sets are applied on session creation:
 *   - extensions → `_meta.goose.enabledExtensions` (builtin/platform/mcp entries)
 *   - system prompt → goose custom request `_goose/unstable/session/system-prompt/set`
 * On resume Goose restores the stored extension set (same as classic mode);
 * the *current* set's prompt is re-applied (or explicitly cleared when no set).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pc from "picocolors";
import {
  Container,
  Editor,
  Key,
  Loader,
  Markdown,
  ProcessTerminal,
  SelectList,
  Spacer,
  Text,
  TuiMainScreen,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";

import { AcpClient } from "./client";
import { setSessionSystemPrompt } from "./custom";
import type { SessionSet } from "../cgoose-config";
import type {
  GooseExtension,
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
  /** Raw stdio extension specs (`name:ENV=val cmd args...`) from the set. */
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

// ─── Extension mapping (cgoose set → ACP `_meta.goose.enabledExtensions`) ────

/**
 * Parse a goose stdio spec `name:ENV=val cmd args...` (same format as
 * `goose session --with-extension`). Leading `KEY=value` tokens are env vars.
 */
function parseStdioSpec(spec: string): GooseExtension | null {
  const colonIdx = spec.indexOf(":");
  if (colonIdx === -1) return null;
  const name = spec.slice(0, colonIdx);
  const tokens = spec.slice(colonIdx + 1).trim().split(/\s+/).filter(Boolean);
  const env: { name: string; value: string }[] = [];
  let i = 0;
  while (i < tokens.length && /^\w+=/.test(tokens[i])) {
    const eq = tokens[i].indexOf("=");
    env.push({ name: tokens[i].slice(0, eq), value: tokens[i].slice(eq + 1) });
    i++;
  }
  if (i >= tokens.length) return null;
  return {
    type: "mcp",
    server: { type: "stdio", name, command: tokens[i], args: tokens.slice(i + 1), env },
  };
}

/** Parse a goose streamable-http spec `url timeout=N` into an MCP http server. */
function parseHttpSpec(spec: string): GooseExtension | null {
  const url = spec.trim().split(/\s+/)[0];
  if (!url) return null;
  const name = url.replace(/^\w+:\/\//, "").replace(/[^a-zA-Z0-9._-]/g, "-");
  return { type: "mcp", server: { type: "http", name, url } };
}

function buildEnabledExtensions(opts: AcpChatOptions): GooseExtension[] | undefined {
  // No set:
  //  - Default (`__default__`) → undefined → goose loads its default profile
  //  - None ("") → [] → ask for a session with no extensions
  // Note: goose 1.57 ignores this field (verified via acp-client-smoke); kept
  // for newer goose versions where it replaces the default profile.
  if (!opts.set) return opts.useDefaultProfile ? undefined : [];
  const result: GooseExtension[] = [];
  for (const name of opts.agentBuiltins) {
    result.push({ type: "builtin", name });
  }
  for (const spec of opts.stdioExtensionSpecs) {
    const ext = parseStdioSpec(spec);
    if (ext) result.push(ext);
  }
  for (const spec of opts.httpExtensionUris) {
    const ext = parseHttpSpec(spec);
    if (ext) result.push(ext);
  }
  return result;
}

/** MCP servers for the standard ACP `session/new.mcpServers` field — the one
 *  channel verified to work on goose 1.57 for stdio/http extensions. */
function buildMcpServers(opts: AcpChatOptions): unknown[] {
  const servers: unknown[] = [];
  for (const spec of opts.stdioExtensionSpecs) {
    const ext = parseStdioSpec(spec);
    if (ext?.type === "mcp") servers.push(ext.server);
  }
  for (const spec of opts.httpExtensionUris) {
    const ext = parseHttpSpec(spec);
    if (ext?.type === "mcp") servers.push(ext.server);
  }
  return servers;
}

// ─── Chat session ────────────────────────────────────────────────────────────

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

export async function runAcpChat(opts: AcpChatOptions): Promise<void> {
  // Keep the last stderr lines around so an agent crash can be explained.
  const stderrTail: string[] = [];
  let setupFailed = false;

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
    onExit: () => {
      // Called from the transport; guard against use before UI exists.
      if (!tui || exiting) return;
      busy = false;
      loader.stop();
      transcript.addChild(new Text(pc.red("⚠ goose acp exited unexpectedly"), 1, 0));
      for (const line of stderrTail.slice(-5)) {
        transcript.addChild(new Text(pc.dim(line), 1, 0));
      }
      tui.requestRender();
    },
  });

  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiMainScreen(terminal);

  const transcript = new Container();
  const statusLine = new Text("", 0, 0);
  let currentMd: Markdown | null = null;
  let streamBuffer = "";
  let thoughtMd: Markdown | null = null;
  let thoughtBuffer = "";
  const toolLines = new Map<string, ToolLine>();
  let busy = false;
  let exiting = false;
  let lastFlush = 0;
  let sessionId: string | null = null;

  // ─── Agent → client handlers ──────────────────────────────────────────────

  // Pending permission bookkeeping: Esc must go to the SelectList while the
  // overlay is open, and a turn end/cancel must resolve a hanging request.
  let permissionActive = false;
  let cancelPendingPermission: (() => void) | null = null;

  client.setPromptHandlers({
    requestPermission: (params) => new Promise<RequestPermissionResponse>((resolve) => {
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
      permissionActive = true;
      const finish = (response: RequestPermissionResponse): void => {
        permissionActive = false;
        cancelPendingPermission = null;
        tui.hideOverlay();
        tui.setFocus(editor);
        resolve(response);
      };
      cancelPendingPermission = () => finish({ outcome: { outcome: "cancelled" } });
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
    }),

    readTextFile: async (params) => {
      const content = await readFile(params.path as string, "utf-8");
      return { content };
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
      thoughtMd = null;
      thoughtBuffer = "";
    }
  };

  const flushStream = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastFlush < 50) return;
    lastFlush = now;
    if (currentMd) {
      currentMd.setText(streamBuffer || "…");
      tui.requestRender();
    }
    if (thoughtMd) {
      thoughtMd.setText(thoughtBuffer);
    }
  };

  client.onUpdate((notification: SessionNotification) => {
    const update = notification.update as any;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content?.type === "text") {
          closeThought();
          if (!currentMd) {
            currentMd = new Markdown("", 1, 0, markdownTheme);
            transcript.addChild(currentMd);
          }
          streamBuffer += update.content.text;
          flushStream();
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
        closeThought();
        const existing = toolLines.get(update.toolCallId);
        const icon = STATUS_ICON[update.status ?? ""] ?? "🔨";
        const title = update.title ?? existing?.title ?? update.toolCallId;
        const line = `${icon} ${title}`;
        if (existing) {
          existing.title = title;
          existing.status = update.status ?? existing.status;
          existing.component.setText(line);
        } else {
          const comp = new Text(line, 1, 0);
          toolLines.set(update.toolCallId, { component: comp, title, status: update.status ?? "" });
          transcript.addChild(comp);
        }
        tui.requestRender();
        break;
      }
      case "usage_update": {
        const cost = update.cost?.total ?? update.cost?.totalCost;
        const costStr = typeof cost === "number" ? ` · $${cost.toFixed(4)}` : "";
        statusLine.setText(
          pc.dim(`tokens ${update.used}/${update.size}${costStr}`),
        );
        tui.requestRender();
        break;
      }
      case "session_info_update": {
        if (update.title) statusLine.setText(pc.dim(update.title));
        tui.requestRender();
        break;
      }
      default:
        break;
    }
  });

  // ─── UI ───────────────────────────────────────────────────────────────────

  tui.addChild(new Text(
    `${pc.green("🪿 cgoose chat")}  ${pc.dim(`${opts.provider}/${opts.model}  ${opts.cwd}`)}`,
    1,
    0,
  ));
  const setLabel = opts.set?.title ?? (opts.useDefaultProfile ? "Default (goose config.yaml)" : undefined);
  if (setLabel !== undefined) {
    tui.addChild(new Text(pc.dim(`set: ${setLabel}`), 1, 0));
  }
  tui.addChild(new Spacer());
  tui.addChild(transcript);
  tui.addChild(new Spacer());

  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  tui.addChild(editor);
  tui.addChild(statusLine);
  editor.onSubmit = (value: string) => {
    const text = value.trim();
    if (!text || busy) return;
    if (setupFailed || !sessionId) {
      transcript.addChild(new Text(pc.red("⚠ No ACP session — press Esc to exit."), 1, 0));
      tui.requestRender();
      return;
    }
    void submitPrompt(text);
  };

  const finishTurn = (turnError?: string): void => {
    busy = false;
    loader.stop();
    // A cancelled turn may leave a permission request hanging — resolve it so
    // the agent→client call does not stay unanswered and the overlay closes.
    if (permissionActive) cancelPendingPermission?.();
    if (currentMd) flushStream(true);
    else if (turnError) {
      transcript.addChild(new Text(pc.red(`⚠ ${turnError}`), 1, 0));
    }
    // Reset per-turn buffers; rendered tool lines stay in the transcript
    currentMd = null;
    streamBuffer = "";
    thoughtMd = null;
    thoughtBuffer = "";
    toolLines.clear();
    tui.requestRender();
  };

  const loader = new Loader(tui, (s) => pc.cyan(s), (s) => pc.dim(s), "thinking…");

  async function submitPrompt(text: string): Promise<void> {
    if (!sessionId || busy) return;
    busy = true;
    transcript.addChild(new Text(pc.bold(`❯ ${text}`), 1, 0));
    currentMd = null;
    streamBuffer = "";
    thoughtMd = null;
    thoughtBuffer = "";
    loader.setMessage("thinking…");
    loader.start();
    editor.disableSubmit = true;
    try {
      const result = (await client.prompt(sessionId, [{ type: "text", text }])) as PromptResponse;
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
    if (permissionActive) return undefined;
    if (matchesKey(data, Key.escape)) {
      if (busy && sessionId) {
        client.cancel(sessionId);
        loader.setMessage("cancelling…");
      } else if (!busy) {
        void shutdown();
      }
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (busy && sessionId) {
        client.cancel(sessionId);
        loader.setMessage("cancelling…");
      } else {
        void shutdown();
      }
      return { consume: true };
    }
    return undefined;
  });

  async function shutdown(): Promise<void> {
    if (exiting) return;
    exiting = true;
    try {
      await client.stop();
    } finally {
      tui.stop();
      process.exit(0);
    }
  }

  tui.start();
  tui.setFocus(editor);

  // ─── Initialize + session setup ───────────────────────────────────────────

  try {
    await client.initialize({
      fs: { readTextFile: true, writeTextFile: true },
      _meta: { goose: { customNotifications: true } },
    });

    const enabledExtensions = buildEnabledExtensions(opts);
    if (opts.isNew) {
      const response = await client.newSession({
        cwd: opts.cwd,
        mcpServers: buildMcpServers(opts),
        _meta: {
          goose: {
            client: "cgoose",
            sessionTitle: opts.sessionTitle,
            provider: opts.provider,
            enabledExtensions,
          },
        },
      });
      sessionId = response.sessionId;
      // goose 1.57 loads the default profile regardless of `enabledExtensions`
      // (verified via acp-client-smoke), so "None" cannot hide profile
      // extensions on this version — be honest about it.
      if (!opts.useDefaultProfile && !opts.set && opts.agentBuiltins.length === 0) {
        transcript.addChild(new Text(
          pc.yellow("⚠ None set: this goose version still loads the default profile extensions in chat mode."),
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
    }

    // The set is the source of truth for the system prompt — same semantics as
    // classic mode's `--system`: apply the current set's prompt, or explicitly
    // clear any previously stored one when no set is selected.
    if (sessionId) {
      await setSessionSystemPrompt(client, sessionId, {
        mode: "set",
        key: "cgoose",
        text: opts.set?.systemPrompt ?? "",
      });
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
