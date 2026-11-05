#!/bin/sh
#
# install-release.sh — install the latest rossii release (prebuilt binary)
#
#   curl -fsSL https://raw.githubusercontent.com/viorn/rossii/main/install-release.sh | sh
#
# Resolves the newest GitHub release, downloads the `rossii-<version>-<os>-<arch>`
# asset (falls back to the pre-3.0 `cgoose-…` naming for old tags), verifies its
# SHA-256 when the release publishes one, and drops the binary into ~/.local/bin.
#
# Options:
#   -v, --version <tag>   install a specific release (default: latest, e.g. v3.4.0)
#   -d, --dir <path>      install into <path>            (default: ~/.local/bin)
#       --no-checksum     skip SHA-256 verification
#   -h, --help            show this help
#
# Environment:
#   ROSSII_VERSION        same as --version
#   ROSSII_INSTALL_DIR    same as --dir
#   ROSSII_REPO           GitHub repo to install from (default: viorn/rossii)
#   ROSSII_OS, ROSSII_ARCH   override platform detection (mostly for testing)
#
# Requirements: curl (or wget). sha256sum is used when available. No Bun, no jq.

set -eu

REPO="${ROSSII_REPO:-viorn/rossii}"
INSTALL_DIR="${ROSSII_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${ROSSII_VERSION:-}"
CHECKSUM=1
BIN_NAME="rossii"

# ─── output helpers ──────────────────────────────────────────────────────────

say()  { printf '%s\n' "$*"; }
info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  # kept as a heredoc on purpose: with `curl | sh` the script is stdin, not $0
  cat <<'EOF'
install-release.sh — install the latest rossii release (prebuilt binary)

  curl -fsSL https://raw.githubusercontent.com/viorn/rossii/main/install-release.sh | sh

Resolves the newest GitHub release, downloads the rossii-<version>-<os>-<arch>
asset (pre-3.0 tags used the cgoose-… name), verifies its SHA-256 when the
release publishes one, and installs the binary.

Options:
  -v, --version <tag>   install a specific release (default: latest, e.g. v3.4.0)
  -d, --dir <path>      install into <path>            (default: ~/.local/bin)
      --no-checksum     skip SHA-256 verification
  -h, --help            show this help

Environment:
  ROSSII_VERSION        same as --version
  ROSSII_INSTALL_DIR    same as --dir
  ROSSII_REPO           GitHub repo to install from (default: viorn/rossii)
  ROSSII_OS, ROSSII_ARCH   override platform detection (mostly for testing)

Requirements: curl (or wget); sha256sum is used when available. No Bun, no jq.
EOF
}

# ─── arguments ───────────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    -v|--version)
      [ $# -ge 2 ] || die "$1 needs a value"
      VERSION="$2"; shift 2 ;;
    -d|--dir)
      [ $# -ge 2 ] || die "$1 needs a value"
      INSTALL_DIR="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dir=*)     INSTALL_DIR="${1#*=}"; shift ;;
    --no-checksum) CHECKSUM=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ─── platform ────────────────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo darwin ;;
    *) echo unknown ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x86_64 ;;
    arm64|aarch64) echo aarch64 ;;
    *) echo unknown ;;
  esac
}

OS="${ROSSII_OS:-$(detect_os)}"
ARCH="${ROSSII_ARCH:-$(detect_arch)}"

if [ "$OS" != "linux" ]; then
  die "no $OS build is published (releases carry linux-x86_64 only) — build from source instead:
       git clone https://github.com/$REPO && cd rossii && bash build.sh"
fi

if [ "$ARCH" = "unknown" ]; then
  die "unsupported architecture: $(uname -m)"
fi

# ─── fetching ────────────────────────────────────────────────────────────────

have() { command -v "$1" >/dev/null 2>&1; }

# fetch <url> <file> — download, non-zero on HTTP failure
fetch() {
  if have curl; then
    curl -fsSL "$1" -o "$2"
  elif have wget; then
    wget -qO "$2" "$1"
  else
    die "neither curl nor wget is available"
  fi
}

# fetch_stdout <url> — download to stdout
fetch_stdout() {
  if have curl; then
    curl -fsSL "$1"
  elif have wget; then
    wget -qO- "$1"
  else
    die "neither curl nor wget is available"
  fi
}

# asset_exists <url> — silent HEAD probe, so probing never prints 404 noise
asset_exists() {
  if have curl; then
    curl -fsSIL -o /dev/null "$1" >/dev/null 2>&1
  else
    wget -q --spider "$1" >/dev/null 2>&1
  fi
}

have curl || have wget || die "neither curl nor wget is available"

# ─── which release ───────────────────────────────────────────────────────────

if [ -n "$VERSION" ]; then
  TAG="$VERSION"
  case "$TAG" in v*) ;; *) TAG="v$TAG" ;; esac
else
  info "looking up the latest release of $REPO"
  TAG=""
  if have curl; then
    # the /releases/latest redirect ends at /releases/tag/<tag>
    TAG="$(curl -fsSIL -o /dev/null -w '%{url_effective}' \
      "https://github.com/$REPO/releases/latest" 2>/dev/null | sed 's|.*/tag/||')"
  fi
  if [ -z "$TAG" ]; then
    TAG="$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  fi
  case "$TAG" in
    ""|*/*) die "could not determine the latest release — pass --version <tag>" ;;
  esac
fi

VER="${TAG#v}"
URL_BASE="https://github.com/$REPO/releases/download/$TAG"
info "release $TAG (${OS}-${ARCH})"

# ─── download the binary ─────────────────────────────────────────────────────

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

# `rossii-…` since 3.0.0, `cgoose-…` for the older tags
ASSET=""
for candidate in "$BIN_NAME-$VER-$OS-$ARCH" "cgoose-$VER-$OS-$ARCH"; do
  if asset_exists "$URL_BASE/$candidate"; then
    ASSET="$candidate"
    break
  fi
done

[ -n "$ASSET" ] || die "release $TAG has no asset for $OS-$ARCH (looked for $BIN_NAME-$VER-$OS-$ARCH)"

info "downloading $ASSET"
fetch "$URL_BASE/$ASSET" "$TMP/$ASSET" || die "download failed: $URL_BASE/$ASSET"
[ -s "$TMP/$ASSET" ] || die "downloaded file is empty"

# ─── checksum ────────────────────────────────────────────────────────────────

expected=""

if [ "$CHECKSUM" = 1 ]; then
  # 1) a published <asset>.sha256, if the release carries one
  if fetch "$URL_BASE/$ASSET.sha256" "$TMP/asset.sha256" 2>/dev/null; then
    expected="$(awk 'NF { print $1; exit }' "$TMP/asset.sha256")"
  fi
  # 2) the digest GitHub reports for the asset (in the API JSON `name` comes
  #    before `digest`, so isolate the asset object first, then read the digest)
  if [ -z "$expected" ]; then
    if fetch_stdout "https://api.github.com/repos/$REPO/releases/tags/$TAG" > "$TMP/release.json" 2>/dev/null; then
      expected="$(tr -d '\n' < "$TMP/release.json" \
        | sed 's/},{/}\n{/g' \
        | grep -E "\"name\"[[:space:]]*:[[:space:]]*\"$ASSET\"" \
        | sed -n 's/.*"digest"[[:space:]]*:[[:space:]]*"sha256:\([0-9a-f]\{64\}\)".*/\1/p' \
        | head -n 1 || true)"
    fi
  fi
fi

if have sha256sum; then
  actual="$(sha256sum "$TMP/$ASSET" | awk '{ print $1 }')"
  if [ -n "$expected" ]; then
    [ "$actual" = "$expected" ] || die "SHA-256 mismatch for $ASSET
       expected $expected
       actual   $actual"
    info "sha256 ok ($actual)"
  else
    warn "no published checksum for $ASSET — installed without verification"
    warn "sha256 of the downloaded file: $actual"
  fi
elif [ -n "$expected" ]; then
  warn "sha256sum not available — cannot verify the download"
fi

# ─── install ─────────────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
target="$INSTALL_DIR/$BIN_NAME"

if have install; then
  install -m 755 "$TMP/$ASSET" "$target"
else
  cp "$TMP/$ASSET" "$target"
  chmod 755 "$target"
fi

say ""
say "  ✓ rossii $VER installed"
say "    binary: $target"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "  $INSTALL_DIR is not in your PATH, add it:"
    say "    export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

say ""
say "  Run:  $BIN_NAME"
