---
name: tmux-test-skill
description: End-to-end testing of rossii's interactive TUI inside tmux — wizard flows, session sets, extension reconciliation — verified against goose's sessions.db without spending LLM tokens. Use when a change touches the TUI, the launch path, session sets, or ACP extension handling and you need proof it works in a real terminal, not just in unit tests.
---

# Testing rossii through tmux

rossii's chat and wizard render with pi-tui, which repaints whole screens. Raw
pty capture is a soup of escape sequences; **tmux is the reliable harness**:
`capture-pane` gives the visible screen, `send-keys` drives the prompts.

Golden rule: **never send a prompt**. Every check below can be done on an idle
session, so a full verification costs zero tokens.

## Prerequisites

- `tmux`, `sqlite3`, `bun`
- run from the repo root so `bun src/index.ts` uses the working tree
- `ROSSII_NO_WORKTREE=1` so test runs do not create git worktrees
- use a throwaway working directory (e.g. `/tmp/rossii-test-<topic>`): rossii
  remembers settings **per directory**, and the session list is per directory

## Helper

`scripts/tmux-drive.py` wraps the tmux calls (start / wait / send / type /
capture / kill). `scripts/mcp-echo.py` is a minimal MCP stdio server that speaks
the handshake goose 1.57 expects — use it to test stdio extensions in a set.

```bash
SKILL_DIR=.goose/skills/tmux-test-skill
rm -rf /tmp/rossii-check && mkdir -p /tmp/rossii-check

python3 $SKILL_DIR/scripts/tmux-drive.py start --name t \
  --cwd /tmp/rossii-check --cmd 'ROSSII_NO_WORKTREE=1 bun /abs/path/to/src/index.ts'
python3 $SKILL_DIR/scripts/tmux-drive.py wait --name t --pattern 'Session set'
python3 $SKILL_DIR/scripts/tmux-drive.py type --name t probe   # filter, do not count arrows
python3 $SKILL_DIR/scripts/tmux-drive.py send --name t Enter
sleep 2
python3 $SKILL_DIR/scripts/tmux-drive.py capture --name t
python3 $SKILL_DIR/scripts/tmux-drive.py kill --name t
```

## Wizard map (6 steps)

1. **Session** — `● ✦ Create new session` first, then `Delete sessions...`, then
   existing sessions. Choosing an existing session **skips the name step**.
2. **Session name** — Enter = auto-name.
3. **Session set** — `None`, `Default`, then named sets. The list is ordered by
   **history first** (`❶` marks last used), so positions change between runs;
   `initialValue` is the last set. Type to filter instead of counting `Down`.
4. **Provider**, 5. **Model** — history first (`✦`), Enter keeps the last one.
6. **Launch** — `Yes / No`, Enter launches.

Keys: `Enter` confirm, `Esc` back one step, `Space` toggle in multiselects,
`Ctrl+C` exit rossii entirely.

## Pacing rules (this is where naive automation breaks)

- **Wait for text, not for time**: `wait --pattern` before the first key, and
  2–3 s between a step that opens a new prompt and the key that answers it.
  Sending `Enter` while the next prompt is still mounting submits it **empty** —
  the classic symptom is `builtins: []` in a freshly created set or an empty
  system prompt.
- Multi-key bursts are dropped: send text with `type`, then `sleep 1`, then
  `Enter` as a separate call.
- Count keys only when the list is stable; after a run the set history reorders.

## Verifying the result (the real assertion)

The UI message is a hint; the database is the truth.

```bash
# what a session actually has
sqlite3 ~/.local/share/goose/sessions/sessions.db \
  "select id, name, extension_data from sessions where name like 'rossii-check%';"

# readable form
sqlite3 ~/.local/share/goose/sessions/sessions.db \
  "select extension_data from sessions where id='20261104_3';" | python3 -c "
import json,sys
print([(e.get('type'), e.get('name') or (e.get('server') or {}).get('name'))
       for e in json.load(sys.stdin)['enabled_extensions.v0']['extensions']])"
```

Expected start-of-session message in the transcript when a set is applied to a
resumed session:

```
set applied to the resumed session: added developer, analyze, summon
default profile applied to the resumed session: added analyze, apps, Extension Manager, …
```

Tools (not just the extension list) can be checked over raw ACP —
`_goose/unstable/tools/list` with the session id — but the chat transcript plus
`sessions.db` is usually enough.

## Session sets

- Files: `~/.config/rossii/sets/<name>.yaml` (legacy `.json` also read).
  Shape: `name`, `title`, `description`, `systemPrompt`, `builtins`,
  `extensions` (config.yaml keys), `stdioExtensions`.
- **A malformed YAML is dropped silently** (`listSessionSets` swallows the parse
  error), so a set "missing" from the picker usually means bad indentation —
  validate with `bun -e 'import {load} from "js-yaml"; …'`.
- Quote values containing `: ` (e.g. `description: "test: one"`).
- Set with a `KEY=value` stdio spec cannot be expressed through ACP: it falls
  back to additive loading, and on resume the set is **not** reconciled.

## Stdio extensions in a set

```yaml
name: probe-mcp
title: Probe MCP
builtins: [developer]
stdioExtensions:
  - "echo-mcp:/usr/bin/python3 /abs/path/mcp-echo.py"
```

goose 1.57 starts with `server/discover` (MCP 2026-07-28) and needs a real
`DiscoverResult`; a server that answers `{}` produces
`process quit before initialization: stderr = …` from `extensions/add`, and is
**silently ignored** on a new session (no tools, no error). Use
`scripts/mcp-echo.py`, which handles both `server/discover` and `initialize`.

## Cleanup (always)

```bash
python3 $SKILL_DIR/scripts/tmux-drive.py kill --name t
sqlite3 ~/.local/share/goose/sessions/sessions.db \
  "delete from sessions where name like 'rossii-check%';"
rm -rf /tmp/rossii-check
rm -f ~/.config/rossii/projects/rossii-check-*.json
rm -f ~/.config/rossii/sets/probe-*.yaml
```

`tmux kill-session` on the **last** session kills the tmux server — harmless,
but a following `capture` fails with "no server running". Test sessions are real
sessions in goose's DB; they show up in the user's `goose session list`, so
delete them. Never test against a session the user owns: resuming it rewrites
`extension_data` (an earlier run wiped the extensions of a live session —
restore by diffing against a reference session if it happens).

## What this skill has already verified

See `plans/sets-resume-verification.md`: new sessions with builtins / with stdio
MCP, switching named sets on resume, `None`, `Default`, MCP re-add on resume, and
the create-set wizard. Use it as a checklist template for the next TUI change.
