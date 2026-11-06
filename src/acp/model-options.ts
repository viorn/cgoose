/**
 * model-options.ts — the model menu's entries.
 *
 * goose keeps declarative providers in an in-process registry that is reloaded
 * only when a provider is created, updated or deleted over ACP
 * (`refresh_custom_providers()` in goose's `providers/init.rs`, called from
 * `acp/server/providers.rs` on `providers/config/{save,delete}`). Writing a
 * model into `custom_providers/<name>.json` — what `/model fetch` does —
 * therefore leaves `configOptions.model.options` stale until goose restarts:
 *
 *   - `session/set_config_option` for `model` goes to `on_set_model`, which only
 *     recreates the provider for the session, and then rebuilds the options from
 *     the same stale inventory (`build_config_update` → `build_model_state`);
 *   - a `provider` switch only schedules an HTTP refresh of the inventory
 *     (`plan_refresh_jobs` → `fetch_recommended_models`, stored as a DB
 *     snapshot) — it never re-reads the JSON, and the background job's
 *     notification arrives long after the response.
 *
 * So the menu re-reads the provider JSON itself, exactly like the wizard's model
 * step (`getCustomProviderModels` in `wizard-steps.ts`), and both UIs agree on
 * what a custom provider offers.
 *
 * Pure: the caller supplies the models it read from the provider JSON.
 */

import { formatNumber } from "../utils";

export interface ModelMenuItem {
  value: string;
  label: string;
  description?: string;
}

/** One `configOptions.model.options` entry as goose reports it. */
export interface GooseModelOption {
  value: string;
  name?: string;
}

/** One entry of a custom provider's `models` array. */
export interface CustomProviderModelOption {
  name: string;
  contextLimit?: number;
}

/**
 * goose's options first — their order and labels are goose's business — then the
 * ones only the provider JSON knows about, de-duplicated by id. A model listed
 * here that the provider no longer serves fails on apply with a warning from
 * `applySessionConfig`, never silently.
 */
export function mergeModelOptions(
  gooseOptions: readonly GooseModelOption[],
  customModels: readonly CustomProviderModelOption[],
): ModelMenuItem[] {
  const known = new Set(gooseOptions.map((option) => option.value));
  const extras: ModelMenuItem[] = [];
  for (const model of customModels) {
    // `addModelToCustomProviderJson` refuses duplicates, but a hand-edited file
    // may still repeat an id; the menu lists it once.
    if (known.has(model.name)) continue;
    known.add(model.name);
    extras.push({
      value: model.name,
      label: model.name,
      description: model.contextLimit
        ? `context: ${formatNumber(model.contextLimit)}`
        : undefined,
    });
  }
  return [
    ...gooseOptions.map((option) => ({ value: option.value, label: option.name ?? option.value })),
    ...extras,
  ];
}
