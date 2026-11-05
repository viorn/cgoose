/**
 * command-complete.ts — the composer's `/…` completion menu.
 *
 * pi-tui's `Editor` completes nothing on its own: it asks an
 * `AutocompleteProvider` for suggestions and rossii never installed one, so
 * both `/` and Tab were dead keys. With a provider set the editor opens the
 * menu by itself while the **first line** starts with `/`
 * (`isInSlashCommandContext` → `tryTriggerAutocomplete` on every keystroke) and
 * on Tab (`handleTabCompletion` → `handleSlashCommandCompletion`); ↑/↓ move,
 * Enter applies the pick and submits it, Esc closes the menu and keeps the
 * draft (`chat-ui.ts` leaves Esc to the editor while the menu is open).
 *
 * Two sources, the chat's first:
 *
 * - `CHAT_COMMANDS` — what `handleCommand` answers itself (`./chat-config.ts`)
 * - goose's own, as announced with `available_commands_update`: builtins,
 *   recipes and skills — exactly the list `/help` prints
 *   (`./slash-commands.ts`). It arrives after `session/new`, which is why
 *   `createCommandCompleter` reads the items per keystroke instead of copying
 *   them once.
 *
 * The menu decides nothing: every `/…` still goes to goose as a prompt unless
 * the chat implements it (`./slash-commands.ts`). It is a keyboard shortcut for
 * typing a name, not a filter on what may run.
 */

import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import { normalizeCommandName, type GooseCommand } from "./slash-commands";

/**
 * What `handleCommand` handles, in the order `/help` lists it. Aliases
 * (`/settings`, `/setting`) are deliberately absent: the menu offers the command
 * once, under its canonical name.
 */
export const CHAT_COMMANDS: readonly AutocompleteItem[] = [
  { value: "config", label: "config", description: "Change provider, model, set or session" },
  { value: "model", label: "model", description: "Switch the model (`fetch` asks the provider's API)" },
  { value: "provider", label: "provider", description: "Switch the provider" },
  { value: "set", label: "set", description: "Switch the set (system prompt + extensions)" },
  { value: "session", label: "session", description: "Switch session, or `new` / `rename` / `fork`" },
  { value: "rename", label: "rename", description: "Rename the current session" },
  { value: "fork", label: "fork", description: "Copy the session and continue in the copy" },
  { value: "think", label: "think", description: "Expand or collapse the thinking blocks (`all`)" },
  { value: "tool", label: "tool", description: "Expand or collapse the tool-call blocks (`all`)" },
  { value: "edit", label: "edit", description: "Edit the draft in $EDITOR (Ctrl+E)" },
  { value: "fetch", label: "fetch", description: "Fetch the model list from the provider's API" },
  { value: "help", label: "help", description: "List the commands — the chat's and goose's" },
];

/**
 * The chat's commands followed by goose's, de-duplicated by name: a name the
 * chat implements is the chat's (`handleCommand` runs before goose ever sees
 * the text), so goose's entry for it is dropped rather than listed twice.
 */
export function buildCommandItems(gooseCommands: readonly GooseCommand[] = []): AutocompleteItem[] {
  const items: AutocompleteItem[] = CHAT_COMMANDS.map((item) => ({ ...item }));
  const taken = new Set(items.map((item) => item.value));
  for (const command of gooseCommands) {
    const name = normalizeCommandName(command.name);
    if (!name || taken.has(name)) continue;
    taken.add(name);
    items.push({ value: name, label: name, description: command.description });
  }
  return items;
}

/**
 * Suggestions for the text before the cursor, or `null` for "no menu".
 *
 * Only a name is completed: `/model ` has arguments and `/co nfig` is not a
 * command, so anything but a single `/token` — a space, prose before the slash,
 * no slash at all — returns `null` and the editor closes the menu.
 *
 * The `prefix` is the typed token, slash included, with the indentation before
 * it left out (`textBeforeCursor` is `trimStart`ed to build it, so `applyCompletion`
 * can keep whatever whitespace the line starts with). The slash matters to the
 * editor, not to us: a completed pick is applied **and submitted** in one Enter
 * when `prefix.startsWith("/")` (`handleInput` → `tui.select.confirm`) — that is
 * how pi-tui treats a slash command, and `createAutocompleteList` picks the
 * narrow command layout for it too. Our `commandSuggestions` already orders the
 * best match first, so the editor's own preselect
 * (`getBestAutocompleteMatchIndex`, which compares `item.value` *with* the
 * prefix and therefore never matches here) changes nothing.
 */
export function commandSuggestions(
  textBeforeCursor: string,
  items: readonly AutocompleteItem[],
): AutocompleteSuggestions | null {
  const token = textBeforeCursor.trimStart();
  if (!token.startsWith("/") || /\s/u.test(token)) return null;
  const query = token.slice(1).toLowerCase();
  const byPrefix: AutocompleteItem[] = [];
  const bySubstring: AutocompleteItem[] = [];
  for (const item of items) {
    const name = item.value.toLowerCase();
    if (name.startsWith(query)) byPrefix.push(item);
    else if (query.length > 0 && name.includes(query)) bySubstring.push(item);
  }
  // Prefix matches first (`/co` → config, compact, clear; not `doctor`), and
  // inside each group the caller's order survives: the chat's commands, then
  // goose's in the order goose announced them.
  const matches = [...byPrefix, ...bySubstring];
  if (matches.length === 0) return null;
  return { items: matches, prefix: token };
}

/**
 * Replace the typed token with the picked command and a trailing space, so the
 * next key typed is an argument (`/model ` …). Whatever follows the cursor
 * inside the token goes away: completing `/com|pact` must not leave `pact`
 * behind. `prefix` is the typed token including its slash, so `head` is the
 * indentation before it (normally empty) and the slash is written back once.
 */
export function applyCommandCompletion(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
  item: AutocompleteItem,
  prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const line = lines[cursorLine] ?? "";
  const head = line.slice(0, Math.max(0, cursorCol - prefix.length));
  const tail = line.slice(cursorCol).replace(/^\S*/u, "");
  const newLines = [...lines];
  newLines[cursorLine] = `${head}/${item.value} ${tail}`;
  return { lines: newLines, cursorLine, cursorCol: head.length + item.value.length + 2 };
}

/**
 * The provider `setupUi` installs on the composer.
 *
 * `readItems` is called per keystroke: goose's list is announced after
 * `session/new`, and a fresh list is worth having without re-installing the
 * provider (the `Editor` keeps the provider it was given).
 */
export function createCommandCompleter(
  readItems: () => readonly AutocompleteItem[],
): AutocompleteProvider {
  return {
    async getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
    ): Promise<AutocompleteSuggestions | null> {
      // `/…` is a command only on the composer's first line. The editor already
      // refuses the menu further down (`isSlashMenuAllowed`), so this only keeps
      // the provider honest about it.
      if (cursorLine !== 0) return null;
      const line = lines[cursorLine] ?? "";
      return commandSuggestions(line.slice(0, cursorCol), readItems());
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return applyCommandCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
  };
}
