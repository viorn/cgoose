/**
 * chat-extensions.ts — extension plan management for the chat.
 *
 * Functions: initExtensionPlan, planForSet, applyExtensionPlan,
 * requiredExtensions, allowedExtensionNames, noteExtensionWarning,
 * verifySessionExtensions, reconcileSessionExtensions, applySystemPrompt.
 */

import pc from "picocolors";
import { Text } from "@earendil-works/pi-tui";

import {
  buildMcpServers,
  diffExtensions,
  extensionName,
  listedExtensionName,
  planGooseExtensions,
  planProfileExtensions,
} from "./extensions";
import { listGooseExtensions, buildExtensionArgs } from "../goose-extensions";
import { writeProjectMeta } from "../project";
import { addSessionExtension, removeSessionExtension, setSessionSystemPrompt, listSessionExtensions } from "./custom";
import { PROMPT_KEY, LEGACY_PROMPT_KEY } from "./chat-context";
import type { AcpChatOptions, ChatContext } from "./chat-context";
import type { SessionSet } from "../rossii-config";
import type { GooseExtension } from "./types";

// ─── Extension plan helpers ──────────────────────────────────────────────────

/**
 * The plan a freshly launched chat starts from.
 *
 * Chat mode has no `--no-profile` flag, but goose's `_meta.enabledExtensions`
 * REPLACES the profile's extension list — an empty array therefore means
 * "no extensions at all", exactly like classic `--no-profile`. The Default
 * set opts out and lets goose load its profile.
 */
export function initExtensionPlan(ctx: ChatContext, opts: AcpChatOptions): void {
  ctx.plan = planGooseExtensions({
    builtins: opts.agentBuiltins,
    stdio: opts.stdioExtensionSpecs,
    http: opts.httpExtensionUris,
  });
  // Sent as well: goose ignores `mcpServers` only when it honours the typed
  // list, so older versions still receive the set's servers (additively).
  ctx.mcpServers = buildMcpServers({
    stdio: opts.stdioExtensionSpecs,
    http: opts.httpExtensionUris,
  });
  // A spec with inline env values cannot be expressed through goose's extension
  // API, so such a set falls back to the additive behaviour.
  ctx.exactSet = !opts.useDefaultProfile && ctx.plan.unsupported.length === 0;

  // Default on RESUME needs the same treatment even though a new Default session
  // simply lets goose load its profile: `session/load` restores the stored set
  // (say, the `None` the session was created with) and goose has no
  // "reset to profile" request. So the profile is rebuilt from config.yaml and
  // reconciled like an exact set — that is what makes switching a session to
  // Default actually bring the extensions back.
  //
  // The profile comes from config.yaml, not from
  // `_goose/unstable/config/extensions/list`: goose filters HIDDEN platform
  // extensions out of that listing (`is_hidden_extension`), and in 1.57 the
  // hidden ones are `scheduler` and `orchestrator`. Building Default from the
  // RPC would silently drop the scheduler on every switch.
  ctx.profilePlan = opts.useDefaultProfile ? planProfileExtensions(listGooseExtensions()) : null;
  /** The extension list this session must end up with. */
  ctx.desiredExtensions = ctx.profilePlan ? ctx.profilePlan.extensions : ctx.plan.extensions;
  /** Enabled profile extensions ACP cannot carry (inline env): leave untouched. */
  ctx.protectedNames = new Set((ctx.profilePlan?.unsupported ?? []).map((entry) => entry.name));
}

/** Rebuild the whole extension plan for another set.
 *
 *  `buildExtensionArgs` resolves the `extensions:` names a set lists against
 *  config.yaml — the very same step the launcher performs at startup — so a
 *  live switch produces the list the session would have been created with. */
export function planForSet(set: SessionSet | undefined, useDefault: boolean): {
  plan: ReturnType<typeof planGooseExtensions>;
  mcpServers: ReturnType<typeof buildMcpServers>;
  exactSet: boolean;
  profilePlan: ReturnType<typeof planProfileExtensions> | null;
  desiredExtensions: GooseExtension[];
  protectedNames: Set<string>;
  warnings: string[];
} {
  const extArgs = set
    ? buildExtensionArgs(set.extensions ?? [])
    : { builtins: [], stdio: [], http: [], warnings: [] };
  const builtins = [...new Set([...(set?.builtins ?? []), ...extArgs.builtins])];
  const stdio = [...(set?.stdioExtensions ?? []), ...extArgs.stdio];
  const http = [...extArgs.http];
  const nextPlan = planGooseExtensions({ builtins, stdio, http });
  const nextProfilePlan = useDefault ? planProfileExtensions(listGooseExtensions()) : null;
  return {
    plan: nextPlan,
    mcpServers: buildMcpServers({ stdio, http }),
    // Same rule as at startup: an inline-env stdio spec cannot be expressed
    // through goose's extension API, so such a set stays additive.
    exactSet: !useDefault && nextPlan.unsupported.length === 0,
    profilePlan: nextProfilePlan,
    desiredExtensions: nextProfilePlan ? nextProfilePlan.extensions : nextPlan.extensions,
    protectedNames: new Set((nextProfilePlan?.unsupported ?? []).map((entry) => entry.name)),
    warnings: extArgs.warnings,
  };
}

/** Make the new plan the one the session is reconciled against. Warnings are
 *  per-configuration, so they are dropped (a warning that still applies is
 *  reported again by the reconciliation that follows). */
export function applyExtensionPlan(ctx: ChatContext, next: ReturnType<typeof planForSet>): void {
  ctx.plan = next.plan;
  ctx.mcpServers = next.mcpServers;
  ctx.exactSet = next.exactSet;
  ctx.profilePlan = next.profilePlan;
  ctx.desiredExtensions = next.desiredExtensions;
  ctx.protectedNames = next.protectedNames;
  ctx.extensionWarnings.clear();
}

/** Extensions the session MUST have (exactly what the set lists). */
export function requiredExtensions(ctx: ChatContext): GooseExtension[] {
  return ctx.desiredExtensions;
}

/** Extensions the session is allowed to have on top. */
export function allowedExtensionNames(ctx: ChatContext): Set<string> {
  const allowed = new Set(ctx.desiredExtensions.map(extensionName));
  allowed.add("developer");
  return allowed;
}

/** Record a warning about extensions (deduplicated). */
export function noteExtensionWarning(ctx: ChatContext, message: string): void {
  if (ctx.extensionWarnings.has(message)) return;
  ctx.extensionWarnings.add(message);
  ctx.transcript.addChild(new Text(pc.yellow(`⚠ ${message}`), 1, 0));
  ctx.tui.requestRender();
}

/**
 * Persist the live selection to the project meta — the same file the wizard
 * writes in `prepareLaunch()`, keyed by the working directory.
 */
export function persistSelection(ctx: ChatContext): void {
  try {
    writeProjectMeta(ctx.currentProvider, ctx.currentModel, ctx.currentSetKey);
  } catch (error) {
    ctx.transcript.addChild(
      new Text(
        pc.yellow(`⚠ Could not save the configuration to the project history: ${String((error as Error)?.message ?? error)}`),
        1, 0,
      ),
    );
  }
}

/** New session: did the agent actually apply the typed list? */
export async function verifySessionExtensions(ctx: ChatContext, id: string): Promise<void> {
  let actual: Awaited<ReturnType<typeof listSessionExtensions>>;
  try {
    actual = await listSessionExtensions(ctx.client, id);
  } catch (error) {
    noteExtensionWarning(ctx, `cannot verify the session extension set: ${String((error as Error)?.message ?? error)}`);
    return;
  }
  const allowed = allowedExtensionNames(ctx);
  const required = new Set(requiredExtensions(ctx).map(extensionName));
  const present = new Set(
    actual.map(listedExtensionName).filter((name): name is string => name !== null),
  );
  const leaked = [...present].filter((name) => !allowed.has(name));
  const missing = [...required].filter((name) => !present.has(name));
  if (leaked.length > 0) {
    noteExtensionWarning(ctx,
      `this goose version ignored "enabledExtensions" — the default profile is loaded too (${leaked.join(", ")})`,
    );
  } else if (missing.length > 0) {
    noteExtensionWarning(ctx, `the agent did not load: ${missing.join(", ")}`);
  }
}

/**
 * Apply the set's system prompt, and drop the one stored under the pre-3.0
 * `cgoose` key.
 */
export async function applySystemPrompt(ctx: ChatContext, id: string, text: string): Promise<void> {
  await setSessionSystemPrompt(ctx.client, id, { mode: "set", key: PROMPT_KEY, text });
  try {
    await setSessionSystemPrompt(ctx.client, id, { mode: "set", key: LEGACY_PROMPT_KEY, text: "" });
  } catch {
    // nothing stored under the legacy key — fine
  }
}

/**
 * Resume: `session/load` restores the extension set stored in the session and
 * ignores every extension channel, so the selected set is applied by diffing.
 */
export async function reconcileSessionExtensions(ctx: ChatContext, id: string, context = "resumed session"): Promise<void> {
  let actual: Awaited<ReturnType<typeof listSessionExtensions>>;
  try {
    actual = await listSessionExtensions(ctx.client, id);
  } catch (error) {
    noteExtensionWarning(ctx, `cannot read the session's extensions: ${String((error as Error)?.message ?? error)}`);
    return;
  }
  const desired = requiredExtensions(ctx);
  const desiredNames = new Set(desired.map(extensionName));
  const expected: GooseExtension[] = desiredNames.has("developer")
    ? desired
    : [...desired, { type: "builtin", name: "developer" }];
  const considered = actual.filter((entry) => {
    const name = listedExtensionName(entry);
    return name === null || !ctx.protectedNames.has(name);
  });
  const diff = diffExtensions(expected, considered);
  const add = diff.add.filter((extension) => desiredNames.has(extensionName(extension)));
  const remove = diff.remove;
  for (const entry of remove) {
    try {
      await removeSessionExtension(ctx.client, id, entry.key);
    } catch (error) {
      noteExtensionWarning(ctx, `could not remove extension "${entry.name}": ${String((error as Error)?.message ?? error)}`);
    }
  }
  for (const extension of add) {
    try {
      await addSessionExtension(ctx.client, id, extension);
    } catch (error) {
      noteExtensionWarning(ctx,
        `could not add extension "${extensionName(extension)}": ${String((error as Error)?.message ?? error)}`,
      );
    }
  }
  if (add.length > 0 || remove.length > 0) {
    const parts: string[] = [];
    if (add.length > 0) parts.push(`added ${add.map(extensionName).join(", ")}`);
    if (remove.length > 0) parts.push(`removed ${remove.map((entry) => entry.name).join(", ")}`);
    ctx.transcript.addChild(new Text(
      pc.yellow(
        `${ctx.profilePlan ? "default profile" : "set"} applied to the ${context}: ${parts.join("; ")}`,
      ),
      1, 0,
    ));
  }
}
