#!/usr/bin/env bun
/**
 * cgoose — TUI for Goose AI Sessions
 *
 * Features:
 * - интерактивный поиск сессий / провайдеров / моделей (autocomplete)
 * - создание новой сессии с именем вида project-YYYY-MM-DD-HH-mm
 * - выбор провайдера из enabled в config.yaml
 * - запоминает последний использованный провайдер/модель для проекта
 *   (в ~/.config/cgoose/projects/<dirname>-<hash>.json)
 * - Fetch моделей через OpenAI API (v1/models) для custom-провайдеров
 * - 🦙 auto-детект локального Ollama (минуя конфиги Goose)
 * - запуск goose session [--name] --provider --model [--resume --history]
 */

import { execSync, spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import process from "node:process";
import { autocomplete, confirm, intro, isCancel, log, outro, select, spinner, text, multiselect } from "@clack/prompts";
import pc from "picocolors";

// ─── Paths ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "goose", "config.yaml");
const CUSTOM_PROVIDERS_DIR = join(homedir(), ".config", "goose", "custom_providers");
const CGOOSE_PROJECTS_DIR = join(homedir(), ".config", "cgoose", "projects");

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

interface ProjectMeta {
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
      const envKey = data.api_key_env || "";
      const secretKey = data.secrets?.api_key || data.secrets?.API_KEY || "";
      p.engine = data.engine || "openai";
      p.baseUrl = data.base_url || "";
      p.authToken = authHeader.replace(/^Bearer\s+/i, "") || (envKey ? process.env[envKey] || "" : "") || secretKey;
    } catch { /* skip corrupt files */ }
  }
  return providers;
}

function getConfigProviders(): ProviderInfo[] {
  if (!existsSync(CONFIG_PATH)) return [];
  return enrichProviders(parseYamlProviders(readFileSync(CONFIG_PATH, "utf-8")));
}

/** Set top-level env vars from config.yaml on process.env so child processes inherit them */
function loadConfigEnvVars(): void {
  if (!existsSync(CONFIG_PATH)) return;
  for (const line of readFileSync(CONFIG_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || line[0] === " " || line[0] === "\t") continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const rawVal = trimmed.slice(colonIdx + 1).trim();
    if (!key || !rawVal || process.env[key]) continue;
    let val = rawVal;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
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



/** Delete a session by ID from SQLite db, returns true on success */
const SESSIONS_DB = join(homedir(), ".local/share/goose/sessions/sessions.db");

function deleteSessionById(sessionId: string): boolean {
  try {
    const sql = [
      "BEGIN;",
      `DELETE FROM messages WHERE session_id = '${sessionId}';`,
      `DELETE FROM usage_ledger WHERE session_id = '${sessionId}';`,
      `DELETE FROM sessions WHERE id = '${sessionId}';`,
      "COMMIT;",
    ].join("\n");
    execSync(`sqlite3 "${SESSIONS_DB}"`, {
      input: sql,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Format a session for display */
function formatSessionHint(s: GooseSession): { name: string; hint: string } {
  const prov = s.provider_name ?? "—";
  const model = s.model_config?.model_name ?? "—";
  const modelShort = model.length > 30 ? model.slice(0, 27) + "…" : model;
  const dateStr = s.created_at
    ? new Date(s.created_at).toLocaleDateString("ru-RU", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "—";
  const msgHint = s.message_count > 0 ? "(" + s.message_count + " msgs)" : "";
  const hint = dateStr + " " + prov + " " + modelShort + " " + msgHint;
  return { name: s.name || s.id, hint: hint.trim() };
}

/** Get a stable project key: dirname + short hash of the full path */
function getProjectKey(): string {
  const dir = resolve(".");
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `${basename(dir)}-${hash}`;
}

function getProjectMetaPath(): string {
  return join(CGOOSE_PROJECTS_DIR, `${getProjectKey()}.json`);
}

function readProjectMeta(): ProjectMeta | null {
  const path = getProjectMetaPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ProjectMeta;
  } catch { return null; }
}

function writeProjectMeta(meta: ProjectMeta): void {
  const dir = CGOOSE_PROJECTS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getProjectMetaPath(), JSON.stringify(meta, null, 2) + "\n");
}

function generateSessionName(prefix: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

// ─── Ollama detection ────────────────────────────────────────────────────────

const OLLAMA_HOST = "http://localhost:11434";

interface OllamaTag {
  name: string;
  model: string;
}

/** Check if Ollama is running and return available model names, or null */
async function detectOllama(): Promise<string[] | null> {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const models: string[] = (data.models || []).map((m: any) => m.name).sort();
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

// ─── OpenAI API model fetcher ────────────────────────────────────────────────

async function fetchModelsFromApi(provider: ProviderInfo): Promise<string[]> {
  const base = provider.baseUrl!.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.authToken) headers["Authorization"] = `Bearer ${provider.authToken}`;

  const s = spinner();
  s.start(`Fetching models from ${provider.baseUrl}...`);

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const data: any = await response.json();
  const models: string[] = (data.data || []).map((m: any) => m.id).sort();
  s.stop(`Found ${models.length} models`);
  return models;
}




// ─── Launch Goose ────────────────────────────────────────────────────────────

function launchGoose(sessionName: string, providerInfo: ProviderInfo, model: string, isNew: boolean): void {
  writeProjectMeta({ provider: providerInfo.name, model });

  // For custom providers (with engine), use the engine as --provider value
  // and set appropriate env vars for base URL and auth
  const effectiveProvider = providerInfo.engine || providerInfo.name;
  const launchEnv: Record<string, string> = { ...process.env as Record<string, string> };

  if (providerInfo.engine && providerInfo.baseUrl) {
    // Clear conflicting env vars that may override our base URL
    for (const k of ["OPENAI_HOST", "OPENAI_BASE_PATH", "OPENAI_BASE_URL"]) {
      delete launchEnv[k];
    }
    launchEnv["OPENAI_BASE_URL"] = providerInfo.baseUrl;
    if (providerInfo.authToken) {
      launchEnv["OPENAI_API_KEY"] = providerInfo.authToken;
    }
  }

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
  ${pc.dim("Command:")}  ${pc.dim(`goose ${args.join(" ")}`)}
  `,
  );

  const child = spawn("goose", args, { stdio: "inherit", env: launchEnv });
  child.on("exit", (code) => process.exit(code ?? 0));
}


// ---- Session deletion dialog ------------------------------------------------

async function handleDeleteSessions(
  _allSessions: GooseSession[],
  dirSessions: GooseSession[],
): Promise<boolean> {
  // 1) Choose mode
  const mode = await select({
    message: "Delete sessions:",
    options: [
      { value: "select", label: "Select individually" },
      { value: "all", label: "Clean all sessions in this directory", hint: "(" + dirSessions.length + " sessions)" },
      { value: "back", label: "\u2190 Go back" },
    ],
  });

  if (isCancel(mode) || mode === "back") return false;

  if (mode === "all") {
    if (dirSessions.length === 0) {
      log.info(pc.dim("No sessions in this directory."));
      return false;
    }
    const confirmed = await confirm({
      message: "Delete all " + dirSessions.length + " sessions in " + pc.cyan(resolve(".")) + "?",
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) return false;

    const s = spinner();
    s.start("Deleting " + dirSessions.length + " sessions...");
    let ok = 0, fail = 0;
    for (const session of dirSessions) {
      if (deleteSessionById(session.id)) ok++; else fail++;
    }
    s.stop("Done: " + ok + " deleted, " + fail + " failed");
    return true;
  }

  // 2) Select individually via multiselect
  const sessionOptions = dirSessions.map(function(s) {
    const h = formatSessionHint(s);
    return { label: h.name, value: s.id, hint: h.hint };
  });

  if (sessionOptions.length === 0) {
    log.info(pc.dim("No sessions to delete."));
    return false;
  }

  const selectedIDs = await multiselect({
    message: "Select sessions to delete (Space to toggle, Enter to confirm):",
    options: sessionOptions,
    required: false,
  });

  if (isCancel(selectedIDs) || !selectedIDs || selectedIDs.length === 0) return false;

  const s = spinner();
  s.start("Deleting " + selectedIDs.length + " session(s)...");
  let ok = 0, fail = 0;
  for (const id of selectedIDs as string[]) {
    if (deleteSessionById(id)) ok++; else fail++;
  }
  s.stop("Done: " + ok + " deleted, " + fail + " failed");
  return true;
}

// ─── Main TUI ────────────────────────────────────────────────────────────────

type Step = "session" | "session_name" | "provider" | "model" | "launch";

async function main() {
  console.clear();
  intro(`${pc.bgCyan(pc.black(" cgoose "))} ${pc.dim("— TUI for Goose AI Sessions")}`);

  const projectName = getCurrentDirName();
  const sessionPrefix = projectName;
  loadConfigEnvVars();
  const configProviders = getConfigProviders();
  const ollamaModels = await detectOllama();

  const hasAnyProvider = configProviders.length > 0 || (ollamaModels !== null && ollamaModels.length > 0);

  if (!hasAnyProvider) {
    log.error(pc.red('\u2716 No enabled providers found in ' + CONFIG_PATH));
    log.info(pc.dim("  Run 'goose configure' to set up a provider first, or install Ollama (ollama.com)."));
    process.exit(1);
  }

  // State shared across steps
  let step: Step = "session";
  let sessionName = "";
  let isNewSession = false;
  let selectedProviderName = "";
  let modelValue = "";
  let lastAllSessions: GooseSession[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // Navigation loop — each Esc/cancel goes back one step
  // ═══════════════════════════════════════════════════════════════════════════

  while (true) {
    switch (step) {
      // ─── STEP 1: Session selection ──────────────────────────────────────
      case "session": {
        const allSessions = getAllSessions();
        lastAllSessions = allSessions;
        const cwd = resolve(".");
        const dirSessions = allSessions.filter((s) => s.working_dir === cwd);

        const sessionOptions: { label: string; value: string; hint?: string }[] = [];

        sessionOptions.push({
          label: pc.green("\u2726 Create new session"),
          value: "__new__",
          hint: "prefix: " + sessionPrefix,
        });

        if (dirSessions.length > 0) {
          sessionOptions.push({
            label: pc.yellow("  Delete sessions..."),
            value: "__delete__",
            hint: "(" + dirSessions.length + " available)",
          });
        }

        for (let i = 0; i < dirSessions.length && i < 50; i++) {
          const s = dirSessions[i];
          const { name, hint } = formatSessionHint(s);
          sessionOptions.push({ label: pc.bold(name), value: s.id, hint });
        }

        if (dirSessions.length === 0) {
          sessionOptions.push({
            label: pc.dim(pc.italic("(no sessions for this directory yet)")),
            value: "__empty__",
            hint: "",
          });
        }

        const selected = await autocomplete({
          message: `Session: ${pc.dim("(Esc ← back / exit)")}`,
          placeholder: "Type to filter sessions...",
          options: sessionOptions,
          maxItems: 12,
          filter: (search, opt) => {
            const haystack = opt.value + " " + opt.label + " " + (opt.hint || "");
            return haystack.toLowerCase().includes(search.toLowerCase());
          },
        });

        if (isCancel(selected)) {
          outro(pc.yellow("See you next time!"));
          process.exit(0);
        }

        if (selected === "__delete__") {
          await handleDeleteSessions(allSessions, dirSessions);
          continue; // refresh session list
        }

        if (selected === "__new__" || selected === "__empty__") {
          isNewSession = true;
          step = "session_name";
          continue;
        }

        sessionName = selected as string;
        isNewSession = false;
        step = "provider";
        continue;
      }

      // ─── STEP 2: Session name (only for new sessions) ───────────────────
      case "session_name": {
        const allSessions = getAllSessions();
        const suggested = generateSessionName(sessionPrefix);
        const customName = await text({
          message: `Session name: ${pc.dim("(press Enter for auto-name from first message)")}`,
          placeholder: suggested,
          validate: (val) => {
            if (val && val.includes(" ")) return "Name cannot contain spaces";
            if (val && allSessions.find((s) => s.id === val.trim())) return "Session '" + val + "' already exists";
            return;
          },
        });

        if (isCancel(customName)) {
          step = "session"; // back to session list
          continue;
        }

        sessionName = (customName as string).trim();
        step = "provider";
        continue;
      }

      // ─── STEP 3: Provider selection ─────────────────────────────────────
      case "provider": {
        const lastMeta = isNewSession ? null : readProjectMeta();
        const lastProviderRaw = lastMeta?.provider ?? null;
        const sessionObj = lastAllSessions.find((s) => s.id === sessionName);
        const sessionProvider = sessionObj?.provider_name ?? null;

        const providerOptions: { label: string; value: string; hint?: string }[] = [];

        for (const p of configProviders) {
          let hint = p.model;
          let isDefault = false;

          if (p.name === lastProviderRaw) {
            hint += ` ${pc.dim("(last used)")}`;
            isDefault = true;
          } else if (p.name === sessionProvider && !lastProviderRaw) {
            hint += ` ${pc.dim("(session provider)")}`;
            isDefault = true;
          }

          const opt = {
            label: isDefault ? `${p.name} ${pc.dim("←")}` : p.name,
            value: p.name,
            hint,
          };

          if (p.name === lastProviderRaw) {
            providerOptions.unshift(opt);
          } else {
            providerOptions.push(opt);
          }
        }

        // Add local Ollama if running
        if (ollamaModels && ollamaModels.length > 0) {
          const isOllamaDefault = lastProviderRaw === "ollama";
          const opt = {
            label: isOllamaDefault
              ? `🦙 Ollama (local) ${pc.dim("←")}`
              : `🦙 Ollama (local)`,
            value: "ollama",
            hint: `${ollamaModels.length} model${ollamaModels.length > 1 ? "s" : ""}`,
          };
          if (isOllamaDefault) {
            providerOptions.unshift(opt);
          } else {
            providerOptions.push(opt);
          }
        }

        const selected = await autocomplete({
          message: `Provider: ${pc.dim("(Esc ← back to sessions)")}`,
          placeholder: "Type to filter providers...",
          options: providerOptions,
          maxItems: 10,
          filter: (search, opt) => {
            const haystack = `${opt.value} ${opt.label} ${opt.hint || ""}`.toLowerCase();
            return haystack.includes(search.toLowerCase());
          },
        });

        if (isCancel(selected)) {
          step = "session"; // back to session list
          continue;
        }

        selectedProviderName = selected as string;
        step = "model";
        continue;
      }

      // ─── STEP 4: Model selection ────────────────────────────────────────
      case "model": {
        if (!selectedProviderName) { step = "provider"; continue; }

        // ── Ollama: show models directly from detection ──────────────────
        if (selectedProviderName === "ollama") {
          const lastMeta = isNewSession ? null : readProjectMeta();
          const lastModel = lastMeta?.provider === "ollama" ? lastMeta.model : null;

          const modelOptions = ollamaModels!.map((m) => ({
            label: m === lastModel ? `${m} ${pc.dim("← last used")}` : m,
            value: m,
            hint: "",
          }));

          const selected = await autocomplete({
            message: `Model for ${pc.cyan("🦙 Ollama (local)")}: ${pc.dim("(Esc ← back to provider)")}`,
            placeholder: `Type to filter ${ollamaModels!.length} models...`,
            options: modelOptions,
            maxItems: 15,
            filter: (search, opt) => {
              if (!search) return true;
              return opt.value.toLowerCase().includes(search.toLowerCase());
            },
          });

          if (isCancel(selected)) {
            step = "provider";
            continue;
          }

          modelValue = selected as string;
          step = "launch";
          continue;
        }

        const lastMeta = isNewSession ? null : readProjectMeta();
        const providerCfg = configProviders.find((p) => p.name === selectedProviderName)!;
        const defaultModel = lastMeta?.provider === selectedProviderName
          ? lastMeta.model
          : providerCfg?.model ?? "";

        const supportsApiFetch = providerCfg?.engine === "openai" && !!providerCfg?.baseUrl;

        const modelOptions: { label: string; value: string; hint?: string }[] = [];

        if (defaultModel) {
          modelOptions.push({
            label: pc.green(`✦ ${defaultModel}`),
            value: defaultModel,
            hint: pc.dim("last used"),
          });
        }

        modelOptions.push({
          label: pc.bold("✎ Type manually"),
          value: "__manual__",
          hint: defaultModel ? pc.dim(`default: ${defaultModel}`) : "",
        });

        if (supportsApiFetch) {
          modelOptions.push({
            label: pc.cyan("🔄 Fetch from API"),
            value: "__api_fetch__",
            hint: providerCfg.baseUrl,
          });
        }

        const modelChoice = await autocomplete({
          message: `Model for ${pc.cyan(selectedProviderName)}: ${pc.dim("(Esc ← back to provider)")}`,
          placeholder: "Type to search or select an option...",
          options: modelOptions,
          maxItems: 12,
          filter: (search, opt) => {
            const haystack = `${opt.value} ${opt.label} ${opt.hint || ""}`.toLowerCase();
            return haystack.includes(search.toLowerCase());
          },
        });

        if (isCancel(modelChoice)) {
          step = "provider"; // back to provider
          continue;
        }

        if (modelChoice === "__api_fetch__") {
          try {
            const apiModels = await fetchModelsFromApi(providerCfg);

            if (apiModels.length === 0) {
              log.warn(pc.yellow("No models returned from API."));
              const typed = await text({
                message: `Model for ${pc.cyan(selectedProviderName)}: ${pc.dim("(Esc ← back)")}`,
                placeholder: defaultModel || "gpt-4o",
                defaultValue: defaultModel,
              });
              if (isCancel(typed)) { step = "model"; continue; }
              modelValue = (typed as string).trim() || defaultModel;
            } else {
              const apiModelChoice = await autocomplete({
                message: `Select model from ${pc.cyan(providerCfg.baseUrl!)}: ${pc.dim("(Esc ← back)")}`,
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

              if (isCancel(apiModelChoice)) { step = "model"; continue; }
              modelValue = apiModelChoice as string;
            }
          } catch (err) {
            log.error(pc.red(`Failed to fetch models: ${err}`));
            const typed = await text({
              message: `Model for ${pc.cyan(selectedProviderName)}: ${pc.dim("(Esc ← back)")}`,
              placeholder: defaultModel || "e.g., deepseek/deepseek-v4-flash",
              defaultValue: defaultModel,
            });
            if (isCancel(typed)) { step = "model"; continue; }
            modelValue = (typed as string).trim() || defaultModel;
          }
        } else if (modelChoice === "__manual__") {
          const typed = await text({
            message: `Model for ${pc.cyan(selectedProviderName)}: ${pc.dim("(Esc ← back)")}`,
            placeholder: defaultModel || "e.g., deepseek/deepseek-v4-flash",
            defaultValue: defaultModel,
            validate: (val) => (!val || val.trim().length === 0) ? "Model name cannot be empty" : undefined,
          });

          if (isCancel(typed)) { step = "model"; continue; }
          modelValue = (typed as string).trim() || defaultModel;
        } else {
          modelValue = modelChoice as string;
        }

        step = "launch";
        continue;
      }

      // ─── STEP 5: Summary & Launch ───────────────────────────────────────
      case "launch": {
        const providerCfg: ProviderInfo = selectedProviderName === "ollama"
          ? { name: "ollama", model: modelValue, engine: "ollama" }
          : configProviders.find((p) => p.name === selectedProviderName)!;
        const displayName = sessionName || "(auto — from first message)";
        const displayProvider = selectedProviderName === "ollama"
          ? "🦙 Ollama (local)"
          : selectedProviderName;
        outro(
          `${pc.green("✓")} Configuration complete:
  ${pc.bold("Session")}:  ${pc.cyan(displayName)}
  ${pc.bold("Provider")}: ${pc.yellow(displayProvider)}
  ${pc.bold("Model")}:    ${pc.magenta(modelValue)}`,
        );

        const shouldLaunch = await confirm({ message: `Launch Goose now? ${pc.dim("(Esc ← back to sessions)")}`, initialValue: true });

        if (isCancel(shouldLaunch) || !shouldLaunch) {
          step = "session"; // back to the beginning
          continue;
        }

        launchGoose(sessionName, providerCfg, modelValue, isNewSession);
        return; // never reached — launchGoose replaces process
      }
    }
  }
}

main().catch((err) => {
  console.error(pc.red("\n✖ Fatal error:"), err);
  process.exit(1);
});