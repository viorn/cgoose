#!/usr/bin/env bash
#
# build.sh — Compile cgoose into a standalone binary for GitHub Releases
#
# Produces a named binary: cgoose-<version>-<os>-<arch>
# e.g. cgoose-1.0.0-linux-x86_64
#
# Requires: bun (https://bun.sh)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Read version from package.json
VERSION="$(grep '"version"' package.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
OS="linux"
ARCH="x86_64"
OUTFILE="cgoose-${VERSION}-${OS}-${ARCH}"

echo "==> Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install

echo "==> Compiling ${OUTFILE}..."
bun build --compile src/index.ts --outfile "${OUTFILE}"

echo ""
echo "  ✓ Done! ./${OUTFILE} is ready"
printf "  %s\n" "$(file "${OUTFILE}" | sed 's/.*://')"
printf "  Size: %s\n" "$(du -h "${OUTFILE}" | cut -f1)"
echo ""
echo "  Run: ./${OUTFILE}"
echo "  For GitHub: upload ${OUTFILE} to a release"