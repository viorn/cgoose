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
import { writeProjectMeta, saveWorktreeMapping, saveSessionPrompt, getSessionPrompt } from "./project";
import { getModelContextLimit, getGooseSecrets } from "./config";
import type { ProviderInfo } from "./config";
import { readCgooseConfig, getSessionSet } from "./cgoose-config";
import { isInsideGitRepo, createWorktree, getSessionWorktreePath, getRepoRoot } from "./worktree";
import { getCurrentDirName, generateSessionName } from "./utils";

export function launchGoose(
  sessionName: string,
  providerInfo: ProviderInfo,
  model: string,
  isNew: boolean,
  /** Session's original name (from db), for worktree lookup on resume.
   *  On resume, sessionName is the UUID; this is the human-readable name. */
  sessionDisplayName?: string,
  /** Optional session set name (defined in cgoose config). */
  sessionSet?: string,
): void {
  writeProjectMeta(providerInfo.name, model, sessionSet);

  // ─── Resolve session set ───────────────────────────────────────────────
  const set = sessionSet ? getSessionSet(sessionSet) : undefined;

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

    // Session set: pass system prompt via --system, builtins via --with-builtin
    if (set) {
      if (set.systemPrompt) {
        args.push("--system", set.systemPrompt);
        // Persist the original prompt for consistent resume behaviour
        saveSessionPrompt(worktreeName, set.systemPrompt);
      }

      // Stdio extensions (e.g. "mcpls --trust-project-config")
      if (set.stdioExtensions && set.stdioExtensions.length > 0) {
        for (const ext of set.stdioExtensions) {
          args.push("--with-extension", ext);
        }
      }

      if (set.builtins.length > 0) {
        args.push("--with-builtin", set.builtins.join(","));
        // Don't load default profile — the set defines exactly what we want
        args.push("--no-profile");
      }
    }
  } else {
    // Resume — re-apply system prompt (--system is in-memory only, not
    // persisted in session DB). Use the *original* prompt saved when the
    // session was first created, so that even if the set definition changes
    // later, the resumed session still gets its original instructions.
    args.push("session", "--resume", "--history");
    if (sessionName) {
      args.push("--name", sessionName);
    }
    args.push("--provider", effectiveProvider, "--model", model);

    const originalPrompt = getSessionPrompt(worktreeName);
    if (originalPrompt) {
      args.push("--system", originalPrompt);
    } else if (set?.systemPrompt) {
      // Fallback: if no saved prompt yet, use current set's prompt
      args.push("--system", set.systemPrompt);
    }
  }

  // ─── Display summary ─────────────────────────────────────────────────────
  const setLine = set ? `\n  ${pc.dim("Set:")}      ${pc.green(set.title)}` : "";
  console.log(
    `\n${pc.green("🚀")} ${pc.bold("Launching Goose...")}
  ${pc.dim("Session:")}  ${pc.cyan(sessionName)}
  ${pc.dim("Provider:")} ${pc.yellow(providerInfo.name)}
  ${pc.dim("Model:")}    ${pc.magenta(model)}${setLine}
  ${worktreePath ? `${pc.dim("Workdir:")}  ${pc.cyan(worktreePath)}\n` : ""}
  ${pc.dim("Command:")}  ${pc.dim(`goose ${args.join(" ")}`)}
  `,
  );

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