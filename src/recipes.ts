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
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { dump as yamlDump } from "js-yaml";
import { text, log, isCancel, outro, multiselect } from "@clack/prompts";
import pc from "picocolors";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecipeInfo {
  name: string;
  title: string;
  description: string;
  path: string;
  source: string;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const GOOSE_RECIPES_DIR = join(homedir(), ".config", "goose", "recipes");

// ─── Discovery ────────────────────────────────────────────────────────────────

/** Ensure the goose recipes directory exists */
export function ensureRecipesDir(): void {
  if (!existsSync(GOOSE_RECIPES_DIR)) {
    mkdirSync(GOOSE_RECIPES_DIR, { recursive: true });
  }
}

/** Get the goose recipes directory path */
export function getRecipesDir(): string {
  return GOOSE_RECIPES_DIR;
}

/** Known extensions for the recipe creation wizard */
const KNOWN_EXTENSIONS: { value: string; label: string; hint: string }[] = [
  { value: "developer", label: "Developer", hint: "Shell commands, file read/write" },
  { value: "analyze", label: "Analyze", hint: "Code structure analysis (tree-sitter)" },
  { value: "memory", label: "Memory", hint: "Session memory persistence" },
  { value: "summon", label: "Summon", hint: "Subagent delegation, knowledge loading" },
  { value: "todo", label: "Todo", hint: "Task tracking within sessions" },
  { value: "tom", label: "Top Of Mind", hint: "Custom context injection per turn" },
  { value: "skills", label: "Skills", hint: "Skill instructions from filesystem/builtins" },
  { value: "chatrecall", label: "Chat Recall", hint: "Search past sessions" },
  { value: "summarize", label: "Summarize", hint: "File/directory LLM summarization" },
  { value: "apps", label: "Apps", hint: "HTML/CSS/JS sandboxed apps" },
  { value: "autovisualiser", label: "Auto Visualiser", hint: "Auto-visualisation" },
  { value: "computercontroller", label: "Computer Controller", hint: "Desktop control" },
  { value: "tutorial", label: "Tutorial", hint: "Guided tutorial mode" },
];

/**
 * Interactive wizard to create a minimal recipe (without `prompt:`).
 * The recipe is saved to ~/.config/goose/recipes/<name>.yaml.
 * Returns the recipe name, or null if cancelled.
 */
export async function createRecipeWizard(): Promise<string | null> {
  ensureRecipesDir();

  log.step(pc.cyan("⚙️  Create a minimal recipe"));
  log.info(pc.dim("Minimal recipes bundle a system prompt + extensions, without a starting prompt."));

  // ── Step 1: Name (slug) ────────────────────────────────────────────────
  const name = await text({
    message: "Recipe name (used as filename):",
    placeholder: "e.g., code-review, data-analysis",
    validate: (val) => {
      if (!val || val.trim().length === 0) return "Name cannot be empty";
      if (!/^[a-zA-Z0-9_-]+$/.test(val.trim())) return "Use only letters, numbers, hyphens, underscores";
      const filePath = join(GOOSE_RECIPES_DIR, `${val.trim()}.yaml`);
      if (existsSync(filePath)) return `Recipe "${val.trim()}" already exists`;
      return;
    },
  });
  if (isCancel(name)) return null;

  const recipeName = (name as string).trim();

  // ── Step 2: Title ──────────────────────────────────────────────────────
  const title = await text({
    message: "Display title:",
    placeholder: "e.g., Code Review, Data Analysis",
    validate: (val) => (!val || val.trim().length === 0 ? "Title cannot be empty" : undefined),
  });
  if (isCancel(title)) return null;

  // ── Step 3: Description ─────────────────────────────────────────────────
  const description = await text({
    message: "Short description:",
    placeholder: "e.g., Review code with a critical eye for bugs and security issues",
    defaultValue: "",
  });
  if (isCancel(description)) return null;

  // ── Step 4: Instructions (system prompt) ───────────────────────────────
  log.info(pc.dim("These instructions will be added to the system prompt and survive context compaction."));
  const instructions = await text({
    message: "System prompt instructions:",
    placeholder: "e.g., You are a senior code reviewer. Be thorough and critical.",
    defaultValue: "",
  });
  if (isCancel(instructions)) return null;

  // ── Step 5: Extensions ─────────────────────────────────────────────────
  const selectedExtensions = await multiselect({
    message: "Extensions to enable:",
    options: KNOWN_EXTENSIONS,
    required: true,
    initialValues: ["developer"],
  });
  if (isCancel(selectedExtensions)) return null;

  const extList = (selectedExtensions as string[]).map((extName) => ({
    type: "builtin" as const,
    name: extName,
  }));

  // ── Write YAML (no `prompt:` — minimal recipe) ──────────────────────────
  const recipeDoc: Record<string, any> = {
    title: (title as string),
    description: (description as string) || `Recipe: ${recipeName}`,
    instructions: (instructions as string) || undefined,
    extensions: extList.length > 0 ? extList : [{ type: "builtin", name: "developer" }],
  };

  // Clean up empty instructions
  if (!recipeDoc.instructions) delete recipeDoc.instructions;

  const yamlContent = yamlDump(recipeDoc, { indent: 2, lineWidth: -1, noRefs: true });
  const filePath = join(GOOSE_RECIPES_DIR, `${recipeName}.yaml`);

  try {
    writeFileSync(filePath, yamlContent, "utf-8");
    log.success(pc.green(`✓ Recipe saved: ${pc.cyan(filePath)}`));
  } catch (e) {
    log.error(pc.red(`✖ Failed to write recipe: ${e}`));
    return null;
  }

  outro(pc.green(`✧ Recipe "${title}" ready!`));

  return recipeName;
}

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