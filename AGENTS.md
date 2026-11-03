# cgoose — Agent Context

> **⚠ Tested only on Linux.** May work on macOS. Windows is not supported.

## Overview

cgoose is a TUI wrapper around `goose session` CLI. It launches Goose — it does not replace it.

## Key facts for agents

- Lives in the user's project directory, remembers settings **per directory** (`~/.config/cgoose/projects/<dir>-<hash>.json`)
- Reads `~/.config/goose/config.yaml` for enabled providers
- Reads `~/.config/goose/custom_providers/*.json` for custom provider definitions (engine, baseUrl, authToken)
- **Session sets** (`~/.config/cgoose/sets/<name>.json`) replace recipes as the primary way to bundle a system prompt + builtin extensions. Recipes are still discovered via `goose recipe list --format json` but cgoose always launches via `goose session` (never `goose run --recipe`)
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
- `stdioExtensions` → passed verbatim to `--with-extension`
- Any set (and `None`) is launched with `--no-profile`: only what the set lists is loaded
- Created/managed via the TUI: **Set → ⚙️ Create new set...** / **Manage sets...**, or manually in `~/.config/cgoose/sets/`

### "None" vs "Default" vs a set

- **None** (`""`) → `--no-profile` only: a session with **no extensions at all**
- **Default** (`__default__` sentinel in `src/launcher.ts`) → no flags at all, so Goose loads the profile from `~/.config/goose/config.yaml`
- **Set** → exactly the flags derived from the set

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

## Chat Mode (ACP)

Besides the classic mode (spawning the `goose session` TUI), cgoose has a **chat mode**
where cgoose itself renders the dialog. It spawns `goose acp` (Agent Client Protocol,
JSON-RPC 2.0 over stdio) and drives it as an ACP client using `@earendil-works/pi-tui`.

- CLI flag: `-c` (and pairs `mc` = no worktree, `wc` = force worktree, `ac`/`nc`/`sc`/`ca`/`cn`/`cs`)
- Implementation: `src/acp/` — `client.ts` (transport), `custom.ts` (goose custom
  requests, methods `_goose/unstable/...`), `chat.ts` (pi-tui based chat UI)
- Classic mode still lives in `src/launcher.ts`; shared launch preparation (worktree,
  env, secrets) is `prepareLaunch()`, used by both modes
- Session sets in chat mode:
  - extensions → `_meta.goose.enabledExtensions` on `session/new` (builtin/platform/mcp
    entries; absent → goose default profile, empty list → no extensions at all)
  - system prompt → goose custom request `_goose/unstable/session/system-prompt/set`
    (`mode: "set"`, key `cgoose`); empty text clears it — same "set is the source of
    truth" semantics as classic `--system`
- ACP sessions live in the same `sessions.db`, so the wizard's session picker sees them;
  resume uses `session/load` (full history replay, pending permissions are re-asked)
- Permissions (`session/request_permission`) are rendered as a SelectList overlay;
  Esc/Ctrl+C during a turn sends `session/cancel`
- Requires goose ≥ ~1.57 (`goose acp` + `_goose/unstable/*` methods); classic mode is
  the fallback on older versions
- Verification scripts: `bun scripts/acp-probe.ts` (raw protocol) and
  `bun scripts/acp-client-smoke.ts` (src/acp/client.ts without the TUI)

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
