/**
 * `session/new` meta for goose — a pure function so both the shape and the
 * deliberate omissions can be pinned by tests without booting the chat TUI.
 *
 * goose reads every *session* field at the TOP level of `_meta`; `_meta.goose`
 * is only understood for initialize capabilities. `client` is what makes goose
 * create a `SessionType::User` session — without it the session is stored as
 * `Acp`, which `goose session list` never reports.
 */

import type { GooseExtension, NewSessionMeta } from "./types";

export interface NewSessionMetaOptions {
  /** Session name; without it goose keeps its "New Chat" placeholder. */
  sessionTitle?: string;
  /**
   * Exact extension set (`_meta.enabledExtensions`). When present goose REPLACES
   * the profile's extensions, and an empty array means "none at all" — hence the
   * key may exist with an empty value but must never be dropped by accident.
   */
  enabledExtensions?: GooseExtension[];
  /** Client identifier; goose stores `SessionType::User` for any non-empty value. */
  client?: string;
}

export function newSessionMeta(opts: NewSessionMetaOptions): NewSessionMeta {
  // `provider` is deliberately absent even though goose accepts the key: with
  // `_meta.provider` goose resolves the model through
  // `resolve_provider_and_model_config`, which falls back to the provider
  // registry's *default* model and ignores GOOSE_MODEL — so the model picked in
  // the wizard was silently replaced (live on goose 1.57: `_meta.provider:
  // "custom_kodik"` + GOOSE_MODEL=qwen/qwen3.6-flash produced
  // deepseek/deepseek-v4-flash, the first model in the provider's JSON, while
  // GOOSE_PROVIDER/GOOSE_MODEL alone resolved to exactly the picked pair).
  return {
    client: opts.client ?? "rossii",
    // Omitted rather than sent as `undefined`: goose treats a null title as
    // empty and an empty extension list as "no extensions at all".
    ...(opts.sessionTitle ? { sessionTitle: opts.sessionTitle } : {}),
    ...(opts.enabledExtensions ? { enabledExtensions: opts.enabledExtensions } : {}),
  };
}
