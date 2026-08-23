/**
 * Custom provider creation wizard.
 *
 * Walks the user through creating a custom_providers JSON file,
 * then optionally adds it to config.yaml so it shows up in Goose.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { select, text, password, confirm, log, spinner, isCancel, outro } from "@clack/prompts";
import pc from "picocolors";

// ─── Paths ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "goose", "config.yaml");
const CUSTOM_PROVIDERS_DIR = join(homedir(), ".config", "goose", "custom_providers");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a safe provider id from a display name */
function generateProviderId(displayName: string): string {
  return "custom_" + displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Pick a sensible env var name for the API key */
function generateApiKeyEnv(providerId: string): string {
  return providerId.toUpperCase() + "_API_KEY";
}

/** Check if a provider ID already exists */
function providerIdExists(id: string): boolean {
  const filePath = join(CUSTOM_PROVIDERS_DIR, `${id}.json`);
  return existsSync(filePath);
}

/**
 * Read an existing config.yaml providers block (simple text-based abordage).
 * Returns the raw content, or null if file doesn't exist.
 */
function readYamlContent(): string | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return readFileSync(CONFIG_PATH, "utf-8");
}

/**
 * Determine the last indentation used in the providers: block so we can
 * append new entries with consistent formatting.
 */
function getProvidersIndent(yamlContent: string): string {
  const lines = yamlContent.split("\n");
  let inProviders = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("providers:")) {
      inProviders = true;
      continue;
    }
    if (!inProviders) continue;
    if (line.trim().startsWith("- ")) {
      // Found a provider entry — return its indentation (leading spaces)
      const indent = line.match(/^(\s*)/)?.[1] ?? "  ";
      return indent;
    }
    // If we hit a non-provider line that's not a comment, stop
    if (line.trim() && !line.trimStart().startsWith("#")) {
      inProviders = false;
    }
  }
  return "  "; // default: 2 spaces
}

/**
 * Try to add the provider to config.yaml so it shows up in Goose.
 * Returns true on success, false if user skipped or it failed.
 */
function addToConfigYaml(providerId: string, model: string): boolean {
  try {
    let content = readYamlContent();
    if (content === null) {
      // No config.yaml exists — create one
      const modelLine2 = model ? `\n    model: ${model}` : "";
      content = `providers:\n  ${providerId}:\n    enabled: true${modelLine2}\n`;
      mkdirSync(join(homedir(), ".config", "goose"), { recursive: true });
      writeFileSync(CONFIG_PATH, content, "utf-8");
      return true;
    }

    // Check if provider already exists in YAML
    if (content.includes(`\n${providerId}:`) || content.includes(` ${providerId}:`) || content.includes(`\t${providerId}:`)) {
      return true; // already there
    }

    const indent = getProvidersIndent(content);

    // Find where to insert: after the last provider entry, before any non-provider top-level key
    const lines = content.split("\n");
    let lastProviderLine = -1;
    let providersEnd = -1;
    let inProviders = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed === "providers:" || trimmed.startsWith("providers:")) {
        inProviders = true;
        continue;
      }
      if (!inProviders) continue;
      if (trimmed.startsWith("- ") || trimmed.startsWith("#") || trimmed === "") {
        if (trimmed.startsWith("- ")) lastProviderLine = i;
        continue;
      }
      // Hit a non-provider, non-comment, non-empty line while inProviders
      providersEnd = i;
      break;
    }

    if (providersEnd === -1) providersEnd = lines.length;

    // Insert after last provider, or after "providers:" line
    const insertAt = lastProviderLine >= 0 ? lastProviderLine + 1 : getProvidersLine(content) + 1;
    const modelLine = model ? `\n${indent}  model: ${model}` : "";
    const newEntry = `${indent}${providerId}:\n${indent}  enabled: true${modelLine}`;

    lines.splice(insertAt, 0, newEntry);
    writeFileSync(CONFIG_PATH, lines.join("\n"), "utf-8");
    return true;
  } catch (e) {
    log.error(pc.red(`Failed to update config.yaml: ${e}`));
    return false;
  }
}

/** Find the line index of the "providers:" key */
function getProvidersLine(yamlContent: string): number {
  const lines = yamlContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart() === "providers:" || lines[i].trimStart().startsWith("providers:")) {
      return i;
    }
  }
  return -1;
}

// ─── Main wizard ─────────────────────────────────────────────────────────────

export interface CreatedProvider {
  id: string;
  displayName: string;
}

export async function createCustomProviderWizard(): Promise<CreatedProvider | null> {
  log.step(pc.cyan("🧩 Create a custom provider"));
  log.info(pc.dim("Define a new OpenAI / Anthropic / Ollama compatible provider."));

  // ── Step 1: engine type ────────────────────────────────────────────────
  const engineType = await select({
    message: "API type:",
    options: [
      { value: "openai", label: "OpenAI Compatible", hint: "Uses OpenAI API format (e.g., KodikRouter, Together, DeepSeek)" },
      { value: "anthropic", label: "Anthropic Compatible", hint: "Uses Anthropic API format" },
      { value: "ollama", label: "Ollama Compatible", hint: "Uses Ollama API format" },
    ],
  });

  if (isCancel(engineType)) return null;

  // ── Step 2: display name ───────────────────────────────────────────────
  const displayName = await text({
    message: "Provider display name:",
    placeholder: "e.g., My Provider",
    validate: (val) => {
      if (!val || val.trim().length === 0) return "Name cannot be empty";
      const id = generateProviderId(val);
      if (providerIdExists(id)) return `Provider "${id}" already exists (from "${val}"). Choose a different name.`;
      return;
    },
  });

  if (isCancel(displayName)) return null;

  const providerId = generateProviderId(displayName as string);

  // ── Step 3: API URL ────────────────────────────────────────────────────
  const apiUrl = await text({
    message: "Provider API URL:",
    placeholder: "https://api.example.com/v1",
    validate: (val) => {
      if (!val || val.trim().length === 0) return "URL cannot be empty";
      if (!val.startsWith("http://") && !val.startsWith("https://")) return "URL must start with http:// or https://";
      return;
    },
  });

  if (isCancel(apiUrl)) return null;

  // ── Step 4: authentication ─────────────────────────────────────────────
  const requiresAuth = await confirm({
    message: "Does this provider require authentication?",
    initialValue: true,
  });

  if (isCancel(requiresAuth)) return null;

  let apiKey = "";
  if (requiresAuth) {
    apiKey = await password({
      message: "API key:",
      mask: "▪",
      validate: (val) => {
        if (!val || val.trim().length === 0) return "API key cannot be empty";
        return;
      },
    });

    if (isCancel(apiKey)) return null;
  }

  // ── Step 5: models (skipped — handled on model selection step) ────────
  log.info(pc.dim("Models can be added on the next step — type manually or fetch from API."));
  const models: string[] = [];
  const defaultModel = "";

  // ── Step 6: streaming ──────────────────────────────────────────────────
  const supportsStreaming = await confirm({
    message: "Does this provider support streaming responses?",
    initialValue: true,
  });

  if (isCancel(supportsStreaming)) return null;

  // ── Step 7: base path (optional) ───────────────────────────────────────
  const basePath = await text({
    message: "API base path (optional — press Enter to skip):",
    placeholder: "e.g., v1/chat/completions or project_id/v1",
    defaultValue: "",
  });

  if (isCancel(basePath)) return null;

  // ── Step 8: custom headers (optional) ──────────────────────────────────
  const addHeaders = await confirm({
    message: "Add custom HTTP headers?",
    initialValue: false,
  });

  if (isCancel(addHeaders)) return null;

  const headers: Record<string, string> = {};
  if (addHeaders) {
    const headerCountStr = await text({
      message: "How many custom headers?",
      placeholder: "1",
      defaultValue: "1",
      validate: (val) => {
        if (val && !/^\d+$/.test(val)) return "Enter a number";
        return;
      },
    });

    if (isCancel(headerCountStr)) return null;

    const count = parseInt((headerCountStr as string) || "1", 10);
    for (let i = 0; i < count; i++) {
      const hName = await text({
        message: `Header #${i + 1} name:`,
        placeholder: "X-Custom-Header",
        validate: (val) => {
          if (!val || val.trim().length === 0) return "Header name cannot be empty";
          return;
        },
      });

      if (isCancel(hName)) return null;

      const hValue = await text({
        message: `Header #${i + 1} value:`,
        placeholder: "value",
        validate: (val) => {
          if (!val || val.trim().length === 0) return "Header value cannot be empty";
          return;
        },
      });

      if (isCancel(hValue)) return null;

      headers[hName as string] = hValue as string;
    }
  }

  // ── Step 9: preserves thinking (for Anthropic) ─────────────────────────
  const preservesThinking = engineType === "anthropic"
    ? await confirm({
        message: "Preserve thinking content from the provider?",
        initialValue: false,
      })
    : true;

  if (isCancel(preservesThinking)) return null;

  // ── Write JSON ──────────────────────────────────────────────────────────
  const s = spinner();
  s.start("Creating custom provider...");

  const apiKeyEnvName = generateApiKeyEnv(providerId);

  const providerJson: Record<string, any> = {
    name: providerId,
    engine: engineType,
    display_name: displayName,
    description: `Custom ${displayName} provider`,
    api_key_env: requiresAuth ? apiKeyEnvName : "",
    base_url: (apiUrl as string).replace(/\/+$/, ""),
    models: models.map((m) => ({
      name: m,
      context_limit: 128000,
    })),
    headers: Object.keys(headers).length > 0 ? headers : null,
    timeout_seconds: null,
    supports_streaming: supportsStreaming,
    requires_auth: requiresAuth,
    catalog_provider_id: null,
    base_path: (basePath as string).trim() || null,
    env_vars: null,
    dynamic_models: null,
    skip_canonical_filtering: false,
    model_doc_link: null,
    setup_steps: [],
    fast_model: null,
    preserves_thinking: preservesThinking,
    setup: null,
  };

  try {
    if (!existsSync(CUSTOM_PROVIDERS_DIR)) {
      mkdirSync(CUSTOM_PROVIDERS_DIR, { recursive: true });
    }
    writeFileSync(
      join(CUSTOM_PROVIDERS_DIR, `${providerId}.json`),
      JSON.stringify(providerJson, null, 2),
      "utf-8",
    );

    // Store API key as env var — write to process.env for current session
    if (requiresAuth && apiKey) {
      process.env[apiKeyEnvName] = apiKey as string;

      // Also store in secrets.yaml so Goose can find it.
      // IMPORTANT: Goose v1.47.0 with GOOSE_DISABLE_KEYRING=1 initializes
      // secrets.yaml with "{}" (empty JSON/YAML mapping). If we just append
      // to "{}", we get "{}\nKEY: VALUE\n" which confuses Goose — it sees
      // the empty mapping and may ignore or overwrite our key.
      // So we must start from scratch, not append to existing content.
      const secretsPath = join(homedir(), ".config", "goose", "secrets.yaml");
      try {
        const newEntry = `${apiKeyEnvName}: ${apiKey}\n`;
        // Read existing secrets, preserving any that aren't keyring's empty "{}"
        const existingSecrets = existsSync(secretsPath)
          ? readFileSync(secretsPath, "utf-8").trim()
          : "";
        const isKeyringInit = existingSecrets === "{}" || existingSecrets === "";
        const lines = isKeyringInit
          ? []
          : existingSecrets.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
        const newLines = [...new Map(
          [...lines, newEntry.trim()].map((l) => {
            const ci = l.indexOf(":");
            return ci > 0 ? [l.slice(0, ci).trim(), l] : [l, l];
          }),
        ).values()];
        writeFileSync(secretsPath, newLines.join("\n") + (newLines.length > 0 ? "\n" : ""), "utf-8");
      } catch {
        log.warn(pc.yellow("⚠ Could not store API key in secrets.yaml. Set the env var manually."));
      }
    }

    s.stop(pc.green("✓ Custom provider created successfully!"));
  } catch (e) {
    s.stop(pc.red("✖ Failed to create custom provider"));
    log.error(pc.red(`Error: ${e}`));
    return null;
  }

  // ── Step 10: add to config.yaml ────────────────────────────────────────
  log.info(pc.dim(`Provider file: ${join(CUSTOM_PROVIDERS_DIR, `${providerId}.json`)}`));

  const addToConfig = await confirm({
    message: `Add "${displayName}" (${providerId}) to config.yaml and set as active?`,
    initialValue: true,
  });

  if (isCancel(addToConfig) || !addToConfig) {
    log.info(pc.dim(`Provider is saved but not active. Enable it later with: goose configure or edit ~/.config/goose/config.yaml`));
    return { id: providerId, displayName: displayName as string };
  }

  const added = addToConfigYaml(providerId, defaultModel);
  if (added) {
    log.success(pc.green(`✓ "${displayName}" added to config.yaml`));
  } else {
    log.warn(pc.yellow(`⚠ Could not auto-add to config.yaml. Add manually.`));
  }

  outro(pc.green(`✧ Custom provider "${displayName}" ready! Select it from the provider list.`));

  return { id: providerId, displayName: displayName as string };
}