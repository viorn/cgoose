/**
 * chat-session.ts — session lifecycle management.
 *
 * Functions: setupSession, changeSet, changeSession, newSession,
 * forkCurrentSession, renameCurrentSession, promptRename.
 */

import pc from "picocolors";
import { Text } from "@earendil-works/pi-tui";
import { listSessionSets, DEFAULT_PROFILE_SENTINEL } from "../rossii-config";
import { getAllSessions } from "../sessions";
import { applySessionConfig, optionValue } from "./session-config";
import { newSessionMeta } from "./session-meta";
import { renameSession } from "./custom";
import {
  planForSet,
  applyExtensionPlan,
  applySystemPrompt,
  reconcileSessionExtensions,
  verifySessionExtensions,
  noteExtensionWarning,
  persistSelection,
} from "./chat-extensions";
import { closeThought, closeMessage, closeUser, closeToolBlocks, renderHeader, renderStatus } from "./chat-stream";
import type { ChatContext } from "./chat-context";
import type { AcpChatOptions } from "./chat-context";
import type { SessionSet } from "../rossii-config";

// ─── Session setup ───────────────────────────────────────────────────────────

export async function setupSession(
  ctx: ChatContext,
  opts: AcpChatOptions,
): Promise<void> {
  try {
    await ctx.client.initialize({
      fs: { readTextFile: true, writeTextFile: true },
      _meta: { goose: { customNotifications: true } },
    });

    if (opts.isNew) {
      await setupNewSession(ctx, opts);
    } else {
      await setupResumedSession(ctx, opts);
    }

    // Apply wizard's provider/model
    if (ctx.sessionId) {
      const outcome = await applySessionConfig(
        ctx.client,
        ctx.sessionId,
        { provider: opts.provider, model: opts.model },
        opts.isNew
          ? {
              provider: optionValue(ctx.newSessionConfigOptions, "provider"),
              model: optionValue(ctx.newSessionConfigOptions, "model"),
            }
          : {
              provider: opts.resumeConfig?.provider ?? undefined,
              model: opts.resumeConfig?.model ?? undefined,
            },
      );
      if (outcome.configOptions) ctx.newSessionConfigOptions = outcome.configOptions;
      if (outcome.warning) {
        ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
      } else if (outcome.applied.length > 0) {
        ctx.transcript.addChild(new Text(
          pc.dim(`⚙ Applied ${outcome.applied.map((s) => s.configId).join("+")} via ACP: ${outcome.provider}/${outcome.model}`),
          1, 0,
        ));
      }
      ctx.tui.requestRender();
    }

    // Apply system prompt
    if (ctx.sessionId) {
      try {
        await applySystemPrompt(ctx, ctx.sessionId, opts.set?.systemPrompt ?? "");
      } catch (error) {
        ctx.transcript.addChild(new Text(
          pc.yellow(`⚠ System prompt not applied: ${String((error as Error)?.message ?? error)}`),
          1, 0,
        ));
      }
    }
    ctx.tui.requestRender();
  } catch (error) {
    ctx.setupFailed = true;
    ctx.transcript.addChild(new Text(
      pc.red(`⚠ ACP setup failed: ${String((error as Error)?.message ?? error)}`),
      1, 0,
    ));
    ctx.transcript.addChild(new Text(
      pc.dim("Chat is unavailable — press Esc to exit (use classic mode instead)."),
      1, 0,
    ));
    ctx.tui.requestRender();
  }
}

async function setupNewSession(ctx: ChatContext, opts: AcpChatOptions): Promise<void> {
  const response = await ctx.client.newSession({
    cwd: opts.cwd,
    mcpServers: ctx.mcpServers,
    _meta: newSessionMeta({
      sessionTitle: opts.sessionTitle,
      ...(ctx.exactSet ? { enabledExtensions: ctx.plan.extensions } : {}),
    }),
  });
  ctx.sessionId = response.sessionId;
  ctx.newSessionConfigOptions = response.configOptions;
  if (ctx.exactSet) {
    await verifySessionExtensions(ctx, ctx.sessionId);
  } else if (!opts.useDefaultProfile && ctx.plan.unsupported.length > 0) {
    ctx.transcript.addChild(new Text(
      pc.yellow(
        "⚠ This set has extensions with inline env values, which goose cannot load through ACP: " +
        "the default profile is loaded too, and those servers come from `mcpServers`.",
      ),
      1, 0,
    ));
  }
  ctx.tui.requestRender();
}

async function setupResumedSession(ctx: ChatContext, opts: AcpChatOptions): Promise<void> {
  if (!opts.resumeSessionId) throw new Error("resume requires a session id");
  if (!ctx.client.supportsLoadSession()) {
    throw new Error("this goose version cannot resume via ACP (no loadSession capability)");
  }
  const loadResponse = await ctx.client.loadSession({
    cwd: opts.cwd,
    sessionId: opts.resumeSessionId,
    mcpServers: [],
  });
  ctx.newSessionConfigOptions = loadResponse?.configOptions;
  ctx.sessionId = opts.resumeSessionId;
  closeUser(ctx);
  closeMessage(ctx);
  closeThought(ctx);
  if (ctx.exactSet || ctx.profilePlan) {
    await reconcileSessionExtensions(ctx, ctx.sessionId);
    if (ctx.profilePlan && ctx.profilePlan.unsupported.length > 0) {
      noteExtensionWarning(ctx,
        "the default profile has extensions ACP cannot load, so they were left untouched: " +
        ctx.profilePlan.unsupported.map((entry) => `${entry.name} (${entry.reason})`).join(", "),
      );
    }
  }
  ctx.tui.requestRender();
}

// ─── Session commands ────────────────────────────────────────────────────────

export async function changeSet(ctx: ChatContext, setName: string | undefined): Promise<void> {
  if (!ctx.sessionId) return;
  if (ctx.busy) {
    ctx.transcript.addChild(new Text(pc.yellow("⚠ Cannot change the set while a turn is in progress."), 1, 0));
    ctx.tui.requestRender();
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
      ctx.transcript.addChild(new Text(pc.yellow(`⚠ Set "${setName}" not found.`), 1, 0));
      ctx.tui.requestRender();
      return;
    }
    useDefault = false;
    label = newSet.title;
  } else {
    ctx.transcript.addChild(new Text(pc.yellow("⚠ No set specified."), 1, 0));
    ctx.tui.requestRender();
    return;
  }

  // Resolve the new set before touching the session: a bad `extensions:` entry
  // must be reported, not half-applied.
  const next = planForSet(newSet, useDefault);
  for (const warning of next.warnings) noteExtensionWarning(ctx, warning);

  try {
    await applySystemPrompt(ctx, ctx.sessionId, newSet?.systemPrompt ?? "");
    ctx.transcript.addChild(new Text(
      pc.dim(
        `⚙ Set changed to ${label ?? "None"}${newSet?.systemPrompt ? " (system prompt applied)" : " (system prompt cleared)"}`,
      ),
      1, 0,
    ));
  } catch (error) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ System prompt not applied: ${String((error as Error)?.message ?? error)}`), 1, 0));
  }

  // The reconciliation below diffs against the *new* plan, so it must be the
  // active one first.
  applyExtensionPlan(ctx, next);
  await reconcileSessionExtensions(ctx, ctx.sessionId, "running session");
  if (next.profilePlan && next.profilePlan.unsupported.length > 0) {
    noteExtensionWarning(ctx,
      `cannot apply through ACP, left as-is: ${next.profilePlan.unsupported
        .map((entry) => `${entry.name} (${entry.reason})`)
        .join(", ")}`,
    );
  }

  ctx.currentSet = newSet;
  ctx.currentUseDefaultProfile = useDefault;
  ctx.currentSetLabel = useDefault ? "Default" : label;
  // `changeSet("none")` leaves `newSet` undefined, so the key is ""; "default"
  // is the sentinel; anything else is the set's name.
  ctx.currentSetKey = useDefault ? DEFAULT_PROFILE_SENTINEL : (newSet?.name ?? "");
  persistSelection(ctx);

  renderHeader(ctx);
  renderStatus(ctx);
  ctx.tui.requestRender();
}

export async function changeSession(ctx: ChatContext, sessionNameOrId: string): Promise<void> {
  if (!ctx.sessionId) return;
  if (ctx.busy) {
    ctx.transcript.addChild(new Text(pc.yellow("⚠ Cannot switch sessions while a turn is in progress."), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  const sessions = getAllSessions();
  const target = sessions.find((s) => s.id === sessionNameOrId || s.name === sessionNameOrId);
  if (!target) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ Session "${sessionNameOrId}" not found.`), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  try {
    const loaded = await ctx.client.loadSession({ cwd: ctx.cwd, sessionId: target.id, mcpServers: [] });
    ctx.sessionId = target.id;
    ctx.sessionTitle = target.name;
    // The replay may end on a thought or an assistant chunk; close those
    // blocks, or the last one stays "Thinking…" and never joins
    // `thoughtBlocks` (only the mouse could toggle it then). Replayed tool
    // calls are closed the same way — a resumed conversation must not show
    // them as still running.
    closeUser(ctx);
    closeMessage(ctx);
    closeThought(ctx);
    closeToolBlocks(ctx);
    if (loaded?.configOptions) ctx.newSessionConfigOptions = loaded.configOptions;
    ctx.transcript.addChild(new Text(pc.dim(`─── Switched to session: ${target.name} (${target.id}) ───`), 1, 0));
    // The wizard's provider/model pair survives the switch: applying it also
    // refreshes the config options for the menus.
    const outcome = await applySessionConfig(
      ctx.client,
      ctx.sessionId,
      { provider: ctx.currentProvider, model: ctx.currentModel },
      {},
    );
    if (outcome.configOptions) ctx.newSessionConfigOptions = outcome.configOptions;
    if (outcome.warning) {
      ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
    } else {
      ctx.currentProvider = outcome.provider ?? ctx.currentProvider;
      ctx.currentModel = outcome.model ?? ctx.currentModel;
    }
    // The set stays the source of truth: the target session's stored
    // extensions are brought in line with it, exactly like on resume.
    await reconcileSessionExtensions(ctx, ctx.sessionId, "switched session");
    renderHeader(ctx);
    renderStatus(ctx);
    ctx.tui.requestRender();
  } catch (error) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ Failed to switch session: ${String((error as Error)?.message ?? error)}`), 1, 0));
    ctx.tui.requestRender();
  }
}

export async function newSession(ctx: ChatContext): Promise<void> {
  if (ctx.busy) {
    ctx.transcript.addChild(new Text(pc.yellow("⚠ Cannot start a new session while a turn is in progress."), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  try {
    const response = await ctx.client.newSession({
      cwd: ctx.cwd,
      mcpServers: [],
      _meta: newSessionMeta({
        sessionTitle: "New Chat",
        ...(ctx.currentSet && !ctx.currentUseDefaultProfile ? { enabledExtensions: ctx.plan.extensions } : {}),
      }),
    });
    ctx.sessionId = response.sessionId;
    ctx.newSessionConfigOptions = response.configOptions;
    ctx.sessionTitle = "New Chat";
    ctx.transcript.addChild(new Text(pc.dim(`─── New session started: ${ctx.sessionId} ───`), 1, 0));
    await applySessionConfig(ctx.client, ctx.sessionId, { provider: ctx.currentProvider, model: ctx.currentModel }, {});
    await applySystemPrompt(ctx, ctx.sessionId, ctx.currentSet?.systemPrompt ?? "");
    renderHeader(ctx);
    renderStatus(ctx);
    ctx.tui.requestRender();
  } catch (error) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ Failed to create new session: ${String((error as Error)?.message ?? error)}`), 1, 0));
    ctx.tui.requestRender();
  }
}

/** `session/fork` copies the conversation into a new session; rossii then
 *  re-applies the current provider/model pair and reconciles the extensions
 *  against the current set, so the copy keeps the configuration on screen. */
export async function forkCurrentSession(ctx: ChatContext): Promise<void> {
  if (!ctx.sessionId) return;  if (ctx.busy) {
    ctx.transcript.addChild(new Text(pc.yellow("⚠ Cannot fork while a turn is in progress."), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  try {
    const previousTitle = ctx.sessionTitle;
    const response = await ctx.client.forkSession({ sessionId: ctx.sessionId, cwd: ctx.cwd, mcpServers: [] });
    ctx.sessionId = response.sessionId;
    if (response.configOptions) ctx.newSessionConfigOptions = response.configOptions;
    const title = `${previousTitle || "Session"} (fork)`;
    try {
      await renameSession(ctx.client, ctx.sessionId, title);
    } catch {
      // Purely cosmetic
    }
    ctx.sessionTitle = title;
    ctx.transcript.addChild(new Text(pc.dim(`─── Forked into a new session: ${title} (${ctx.sessionId}) ───`), 1, 0));
    const outcome = await applySessionConfig(
      ctx.client,
      ctx.sessionId,
      { provider: ctx.currentProvider, model: ctx.currentModel },
      {},
    );
    if (outcome.configOptions) ctx.newSessionConfigOptions = outcome.configOptions;
    if (outcome.warning) {
      ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
    } else {
      ctx.currentProvider = outcome.provider ?? ctx.currentProvider;
      ctx.currentModel = outcome.model ?? ctx.currentModel;
    }
    await reconcileSessionExtensions(ctx, ctx.sessionId, "forked session");
    renderHeader(ctx);
    renderStatus(ctx);
  } catch (error) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ Fork failed: ${String((error as Error)?.message ?? error)}`), 1, 0));
  }
  ctx.tui.requestRender();
}

export async function renameCurrentSession(ctx: ChatContext, title: string | undefined): Promise<void> {
  if (!ctx.sessionId) return;
  const next = title?.trim();
  if (!next) {
    ctx.transcript.addChild(new Text(pc.yellow("⚠ Usage: /session rename <title>"), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  try {
    await renameSession(ctx.client, ctx.sessionId, next);
    ctx.sessionTitle = next;
    ctx.transcript.addChild(new Text(pc.dim(`⚙ Session renamed to "${next}"`), 1, 0));
    renderHeader(ctx);
  } catch (error) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ Rename failed: ${String((error as Error)?.message ?? error)}`), 1, 0));
  }
  ctx.tui.requestRender();
}

/** Ask the composer for a title (`session/rename` needs free text). */
export function promptRename(ctx: ChatContext): void {
  if (!ctx.sessionId) return;
  ctx.awaitingRename = true;
  ctx.transcript.addChild(new Text(pc.dim("Type the new session title, Enter to apply (Esc to cancel)."), 1, 0));
  ctx.tui.setFocus(ctx.editor);
  ctx.tui.requestRender();
}
