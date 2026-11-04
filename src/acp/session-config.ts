/**
 * Applying the wizard's provider/model to an ACP session.
 *
 * `session/new` resolves the provider and model from the agent's own config
 * (`GOOSE_PROVIDER`/`GOOSE_MODEL` env for cgoose), and `session/load` ignores
 * both, keeping whatever the session row says. The ACP-native way to pin them is
 * the `session/set_config_option` request ("SACP 11"), which goose implements for
 * `provider`, `model`, `mode` and `thinking_effort` and persists into
 * `sessions.db` — the same route goose's own ACP client takes for agents whose
 * model is a config option (`crates/goose/src/acp/provider.rs`,
 * `apply_model_if_changed`).
 *
 * Facts verified live on goose 1.57 that shape the plan below:
 *   - `value` is a bare string (`{configId: "model", value: "qwen/qwen3.6-flash"}`);
 *   - changing the PROVIDER resets the model to that provider's default
 *     (`custom_openintegration` → `deepseek/deepseek-v4-flash`), so the model has
 *     to be applied AFTER the provider;
 *   - re-applying an unchanged value is accepted (no error, no-op in effect);
 *   - the response carries the refreshed `configOptions`, i.e. the effective pair;
 *   - an unsupported `configId` is a clean `Invalid params` error, so an older
 *     goose degrades into a warning rather than a broken session.
 */

import type { AcpClient } from "./client";
import type {
  SessionConfigOption,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from "./types";

export interface SessionConfig {
  provider?: string | null;
  model?: string | null;
}

export interface SessionConfigStep {
  configId: "provider" | "model";
  value: string;
}

/**
 * The requests needed to turn `current` into `desired`.
 * Pure: the unit tests pin the ordering rules.
 */
export function planSessionConfig(
  desired: SessionConfig,
  current: SessionConfig = {},
): SessionConfigStep[] {
  const steps: SessionConfigStep[] = [];
  const providerChanged = Boolean(desired.provider && desired.provider !== current.provider);

  // Provider first: the switch makes goose pick the new provider's default
  // model, so a model applied before it would be thrown away.
  if (providerChanged) steps.push({ configId: "provider", value: desired.provider as string });

  // After a provider change the model is re-applied even when it looks equal to
  // the old one — the provider switch just replaced it with its own default.
  if (desired.model && (providerChanged || desired.model !== current.model)) {
    steps.push({ configId: "model", value: desired.model });
  }
  return steps;
}

/** Read one option's current value out of a `configOptions` payload. */
export function optionValue(
  options: SessionConfigOption[] | undefined,
  id: string,
): string | undefined {
  return options?.find((option) => option.id === id)?.currentValue;
}

export interface SessionConfigOutcome {
  /** Effective pair as reported by the agent (falls back to what was requested). */
  provider?: string | null;
  model?: string | null;
  /** Requests actually sent, in order. */
  applied: SessionConfigStep[];
  /** Non-fatal problem to show in the chat (unsupported method, mismatch, …). */
  warning?: string;
}

const CONFIG_TIMEOUT_MS = 60_000;

/**
 * Apply `desired` to a live session. Never throws: a failure becomes a warning,
 * because a session with the wrong model is still usable.
 */
export async function applySessionConfig(
  client: AcpClient,
  sessionId: string,
  desired: SessionConfig,
  current: SessionConfig = {},
): Promise<SessionConfigOutcome> {
  const steps = planSessionConfig(desired, current);
  let provider = current.provider ?? null;
  let model = current.model ?? null;

  for (const step of steps) {
    const params: SetSessionConfigOptionRequest = {
      sessionId,
      configId: step.configId,
      value: step.value,
    };
    try {
      const response = (await client.request(
        "session/set_config_option",
        params,
        CONFIG_TIMEOUT_MS,
      )) as SetSessionConfigOptionResponse;
      // Trust the agent's report when it has one (it knows the effective
      // values); fall back to what was requested only when it reports nothing,
      // so a silent mismatch stays visible in the final check below.
      const reported = optionValue(response?.configOptions, step.configId);
      if (step.configId === "provider") provider = reported ?? step.value;
      else model = reported ?? step.value;
    } catch (error) {
      const detail = String((error as Error)?.message ?? error);
      const unsupported = /unsupported config option|method not found|invalid params/i.test(detail);
      return {
        provider,
        model,
        applied: steps.slice(0, steps.indexOf(step)),
        warning:
          `Could not apply ${step.configId} "${step.value}" via session/set_config_option: ${detail}. ` +
          (unsupported
            ? "This goose may not support switching it through ACP."
            : "The session keeps whatever the agent resolved on its own."),
      };
    }
  }

  // The requested pair is what the wizard promised; say so when the agent ended
  // up somewhere else (e.g. an unchanged provider whose default model won).
  const mismatches: string[] = [];
  if (desired.provider && provider && desired.provider !== provider) {
    mismatches.push(`provider is ${provider}`);
  }
  if (desired.model && model && desired.model !== model) {
    mismatches.push(`model is ${model}`);
  }
  return {
    provider,
    model,
    applied: steps,
    ...(mismatches.length > 0
      ? { warning: `Session runs with ${mismatches.join(", ")} instead of the selected ${desired.provider}/${desired.model}` }
      : {}),
  };
}
