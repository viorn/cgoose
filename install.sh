#!/usr/bin/env bash
#
# install.sh — Install cgoose locally (requires bun)
#
# Installs cgoose for the current user:
#   ~/.local/share/cgoose/   — source code + dependencies
#   ~/.local/bin/cgoose      — launcher script (runs via bun)
#
# Make sure ~/.local/bin is in your PATH:
#   export PATH="$HOME/.local/bin:$PATH"
#
# Requires: bun (https://bun.sh)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${HOME}/.local/share/cgoose"
BIN_DIR="${HOME}/.local/bin"
LAUNCHER="${BIN_DIR}/cgoose"

echo "==> Installing cgoose to ${INSTALL_DIR}"

# Create directories
mkdir -p "${INSTALL_DIR}"
mkdir -p "${BIN_DIR}"

# Copy source code
cp -r "${SCRIPT_DIR}/src" "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/"

# Install dependencies
echo "==> Installing dependencies..."
cd "${INSTALL_DIR}"
bun install --frozen-lockfile 2>/dev/null || bun install

# Create launcher script
cat > "${LAUNCHER}" << LAUNCHER
#!/usr/bin/env bash
exec bun "${INSTALL_DIR}/src/index.ts" "\$@"
LAUNCHER

chmod +x "${LAUNCHER}"

echo ""
echo "  ✓ Installed!"
echo "    Source:  ${INSTALL_DIR}"
echo "    Binary:  ${LAUNCHER}"
echo ""
echo "  Make sure ${BIN_DIR} is in your PATH:"
echo "    export PATH=\"\${HOME}/.local/bin:\$PATH\""
echo ""
echo "  Then run: cgoose"