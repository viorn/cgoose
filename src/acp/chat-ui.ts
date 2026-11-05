/**
 * chat-ui.ts — UI assembly and process lifetime.
 *
 * Functions: setupUi (loader, editor, layout), startChat (start + hints),
 * attachInputListener (Ctrl+P/O/E, Esc-arming, Ctrl+C), startIdleWatchdog,
 * attachAgentExit, shutdown.
 */

import pc from "picocolors";
import {
  Container,
  Editor,
  Key,
  Loader,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";

import { editorTheme } from "./chat-context";
import { buildCommandItems, createCommandCompleter } from "./command-complete";
import { closeThought, closeToolBlocks, renderHeader, renderStatus } from "./chat-stream";
import { showConfigMenu, showModelMenu } from "./chat-config";
import { abandonPendingSteers, promptInEditor, setLoader } from "./chat-io";
import { cancelAllPermissions } from "./chat-handlers";
import type { ChatContext } from "./chat-context";

// ─── UI assembly ─────────────────────────────────────────────────────────────

/**
 * Build the whole renderer: terminal, transcript, composer, layout root.
 *
 * The chat renders into its own viewport (alternate screen): the transcript
 * scrolls *inside* the TUI — wheel, PgUp/PgDn, Ctrl+Shift+F search — and
 * streaming updates never drag the view back to the bottom. Only the
 * composer is pinned; the header scrolls with the conversation.
 * On exit pi-tui prints the final transcript to
 * the normal screen, so the conversation still lands in the scrollback.
 *
 * ROSSII_CHAT_MAIN_SCREEN=1 restores the inline renderer, where the terminal
 * owns the scrollback: any repaint writes at the cursor and pulls the view
 * down, so reading history during a turn is best-effort there.
 */
export function setupUi(ctx: ChatContext): void {
  const terminal = new ProcessTerminal();
  const tui: TUI = ctx.altScreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  ctx.tui = tui;

  // A plain Container, not a VStack: the transcript is not part of the layout
  // tree (the scroll view hosts a plain document), and `Stack.render` does not
  // record the child geometry `Container.handleMouse` hit-tests with — a VStack
  // here made every mouse event re-render the whole transcript.
  ctx.transcript = new Container();
  ctx.statusLine = new Text("", 0, 0);
  ctx.headerLine = new Text("", 1, 0);

  // In the inline renderer every repaint writes at the cursor (the last line)
  // and drags the terminal back to the bottom, so there the spinner must not
  // request renders: its ticks only advance the frame text and the next real
  // update paints it. With a viewport of our own the animation is harmless.
  const inertUi = { requestRender: () => {} } as unknown as TUI;
  const loader = new Loader(ctx.altScreen ? tui : inertUi, (s) => pc.cyan(s), (s) => pc.dim(s), "thinking…");
  // The constructor starts the animation; keep it idle until a turn runs.
  loader.stop();
  loader.setText("");
  ctx.loader = loader;

  // 8 rows of completion: the chat's twelve names plus goose's (builtins,
  // recipes, skills) is around two dozen, and the editor scrolls the rest with
  // its "(1/24)" counter.
  ctx.editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
  // The `/…` menu. The list is read lazily — goose announces its own commands
  // after `session/new`, which is later than this line (./command-complete.ts).
  ctx.editor.setAutocompleteProvider(
    createCommandCompleter(() => buildCommandItems(ctx.gooseCommands)),
  );

  if (isViewportTUI(tui)) {
    // The header scrolls with the conversation (it is just the first lines of
    // the document), the composer stays pinned at the bottom. `follow: "end"`
    // auto-follows new content until the user scrolls up, and resumes when the
    // view is back at the bottom.
    const document = new Container();
    document.addChild(ctx.headerLine);
    document.addChild(new Spacer());
    document.addChild(ctx.transcript);

    const composer = new VStack([loader, new Spacer(), ctx.editor, ctx.statusLine]);
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
    tui.addChild(ctx.headerLine);
    tui.addChild(new Spacer());
    tui.addChild(ctx.transcript);
    tui.addChild(loader);
    tui.addChild(new Spacer());
    tui.addChild(ctx.editor);
    tui.addChild(ctx.statusLine);
  }
}

/** Take the terminal, paint the header, and print the startup hints. */
export function startChat(ctx: ChatContext): void {
  ctx.tui.start();
  ctx.tui.setFocus(ctx.editor);
  renderHeader(ctx);
  renderStatus(ctx);
  const timeoutWarnings = [ctx.idleTimeout.invalid, ctx.turnTimeout.invalid]
    .filter((warning): warning is string => warning !== null);
  for (const warning of [...timeoutWarnings, ...(ctx.steeringWarning ? [ctx.steeringWarning] : [])]) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${warning}`), 1, 0));
  }
  ctx.transcript.addChild(new Text(
    pc.dim(
      "Type / for the command list (Tab completes it, /help prints it) · /config changes provider, model, set or session · Ctrl+P config · Ctrl+O model · Ctrl+E $EDITOR" +
        (ctx.steeringEnabled ? " · Enter during a turn adds to that turn, Esc cancels it" : ""),
    ),
    1, 0,
  ));
  ctx.tui.requestRender();
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

/** Every key the chat owns: quick menus, Ctrl+C, and the armed Esc exit. */
export function attachInputListener(ctx: ChatContext): void {
  ctx.tui.addInputListener((data: string): { consume?: boolean } | undefined => {
    // A permission prompt owns the keyboard entirely: Esc/Ctrl+C reject the tool
    // call. Without this, Esc exited the whole chat while the prompt was open.
    if (ctx.activePermission) return undefined;
    if (ctx.tui.hasOverlay()) {
      // A menu owns Esc (it closes the menu), but Ctrl+C stays the unconditional
      // "get me out" key, as it is everywhere else in the chat.
      if (matchesKey(data, Key.ctrl("c"))) {
        void shutdown(ctx);
        return { consume: true };
      }
      return undefined;
    }
    // Quick keys. Ctrl+M cannot be used for the model menu: a terminal sends
    // Enter as CR, which *is* Ctrl+M, so the binding would fire on every
    // submitted prompt — Ctrl+O is the free equivalent.
    if (matchesKey(data, Key.ctrl("p"))) {
      ctx.escArmedExit = false;
      showConfigMenu(ctx);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      ctx.escArmedExit = false;
      showModelMenu(ctx);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("e"))) {
      ctx.escArmedExit = false;
      void promptInEditor(ctx);
      return { consume: true };
    }
    const escape = matchesKey(data, Key.escape);
    const ctrlC = matchesKey(data, Key.ctrl("c"));
    if (!escape && !ctrlC) {
      // Any other key means the user is still typing — disarm the exit.
      ctx.escArmedExit = false;
      return undefined;
    }

    if (ctx.agentDead || ctx.client.closed) {
      void shutdown(ctx);
      return { consume: true };
    }
    // Esc aborts the pending title prompt instead of exiting the chat.
    if (ctx.awaitingRename) {
      ctx.awaitingRename = false;
      ctx.editor.setText("");
      ctx.transcript.addChild(new Text(pc.dim("Rename cancelled."), 1, 0));
      ctx.tui.requestRender();
      return { consume: true };
    }
    if (ctx.busy && ctx.sessionId) {
      // Esc still cancels the whole turn — and goose throws away the steers it
      // has not picked up yet, so say it before it happens.
      if (ctx.steerEntries.length > 0) {
        ctx.transcript.addChild(new Text(
          pc.dim("Esc cancels the turn — a steer that is still queued will be discarded."),
          1, 0,
        ));
      }
      ctx.client.cancel(ctx.sessionId);
      setLoader(ctx, "cancelling…");
      return { consume: true };
    }
    if (ctrlC) {
      // Ctrl+C is the "just get me out" key: it always exits.
      void shutdown(ctx);
      return { consume: true };
    }
    // Esc with the autocomplete menu open belongs to the editor (it closes the
    // menu) — the draft must survive that.
    if (ctx.editor.capturesViewportInput) return undefined;
    // The editor does not handle Esc itself, so a non-empty draft used to make
    // Esc a dead key. Require a second Esc instead of silently doing nothing.
    if (ctx.editor.getText().length > 0 && !ctx.escArmedExit) {
      ctx.escArmedExit = true;
      if (!ctx.exitHintShown) {
        ctx.exitHintShown = true;
        ctx.transcript.addChild(new Text(
          pc.dim("Esc again to exit (the draft will be lost) · Ctrl+C exits right away"),
          1, 0,
        ));
        ctx.tui.requestRender();
      }
      return { consume: true };
    }
    void shutdown(ctx);
    return { consume: true };
  });
}

// ─── Watchdogs ───────────────────────────────────────────────────────────────

/**
 * Idle watchdog: a long but *live* turn must not be interrupted, a silent one
 * must not leave the UI stuck with `busy` forever (the request itself has no
 * deadline until the hard cap in ./timeouts.ts).
 */
export function startIdleWatchdog(ctx: ChatContext): void {
  if (ctx.idleTimeout.ms <= 0) return;
  const checkEvery = Math.max(1_000, Math.min(30_000, Math.floor(ctx.idleTimeout.ms / 4)));
  const idleTimer = setInterval(() => {
    if (!ctx.busy || !ctx.sessionId || ctx.exiting || ctx.agentDead || ctx.cancelRequested) return;
    const silentFor = Date.now() - ctx.lastAgentActivity;
    if (silentFor < ctx.idleTimeout.ms) return;
    ctx.cancelRequested = true;
    ctx.transcript.addChild(new Text(
      pc.yellow(`⚠ no agent activity for ${Math.round(silentFor / 60_000)} min — cancelling the turn`),
      1, 0,
    ));
    setLoader(ctx, "cancelling…");
    ctx.client.cancel(ctx.sessionId);
    ctx.tui.requestRender();
  }, checkEvery);
  // Never keep the process alive by itself: the chat owns the lifetime.
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

// ─── Agent exit & shutdown ───────────────────────────────────────────────────

/** The agent may die at any moment: stop accepting prompts and say why. */
export function attachAgentExit(ctx: ChatContext): void {
  ctx.onAgentExit = () => {
    if (ctx.exiting || ctx.agentDead) return;
    ctx.agentDead = true;
    ctx.busy = false;
    ctx.activeRunId = null;
    setLoader(ctx, null);
    cancelAllPermissions(ctx);
    closeThought(ctx);
    closeToolBlocks(ctx);
    abandonPendingSteers(ctx, "goose exited before the steer was delivered");
    ctx.transcript.addChild(new Text(pc.red("⚠ goose acp exited unexpectedly"), 1, 0));
    for (const line of ctx.stderrTail.slice(-5)) {
      ctx.transcript.addChild(new Text(pc.dim(line), 1, 0));
    }
    ctx.transcript.addChild(new Text(pc.dim("Press Esc to exit."), 1, 0));
    ctx.tui.requestRender();
  };
}

/** Stop the agent, hand the terminal back, exit the process. */
export async function shutdown(ctx: ChatContext): Promise<void> {
  if (ctx.exiting) return;
  ctx.exiting = true;
  // Do not leave the agent waiting for a permission answer.
  cancelAllPermissions(ctx);
  setLoader(ctx, null);
  try {
    await ctx.client.stop();
  } finally {
    ctx.tui.stop();
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
