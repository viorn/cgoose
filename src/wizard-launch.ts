/**
 * rossii — CLI launch-mode resolution and the final wizard step.
 *
 * `resolveLaunchMode` turns the positional flags into a launch mode and
 * fast-forwards `rossii a` / `rossii n` to the summary; `stepLaunch` renders
 * the configuration summary and hands the resolved run over to the launcher.
 */

import { resolve } from "node:path";
import { confirm, isCancel, log, outro } from "@clack/prompts";
import pc from "picocolors";

import { generateSessionName } from "./utils";
import { listSessionSets } from "./rossii-config";
import { readProjectMeta } from "./project";
import { getAllSessions } from "./sessions";
import { getRepoWorktreePaths } from "./worktree";
import { launchGoose, launchGooseAcp, DEFAULT_PROFILE_SENTINEL } from "./launcher";
import type { ProviderInfo } from "./config";

import type { Step, LaunchMode, WizardState } from "./wizard-steps";

// ─── CLI launch mode ────────────────────────────────────────────────────────

/** Resolve the CLI launch mode from the positional flags (after alias mapping)
 *  and fast-forward `rossii a` / `rossii n` from the project meta. Returns the
 *  step the wizard starts on. */
export async function resolveLaunchMode(args: string[], state: WizardState): Promise<Step> {
  // Detect "fork" mode (e) — edit/fork existing sessions
  const isEditMode = args.includes("e") || args.includes("me") || args.includes("we");

  // Resolve mode: shortcuts like w*/m* are composed, plain "w" / "m" falls back to full
  let mode: LaunchMode;
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
  state.mode = mode;

  if (mode === "auto" || mode === "new" || mode === "session-only") {
    const meta = readProjectMeta();
    if (meta) {
      state.selectedProviderName = meta.providerHistory?.[0] ?? "";
      state.modelValue = meta.modelHistory[meta.providerHistory?.[0] ?? ""]?.[0] ?? "";
      state.selectedSet = meta.setHistory?.[0] ?? "";
    }
  }

  if (mode === "auto") {
    // Quick resume: find last session in this directory or its worktrees
    if (!state.selectedProviderName) {
      log.warn(pc.yellow("No previous session data for this project. Falling back to full workflow."));
    } else {
      const allSessions = getAllSessions();
      const cwd = resolve(".");
      // Also consider sessions from git worktrees managed by rossii
      const worktreeDirs = state.noWorktree ? [] : getRepoWorktreePaths();
      const relevantDirs = [cwd, ...worktreeDirs];
      const dirSessions = allSessions.filter((s) => relevantDirs.includes(s.working_dir));
      const lastSession = dirSessions.sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )[0];
      if (lastSession) {
        state.lastAllSessions = allSessions; // ← populate so launch step can resolve display name
        state.sessionName = lastSession.id;
        state.isNewSession = false;
        state.quickLaunch = true;
        return "launch";
      } else {
        log.warn(pc.yellow("No sessions found for this project. Falling back to full workflow."));
      }
    }
  }

  if (mode === "new") {
    // Quick new: skip straight to launch
    if (!state.selectedProviderName) {
      log.warn(pc.yellow("No previous session data for this project. Falling back to full workflow."));
    } else {
      state.isNewSession = true;
      // Generate the name up front: the worktree directory/branch and the
      // goose session title must share it, otherwise resume cannot find the
      // worktree (quick-new used to launch with an auto-named session).
      state.sessionName = generateSessionName(state.sessionPrefix);
      state.quickLaunch = true;
      return "launch";
    }
  }

  return "session";
}

// ─── STEP 5: Summary & Launch ───────────────────────────────────────────────

export async function stepLaunch(state: WizardState): Promise<Step | null> {
  let step: Step = "launch";
  const {
    isNewSession, sessionName, lastAllSessions, selectedProviderName, modelValue,
    selectedSet, quickLaunch, isChatMode, allProviders,
  } = state;
  do {
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
    // Show set info
    const setLine = formatSetLine(selectedSet);

    const chatLaunchOptions: Parameters<typeof launchGooseAcp>[0] = {
      sessionName: isNewSession ? sessionName : resolvedSessionName,
      providerInfo: providerCfg,
      model: modelValue,
      isNew: isNewSession,
      resumeSessionId: isNewSession ? undefined : sessionName,
      // `session/load` keeps the provider/model stored in the session row,
      // so the chat needs them to tell "unchanged" from "switched" and
      // apply the wizard's choice through `session/set_config_option`.
      resumeConfig: sessionObj
        ? {
            provider: sessionObj.provider_name,
            model: sessionObj.model_config?.model_name ?? null,
          }
        : undefined,
      sessionDisplayName: resolvedSessionName,
      sessionSet: selectedSet,
    };

    // `rossii a` / `rossii n`: the pickers were skipped on purpose, so in
    // chat mode the chat opens right away — no summary, no confirmation.
    if (quickLaunch && isChatMode) {
      await launchGooseAcp(chatLaunchOptions);
      return null; // chat closed
    }

    outro(
      `${pc.green("✓")} Configuration complete:
  ${pc.bold("Session")}:  ${pc.cyan(displayName)}
  ${pc.bold("Provider")}: ${pc.yellow(displayProvider)}
  ${pc.bold("Model")}:    ${pc.magenta(modelValue)}${setLine}`,
    );

    const shouldLaunch = await confirm({ message: `Launch Goose now? ${pc.dim("(Esc ← back to sessions)")}`, initialValue: true });

    if (isCancel(shouldLaunch) || !shouldLaunch) {
      step = "session"; // back to the beginning
      continue;
    }

    if (isChatMode) {
      await launchGooseAcp(chatLaunchOptions);
      return null; // chat closed
    }
    launchGoose(sessionName, providerCfg, modelValue, isNewSession, resolvedSessionName, selectedSet);
    return null; // never reached — launchGoose replaces process
  } while (false);
  return step;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** `\n  Set:     <title>` line shown in the final configuration summary. */
export function formatSetLine(selectedSet: string): string {
  const allSets = listSessionSets();
  const setObj = selectedSet && selectedSet !== DEFAULT_PROFILE_SENTINEL
    ? allSets[selectedSet]
    : undefined;
  const displaySet = setObj
    ? setObj.title
    : selectedSet === DEFAULT_PROFILE_SENTINEL
      ? "Default (goose config.yaml)"
      : "none (no extensions)";
  return `\n  ${pc.bold("Set")}:     ${pc.cyan(displaySet)}`;
}

