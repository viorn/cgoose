/**
 * chat-config.ts — configuration menus and slash commands.
 *
 * Functions: showMenu, changeModel, changeProvider, currentProviderConfig,
 * fetchModelsForCurrentProvider, applyFetchedModel, showConfigMenu,
 * showProviderMenu, showModelMenu, showSetMenu, showSessionMenu,
 * submitGooseCommand, showCommandsHelp, handleCommand.
 */

import pc from "picocolors";
import { Text, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
import { listSessionSets } from "../rossii-config";
import { getAllSessions } from "../sessions";
import { isInsideGitRepo, getProjectSessionDirs } from "../worktree";
import { applySessionConfig } from "./session-config";
import { changeSet, changeSession, newSession, forkCurrentSession, renameCurrentSession, promptRename } from "./chat-session";
import { toggleAllThoughts, toggleAllTools, renderHeader, renderStatus } from "./chat-stream";
import { persistSelection } from "./chat-extensions";
import { framed } from "./chat-handlers";
import { promptInEditor, queuePrompt, submitPrompt } from "./chat-io";
import { commandRewritesHistory, formatGooseCommandNames } from "./slash-commands";
import { SearchableList } from "./overlay";
import { mergeModelOptions } from "./model-options";
import { selectListTheme } from "./chat-context";
import {
  addModelToCustomProviderJson,
  getConfigProviders,
  getDiscoveredCustomProviders,
  getCustomProviderModels,
  isModelInCustomProviderJson,
  type ProviderInfo,
} from "../config";
import { fetchModels, type ApiModelInfo } from "../models";
import { formatNumber } from "../utils";
import type { ChatContext } from "./chat-context";

// ─── Menu helpers ────────────────────────────────────────────────────────────

export function showMenu(
  ctx: ChatContext,
  title: string,
  items: Array<{ value: string; label: string; description?: string }>,
  onSelect: (value: string) => void | Promise<void>,
  options: { layout?: SelectListLayoutOptions; width?: number } = {},
): void {
  if (ctx.activePermission || ctx.menuActive) return;
  ctx.menuActive = true;
  const entries = items.length > 0 ? items : [{ value: "cancel", label: "Cancel" }];
  // Every menu is searchable: typing narrows the list (substring match, so
  // `flash` finds `deepseek-v4-flash`) while arrows, Enter and Esc keep
  // behaving exactly as in a plain SelectList. Provider names, model ids, set
  // titles and session names are all lists one filters rather than scans.
  const list = new SearchableList(entries, selectListTheme, {
    maxVisible: 10,
    layout: options.layout,
    placeholder: "type to filter",
    searchStyle: pc.dim,
  });
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    ctx.menuActive = false;
    ctx.tui.hideOverlay();
    ctx.tui.setFocus(ctx.editor);
  };
  list.onSelect = (item: any) => {
    finish();
    if (item.value === "cancel") return;
    void onSelect(String(item.value));
  };
  list.onCancel = () => finish();
  ctx.tui.showOverlay(framed(list, `⚙ ${title}`), { width: options.width ?? 76 });
  ctx.tui.setFocus(list);
}

// ─── Model / Provider ────────────────────────────────────────────────────────

export async function changeModel(ctx: ChatContext, newModel: string): Promise<void> {
  if (!ctx.sessionId) return;
  const outcome = await applySessionConfig(
    ctx.client,
    ctx.sessionId,
    { provider: ctx.currentProvider, model: newModel },
    { provider: ctx.currentProvider, model: ctx.currentModel },
  );
  if (outcome.configOptions) ctx.newSessionConfigOptions = outcome.configOptions;
  if (outcome.warning) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
  } else {
    ctx.currentModel = outcome.model ?? newModel;
    ctx.transcript.addChild(new Text(pc.dim(`⚙ Model changed to ${ctx.currentModel}`), 1, 0));
    renderStatus(ctx);
    renderHeader(ctx);
    persistSelection(ctx);
  }
  ctx.tui.requestRender();
}

export async function changeProvider(ctx: ChatContext, newProvider: string): Promise<void> {
  if (!ctx.sessionId) return;
  const outcome = await applySessionConfig(
    ctx.client,
    ctx.sessionId,
    { provider: newProvider, model: ctx.currentModel },
    { provider: ctx.currentProvider, model: ctx.currentModel },
  );
  if (outcome.configOptions) ctx.newSessionConfigOptions = outcome.configOptions;
  if (outcome.warning) {
    ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${outcome.warning}`), 1, 0));
  } else {
    ctx.currentProvider = outcome.provider ?? newProvider;
    ctx.currentModel = outcome.model ?? ctx.currentModel;
    ctx.transcript.addChild(new Text(pc.dim(`⚙ Provider changed to ${ctx.currentProvider}, model: ${ctx.currentModel}`), 1, 0));
    renderStatus(ctx);
    renderHeader(ctx);
    persistSelection(ctx);
  }
  ctx.tui.requestRender();
}

// ─── Config menu ─────────────────────────────────────────────────────────────

export function showConfigMenu(ctx: ChatContext): void {
  showMenu(ctx, "Configuration", [
    { value: "provider", label: "Change Provider" },
    { value: "model", label: "Change Model" },
    { value: "set", label: "Change Set" },
    { value: "session", label: "Change Session" },
  ], (value) => {
    switch (value) {
      case "provider": showProviderMenu(ctx); break;
      case "model": showModelMenu(ctx); break;
      case "set": showSetMenu(ctx); break;
      case "session": showSessionMenu(ctx); break;
    }
  });
}

export function showProviderMenu(ctx: ChatContext): void {
  const options = ctx.newSessionConfigOptions?.find((o) => o.id === "provider")?.options ?? [];
  if (options.length === 0) {
    ctx.transcript.addChild(new Text(
      pc.yellow("⚠ No provider list available (config options missing). Use /provider <name> or restart."),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
  const items = options.map((o) => ({ value: o.value, label: o.name ?? o.value }));
  items.push({ value: "cancel", label: "Cancel" });
  showMenu(ctx, "Select Provider", items, (value) => {
    if (value !== "cancel") void changeProvider(ctx, value);
  });
}

// ─── Model fetch from the provider's own API ─────────────────────────────────

/** The provider entry from config.yaml / custom_providers/*.json, which is
 *  what the HTTP model fetch needs (base_url + api key). */
export function currentProviderConfig(ctx: ChatContext): ProviderInfo | undefined {
  const yamlProviders = getConfigProviders();
  return [...yamlProviders, ...getDiscoveredCustomProviders(yamlProviders)].find(
    (entry) => entry.name === ctx.currentProvider,
  );
}

export async function applyFetchedModel(ctx: ChatContext, model: ApiModelInfo, provider: ProviderInfo): Promise<void> {
  await changeModel(ctx, model.id);
  // A model the provider JSON does not list has no context limit, and the
  // wizard would not offer it either — record it (the API's own limit when it
  // reports one) so both UIs see the same list.
  if (provider.name.startsWith("custom_") && !isModelInCustomProviderJson(provider.name, model.id)) {
    const contextLimit = model.contextLimit ?? 128_000;
    if (addModelToCustomProviderJson(provider.name, model.id, contextLimit)) {
      ctx.transcript.addChild(new Text(
        pc.dim(`⚙ Added "${model.id}" to ${provider.name} (context_limit: ${formatNumber(contextLimit)})`),
        1, 0,
      ));
    }
  }
  ctx.tui.requestRender();
}

/** Ask the provider's own /v1/models endpoint for its current model list — the
 *  list goose may not know until the model is added to the provider JSON. */
export async function fetchModelsForCurrentProvider(ctx: ChatContext): Promise<void> {
  const provider = currentProviderConfig(ctx);
  if (!provider || !provider.baseUrl) {
    ctx.transcript.addChild(new Text(
      pc.yellow(`⚠ "${ctx.currentProvider}" is not an HTTP provider with a base_url — cannot fetch models. Use /model <name>.`),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
  if (!provider.authToken) {
    const envHint = provider.apiKeyEnv || `${provider.name.replace(/^custom_/, "").toUpperCase()}_API_KEY`;
    ctx.transcript.addChild(new Text(
      pc.yellow(`⚠ No API key for "${provider.name}" — set $${envHint} and retry.`),
      1, 0,
    ));
    ctx.tui.requestRender();
    return;
  }
  ctx.transcript.addChild(new Text(pc.dim(`🔄 Fetching models from ${provider.baseUrl}…`), 1, 0));
  ctx.tui.requestRender();
  try {
    const models = await fetchModels(provider);
    if (models.length === 0) {
      ctx.transcript.addChild(new Text(pc.yellow("⚠ The API returned no models."), 1, 0));
      ctx.tui.requestRender();
      return;
    }
    ctx.transcript.addChild(new Text(pc.dim(`Found ${models.length} model(s) at ${provider.name}.`), 1, 0));
    // Model ids are long (`~anthropic/claude-sonnet-latest`) and the context
    // limit needs its own room, so the list is wider than the other menus.
    showMenu(ctx, `Models from ${provider.name}`, models.map((model) => ({
      value: model.id,
      label: model.id,
      description: model.contextLimit
        ? `context: ${formatNumber(model.contextLimit)}`
        : "context: 128k default",
    })), (value) => {
      const picked = models.find((model) => model.id === value);
      if (picked) void applyFetchedModel(ctx, picked, provider);
    }, { width: 88, layout: { maxPrimaryColumnWidth: 52 } });
  } catch (error) {
    ctx.transcript.addChild(new Text(
      pc.yellow(`⚠ Failed to fetch models: ${String((error as Error)?.message ?? error)}`),
      1, 0,
    ));
  }
  ctx.tui.requestRender();
}

export function showModelMenu(ctx: ChatContext): void {
  const gooseOptions = ctx.newSessionConfigOptions?.find((o) => o.id === "model")?.options ?? [];
  // Same gate as the wizard: only `custom_*` providers keep a JSON file.
  const customModels = ctx.currentProvider.startsWith("custom_")
    ? getCustomProviderModels(ctx.currentProvider)
    : [];
  const items = mergeModelOptions(gooseOptions, customModels);
  if (items.length === 0) {
    // No list from goose, and nothing in the custom provider either.
    ctx.transcript.addChild(new Text(
      pc.dim("goose reported no model list for this session — fetch it from the provider, or use /model <name>."),
      1, 0,
    ));
  }
  items.push({
    value: "!fetch",
    label: "🔄 Fetch models from API",
    description: ctx.currentProvider,
  });
  items.push({ value: "cancel", label: "Cancel" });
  // The same room for the ids as the fetched list: the names goose reports are
  // just as long, and typing filters them down the same way.
  showMenu(ctx, "Select Model", items, (value) => {
    if (value === "!fetch") void fetchModelsForCurrentProvider(ctx);
    else if (value !== "cancel") void changeModel(ctx, value);
  }, { width: 88, layout: { maxPrimaryColumnWidth: 52 } });
}

export function showSetMenu(ctx: ChatContext): void {
  const sets = listSessionSets();
  const items = Object.values(sets).map((s) => ({ value: s.name, label: s.title }));
  items.push({ value: "default", label: "Default (goose config.yaml)" });
  items.push({ value: "none", label: "None" });
  items.push({ value: "cancel", label: "Cancel" });
  showMenu(ctx, "Select Set", items, (value) => {
    if (value !== "cancel") void changeSet(ctx, value);
  });
}

export function showSessionMenu(ctx: ChatContext): void {
  // Same project filter as the wizard: the whole sessions.db holds every
  // project the user ever ran, and switching into someone else's working
  // directory would put the agent in the wrong place.
  const dirs = new Set([ctx.cwd]);
  if (isInsideGitRepo()) for (const dir of getProjectSessionDirs(ctx.cwd)) dirs.add(dir);
  const sessions = getAllSessions().filter((s) => s.working_dir && dirs.has(s.working_dir));
  const items: Array<{ value: string; label: string; description?: string }> = sessions
    .filter((s) => s.id !== ctx.sessionId)
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
  // Free-form titles, usually longer than the default 32-column primary
  // column — the filter makes a long list usable either way.
  showMenu(ctx, "Select Session", items, (value) => {
    if (value === "new") {
      void newSession(ctx);
    } else if (value === "!rename") {
      promptRename(ctx);
    } else if (value === "!fork") {
      void forkCurrentSession(ctx);
    } else if (value !== "cancel") {
      void changeSession(ctx, value);
    }
  }, { width: 88, layout: { maxPrimaryColumnWidth: 52 } });
}

// ─── Slash command handler ───────────────────────────────────────────────────

/**
 * Run a `/…` that rossii does not implement — it is goose's. The agent's
 * `execute_command()` is the only thing that can run them (they rewrite the
 * conversation goose stores or report on it) and it looks at the *prompt* of a
 * turn, so the text goes out as an ordinary prompt, verbatim; the answer
 * ("Compaction complete", the status report…) streams back normally.
 *
 * Nothing is validated against goose's announced list: goose's own TUI does not
 * either (an unknown `/…` is submitted as a message), and refusing what the chat
 * cannot know about is what made `/compact` unreachable in the first place.
 */
export function submitGooseCommand(ctx: ChatContext, text: string): void {
  if (commandRewritesHistory(text)) {
    // goose replaces its stored conversation and the ACP server drops
    // `AgentEvent::HistoryReplaced`, so nothing tells the client to redraw: this
    // transcript stays the pre-command view. Say so rather than pretend the
    // history refreshed — including when the command only runs after this turn.
    ctx.transcript.addChild(new Text(
      pc.dim(`🪿 ${text.trim()} runs on goose's side — the agent's conversation is rewritten, this transcript is not.`),
      1, 0,
    ));
    ctx.tui.requestRender();
  }
  if (ctx.busy) {
    // Queued, never steered: goose only looks for a command in a turn's prompt,
    // so a `/compact` steered into the running turn would just be text the model
    // reads mid-turn.
    queuePrompt(ctx, text);
    return;
  }
  void submitPrompt(ctx, text);
}

/**
 * `/help` — the same two lists the composer's completion menu offers
 * (./command-complete.ts), printed for reading.
 */
export function showCommandsHelp(ctx: ChatContext): void {
  ctx.transcript.addChild(new Text(
    pc.dim("The chat: ") + "/config /model /provider /set /session /rename /fork /think /tool /edit /fetch /help",
    1, 0,
  ));
  ctx.transcript.addChild(new Text(
    ctx.gooseCommands.length > 0
      ? pc.dim("goose:    ") + formatGooseCommandNames(ctx.gooseCommands) +
        pc.dim("  (any other /command goes to the agent too)")
      : pc.dim("goose also has its own commands (/compact, /clear, /status…) — its list is not here yet, try /help again."),
    1, 0,
  ));
  ctx.transcript.addChild(new Text(
    pc.dim("Tab (or just `/`) opens the same list in the composer · ↑/↓ pick · Enter applies · Esc closes"),
    1, 0,
  ));
  ctx.tui.requestRender();
}

export async function handleCommand(ctx: ChatContext, text: string): Promise<void> {
  const [cmd, ...args] = text.slice(1).split(/\s+/);
  switch (cmd) {
    case "config":
    case "settings":
    case "setting":
      showConfigMenu(ctx);
      return;
    case "edit":
      await promptInEditor(ctx);
      return;
    case "fetch":
      await fetchModelsForCurrentProvider(ctx);
      return;
    case "model":
      if (args.length === 0) {
        showModelMenu(ctx);
      } else if (args[0] === "fetch") {
        await fetchModelsForCurrentProvider(ctx);
      } else {
        await changeModel(ctx, args.join(" "));
      }
      return;
    case "provider":
      if (args.length > 0) {
        await changeProvider(ctx, args.join(" "));
      } else {
        showProviderMenu(ctx);
      }
      return;
    case "set":
      if (args.length > 0) {
        await changeSet(ctx, args.join(" "));
      } else {
        showSetMenu(ctx);
      }
      return;
    case "session":
      if (args.length > 0) {
        switch (args[0]) {
          case "new":
            await newSession(ctx);
            break;
          case "rename":
            if (args.length > 1) await renameCurrentSession(ctx, args.slice(1).join(" "));
            else promptRename(ctx);
            break;
          case "fork":
            await forkCurrentSession(ctx);
            break;
          default:
            await changeSession(ctx, args.join(" "));
        }
      } else {
        showSessionMenu(ctx);
      }
      return;
    case "rename":
      if (args.length > 0) await renameCurrentSession(ctx, args.join(" "));
      else promptRename(ctx);
      return;
    case "fork":
      await forkCurrentSession(ctx);
      return;
    case "think":
      toggleAllThoughts(ctx, args);
      return;
    case "tool":
      toggleAllTools(ctx, args);
      return;
    case "help":
      showCommandsHelp(ctx);
      return;
    default:
      // Not a command rossii implements → goose's (see ./slash-commands.ts):
      // `/compact`, `/clear`, `/status`, `/doctor`, `/goal`, …, a recipe or a
      // skill, or simply a typo goose will treat as text.
      submitGooseCommand(ctx, text);
      return;
  }
}
