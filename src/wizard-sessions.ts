/**
 * rossii — session-set wizard and session-deletion dialog.
 *
 * The interactive dialogs behind "Delete sessions..." and the "⚙️ Create new
 * session set..." / "Manage sets..." entries of the Set step. Moved verbatim
 * out of `src/index.ts`.
 */

import { resolve } from "node:path";
import { confirm, isCancel, log, multiselect, select, spinner, text } from "@clack/prompts";
import pc from "picocolors";

import { listSessionSets, saveSessionSet, deleteSessionSet, type SessionSet } from "./rossii-config";
import { getWorktreeMappings, removeWorktreeMapping } from "./project";
import { deleteSessionById, formatSessionHint, type GooseSession } from "./sessions";
import { listGooseExtensions } from "./goose-extensions";
import { removeWorktree } from "./worktree";

// ─── Session deletion dialog ─────────────────────────────────────────────────

export async function handleDeleteSessions(
  _allSessions: GooseSession[],
  dirSessions: GooseSession[],
): Promise<boolean> {
  // Count empty sessions
  const emptySessions = dirSessions.filter((s) => s.message_count === 0);

  // 1) Choose mode
  const mode = await select({
    message: "Delete sessions:",
    options: [
      { value: "select", label: "Select individually" },
      { value: "empty", label: "Clean empty sessions", hint: "(" + emptySessions.length + " sessions)" },
      { value: "all", label: "Clean all sessions in this directory", hint: "(" + dirSessions.length + " sessions)" },
      { value: "back", label: "\u2190 Go back" },
    ],
  });

  if (isCancel(mode) || mode === "back") return false;

  if (mode === "empty") {
    if (emptySessions.length === 0) {
      log.info(pc.dim("No empty sessions in this directory."));
      return false;
    }
    const confirmed = await confirm({
      message: "Delete " + emptySessions.length + " empty sessions in " + pc.cyan(resolve(".")) + "?",
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) return false;

    const s = spinner();
    s.start("Deleting " + emptySessions.length + " empty sessions...");
    let ok = 0, fail = 0;
    for (const session of emptySessions) {
      if (deleteSessionById(session.id)) {
        ok++;
        // Clean up associated worktree (mapped by session NAME, not UUID id)
        const wtMappings = getWorktreeMappings();
        if (wtMappings[session.name]) {
          removeWorktree(session.name);
          removeWorktreeMapping(session.name);
        }
      } else fail++;
    }
    s.stop("Done: " + ok + " deleted, " + fail + " failed");
    return true;
  }

  if (mode === "all") {
    if (dirSessions.length === 0) {
      log.info(pc.dim("No sessions in this directory."));
      return false;
    }
    const confirmed = await confirm({
      message: "Delete all " + dirSessions.length + " sessions in " + pc.cyan(resolve(".")) + "?",
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) return false;

    const s = spinner();
    s.start("Deleting " + dirSessions.length + " sessions...");
    let ok = 0, fail = 0;
    for (const session of dirSessions) {
      if (deleteSessionById(session.id)) {
        ok++;
        const wtMappings = getWorktreeMappings();
        if (wtMappings[session.name]) {
          removeWorktree(session.name);
          removeWorktreeMapping(session.name);
        }
      } else fail++;
    }
    s.stop("Done: " + ok + " deleted, " + fail + " failed");
    return true;
  }

  // 2) Select individually via multiselect
  const sessionOptions = dirSessions.map(function(s) {
    const h = formatSessionHint(s);
    return { label: h.name, value: s.id, hint: h.hint };
  });

  if (sessionOptions.length === 0) {
    log.info(pc.dim("No sessions to delete."));
    return false;
  }

  const selectedIDs = await multiselect({
    message: "Select sessions to delete (Space to toggle, Enter to confirm):",
    options: sessionOptions,
    required: false,
  });

  if (isCancel(selectedIDs) || !selectedIDs || selectedIDs.length === 0) return false;

  const s = spinner();
  s.start("Deleting " + selectedIDs.length + " session(s)...");
  let ok = 0, fail = 0;
  for (const id of selectedIDs as string[]) {
    if (deleteSessionById(id)) {
      ok++;
      const session = _allSessions.find((s) => s.id === id);
      const sessionName = session?.name ?? id;
      const wtMappings = getWorktreeMappings();
      if (wtMappings[sessionName]) {
        removeWorktree(sessionName);
        removeWorktreeMapping(sessionName);
      }
    } else fail++;
  }
  s.stop("Done: " + ok + " deleted, " + fail + " failed");
  return true;
}

// ─── Session Set Wizard ──────────────────────────────────────────────────────

/** Interactive wizard to create a new session set */
export async function createSessionSetWizard(): Promise<string | null> {
  log.step(pc.cyan("⚙️  Create a session set"));
  log.info(pc.dim("Session sets bundle a system prompt with builtin extensions, always launched via `goose session`."));

  // ── Step 1: Name (slug) ────────────────────────────────────────────────
  const name = await text({
    message: "Set name (used as unique identifier):",
    placeholder: "e.g., code-review, my-stack",
    validate: (val) => {
      if (!val || val.trim().length === 0) return "Name cannot be empty";
      if (!/^[a-zA-Z0-9_-]+$/.test(val.trim())) return "Use only letters, numbers, hyphens, underscores";
      const existing = listSessionSets();
      if (existing[val.trim()]) return `Set "${val.trim()}" already exists`;
      return;
    },
  });
  if (isCancel(name)) return null;
  const setName = (name as string).trim();

  // ── Step 2: Title ──────────────────────────────────────────────────────
  const title = await text({
    message: "Display title:",
    placeholder: "e.g., Code Review, My Stack",
    validate: (val) => (!val || val.trim().length === 0 ? "Title cannot be empty" : undefined),
  });
  if (isCancel(title)) return null;

  // ── Step 3: Description ─────────────────────────────────────────────────
  const desc = await text({
    message: "Short description:",
    placeholder: "e.g., Custom extensions and hints for reviewing code",
    defaultValue: "",
  });
  if (isCancel(desc)) return null;

  // ── Step 4: System prompt (will be passed via --system flag) ──────────
  log.info(pc.dim("This text is passed as additional system instructions via the --system flag."));
  const systemPrompt = await text({
    message: "System prompt text:",
    placeholder: "e.g., You are a senior code reviewer. Be thorough.",
    defaultValue: "",
  });
  if (isCancel(systemPrompt)) return null;

  // ── Step 5: Builtin extensions ─────────────────────────────────────────
  const KNOWN_BUILTINS: { value: string; label: string; hint: string }[] = [
    { value: "developer", label: "Developer", hint: "Shell commands, file read/write" },
    { value: "analyze", label: "Analyze", hint: "Code structure analysis (tree-sitter)" },
    { value: "memory", label: "Memory", hint: "Session memory persistence" },
    { value: "summon", label: "Summon", hint: "Subagent delegation, knowledge loading" },
    { value: "todo", label: "Todo", hint: "Task tracking within sessions" },
    { value: "tom", label: "Top Of Mind", hint: "Custom context injection per turn" },
    { value: "skills", label: "Skills", hint: "Skill instructions from filesystem/builtins" },
    { value: "chatrecall", label: "Chat Recall", hint: "Search past sessions" },
    { value: "summarize", label: "Summarize", hint: "File/directory LLM summarization" },
    { value: "apps", label: "Apps", hint: "HTML/CSS/JS sandboxed apps" },
    { value: "autovisualiser", label: "Auto Visualiser", hint: "Auto-visualisation" },
    { value: "computercontroller", label: "Computer Controller", hint: "Desktop control" },
    { value: "tutorial", label: "Tutorial", hint: "Guided tutorial mode" },
  ];

  const extNames = await multiselect({
    message: "Builtin extensions to enable:",
    options: KNOWN_BUILTINS,
    required: false,
    initialValues: ["developer"],
  });
  if (isCancel(extNames)) return null;

  const builtins = (extNames as string[]).filter(Boolean);

  // ── Step 5.5: Extensions already configured in Goose (config.yaml) ──────
  // Sets are launched with --no-profile, so config.yaml extensions (like
  // `fetch`) are not loaded unless they are referenced here by name.
  const gooseExtensions = listGooseExtensions();
  let chosenExtensions: string[] = [];
  if (gooseExtensions.length > 0) {
    log.info(pc.dim("These come from ~/.config/goose/config.yaml (sets run with --no-profile, so nothing else is loaded)."));
    const extChoice = await multiselect({
      message: "Goose-configured extensions to enable:",
      options: gooseExtensions.map((e) => ({
        value: e.key,
        label: e.key,
        hint: `${e.type}${e.enabled ? "" : " · disabled in config"}${e.description ? ` — ${e.description}` : ""}`,
      })),
      required: false,
      initialValues: [],
    });
    if (isCancel(extChoice)) return null;
    chosenExtensions = (extChoice as string[]).filter(Boolean);
  }

  // ── Step 6: Stdio extensions (optional) ────────────────────────────────
  log.info(pc.dim("Stdio extensions are passed via --with-extension (e.g. 'mcpls --trust-project-config')." +
    "\nLeave empty to skip."));
  const stdioExt = await text({
    message: "Stdio extensions (comma-separated, optional):",
    placeholder: "mcpls --trust-project-config, npx -y @some/mcp-server",
    defaultValue: "",
  });
  if (isCancel(stdioExt)) return null;

  const stdioExtensions = (stdioExt as string)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // ── Save ────────────────────────────────────────────────────────────────
  const set: SessionSet = {
    name: setName,
    title: (title as string),
    description: (desc as string) || undefined,
    systemPrompt: (systemPrompt as string) || "",
    builtins,
    extensions: chosenExtensions.length > 0 ? chosenExtensions : undefined,
    stdioExtensions: stdioExtensions.length > 0 ? stdioExtensions : undefined,
  };

  saveSessionSet(set);
  log.success(pc.green(`✓ Session set "${set.title}" created!`));

  return setName;
}

/** Manage existing session sets: edit or delete */
export async function manageSessionSets(): Promise<void> {
  const allSets = listSessionSets();
  const keys = Object.keys(allSets);
  if (keys.length === 0) {
    log.info(pc.dim("No session sets defined."));
    return;
  }

  const action = await select({
    message: "Manage session sets:",
    options: [
      { value: "delete", label: "Delete a set" },
      { value: "back", label: "← Go back" },
    ],
  });
  if (isCancel(action) || action === "back") return;

  if (action === "delete") {
    const setOptions = keys.map((k) => ({
      label: allSets[k].title,
      value: k,
      hint: allSets[k].description || allSets[k].systemPrompt.slice(0, 60),
    }));

    const toDelete = await select({
      message: "Select a set to delete:",
      options: setOptions,
    });
    if (isCancel(toDelete) || !toDelete) return;

    const confirmed = await confirm({
      message: `Delete set "${allSets[toDelete as string].title}"?`,
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) return;

    if (deleteSessionSet(toDelete as string)) {
      log.success(pc.green(`✓ Set deleted`));
    }
  }
}
