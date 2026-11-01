/**
 * Launch Goose with session name, provider, model, and optional session set.
 *
 * Always uses `goose session` (never `goose run --recipe`).
 * Session sets (system prompt + extensions) are applied via:
 *   - Extensions → CLI flags (--with-builtin, --with-extension)
 *   - System prompt → --system flag
 *
 * Git worktree integration:
 * - New sessions create a git worktree (<repo-root>/.worktree/<name>) and launch Goose there
 * - Resuming existing sessions check for an existing worktree and launch there if found
 * - Skips worktree creation if not in a git repo or CGOOSE_NO_WORKTREE=1 is set
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import pc from "picocolors";
import { writeProjectMeta, saveWorktreeMapping } from "./project";
import { getModelContextLimit, getGooseSecrets } from "./config";
import type { ProviderInfo } from "./config";
import { readCgooseConfig, getSessionSet } from "./cgoose-config";
import { buildExtensionArgs } from "./goose-extensions";
import { isInsideGitRepo, createWorktree, getSessionWorktreePath, getRepoRoot } from "./worktree";
import { getCurrentDirName, generateSessionName } from "./utils";

/**
 * Sentinel value for the "Default" pseudo-set: load Goose's default profile
 * (i.e. the extensions enabled in ~/.config/goose/config.yaml).
 */
export const DEFAULT_PROFILE_SENTINEL = "__default__";

export function launchGoose(
  sessionName: string,
  providerInfo: ProviderInfo,
  model: string,
  isNew: boolean,
  /** Session's original name (from db), for worktree lookup on resume.
   *  On resume, sessionName is the UUID; this is the human-readable name. */
  sessionDisplayName?: string,
  /**
   * Optional session set name (defined in cgoose config).
   * The special value DEFAULT_PROFILE_SENTINEL ("__default__") means
   * "use Goose's default profile" (extensions from config.yaml);
   * "" (none) means "load no extensions at all".
   */
  sessionSet?: string,
): void {
  writeProjectMeta(providerInfo.name, model, sessionSet);

  // ─── Resolve session set ───────────────────────────────────────────────
  const useDefaultProfile = sessionSet === DEFAULT_PROFILE_SENTINEL;
  const set = sessionSet && !useDefaultProfile ? getSessionSet(sessionSet) : undefined;

  // ─── Git worktree setup ────────────────────────────────────────────────
  let worktreePath: string | null = null;
  const forceWorktree = process.env.CGOOSE_FORCE_WORKTREE === "1";

  // Check cgoose config for default mode if no env var is explicitly set
  if (!forceWorktree && process.env.CGOOSE_NO_WORKTREE === undefined) {
    const cgooseConfig = readCgooseConfig();
    if (cgooseConfig.default_mode === "no-worktree") {
      process.env.CGOOSE_NO_WORKTREE = "1";
    }
  }
  const noWorktree = forceWorktree ? false : process.env.CGOOSE_NO_WORKTREE === "1";

  // Use the display name for worktree (stable across creates and resumes)
  const worktreeName = sessionDisplayName || sessionName || generateSessionName(getCurrentDirName());

  if (!noWorktree && isInsideGitRepo()) {
    if (isNew) {
      // Create a new worktree for this session
      worktreePath = createWorktree(worktreeName);
      if (worktreePath) {
        console.log(pc.dim(`  📂 Worktree: ${pc.cyan(worktreePath)}`));
        console.log(pc.dim(`  🌿 Branch:   ${pc.green(worktreeName)}`));
        saveWorktreeMapping(worktreeName, worktreePath);
      }
    } else {
      // Resuming — find existing worktree by the session's original name
      worktreePath = getSessionWorktreePath(worktreeName);
      if (worktreePath) {
        console.log(pc.dim(`  📂 Resuming worktree: ${pc.cyan(worktreePath)}`));
      }
    }
  }

  // ─── Provider env setup ──────────────────────────────────────────────────
  const effectiveProvider = providerInfo.name;
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
        // Find all $KEY or ${KEY} references in YAML values
        const envRefRegex = /\$\{?(\w+)\}?/g;
        const foundKeys = new Set<string>();
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const colonIdx = trimmed.indexOf(":");
          if (colonIdx === -1) continue;
          const value = trimmed.slice(colonIdx + 1).trim();
          if (!value) continue;
          // Match env var references in the value
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

  // ─── Build args — always `goose session` ─────────────────────────────────
  const args: string[] = [];

  if (isNew) {
    args.push("session");
    if (sessionName) {
      args.push("--name", sessionName);
    }
    args.push("--provider", effectiveProvider, "--model", model);

    // Session set: pass system prompt via --system, extensions via CLI flags
    if (set) {
      if (set.systemPrompt) {
        args.push("--system", set.systemPrompt);
      }

      // Named extensions from ~/.config/goose/config.yaml (e.g. "fetch")
      const extArgs = buildExtensionArgs(set.extensions ?? []);
      for (const warning of extArgs.warnings) {
        console.log(pc.yellow(`  ⚠ ${warning}`));
      }

      // Builtins: those listed in the set + builtin/platform ones from config.yaml
      const builtins = [...new Set([...set.builtins, ...extArgs.builtins])];
      if (builtins.length > 0) {
        args.push("--with-builtin", builtins.join(","));
      }

      // Stdio extensions: explicit command lines from the set + config.yaml entries
      for (const ext of [...(set.stdioExtensions ?? []), ...extArgs.stdio]) {
        args.push("--with-extension", ext);
      }

      // Streamable HTTP extensions from config.yaml
      for (const uri of extArgs.http) {
        args.push("--with-streamable-http-extension", uri);
      }

      // Don't load default profile — the set defines exactly what we want
      args.push("--no-profile");
    } else if (!useDefaultProfile) {
      // "None" — a truly bare session: no extensions at all
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
      args.push("--name", sessionName);
    }
    args.push("--provider", effectiveProvider, "--model", model);
    args.push("--system", set?.systemPrompt ?? "");
  }

  // ─── Display summary ─────────────────────────────────────────────────────
  const setLabel = set
    ? pc.green(set.title)
    : useDefaultProfile
      ? pc.green("Default") + pc.dim(" (goose config.yaml)")
      : pc.dim("none (no extensions)");
  const setLine = isNew ? `\n  ${pc.dim("Set:")}      ${setLabel}` : "";
  const summary = [
    `\n${pc.green("🚀")} ${pc.bold("Launching Goose...")}`,
    `  ${pc.dim("Session:")}  ${pc.cyan(sessionName)}`,
    `  ${pc.dim("Provider:")} ${pc.yellow(providerInfo.name)}`,
    `  ${pc.dim("Model:")}    ${pc.magenta(model)}${setLine}`,
  ];
  if (worktreePath) {
    summary.push(`  ${pc.dim("Workdir:")}  ${pc.cyan(worktreePath)}`);
  }
  if (process.env.CGOOSE_DEBUG === "1") {
    summary.push(`  ${pc.dim("Command:")}  ${pc.dim(`goose ${args.join(" ")}`)}`);
  }
  summary.push("");
  console.log(summary.join("\n"));

  // ─── Spawn with optional cwd ───────────────────────────────────────────
  const spawnOpts: Record<string, unknown> = { stdio: "inherit", env: launchEnv };
  if (worktreePath) {
    spawnOpts.cwd = worktreePath;
  }

  // Return a promise so the caller can await exit if needed.
  // The function type is `void` for backwards compatibility with callers
  // that don't use the promise.
  // Spawn goose; we intentionally don't await — the child process takes over the terminal.
  const child = spawn("goose", args, spawnOpts as any);
  child.on("exit", () => {
    /* goose exited */
  });
}