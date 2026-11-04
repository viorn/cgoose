#!/usr/bin/env python3
"""Minimal MCP stdio server for cgoose/goose live tests.

goose 1.57 starts the handshake with `server/discover` (MCP draft 2026-07-28)
and only falls back to `initialize` for older peers. A server that answers
`server/discover` with `{}` makes goose report
`process quit before initialization: stderr = ...`, so both paths are handled
here. One tool: `echo`.

Usage (as a session-set stdio spec):
  stdioExtensions:
    - "echo-mcp:/usr/bin/python3 /path/to/mcp-echo.py"
"""

import json
import sys

SERVER_INFO = {"name": "echo-mcp", "version": "0.1.0"}
TOOLS = [
    {
        "name": "echo",
        "description": "Echo the given text back",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    }
]


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = message.get("method")
        if method is None:
            continue  # a response to a server request we never send
        rid = message.get("id")
        if method == "server/discover":
            send({
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "resultType": "complete",
                    "supportedVersions": ["2026-07-28", "2025-11-25"],
                    "capabilities": {"tools": {}},
                    "ttlMs": 0,
                    "cacheScope": "public",
                    "_meta": {"io.modelcontextprotocol/serverInfo": SERVER_INFO},
                },
            })
        elif method == "initialize":
            send({
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "protocolVersion": message.get("params", {}).get("protocolVersion", "2025-11-25"),
                    "capabilities": {"tools": {}},
                    "serverInfo": SERVER_INFO,
                },
            })
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            text = (message.get("params", {}).get("arguments") or {}).get("text", "")
            send({
                "jsonrpc": "2.0",
                "id": rid,
                "result": {"content": [{"type": "text", "text": text}]},
            })
        elif method.startswith("notifications/"):
            continue
        elif rid is not None:
            send({"jsonrpc": "2.0", "id": rid, "result": {}})


if __name__ == "__main__":
    main()
