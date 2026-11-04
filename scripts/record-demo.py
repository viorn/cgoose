#!/usr/bin/env python3
"""Record the rossii chat demo as a cast, then convert it to a GIF with agg.

Why not a screen recorder: the chat lives on the alternate screen and repaints
whole frames, so a plain `script` capture is unusable. Instead this drives a
real rossii inside tmux, takes `capture-pane -e` snapshots after each action and
writes them into an asciinema v2 `.cast` file (a full repaint per frame), which
`agg` turns into a GIF.

The demo never sends a prompt to the model unless `--prompt` is passed, so it
costs no tokens: it only opens the configuration dialogs, switches a session set
and browses a fetched model list.

Usage:
  python3 scripts/record-demo.py --out chat.gif [--duration 1.6] [--agg /tmp/agg]
  python3 scripts/record-demo.py --prompt        # include a real exchange
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT = 120, 34
# Fixed path on purpose: it shows up in the chat header, and a random suffix
# would end up in the GIF.
WORKDIR = Path("/tmp/rossii-demo")
SESSION = "rossii-demo"
SET_A = "zz-demo-a"
SET_B = "zz-demo-b"


def sh(*args: str, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, **kwargs)


def tmux(*args: str) -> str:
    return sh("tmux", *args).stdout


def pane() -> str:
    return tmux("capture-pane", "-p", "-t", SESSION)


TOKENS = re.compile(r"tokens\s+(\d+)/")


def turn_running(text: str) -> bool:
    return "thinking" in text or "cancelling" in text


def wait_for_turn(timeout: float = 300.0) -> None:
    """Block until the turn that was just sent has finished.

    Typing into a busy turn is useless (the editor is disabled), which is what
    made the first recordings miss every dialog. Three conditions, checked on the
    pane itself, because any one of them alone races:

    * the loader (`thinking` / `cancelling`) is gone — it can lag behind the
      prompt by a few seconds, so its absence alone would return too early;
    * the footer counts tokens (`tokens 1954/256000`) — before the turn it reads
      `0`, so this is what proves an answer actually arrived;
    * two identical captures in a row — the pane has stopped streaming.
    """
    deadline = time.time() + timeout
    last = None
    stable = 0
    while time.time() < deadline:
        text = pane()
        match = TOKENS.search(text)
        done = match is not None and int(match.group(1)) > 0 and not turn_running(text)
        stable = stable + 1 if done and text == last else 0
        if stable >= 2:
            return
        last = text
        time.sleep(1.2)
    raise TimeoutError("the turn did not finish in time")


def send(text: str) -> None:
    if text in {"Enter", "Escape", "Down", "Up", "C-c", "C-p", "C-o", "C-e"}:
        tmux("send-keys", "-t", SESSION, text)
    else:
        tmux("send-keys", "-t", SESSION, "-l", text)


class Cast:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.t = 0.0

    def frame(self, delay: float) -> None:
        """Snapshot the pane now; it becomes visible after `delay` seconds."""
        screen = tmux("capture-pane", "-p", "-e", "-t", SESSION)
        # Full repaint: home the cursor, clear, print every row but the last.
        lines = screen.rstrip("\n").split("\n")
        lines = (lines + [""] * HEIGHT)[:HEIGHT]
        payload = "\x1b[H\x1b[2J" + "\r\n".join(lines)
        self.events.append(json.dumps([round(self.t, 3), "o", payload]))
        self.t += delay

    def write(self, path: Path) -> None:
        header = {
            "version": 2,
            "width": WIDTH,
            "height": HEIGHT,
            "timestamp": int(time.time()),
            "env": {"SHELL": "/bin/bash", "TERM": "xterm-256color"},
        }
        path.write_text("\n".join([json.dumps(header), *self.events]) + "\n")


def prepare_sets() -> None:
    sets = Path.home() / ".config" / "rossii" / "sets"
    sets.mkdir(parents=True, exist_ok=True)
    (sets / f"{SET_A}.yaml").write_text(
        "name: %s\ntitle: Demo Set A\nsystemPrompt: \"You are demo set A.\"\nbuiltins: [developer]\n" % SET_A
    )
    (sets / f"{SET_B}.yaml").write_text(
        "name: %s\ntitle: Demo Set B\nsystemPrompt: \"You are demo set B.\"\nbuiltins: [developer, analyze, summon]\n"
        % SET_B
    )


def cleanup_sets() -> None:
    for name in (SET_A, SET_B):
        (Path.home() / ".config" / "rossii" / "sets" / f"{name}.yaml").unlink(missing_ok=True)


# The set picker lists everything in ~/.config/rossii/sets, and the GIF is
# published — so the user's own sets are moved aside for the recording and put
# back afterwards (including on failure).
STASH = Path("/tmp/rossii-demo-sets-stash")


def stash_other_sets() -> None:
    STASH.mkdir(parents=True, exist_ok=True)
    for path in (Path.home() / ".config" / "rossii" / "sets").iterdir():
        if path.suffix in {".yaml", ".yml", ".json"}:
            shutil.move(str(path), str(STASH / path.name))


def restore_other_sets() -> None:
    if not STASH.exists():
        return
    sets = Path.home() / ".config" / "rossii" / "sets"
    for path in STASH.iterdir():
        shutil.move(str(path), str(sets / path.name))
    shutil.rmtree(STASH, ignore_errors=True)


def cleanup_session(workdir: Path) -> None:
    """The demo session is real (it has to be — `rossii a` resumes it)."""
    db = Path.home() / ".local/share/goose/sessions/sessions.db"
    if shutil.which("sqlite3") and db.exists():
        sh("sqlite3", str(db),
           f"delete from messages where session_id in (select id from sessions where working_dir='{workdir}');"
           f"delete from sessions where working_dir='{workdir}';")
    for meta in (Path.home() / ".config/rossii/projects").glob(f"{workdir.name}-*.json"):
        meta.unlink(missing_ok=True)


def create_session(workdir: Path) -> None:
    """Create one session in the demo directory (the wizard, no model calls)."""
    tmux("new-session", "-d", "-s", SESSION, "-x", str(WIDTH), "-y", str(HEIGHT),
         f"cd {workdir} && ROSSII_NO_WORKTREE=1 bun {REPO / 'src/index.ts'}")
    time.sleep(3)
    send("Enter")  # create new session
    time.sleep(2.5)
    send("Enter")  # auto name
    time.sleep(2.5)
    send("Demo Set A")
    time.sleep(1.5)
    send("Enter")
    time.sleep(2.5)
    send("Enter")  # provider
    time.sleep(2.5)
    send("Enter")  # model
    time.sleep(2.5)
    send("Enter")  # launch
    time.sleep(10)
    send("C-c")  # leave the chat
    time.sleep(1.5)
    tmux("kill-session", "-t", SESSION)


def record(workdir: Path, duration: float, prompt: bool) -> Cast:
    cast = Cast()
    tmux("new-session", "-d", "-s", SESSION, "-x", str(WIDTH), "-y", str(HEIGHT),
         f"cd {workdir} && ROSSII_NO_WORKTREE=1 bun {REPO / 'src/index.ts'} a")
    time.sleep(9)  # agent spawn + session load
    cast.frame(duration)

    if prompt:
        send("In one sentence: what is a terminal user interface?")
        time.sleep(1.0)
        send("Enter")
        wait_for_turn()
        time.sleep(1.5)
        cast.frame(duration)

    send("/config")
    time.sleep(1.0)
    send("Enter")
    time.sleep(1.6)
    cast.frame(duration)

    send("Down")
    send("Down")
    time.sleep(0.6)
    send("Enter")  # Change Set
    time.sleep(1.6)
    cast.frame(duration)

    # Leave the menu again: the actual switch goes through the command form, which
    # is deterministic no matter which sets the user has.
    send("Escape")
    time.sleep(1.0)

    send(f"/set {SET_B}")
    time.sleep(1.2)
    send("Enter")
    time.sleep(4.0)
    cast.frame(duration)

    send("/model")
    time.sleep(1.0)
    send("Enter")
    time.sleep(1.6)
    cast.frame(duration)

    send("Down")
    send("Down")
    time.sleep(0.5)
    send("Enter")  # Fetch models from API
    time.sleep(4.0)
    cast.frame(duration)

    send("claude-sonnet")
    time.sleep(1.8)
    cast.frame(duration)

    send("Escape")
    time.sleep(1.2)
    send("/session")
    time.sleep(1.0)
    send("Enter")
    time.sleep(1.8)
    cast.frame(duration)

    send("Escape")
    time.sleep(1.6)
    cast.frame(duration)
    tmux("kill-session", "-t", SESSION)
    return cast


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="chat.gif")
    parser.add_argument("--agg", default=shutil.which("agg") or "/tmp/agg")
    parser.add_argument("--duration", type=float, default=1.6, help="seconds each frame stays")
    parser.add_argument("--prompt", action="store_true", help="include one real model exchange (spends tokens)")
    parser.add_argument("--keep-cast", metavar="PATH", help="also keep the intermediate .cast file")
    args = parser.parse_args()

    if not Path(args.agg).exists():
        print("agg not found: download it from https://github.com/asciinema/agg/releases", file=sys.stderr)
        return 1
    if sh("tmux", "has-session", "-t", SESSION).returncode == 0:
        tmux("kill-session", "-t", SESSION)

    workdir = WORKDIR
    shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True, exist_ok=True)
    restore_other_sets()  # in case a previous run died before its cleanup
    stash_other_sets()
    prepare_sets()
    try:
        create_session(workdir)
        cast = record(workdir, args.duration, args.prompt)
        cast_path = workdir / "demo.cast"
        cast.write(cast_path)
        out = (REPO / args.out).resolve() if not os.path.isabs(args.out) else Path(args.out)
        # `--text-font-family`, not `--font-family`: the latter disables agg's
        # emoji fallback, and the header starts with 🪿.
        sh(args.agg, "--text-font-family", "DejaVu Sans Mono", "--font-size", "14",
           "--theme", "asciinema", "--last-frame-duration", "2", "--speed", "1.3",
           str(cast_path), str(out))
        print(f"wrote {out}")
        if args.keep_cast:
            shutil.copy(cast_path, args.keep_cast)
            print(f"kept {args.keep_cast}")
        cast_path.unlink(missing_ok=True)
    finally:
        sh("tmux", "kill-session", "-t", SESSION)
        cleanup_session(workdir)
        cleanup_sets()
        restore_other_sets()
        shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
