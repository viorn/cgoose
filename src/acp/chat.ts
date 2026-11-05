/**
 * Chat TUI — rossii's own dialog renderer on top of @earendil-works/pi-tui.
 *
 * Talks to a spawned `goose acp` agent via AcpClient (JSON-RPC over stdio):
 *   initialize → session/new | session/load → session/prompt ⇄ session/update
 * Handles agent→client requests: session/request_permission (SelectList
 * overlay), fs/read_text_file, fs/write_text_file.
 *
 * This file is only the orchestrator: it spawns the agent, builds the shared
 * `ChatContext` (./chat-context.ts) and wires the modules together —
 *
 *   ./chat-ui.ts         the renderer: layout, composer, keyboard, watchdogs,
 *                        shutdown and the agent-exit handler
 *   ./chat-io.ts         prompt dispatch, steering, /edit, the turn lifecycle
 *   ./chat-stream.ts     session/update rendering, thought and tool blocks
 *   ./chat-session.ts    initialize + session/new | session/load, and the
 *                        /session commands (switch, new, rename, fork)
 *   ./chat-config.ts     /config menus (provider, model, set, session) and the
 *                        provider's own /v1/models fetch
 *   ./chat-extensions.ts the extension plan of the current set and its
 *                        reconciliation against a live session
 *   ./chat-handlers.ts   agent→client requests (permissions, fs)
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
 * `/config` menus — every one of them a searchable SelectList):
 *   /provider · /model → `session/set_config_option` (provider first, then model)
 *   /set               → system prompt + extension reconciliation in place
 *   /session           → switch (session/load), new, rename, fork
 *   /rename · /fork    → session title / `session/fork` copy
 *   /think             → expand/collapse thinking blocks (./thought.ts)
 *   /tool              → expand/collapse tool call blocks (./tool-call-block.ts)
 * Every switch re-applies the pair the wizard chose and reconciles extensions
 * against the selected set, so the set stays the single source of truth.
 */

import pc from "picocolors";

import { AcpClient } from "./client";
import { createChatContext } from "./chat-context";
import type { AcpChatOptions } from "./chat-context";
import { initExtensionPlan } from "./chat-extensions";
import { setPromptHandlers } from "./chat-handlers";
import { handleSessionUpdate } from "./chat-stream";
import { attachEditorSubmit } from "./chat-io";
import { setupSession } from "./chat-session";
import {
  attachAgentExit,
  attachInputListener,
  setupUi,
  startChat,
  startIdleWatchdog,
} from "./chat-ui";
import { env } from "../utils";

export type { AcpChatOptions };

export async function runAcpChat(opts: AcpChatOptions): Promise<void> {
  const ctx = createChatContext(opts);
  // The extension plan is state, not UI: build it before anything can render.
  initExtensionPlan(ctx, opts);

  // Keep the last stderr lines around so an agent crash can be explained.
  ctx.client = AcpClient.spawn({
    cwd: opts.cwd,
    env: opts.env,
    args: opts.agentBuiltins.length > 0
      ? ["--with-builtin", opts.agentBuiltins.join(",")]
      : [],
    onStderr: (line) => {
      ctx.stderrTail.push(line);
      if (ctx.stderrTail.length > 20) ctx.stderrTail.shift();
      if (env("DEBUG") === "1") {
        process.stderr.write(`${pc.dim(line)}\n`);
      }
    },
    onExit: (code) => ctx.onAgentExit(code),
  });
  ctx.client.onUpdate((notification) => handleSessionUpdate(ctx, notification));

  setupUi(ctx);
  // Registration only — the agent can ask for a permission or a file as soon
  // as it is initialized, which `setupSession` does below.
  setPromptHandlers(ctx);
  attachEditorSubmit(ctx);
  attachInputListener(ctx);
  startIdleWatchdog(ctx);
  attachAgentExit(ctx);
  startChat(ctx);

  await setupSession(ctx, opts);

  // Keep the process alive until the user exits; shutdown() exits the process.
  await new Promise<void>(() => {});
}
