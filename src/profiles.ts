/**
 * Profile management — minimal goose recipes (without prompt:) stored in
 * ~/.config/cgoose/profiles/*.yaml
 *
 * Profiles use `instructions:` (→ system prompt, survives compaction) and
 * `extensions:` (→ extension config) but no `prompt:` (no initial user message).
 * Launch via `goose run --recipe <path> --interactive`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import { text, log, isCancel, outro, multiselect } from "@clack/prompts";
import pc from "picocolors";

// ─── Paths ───────────────────────────────────────────────────────────────────

const PROFILES_DIR = join(homedir(), ".config", "cgoose", "profiles");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProfileExtension {
  type: string;
  name: string;
}

export interface ProfileInfo {
  /** File stem (filename without extension) */
  name: string;
  /** Human-readable title from YAML frontmatter */
  title: string;
  description: string;
  instructions?: string;
  extensions: ProfileExtension[];
  /** Full filesystem path to the YAML file */
  path: string;
}

// ─── Known extensions for the profile wizard ─────────────────────────────────
// Sources: goose builtin extensions + platform extensions (non-hidden)

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

// ─── Discovery ────────────────────────────────────────────────────────────────

/** Ensure the profiles directory exists */
export function ensureProfilesDir(): void {
  if (!existsSync(PROFILES_DIR)) {
    mkdirSync(PROFILES_DIR, { recursive: true });
  }
}

/** Get the profiles directory path */
export function getProfilesDir(): string {
  return PROFILES_DIR;
}

/**
 * Discover all cgoose profiles from ~/.config/cgoose/profiles/*.yaml
 */
export function discoverProfiles(): ProfileInfo[] {
  if (!existsSync(PROFILES_DIR)) return [];

  const profiles: ProfileInfo[] = [];
  for (const file of readdirSync(PROFILES_DIR)) {
    const ext = extname(file).toLowerCase();
    if (ext !== ".yaml" && ext !== ".yml") continue;
    const filePath = join(PROFILES_DIR, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const doc = yamlLoad(raw) as Record<string, any>;
      if (!doc || !doc.title) continue;
      profiles.push({
        name: basename(file).replace(/\.\w+$/, ""),
        title: String(doc.title ?? ""),
        description: String(doc.description ?? ""),
        instructions: doc.instructions ? String(doc.instructions) : undefined,
        extensions: Array.isArray(doc.extensions)
          ? doc.extensions.map((e: any) => ({
              type: String(e.type ?? "builtin"),
              name: String(e.name ?? ""),
            })).filter((e) => e.name)
          : [],
        path: filePath,
      });
    } catch {
      // skip corrupt files
    }
  }
  return profiles;
}

/** Resolve a profile name or path to its full path, or null if not found */
export function resolveProfilePath(nameOrPath: string): string | null {
  // Already a path
  if (nameOrPath.startsWith("/") || nameOrPath.startsWith("~") || nameOrPath.startsWith(".")) {
    const expanded = nameOrPath.startsWith("~")
      ? join(homedir(), nameOrPath.slice(1))
      : nameOrPath;
    if (existsSync(expanded)) return expanded;
    return null;
  }
  // Try by name (file stem)
  const profiles = discoverProfiles();
  const match = profiles.find((p) => p.name === nameOrPath);
  return match?.path ?? null;
}

/** Check if a string is a profile path (not a recipe name) */
export function isProfilePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.startsWith(".");
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** Delete a profile by name. Returns true on success. */
export function deleteProfile(name: string): boolean {
  const path = join(PROFILES_DIR, `${name}.yaml`);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Profile creation wizard ──────────────────────────────────────────────────

/**
 * Interactive wizard to create a new profile YAML file.
 * Returns the created ProfileInfo, or null if cancelled.
 */
export async function createProfileWizard(): Promise<ProfileInfo | null> {
  ensureProfilesDir();

  log.step(pc.cyan("⚙️  Create a profile"));
  log.info(pc.dim("Profiles are reusable session configs: extensions + system prompt."));

  // ── Step 1: Name (slug) ────────────────────────────────────────────────
  const name = await text({
    message: "Profile name (used as filename):",
    placeholder: "e.g., code-review, data-analysis",
    validate: (val) => {
      if (!val || val.trim().length === 0) return "Name cannot be empty";
      if (!/^[a-zA-Z0-9_-]+$/.test(val.trim())) return "Use only letters, numbers, hyphens, underscores";
      const filePath = join(PROFILES_DIR, `${val.trim()}.yaml`);
      if (existsSync(filePath)) return `Profile "${val.trim()}" already exists`;
      return;
    },
  });
  if (isCancel(name)) return null;

  const profileName = (name as string).trim();

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

  // ── Write YAML ─────────────────────────────────────────────────────────
  const profileDoc: Record<string, any> = {
    title: title as string,
    description: (description as string) || `Profile: ${profileName}`,
    instructions: (instructions as string) || undefined,
    extensions: extList.length > 0 ? extList : undefined,
  };

  // Clean up empty fields
  if (!profileDoc.instructions) delete profileDoc.instructions;
  if (!profileDoc.extensions || profileDoc.extensions.length === 0) {
    // Default to developer if nothing selected
    profileDoc.extensions = [{ type: "builtin", name: "developer" }];
  }

  const yamlContent = yamlDump(profileDoc, { indent: 2, lineWidth: -1, noRefs: true });
  const filePath = join(PROFILES_DIR, `${profileName}.yaml`);

  try {
    writeFileSync(filePath, yamlContent, "utf-8");
    log.success(pc.green(`✓ Profile saved: ${pc.cyan(filePath)}`));
  } catch (e) {
    log.error(pc.red(`✖ Failed to write profile: ${e}`));
    return null;
  }

  outro(pc.green(`✧ Profile "${title}" ready!`));

  return {
    name: profileName,
    title: title as string,
    description: (description as string) || "",
    instructions: (instructions as string) || undefined,
    extensions: extList,
    path: filePath,
  };
}