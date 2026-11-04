#!/usr/bin/env python3
"""Drive a terminal TUI (cgoose, goose, any curses app) inside tmux.

Why tmux and not a raw pty: pi-tui repaints the whole screen, so raw pty output
is a soup of escape sequences. `tmux capture-pane` gives the visible screen.

Usage:
  tmux-drive.py start  [--name N] [--cwd DIR] [--cmd CMD] [--width W] [--height H]
  tmux-drive.py wait   [--name N] --pattern REGEX [--timeout SEC]
  tmux-drive.py send   [--name N] KEY [KEY ...]
  tmux-drive.py type   [--name N] TEXT          # literal text (no key names)
  tmux-drive.py capture [--name N] [--lines N]
  tmux-drive.py kill   [--name N]

`send` accepts tmux key names (Enter, Escape, Space, Tab, Down, Up, C-c, …) and
sends anything else as literal text.

Typical session:
  tmux-drive.py start --cwd /tmp/probe --cmd 'CGOOSE_NO_WORKTREE=1 bun /path/src/index.ts'
  tmux-drive.py wait --pattern 'Session set'
  tmux-drive.py type probe          # filter the list instead of counting arrows
  tmux-drive.py send Enter
  sleep 2                           # let the next prompt mount before Enter
  tmux-drive.py capture
  tmux-drive.py kill
"""

import argparse
import os
import re
import subprocess
import sys
import time

DEFAULT_NAME = "cgoose-test"
KEY_NAMES = {
    "Enter", "Escape", "Esc", "Space", "Tab", "BTab", "BSpace", "Up", "Down",
    "Left", "Right", "Home", "End", "PPage", "NPage", "DC", "C-c", "C-d",
    "C-z", "C-l", "C-u", "C-a", "C-e", "C-r", "C-g",
}


def tmux(*args: str, check: bool = True) -> str:
    proc = subprocess.run(["tmux", *args], capture_output=True, text=True)
    if check and proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise SystemExit(proc.returncode)
    return proc.stdout


def session_alive(name: str) -> bool:
    return subprocess.run(
        ["tmux", "has-session", "-t", name], capture_output=True
    ).returncode == 0


def cmd_start(args) -> None:
    if session_alive(args.name):
        tmux("kill-session", "-t", args.name)
    tmux(
        "new-session", "-d", "-s", args.name,
        "-x", str(args.width), "-y", str(args.height),
        "-c", args.cwd, args.cmd,
    )


def cmd_send(args) -> None:
    for key in args.keys:
        if key in KEY_NAMES:
            tmux("send-keys", "-t", args.name, key)
        else:
            tmux("send-keys", "-t", args.name, "-l", key)


def cmd_type(args) -> None:
    tmux("send-keys", "-t", args.name, "-l", args.text)


def cmd_capture(args) -> None:
    out = tmux("capture-pane", "-p", "-t", args.name)
    lines = out.rstrip("\n").split("\n")
    if args.lines:
        lines = lines[: args.lines]
    # Trim the blank tail pi-tui leaves below its layout.
    while lines and lines[-1].strip() == "":
        lines.pop()
    print("\n".join(lines))


def cmd_wait(args) -> None:
    deadline = time.time() + args.timeout
    pattern = re.compile(args.pattern)
    while time.time() < deadline:
        screen = tmux("capture-pane", "-p", "-t", args.name, check=False)
        if pattern.search(screen):
            return
        time.sleep(0.3)
    sys.stderr.write(f"timeout: {args.pattern!r} not on screen after {args.timeout}s\n")
    sys.stderr.write(tmux("capture-pane", "-p", "-t", args.name, check=False))
    raise SystemExit(1)


def cmd_kill(args) -> None:
    tmux("kill-session", "-t", args.name, check=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start")
    start.add_argument("--name", default=DEFAULT_NAME)
    start.add_argument("--cwd", default=os.getcwd())
    start.add_argument("--cmd", default="bun src/index.ts")
    start.add_argument("--width", type=int, default=140)
    start.add_argument("--height", type=int, default=45)
    start.set_defaults(func=cmd_start)

    send = sub.add_parser("send")
    send.add_argument("--name", default=DEFAULT_NAME)
    send.add_argument("keys", nargs="+")
    send.set_defaults(func=cmd_send)

    typ = sub.add_parser("type")
    typ.add_argument("--name", default=DEFAULT_NAME)
    typ.add_argument("text")
    typ.set_defaults(func=cmd_type)

    cap = sub.add_parser("capture")
    cap.add_argument("--name", default=DEFAULT_NAME)
    cap.add_argument("--lines", type=int, default=0)
    cap.set_defaults(func=cmd_capture)

    wait = sub.add_parser("wait")
    wait.add_argument("--name", default=DEFAULT_NAME)
    wait.add_argument("--pattern", required=True)
    wait.add_argument("--timeout", type=float, default=15.0)
    wait.set_defaults(func=cmd_wait)

    kill = sub.add_parser("kill")
    kill.add_argument("--name", default=DEFAULT_NAME)
    kill.set_defaults(func=cmd_kill)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
