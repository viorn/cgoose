/**
 * chat-stream.ts — streaming state and session update rendering.
 *
 * Functions: closeThought, closeToolBlocks, closeUser, closeMessage,
 * flushStream, flushThought, markSteerQueued, takeSteer, dropSteer,
 * handleSessionUpdate, renderHeader, renderStatus, toggleAllThoughts,
 * toggleAllTools.
 */

import pc from "picocolors";
import { Container, Text, Markdown } from "@earendil-works/pi-tui";
import { activeRunIdFromMeta, queuedSteerIdFromMeta, steerChunkId } from "./steer";
import { ThoughtBlock } from "./thought";
import { parseThoughtCommand } from "./thought";
import { ToolCallBlock } from "./tool-call-block";
import { parseToolCommand } from "./tool-call-block";
import { toolCallPayload, toolDetailFromRawInput } from "./tool-call-content";
import { parseAvailableCommands } from "./slash-commands";
import { answerLabel, formatCost, markdownTheme } from "./chat-context";
import type { ChatContext } from "./chat-context";
import type { SessionNotification } from "./types";

// ─── Close helpers ───────────────────────────────────────────────────────────

/** Close the current thought block so the next burst renders separately. */
export function closeThought(ctx: ChatContext): void {
  if (ctx.currentThought) {
    ctx.currentThought.setFinished();
    ctx.thoughtBlocks.push(ctx.currentThought);
    ctx.currentThought = null;
  }
}

/**
 * Close every tool block that is still live. A cancelled turn, a dead agent
 * or a replayed history must not leave a block stuck at "in progress".
 */
export function closeToolBlocks(ctx: ChatContext): void {
  for (const block of ctx.toolCallBlocks.values()) {
    if (!block.isFinished) block.setFinished();
  }
}
/** Close the replayed user message block (chunks of one message are merged). */
export function closeUser(ctx: ChatContext): void {
  ctx.userLine = null;
  ctx.userBuffer = "";
  ctx.userMessageId = null;
}

/** Close the current agent message block (a tool call splits the answer). */
export function closeMessage(ctx: ChatContext): void {
  if (ctx.currentMd) {
    flushStream(ctx, true);
    ctx.currentMd = null;
    ctx.streamBuffer = "";
  }
  ctx.answerLabelLine = null;
  ctx.answerChars = 0;
  ctx.currentMessageId = null;
}

// ─── Throttle ────────────────────────────────────────────────────────────────

let lastFlush = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function flushStream(ctx: ChatContext, force = false): void {
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
        flushStream(ctx, true);
      }, 50);
    }
    return;
  }
  lastFlush = now;
  if (ctx.currentMd) {
    ctx.currentMd.setText(ctx.streamBuffer || "…");
    ctx.tui.requestRender();
  }
}

/**
 * Repaint a streaming thought inside the same 50 ms window as the text: the
 * block already holds its live markdown, so only the frame is throttled.
 */
export function flushThought(ctx: ChatContext): void {
  const now = Date.now();
  if (now - lastFlush < 50) {
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        // Covers both cases: with a text block in flight this refreshes it,
        // thought-only bursts still need the paint.
        flushStream(ctx, true);
        ctx.tui.requestRender();
      }, 50);
    }
    return;
  }
  lastFlush = now;
  ctx.tui.requestRender();
}

// ─── Steering helpers ────────────────────────────────────────────────────────

/** goose acked the queueing — flip the provisional line's wording. */
export function markSteerQueued(ctx: ChatContext, messageId: string): void {
  ctx.steerAckIds.add(messageId);
  const entry = ctx.steerEntries.find((candidate) => candidate.messageId === messageId);
  if (!entry || entry.acked) return;
  entry.acked = true;
  entry.line.setText(pc.dim(`⤴ steer queued: ${entry.text}`));
  ctx.tui.requestRender();
}

/** Hand the entry the delivered chunk belongs to back to the caller. */
export function takeSteer(ctx: ChatContext, messageId: string): (typeof ctx.steerEntries)[number] | null {
  const index = ctx.steerEntries.findIndex((entry) => entry.messageId === messageId);
  if (index === -1) return null;
  ctx.steerAckIds.delete(messageId);
  return ctx.steerEntries.splice(index, 1)[0];
}

/** Forget a steer that will not be delivered and take its line down. */
export function dropSteer(ctx: ChatContext, entry: (typeof ctx.steerEntries)[number]): void {
  const index = ctx.steerEntries.indexOf(entry);
  if (index !== -1) ctx.steerEntries.splice(index, 1);
  if (entry.messageId) ctx.steerAckIds.delete(entry.messageId);
  ctx.transcript.removeChild(entry.line);
  ctx.tui.requestRender();
}

// ─── Status / header ─────────────────────────────────────────────────────────

let usagePart = "";

// Status line: provider/model + token usage (kept as parts so usage updates
// never wipe the model info).
export function renderStatus(ctx: ChatContext): void {
  // The set decides the system prompt and the extension list, so its short
  // label sits with the pair it applies to (the header carries the long form).
  const setPart = ctx.currentSetLabel ? `set: ${ctx.currentSetLabel}` : "";
  ctx.statusLine.setText(
    [
      pc.dim(`${ctx.currentProvider}/${ctx.currentModel}`),
      setPart ? pc.dim(setPart) : "",
      usagePart ? pc.dim(usagePart) : "",
    ]
      .filter(Boolean)
      .join(pc.dim("  ")),
  );
  ctx.tui.requestRender();
}

export function renderHeader(ctx: ChatContext): void {
  const title = ctx.sessionTitle ? `  ${pc.dim(`· ${ctx.sessionTitle}`)}` : "";
  const setText = ctx.currentSetLabel ? `  ${pc.dim(`· set: ${ctx.currentSetLabel}`)}` : "";
  ctx.headerLine.setText(
    `${pc.green("🪿 rossii chat")}  ${pc.dim(`${ctx.currentProvider}/${ctx.currentModel}  ${ctx.cwd}`)}${title}${setText}`,
  );
  ctx.tui.requestRender();
}

// ─── Session update ──────────────────────────────────────────────────────────

export function handleSessionUpdate(ctx: ChatContext, notification: SessionNotification): void {
  // Any agent update counts as progress: the idle watchdog is reset.
  ctx.lastAgentActivity = Date.now();
  const update = notification.update as any;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (update.content?.type === "text") {
        closeUser(ctx);
        closeThought(ctx);
        // A new messageId means a new message (history replay relies on it).
        const messageId = typeof update.messageId === "string" ? update.messageId : null;
        if (messageId && messageId !== ctx.currentMessageId) closeMessage(ctx);
        if (messageId) ctx.currentMessageId = messageId;
        if (!ctx.currentMd) {
          // The label rides above the markdown in the same container, so the
          // streaming block reports its size live (`❮ Answer · N chars`),
          // exactly like the thought bar.
          const container = new Container();
          ctx.answerLabelLine = new Text(answerLabel(0), 1, 0);
          container.addChild(ctx.answerLabelLine);
          ctx.currentMd = new Markdown("", 1, 0, markdownTheme);
          container.addChild(ctx.currentMd);
          ctx.transcript.addChild(container);
          ctx.answerChars = 0;
        }
        ctx.streamBuffer += update.content.text;
        // Counted per chunk (`[...s].length` per update): recounting the whole
        // buffer on every chunk would make a long answer quadratic.
        ctx.answerChars += [...update.content.text].length;
        ctx.answerLabelLine?.setText(answerLabel(ctx.answerChars));
        flushStream(ctx);
      }
      break;
    }
    case "user_message_chunk": {
      if (update.content?.type === "text") {
        // A steer that the running turn picked up is a *live* user message:
        // it must be rendered even though `busy` is true (the replay guard
        // below would swallow it). It takes the provisional line's place.
        const sId = steerChunkId(update);
        if (sId) {
          const entry = takeSteer(ctx, sId);
          if (entry) ctx.transcript.removeChild(entry.line);
        } else if (ctx.busy) break;
        // A live turn already echoed the prompt locally; replay
        // (session/load) arrives while idle and must be rendered. Chunks of
        // one message are merged into a single line.
        closeThought(ctx);
        closeMessage(ctx);
        const messageId = sId ?? (typeof update.messageId === "string" ? update.messageId : null);
        if (ctx.userLine && messageId && ctx.userMessageId && messageId !== ctx.userMessageId) {
          closeUser(ctx);
        }
        if (!ctx.userLine) {
          ctx.userLine = new Text("", 1, 0);
          ctx.transcript.addChild(ctx.userLine);
          ctx.userBuffer = "";
          ctx.userMessageId = messageId;
        }
        ctx.userBuffer += update.content.text;
        ctx.userLine.setText(pc.bold(`❯ ${ctx.userBuffer}`));
        ctx.tui.requestRender();
      }
      break;
    }
    case "agent_thought_chunk": {
      if (update.content?.type === "text") {
        if (!ctx.currentThought) {
          ctx.currentThought = new ThoughtBlock({
            onToggle: () => ctx.tui.requestRender(),
            // Only the alternate screen captures the mouse; on the main screen
            // the bar points at `/think` instead of promising a click.
            clickable: ctx.altScreen,
          });
          ctx.transcript.addChild(ctx.currentThought);
        }
        ctx.currentThought.append(update.content.text);
        flushThought(ctx);
      }
      break;
    }
    case "tool_call":
    case "tool_call_update": {
      closeUser(ctx);
      closeThought(ctx);
      closeMessage(ctx);
      const existing = ctx.toolCallBlocks.get(update.toolCallId);
      // Merge with the stored status: a partial `tool_call_update` without a
      // status must not demote an already finished block back to "in progress".
      const status = update.status ?? existing?.status ?? "";
      const title = update.title ?? existing?.title ?? update.toolCallId;
      const block = existing ?? new ToolCallBlock({
        onToggle: () => ctx.tui.requestRender(),
        // Only the alternate screen captures the mouse; on the main screen the
        // bar points at `/tool` instead of promising a click.
        clickable: ctx.altScreen,
      });
      if (!existing) {
        ctx.toolCallBlocks.set(update.toolCallId, block);
        ctx.toolBlocks.push(block);
        ctx.transcript.addChild(block);
      }
      block.setTitle(title);
      block.setStatus(status);
      // The full command: goose truncates its own title to 57 characters.
      block.setDetail(toolDetailFromRawInput(update.rawInput));
      // Live output arrives on its own channel (`_meta.toolNotification`), the
      // final `content` restates the whole output — so it replaces the buffer.
      const payload = toolCallPayload(update);
      if (payload.replace !== undefined) block.setContent(payload.replace);
      if (payload.append !== undefined) block.appendContent(payload.append);
      if (status === "completed" || status === "failed") block.setFinished();
      ctx.tui.requestRender();
      break;
    }
    case "available_commands_update": {
      // goose's own slash commands (`compact`, `clear`, `status`, … plus the
      // ones it builds from recipes and skills), sent right after session/new,
      // session/load and fork. Kept for `/help`; `/…` routing does not depend on
      // it (see ./slash-commands.ts).
      ctx.gooseCommands = parseAvailableCommands(update.availableCommands);
      break;
    }
    case "config_option_update": {
      // goose restates the whole option set — model list included — at session
      // setup and again when a provider switch's background inventory refresh
      // finishes (its `plan_refresh_jobs` fetch is async, so the synchronous
      // `set_config_option` response carries the OLD list). Dropping this update
      // left the model menu showing whatever the last response happened to say.
      // The current pair is left alone: `changeModel`/`changeProvider` own it.
      const options = update.configOptions;
      if (Array.isArray(options)) ctx.newSessionConfigOptions = options;
      break;
    }
    case "usage_update": {
      usagePart = `tokens ${update.used}/${update.size}${formatCost(update.cost)}`;
      renderStatus(ctx);
      break;
    }
    case "session_info_update": {
      if (typeof update.title === "string" && update.title) {
        ctx.sessionTitle = update.title;
        renderHeader(ctx);
      }
      const run = activeRunIdFromMeta(update._meta);
      // Steering rides on this update: the run id while a turn is live (null
      // when it ends) and the ack of a queued steer (see ./steer.ts).
      if (run !== undefined) ctx.activeRunId = run;
      const ackedId = queuedSteerIdFromMeta(update._meta);
      if (ackedId) markSteerQueued(ctx, ackedId);
      break;
    }
    default:
      break;
  }
}

// ─── Toggle helpers ──────────────────────────────────────────────────────────

export function toggleAllThoughts(ctx: ChatContext, args: string[]): void {
  const command = parseThoughtCommand(args);
  if (!command) {
    ctx.transcript.addChild(new Text(
      pc.yellow("⚠ Usage: /think [toggle|expand|collapse] [all]"),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
    // The list outlives a turn: `/think` reaches the whole conversation, not
    // just the block that happens to be streaming right now. A live block is
    // not in the list yet (`closeThought` adds it on finish), so it is spliced
    // in as the most recent one.
    const blocks = ctx.currentThought ? [...ctx.thoughtBlocks, ctx.currentThought] : ctx.thoughtBlocks;
  if (blocks.length === 0) {
    ctx.transcript.addChild(new Text(pc.dim("No thoughts in this conversation yet."), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  const targets = command.all ? blocks : [blocks[blocks.length - 1]];
  for (const block of targets) {
    if (command.action === "expand") block.setExpanded(true);
    else if (command.action === "collapse") block.setExpanded(false);
    else block.toggle();
  }
  ctx.tui.requestRender();
}

export function toggleAllTools(ctx: ChatContext, args: string[]): void {
  const command = parseToolCommand(args);
  if (!command) {
    ctx.transcript.addChild(new Text(
      pc.yellow("⚠ Usage: /tool [toggle|expand|collapse] [all]"),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
  const blocks = ctx.toolBlocks;
  if (blocks.length === 0) {
    ctx.transcript.addChild(new Text(pc.dim("No tool calls in this conversation yet."), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  const targets = command.all ? blocks : [blocks[blocks.length - 1]];
  for (const block of targets) {
    if (command.action === "expand") block.setExpanded(true);
    else if (command.action === "collapse") block.setExpanded(false);
    else block.toggle();
  }
  ctx.tui.requestRender();
}