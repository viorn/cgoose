# cgoose — Agent Context

> **⚠ Tested only on Linux.** May work on macOS. Windows is not supported.

## Overview

cgoose is a TUI wrapper around `goose session` CLI. It launches Goose — it does not replace it.

## Key facts for agents

- Lives in the user's project directory, remembers settings **per directory** (`~/.config/cgoose/projects/<dir>-<hash>.json`)
- Reads `~/.config/goose/config.yaml` for enabled providers
- Reads `~/.config/goose/custom_providers/*.json` for custom provider definitions (engine, baseUrl, authToken)
- Secrets resolved from: env vars → system keyring → `~/.config/goose/secrets.yaml` → JSON config files
- Config file: `~/.config/cgoose/config.json` — supports `default_mode` (`"worktree"` or `"no-worktree"`)

## Git Worktree Integration

When creating a new session inside a git repo:

1. Worktree at `<repo>/.worktree/<sanitized-name>` with matching branch
2. Goose runs inside that worktree — isolated from main branches
3. On resume, detects and reuses existing worktree
4. On session deletion, cleans up worktree and branch

Control:
- `CGOOSE_NO_WORKTREE=1` — skip worktree creation
- `CGOOSE_FORCE_WORKTREE=1` — force worktree (overrides above)
- `-m` CLI flag disables worktree, `-w` enables it
- Config `~/.config/cgoose/config.json`: `{ "default_mode": "no-worktree" }` — sets default when no flag/env is present

## Data Paths

| What | Path |
|------|------|
| Per-project memory | `~/.config/cgoose/projects/<dir>-<hash>.json` |
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

### Reset project history
Delete the corresponding file in `~/.config/cgoose/projects/`.

## Navigation

- **Esc** at any prompt: go back one step
- **Ctrl+C**: exit entirely