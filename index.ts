#!/usr/bin/env bun
/**
 * cgoose — TUI for Goose AI Sessions
 *
 * Features:
 * - интерактивный поиск сессий / провайдеров / моделей (autocomplete)
 * - создание новой сессии с именем вида project-YYYY-MM-DD-HH-mm
 * - выбор провайдера из enabled в config.yaml
 * - показывает последний использованный провайдер/модель (из .goose-tui.json)
 * - Fetch моделей через OpenAI API (v1/models) для custom-провайдеров
 * - запуск goose session --resume/--name --provider --model --history
 */

import { execSync, spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { autocomplete, confirm, intro, isCancel, log, outro, select, spinner, text } from "@clack/prompts";
import pc from "picocolors";

// ─── Paths ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "goose", "config.yaml");
const CUSTOM_PROVIDERS_DIR = join(homedir(), ".config", "goose", "custom_providers");
const SESSION_STORE_PATH = ".goose-tui.json";

// ─── Types ───────────────────────────────────────────────────────────────────

interface GooseSession {
  id: string;
  name: string;
  working_dir: string;
  provider_name: string | null;
  model_config: { model_name: string } | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface ProviderInfo {
  name: string;
  model: string;
  engine?: string;
  baseUrl?: string;
  authToken?: string;
}

interface SessionMeta {
  provider: string;
  model: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCurrentDirName(): string {
  return basename(resolve("."));
}

function parseYamlProviders(raw: string): ProviderInfo[] {
  const lines = raw.split("\n");
  const providers: ProviderInfo[] = [];
  let inProviders = false, currentName = "", currentEnabled = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("providers:")) { inProviders = true; continue; }
    if (!inProviders) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t") && line.length > 0 && !line.startsWith("#")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx);
        if (key.trim().length > 0 && !key.trim().startsWith("-")) break;
      }
    }
    const trimmed = line.trim();
    if (trimmed.endsWith(":") && !trimmed.startsWith("-") && trimmed.length > 1) {
      currentName = trimmed.slice(0, -1);
      currentEnabled = false;
      continue;
    }
    if (trimmed.startsWith("enabled:")) {
      currentEnabled = trimmed.split("enabled:")[1]?.trim() === "true";
      continue;
    }
    if (trimmed.startsWith("model:") && currentName && currentEnabled) {
      const model = trimmed.split("model:")[1]?.trim();
      if (model) providers.push({ name: currentName, model });
      currentName = "";
      currentEnabled = false;
    }
  }
  return providers;
}

/** Enrich providers with engine/base_url/auth from custom_providers JSON files */
function enrichProviders(providers: ProviderInfo[]): ProviderInfo[] {
  if (!existsSync(CUSTOM_PROVIDERS_DIR)) return providers;
  for (const file of readdirSync(CUSTOM_PROVIDERS_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(readFileSync(join(CUSTOM_PROVIDERS_DIR, file), "utf-8"));
      const p = providers.find((x) => x.name === data.name);
      if (!p) continue;
      const authHeader = data.headers?.Authorization || data.headers?.authorization || "";
      p.engine = data.engine || "openai";
      p.baseUrl = data.base_url || "";
      p.authToken = authHeader.replace(/^Bearer\s+/i, "");
    } catch { /* skip corrupt files */ }
  }
  return providers;
}

function getConfigProviders(): ProviderInfo[] {
  if (!existsSync(CONFIG_PATH)) return [];
  return enrichProviders(parseYamlProviders(readFileSync(CONFIG_PATH, "utf-8")));
}

function getAllSessions(): GooseSession[] {
  try {
    const output = execSync("goose session list --format json", {
      encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const jsonStart = output.indexOf("[");
    const jsonEnd = output.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd === -1) return [];
    return JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as GooseSession[];
  } catch { return []; }
}

function readSessionMeta(sessionName: string): SessionMeta | null {
  if (!existsSync(SESSION_STORE_PATH)) return null;
  try {
    const store: Record<string, SessionMeta> = JSON.parse(readFileSync(SESSION_STORE_PATH, "utf-8"));
    return store[sessionName] ?? null;
  } catch { return null; }
}

function writeSessionMeta(sessionName: string, meta: SessionMeta): void {
  let store: Record<string, SessionMeta> = {};
  if (existsSync(SESSION_STORE_PATH)) {
    try { store = JSON.parse(readFileSync(SESSION_STORE_PATH, "utf-8")); } catch { /* ignore */ }
  }
  store[sessionName] = meta;
  writeFileSync(SESSION_STORE_PATH, JSON.stringify(store, null, 2) + "\n");
}

function generateSessionName(prefix: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

// ─── OpenAI API model fetcher ────────────────────────────────────────────────

async function fetchModelsFromApi(provider: ProviderInfo): Promise<string[]> {
  const url = `${provider.baseUrl!.replace(/\/+$/, "")}/v1/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.authToken) headers["Authorization"] = `Bearer ${provider.authToken}`;

  const s = spinner();
  s.start(`Fetching models from ${provider.baseUrl}...`);

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const data: any = await response.json();
  const models: string[] = (data.data || []).map((m: any) => m.id).sort();
  s.stop(`Found ${models.length} models`);
  return models;
}

// ─── Launch Goose ────────────────────────────────────────────────────────────

function launchGoose(sessionName: string, provider: string, model: string, isNew: boolean): void {
  writeSessionMeta(sessionName, { provider, model });

  const args = ["session"];
  if (!isNew) args.push("--resume");
  args.push("--name", sessionName, "--provider", provider, "--model", model, "--history");

  console.log(
    `\n${pc.green("🚀")} ${pc.bold("Launching Goose...")}
  ${pc.dim("Session:")}  ${pc.cyan(sessionName)}
  ${pc.dim("Provider:")} ${pc.yellow(provider)}
  ${pc.dim("Model:")}    ${pc.magenta(model)}
  ${pc.dim("Command:")}  ${pc.dim(`goose ${args.join(" ")}`)}
  `,
  );

  const child = spawn("goose", args, { stdio: "inherit", env: { ...process.env } });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ─── Main TUI ────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  intro(`${pc.bgCyan(pc.black(" cgoose "))} ${pc.dim("— TUI for Goose AI Sessions")}`);

  const projectName = getCurrentDirName();
  const sessionPrefix = projectName;
  const configProviders = getConfigProviders();
  const allSessions = getAllSessions();
  const cwd = resolve(".");
  const dirSessions = allSessions.filter((s) => s.working_dir === cwd);

  if (configProviders.length === 0) {
    log.error(pc.red(`✖ No enabled providers found in ${CONFIG_PATH}`));
    log.info(pc.dim("  Run 'goose configure' to set up a provider first."));
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Session — interactive autocomplete
  // ═══════════════════════════════════════════════════════════════════════════

  const sessionOptions: { label: string; value: string; hint?: string }[] = [
    {
      label: pc.green("✦ Create new session"),
      value: "__new__",
      hint: `prefix: ${sessionPrefix}`,
    },
  ];

  const sessionHints = new Map<string, string>();

  for (const s of dirSessions.slice(0, 50)) {
    const meta = readSessionMeta(s.id);
    const prov = s.provider_name ?? meta?.provider ?? "—";
    const model = s.model_config?.model_name ?? meta?.model ?? "—";
    const modelShort = model.length > 30 ? model.slice(0, 27) + "…" : model;
    const dateStr = s.created_at
      ? new Date(s.created_at).toLocaleDateString("ru-RU", {
          day: "2-digit", month: "2-digit", year: "numeric",
          hour: "2-digit", minute: "2-digit",
        })
      : "—";
    const msgHint = s.message_count > 0 ? `(${s.message_count} msgs)` : "";
    const hint = `${dateStr} ${prov} ${modelShort} ${msgHint}`.trim();
    sessionHints.set(s.id, hint);
    sessionOptions.push({ label: pc.bold(s.id), value: s.id, hint });
  }

  if (dirSessions.length === 0) {
    sessionOptions.push({
      label: pc.dim(pc.italic("(no sessions for this directory yet)")),
      value: "__empty__",
      hint: "",
    });
  }

  const selectedSession = await autocomplete({
    message: "Session:",
    placeholder: "Type to filter sessions...",
    options: sessionOptions,
    maxItems: 12,
    filter: (search, opt) => {
      const haystack = `${opt.value} ${opt.label} ${opt.hint || ""}`.toLowerCase();
      return haystack.includes(search.toLowerCase());
    },
  });

  if (isCancel(selectedSession)) {
    outro(pc.yellow("See you next time! 👋"));
    process.exit(0);
  }

  let sessionName: string;
  let lastMeta: SessionMeta | null = null;
  let isNewSession = false;

  if (selectedSession === "__new__" || selectedSession === "__empty__") {
    isNewSession = true;
    const suggested = generateSessionName(sessionPrefix);
    const customName = await text({
      message: "Session name:",
      placeholder: suggested,
      defaultValue: suggested,
      validate: (val) => {
        if (!val || val.trim().length === 0) return "Name cannot be empty";
        if (val.includes(" ")) return "Name cannot contain spaces";
        if (allSessions.find((s) => s.id === val.trim())) return `Session "${val}" already exists`;
        return;
      },
    });

    if (isCancel(customName)) process.exit(0);
    sessionName = (customName as string).trim() || suggested;
  } else {
    sessionName = selectedSession as string;
    lastMeta = readSessionMeta(sessionName);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Provider — interactive autocomplete
  // ═══════════════════════════════════════════════════════════════════════════

  const lastProviderRaw = lastMeta?.provider ?? null;
  const sessionObj = allSessions.find((s) => s.id === sessionName);
  const sessionProvider = sessionObj?.provider_name ?? null;

  const providerOptions = configProviders.map((p) => {
    let hint = p.model;
    let isDefault = false;

    if (p.name === lastProviderRaw) {
      hint += ` ${pc.dim("(last used)")}`;
      isDefault = true;
    } else if (p.name === sessionProvider && !lastProviderRaw) {
      hint += ` ${pc.dim("(session provider)")}`;
      isDefault = true;
    }

    return {
      label: isDefault ? `${p.name} ${pc.dim("←")}` : p.name,
      value: p.name,
      hint,
    };
  });

  const selectedProvider = await autocomplete({
    message: "Provider:",
    placeholder: "Type to filter providers...",
    options: providerOptions,
    maxItems: 10,
    filter: (search, opt) => {
      const haystack = `${opt.value} ${opt.label} ${opt.hint || ""}`.toLowerCase();
      return haystack.includes(search.toLowerCase());
    },
  });

  if (isCancel(selectedProvider)) process.exit(0);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: Model — interactive autocomplete with API fetch option
  // ═══════════════════════════════════════════════════════════════════════════

  const selectedProviderName = selectedProvider as string;
  const providerCfg = configProviders.find((p) => p.name === selectedProviderName)!;
  const defaultModel = lastMeta?.provider === selectedProviderName
    ? lastMeta.model
    : providerCfg?.model ?? "";

  const supportsApiFetch = providerCfg?.engine === "openai" && !!providerCfg?.baseUrl;

  let modelValue = "";

  // Build model selection options — default model first for quick Enter-spam
  const modelOptions: { label: string; value: string; hint?: string }[] = [];

  // 1) Default model (last used or from config) — always first for quick Enter
  if (defaultModel) {
    modelOptions.push({
      label: pc.green(`✦ ${defaultModel}`),
      value: defaultModel,
      hint: pc.dim("last used"),
    });
  }

  // 2) Type manually
  modelOptions.push({
    label: pc.bold("✎ Type manually"),
    value: "__manual__",
    hint: defaultModel ? pc.dim(`default: ${defaultModel}`) : "",
  });

  // 3) Fetch from API (if supported) — last resort
  if (supportsApiFetch) {
    modelOptions.push({
      label: pc.cyan("🔄 Fetch from API"),
      value: "__api_fetch__",
      hint: providerCfg.baseUrl,
    });
  }

  const modelChoice = await autocomplete({
    message: `Model for ${pc.cyan(selectedProviderName)}:`,
    placeholder: "Type to search or select an option...",
    options: modelOptions,
    maxItems: 12,
    filter: (search, opt) => {
      const haystack = `${opt.value} ${opt.label} ${opt.hint || ""}`.toLowerCase();
      return haystack.includes(search.toLowerCase());
    },
  });

  if (isCancel(modelChoice)) process.exit(0);

  if (modelChoice === "__api_fetch__") {
    // ── Fetch models from API ─────────────────────────────────────────────
    try {
      const apiModels = await fetchModelsFromApi(providerCfg);

      if (apiModels.length === 0) {
        log.warn(pc.yellow("No models returned from API."));
        const typed = await text({
          message: `Model for ${pc.cyan(selectedProviderName)}:`,
          placeholder: defaultModel || "gpt-4o",
          defaultValue: defaultModel,
        });
        if (isCancel(typed)) process.exit(0);
        modelValue = (typed as string).trim() || defaultModel;
      } else {
        const apiModelChoice = await autocomplete({
          message: `Select model from ${pc.cyan(providerCfg.baseUrl!)}:`,
          placeholder: `Type to filter ${apiModels.length} models...`,
          options: apiModels.map((m) => ({
            label: m,
            value: m,
            hint: "",
          })),
          maxItems: 15,
          filter: (search, opt) => {
            if (!search) return true;
            return opt.value.toLowerCase().includes(search.toLowerCase());
          },
        });

        if (isCancel(apiModelChoice)) process.exit(0);
        modelValue = apiModelChoice as string;
      }
    } catch (err) {
      log.error(pc.red(`Failed to fetch models: ${err}`));
      const typed = await text({
        message: `Model for ${pc.cyan(selectedProviderName)}:`,
        placeholder: defaultModel || "e.g., deepseek/deepseek-v4-flash",
        defaultValue: defaultModel,
      });
      if (isCancel(typed)) process.exit(0);
      modelValue = (typed as string).trim() || defaultModel;
    }
  } else if (modelChoice === "__manual__") {
    const typed = await text({
      message: `Model for ${pc.cyan(selectedProviderName)}:`,
      placeholder: defaultModel || "e.g., deepseek/deepseek-v4-flash",
      defaultValue: defaultModel,
      validate: (val) => (!val || val.trim().length === 0) ? "Model name cannot be empty" : undefined,
    });

    if (isCancel(typed)) process.exit(0);
    modelValue = (typed as string).trim() || defaultModel;
  } else {
    // User selected a specific model from the list
    modelValue = modelChoice as string;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Summary & Launch
  // ═══════════════════════════════════════════════════════════════════════════

  outro(
    `${pc.green("✓")} Configuration complete:
  ${pc.bold("Session")}:  ${pc.cyan(sessionName)}
  ${pc.bold("Provider")}: ${pc.yellow(selectedProviderName)}
  ${pc.bold("Model")}:    ${pc.magenta(modelValue)}`,
  );

  const shouldLaunch = await confirm({ message: "Launch Goose now?", initialValue: true });

  if (isCancel(shouldLaunch) || !shouldLaunch) {
    outro(pc.yellow("See you next time! 👋"));
    process.exit(0);
  }

  launchGoose(sessionName, selectedProviderName, modelValue, isNewSession);
}

main().catch((err) => {
  console.error(pc.red("\n✖ Fatal error:"), err);
  process.exit(1);
});