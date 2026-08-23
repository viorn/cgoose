#!/usr/bin/env bash
#
# build.sh — Compile cgoose into a standalone binary
#
# Produces a single executable at ./cgoose that requires no runtime
# dependencies (no Bun, no Node.js). Use for distribution to users
# who don't have Bun installed, or for deployment.
#
# Requires: bun (https://bun.sh)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install

echo "==> Compiling cgoose..."
bun build --compile src/index.ts --outfile cgoose

echo ""
echo "  ✓ Done! ./cgoose is ready"
printf "  %s\n" "$(file cgoose | sed 's/.*://')"
printf "  Size: %s\n" "$(du -h cgoose | cut -f1)"
echo ""
echo "  Run: ./cgoose"