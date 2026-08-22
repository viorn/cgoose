#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "📦 Installing dependencies..."
bun install

echo "🔨 Compiling cgoose..."
bun build ./index.ts --compile --outfile cgoose

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"
cp -f cgoose "$INSTALL_DIR/cgoose"

echo "✅ Installed to ${INSTALL_DIR}/cgoose"
echo "   Make sure ${INSTALL_DIR} is in your PATH"