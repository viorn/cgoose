/**
 * Git worktree management for cgoose sessions
 *
 * Convention:
 *   Worktree path: <repo-root>/.worktree/<sanitized-session-name>
 *   Branch name:   cgoose-<sanitized-session-name>
 *
 * Worktrees live inside the repo in .worktree/ which is gitignored.
 * This keeps everything self-contained and discoverable from the project root.
 */

import { execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import pc from "picocolors";

// ─── Constants ────────────────────────────────────────────────────────────────

const CGOOSE_WT_PREFIX = "cgoose-";

// ─── Git repo detection ───────────────────────────────────────────────────────

/** Check if CWD is inside a git repository */
export function isInsideGitRepo(): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      encoding: "utf-8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Get the repository root path */
export function getRepoRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// ─── Naming helpers ───────────────────────────────────────────────────────────

/** Sanitize session name for use as a directory/branch name */
function sanitize(sessionName: string): string {
  return sessionName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .toLowerCase()
    .slice(0, 80);
}

/**
 * Get the worktree path for a session.
 * Path: <repo-root>/.worktree/<sanitized-session-name>
 *
 * This keeps all worktrees inside the repo in a single hidden directory.
 * The .worktree/ directory should be in .gitignore (added automatically).
 */
export function getWorktreePath(repoRoot: string, sessionName: string): string {
  return join(repoRoot, ".worktree", sanitize(sessionName));
}

/** Get the git branch name for a session worktree */
export function getBranchName(sessionName: string): string {
  return `${CGOOSE_WT_PREFIX}${sanitize(sessionName)}`;
}

// ─── Worktree CRUD ───────────────────────────────────────────────────────────

/**
 * Check if a worktree path already exists in git's worktree registry.
 * Also checks if the directory exists on disk.
 */
function worktreeExists(path: string): boolean {
  try {
    const output = execSync("git worktree list --porcelain", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ") && resolve(line.slice(9)) === resolve(path)) {
        return true;
      }
    }
  } catch { /* ignore */ }
  return existsSync(path);
}

/**
 * Create a git worktree for a session.
 * Returns the worktree path on success, null on failure.
 */
export function createWorktree(sessionName: string): string | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return null;

  const path = getWorktreePath(repoRoot, sessionName);
  const branch = getBranchName(sessionName);

  // Already exists — just return the path
  if (worktreeExists(path)) return path;

  // Check for uncommitted changes
  try {
    const status = execSync("git status --porcelain", {
      encoding: "utf-8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (status.length > 0) {
      console.log(pc.yellow("⚠ uncommitted changes detected — creating worktree from current HEAD"));
    }
  } catch { /* ignore */ }

  // Ensure parent dir exists — git worktree add won't create it
  const parentDir = dirname(path);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // Create worktree with a new branch from HEAD
  try {
    execSync(`git worktree add -b "${branch}" "${path}"`, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repoRoot,
    });
    return path;
  } catch (err) {
    // Branch may already exist — try attaching to existing branch
    try {
      execSync(`git worktree add "${path}" "${branch}"`, {
        encoding: "utf-8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: repoRoot,
      });
      return path;
    } catch (e2) {
      console.log(pc.red(`✗ Failed to create worktree: ${e2}`));
      return null;
    }
  }
}

/**
 * Remove a git worktree for a session.
 * Returns true on success.
 */
export function removeWorktree(sessionName: string): boolean {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return false;

  const path = getWorktreePath(repoRoot, sessionName);
  const branch = getBranchName(sessionName);

  // Remove worktree (force if dirty — we're deleting anyway)
  try {
    execSync(`git worktree remove "${path}" --force`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repoRoot,
    });
    // Also delete the branch
    try {
      execSync(`git branch -D "${branch}"`, {
        encoding: "utf-8",
        timeout: 3_000,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: repoRoot,
      });
    } catch { /* branch may not exist or already deleted */ }
    return true;
  } catch {
    // Path may not exist as worktree — clean up directory manually
    try {
      execSync(`rm -rf "${path}"`, { timeout: 5_000 });
    } catch { /* ignore */ }
    try {
      execSync(`git branch -D "${branch}"`, {
        encoding: "utf-8",
        timeout: 3_000,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: repoRoot,
      });
    } catch { /* ignore */ }
    return false;
  }
}

/**
 * Get all cgoose-managed worktree paths for the current repo.
 * Returns empty array if not in a git repo.
 *
 * Parses `git worktree list --porcelain` format:
 *   worktree <path>
 *   HEAD <sha1>
 *   branch <ref>       (absent for detached HEAD)
 *   (empty line separates entries)
 */
export function getRepoWorktreePaths(): string[] {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return [];

  const worktrees: string[] = [];
  try {
    const output = execSync("git worktree list --porcelain", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Split by double newline (entries separated by blank lines)
    const entries = output.split(/\n\n+/);
    for (const entry of entries) {
      if (!entry.trim()) continue;
      let path = "";
      let isCgoose = false;

      for (const line of entry.split("\n")) {
        if (line.startsWith("worktree ")) {
          path = resolve(line.slice(9).trim());
        } else if (line.startsWith("branch ")) {
          const ref = line.slice(7).trim().replace("refs/heads/", "");
          if (ref.startsWith(CGOOSE_WT_PREFIX)) {
            isCgoose = true;
          }
        }
      }

      if (path && isCgoose) {
        worktrees.push(path);
      }
    }
  } catch { /* ignore */ }

  return worktrees;
}

/**
 * Get all directory paths that are part of this project:
 * - The repo root (if in a git repo)
 * - All cgoose-managed worktree paths
 * Falls back to [cwd] if not in a git repo.
 *
 * Used for session listing: sessions in worktrees have a different
 * working_dir but belong to the same project.
 */
export function getProjectSessionDirs(cwd: string): string[] {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return [cwd];
  return [repoRoot, ...getRepoWorktreePaths()];
}

/**
 * Check if a session has an associated worktree.
 * Returns the worktree path if it exists, null otherwise.
 */
export function getSessionWorktreePath(sessionName: string): string | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return null;

  const path = getWorktreePath(repoRoot, sessionName);
  return worktreeExists(path) ? path : null;
}

/**
 * Get all session names that have cgoose-managed worktrees in this repo.
 * Useful for session listing: sessions in worktrees should show up
 * even though their working_dir differs from the main repo CWD.
 *
 * Extracts session name from branch name (cgoose-<name> → <name>).
 */
export function getWorktreeSessionNames(): string[] {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return [];

  const names: string[] = [];
  try {
    const output = execSync("git worktree list --porcelain", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const entries = output.split(/\n\n+/);
    for (const entry of entries) {
      if (!entry.trim()) continue;
      for (const line of entry.split("\n")) {
        if (line.startsWith("branch ")) {
          const ref = line.slice(7).trim().replace("refs/heads/", "");
          if (ref.startsWith(CGOOSE_WT_PREFIX)) {
            names.push(ref.slice(CGOOSE_WT_PREFIX.length));
          }
        }
      }
    }
  } catch { /* ignore */ }

  return names;
}