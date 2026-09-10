# cgoose — TUI for Goose AI Sessions

**cgoose** is a terminal UI for [Goose](https://github.com/block/goose) — your AI coding agent. It replaces raw CLI commands with an interactive multi-step workflow to pick sessions, providers, models, and **session sets** (bundles of system prompt + builtin extensions).

> Built with [Clack](https://github.com/natemoo-re/clack) prompts + [picocolors](https://github.com/alexeyraspopov/picocolors), runs on [Bun](https://bun.sh).
>
> **⚠ Tested only on Linux.** May work on macOS (secret-tool not available, but file-based secrets should work). Windows is not supported.

---

## Demo

![cgoose workflow](flow.gif)

---

## Screenshots

| Session list | New session |
|:--:|:--:|
| ![sessions](sessions.jpg) | ![new session](new-session.jpg) |
| Provider selection | Model selection |
| ![providers](providers.jpg) | ![models](models.jpg) |

---

## Why cgoose?

Goose's CLI works, but every time you start a session you need to remember:

- What provider did I use last time in this project?
- What model?
- What session name?
- What system prompt / extensions?

**cgoose remembers.** It keeps per-project history of providers, models, and session sets, shows you what you used last, and lets you fetch models directly from the API instead of typing them by hand.

---

## Installation

### Option 1: Standalone binary (no runtime needed)

```bash
bash build.sh
./cgoose
```

Requires **Bun** to build, but the resulting binary runs on any Linux x86_64 without Bun.

### Option 2: Local install (requires Bun)

```bash
bash install.sh
cgoose
```

Installs source + deps to `~/.local/lib/cgoose/` and a launcher to `~/.local/bin/cgoose`. Make sure `~/.local/bin` is in your `PATH`.

### Option 3: Run from source (requires Bun)

```bash
bun install
bun start
```

---

## Features

### Session Management
- **List sessions** for current working directory with fuzzy search
- **Create new** — custom name or leave empty for auto-name from first message
- **Resume** existing sessions with full history
- **Batch delete** — pick individually or clean all sessions for the current directory

### Session Sets (replaces recipes)
A **session set** is a JSON file at `~/.config/cgoose/sets/<name>.json` that bundles:

```json
{
  "title": "My Set",
  "systemPrompt": "You are an expert in...",
  "builtins": ["developer", "analyze", "memory"]
}
```

- **System prompt** passed via `--system` flag (appended to Goose's default prompt)
- **Builtins** passed via `--with-builtin` + `--no-profile` (the set fully defines the toolset)
- Creates **consistent, replayable** agent configurations — no recipe YAML complexity
- Session sets always launch via `goose session`, allowing session history, resume, and forks
- Sets are discoverable, editable, and deletable via the TUI

#### Prompt persistence on resume
`--system` is in-memory only (not persisted in Goose's session DB), so cgoose saves the original prompt per-session in project meta (`sessionPrompts[<session-name>]`). On resume, the *original* prompt is passed again — even if the set definition was later edited. Legacy sessions with no saved prompt fall back to the current set definition.

**Why not recipes?**
- Recipes use `goose run --recipe` which creates a one-shot session with no resume capability
- Recipes require YAML syntax with sub-recipes, parameters, response schemas — overkill for most use cases
- Session sets are plain JSON, trivially editable, and work with `goose session` (full history/resume/fork support)

The TUI still discovers installed recipes via `goose recipe list --format json`, but they are shown as read-only in a separate section, and launching a recipe creates a new session set equivalent.

### Provider Selection
- Sorted by your usage history (most recent first), then alphabetically
- Shows last used, history, and session provider hints
- **Ollama** — auto-detected if running locally, shows model count + tool support
- Supports any number of enabled providers from your Goose config
- Custom providers (`custom_*`) only shown when a JSON config file exists

### Model Selection
- **Last used model** shown as default (`✦`)
- **Model history** per provider — previously used models at your fingertips
- **Fetch from API** — hits `GET /v1/models` on OpenAI-compatible endpoints, parses `context_limit`/`max_context`/`context_window` if available
- **Ollama models** — lists with tool support badges, warns if model lacks tool calling
- **Manual input** fallback with validation

### Context Limit
- When discovery or manual input finds a model not yet in the provider's JSON config, cgoose prompts you for a **context limit** (in tokens)
- If the API returned context info (KodikRouter, llama.cpp, etc.), it's pre-filled as the default
- Otherwise defaults to `128000` (Goose's built-in default)
- **On launch**, cgoose sets `GOOSE_CONTEXT_LIMIT` so Goose actually uses the value instead of falling back to its canonical registry or `DEFAULT_CONTEXT_LIMIT`

### Secrets & Auth
- Reads API keys from all Goose storage backends:
  - **System keyring** (libsecret — works with GNOME Keyring, KDE Wallet, KeePassXC, etc.)
  - **File-based** (`~/.config/goose/secrets.yaml`)
  - Environment variables
- If a key is missing, cgoose shows a clear hint about which variable to set

### Git Worktree Integration
- **New sessions** create a dedicated **git worktree** under `<repo>/.worktree/<name>` with a matching branch
- **Resume** detects existing worktree and launches Goose inside it — no manual checkout needed
- **Isolation** — worktrees let you run Goose in a separate working tree without touching your main branches
- **Cleanup** — deleting a session through cgoose also removes the worktree and branch
- **Smart recovery** — detects stale worktree registrations and prunes them automatically
- Skipped if not in a git repo or `CGOOSE_NO_WORKTREE=1` is set (default)
- Force with `CGOOSE_FORCE_WORKTREE=1` or the `w` CLI flag
- Default mode is `no-worktree`. Use `w` flag or set `default_mode: "worktree"` in config to enable worktrees

### Local Config Overrides
- **`.goose/config.yaml`** — cgoose automatically discovers it in the project root or session worktree
- Sets `GOOSE_ADDITIONAL_CONFIG_FILES` env var so Goose includes it alongside the main config
- **Secrets resolution** — any `${VARIABLE}` or `$VARIABLE` references found in `.goose/config.yaml` values are resolved from Goose secrets (system keyring,`~/.config/goose/secrets.yaml`) and injected into the session environment

### Launch
- Always uses `goose session` (never `goose run --recipe`)
- Sets `OPENAI_BASE_URL` + `OPENAI_API_KEY` for custom providers
- Clears conflicting env vars (`OPENAI_HOST`, `OPENAI_BASE_PATH`)
- Sets `GOOSE_CONTEXT_LIMIT` from the provider's JSON model config
- New session with a set: `--system`, `--with-builtin`, `--no-profile`
- Resume passes saved original prompt via `--system`, skips `--with-builtin` (extensions are in session DB)
- Shows set in launch summary if one was selected
- Spawns `goose session` with `stdio: inherit`, forwards exit code

---

## Workflow

1. **Choose a session** — pick from existing sessions for this directory, create new, or delete
2. **Name the session** — enter a custom name or leave empty for auto-name from first message
3. **Pick a session set** (optional) — last used set at the very top (`❶`), then None, then history + alphabetically, plus options to create new sets or manage existing ones
4. **Pick a provider** — sorted by your history, shows Ollama if running locally
5. **Pick a model** — last used, history, fetch from API, or type manually
6. **Context limit** (if new model for custom provider) — enter tokens or accept default
7. **Launch** — summary screen → `goose session` starts in the same terminal

**Pressing Enter on every step** creates a new session with the same set, provider, and model as the last one — no navigation needed.

Pressing **Esc** at any step goes back one step (not abort).

---

## Data Locations

| What | Where |
|------|-------|
| Provider config | `~/.config/goose/config.yaml` |
| Custom provider defs | `~/.config/goose/custom_providers/*.json` |
| Secrets (keyring) | System keyring via libsecret (service: `secrets@goose:default`) |
| Secrets (file) | `~/.config/goose/secrets.yaml` |
| Session sets | `~/.config/cgoose/sets/*.json` |
| Per-project history | `~/.config/cgoose/projects/<dir>-<hash>.json` |
| Git worktrees | `<repo>/.worktree/<name>` (per-project, gitignored) |
| Session DB | `~/.local/share/goose/sessions/sessions.db` |

---

## CLI Flags

Run cgoose with a single-letter mode (like tmux):

| Mode | What it does |
|------|-------------|
| `a` | **Auto-resume** — jump straight to launch with the last session, provider, model, and set for this project |
| `n` | **New session** — skip pickers, start a new session with the last provider, model, and set |
| `s` | **Sessions only** — show only the session picker, skip provider, model, and set selection, use last used |
| `m` | **No-worktree** — run without git worktree isolation (default mode) |
| `w` | **Force worktree** — enable git worktree isolation (overrides `CGOOSE_NO_WORKTREE=1` or `m` flag) |
| `ma` | Auto-resume + no worktree |
| `ms` | Sessions only + no worktree |
| `mn` | New session + no worktree |
| `wa` | Auto-resume + force worktree |
| `ws` | Sessions only + force worktree |
| `wn` | New session + force worktree |

When using `a`, `n`, or `s` modes, the last used **set** is also restored alongside provider and model.

If there's no project history for the current directory, the flag is ignored and the full workflow runs.

```bash
cgoose a    # resume last session (with last set, provider, model)
cgoose n    # new session with last set/provider/model
cgoose s    # pick a session, then launch
cgoose m    # full workflow, no worktree
cgoose w    # full workflow, force worktree
cgoose wa   # auto-resume, force worktree
```

## Scripts

| Script | What it does |
|--------|-------------|
| `build.sh` | Compiles a standalone binary (`./cgoose`) with Bun runtime embedded |
| `install.sh` | Installs source to `~/.local/lib/cgoose/` + launcher to `~/.local/bin/cgoose` |

---

## License

MIT