/**
 * Launch Goose with session name, provider, and model
 *
 * Git worktree integration:
 * - New sessions create a git worktree (<repo-root>/.worktree/<name>) and launch Goose there
 * - Resuming existing sessions check for an existing worktree and launch there if found
 * - Skips worktree creation if not in a git repo or CGOOSE_NO_WORKTREE=1 is set
 */

import { spawn } from "node:child_process";
import process from "node:process";
import pc from "picocolors";
import { writeProjectMeta, saveWorktreeMapping } from "./project";
import { getModelContextLimit } from "./config";
import type { ProviderInfo } from "./config";
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
): void {
  writeProjectMeta(providerInfo.name, model);

  // ─── Git worktree setup ────────────────────────────────────────────────
  let worktreePath: string | null = null;
  const noWorktree = process.env.CGOOSE_NO_WORKTREE === "1";

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

  // ─── Build args ─────────────────────────────────────────────────────────
  const args = ["session"];
  if (!isNew) {
    args.push("--resume", "--history");
  }
  if (sessionName) {
    args.push("--name", sessionName);
  }
  args.push("--provider", effectiveProvider, "--model", model);

  console.log(
    `\n${pc.green("🚀")} ${pc.bold("Launching Goose...")}
  ${pc.dim("Session:")}  ${pc.cyan(sessionName)}
  ${pc.dim("Provider:")} ${pc.yellow(providerInfo.name)}
  ${pc.dim("Model:")}    ${pc.magenta(model)}
  ${worktreePath ? `${pc.dim("Workdir:")}  ${pc.cyan(worktreePath)}\n` : ""}
  ${pc.dim("Command:")}  ${pc.dim(`goose ${args.join(" ")}`)}
  `,
  );

  // ─── Spawn with optional cwd ───────────────────────────────────────────
  const spawnOpts: Record<string, unknown> = { stdio: "inherit", env: launchEnv };
  if (worktreePath) {
    spawnOpts.cwd = worktreePath;
  }

  const child = spawn("goose", args, spawnOpts as any);
  child.on("exit", (code) => process.exit(code ?? 0));
}