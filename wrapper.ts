#!/usr/bin/env bun
/**
 * cgoose — TUI Wrapper for Goose CLI
 *
 * Usage: bun run wrapper.ts [options]
 *   --provider <name>   Provider name (required)
 *   --model <name>      Model name (required)
 *   --session-id <id>   Resume existing session by ID
 *   --session-name <n>  Session name (for new or resume-by-name)
 *   --resume            Resume last session or by session-id/name
 *   --fork              Fork an existing session
 *   --fresh             Start a fresh session (default if no --resume/--fork)
 *
 * Hotkeys (inside session):
 *   Ctrl+P — change model/provider
 *   Ctrl+F — fork current session
 *   Ctrl+Q — quit wrapper
 *   Ctrl+C — forwarded to goose
 */
import { spawn, Terminal } from "bun";
import process from "node:process";
import path from "node:path";
import {
  readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { intro, outro, isCancel, log, select, confirm, text } from "@clack/prompts";
import pc from "picocolors";

// ─── CLI args ──────────────────────────────────────────────────────────────
interface WrapperArgs {
  provider: string;
  model: string;
  sessionId?: string;
  sessionName?: string;
  resume: boolean;
  fork: boolean;
  fresh: boolean;
}

function parseArgs(): WrapperArgs {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  return {
    provider: get("--provider") || "",
    model: get("--model") || "",
    sessionId: get("--session-id"),
    sessionName: get("--session-name"),
    resume: has("--resume"),
    fork: has("--fork"),
    fresh: has("--fresh") || (!has("--resume") && !has("--fork")),
  };
}

// ─── Paths ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(homedir(), ".config", "goose", "config.yaml");
const CUSTOM_PROVIDERS_DIR = path.join(homedir(), ".config", "goose", "custom_providers");
const CGOOSE_DIR = path.join(homedir(), ".config", "cgoose", "projects");

// ─── Parse providers from config.yaml ──────────────────────────────────────
interface ProviderInfo {
  name: string;
  model: string;
  engine?: string;
  baseUrl?: string;
  authToken?: string;
}

function parseYamlProviders(raw: string): ProviderInfo[] {
  const lines = raw.split("\n");
  const result: ProviderInfo[] = [];
  let inProviders = false;
  let curName = "";
  let curEnabled = false;
  for (const rl of lines) {
    const line = rl.trimEnd();
    if (line.startsWith("providers:")) { inProviders = true; continue; }
    if (!inProviders) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t") && line.length > 0 && !line.startsWith("#")) {
      const ci = line.indexOf(":");
      if (ci > 0) break;
    }
    const t = line.trim();
    if (t.endsWith(":") && !t.startsWith("-") && t.length > 1) {
      curName = t.slice(0, -1); curEnabled = false; continue;
    }
    if (t.startsWith("enabled:")) {
      curEnabled = t.split("enabled:")[1]?.trim() === "true"; continue;
    }
    if (t.startsWith("model:") && curName && curEnabled) {
      const m = t.split("model:")[1]?.trim();
      if (m) result.push({ name: curName, model: m });
      curName = ""; curEnabled = false;
    }
  }
  return result;
}

function enrichProviders(providers: ProviderInfo[]): ProviderInfo[] {
  if (!existsSync(CUSTOM_PROVIDERS_DIR)) return providers;
  for (const f of readdirSync(CUSTOM_PROVIDERS_DIR).filter((x) => x.endsWith(".json"))) {
    try {
      const d = JSON.parse(readFileSync(path.join(CUSTOM_PROVIDERS_DIR, f), "utf-8"));
      const p = providers.find((x) => x.name === d.name);
      if (!p) continue;
      const auth = d.headers?.Authorization || d.headers?.authorization || "";
      p.engine = d.engine || "openai";
      p.baseUrl = d.base_url || "";
      p.authToken = auth.replace(/^Bearer\s+/i, "");
    } catch { /* skip */ }
  }
  return providers;
}

function getProviders(): ProviderInfo[] {
  if (!existsSync(CONFIG_PATH)) return [];
  return enrichProviders(parseYamlProviders(readFileSync(CONFIG_PATH, "utf-8")));
}

function getProjectKey(): string {
  const dir = path.resolve(".");
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return path.basename(dir) + "-" + hash;
}

function readProjectMeta(): any {
  const p = path.join(CGOOSE_DIR, getProjectKey() + ".json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function writeProjectMeta(m: any): void {
  if (!existsSync(CGOOSE_DIR)) mkdirSync(CGOOSE_DIR, { recursive: true });
  writeFileSync(path.join(CGOOSE_DIR, getProjectKey() + ".json"), JSON.stringify(m, null, 2) + "\n");
}

// ─── Session list (for resume detection) ───────────────────────────────────
function listSessions(): any[] {
  try {
    const out = Bun.spawnSync(["goose", "session", "list", "--format", "json"], { env: { ...process.env } });
    const text = out.stdout.toString();
    const s = text.indexOf("["); const e = text.lastIndexOf("]");
    if (s === -1 || e === -1) return [];
    return JSON.parse(text.slice(s, e + 1));
  } catch { return []; }
}

// ─── State ───────────────────────────────────────────────────────────────────
let currentGoose: any = null;
let currentPtyWriter: any = null;
let currentProvider = "";
let currentModel = "";
let wrapperRunning = true;

// ─── Launch Goose ───────────────────────────────────────────────────────────
async function launchGoose(
  provider: string,
  model: string,
  sessionId?: string | null,
  sessionName?: string | null,
  options?: { fork?: boolean; fresh?: boolean },
): Promise<void> {
  const args: string[] = ["session"];

  if (sessionId) {
    args.push("--resume", "--session-id", sessionId);
  } else if (sessionName && !options?.fresh) {
    // Try to resume by name if session exists
    args.push("--resume", "--name", sessionName);
  } else if (options?.fork) {
    args.push("--resume", "--fork", "--history");
  } else if (!options?.fresh) {
    args.push("--resume", "--history");
  } else if (sessionName) {
    // New session with a name
    args.push("--name", sessionName);
  }
  args.push("--provider", provider, "--model", model);

  console.log(
    "\n" + pc.green("🐥") + " " + pc.bold("Starting Goose session...") +
    "\n  " + pc.dim("Provider:") + " " + pc.yellow(provider) +
    "\n  " + pc.dim("Model:") + " " + pc.magenta(model) +
    "\n  " + pc.dim("Mode:") + " " + (options?.fork ? "fork" : sessionId ? "resume-by-id" : sessionName && !options?.fresh ? "resume-by-name" : "new") +
    "\n  " + pc.dim("Session:") + " " + pc.cyan(sessionName || sessionId || "(auto)") +
    "\n",
  );

  const g = spawn(["goose", ...args], {
    pty: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    cwd: path.resolve("."),
  });

  currentGoose = g;
  currentPtyWriter = g.stdin;  // FileSink — has .write() directly
  currentProvider = provider;
  currentModel = model;
}

// ─── Pipe goose output to real terminal ────────────────────────────────────
function pipeGooseOutput(g: any): void {
  if (g.stdout) {
    (async () => {
      const reader = g.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (wrapperRunning && !g.killed) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stdout.write(decoder.decode(value, { stream: true }));
        }
      } catch { /* terminated */ }
    })();
  }
  if (g.stderr) {
    (async () => {
      const reader = g.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stderr.write(decoder.decode(value, { stream: true }));
        }
      } catch { /* terminated */ }
    })();
  }
}

// ─── Model change dialog ────────────────────────────────────────────────────
async function modelDialog(
  currentProv: string,
  currentModel_: string,
): Promise<{ provider: string; model: string } | null> {
  const providers = getProviders();
  if (providers.length === 0) {
    log.error(pc.red("No providers configured"));
    return null;
  }
  const meta = readProjectMeta();
  const lastProv = meta?.provider || "";
  const sel = await select({
    message: "Select provider for model change",
    options: providers.map((p) => ({
      label: p.name === lastProv ? p.name + " " + pc.dim("← last") : p.name,
      value: p.name,
      hint: p.model,
    })),
  });
  if (isCancel(sel)) return null;
  const cfg = providers.find((x) => x.name === sel);
  const def = (meta?.provider === sel ? meta.model : null) || cfg?.model || currentModel_;
  const res = await text({
    message: "Model for " + pc.cyan(sel),
    placeholder: def,
  });
  if (isCancel(res)) return null;
  const modelName = (res || "").trim() || def;
  return { provider: sel, model: modelName };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const cliArgs = parseArgs();

  if (!cliArgs.provider || !cliArgs.model) {
    console.error(pc.red("Usage: bun run wrapper.ts --provider <name> --model <name> [--session-id <id>] [--session-name <n>] [--resume] [--fork] [--fresh]"));
    process.exit(1);
  }

  console.clear();
  intro(pc.bgCyan(pc.black(" cgoose-wrapper ")) + pc.dim(" — PTY wrapper"));

  writeProjectMeta({ provider: cliArgs.provider, model: cliArgs.model });

  // Detect latest session if --resume without specific session-id/name
  let sessionId = cliArgs.sessionId;
  let sessionName = cliArgs.sessionName;

  if (cliArgs.resume && !sessionId && !sessionName) {
    const sessions = listSessions();
    const cwd = path.resolve(".");
    const dirSessions = sessions.filter((s: any) => s.working_dir === cwd);
    if (dirSessions.length > 0) {
      sessionId = dirSessions[0].id;
    }
  }

  await launchGoose(
    cliArgs.provider,
    cliArgs.model,
    sessionId || null,
    sessionName || null,
    { fork: cliArgs.fork, fresh: cliArgs.fresh },
  );

  // Terminal raw mode
  const term = new Terminal({
    stdin: process.stdin,
    stdout: process.stdout,
  } as any);
  term.setRawMode(true);
  process.stdin.resume();

  // Pipe output
  if (currentGoose) pipeGooseOutput(currentGoose);

  // Resize handler
  function handleResize() {
    const c = process.stdout.columns;
    const r = process.stdout.rows;
    if (c && r && currentGoose) {
      try { (currentGoose as any).terminal?.resize(r, c); } catch { /* ignore */ }
    }
  }
  process.stdout.on("resize", handleResize);
  handleResize();

  // Key interception
  process.stdin.on("data", (chunk: Buffer) => {
    const k = chunk.toString();

    // Ctrl+P (0x10) — Change model
    if (k === "\x10") {
      setTimeout(async () => {
        term.setRawMode(false);
        const result = await modelDialog(currentProvider, currentModel);
        if (result && currentGoose && !currentGoose.killed) {
          const cmd = "/model --provider " + result.provider + " " + result.model + "\n";
          console.log(pc.yellow("\n  → Switching to " + result.provider + "/" + result.model + "...\n"));
          try { currentPtyWriter!.write(new TextEncoder().encode(cmd)); } catch (e) { log.error(pc.red("Failed: " + e)); }
          currentProvider = result.provider;
          currentModel = result.model;
          writeProjectMeta({ provider: currentProvider, model: currentModel });
        }
        term.setRawMode(true);
      }, 0);
      return;
    }

    // Ctrl+F (0x06) — Fork session
    if (k === "\x06") {
      setTimeout(async () => {
        term.setRawMode(false);
        const confirmed = await confirm({
          message: "Fork this session? A copy will be created and resumed.",
          initialValue: true,
        });
        if (!confirmed) { term.setRawMode(true); return; }
        console.log(pc.yellow("\n  Forking session...\n"));
        try { currentPtyWriter?.close(); } catch {}
        try { currentGoose?.kill("SIGTERM"); } catch {}
        await Bun.sleep(150);
        currentGoose = null;
        currentPtyWriter = null;
        await launchGoose(currentProvider, currentModel, null, null, { fork: true });
        writeProjectMeta({ provider: currentProvider, model: currentModel });
        if (currentGoose) pipeGooseOutput(currentGoose);
        term.setRawMode(true);
      }, 0);
      return;
    }

    // Ctrl+Q (0x11) — Quit
    if (k === "\x11") {
      setTimeout(async () => {
        term.setRawMode(false);
        const confirmed = await confirm({
          message: "Quit wrapper? Session will be saved.",
          initialValue: true,
        });
        if (!confirmed) { term.setRawMode(true); return; }
        wrapperRunning = false;
        try { currentPtyWriter?.close(); } catch {}
        try { currentGoose?.kill("SIGTERM"); } catch {}
        console.log(pc.green("\n✓ Bye!"));
        process.exit(0);
      }, 0);
      return;
    }

    // Ctrl+C (0x03) — Forward to goose
    if (k === "\x03") {
      if (currentPtyWriter) { try { currentPtyWriter.write(new TextEncoder().encode(k)); } catch {} }
      return;
    }

    // Not a hotkey — forward to goose
    if (currentPtyWriter && !currentGoose?.killed) {
      try { currentPtyWriter.write(new TextEncoder().encode(k)); } catch {}
    }
  });

  // Wait for goose to exit
  if (currentGoose) {
    try { await currentGoose.exited; wrapperRunning = false; } catch { /* killed */ }
  }

  // Cleanup
  process.stdin.removeAllListeners("data");
  process.stdout.removeListener("resize", handleResize);
  process.stdin.pause();
  term.setRawMode(false);
  outro(pc.green("Wrapper closed"));
}

main().catch((e) => {
  console.error(pc.red("Failed: " + e));
  process.exit(1);
});