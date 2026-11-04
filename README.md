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
A **session set** is a YAML file at `~/.config/cgoose/sets/<name>.yaml` that bundles:

```yaml
title: My Set
systemPrompt: You are an expert in...
builtins: [developer, analyze, memory]                # bundled Goose builtins
extensions: [fetch]                                   # extensions from ~/.config/goose/config.yaml
stdioExtensions: ["mcpls --trust-project-config"]     # ad-hoc stdio commands
```

- **System prompt** passed via `--system` flag (appended to Goose's default prompt)
- **builtins** passed via `--with-builtin`
- **extensions** — names of extensions already configured in `~/.config/goose/config.yaml` (e.g. `fetch`, `mcpls`, `sigma`). Each entry is translated to the matching flag: `builtin`/`platform` → `--with-builtin`, `stdio` → `--with-extension "name:cmd args"`, `streamable_http` → `--with-streamable-http-extension <uri>`
- **stdioExtensions** — raw command lines passed straight to `--with-extension`
- Sets launch with `--no-profile`: **only** what the set lists is loaded (in chat mode the same is achieved with `_meta.enabledExtensions` — an empty array means "no extensions")
- Creates **consistent, replayable** agent configurations — no recipe YAML complexity
- Session sets always launch via `goose session`, allowing session history, resume, and forks
- Sets are discoverable, editable, and deletable via the TUI

#### Set choice: None vs Default vs a set
- **None** — no extensions at all (`--no-profile` and nothing else): a bare agent without shell/file tools (on goose 1.50/1.57 chat mode ends up with no extensions at all; some builds add their own `developer`, which cgoose tolerates)
- **Default** — leave the profile alone: Goose loads every extension enabled in `~/.config/goose/config.yaml` (classic `goose session` behavior)
- **&lt;set&gt;** — exactly the builtins/extensions the set lists

Extension flags only apply when a session is **created**. On resume, Goose restores the extension set stored in the session DB and ignores CLI extension flags — how the session was first created wins (the set's system prompt is still re-applied). In chat mode the extension set is also applied to a resumed session (the loaded list is diffed and reconciled through `_goose/unstable/session/extensions/*`), except when the set carries stdio extensions with inline `KEY=value` env vars: goose only accepts env through `envKeys` pointing at its own secret store, so such a set falls back to loading the profile as well.

#### Prompt on resume
The selected set is the source of truth for the system prompt. Goose ≥ 1.55 stores `--system` in the session DB (`system_prompt_extras`), so on resume cgoose applies the **current** set's prompt (edit the set → resume → fresh prompt). When **no set** is selected it passes an explicit `--system ""` to clear any previously stored prompt, since omitting the flag would restore the old one.

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

### Launch (classic mode)
- Always uses `goose session` (never `goose run --recipe`); chat mode is the default, this path is used with `CGOOSE_ACP_MODE=classic`
- Sets `OPENAI_BASE_URL` + `OPENAI_API_KEY` for custom providers
- Clears conflicting env vars (`OPENAI_HOST`, `OPENAI_BASE_PATH`)
- Sets `GOOSE_CONTEXT_LIMIT` from the provider's JSON model config
- New session with a set: `--system`, `--with-builtin`, `--no-profile`
- Resume applies the current set's prompt via `--system` (or `--system ""` when no set is selected), skips `--with-builtin` (extensions are in session DB)
- Shows set in launch summary if one was selected
- Spawns `goose session` with `stdio: inherit`, forwards exit code

### Chat Mode (ACP) — default
- cgoose spawns `goose acp` and renders the dialog itself instead of handing the terminal to Goose's TUI. This is the default; `CGOOSE_ACP_MODE=classic` switches to the classic `goose session` TUI (an unknown value warns and keeps the default)
- Streaming assistant text, thinking blocks, tool calls and token/cost usage are rendered by cgoose
- Session sets: builtins via `goose acp --with-builtin`, the full extension list via `_meta.enabledExtensions` (typed `GooseExtension[]`), stdio/HTTP extensions additionally via ACP `mcpServers`, system prompt via `_goose/unstable/session/system-prompt/set`
- `_meta.enabledExtensions` **replaces** the profile's extensions, so a set (and None, via an empty array) loads exactly what it lists — the chat-mode equivalent of `--no-profile`. The Default set sends no such field and lets the profile load. On resume `session/load` ignores it, so the loaded list is reconciled with `_goose/unstable/session/extensions/{list,add,remove}` — including Default, whose profile is rebuilt from `config.yaml` (goose has no "reset to profile" request), so a resumed session created with None really does switch to the profile extensions
- The chat no longer warns that "the profile is always loaded": after creating a session it reads the real extension list and warns only if profile extensions leaked in (a goose version that ignores the field) — `mcpServers` stays in the request as a safety net for exactly that case
- Provider and model reach the agent as `GOOSE_PROVIDER`/`GOOSE_MODEL`, and are then pinned through ACP with `session/set_config_option` (provider first, then model, because switching the provider resets the model to its default): `session/new` resolves the pair from the env, but `session/load` keeps the pair stored in the session row and would otherwise ignore the wizard's choice. `_meta.provider` is deliberately not sent, because goose would resolve the model from the provider registry's default and silently replace the one picked in the wizard. An unchanged pair sends no request; an unsupported option degrades into a warning instead of breaking the session
- The chat owns the alternate screen: the transcript (header included) scrolls inside cgoose (mouse wheel, PgUp/PgDn, Ctrl+Shift+F search) while the composer stays pinned, and streamed updates no longer pull the view back to the bottom. On exit the final transcript is printed back to the terminal's normal screen, so it stays in the scrollback. `CGOOSE_CHAT_MAIN_SCREEN=1` restores the old inline renderer (terminal owns scrollback, any repaint pulls the view down while a turn runs)
- Permissions are shown as a SelectList overlay; Esc/Ctrl+C during a turn cancels it. Esc exits when the prompt is empty (with a draft it arms the exit — press it twice), Ctrl+C always exits
- Two watchdogs bound a turn: no agent activity for 5 minutes cancels it (`CGOOSE_ACP_IDLE_TIMEOUT_MS`), a single turn is capped at 4 hours (`CGOOSE_ACP_PROMPT_TIMEOUT_MS`)
- Requires a goose with the `acp` subcommand (1.50 and 1.57 verified); without `_meta.enabledExtensions` support the profile loads alongside the set and the chat says so. No `acp` subcommand at all → cgoose falls back to the classic `goose session` TUI
- Verification: `bun run test` (no goose needed), `bun run acp:probe`, `bun run acp:smoke`

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

**Chat (ACP) mode is the default** — every flag above launches the cgoose chat UI on top of `goose acp`. The old chat letters are gone (`c` is no longer a flag); the pairs still work as aliases of their base mode (`mc`→`m`, `ac`/`ca`→`a`, `nc`/`cn`→`n`, `sc`/`cs`→`s`, `wc`→`w`).

```bash
cgoose a    # resume last session (with last set, provider, model)
cgoose n    # new session with last set/provider/model
cgoose s    # pick a session, then launch
cgoose m    # full workflow, no worktree
cgoose w    # full workflow, force worktree
cgoose wa   # auto-resume, force worktree

CGOOSE_ACP_MODE=classic cgoose n   # hand the terminal to the classic `goose session` TUI
```

## Scripts

| Script | What it does |
|--------|-------------|
| `build.sh` | Compiles a standalone binary (`./cgoose`) with Bun runtime embedded |
| `install.sh` | Installs source to `~/.local/lib/cgoose/` + launcher to `~/.local/bin/cgoose` |

---

## License

MIT