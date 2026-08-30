#!/usr/bin/env bun
/**
 * cgoose — TUI for Goose AI Sessions
 *
 * CLI flags (single-letter, like tmux):
 *   e    Edit mode: choose a session → choose a user message → rollback
 *        (permanently delete messages from that point forward).
 *   m    No-worktree: run interactively without git worktree isolation
 *   w    Force worktree: enable git worktree isolation (overrides CGOOSE_NO_WORKTREE=1)
 *   a    Auto-resume: quick resume to last session in this directory
 *   n    New session: skip pickers, start new with last provider/model
 *   s    Sessions only: picker only, then launch with last provider/model
 *   ma   Like a but without git worktree isolation (shortcut for m+a)
 *   ms   Like s but without git worktree isolation (shortcut for m+s)
 *   mn   Like n but without git worktree isolation (shortcut for m+n)
 *   wa   Like a but with worktree forced on (shortcut for w+a)
 *   ws   Like s but with worktree forced on (shortcut for w+s)
 *   wn   Like n but with worktree forced on (shortcut for w+n)
 *   me   Edit mode without git worktree isolation
 *   we   Edit mode with worktree forced on
 *
 * Entry point. Imports all modules and runs the interactive TUI loop.
 */

import process from "node:process";
import { resolve } from "node:path";
import {
  autocomplete, confirm, intro, isCancel, log, outro, select, spinner, text, multiselect,
} from "@clack/prompts";
import pc from "picocolors";

import { getCurrentDirName, generateSessionName } from "./utils";
import { readCgooseConfig } from "./cgoose-config";
import { getConfigProviders, getDiscoveredCustomProviders, loadConfigEnvVars, isModelInCustomProviderJson, addModelToCustomProviderJson, getCustomProviderModels, type ProviderInfo } from "./config";
import { createCustomProviderWizard, type CreatedProvider } from "./provider-creator";
import { readProjectMeta, getWorktreeMappings, removeWorktreeMapping } from "./project";
import { getAllSessions, deleteSessionById, formatSessionHint, type GooseSession } from "./sessions";
import { detectOllama, fetchModelsFromApi, type OllamaModelInfo, type ApiModelInfo } from "./models";
import { launchGoose } from "./launcher";
import { getProjectSessionDirs, getRepoWorktreePaths, isInsideGitRepo, removeWorktree } from "./worktree";

// ─── Types ───────────────────────────────────────────────────────────────────

type Step = "session" | "session_name" | "provider" | "model" | "launch";

// ─── Session deletion dialog ─────────────────────────────────────────────────

async function handleDeleteSessions(
  _allSessions: GooseSession[],
  dirSessions: GooseSession[],
): Promise<boolean> {
  // Count empty sessions
  const emptySessions = dirSessions.filter((s) => s.message_count === 0);

  // 1) Choose mode
  const mode = await select({
    message: "Delete sessions:",
    options: [
      { value: "select", label: "Select individually" },
      { value: "empty", label: "Clean empty sessions", hint: "(" + emptySessions.length + " sessions)" },
      { value: "all", label: "Clean all sessions in this directory", hint: "(" + dirSessions.length + " sessions)" },
      { value: "back", label: "\u2190 Go back" },
    ],
  });

  if (isCancel(mode) || mode === "back") return false;

  if (mode === "empty") {
    if (emptySessions.length === 0) {
      log.info(pc.dim("No empty sessions in this directory."));
      return false;
    }
    const confirmed = await confirm({
      message: "Delete " + emptySessions.length + " empty sessions in " + pc.cyan(resolve(".")) + "?",
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) return false;

    const s = spinner();
    s.start("Deleting " + emptySessions.length + " empty sessions...");
    let ok = 0, fail = 0;
    for (const session of emptySessions) {
      if (deleteSessionById(session.id)) {
        ok++;
        // Clean up associated worktree (mapped by session NAME, not UUID id)
        const wtMappings = getWorktreeMappings();
        if (wtMappings[session.name]) {
          removeWorktree(session.name);
          removeWorktreeMapping(session.name);
        }
      } else fail++;
    }
    s.stop("Done: " + ok + " deleted, " + fail + " failed");
    return true;
  }

  if (mode === "all") {
    if (dirSessions.length === 0) {
      log.info(pc.dim("No sessions in this directory."));
      return false;
    }
    const confirmed = await confirm({
      message: "Delete all " + dirSessions.length + " sessions in " + pc.cyan(resolve(".")) + "?",
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) return false;

    const s = spinner();
    s.start("Deleting " + dirSessions.length + " sessions...");
    let ok = 0, fail = 0;
    for (const session of dirSessions) {
      if (deleteSessionById(session.id)) {
        ok++;
        const wtMappings = getWorktreeMappings();
        if (wtMappings[session.name]) {
          removeWorktree(session.name);
          removeWorktreeMapping(session.name);
        }
      } else fail++;
    }
    s.stop("Done: " + ok + " deleted, " + fail + " failed");
    return true;
  }

  // 2) Select individually via multiselect
  const sessionOptions = dirSessions.map(function(s) {
    const h = formatSessionHint(s);
    return { label: h.name, value: s.id, hint: h.hint };
  });

  if (sessionOptions.length === 0) {
    log.info(pc.dim("No sessions to delete."));
    return false;
  }

  const selectedIDs = await multiselect({
    message: "Select sessions to delete (Space to toggle, Enter to confirm):",
    options: sessionOptions,
    required: false,
  });

  if (isCancel(selectedIDs) || !selectedIDs || selectedIDs.length === 0) return false;

  const s = spinner();
  s.start("Deleting " + selectedIDs.length + " session(s)...");
  let ok = 0, fail = 0;
  for (const id of selectedIDs as string[]) {
    if (deleteSessionById(id)) {
      ok++;
      const session = _allSessions.find((s) => s.id === id);
      const sessionName = session?.name ?? id;
      const wtMappings = getWorktreeMappings();
      if (wtMappings[sessionName]) {
        removeWorktree(sessionName);
        removeWorktreeMapping(sessionName);
      }
    } else fail++;
  }
  s.stop("Done: " + ok + " deleted, " + fail + " failed");
  return true;
}

// ─── Main TUI ────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  intro(`${pc.bgCyan(pc.black(" cgoose "))} ${pc.dim("— TUI for Goose AI Sessions")}`);

  const projectName = getCurrentDirName();
  const sessionPrefix = projectName;
  loadConfigEnvVars();
  let configProviders = getConfigProviders();
  // Discover custom providers that have JSON files but aren't in config.yaml
  let discoveredProviders = getDiscoveredCustomProviders(configProviders);
  // All known providers = from config.yaml/enriched + discovered from JSON only
  let allProviders = [...configProviders, ...discoveredProviders];
  const ollamaModels = await detectOllama();

  const hasAnyProvider = allProviders.length > 0 || (ollamaModels !== null && ollamaModels.length > 0);

  if (!hasAnyProvider) {
    log.error(pc.red('\u2716 No enabled providers found in ' + resolve('.config/goose/config.yaml')));
    log.info(pc.dim("  Run 'goose configure' to set up a provider first, or install Ollama (ollama.com)."));
    process.exit(1);
  }

  // ─── State shared across steps ───────────────────────────────────────────
  let step: Step = "session";
  let sessionName = "";
  let sessionDisplayName = ""; // human-readable name (for worktree lookups)
  let isNewSession = false;
  let selectedProviderName = "";
  let modelValue = "";
  let lastAllSessions: GooseSession[] = [];

  // ─── CLI flags ───────────────────────────────────────────────────────────
  const args = process.argv.slice(2);

  // Detect worktree force flag (w, wa, ws, wn) — overrides CGOOSE_NO_WORKTREE
  const forceWorktree = args.includes("w") || args.includes("wa") || args.includes("ws") || args.includes("wn");
  if (forceWorktree) {
    process.env.CGOOSE_FORCE_WORKTREE = "1";
    delete process.env.CGOOSE_NO_WORKTREE;
  }

  // Detect "fork" mode (e) — edit/fork existing sessions
  const isEditMode = args.includes("e") || args.includes("me") || args.includes("we");

  // Detect "minimal" variants (ma, ms, mn, m) — no worktree, root-only sessions
  let noWorktree = !forceWorktree && (args.includes("m") || args.includes("ma") || args.includes("ms") || args.includes("mn"));
  if (noWorktree) {
    process.env.CGOOSE_NO_WORKTREE = "1";
  }

  // If no explicit CLI override, check cgoose config for default mode
  if (!forceWorktree && !noWorktree) {
    const cgooseConfig = readCgooseConfig();
    if (cgooseConfig.default_mode === "no-worktree") {
      process.env.CGOOSE_NO_WORKTREE = "1";
      noWorktree = true;
    }
  }

  // Resolve mode: shortcuts like w*/m* are composed, plain "w" / "m" falls back to full
  let mode: string;
  if (isEditMode) {
    mode = "edit";
  } else if (args.includes("wa")) {
    mode = "auto";
  } else if (args.includes("wn")) {
    mode = "new";
  } else if (args.includes("ws")) {
    mode = "session-only";
  } else if (args.includes("w")) {
    mode = "full";
  } else if (args.includes("ma")) {
    mode = "auto";
  } else if (args.includes("mn")) {
    mode = "new";
  } else if (args.includes("ms")) {
    mode = "session-only";
  } else if (args.includes("m")) {
    mode = "full";
  } else {
    mode = args.includes("a") ? "auto" : args.includes("n") ? "new" : args.includes("s") ? "session-only" : "full";
  }

  if (mode === "auto" || mode === "new" || mode === "session-only") {
    const meta = readProjectMeta();
    if (meta) {
      selectedProviderName = meta.provider;
      modelValue = meta.modelHistory[meta.provider]?.[0] ?? "";
    }
  }

  if (mode === "auto") {
    // Quick resume: find last session in this directory or its worktrees
    if (!selectedProviderName) {
      log.warn(pc.yellow("No previous session data for this project. Falling back to full workflow."));
    } else {
      const allSessions = getAllSessions();
      const cwd = resolve(".");
      // Also consider sessions from git worktrees managed by cgoose
      const worktreeDirs = noWorktree ? [] : getRepoWorktreePaths();
      const relevantDirs = [cwd, ...worktreeDirs];
      const dirSessions = allSessions.filter((s) => relevantDirs.includes(s.working_dir));
      const lastSession = dirSessions.sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )[0];
      if (lastSession) {
        lastAllSessions = allSessions; // ← populate so launch step can resolve display name
        sessionName = lastSession.id;
        isNewSession = false;
        step = "launch";
      } else {
        log.warn(pc.yellow("No sessions found for this project. Falling back to full workflow."));
      }
    }
  }

  if (mode === "new") {
    // Quick new: skip straight to launch
    if (!selectedProviderName) {
      log.warn(pc.yellow("No previous session data for this project. Falling back to full workflow."));
    } else {
      isNewSession = true;
      step = "launch";
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Navigation loop — each Esc/cancel goes back one step
  // ═══════════════════════════════════════════════════════════════════════════

  while (true) {
    switch (step) {
      // ─── STEP 1: Session selection ──────────────────────────────────────
      case "session": {
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
          step = "provider";
        }
        continue;
      }

      // ─── STEP 2: Session name (only for new sessions) ───────────────────
      case "session_name": {
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
          step = "provider";
        }
        continue;
      }

      // ─── STEP 3: Provider selection ─────────────────────────────────────
      case "provider": {
        const lastMeta = readProjectMeta();
        const lastProviderRaw = lastMeta?.provider ?? null;
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
          message: `Provider: ${pc.dim("(Esc ← back to sessions)")}`,
          placeholder: "Type to filter providers...",
          options: providerOptions,
          maxItems: 10,
          filter: (search, opt) => {
            const haystack = `${opt.value} ${opt.label} ${opt.hint || ""}`.toLowerCase();
            return haystack.includes(search.toLowerCase());
          },
        });

        if (isCancel(selected)) {
          step = "session"; // back to session list
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
      }

      // ─── STEP 4: Model selection ────────────────────────────────────────
      case "model": {
        if (!selectedProviderName) { step = "provider"; continue; }

        // ── Ollama: show models directly from detection ──────────────────
        if (selectedProviderName === "ollama") {
          const lastMeta = readProjectMeta();
          const lastModel = lastMeta?.provider === "ollama" ? (lastMeta.modelHistory.ollama?.[0] ?? null) : null;

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
        const defaultModel = lastMeta?.provider === selectedProviderName
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
                  hint: m.contextLimit ? pc.dim(`context: ${m.contextLimit.toLocaleString("ru-RU")}`) : pc.dim("context: 128k default"),
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
              const suggestedLimit = (apiCtxLimit ?? 128000).toLocaleString("ru-RU");
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
                log.success(pc.green(`✓ Added "${modelValue}" (context_limit: ${contextLimit.toLocaleString("ru-RU")}) to ${selectedProviderName} provider config`));
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
                log.success(pc.green(`✓ Added "${modelValue}" (context_limit: ${contextLimit.toLocaleString("ru-RU")}) to ${selectedProviderName} provider config`));
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
      }

      // ─── EDIT STEP 1: Session selection (no create/delete) ─────────────
      // ─── STEP 5: Summary & Launch ───────────────────────────────────────
      case "launch": {
        // Resolve session name for worktree mapping:
        // - New sessions: sessionName is the name passed to Goose
        // - Resumed sessions: sessionName is the session ID UUID,
        //   but worktree is keyed by the session's original name
        const sessionObj = !isNewSession ? lastAllSessions.find((s) => s.id === sessionName) : null;
        const resolvedSessionName = sessionObj?.name ?? sessionName;

        const providerCfg: ProviderInfo = selectedProviderName === "ollama"
          ? { name: "ollama", model: modelValue, engine: "ollama" }
          : allProviders.find((p) => p.name === selectedProviderName)!;
        const displayName = resolvedSessionName || "(auto)";
        const displayProvider = selectedProviderName === "ollama"
          ? "🦙 Ollama (local)"
          : selectedProviderName;
        outro(
          `${pc.green("✓")} Configuration complete:
  ${pc.bold("Session")}:  ${pc.cyan(displayName)}
  ${pc.bold("Provider")}: ${pc.yellow(displayProvider)}
  ${pc.bold("Model")}:    ${pc.magenta(modelValue)}`,
        );

        const shouldLaunch = await confirm({ message: `Launch Goose now? ${pc.dim("(Esc ← back to sessions)")}`, initialValue: true });

        if (isCancel(shouldLaunch) || !shouldLaunch) {
          step = "session"; // back to the beginning
          continue;
        }

        launchGoose(sessionName, providerCfg, modelValue, isNewSession, resolvedSessionName);
        return; // never reached — launchGoose replaces process
      }
    }
  }
}

main().catch((err) => {
  console.error(pc.red("\n✖ Fatal error:"), err);
  process.exit(1);
});