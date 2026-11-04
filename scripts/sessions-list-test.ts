#!/usr/bin/env bun
/**
 * Regression tests for session listing (src/sessions.ts).
 *
 * The bug this pins: cgoose listed sessions via `goose session list`, which
 * reports `user` + `scheduled` only, so every `goose acp` session was invisible
 * — to the picker, to auto-resume and to the delete menu. Listing now reads
 * `sessions.db` (types `user`/`scheduled`/`acp`, goose's own ordering by last
 * user-visible message) with the CLI as a fallback.
 *
 * Runs against a throwaway `$HOME` in child processes, so the developer's real
 * `sessions.db` is never touched. Skips (exit 0) when sqlite3 is missing.
 *
 * Usage: bun run test   (or `bun scripts/sessions-list-test.ts`)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS_MODULE = resolve(HERE, "../src/sessions.ts");

try {
  execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
} catch {
  console.log("⚠ sqlite3 not available — session listing tests skipped");
  process.exit(0);
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

/** The columns goose creates that the listing touches (plus `description`). */
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  provider_name TEXT,
  model_config_json TEXT,
  recipe_json TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  metadata_json TEXT
);
CREATE TABLE usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
);
`;

interface FixtureRow {
  id: string;
  type: string;
  name: string;
  description?: string;
  provider?: string | null;
  model?: string | null;
  created: string;
  updated: string;
  /** [created_timestamp, metadata_json] — sort key is the max timestamp. */
  messages?: Array<[number, string | null]>;
  recipe?: string;
}

// Timestamps: goose stores seconds, but some paths write milliseconds — the
// listing normalizes both (>1e10 ⇒ /1000) and falls back to `updated_at`.
const FIXTURE: FixtureRow[] = [
  // Newest by message timestamp (1_800_000_000, given in ms), one of its two
  // messages is not user-visible and must not be counted.
  { id: "acp_newest", type: "acp", name: "ACP session", created: "2026-01-01 08:00:00",
    updated: "2026-01-01 08:30:00", provider: null, model: '{not json',
    messages: [[1_800_000_000_000, null], [1_799_000_000_000, '{"userVisible":false}']] },
  // No messages: sorted by `updated_at`, and the name comes from `description`.
  { id: "user_middle", type: "user", name: "", description: "From description",
    created: "2023-11-14 22:13:20", updated: "2023-11-14 22:13:20",
    provider: "custom_x", model: '{"model_name":"m-1"}', recipe: '{"instructions":"do the thing"}' },
  // Oldest (1_600_000_000 seconds).
  { id: "scheduled_oldest", type: "scheduled", name: "Nightly", created: "2020-09-13 12:00:00",
    updated: "2020-09-13 12:26:40", messages: [[1_600_000_000, '{"userVisible":true}']] },
  // Every other type must stay out of the picker, however recent it is.
  { id: "terminal_junk", type: "terminal", name: "Goose Term Session", created: "2026-11-04 12:00:00",
    updated: "2026-11-04 12:00:00", messages: [[2_000_000_000_000, null]] },
  { id: "hidden_x", type: "hidden", name: "Hidden", created: "2026-11-04 12:00:00", updated: "2026-11-04 12:00:00" },
  { id: "subagent_x", type: "sub_agent", name: "Sub agent", created: "2026-11-04 12:00:00", updated: "2026-11-04 12:00:00" },
  { id: "gateway_x", type: "gateway", name: "Gateway", created: "2026-11-04 12:00:00", updated: "2026-11-04 12:00:00" },
];

const EXPECTED_ORDER = ["acp_newest", "user_middle", "scheduled_oldest"];

const quote = (value: string | null): string =>
  value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;

function fixtureSql(): string {
  const sessions = FIXTURE.map((s) => `INSERT INTO sessions
    (id, name, description, session_type, working_dir, created_at, updated_at,
     provider_name, model_config_json, recipe_json)
    VALUES ('${s.id}', ${quote(s.name)}, ${quote(s.description ?? "")}, '${s.type}', '/repo',
            '${s.created}', '${s.updated}', ${quote(s.provider ?? null)},
            ${quote(s.model ?? null)}, ${quote(s.recipe ?? null)});`).join("\n");
  const messages = FIXTURE.flatMap((s) => (s.messages ?? []).map(([ts, meta]) =>
    `INSERT INTO messages (session_id, role, content_json, created_timestamp, metadata_json)
     VALUES ('${s.id}', 'user', '{}', ${ts}, ${quote(meta)});`)).join("\n");
  return [SCHEMA, sessions, messages].join("\n");
}

/** Temp `$HOME` with a db (or not) plus a `goose` shim for the CLI fallback. */
function makeHome(opts: { db?: "fixture" | "broken" } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "cgoose-sessions-home-"));
  if (opts.db) {
    const dbDir = join(home, ".local/share/goose/sessions");
    mkdirSync(dbDir, { recursive: true });
    const db = join(dbDir, "sessions.db");
    if (opts.db === "fixture") execFileSync("sqlite3", [db], { input: fixtureSql(), encoding: "utf-8" });
    else writeFileSync(db, "this is not a sqlite database");
  }

  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const payload = JSON.stringify([{
    id: "cli_1", name: "From CLI", working_dir: "/repo", provider_name: "p",
    model_config: { model_name: "m" }, created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z", message_count: 1,
  }]);
  const shim = join(binDir, "goose");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s' '${payload}'\n`);
  chmodSync(shim, 0o755);
  return home;
}

/**
 * Runs the module in a child process: it resolves the db path at import time
 * (and honours `GOOSE_PATH_ROOT`), so a fresh process is the only honest way.
 */
function runChild(
  home: string,
  mode: "list" | "delete" | "recipe" | "hint",
  env: Record<string, string> = {},
): unknown {
  const script = join(home, "child.ts");
  if (!existsSync(script)) {
    writeFileSync(script, `
const mode = process.argv[2];
const sessions = await import(${JSON.stringify(SESSIONS_MODULE)});
if (mode === "list") {
  console.log(JSON.stringify(sessions.getAllSessions()));
} else if (mode === "delete") {
  console.log(JSON.stringify({
    ok: sessions.deleteSessionById("user_middle"),
    remaining: sessions.getAllSessions().map((s) => s.id),
  }));
} else if (mode === "hint") {
  console.log(JSON.stringify(sessions.getAllSessions().map(sessions.formatSessionHint)));
} else {
  console.log(JSON.stringify(sessions.getSessionRecipeInstructions("user_middle")));
}
`);
  }
  const out = execFileSync("bun", [script, mode], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}`, ...env },
  });
  return JSON.parse(out.trim().split("\n").pop() as string);
}

// ─── Checks ──────────────────────────────────────────────────────────────────

type Check = [name: string, run: () => void];
const checks: Check[] = [];
const tracked: string[] = [];

const fixtureHome = makeHome({ db: "fixture" });
tracked.push(fixtureHome);
const listed = runChild(fixtureHome, "list") as Array<Record<string, any>>;
const byId = (id: string) => listed.find((s) => s.id === id)!;

checks.push(["lists user + scheduled + acp, in goose's order, and nothing else", () => {
  assert.deepEqual(listed.map((s) => s.id), EXPECTED_ORDER,
    "ACP sessions must be listed; terminal/hidden/sub_agent/gateway must not");
}]);

checks.push(["orders by last message timestamp, falling back to updated_at", () => {
  // acp_newest has the newest *message*; user_middle has none and rides on
  // `updated_at`; scheduled_oldest is oldest either way.
  assert.equal(byId("acp_newest").session_type, "acp");
  assert.equal(byId("user_middle").session_type, "user");
  assert.equal(listed[2].id, "scheduled_oldest");
}]);

checks.push(["message_count counts only user-visible messages", () => {
  assert.equal(byId("acp_newest").message_count, 1, "userVisible:false must not be counted");
  assert.equal(byId("scheduled_oldest").message_count, 1);
  assert.equal(byId("user_middle").message_count, 0, "a session without messages must still be listed");
}]);

checks.push(["timestamps are RFC3339 UTC, names fall back to description", () => {
  assert.equal(byId("user_middle").updated_at, "2023-11-14T22:13:20Z");
  assert.equal(new Date(byId("user_middle").updated_at).toISOString(), "2023-11-14T22:13:20.000Z");
  assert.equal(byId("user_middle").name, "From description");
  assert.equal(byId("acp_newest").name, "ACP session");
}]);

checks.push(["model_config is parsed, junk config does not hide a session", () => {
  assert.deepEqual(byId("user_middle").model_config, { model_name: "m-1" });
  assert.equal(byId("acp_newest").model_config, null);
  assert.equal(byId("acp_newest").provider_name, null);
  assert.equal(byId("user_middle").provider_name, "custom_x");
  assert.equal(byId("user_middle").working_dir, "/repo");
}]);

checks.push(["non-user sessions get a type badge in the picker hint", () => {
  const hints = runChild(fixtureHome, "hint") as Array<{ name: string; hint: string }>;
  const acp = hints.find((h) => h.name === "ACP session")!;
  assert.match(acp.hint, /^\[acp\] /, "an ACP session must be labelled as such");
  const user = hints.find((h) => h.name === "From description")!;
  assert.doesNotMatch(user.hint, /^\[/, "a user session needs no badge");
}]);

checks.push(["recipe instructions are still readable", () => {
  assert.equal(runChild(fixtureHome, "recipe"), "do the thing");
}]);

checks.push(["missing db falls back to `goose session list`, creating no db", () => {
  const home = makeHome();
  tracked.push(home);
  const fromCli = runChild(home, "list") as Array<Record<string, any>>;
  assert.deepEqual(fromCli.map((s) => s.id), ["cli_1"], "the CLI fallback must be used, not a crash");
  assert.equal(
    existsSync(join(home, ".local/share/goose/sessions/sessions.db")),
    false,
    "an empty db must not be created just by listing",
  );
}]);

checks.push(["an unreadable db falls back instead of throwing", () => {
  const home = makeHome({ db: "broken" });
  tracked.push(home);
  const fromCli = runChild(home, "list") as Array<Record<string, any>>;
  assert.deepEqual(fromCli.map((s) => s.id), ["cli_1"]);
}]);

checks.push(["GOOSE_PATH_ROOT moves the data dir", () => {
  const root = mkdtempSync(join(tmpdir(), "cgoose-goose-root-"));
  tracked.push(root);
  const dataDir = join(root, "data/sessions");
  mkdirSync(dataDir, { recursive: true });
  execFileSync("sqlite3", [join(dataDir, "sessions.db")], { input: fixtureSql(), encoding: "utf-8" });
  // HOME points at a throwaway without a db: only GOOSE_PATH_ROOT can supply one.
  const home = makeHome();
  tracked.push(home);
  const fromRoot = runChild(home, "list", { GOOSE_PATH_ROOT: root }) as Array<Record<string, any>>;
  assert.deepEqual(fromRoot.map((s) => s.id), EXPECTED_ORDER);
}]);

checks.push(["deleteSessionById removes the session and its messages", () => {
  const home = makeHome({ db: "fixture" });
  tracked.push(home);
  const result = runChild(home, "delete") as { ok: boolean; remaining: string[] };
  assert.equal(result.ok, true);
  assert.deepEqual(result.remaining, ["acp_newest", "scheduled_oldest"]);
  const left = execFileSync("sqlite3", [
    join(home, ".local/share/goose/sessions/sessions.db"),
    "SELECT COUNT(*) FROM messages WHERE session_id = 'user_middle';",
  ], { encoding: "utf-8" }).trim();
  assert.equal(left, "0", "messages of a deleted session must go too");
}]);

// ─── Runner ──────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, run] of checks) {
  try {
    run();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(error);
  }
}

for (const dir of tracked) rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n❌ ${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\n✅ ${checks.length} checks passed`);
