# cgoose

**TUI for [Goose](https://github.com/block/goose) AI sessions** — interactive session manager with provider/model selection, navigation, and per-project persistence.

![Goose](https://img.shields.io/badge/Goose-AI%20sessions-blue?style=flat-square)

---

## Features

- **Session management** — browse existing sessions, create new ones, or delete (bulk or individually)
- **Provider selection** — pick from enabled providers in your `goose config.yaml`
- **Model selection** — last-used model per project, manual entry, or live fetch from OpenAI-compatible APIs
- **Navigation loop** — `Esc` goes back one step at any point, never aborts abruptly
- **Per-project memory** — remembers last provider + model per directory
- **Minimal dependencies** — only `@clack/prompts` and `picocolors`

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- [Goose](https://github.com/block/goose) installed and configured (`goose configure`)
- `sqlite3` CLI (for session deletion)

---

## Install

```bash
git clone https://github.com/viorn/cgoose.git
cd cgoose
bun install
```

## Usage

```bash
bun run index.ts
```

Or make executable and run directly:

```bash
chmod +x index.ts
./index.ts
```

## Workflow

1. **Session** — pick an existing session, create a new one, or delete sessions for the current directory
2. **Name** (new sessions only) — auto-generated as `project-YYYY-MM-DD-HH-mm`, or type your own
3. **Provider** — select from enabled providers in your Goose config
4. **Model** — choose last-used, type manually, or fetch from API (OpenAI-compatible providers)
5. **Launch** — review summary and confirm — Goose starts with your selection

Press `Esc` at any step to go back.

---

## Configuration

### Goose Config (`~/.config/goose/config.yaml`)

cgoose reads the `providers:` section and shows only **enabled** providers:

```yaml
providers:
  openai:
    enabled: true
    model: gpt-4o
  custom_provider:
    enabled: true
    model: deepseek/deepseek-v4-flash
```

### Custom Providers (`~/.config/goose/custom_providers/*.json`)

If a custom provider has an `engine`, `base_url`, and `headers`, cgoose uses them for API model fetching:

```json
{
  "name": "custom_provider",
  "engine": "openai",
  "base_url": "https://api.example.com",
  "headers": {
    "Authorization": "Bearer sk-..."
  }
}
```

### Per-Project Persistence (`~/.config/cgoose/projects/`)

cgoose saves your last-used provider and model per directory. No global config pollution.

---

## Key Design Decisions

- **Single-file** — everything in `index.ts`, no modularization overhead
- **Minimal deps** — no YAML parser, no ORM, no HTTP client; uses stdlib and native `fetch`
- **Direct SQLite deletion** — bypasses Goose CLI for fast, reliable session cleanup
- **Esc-navigation** — every step is reversible, exploration-friendly

---

## License

MIT