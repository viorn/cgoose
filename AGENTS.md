# cgoose — Agentic AI Session Manager

## Overview

**cgoose** is a TUI (Terminal User Interface) for managing [Goose](https://github.com/block/goose) AI sessions. It provides an interactive multi-step workflow for selecting or creating sessions, choosing providers and models, and launching Goose.

Built with [Clack](https://github.com/natemoo-re/clack) prompts + [picocolors](https://github.com/alexeyraspopov/picocolors).

---

## Architecture

### Language & Runtime
- **TypeScript** — runs under [Bun](https://bun.sh)
- Single-file entry: `index.ts` (~680 lines)

### Dependencies
| Package | Purpose |
|---------|---------|
| `@clack/prompts` | Interactive TUI prompts |
| `picocolors` | Terminal styling |
| *(stdlib)* | `child_process`, `fs`, `path`, `os`, `crypto`, `process` |

### Config / Data Paths
| Path | Purpose |
|------|---------|
| `~/.config/goose/config.yaml` | Goose config — parsed for enabled providers |
| `~/.config/goose/custom_providers/*.json` | Custom provider definitions (engine, base URL, auth) |
| `~/.config/cgoose/projects/<dirname>-<hash>.json` | Per-project last-used provider/model |
| `~/.local/share/goose/sessions/sessions.db` | SQLite DB — direct deletion via `sqlite3` |

### Data Flow
```
  Step 1: Session Selection (pick existing / create new / delete)
  Step 2: Session Name (auto: project-YYYY-MM-DD-HH-mm)
  Step 3: Provider Selection (from config.yaml, enabled only)
  Step 4: Model Selection (last used / manual / API fetch)
  Step 5: Summary & Launch (goose session --name --provider --model)
```

### Key Components

- **`parseYamlProviders()`** — Minimal YAML parser, extracts enabled providers + default models from config. No external YAML lib.
- **`enrichProviders()`** — Reads custom provider JSONs for engine, baseUrl, authToken.
- **`getAllSessions()`** — Shells out to `goose session list --format json`.
- **`deleteSessionById()`** — Deletes from SQLite directly (3 tables in a transaction).
- **`fetchModelsFromApi()`** — Hits `GET /v1/models` on OpenAI-compatible APIs (15s timeout).
- **`launchGoose()`** — Saves project meta, spawns `goose session` with stdio: inherit.
- **`getProjectKey()`** — Deterministic key: `<dirname>-<sha256[:8]>` from CWD.

---

## Key Design Decisions

1. **Single-file architecture** — Everything in `index.ts`. No modularization. Fits a focused TUI tool under 700 lines.
2. **Minimal dependencies** — Only `@clack/prompts` and `picocolors`. No YAML parser, no ORM (raw `sqlite3`), no HTTP client (native `fetch`).
3. **Per-project memory** — Persists last-used provider+model per directory, not globally. Matches project-specific workflows.
4. **Navigation loop** — `Esc` goes back one step instead of aborting. Natural exploration flow.
5. **Direct SQLite deletion** — Bypasses Goose CLI, writes SQL directly for speed and reliability.

---

## TUI Wrapper (`wrapper.ts`)

Built in `feature/tui-wrapper` branch. PTY-обёртка вокруг goose session:

- **PTY** через `Bun.spawn(["goose", ...], { pty: true })`
- **Raw mode** через `Bun.Terminal.setRawMode()`
- **Hotkeys**: Ctrl+P (model change), Ctrl+F (fork), Ctrl+Q (quit)
- **Dialogs**: `@clack/prompts` поверх goose при активации хоткея
- **Model switch**: отправляет `/model --provider X Y\n` в PTY (встроенная команда goose)
- **Fork**: SIGTERM → `goose --resume --fork --provider X --model Y`
- **Project meta**: `~/.config/cgoose/projects/<dir>-<hash>.json`

### FileSink note
В PTY-режиме `Bun.spawn` возвращает stdin как `FileSink` (не WritableStream).
Использовать: `ptyStdin.write(data)` — синхронно, без await/getWriter.`