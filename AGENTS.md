# rossii — Agent Context

> **⚠ Tested only on Linux.** May work on macOS. Windows is not supported.

> **History:** the project was called **cgoose** until 3.0.0 (repo: `viorn/cgoose` → `viorn/rossii`).
> The rename is deliberately backward compatible — `ROSSII_*` settings fall back to `CGOOSE_*`
> (`env()` in `src/utils.ts`), settings are read from `~/.config/rossii` or the old
> `~/.config/cgoose` when the new one is absent, and a session's system prompt stored under the
> legacy `cgoose` key is cleared on apply (`applySystemPrompt()` in
> `src/acp/chat-extensions.ts`).

## Overview

rossii is a TUI wrapper around `goose session` CLI. It launches Goose — it does not replace it.

## Key facts for agents

- Lives in the user's project directory, remembers settings **per directory** (`~/.config/rossii/projects/<dir>-<hash>.json`)
- Reads `~/.config/goose/config.yaml` for enabled providers
- Reads `~/.config/goose/custom_providers/*.json` for custom provider definitions (engine, baseUrl, authToken)
- **Session sets** (`~/.config/rossii/sets/<name>.json`) replace recipes as the primary way to bundle a system prompt + builtin extensions. Recipes are still discovered via `goose recipe list --format json` but rossii launches via `goose acp` (chat mode, default) or `goose session` (`ROSSII_ACP_MODE=classic`), never `goose run --recipe`
- Set history tracked per-project (like provider/model history), last used shown at top
- The selected **set is the source of truth** for the system prompt: on resume the *current* set's prompt is applied, and **None** explicitly clears any stored prompt via `--system ""` (Goose ≥1.55 persists `--system` in the session DB, so omitting the flag would restore the old prompt instead of clearing it)
- On new session, set's system prompt is passed via `--system`, extensions via `--with-builtin` / `--with-extension` / `--with-streamable-http-extension` + `--no-profile`
- Secrets resolved from: env vars → system keyring → `~/.config/goose/secrets.yaml` → JSON config files
- Config file: `~/.config/rossii/config.json` — supports `default_mode` (`"worktree"` or `"no-worktree"`)

## Wizard Flow (6 steps)

The TUI wizard has 6 steps, each with `initialValue` set to the last-used selection:

1. **session** — pick existing session or create new. `initialValue` on last-new
2. **session_name** — enter name (Enter = auto-name from generated prefix)
3. **set** — last-used set is **first** (`❶`), then None, then history + alphabetically, plus options to create/manage sets. `initialValue: lastSet`
4. **provider** — sorted by history then alphabetical. `initialValue: lastProviderRaw`
5. **model** — last used (`✦`), then history, configured models, manual/fetch. `initialValue: lastModel / defaultModel`
6. **launch** — summary + confirmation

**Pressing Enter on every step = resume with identical set/provider/model as last session.**

Quick modes skip the wizard: `rossii a` (last session in this directory) and `rossii n`
(new session) go straight to step 6, and in **chat mode they skip the confirmation too** —
the chat opens immediately (`quickLaunch` in `src/wizard-launch.ts`). Classic mode still asks.

Implementation of the wizard: `src/index.ts` is a thin `main()` (CLI flags, worktree /
renderer resolution, the step loop), `src/wizard-steps.ts` holds steps 1–5 plus
`resolveChatMode`/`LEGACY_CHAT_ALIASES`, `src/wizard-launch.ts` resolves the CLI launch
mode and renders the summary, and `src/wizard-sessions.ts` holds the session-deletion
dialog and the set create/manage wizards.

If no project meta exists yet, first option is selected (None → first provider → first model).

## Session Sets

A session set is a YAML file at `~/.config/rossii/sets/<name>.yaml` (legacy `.json` is still read):

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
- Created/managed via the TUI: **Set → ⚙️ Create new set...** / **Manage sets...**, or manually in `~/.config/rossii/sets/`

### "None" vs "Default" vs a set

- **None** (`""`) → classic: `--no-profile` only, a session with **no extensions at all**;
  chat: `_meta.enabledExtensions: []` — no profile and (1.50.0 / 1.57.0) no extensions at all; some builds
  inject their own `developer`, which rossii treats as allowed but never adds or removes
- **Default** (`__default__` sentinel in `src/launcher.ts`) → no flags at all, so Goose loads the profile from `~/.config/goose/config.yaml`; chat sends no `enabledExtensions` at all
- **Set** → exactly the flags/typed list derived from the set

Extension flags are only effective when a session is **created**. On resume Goose restores the extension list stored in `sessions.extension_data` and ignores CLI extension flags; `setHistory[0]` may hold the `__default__` sentinel.

### Prompt on resume

Goose ≥ 1.55 persists `--system` in the session DB (`system_prompt_extras`), so on resume rossii:
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
- `ROSSII_NO_WORKTREE=1` — skip worktree creation
- `ROSSII_FORCE_WORKTREE=1` — force worktree (overrides above)
- `-m` CLI flag disables worktree (default)
- `-w` CLI flag enables worktree
- Config `~/.config/rossii/config.json`: `{ "default_mode": "worktree" }` — override default to worktree mode

## Chat Mode (ACP) — default renderer

rossii itself renders the dialog by default. It spawns `goose acp` (Agent Client
Protocol, JSON-RPC 2.0 over stdio) and drives it as an ACP client using
`@earendil-works/pi-tui`. `ROSSII_ACP_MODE=classic` (or `0`/`off`/`false`/`session`)
hands the terminal over to the classic `goose session` TUI instead; an unrecognised value
warns in the TUI and keeps the ACP default.

- No chat-specific CLI letters: `c` is gone, and the old pairs are aliases of their
  base mode (`mc`→`m`, `ac`/`ca`→`a`, `nc`/`cn`→`n`, `sc`/`cs`→`s`, `wc`→`w`)
- Implementation: `src/acp/` — `client.ts` (transport), `custom.ts` (goose custom
  requests, methods `_goose/unstable/...`), `extensions.ts` (spec → ACP `mcpServers`,
  pure and unit-tested), `session-meta.ts` (`session/new` `_meta`, pure and unit-tested),
  `session-config.ts` (provider/model via `session/set_config_option`, pure planning +
  non-throwing apply, unit-tested), `steer.ts` (steering a running turn: meta parsing and
  the Enter decision, pure and unit-tested), `slash-commands.ts` (which `/…` is the chat's
  and which is goose's, plus the command list goose announces, pure and unit-tested),
  `command-complete.ts` (the composer's `/…` completion menu: the chat's commands plus
  goose's announced ones, pure and unit-tested),
  `model-options.ts` (the model menu's entries: goose's `configOptions.model.options`
  unioned with the custom provider's own JSON — goose's registry only reloads such a file
  on provider create/update/delete, so a model written by `/model fetch` would otherwise
  vanish from the menu — pure and unit-tested),
  `overlay.ts` (framed / searchable lists),
  `timeouts.ts` (turn watchdogs), `thought.ts` · `tool-call-block.ts` ·
  `tool-call-content.ts` (the collapsible thinking and tool blocks)
- The chat itself is one module per responsibility, all sharing a `ChatContext`
  (`chat-context.ts`: the mutable state, themes, constants, `createChatContext`):
  `chat.ts` (~120 lines) only orchestrates — spawns `goose acp`, builds the context and
  wires the rest; `chat-ui.ts` (layout, composer, keyboard, watchdogs, shutdown, agent
  exit), `chat-io.ts` (prompt dispatch, steering, `/edit`, turn lifecycle),
  `chat-stream.ts` (`session/update` rendering), `chat-session.ts` (initialize +
  `session/new`|`session/load`, `/session` commands), `chat-config.ts` (`/config` menus,
  the model fetch, and the `/…` routing: what rossii does not implement goes to goose),
  `chat-extensions.ts` (the set's extension plan and its
  reconciliation), `chat-handlers.ts` (agent→client requests: permissions, fs)
- Classic mode still lives in `src/launcher.ts`; shared launch preparation (worktree,
  env, secrets) is `prepareLaunch()`, used by both modes
- Rendering: the chat owns the **alternate screen** — `TuiAltScreen` with an explicit
  layout root (`ScrollView(document, { follow: "end", primary: true })` with the header
  as the first lines of the document, composer pinned). Scroll position survives
  streaming: follow-end turns off when the user scrolls up and resumes at the bottom.
  `tui.stop()` prints the final
  transcript back to the normal screen, so scrollback keeps the conversation.
  `ROSSII_CHAT_MAIN_SCREEN=1` switches back to `TuiMainScreen` (inline; the terminal owns
  scrollback, so any repaint — spinner, streamed chunk — pulls the view to the bottom)
- Thinking blocks (`src/acp/thought.ts`, `ThoughtBlock`): the block that is streaming starts
  **expanded** (reasoning is visible live, like before the collapsible bars) and collapses to
  `💭 Thought · N chars` on `setFinished()`; a click or `/think` reopens it. A manual toggle
  (`toggle()` / `setExpanded()`) outranks that auto-collapse. `/think [expand|collapse] [all]`
  reaches every block of the conversation (`parseThoughtCommand` is pure and unit-tested),
  `/think` alone toggles the most recent one. Clicking is only advertised when the renderer
  captures the mouse: `TuiMainScreen` does not, so the bar says `/think expand` there
  (`clickable` option). The transcript stays a plain `Container` — `Stack.render` does not
  record the child geometry `Container.handleMouse` hit-tests with, so a `VStack` there
  re-rendered the whole transcript on every mouse event. Thought repaints share the text
  stream's 50 ms window (`flushThought`) instead of one frame per chunk.
- Answers: an assistant message is one `Container` — an `❮ Answer · N chars` label followed
  by the streaming markdown — so the block reports its size live like the thought bar
  (`formatCharCount` in `src/utils.ts` is shared by both). The count accumulates per chunk
  (`[...chunk].length`, code points) instead of re-measuring the buffer, which would make a long
  answer quadratic. A tool call splits the answer (`closeMessage`), and each half then carries
  its own label and count.
- **Steering** (`src/acp/steer.ts`, pure + unit-tested): Enter during a turn adds a user message to
  the *running* prompt (`_goose/unstable/session/steer`) instead of doing nothing — no second
  `session/prompt`, no cancel, no lost work. goose announces the turn through
  `session_info_update` → `_meta.goose.activeRunId` (string on start, `null` on end); the steer is
  pinned to that id (`expectedRunId`) and answered `{runId, messageId}`, acked by
  `_meta.goose.queuedSteer` (the ack can beat the response — `steerAckIds` holds it) and finally
  echoed as a `user_message_chunk` with `_meta.goose.steer: true` and the same id. "Accepted" is not
  "delivered": goose drains the queue on a turn boundary (finished assistant message or tool
  result), so the provisional `⤴ steering: …` / `⤴ steer queued: …` line is replaced by a real
  `❯ …` only on that echo, and `finishTurn` / `onAgentExit` drop what is left
  (`abandonPendingSteers`, `discard_pending_steers` on goose's side) with the text back in the
  composer. Esc keeps cancelling (with a note that queued steers die with the turn), and a steer
  that cannot be sent (`no active run to steer`, stale run id, `-32601` on an older goose) falls
  back to a one-slot `pendingPrompt` that `finishTurn` sends as a normal prompt.
  `ROSSII_ACP_STEER=0` disables the feature (Enter mid-turn restores the draft and says so;
  anything but `0`/`1` warns, like the watchdogs). Plan and live traces: `plans/acp-steering.md`.
- Tool-call blocks (`src/acp/tool-call-block.ts`, `ToolCallBlock`, modelled on `ThoughtBlock`):
  a `tool_call` opens a block whose chrome bar is `statusIcon · tool name · N chars · hint` (variant
  C — the command never shares that line). `rawInput` supplies the full command via `setDetail()`
  (goose's `title` is truncated by `default_tool_title`: first line, 57 chars + "…"), which is
  wrapped on the following line(s) — at most two lines collapsed, unlimited expanded. The icon is
  coloured by status (`statusColor`); the status *word* is not printed (the icon carries it). A
  click or `/tool [toggle|expand|collapse] [all]` expands/collapses; `/tool` alone toggles the most
  recent block and `all` reaches the whole conversation (`parseToolCommand` is pure and
  unit-tested). `src/acp/tool-call-content.ts` maps the wire shapes: `toolContentText` unwraps the
  ACP `ToolCallContent` envelope (`{type:"content", content:{…}}`, `diff`, `terminal`) — the first
  version tested `content[].type === "text"` and every block stayed at "0 chars" — and
  `toolCallPayload` returns two operations because goose streams output on `_meta.toolNotification`
  (`live_output`) and then RESTATES the whole output in the final `content`: `appendContent` for the
  live chunks, `setContent` (replace) for the final update. `setFinished()` collapses a block unless
  the user toggled it by hand; `closeToolBlocks()` marks live blocks finished on `finishTurn`,
  agent exit and after the `session/load` replay, so a resumed conversation has no block stuck on
  "in progress".
- Session sets in chat mode (verified live on goose 1.50.0 and 1.57.0 via the probes described in
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
    name differs between versions — `extensionKey` vs `name`, see `src/acp/custom.ts`).
    Matching is by extension NAME (goose normalizes keys: `Extension Manager` →
    `extensionmanager`), removal uses the key
  - **Default on resume** is reconciled too: `planProfileExtensions(listGooseExtensions())`
    rebuilds the profile from config.yaml (goose has no "reset to profile" request), so a
    session created with None actually gains the profile extensions; a profile entry ACP
    cannot express (inline env) is left untouched and reported. config.yaml (not
    `_goose/unstable/config/extensions/list`) is the source: goose filters HIDDEN platform
    extensions out of that RPC (`is_hidden_extension`) — in 1.57 those are `scheduler` and
    `orchestrator`, so the RPC would silently drop the scheduler on every Default switch
  - after creating a session the chat reads the real extension list and warns only if profile
    extensions leaked in (a goose that ignores the field) or expected ones are missing
  - system prompt → goose custom request `_goose/unstable/session/system-prompt/set`
    (`mode: "set"`, key `rossii`); empty text clears it — same "set is source of
    truth" semantics as classic `--system`. A failure here is non-fatal (warning only)
- **Slash commands** — rossii answers its own (`/config`, `/model`, `/provider`, `/set`,
  `/session`, `/rename`, `/fork`, `/think`, `/tool`, `/edit`, `/fetch`, `/help`) and sends
  **everything else that starts with `/` to the agent as a plain prompt**, so goose's own
  commands work: `/compact`, `/clear`, `/status`, `/doctor`, `/goal`, `/grind`, `/prompts`,
  `/prompt`, `/skills` and the slash commands goose builds from recipes and skills (see
  `src/acp/slash-commands.ts`). Nothing is validated against goose's announced list:
  goose's own TUI forwards an unknown `/…` as a message too (`handle_slash_command` returns
  `None`), and refusing what the chat cannot know about is what made `/compact` unreachable.
  goose's `execute_command()` only looks at a turn's *prompt*, so a command typed during a
  turn is queued, never steered. `available_commands_update` (sent after `session/new`,
  `session/load` and fork) is kept for `/help`; for `/compact`, `/clear` and `/summarize` a
  note says goose rewrites its stored conversation and the transcript here is not refreshed
  (goose's ACP server does not forward `AgentEvent::HistoryReplaced`)
- **Completing them** — the composer completes `/…` (`src/acp/command-complete.ts`): the
  editor gets an `AutocompleteProvider`, which pi-tui only has when one is installed
  (`setupUi` did not, so `/` and Tab were dead keys). It offers the chat's commands
  (`CHAT_COMMANDS`, the same list `/help` prints) followed by goose's announced ones —
  builtins, recipes and skills — de-duplicated by name, read lazily per keystroke so
  goose's list can arrive after the provider is installed. Typing `/` on the first line
  opens the menu by itself (`isInSlashCommandContext`), Tab opens or re-opens it after Esc,
  ↑/↓ pick, Esc closes it and keeps the draft (`capturesViewportInput` already hands Esc to
  the editor), Enter applies **and submits** (`prefix.startsWith("/")` is the editor's own
  condition for a slash command), Tab applies without submitting. Matching is
  prefix-then-substring, case-insensitive, names only: `/model ` (with a space) closes the
  menu. Nothing is gated by it — it is a shortcut for typing, not a filter
- **Live configuration** — no restart: slash commands typed into the composer
  (`/config`, `/provider`, `/model`, `/set`, `/session`, `/rename`, `/fork`, `/think`, `/tool`) plus `SelectList`
  overlays. `showMenu()` refuses to stack a menu on a permission prompt or another menu:
  - provider/model → `session/set_config_option`; the response's `configOptions` are kept, and
    `session/load`'s are read too (`LoadSessionResponse` used to be discarded, which is why the
    model menu claimed "No model list available" on every resume). The `session/update` →
    `config_option_update` notification is handled as well: goose sends the whole option set at
    session setup and again when a provider switch's background inventory refresh completes, and
    that second one is the only way to see the refreshed model list — the synchronous
    `set_config_option` response still carries the pre-refresh one. The current pair is left to
    `changeModel`/`changeProvider` (the notification only refreshes the lists)
  - every successful `/provider`, `/model` or `/set` change is written back to the per-project
    meta (`~/.config/rossii/projects/<dir>-<hash>.json`) through `persistSelection()` →
    `writeProjectMeta()` — the same file `prepareLaunch()` writes for the wizard — so the next
    `rossii`/`rossii a`/wizard run starts from what the chat is actually using instead of the
    launch-time pair. The set key goes into `setHistory` as-is: `""` = None, `__default__` =
    goose's profile, anything else = the set's name
  - set → system prompt + **extension reconciliation in place** through
    `_goose/unstable/session/extensions/{list,add,remove}`, driven by `planForSet()`:
    `buildExtensionArgs` resolves the set's `extensions:` names exactly like the launcher, so
    the live list equals what a new session would get. Default switches to the profile built
    from config.yaml, None empties the list (goose keeps its implicit `developer`). Verified
    live: A→B added/removed builtins, Default added `scheduler` (hidden from the config RPC),
    None removed everything, a stdio set added `echo-mcp`
  - session → `session/load`, then the current provider/model pair is re-applied and the set is
    reconciled; the picker is filtered to this project's directories (same filter as the
    wizard) because `sessions.db` holds every project the user ever ran
  - model list → `configOptions.model.options`; when goose has none (or for models the
    provider added later) **🔄 Fetch models from API** / `/model fetch` calls the provider's
    own `GET {base_url}/v1/models` (`fetchModels()` in `src/models.ts`, no clack spinner —
    the chat owns the terminal) and offers the result in a searchable overlay. Picking one
    applies it and, for a `custom_*` provider, records it in the provider JSON with the
    API's context limit (`addModelToCustomProviderJson`), so the wizard sees it too. The
    menu itself is goose's list **unioned** with that JSON (`mergeModelOptions` in
    `src/acp/model-options.ts`, pure and unit-tested): goose's in-process provider registry
    reloads a `custom_providers/*.json` only on provider create/update/delete over ACP, so
    without the union a just-fetched model disappears from the menu on the next open
    (`set_config_option("model")` rebuilds the options from the same stale inventory)
  - overlays are framed: pi-tui has no border primitive, so `BorderBox` (`src/acp/overlay.ts`,
    unit-tested) draws a titled box around the SelectList; long lists use `SearchableList`,
    which adds a filter line and matches by **substring** (the stock `setFilter` is
    prefix-only, useless for 700 model ids) while forwarding arrows/Enter/Esc
  - `/edit` (Ctrl+E) suspends the renderer with `tui.stop({ preserveScreen: true })`, runs
    `$VISUAL`/`$EDITOR`/`vi` on the real terminal via `sh -c '<editor> "$1"'` with the composer's
    draft as the buffer, then `tui.start()` takes the chat back; a clean exit sends the file's
    content through the normal `submitPrompt()`, a non-zero exit sends nothing
  - Ctrl+P opens `/config` (alias `/settings`), Ctrl+O opens `/model`. **Ctrl+M is Enter** (CR is
    the Ctrl+M control character), so it cannot be a shortcut — it would fire on every prompt
  - rename → `_goose/unstable/session/rename`; a bare `/rename` (or the menu entry) asks the
    composer for the title, Esc cancels without exiting
  - fork → `session/fork` (returns a new session id; probe `scripts/acp-fork-probe.ts`), the
    copy is renamed `<title> (fork)` and configured like the current session
  - a set change, session switch or fork is refused while a turn runs; provider/model switches
    are allowed and apply to the next turn
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
  unconditionally. An **open overlay owns Esc** (`tui.hasOverlay()` in the input listener):
  it closes the menu / rejects the permission prompt instead of quitting the chat — the
  listener used to intercept it and exit with the dialog still on screen
- If `goose acp` dies, the chat stops accepting prompts and Esc exits; `send()` refuses
  to write to a closed transport, so no request can hang forever
- `fs/read_text_file` / `fs/write_text_file` are served for any path the agent asks for
  (no worktree sandbox; write creates parent dirs). A read honours ACP `line`/`limit` and
  defaults to 2000 lines (the ACP default), so one huge file cannot flood the context.
  ACP clients are trusted — MCP servers effectively get the same access
- Two watchdogs bound a turn (`src/acp/timeouts.ts`); both are disabled by `0`, and a
  malformed value warns in the chat instead of silently switching the guard off:
  - `ROSSII_ACP_IDLE_TIMEOUT_MS` (default 5 min) — no `session/update` from the agent for
    that long → `session/cancel`; a long but *live* turn is never interrupted
  - `ROSSII_ACP_PROMPT_TIMEOUT_MS` (default 4 h) — absolute cap on a single turn; on
    timeout the client also sends `session/cancel` and the UI reports the error
- `session/new` `_meta` is built by `newSessionMeta()` (`src/acp/session-meta.ts`) and stays FLAT:
  goose reads session fields at the top level (`_meta.goose` is only for initialize
  capabilities), so a nested `client` used to leave the session `Acp` — invisible to
  `goose session list` and to the wizard — and a nested `sessionTitle` left it "New Chat"
- Provider/model reach the agent via `GOOSE_PROVIDER`/`GOOSE_MODEL` env, with the wizard's
  pair then pinned through ACP: `_meta.provider` is deliberately not sent, because goose
  resolves the model from the provider registry's default and ignores `GOOSE_MODEL` — the
  wizard's model choice was silently replaced (live 1.57: `custom_kodik` +
  `GOOSE_MODEL=qwen/qwen3.6-flash` → `deepseek/deepseek-v4-flash`); `session/load` then
  ignores the env entirely and keeps the pair stored in the session row, so the model would
  also be lost on resume. Both cases go through `session/set_config_option`
  (`src/acp/session-config.ts`, the SACP request goose's own ACP client uses): a pure
  `planSessionConfig()` sends **provider first, then model** (switching the provider resets
  the model to that provider's default — live: `custom_openintegration` →
  `deepseek/deepseek-v4-flash`), skips an unchanged pair, and `applySessionConfig()` never
  throws — an unsupported `configId` (`Unsupported config option: …` on an older goose)
  becomes a chat warning, and a silent mismatch between the request and the agent's reported
  `configOptions` is reported too. `value` must be a bare string: an object fails goose's
  `untagged enum SessionConfigOptionValue` deserialization. `configOptions` come from the
  `session/new` response (new sessions) and from `sessions.db`'s `provider_name` +
  `model_config_json` (resume, passed as `resumeConfig`) rather than
  `_goose/unstable/session/info`, which does not exist on goose 1.50
- `_meta.sessionTitle` + `_meta.client` name the session and make it a normal `user` session
  (`session_type = 'user'`); ACP sessions created before this are still listed, just badged
  `[acp]` — listing reads `sessions.db` directly (`src/sessions.ts`, types `user`/`scheduled`/`acp`),
  because `goose session list` reports only `user` + `scheduled`; resume uses `--session-id`,
  which has no `session_type` filter (`--name` resolves through `list_sessions()` and failed on ACP ids)
- Requires a goose with the `acp` subcommand (1.50.0 and 1.57.0 verified; `_goose/unstable/*` methods degrade
  to warnings when absent); `launchGooseAcp` checks `goose acp --help` at startup and falls
  back to the classic TUI otherwise
- Verification scripts: `bun run test` (unit tests for `extensions.ts`, `session-meta.ts`,
  `session-config.ts`, `steer.ts`, `slash-commands.ts`, `command-complete.ts`,
  `model-options.ts`, the db-backed
  session listing, the overlay
  components and the
  tool-call block + its `tool-call-content.ts` wire mapping — no goose
  needed), `bun scripts/acp-probe.ts`
  (raw protocol), `bun scripts/acp-steer-probe.ts` (steering against a live agent: run id, ack,
  pickup, `ids match: YES`; it parses the meta with `src/acp/steer.ts`, so the shipped code is what
  gets proven) and `bun scripts/acp-client-smoke.ts` (`src/acp/client.ts` without the TUI; checks the
  `enabledExtensions` and `mcpServers` channels)

## Data Paths

| What | Path |
|------|------|
| Per-project memory | `~/.config/rossii/projects/<dir>-<hash>.json` |
| Session sets | `~/.config/rossii/sets/*.json` |
| rossii config | `~/.config/rossii/config.json` |
| Provider configs | `~/.config/goose/custom_providers/*.json` |
| Goose config | `~/.config/goose/config.yaml` |
| Goose sessions | `~/.local/share/goose/sessions/sessions.db` |

## Local Config Overrides

rossii looks for `.goose/config.yaml` in the session's worktree (or project root):

- Sets `GOOSE_ADDITIONAL_CONFIG_FILES` so Goose loads it alongside main config
- Resolves `${VARIABLE}` / `$VARIABLE` references from Goose secrets and injects into session environment

## Common tasks

### Add a model to a custom provider
Append to `models` array in `~/.config/goose/custom_providers/<name>.json`:
```json
{ "name": "model-id", "context_limit": 128000 }
```

### Create a session set manually
Write `~/.config/rossii/sets/<name>.json` with the shape above, or use the TUI wizard.

### Reset project history
Delete the corresponding file in `~/.config/rossii/projects/`.

### Build the release binary
`bash build.sh` — writes `rossii-<version>-linux-x86_64` and its `.sha256`, and refuses to leave an
artifact whose loader is not `/lib64/ld-linux-x86-64.so.2` or that needs a C++/musl runtime (the
released 2.0.2 … 3.0.0 had Homebrew's loader baked in and started only on the build machine).

Do **not** add `--target=…` to that command: an explicit target makes Bun download the official
release for it and can replace the installed `bun` (observed 1.4.0 → 1.4.4 mid-session, artifacts
83.4 MB → 105 MB). The artifact *is* the embedded Bun runtime with ~2.5 MB of rossii on top, so its
size follows the compiler — `build.sh` prints `bun --revision` next to the result. The binary runs
on glibc ≥ 2.17 x86_64 (centos:7, debian:8, ubuntu:16.04, debian:11 verified); not on musl
(`bun-linux-x64-musl` still needs `libc.musl` and `libstdc++`), not on ARM64, not on a CPU without
AVX2. Builds are reproducible for the same outfile name and Bun — the name is embedded in the
executable, so a differently named output hashes differently.

## Navigation

- **Esc** at any prompt: go back one step
- **Ctrl+C**: exit entirely
