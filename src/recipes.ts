/**
 * Recipe discovery — find available recipes from Goose's standard paths.
 *
 * Goose discovers recipes from:
 * - ~/.config/goose/recipes/ (default path)
 * - ~/.agents/recipes/
 * - GOOSE_RECIPE_PATH environment variable (colon-separated directories)
 * - GOOSE_RECIPE_GITHUB_REPO (remote recipes, not covered here)
 *
 * We use `goose recipe list --format json` to get canonical list.
 */

import { execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecipeInfo {
  name: string;
  title: string;
  description: string;
  path: string;
  source: string;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Discover all available recipes by running `goose recipe list --format json`.
 * Returns an empty array if the command fails or no recipes are found.
 */
export function discoverRecipes(): RecipeInfo[] {
  try {
    const output = execSync("goose recipe list --format json", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Find JSON array in output (there may be leading text)
    const jsonStart = output.indexOf("[");
    const jsonEnd = output.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd === -1) return [];

    const raw: any[] = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
    return raw.map((r: any) => ({
      name: String(r.name ?? ""),
      title: String(r.title ?? r.name ?? ""),
      description: String(r.description ?? ""),
      path: String(r.path ?? ""),
      source: String(r.source ?? "Local"),
    })).filter((r) => r.name.length > 0);
  } catch {
    return [];
  }
}