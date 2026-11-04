# cgoose — Agent Context

> **⚠ Tested only on Linux.** May work on macOS. Windows is not supported.

## Overview

cgoose is a TUI wrapper around `goose session` CLI. It launches Goose — it does not replace it.

## Key facts for agents

- Lives in the user's project directory, remembers settings **per directory** (`~/.config/cgoose/projects/<dir>-<hash>.json`)
- Reads `~/.config/goose/config.yaml` for enabled providers
- Reads `~/.config/goose/custom_providers/*.json` for custom provider definitions (engine, baseUrl, authToken)
- **Session sets** (`~/.config/cgoose/sets/<name>.json`) replace recipes as the primary way to bundle a system prompt + builtin extensions. Recipes are still discovered via `goose recipe list --format json` but cgoose launches via `goose acp` (chat mode, default) or `goose session` (`CGOOSE_ACP_MODE=classic`), never `goose run --recipe`
- Set history tracked per-project (like provider/model history), last used shown at top
- The selected **set is the source of truth** for the system prompt: on resume the *current* set's prompt is applied, and **None** explicitly clears any stored prompt via `--system ""` (Goose ≥1.55 persists `--system` in the session DB, so omitting the flag would restore the old prompt instead of clearing it)
- On new session, set's system prompt is passed via `--system`, extensions via `--with-builtin` / `--with-extension` / `--with-streamable-http-extension` + `--no-profile`
- Secrets resolved from: env vars → system keyring → `~/.config/goose/secrets.yaml` → JSON config files
- Config file: `~/.config/cgoose/config.json` — supports `default_mode` (`"worktree"` or `"no-worktree"`)

## Wizard Flow (6 steps)

The TUI wizard has 6 steps, each with `initialValue` set to the last-used selection:

1. **session** — pick existing session or create new. `initialValue` on last-new
2. **session_name** — enter name (Enter = auto-name from generated prefix)
3. **set** — last-used set is **first** (`❶`), then None, then history + alphabetically, plus options to create/manage sets. `initialValue: lastSet`
4. **provider** — sorted by history then alphabetical. `initialValue: lastProviderRaw`
5. **model** — last used (`✦`), then history, configured models, manual/fetch. `initialValue: lastModel / defaultModel`
6. **launch** — summary confirmation

**Pressing Enter on every step = resume with identical set/provider/model as last session.**

If no project meta exists yet, first option is selected (None → first provider → first model).

## Session Sets

A session set is a YAML file at `~/.config/cgoose/sets/<name>.yaml` (legacy `.json` is still read):

```yaml
title: My Set
systemPrompt: Instructions for the agent...
builtins: [developer, analyze, memory]              # bundled Goose builtins
extensions: [fetch]                                 # names from ~/.config/goose/config.yaml
stdioExtensions: ["mcpls --trust-project-config"]   # raw --with-extension commands
```

- `systemPrompt` → passed via `--system`
- `builtins` → passed via `--with-builtin <comma,separated>`
- `extensions` → names of extensions declared in `~/.config/goose/config.yaml`, resolved by `src/goose-extensions.ts`: `builtin`/`platform` → `--with-builtin`, `stdio` → `--with-extension "name:ENV=val cmd args..."`, `streamable_http` → `--with-streamable-http-extension "<uri> timeout=N"`. Unknown names produce a launcher warning and are skipped
- `stdioExtensions` → passed verbatim to `--with-extension` in classic mode; in chat mode the
  `[name:]` prefix is optional and the name is derived from the launcher command
- Classic mode launches any set (and `None`) with `--no-profile`: only what the set lists is loaded
- Chat mode has no `--no-profile` flag, but `_meta.enabledExtensions` (typed `GooseExtension[]`)
  **replaces** the profile's list, so the same semantics hold; an empty array means "no extensions"
  (goose keeps its implicit `developer`). See the chat-mode section below
- Created/managed via the TUI: **Set → ⚙️ Create new set...** / **Manage sets...**, or manually in `~/.config/cgoose/sets/`

### "None" vs "Default" vs a set

- **None** (`""`) → classic: `--no-profile` only, a session with **no extensions at all**;
  chat: `_meta.enabledExtensions: []` — no profile and (on 1.50.0) no extensions at all; some builds
  inject their own `developer`, which cgoose treats as allowed but never adds or removes
- **Default** (`__default__` sentinel in `src/launcher.ts`) → no flags at all, so Goose loads the profile from `~/.config/goose/config.yaml`; chat sends no `enabledExtensions` at all
- **Set** → exactly the flags/typed list derived from the set

Extension flags are only effective when a session is **created**. On resume Goose restores the extension list stored in `sessions.extension_data` and ignores CLI extension flags; `setHistory[0]` may hold the `__default__` sentinel.

### Prompt on resume

Goose ≥ 1.55 persists `--system` in the session DB (`system_prompt_extras`), so on resume cgoose:
1. Applies the **currently selected set's** `systemPrompt` via `--system` — edit the set, resume, get the fresh prompt
2. Passes an explicit `--system ""` when **no set** is selected, so "no set" really means "no additional prompt". Omitting the flag would *restore* a previously stored prompt instead of clearing it

There is no per-project prompt cache: the set, not a saved snapshot, defines the prompt.

## Git Worktree Integration

When creating a new session inside a git repo:

1. Worktree at `<repo>/.worktree/<sanitized-name>` with matching branch
2. Goose runs inside that worktree — isolated from main branches
3. On resume, detects and reuses existing worktree
4. On session deletion, cleans up worktree and branch

Control:
- `CGOOSE_NO_WORKTREE=1` — skip worktree creation
- `CGOOSE_FORCE_WORKTREE=1` — force worktree (overrides above)
- `-m` CLI flag disables worktree (default)
- `-w` CLI flag enables worktree
- Config `~/.config/cgoose/config.json`: `{ "default_mode": "worktree" }` — override default to worktree mode

## Chat Mode (ACP) — default renderer

cgoose itself renders the dialog by default. It spawns `goose acp` (Agent Client
Protocol, JSON-RPC 2.0 over stdio) and drives it as an ACP client using
`@earendil-works/pi-tui`. `CGOOSE_ACP_MODE=classic` (or `0`/`off`/`false`/`session`)
hands the terminal over to the classic `goose session` TUI instead; an unrecognised value
warns in the TUI and keeps the ACP default.

- No chat-specific CLI letters: `c` is gone, and the old pairs are aliases of their
  base mode (`mc`→`m`, `ac`/`ca`→`a`, `nc`/`cn`→`n`, `sc`/`cs`→`s`, `wc`→`w`)
- Implementation: `src/acp/` — `client.ts` (transport), `custom.ts` (goose custom
  requests, methods `_goose/unstable/...`), `extensions.ts` (spec → ACP `mcpServers`,
  pure and unit-tested), `chat.ts` (pi-tui based chat UI)
- Classic mode still lives in `src/launcher.ts`; shared launch preparation (worktree,
  env, secrets) is `prepareLaunch()`, used by both modes
- Rendering: the chat owns the **alternate screen** — `TuiAltScreen` with an explicit
  layout root (`ScrollView(document, { follow: "end", primary: true })` with the header
  as the first lines of the document, composer pinned). Scroll position survives
  streaming: follow-end turns off when the user scrolls up and resumes at the bottom.
  `tui.stop()` prints the final
  transcript back to the normal screen, so scrollback keeps the conversation.
  `CGOOSE_CHAT_MAIN_SCREEN=1` switches back to `TuiMainScreen` (inline; the terminal owns
  scrollback, so any repaint — spinner, streamed chunk — pulls the view to the bottom)
- Session sets in chat mode (verified live on goose 1.50.0 via the probes described in
  `plans/acp-mode-review5.md`):
  - builtins → `goose acp --with-builtin <names>` **and** `{type:"builtin",name}` entries in the
    typed list (goose dedupes by name)
  - `session/new._meta.enabledExtensions` (typed `GooseExtension[]`, built by
    `planGooseExtensions` in `src/acp/extensions.ts`) **replaces** the profile: a set (or `None`
    with `[]`) loads exactly what it lists — the chat-mode `--no-profile`
  - MCP servers travel inside that list as `{type:"mcp", server}`; the standard
    `mcpServers` field is ALSO sent, because goose ignores it only when the typed list is
    honoured — that is the compatibility channel for versions without support
  - **inline env (`KEY=value` in a stdio spec) cannot be expressed**: goose wants `envKeys`
    referencing its own secret store and rejects inline values. A set with such a spec keeps
    `enabledExtensions` unsent (profile loads additively, `mcpServers` supplies the server)
    and the chat says so
  - `session/load` ignores `enabledExtensions`/`mcpServers`; on resume the loaded list is
    reconciled with `_goose/unstable/session/extensions/{list,add,remove}` (remove's field
    name differs between versions — `extensionKey` vs `name`, see `src/acp/custom.ts`)
  - after creating a session the chat reads the real extension list and warns only if profile
    extensions leaked in (a goose that ignores the field) or expected ones are missing
  - system prompt → goose custom request `_goose/unstable/session/system-prompt/set`
    (`mode: "set"`, key `cgoose`); empty text clears it — same "set is source of
    truth" semantics as classic `--system`. A failure here is non-fatal (warning only)
- ACP sessions live in the same `sessions.db`, so the wizard's session picker sees them;
  resume uses `session/load` (requires the agent's `loadSession` capability, checked at
  startup) and replays history: `user_message_chunk` is rendered and `messageId`
  boundaries split assistant messages
- Permissions (`session/request_permission`) are rendered as a SelectList overlay and
  queued (parallel tool calls); Esc/Ctrl+C during a turn sends `session/cancel`, while
  the overlay is open they belong to the list (reject that tool call). Pending requests
  are resolved as `cancelled` on turn end, agent exit and shutdown
- Esc exits when the prompt is empty; with a non-empty draft it *arms* the exit (a hint
  is printed, the second Esc exits — the editor itself does not handle Esc); with the
  autocomplete menu open Esc stays with the editor, which closes the menu. Ctrl+C exits
  unconditionally
- If `goose acp` dies, the chat stops accepting prompts and Esc exits; `send()` refuses
  to write to a closed transport, so no request can hang forever
- `fs/read_text_file` / `fs/write_text_file` are served for any path the agent asks for
  (no worktree sandbox; write creates parent dirs). A read honours ACP `line`/`limit` and
  defaults to 2000 lines (the ACP default), so one huge file cannot flood the context.
  ACP clients are trusted — MCP servers effectively get the same access
- Two watchdogs bound a turn (`src/acp/timeouts.ts`); both are disabled by `0`, and a
  malformed value warns in the chat instead of silently switching the guard off:
  - `CGOOSE_ACP_IDLE_TIMEOUT_MS` (default 5 min) — no `session/update` from the agent for
    that long → `session/cancel`; a long but *live* turn is never interrupted
  - `CGOOSE_ACP_PROMPT_TIMEOUT_MS` (default 4 h) — absolute cap on a single turn; on
    timeout the client also sends `session/cancel` and the UI reports the error
- Provider/model reach the agent via `GOOSE_PROVIDER`/`GOOSE_MODEL` env + `_meta.provider` (top level — goose reads session fields there, only initialize capabilities live under `_meta.goose`); `_meta.sessionTitle` + `_meta.client` name the session and make it a normal `user` session
- Requires a goose with the `acp` subcommand (1.50.0 verified; `_goose/unstable/*` methods degrade
  to warnings when absent); `launchGooseAcp` checks `goose acp --help` at startup and falls
  back to the classic TUI otherwise
- Verification scripts: `bun run test` (unit tests for `extensions.ts`, no goose needed),
  `bun scripts/acp-probe.ts` (raw protocol) and `bun scripts/acp-client-smoke.ts`
  (`src/acp/client.ts` without the TUI; checks the `enabledExtensions` and `mcpServers` channels)

## Data Paths

| What | Path |
|------|------|
| Per-project memory | `~/.config/cgoose/projects/<dir>-<hash>.json` |
| Session sets | `~/.config/cgoose/sets/*.json` |
| cgoose config | `~/.config/cgoose/config.json` |
| Provider configs | `~/.config/goose/custom_providers/*.json` |
| Goose config | `~/.config/goose/config.yaml` |
| Goose sessions | `~/.local/share/goose/sessions/sessions.db` |

## Local Config Overrides

cgoose looks for `.goose/config.yaml` in the session's worktree (or project root):

- Sets `GOOSE_ADDITIONAL_CONFIG_FILES` so Goose loads it alongside main config
- Resolves `${VARIABLE}` / `$VARIABLE` references from Goose secrets and injects into session environment

## Common tasks

### Add a model to a custom provider
Append to `models` array in `~/.config/goose/custom_providers/<name>.json`:
```json
{ "name": "model-id", "context_limit": 128000 }
```

### Create a session set manually
Write `~/.config/cgoose/sets/<name>.json` with the shape above, or use the TUI wizard.

### Reset project history
Delete the corresponding file in `~/.config/cgoose/projects/`.

## Navigation

- **Esc** at any prompt: go back one step
- **Ctrl+C**: exit entirely
