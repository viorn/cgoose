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

/**
 * Move the entries this project used most recently to the front, in usage
 * order (`history[0]` = last used). Everything else keeps its incoming order,
 * so a caller that hands over goose's list is never re-sorted behind its back.
 *
 * Stable: an entry not in `history` never overtakes another such entry. A
 * history entry with no matching item is ignored here — `orderModelMenu` is
 * what resurrects it as a selectable model.
 */
export function orderByUsage<T extends { value: string }>(
  items: readonly T[],
  history: readonly string[],
): T[] {
  if (history.length === 0) return [...items];
  const rank = new Map<string, number>();
  history.forEach((value, index) => {
    if (!rank.has(value)) rank.set(value, index);
  });
  return [...items].sort((a, b) => {
    const aRank = rank.get(a.value) ?? Number.POSITIVE_INFINITY;
    const bRank = rank.get(b.value) ?? Number.POSITIVE_INFINITY;
    return aRank === bRank ? 0 : aRank - bRank;
  });
}

/**
 * The model menu's entries for one provider, ordered the way the wizard's model
 * step orders them: the project's `modelHistory[provider]` first (last used on
 * top), then goose's list, then the provider JSON's extras.
 *
 * A model that only the history knows is offered too, labelled `history` — the
 * wizard does the same, and applying it either works (goose still serves it,
 * it just stopped advertising it) or fails with a warning from
 * `applySessionConfig`. Silently hiding a model the user picked last week is
 * worse than one stale entry.
 */
export function orderModelMenu(
  items: readonly ModelMenuItem[],
  history: readonly string[],
): ModelMenuItem[] {
  const known = new Map(items.map((item) => [item.value, item]));
  const ordered: ModelMenuItem[] = [];
  const seen = new Set<string>();
  for (const value of history) {
    if (seen.has(value)) continue;
    seen.add(value);
    ordered.push(known.get(value) ?? { value, label: value, description: "history" });
  }
  for (const item of items) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    ordered.push(item);
  }
  return ordered;
}
