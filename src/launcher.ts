/**
 * Launch Goose with session name, provider, and model
 */

import { spawn } from "node:child_process";
import process from "node:process";
import pc from "picocolors";
import { writeProjectMeta } from "./project";
import { getModelContextLimit } from "./config";
import type { ProviderInfo } from "./config";

export function launchGoose(
  sessionName: string,
  providerInfo: ProviderInfo,
  model: string,
  isNew: boolean,
): void {
  writeProjectMeta(providerInfo.name, model);

  // Use the provider name as --provider value (engine is just for API compat)
  // and set appropriate env vars for base URL and auth
  const effectiveProvider = providerInfo.name;
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

  // Set GOOSE_CONTEXT_LIMIT from custom provider JSON so Goose actually uses it
  if (providerInfo.name.startsWith("custom_")) {
    const contextLimit = getModelContextLimit(providerInfo.name, model);
    if (contextLimit !== undefined) {
      delete launchEnv["GOOSE_CONTEXT_LIMIT"]; // clear any stale value
      launchEnv["GOOSE_CONTEXT_LIMIT"] = String(contextLimit);
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