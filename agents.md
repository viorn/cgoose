# cgoose — Agent Context

This file describes what cgoose is and how agents (Goose) should interact with it.

> **⚠ Tested only on Linux.** May work on macOS (secret-tool not available, file-based secrets should work). Windows is not supported.

## Overview

cgoose is a TUI wrapper around the `goose session` CLI. It does **not** replace Goose — it launches it. Think of it as a session launcher with history and discovery.

## Key facts for agents

- cgoose lives in the user's project directory and remembers settings **per directory**
- It reads `~/.config/goose/config.yaml` for enabled providers
- It reads `~/.config/goose/custom_providers/*.json` for custom provider definitions
- Secrets come from: env vars → system keyring (libsecret) → `~/.config/goose/secrets.yaml` → JSON config files
- When the user selects a model via "Fetch from API", cgoose may ask to save it to the provider's JSON file

## Installation

```bash
# From source (requires Bun)
git clone <repo>
cd cgoose
bun install
bun start

# Install locally
bash install.sh
cgoose

# Build standalone binary
bash build.sh
./cgoose
```

## Data paths

| What | Path |
|------|------|
| Source install | `~/.local/share/cgoose/` |
| Launcher | `~/.local/bin/cgoose` |
| Standalone binary | `./cgoose` (or any path) |
| Per-project memory | `~/.config/cgoose/projects/<dir>-<hash>.json` |
| Provider configs | `~/.config/goose/custom_providers/*.json` |

## Git Worktree integration

When cgoose creates a new session inside a git repository:
1. A worktree is created at `<repo>/.worktree/<sanitized-session-name>`
2. A matching git branch is created
3. Goose runs inside that worktree — isolated from main branches
4. On resume, cgoose detects the existing worktree and reuses it
5. On session deletion, the worktree and branch are cleaned up

Set `CGOOSE_NO_WORKTREE=1` to skip worktree creation.

## Local Config Overrides

cgoose looks for `.goose/config.yaml` in the session's worktree (if any) or the project root:

- Sets `GOOSE_ADDITIONAL_CONFIG_FILES` env var so Goose loads it alongside the main config
- Any `${VARIABLE}` or `$VARIABLE` references in YAML values are resolved from Goose secrets (system keyring, `~/.config/goose/secrets.yaml`) and injected into the session environment

## Common tasks

### Add a model to a custom provider config

If the user fetched models via API and picked one, cgoose asks to save it. The JSON file looks like:

```json
{
  "name": "custom_kodik",
  "models": [
    { "name": "model-id" }
  ]
}
```

To add manually, append `{ "name": "model-id" }` to the `models` array.

### Reset project history

Delete the corresponding file in `~/.config/cgoose/projects/`.

### Debug provider detection

Run from source to see which providers are found and whether auth tokens are resolved:

```bash
bun run -e "import { getConfigProviders } from './src/config'; console.log(JSON.stringify(getConfigProviders(), null, 2))"
```

## Navigation

- **Esc** at any prompt: go back one step (not abort)
- **Ctrl+C**: exit entirely