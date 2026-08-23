/**
 * Model discovery — Ollama detection + OpenAI-compatible API fetcher
 */

import type { ProviderInfo } from "./config";
import { spinner } from "@clack/prompts";

// ─── Ollama ──────────────────────────────────────────────────────────────────

const OLLAMA_HOST = "http://localhost:11434";

export interface OllamaModelInfo {
  name: string;
  supportsTools: boolean;
}

/** Check if Ollama is running and return available models with capabilities */
export async function detectOllama(): Promise<OllamaModelInfo[] | null> {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const models: OllamaModelInfo[] = (data.models || [])
      .map((m: any) => ({
        name: m.name,
        supportsTools: (m.capabilities || []).includes("tools"),
      }))
      .sort((a: OllamaModelInfo, b: OllamaModelInfo) => a.name.localeCompare(b.name));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

// ─── OpenAI API model fetcher ────────────────────────────────────────────────

export async function fetchModelsFromApi(provider: ProviderInfo): Promise<string[]> {
  if (!provider.authToken) {
    const envHint = provider.apiKeyEnv || `${provider.name.replace(/^custom_/, "").toUpperCase()}_API_KEY`;
    throw new Error(
      `No API key found for "${provider.name}". ` +
      `Check that the ${envHint} environment variable is set.`
    );
  }

  const base = provider.baseUrl!.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.authToken) headers["Authorization"] = `Bearer ${provider.authToken}`;

  const s = spinner();
  s.start(`Fetching models from ${provider.baseUrl}...`);

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) {
    const envHint = provider.apiKeyEnv || `${provider.name.replace(/^custom_/, "").toUpperCase()}_API_KEY`;
    throw new Error(
      `Authentication failed (HTTP ${response.status}). ` +
      `The API key for "${provider.name}" may be invalid or expired. ` +
      `Check your $${envHint} environment variable.`
    );
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const data: any = await response.json();
  const models: string[] = (data.data || []).map((m: any) => m.id).sort();
  s.stop(`Found ${models.length} models`);
  return models;
}