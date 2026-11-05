/**
 * chat-handlers.ts — agent→client request handlers.
 *
 * Functions: permission queue, cancelAllPermissions, showNextPermission,
 * framed(), setPromptHandlers (readTextFile, writeTextFile, requestPermission).
 */

import pc from "picocolors";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  SelectList,
  type Component,
} from "@earendil-works/pi-tui";
import { BorderBox } from "./overlay";
import { DEFAULT_READ_LIMIT, selectListTheme } from "./chat-context";
import type { ChatContext } from "./chat-context";
import type { RequestPermissionResponse } from "./types";

// ─── Permission queue ────────────────────────────────────────────────────────

// Permission requests are queued: goose may ask about several tool calls in
// parallel, while only one overlay can be visible at a time. Every pending
// request must be answered, otherwise the agent waits forever.
// (The queue itself lives on the context — see `PendingPermission` in
// ./chat-context.ts.)

/** Cancel all pending permission requests. */
export function cancelAllPermissions(ctx: ChatContext): void {
  // Drain the queue first so `finish()` cannot pop a new overlay while we
  // are resolving the rest.
  const pending = ctx.permissionQueue.splice(0);
  const active = ctx.activePermission;
  ctx.activePermission = null;
  active?.finish({ outcome: { outcome: "cancelled" } });
  for (const entry of pending) {
    entry.resolve({ outcome: { outcome: "cancelled" } });
  }
}

/** Overlay frame: a titled border. */
export function framed(content: Component, title: string): BorderBox {
  return new BorderBox(content, { title: pc.bold(title), border: pc.dim });
}

/** Show the next permission request from the queue. */
export function showNextPermission(ctx: ChatContext): void {
  if (ctx.activePermission || ctx.exiting || ctx.agentDead) return;
  const next = ctx.permissionQueue.shift();
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
    ctx.activePermission = null;
    ctx.tui.hideOverlay();
    ctx.tui.setFocus(ctx.editor);
    next.resolve(response);
    showNextPermission(ctx);
  };
  ctx.activePermission = { finish };
  list.onSelect = (item: any) => {
    finish(item.value === "cancel"
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: String(item.value) } });
  };
  list.onCancel = () => finish({ outcome: { outcome: "cancelled" } });
  ctx.tui.showOverlay(framed(list, `⚡ ${title}`), { width: 76 });
  ctx.tui.setFocus(list);
}

/**
 * Set prompt handlers on the ACP client.
 *
 * Registers handlers for `requestPermission`, `readTextFile`, and
 * `writeTextFile` — the three agent→client requests the chat handles.
 */
export function setPromptHandlers(ctx: ChatContext): void {
  ctx.client.setPromptHandlers({
    requestPermission: (params) => new Promise<RequestPermissionResponse>((resolve) => {
      if (ctx.exiting || ctx.agentDead) {
        resolve({ outcome: { outcome: "cancelled" } });
        return;
      }
      ctx.permissionQueue.push({ params, resolve });
      showNextPermission(ctx);
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
}