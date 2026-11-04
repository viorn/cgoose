/**
 * Launch Goose: classic TUI mode (`goose session`) or rossii chat mode
 * (`goose acp` + own TUI).
 *
 * Classic mode always uses `goose session` (never `goose run --recipe`).
 * Session sets (system prompt + extensions) are applied via:
 *   - Extensions → CLI flags (--with-builtin, --with-extension)
 *   - System prompt → --system flag
 *
 * Chat (ACP) mode spawns `goose acp`, negotiates the Agent Client Protocol
 * over stdio and renders the dialog itself (src/acp/chat.ts). Session sets are
 * applied via builtins on the agent command line (`--with-builtin`), stdio/http
 * extensions in the standard ACP `session/new.mcpServers` field, and the goose
 * custom request `_goose/unstable/session/system-prompt/set`.
 *
 * Git worktree integration (both modes):
 * - New sessions create a git worktree (<repo-root>/.worktree/<name>) and launch Goose there
 * - Resuming existing sessions check for an existing worktree and launch there if found
 * - Skips worktree creation if not in a git repo or ROSSII_NO_WORKTREE=1 is set
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import pc from "picocolors";
import { writeProjectMeta, saveWorktreeMapping } from "./project";
import { getModelContextLimit, getGooseSecrets } from "./config";
import type { ProviderInfo } from "./config";
import { readRossiiConfig, getSessionSet } from "./rossii-config";
import type { SessionSet } from "./rossii-config";
import { buildExtensionArgs } from "./goose-extensions";
import { isInsideGitRepo, createWorktree, getSessionWorktreePath, getRepoRoot } from "./worktree";
import { env, hasEnv, setEnv, getCurrentDirName, generateSessionName } from "./utils";
import { runAcpChat } from "./acp/chat";

/**
 * Sentinel value for the "Default" pseudo-set: load Goose's default profile
 * (i.e. the extensions enabled in ~/.config/goose/config.yaml).
 */
export const DEFAULT_PROFILE_SENTINEL = "__default__";

// ─── Shared launch preparation ───────────────────────────────────────────────

export interface PreparedLaunch {
  /** Resolved session set, or undefined for None / Default. */
  set: SessionSet | undefined;
  useDefaultProfile: boolean;
  /** Worktree directory to run in, if any. */
  worktreePath: string | null;
  /** Stable worktree/branch name. */
  worktreeName: string;
  /** Environment for the goose process (config secrets, provider, context limit). */
  launchEnv: Record<string, string>;
}

/**
 * Everything both launch modes need before spawning: project meta, worktree,
 * `.goose/config.yaml` secrets, custom-provider env and context limit.
 */
export function prepareLaunch(
  sessionName: string,
  providerInfo: ProviderInfo,
  model: string,
  isNew: boolean,
  /** Session's original name (from db), for worktree lookup on resume. */
  sessionDisplayName?: string,
  /** Session set name; see DEFAULT_PROFILE_SENTINEL and "" (None). */
  sessionSet?: string,
): PreparedLaunch {
  writeProjectMeta(providerInfo.name, model, sessionSet);

  const useDefaultProfile = sessionSet === DEFAULT_PROFILE_SENTINEL;
  const set = sessionSet && !useDefaultProfile ? getSessionSet(sessionSet) : undefined;

  // ─── Git worktree setup ────────────────────────────────────────────────
  let worktreePath: string | null = null;
  const forceWorktree = env("FORCE_WORKTREE") === "1";

  if (!forceWorktree && !hasEnv("NO_WORKTREE")) {
    const rossiiConfig = readRossiiConfig();
    if (rossiiConfig.default_mode === "no-worktree") {
      setEnv("NO_WORKTREE", "1");
    }
  }
  const noWorktree = forceWorktree ? false : env("NO_WORKTREE") === "1";

  const worktreeName = sessionDisplayName || sessionName || generateSessionName(getCurrentDirName());

  if (!noWorktree && isInsideGitRepo()) {
    if (isNew) {
      worktreePath = createWorktree(worktreeName);
      if (worktreePath) {
        console.log(pc.dim(`  📂 Worktree: ${pc.cyan(worktreePath)}`));
        console.log(pc.dim(`  🌿 Branch:   ${pc.green(worktreeName)}`));
        saveWorktreeMapping(worktreeName, worktreePath);
      }
    } else {
      worktreePath = getSessionWorktreePath(worktreeName);
      if (worktreePath) {
        console.log(pc.dim(`  📂 Resuming worktree: ${pc.cyan(worktreePath)}`));
      }
    }
  }

  // ─── Provider env setup ──────────────────────────────────────────────────
  const launchEnv: Record<string, string> = { ...process.env as Record<string, string> };

  // ─── Goose additional config ────────────────────────────────────────────
  const configDir = worktreePath && existsSync(join(worktreePath, ".goose", "config.yaml"))
    ? worktreePath
    : getRepoRoot();
  if (configDir) {
    const configPath = join(configDir, ".goose", "config.yaml");
    if (existsSync(configPath)) {
      console.log(pc.dim(`  📋 Config:   ${pc.cyan(configPath)}`));
      launchEnv["GOOSE_ADDITIONAL_CONFIG_FILES"] = configPath;

      // Resolve environment variable references from the config file via Goose secrets
      const secrets = getGooseSecrets();
      if (Object.keys(secrets).length > 0) {
        const raw = readFileSync(configPath, "utf-8");
        const envRefRegex = /\$\{?(\w+)\}?/g;
        const foundKeys = new Set<string>();
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const colonIdx = trimmed.indexOf(":");
          if (colonIdx === -1) continue;
          const value = trimmed.slice(colonIdx + 1).trim();
          if (!value) continue;
          let match;
          while ((match = envRefRegex.exec(value)) !== null) {
            foundKeys.add(match[1]);
          }
        }
        for (const key of foundKeys) {
          if (secrets[key] !== undefined) {
            launchEnv[key] = secrets[key];
          }
        }
      }
    }
  }

  if (providerInfo.engine && providerInfo.baseUrl) {
    for (const k of ["OPENAI_HOST", "OPENAI_BASE_PATH", "OPENAI_BASE_URL"]) {
      delete launchEnv[k];
    }
    launchEnv["OPENAI_BASE_URL"] = providerInfo.baseUrl;
    if (providerInfo.authToken) {
      launchEnv["OPENAI_API_KEY"] = providerInfo.authToken;
    }
  }

  // Set GOOSE_CONTEXT_LIMIT from custom provider JSON
  if (providerInfo.name.startsWith("custom_")) {
    const contextLimit = getModelContextLimit(providerInfo.name, model);
    if (contextLimit !== undefined) {
      delete launchEnv["GOOSE_CONTEXT_LIMIT"];
      launchEnv["GOOSE_CONTEXT_LIMIT"] = String(contextLimit);
    }
  }

  return { set, useDefaultProfile, worktreePath, worktreeName, launchEnv };
}

/** Shared launch summary lines (both modes print the same shape). */
function printSummary(
  sessionName: string,
  providerInfo: ProviderInfo,
  model: string,
  prepared: PreparedLaunch,
  extra: string[] = [],
): void {
  const setLabel = prepared.set
    ? pc.green(prepared.set.title)
    : prepared.useDefaultProfile
      ? pc.green("Default") + pc.dim(" (goose config.yaml)")
      : pc.dim("none (no extensions)");
  const setLine = `\n  ${pc.dim("Set:")}      ${setLabel}`;
  const summary = [
    `\n${pc.green("🚀")} ${pc.bold("Launching Goose...")}`,
    `  ${pc.dim("Session:")}  ${pc.cyan(sessionName)}`,
    `  ${pc.dim("Provider:")} ${pc.yellow(providerInfo.name)}`,
    `  ${pc.dim("Model:")}    ${pc.magenta(model)}${setLine}`,
    ...extra,
  ];
  if (prepared.worktreePath) {
    summary.push(`  ${pc.dim("Workdir:")}  ${pc.cyan(prepared.worktreePath)}`);
  }
  summary.push("");
  console.log(summary.join("\n"));
}

// ─── Classic mode: spawn `goose session` TUI ─────────────────────────────────

export function launchGoose(
  sessionName: string,
  providerInfo: ProviderInfo,
  model: string,
  isNew: boolean,
  /** Session's original name (from db), for worktree lookup on resume.
   *  On resume, sessionName is the UUID; this is the human-readable name. */
  sessionDisplayName?: string,
  /** Session set name; see DEFAULT_PROFILE_SENTINEL and "" (None). */
  sessionSet?: string,
): void {
  const prepared = prepareLaunch(sessionName, providerInfo, model, isNew, sessionDisplayName, sessionSet);
  const { set, useDefaultProfile } = prepared;

  const args: string[] = [];

  if (isNew) {
    args.push("session");
    if (sessionName) {
      args.push("--name", sessionName);
    }
    args.push("--provider", providerInfo.name, "--model", model);

    if (set) {
      if (set.systemPrompt) {
        args.push("--system", set.systemPrompt);
      }

      const extArgs = buildExtensionArgs(set.extensions ?? []);
      for (const warning of extArgs.warnings) {
        console.log(pc.yellow(`  ⚠ ${warning}`));
      }

      const builtins = [...new Set([...set.builtins, ...extArgs.builtins])];
      if (builtins.length > 0) {
        args.push("--with-builtin", builtins.join(","));
      }

      for (const ext of [...(set.stdioExtensions ?? []), ...extArgs.stdio]) {
        args.push("--with-extension", ext);
      }

      for (const uri of extArgs.http) {
        args.push("--with-streamable-http-extension", uri);
      }

      args.push("--no-profile");
    } else if (!useDefaultProfile) {
      args.push("--no-profile");
    }
  } else {
    // Resume — the selected set is the source of truth for the system prompt.
    // Goose >= 1.55 persists --system in the session DB (system_prompt_extras),
    // so merely omitting --system RESTORES a previously stored prompt instead of
    // clearing it. Pass an explicit empty value when no set is selected so that
    // "no set" really means "no additional system prompt".
    // Note: Goose restores the extension set stored in the session DB on resume
    // and ignores extension flags, so how the session was originally started wins.
    args.push("session", "--resume", "--history");
    if (sessionName) {
      // Use --session-id, NOT --name: goose resolves --name through
      // SessionStorage::list_sessions(), which only returns user+scheduled
      // sessions — sessions created by an ACP client that does not send
      // `_meta.client` are stored as "acp" and are not found that way.
      // --session-id goes straight to get_session(), which has no
      // session_type filter.
      args.push("--session-id", sessionName);
    }
    args.push("--provider", providerInfo.name, "--model", model);
    args.push("--system", set?.systemPrompt ?? "");
  }

  printSummary(sessionName, providerInfo, model, prepared, [
    ...(env("DEBUG") === "1"
      ? [`  ${pc.dim("Command:")}  ${pc.dim(`goose ${args.join(" ")}`)}`]
      : []),
  ]);

  const spawnOpts: Record<string, unknown> = { stdio: "inherit", env: prepared.launchEnv };
  if (prepared.worktreePath) {
    spawnOpts.cwd = prepared.worktreePath;
  }

  // Spawn goose; we intentionally don't await — the child process takes over the terminal.
  const child = spawn("goose", args, spawnOpts as any);
  child.on("exit", () => {
    /* goose exited */
  });
}

// ─── Chat mode: `goose acp` + own TUI ────────────────────────────────────────

export interface AcpLaunchOptions {
  sessionName: string;
  providerInfo: ProviderInfo;
  model: string;
  isNew: boolean;
  /** On resume: the goose session id (from sessions.db) to load. */
  resumeSessionId?: string;
  /**
   * On resume: provider/model currently stored in the session row, so the chat
   * can tell an unchanged choice from a real switch (`session/load` keeps the
   * stored pair, `session/set_config_option` changes it).
   */
  resumeConfig?: { provider?: string | null; model?: string | null };
  sessionDisplayName?: string;
  sessionSet?: string;
}

/** Check that the installed goose supports the `acp` subcommand. */
function gooseAcpSupported(): boolean {
  try {
    execSync("goose acp --help", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Chat mode: run goose as an ACP agent and render the conversation with the
 * pi-tui based chat UI (src/acp/chat.ts). Resolves when the chat is closed.
 * Falls back to the classic `goose session` TUI when the installed goose has
 * no `acp` subcommand.
 */
export async function launchGooseAcp(opts: AcpLaunchOptions): Promise<void> {
  if (!gooseAcpSupported()) {
    console.log(pc.yellow("  ⚠ Installed goose has no `acp` subcommand — falling back to classic TUI"));
    launchGoose(opts.sessionName, opts.providerInfo, opts.model, opts.isNew, opts.sessionDisplayName, opts.sessionSet);
    return;
  }

  const prepared = prepareLaunch(
    opts.sessionName,
    opts.providerInfo,
    opts.model,
    opts.isNew,
    opts.sessionDisplayName,
    opts.sessionSet,
  );

  // Provider/model selection must reach the ACP agent: goose reads these env
  // vars when resolving the session's provider and model.
  prepared.launchEnv["GOOSE_PROVIDER"] = opts.providerInfo.name;
  prepared.launchEnv["GOOSE_MODEL"] = opts.model;

  // Builtins go on the agent command line (`goose acp --with-builtin`); stdio
  // and streamable-http extensions travel per-session in `session/new.mcpServers`.
  const set = prepared.set;
  const extArgs = set ? buildExtensionArgs(set.extensions ?? []) : { builtins: [], stdio: [], http: [], warnings: [] };
  for (const warning of extArgs.warnings) {
    console.log(pc.yellow(`  ⚠ ${warning}`));
  }
  const agentBuiltins = set
    ? [...new Set([...set.builtins, ...extArgs.builtins])]
    : [];

  printSummary(opts.sessionName, opts.providerInfo, opts.model, prepared, [
    ...(env("DEBUG") === "1"
      ? [`  ${pc.dim("Command:")}  ${pc.dim("goose acp")}`]
      : []),
  ]);

  await runAcpChat({
    cwd: prepared.worktreePath ?? process.cwd(),
    env: prepared.launchEnv,
    isNew: opts.isNew,
    resumeSessionId: opts.resumeSessionId,
    sessionTitle: opts.sessionName || undefined,
    provider: opts.providerInfo.name,
    model: opts.model,
    resumeConfig: opts.resumeConfig,
    set,
    useDefaultProfile: prepared.useDefaultProfile,
    agentBuiltins,
    stdioExtensionSpecs: set ? [...(set.stdioExtensions ?? []), ...extArgs.stdio] : [],
    httpExtensionUris: extArgs.http,
  });
}
