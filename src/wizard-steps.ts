/**
 * rossii — wizard steps 1–5 (session, session_name, set, provider, model).
 *
 * The wizard state is passed in explicitly as `state`: each step destructures
 * the fields it needs and writes the mutated ones back before returning, and
 * every step returns the next step to run — or the same step to re-show it
 * (the original loop's `continue`). Nothing closes over `main()`'s locals.
 */

import process from "node:process";
import { resolve } from "node:path";
import { autocomplete, confirm, isCancel, log, outro, text } from "@clack/prompts";
import pc from "picocolors";

import { env, generateSessionName, formatNumber } from "./utils";
import { listSessionSets } from "./rossii-config";
import { DEFAULT_PROFILE_SENTINEL } from "./launcher";
import {
  getConfigProviders, getDiscoveredCustomProviders, getCustomProviderModels,
  isModelInCustomProviderJson, addModelToCustomProviderJson, type ProviderInfo,
} from "./config";
import { createCustomProviderWizard, type CreatedProvider } from "./provider-creator";
import { readProjectMeta, getWorktreeMappings } from "./project";
import { getAllSessions, formatSessionHint, type GooseSession } from "./sessions";
import { fetchModelsFromApi, type OllamaModelInfo } from "./models";
import { getProjectSessionDirs, isInsideGitRepo } from "./worktree";

import { handleDeleteSessions, createSessionSetWizard, manageSessionSets } from "./wizard-sessions";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Step = "session" | "session_name" | "set" | "provider" | "model" | "launch";

export type LaunchMode = "full" | "auto" | "new" | "session-only" | "edit";

/** Wizard state shared across the steps. Each step receives it explicitly and
 *  writes back the fields it mutates — no step closes over `main()`'s locals. */
export interface WizardState {
  /** Resolved CLI launch mode (`s` / `a` / `n` / `w` / `m` / `e`). */
  mode: LaunchMode;
  noWorktree: boolean;
  isChatMode: boolean;
  sessionPrefix: string;
  allProviders: ProviderInfo[];
  discoveredProviders: ProviderInfo[];
  ollamaModels: OllamaModelInfo[] | null;
  sessionName: string;
  sessionDisplayName: string; // human-readable name (for worktree lookups)
  isNewSession: boolean;
  selectedProviderName: string;
  modelValue: string;
  selectedSet: string; // name of the selected session set ("" = none)
  lastAllSessions: GooseSession[];
  /** `a`/`n` resolved without any prompt: in chat mode the summary + "Launch
   *  Goose now?" would be one more Enter on a path that exists to skip prompts,
   *  so the chat opens straight away (classic mode keeps the confirmation). */
  quickLaunch: boolean;
}

// ─── Renderer selection ──────────────────────────────────────────────────────

/**
 * ACP (chat) mode is the default: rossii spawns `goose acp` and draws the
 * dialog itself. `ROSSII_ACP_MODE=classic` switches to the classic
 * `goose session` TUI; `acp`/`chat` (also 1/on/true) opt in explicitly.
 * An unrecognised value warns and keeps the default instead of silently
 * changing how the session is rendered.
 */
export function resolveChatMode(): boolean {
  const raw = (env("ACP_MODE") ?? "").trim().toLowerCase();
  if (raw === "") return true;
  if (["acp", "chat", "1", "on", "true", "yes"].includes(raw)) return true;
  if (["classic", "session", "0", "off", "false", "no"].includes(raw)) return false;
  log.warn(pc.yellow(
    `⚠ ROSSII_ACP_MODE="${raw}" is not recognised — using ACP (chat) mode. Set "classic" for the goose session TUI.`,
  ));
  return true;
}

/** Old chat-mode letters (the feature is the default now); the pairs remain
 *  valid as aliases of their base mode so muscle memory keeps working. */
export const LEGACY_CHAT_ALIASES: Record<string, string> = {
  c: "",
  mc: "m",
  wc: "w",
  ac: "a",
  ca: "a",
  nc: "n",
  cn: "n",
  sc: "s",
  cs: "s",
};

// ─── Wizard steps ────────────────────────────────────────────────────────────

// ─── STEP 1: Session selection (also handles Delete sessions...) ────────────

export async function stepSession(state: WizardState): Promise<Step> {
  let step: Step = "session";
  let { sessionName, isNewSession, lastAllSessions } = state;
  const { mode, noWorktree, selectedProviderName } = state;
  do {
    const allSessions = getAllSessions();
    lastAllSessions = allSessions;
    const cwd = resolve(".");

    // In a git repo, show sessions from all worktrees too (not just CWD)
    const inRepo = !noWorktree && isInsideGitRepo();
    const projectDirs = inRepo ? getProjectSessionDirs(cwd) : [cwd];
    const worktreeMap = inRepo ? getWorktreeMappings() : {};

    const dirSessions = allSessions.filter((s) => {
      if (!s.working_dir) return false;
      return projectDirs.includes(s.working_dir);
    });

    const sessionOptions: { label: string; value: string; hint?: string }[] = [];

    sessionOptions.push({
      label: pc.green("\u2726 Create new session"),
      value: "__new__",
    });

    if (dirSessions.length > 0) {
      sessionOptions.push({
        label: pc.yellow("  Delete sessions..."),
        value: "__delete__",
        hint: "(" + dirSessions.length + " available)",
      });
    }

    for (let i = 0; i < dirSessions.length && i < 50; i++) {
      const s = dirSessions[i];
      const { name, hint } = formatSessionHint(s);
      const hasWorktree = worktreeMap[s.id] ? true : false;
      const icon = hasWorktree ? pc.green(" 🌲") : "";
      sessionOptions.push({ label: pc.bold(name) + icon, value: s.id, hint });
    }

    const selected = await autocomplete({
      message: `Session: ${pc.dim("(Esc ← back / exit)")}`,
      placeholder: "Type to filter sessions...",
      options: sessionOptions,
      maxItems: 12,
      filter: (search, opt) => {
        const haystack = opt.value + " " + opt.label + " " + (opt.hint || "");
        return haystack.toLowerCase().includes(search.toLowerCase());
      },
    });

    if (isCancel(selected)) {
      outro(pc.yellow("See you next time!"));
      process.exit(0);
    }

    if (selected === "__delete__") {
      await handleDeleteSessions(allSessions, dirSessions);
      continue; // refresh session list
    }

    if (selected === "__new__") {
      isNewSession = true;
      if (mode === "session-only" && selectedProviderName) {
        step = "session_name"; // still need a name, then skip to launch
      } else {
        step = "session_name";
      }
      continue;
    }

    sessionName = selected as string;
    isNewSession = false;

    // When resuming, find the session's name to look up worktree mappings
    // (sessions are stored by ID, but worktree is mapped by session name)
    const selectedSession = allSessions.find((s) => s.id === sessionName);
    const resumedSessionName = selectedSession?.name ?? sessionName;

    // If resuming and session already has a worktree, switch cwd context
    if (inRepo && worktreeMap[resumedSessionName]) {
      console.log(pc.dim(`  📂 Session has worktree at ${pc.cyan(worktreeMap[resumedSessionName])}`));
    }

    if (mode === "session-only" && selectedProviderName) {
      step = "launch";
    } else {
      step = "set";
    }
    continue;
  } while (false);
  state.sessionName = sessionName;
  state.isNewSession = isNewSession;
  state.lastAllSessions = lastAllSessions;
  return step;
}

// ─── STEP 2: Session name (only for new sessions) ──────────────────────────

export async function stepSessionName(state: WizardState): Promise<Step> {
  let step: Step = "session_name";
  let { sessionName } = state;
  const { mode, selectedProviderName, sessionPrefix } = state;
  do {
    const allSessions = getAllSessions();
    const suggested = generateSessionName(sessionPrefix);
    const customName = await text({
      message: `Session name: ${pc.dim("(press Enter for auto-name)")}`,
      placeholder: suggested,
      defaultValue: suggested,
      validate: (val) => {
        if (val && val.includes(" ")) return "Name cannot contain spaces";
        if (val && allSessions.find((s) => s.id === val.trim())) return "Session '" + val + "' already exists";
        return;
      },
    });

    if (isCancel(customName)) {
      step = "session"; // back to session list
      continue;
    }

    sessionName = (customName as string).trim();
    if (mode === "session-only" && selectedProviderName) {
      step = "launch";
    } else {
      step = "set"; // go to set selection next
    }
    continue;
  } while (false);
  state.sessionName = sessionName;
  return step;
}

// ─── STEP 2.5: Session set selection ───────────────────────────────────────

export async function stepSet(state: WizardState): Promise<Step> {
  let step: Step = "set";
  let { selectedSet } = state;
  do {
    const allSets = listSessionSets();

    const lastMeta = readProjectMeta();
    const lastSet = lastMeta?.setHistory?.[0] ?? "";
    const setHistory = lastMeta?.setHistory ?? [];

    const setOptions: { label: string; value: string; hint?: string }[] = [];

    // 1) Last-used set — always at the very top
    const lastIsDefault = lastSet === DEFAULT_PROFILE_SENTINEL;
    const lastSetObj = lastSet && !lastIsDefault ? allSets[lastSet] : undefined;
    if (lastSetObj) {
      setOptions.push({
        label: `${lastSetObj.title} ${pc.dim("←")}  ${pc.green("❶")}`,
        value: lastSetObj.name,
        hint: (lastSetObj.description || lastSetObj.name) + ` ${pc.dim("← last used")}`,
      });
    } else if (lastIsDefault) {
      setOptions.push({
        label: `Default ${pc.dim("←")}  ${pc.green("❶")}`,
        value: DEFAULT_PROFILE_SENTINEL,
        hint: pc.dim("extensions from ~/.config/goose/config.yaml") + ` ${pc.dim("← last used")}`,
      });
    }

    // 2) "None" option — no extensions at all (--no-profile, nothing else)
    setOptions.push({
      label: !lastSetObj && lastSet === ""
        ? pc.green("✦ None") + ` ${pc.dim("←")}`
        : "None",
      value: "",
      hint: pc.dim("no extensions at all"),
    });

    // 2.5) "Default" pseudo-set — Goose's own profile from ~/.config/goose/config.yaml
    if (!lastIsDefault) {
      setOptions.push({
        label: "Default",
        value: DEFAULT_PROFILE_SENTINEL,
        hint: pc.dim("extensions from ~/.config/goose/config.yaml"),
      });
    }

    // 3) Remaining sets sorted by history then alphabetical
    const sortedSets = Object.values(allSets)
      .filter((s) => !lastSetObj || s.name !== lastSetObj.name)
      .sort((a, b) => {
        const aIdx = setHistory.indexOf(a.name);
        const bIdx = setHistory.indexOf(b.name);
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        if (aIdx !== -1) return -1;
        if (bIdx !== -1) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const s of sortedSets) {
      let label = s.title;
      let extra = "";
      if (setHistory.includes(s.name)) {
        extra = ` ${pc.dim("(history)")}`;
      }
      setOptions.push({
        label,
        value: s.name,
        hint: (s.description || s.name) + extra,
      });
    }

    // 4) Create new set option
    setOptions.push({
      label: pc.cyan("⚙️ Create new session set..."),
      value: "__create_set__",
      hint: pc.dim("system prompt + builtins/extensions"),
    });

    // 5) Manage sets
    setOptions.push({
      label: pc.yellow("  Manage sets..."),
      value: "__manage_sets__",
      hint: pc.dim("edit or delete existing sets"),
    });

    const selected = await autocomplete({
      message: `Session set: ${pc.dim("(Esc ← back to session name)")}`,
      placeholder: "Type to filter... (default = none)",
      options: setOptions,
      maxItems: 10,
      initialValue: lastSet || "",
      filter: (search, opt) => {
        const haystack = `${opt.value} ${opt.label} ${opt.hint || ""}`.toLowerCase();
        return haystack.includes(search.toLowerCase());
      },
    });

    if (isCancel(selected)) {
      step = "session_name";
      continue;
    }

    if (selected === "__create_set__") {
      const created = await createSessionSetWizard();
      if (created) {
        selectedSet = created;
        step = "provider";
      }
      continue;
    }

    if (selected === "__manage_sets__") {
      await manageSessionSets();
      continue; // re-show set list
    }

    selectedSet = selected as string;
    step = "provider";
    continue;
  } while (false);
  state.selectedSet = selectedSet;
  return step;
}

// ─── STEP 3: Provider selection ────────────────────────────────────────────

export async function stepProvider(state: WizardState): Promise<Step> {
  let step: Step = "provider";
  let { allProviders, discoveredProviders, selectedProviderName, modelValue } = state;
  const { sessionName, lastAllSessions, ollamaModels } = state;
  let configProviders = getConfigProviders();
  do {
    const lastMeta = readProjectMeta();
    const lastProviderRaw = lastMeta?.providerHistory?.[0] ?? null;
    const sessionObj = lastAllSessions.find((s) => s.id === sessionName);
    const sessionProvider = sessionObj?.provider_name ?? null;

    const providerHistory = lastMeta?.providerHistory ?? [];
    const providerOptions: { label: string; value: string; hint?: string }[] = [];

    // Sort all providers (config + discovered): history first, then alphabetical
    const sortedProviders = [...allProviders].sort((a, b) => {
      const aIdx = providerHistory.indexOf(a.name);
      const bIdx = providerHistory.indexOf(b.name);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const p of sortedProviders) {
      // Actual default model: if this provider was used before, last model from history; else config model
      const defaultModel = lastMeta?.modelHistory?.[p.name]?.[0] ?? p.model;
      let hint = defaultModel;
      let label = p.name;
      let extra = "";

      // Mark discovered providers (those without a YAML entry)
      const isDiscovered = discoveredProviders.some((d) => d.name === p.name);
      if (isDiscovered) {
        label = `${p.name} ${pc.dim("(discovered)")}`;
      }

      if (p.name === lastProviderRaw) {
        extra = ` ${pc.dim("(last used)")}`;
        label = `${p.name} ${pc.dim("←")}`;
      } else if (p.name === sessionProvider && !lastProviderRaw) {
        extra = ` ${pc.dim("(session provider)")}`;
      } else if (providerHistory.includes(p.name)) {
        extra = ` ${pc.dim("(history)")}`;
      }

      providerOptions.push({ label, value: p.name, hint: hint + extra });
    }

    // Add local Ollama if running
    if (ollamaModels && ollamaModels.length > 0) {
      const isOllamaDefault = lastProviderRaw === "ollama";
      const inHistory = providerHistory.includes("ollama");
      const toolsCount = ollamaModels.filter((m) => m.supportsTools).length;
      let hint = toolsCount > 0
        ? `${ollamaModels.length} model${ollamaModels.length > 1 ? "s" : ""} (${toolsCount} with tools)`
        : `${ollamaModels.length} model${ollamaModels.length > 1 ? "s" : ""} ⚠️ no tool support`;
      if (isOllamaDefault) hint += ` ${pc.dim("(last used)")}`;
      else if (inHistory) hint += ` ${pc.dim("(history)")}`;
      const opt = {
        label: isOllamaDefault
          ? `🦙 Ollama (local) ${pc.dim("←")}`
          : `🦙 Ollama (local)`,
        value: "ollama",
        hint,
      };

      // Insert at correct position: after history providers, before non-history
      if (isOllamaDefault) {
        providerOptions.unshift(opt);
      } else if (inHistory) {
        // Find last history provider index and insert after
        const lastHistIdx = providerOptions.reduce((max, o, i) =>
          providerHistory.includes(o.value) ? i : max, -1);
        providerOptions.splice(lastHistIdx + 1, 0, opt);
      } else {
        providerOptions.push(opt);
      }
    }

    // ── "Add custom provider..." option always at bottom ────────────
    providerOptions.push({
      label: pc.cyan("🆕 Add custom provider..."),
      value: "__add_provider__",
      hint: pc.dim("OpenAI/Anthropic/Ollama compatible"),
    });

    const selected = await autocomplete({
      message: `Provider: ${pc.dim("(Esc ← back to set selection)")}`,
      placeholder: "Type to filter providers...",
      options: providerOptions,
      maxItems: 10,
      initialValue: lastProviderRaw ?? undefined,
      filter: (search, opt) => {
        const haystack = `${opt.value} ${opt.label} ${opt.hint || ""}`.toLowerCase();
        return haystack.includes(search.toLowerCase());
      },
    });

    if (isCancel(selected)) {
      // Back: sets → session_name
      const hasSets = Object.keys(listSessionSets()).length > 0;
      step = hasSets ? "set" : "session_name";
      continue;
    }

    // ── Handle "Add custom provider..." ───────────────────────────────
    if (selected === "__add_provider__") {
      const created: CreatedProvider | null = await createCustomProviderWizard();
      if (created) {
        // Re-read providers so the new one shows up immediately
        configProviders = getConfigProviders();
        discoveredProviders = getDiscoveredCustomProviders(configProviders);
        allProviders = [...configProviders, ...discoveredProviders];

        // Auto-select the newly created provider
        selectedProviderName = created.id;
        modelValue = "";
        // Models are chosen on the next step
        step = "model";
      }
      // If cancelled, go back to provider list
      continue;
    }

    selectedProviderName = selected as string;
    step = "model";
    continue;
  } while (false);
  state.allProviders = allProviders;
  state.discoveredProviders = discoveredProviders;
  state.selectedProviderName = selectedProviderName;
  state.modelValue = modelValue;
  return step;
}

// ─── STEP 4: Model selection ───────────────────────────────────────────────

export async function stepModel(state: WizardState): Promise<Step> {
  let step: Step = "model";
  let { modelValue } = state;
  const { selectedProviderName, ollamaModels, allProviders } = state;
  do {
    if (!selectedProviderName) { step = "provider"; continue; }

    // ── Ollama: show models directly from detection ──────────────────
    if (selectedProviderName === "ollama") {
      const lastMeta = readProjectMeta();
      const lastModel = lastMeta?.providerHistory?.[0] === "ollama" ? (lastMeta.modelHistory.ollama?.[0] ?? null) : null;

      const modelOptions = ollamaModels!.map((m) => ({
        label: m.name === lastModel
          ? (m.supportsTools ? pc.green(`✦ ${m.name}`) : pc.yellow(`✦ ${m.name}`)) + ` ${pc.dim("← last used")}`
          : m.supportsTools ? m.name : pc.yellow(`${m.name}`),
        value: m.name,
        hint: m.supportsTools ? pc.dim("tools ✅") : pc.dim("tools ❌ — may cause errors"),
      }));

      const selected = await autocomplete({
        message: `Model for ${pc.cyan("🦙 Ollama (local)")}: ${pc.dim("(Esc ← back to provider)")}`,
        placeholder: `Type to filter ${ollamaModels!.length} models...`,
        options: modelOptions,
        maxItems: 15,
        initialValue: lastModel ?? undefined,
        filter: (search, opt) => {
          if (!search) return true;
          return opt.value.toLowerCase().includes(search.toLowerCase());
        },
      });

      if (isCancel(selected)) {
        step = "provider";
        continue;
      }

      modelValue = selected as string;

      // Warn if selected model doesn't support tools
      const selectedModel = ollamaModels!.find((m) => m.name === modelValue);
      if (selectedModel && !selectedModel.supportsTools) {
        log.warn(pc.yellow(`⚠️ "${modelValue}" doesn't support tool calling. Goose uses tools extensively — expect limited functionality.`));
        log.info(pc.dim("  💡 Models that support tools: llama3.x, qwen2.5, mistral, phi-4, etc."));
        log.info(pc.dim("     Pull one: ollama pull llama3.2:3b"));
        const proceed = await confirm({
          message: "Continue anyway?",
          initialValue: false,
        });
        if (isCancel(proceed) || !proceed) {
          step = "model";
          continue;
        }
      }

      step = "launch";
      continue;
    }

    const lastMeta = readProjectMeta();
    const providerCfg = allProviders.find((p) => p.name === selectedProviderName)!;
    const defaultModel = lastMeta?.providerHistory?.[0] === selectedProviderName
      ? (lastMeta.modelHistory[selectedProviderName]?.[0] ?? "")
      : providerCfg?.model ?? "";

    const supportsApiFetch = providerCfg?.engine === "openai" && !!providerCfg?.baseUrl;
    const missingAuth = !providerCfg?.authToken && providerCfg?.apiKeyEnv;

    const modelOptions: { label: string; value: string; hint?: string }[] = [];

    if (defaultModel) {
      const isConfigured = selectedProviderName.startsWith("custom_") && isModelInCustomProviderJson(selectedProviderName, defaultModel);
      modelOptions.push({
        label: pc.green(`✦ ${defaultModel}`),
        value: defaultModel,
        hint: isConfigured ? pc.dim("configured") : undefined,
      });
    }

    // Add history models for this provider (skip if already shown as default)
    const allHistory = lastMeta?.modelHistory?.[selectedProviderName] ?? [];
    const historyModels = allHistory.filter((m) => m !== defaultModel);
    for (const m of historyModels) {
      const isConfigured = selectedProviderName.startsWith("custom_") && isModelInCustomProviderJson(selectedProviderName, m);
      modelOptions.push({
        label: pc.dim(m),
        value: m,
        hint: isConfigured ? pc.dim("configured") : pc.dim("history"),
      });
    }

    // Add models from custom provider JSON (if any) — skip if already shown above
    if (selectedProviderName.startsWith("custom_")) {
      const customModels = getCustomProviderModels(selectedProviderName);
      for (const cm of customModels) {
        if (cm.name !== defaultModel && !historyModels.includes(cm.name)) {
          modelOptions.push({
            label: cm.name,
            value: cm.name,
            hint: pc.dim("configured"),
          });
        }
      }
    }

    modelOptions.push({
      label: pc.bold("✎ Type manually"),
      value: "__manual__",
      hint: defaultModel ? pc.dim(`default: ${defaultModel}`) : "",
    });

    if (supportsApiFetch) {
      modelOptions.push({
        label: missingAuth ? pc.red("🔄 Fetch from API ⚠️") : pc.cyan("🔄 Fetch from API"),
        value: "__api_fetch__",
        hint: missingAuth
          ? pc.yellow(`Set $${providerCfg.apiKeyEnv} first`)
          : providerCfg.baseUrl,
      });
    }

    const modelChoice = await autocomplete({
      message: `Model for ${pc.cyan(selectedProviderName)}: ${pc.dim("(Esc ← back to provider)")}`,
      placeholder: "Type to search or select an option...",
      options: modelOptions,
      maxItems: 12,
      initialValue: defaultModel || undefined,
      filter: (search, opt) => {
        const haystack = `${opt.value} ${opt.label} ${opt.hint || ""}`.toLowerCase();
        return haystack.includes(search.toLowerCase());
      },
    });

    if (isCancel(modelChoice)) {
      step = "provider"; // back to provider
      continue;
    }

    if (modelChoice === "__api_fetch__") {
      let selectedApiContextLimit: number | undefined;
      try {
        const apiModels = await fetchModelsFromApi(providerCfg);

        if (apiModels.length === 0) {
          log.warn(pc.yellow("No models returned from API."));
          const typed = await text({
            message: `Model for ${pc.cyan(selectedProviderName)}: ${pc.dim("(Esc ← back)")}`,
            placeholder: defaultModel || "gpt-4o",
            defaultValue: defaultModel,
          });
          if (isCancel(typed)) { step = "model"; continue; }
          modelValue = (typed as string).trim() || defaultModel;
        } else {
          const apiModelChoice = await autocomplete({
            message: `Select model from ${pc.cyan(providerCfg.baseUrl!)}: ${pc.dim("(Esc ← back)")}`,
            placeholder: `Type to filter ${apiModels.length} models...`,
            options: apiModels.map((m) => ({
              label: m.id,
              value: m.id,
              hint: m.contextLimit ? pc.dim(`context: ${formatNumber(m.contextLimit)}`) : pc.dim("context: 128k default"),
            })),
            maxItems: 15,
            filter: (search, opt) => {
              if (!search) return true;
              return opt.value.toLowerCase().includes(search.toLowerCase());
            },
          });

          if (isCancel(apiModelChoice)) { step = "model"; continue; }
          modelValue = apiModelChoice as string;
          selectedApiContextLimit = apiModels.find((m) => m.id === modelValue)?.contextLimit;
        }
      } catch (err) {
        log.error(pc.red(`Failed to fetch models: ${err}`));
        const typed = await text({
          message: `Model for ${pc.cyan(selectedProviderName)}: ${pc.dim("(Esc ← back)")}`,
          placeholder: defaultModel || "e.g., deepseek/deepseek-v4-flash",
          defaultValue: defaultModel,
        });
        if (isCancel(typed)) { step = "model"; continue; }
        modelValue = (typed as string).trim() || defaultModel;
      }

      // If model is not in provider's JSON file, offer to add it
      if (!isModelInCustomProviderJson(selectedProviderName, modelValue)) {
        const addToJson = await confirm({
          message: `Add "${modelValue}" to "${selectedProviderName}" provider's model list?`,
          initialValue: true,
        });
        if (!isCancel(addToJson) && addToJson) {
          const apiCtxLimit = selectedApiContextLimit;
          const suggestedLimit = formatNumber(apiCtxLimit ?? 128000);
          const ctxInput = await text({
            message: `Context limit for "${modelValue}" (tokens): ${pc.dim(`(Enter for ${suggestedLimit})`)}`,
            placeholder: suggestedLimit,
            defaultValue: String(apiCtxLimit ?? 128000),
            validate: (val) => {
              if (val && val.trim() && isNaN(Number(val.trim()))) return "Must be a number";
              return;
            },
          });
          const contextLimit = !isCancel(ctxInput) && (ctxInput as string).trim()
            ? Number((ctxInput as string).trim())
            : apiCtxLimit ?? 128000;
          if (addModelToCustomProviderJson(selectedProviderName, modelValue, contextLimit)) {
            log.success(pc.green(`✓ Added "${modelValue}" (context_limit: ${formatNumber(contextLimit)}) to ${selectedProviderName} provider config`));
          } else {
            log.warn(pc.yellow(`⚠ Could not update provider config`));
          }
        }
      }
    } else if (modelChoice === "__manual__") {
      const typed = await text({
        message: `Model for ${pc.cyan(selectedProviderName)}: ${pc.dim("(Esc ← back)")}`,
        placeholder: defaultModel || "e.g., deepseek/deepseek-v4-flash",
        defaultValue: defaultModel,
        validate: (val) => (!val || val.trim().length === 0) ? "Model name cannot be empty" : undefined,
      });

      if (isCancel(typed)) { step = "model"; continue; }
      modelValue = (typed as string).trim() || defaultModel;

      // If custom provider and model not in JSON, offer to add with context_limit
      if (selectedProviderName.startsWith("custom_") && !isModelInCustomProviderJson(selectedProviderName, modelValue)) {
        const addToJson = await confirm({
          message: `Add "${modelValue}" to "${selectedProviderName}" provider's model list?`,
          initialValue: true,
        });
        if (!isCancel(addToJson) && addToJson) {
          const ctxInput = await text({
            message: `Context limit for "${modelValue}" (tokens): ${pc.dim("(Enter for 128000)")}`,
            placeholder: "128000",
            defaultValue: "128000",
            validate: (val) => {
              if (val && val.trim() && isNaN(Number(val.trim()))) return "Must be a number";
              return;
            },
          });
          const contextLimit = !isCancel(ctxInput) && (ctxInput as string).trim()
            ? Number((ctxInput as string).trim())
            : 128000;
          if (addModelToCustomProviderJson(selectedProviderName, modelValue, contextLimit)) {
            log.success(pc.green(`✓ Added "${modelValue}" (context_limit: ${formatNumber(contextLimit)}) to ${selectedProviderName} provider config`));
          } else {
            log.warn(pc.yellow(`⚠ Could not update provider config`));
          }
        }
      }
    } else {
      modelValue = modelChoice as string;
    }

    step = "launch";
    continue;
  } while (false);
  state.modelValue = modelValue;
  return step;
}

