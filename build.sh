#!/usr/bin/env bash
#
# build.sh — Compile rossii into a standalone binary for GitHub Releases
#
# Produces a named binary: rossii-<version>-<os>-<arch>
# e.g. rossii-1.0.0-linux-x86_64
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
OUTFILE="rossii-${VERSION}-${OS}-${ARCH}"

echo "==> Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install

echo "==> Compiling ${OUTFILE}..."
bun build --compile src/index.ts --outfile "${OUTFILE}"

# A published <asset>.sha256 is what install-release.sh prefers over the digest
# GitHub reports, and it is what a user verifies by hand; write it next to the
# binary in the `sha256sum` format so `sha256sum -c` works as well.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${OUTFILE}" > "${OUTFILE}.sha256"
fi

echo ""
echo "  ✓ Done! ./${OUTFILE} is ready"
printf "  %s\n" "$(file "${OUTFILE}" | sed 's/.*://')"
printf "  Size: %s\n" "$(du -h "${OUTFILE}" | cut -f1)"
[ -f "${OUTFILE}.sha256" ] && printf "  %s\n" "$(cat "${OUTFILE}.sha256")"
echo ""
echo "  Run: ./${OUTFILE}"
echo "  For GitHub: upload ${OUTFILE}$([ -f "${OUTFILE}.sha256" ] && echo " and ${OUTFILE}.sha256") to a release"
