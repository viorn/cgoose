/**
 * chat-io.ts — user input handling: editor, prompt dispatch, steering,
 * external editor, turn lifecycle.
 *
 * Functions: attachEditorSubmit (the composer's Enter), promptInEditor,
 * externalEditorCommand, dispatchPrompt, submitPrompt, submitSteer, queuePrompt,
 * restoreDraft, abandonPendingSteers, finishTurn, setLoader, steerHint.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { Text } from "@earendil-works/pi-tui";
import { planSteer, classifySteerError } from "./steer";
import {
  closeThought,
  closeMessage,
  closeUser,
  closeToolBlocks,
  dropSteer,
  markSteerQueued,
} from "./chat-stream";
import { cancelAllPermissions } from "./chat-handlers";
import { handleCommand } from "./chat-config";
import { renameCurrentSession } from "./chat-session";
import { steerSession } from "./custom";
import type { ChatContext, PendingSteer } from "./chat-context";
import type { PromptResponse } from "./types";

// ─── External editor ─────────────────────────────────────────────────────────

export function externalEditorCommand(ctx: ChatContext): string {
  return ctx.externalEditorCommand();
}

/**
 * Compose the prompt in an external editor and send it on save.
 */
export async function promptInEditor(ctx: ChatContext): Promise<void> {
  if (!ctx.sessionId) return;
  const command = externalEditorCommand(ctx);
  let dir: string;
  let file: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "rossii-edit-"));
    file = join(dir, "prompt.md");
    await writeFile(file, ctx.editor.getText(), "utf8");
  } catch (error) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ Cannot prepare the editor buffer: ${String((error as Error)?.message ?? error)}`), 1, 0));
    ctx.tui.requestRender();
    return;
  }

  let exitCode = 0;
  try {
    ctx.tui.stop({ preserveScreen: true });
    exitCode = await new Promise<number>((resolve) => {
      let settled = false;
      const done = (code: number): void => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      const child = spawn(process.env.SHELL?.trim() || "/bin/sh", ["-c", `${command} "$1"`, "rossii-edit", file], {
        stdio: "inherit",
        env: process.env,
      });
      child.on("error", () => done(-1));
      child.on("close", (code) => done(code ?? 0));
    });
  } finally {
    ctx.tui.start();
  }

  let text = "";
  try {
    text = (await readFile(file, "utf8")).trim();
  } catch {
    // Fall through to the "empty" branch
  }
  void rm(dir, { recursive: true, force: true }).catch(() => {});

  if (exitCode !== 0) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ Editor "${command}" exited with code ${exitCode} — nothing sent.`), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  if (!text) {
    ctx.transcript.addChild(new Text(pc.dim("Editor closed with an empty buffer — nothing sent."), 1, 0));
    ctx.tui.requestRender();
    return;
  }
  ctx.editor.setText("");
  dispatchPrompt(ctx, text);
}

// ─── Prompt dispatch ─────────────────────────────────────────────────────────

/**
 * Wire the composer's Enter key. Kept out of the UI module because every branch
 * it takes (a title prompt, a slash command, a steered prompt) is chat I/O.
 */
export function attachEditorSubmit(ctx: ChatContext): void {
  ctx.editor.onSubmit = (value: string) => {
    const text = value.trim();
    if (ctx.awaitingRename) {
      ctx.awaitingRename = false;
      // A command typed at the title prompt is a command, not a title.
      if (text.startsWith("/")) {
        void handleCommand(ctx, text);
        return;
      }
      if (text) void renameCurrentSession(ctx, text);
      return;
    }
    if (!text) return;
    if (ctx.agentDead || ctx.client.closed) {
      ctx.transcript.addChild(new Text(pc.red("⚠ goose acp is not running — press Esc to exit."), 1, 0));
      ctx.tui.requestRender();
      return;
    }
    if (ctx.setupFailed || !ctx.sessionId) {
      ctx.transcript.addChild(new Text(pc.red("⚠ No ACP session — press Esc to exit."), 1, 0));
      ctx.tui.requestRender();
      return;
    }
    if (text.startsWith("/")) {
      void handleCommand(ctx, text);
      return;
    }
    dispatchPrompt(ctx, text);
  };
}

/**
 * Route a finished prompt (Enter, `/edit`) to the right place: a second
 * `session/prompt` while a turn runs is refused by goose — the text belongs
 * to that turn (steering, ./steer.ts), or it waits for it.
 */
export function dispatchPrompt(ctx: ChatContext, text: string): void {
  // `ROSSII_ACP_STEER=0` keeps the pre-steering behaviour: the draft goes
  // back to the composer and Esc is the way to add context mid-turn. (The
  // editor clears its own buffer on submit, so "do nothing" would drop the
  // text silently — which is what it used to do.)
  if (ctx.busy && !ctx.steeringEnabled) {
    restoreDraft(ctx, text);
    if (!ctx.steerDisabledHintShown) {
      ctx.steerDisabledHintShown = true;
      ctx.transcript.addChild(new Text(
        pc.dim("Steering is off (ROSSII_ACP_STEER=0): press Esc to cancel the turn before sending."),
        1, 0,
      ));
      ctx.tui.requestRender();
    }
    return;
  }
  const plan = planSteer({ busy: ctx.busy, runId: ctx.activeRunId, steerSupported: ctx.steerSupported, text });
  switch (plan.kind) {
    case "command":
      void handleCommand(ctx, text);
      return;
    case "idle":
      void submitPrompt(ctx, text);
      return;
    case "steer":
      void submitSteer(ctx, text, plan.expectedRunId);
      return;
    case "queue":
      queuePrompt(ctx, text);
      return;
  }
}

// ─── Queue / draft ───────────────────────────────────────────────────────────

export function queuePrompt(ctx: ChatContext, text: string): void {
  if (ctx.pendingPrompt !== null) {
    const restored = restoreDraft(ctx, text);
    ctx.transcript.addChild(new Text(
      pc.yellow(
        `⚠ a prompt is already queued for after this turn${restored ? " — this one is back in the composer" : ""}`,
      ),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
  ctx.pendingPrompt = text;
  ctx.transcript.addChild(new Text(pc.dim(`⧗ queued for after this turn: ${text}`), 1, 0));
  ctx.tui.requestRender();
}

export function restoreDraft(ctx: ChatContext, text: string): boolean {
  if (ctx.editor.getText().trim() !== "") return false;
  ctx.editor.setText(text);
  ctx.tui.setFocus(ctx.editor);
  return true;
}

export function abandonPendingSteers(ctx: ChatContext, reason: string): void {
  const abandoned = ctx.steerEntries.splice(0);
  ctx.steerAckIds.clear();
  if (abandoned.length === 0) return;
  for (const entry of abandoned) {
    entry.abandoned = true;
    ctx.transcript.removeChild(entry.line);
  }
  const restored = restoreDraft(ctx, abandoned.map((entry) => entry.text).join("\n\n"));
  ctx.transcript.addChild(new Text(
    pc.yellow(`⚠ ${reason}${restored ? " — the text is back in the composer" : ""}`),
    1, 0,
  ));
  ctx.tui.requestRender();
}

// ─── Turn lifecycle ──────────────────────────────────────────────────────────

export function finishTurn(ctx: ChatContext, turnError?: string): void {
  ctx.busy = false;
  ctx.cancelRequested = false;
  ctx.activeRunId = null;
  setLoader(ctx, null);
  cancelAllPermissions(ctx);
  closeUser(ctx);
  closeThought(ctx);
  closeMessage(ctx);
  closeToolBlocks(ctx);
  abandonPendingSteers(ctx, "steer not delivered (the turn ended)");
  if (turnError && !ctx.agentDead) {
    ctx.transcript.addChild(new Text(pc.red(`⚠ ${turnError}`), 1, 0));
  }
  ctx.tui.requestRender();
  const queued = ctx.pendingPrompt;
  ctx.pendingPrompt = null;
  if (queued) void submitPrompt(ctx, queued);
}

// ─── Submit prompt ───────────────────────────────────────────────────────────

export async function submitPrompt(ctx: ChatContext, text: string, attempt = 0): Promise<void> {
  if (!ctx.sessionId || ctx.busy) return;
  ctx.busy = true;
  ctx.cancelRequested = false;
  ctx.activeRunId = null;
  ctx.lastAgentActivity = Date.now();
  if (attempt === 0) ctx.transcript.addChild(new Text(pc.bold(`❯ ${text}`), 1, 0));
  ctx.currentMd = null;
  ctx.currentMessageId = null;
  ctx.streamBuffer = "";
  ctx.answerLabelLine = null;
  ctx.answerChars = 0;
  ctx.currentThought = null;
  closeUser(ctx);
  ctx.toolCallBlocks.clear();
  setLoader(ctx, steerHint(ctx));
  try {
    const result = (await ctx.client.prompt(
      ctx.sessionId,
      [{ type: "text", text }],
      ctx.turnTimeout.ms,
    )) as PromptResponse;
    finishTurn(ctx, result.stopReason && result.stopReason !== "end_turn" && result.stopReason !== "cancelled"
      ? `turn ended: ${result.stopReason}`
      : undefined);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (!ctx.agentDead && attempt === 0 && /already has active run/i.test(message)) {
      ctx.transcript.addChild(new Text(pc.dim("⧗ the previous turn is still finishing — retrying…"), 1, 0));
      ctx.tui.requestRender();
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      ctx.busy = false;
      return submitPrompt(ctx, text, attempt + 1);
    }
    finishTurn(ctx, message);
  }
}

// ─── Submit steer ────────────────────────────────────────────────────────────

export async function submitSteer(ctx: ChatContext, text: string, expectedRunId: string): Promise<void> {
  if (!ctx.sessionId) return;
  const entry: PendingSteer = {
    text,
    line: new Text(pc.dim(`⤴ steering: ${text}`), 1, 0),
    acked: false,
  };
  ctx.steerEntries.push(entry);
  ctx.transcript.addChild(entry.line);
  ctx.tui.requestRender();
  try {
    // The turn may have ended while the request was in flight — then the entry
    // is gone and the text is already back in the composer.
    const response = await steerSession(ctx.client, ctx.sessionId, text, expectedRunId);
    if (entry.abandoned) return;
    entry.messageId = response.messageId;
    // The ack travels on its own channel and can beat this response.
    if (ctx.steerAckIds.has(response.messageId)) markSteerQueued(ctx, response.messageId);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    dropSteer(ctx, entry);
    // A late failure for a steer the turn's end already took back must not be
    // reported twice, queued, or restored over the user's draft.
    if (entry.abandoned) return;
    switch (classifySteerError(message)) {
      case "unsupported":
        // An older goose: same story as the env flag — the text leaves as a
        // normal prompt once the turn is over, instead of an error nobody can
        // act on.
        ctx.steerSupported = false;
        if (!ctx.steerUnsupportedWarned) {
          ctx.steerUnsupportedWarned = true;
          ctx.transcript.addChild(new Text(
            pc.yellow(
              "⚠ This goose cannot steer a running turn — Enter during a turn now queues the text for after it.",
            ),
            1, 0,
          ));
        }
        queuePrompt(ctx, text);
        return;
      case "no-active-run":
        queuePrompt(ctx, text);
        return;
      default: {
        const restored = restoreDraft(ctx, text);
        ctx.transcript.addChild(new Text(
          pc.yellow(`⚠ steer rejected: ${message}${restored ? " — the text is back in the composer" : ""}`),
          1, 0,
        ));
        ctx.tui.requestRender();
        return;
      }
    }
  }
}

// ─── Loader hint ─────────────────────────────────────────────────────────────

function steerHint(ctx: ChatContext): string {
  if (!ctx.steeringEnabled) return "thinking…";
  if (!ctx.steerSupported) return "thinking… · Esc — cancel";
  return "thinking… · Enter — add to this turn · Esc — cancel";
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export function setLoader(ctx: ChatContext, message: string | null): void {
  if (message === null) {
    ctx.loader.stop();
    ctx.loader.setText("");
    ctx.tui.requestRender();
    return;
  }
  ctx.loader.setMessage(message);
  ctx.loader.start();
  ctx.tui.requestRender();
}
