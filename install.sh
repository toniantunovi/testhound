#!/bin/sh
# TestHound installer: downloads the latest GitHub release for this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/toniantunovi/testhound/main/install.sh | sh
#
# macOS: installs TestHound.app into /Applications (or ~/Applications when
# /Applications is not writable) and clears the quarantine flag, since release
# builds are not notarized yet and Gatekeeper would otherwise report a
# browser-style download as "damaged".
# Linux: installs the AppImage as ~/.local/bin/testhound.
# Windows: not covered here; download the installer from the releases page.
set -eu

REPO="toniantunovi/testhound"
LATEST="https://github.com/$REPO/releases/latest/download"
API="https://api.github.com/repos/$REPO/releases/latest"

fail() {
    echo "error: $1" >&2
    exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"

os=$(uname -s)
arch=$(uname -m)

case "$os" in
Darwin)
    case "$arch" in
    arm64) bundle="TestHound_aarch64.app.tar.gz" ;;
    x86_64) bundle="TestHound_x64.app.tar.gz" ;;
    *) fail "unsupported macOS architecture: $arch" ;;
    esac

    dest="${TESTHOUND_INSTALL_DIR:-/Applications}"
    [ -w "$dest" ] || dest="$HOME/Applications"
    mkdir -p "$dest"

    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT

    echo "Downloading $bundle ..."
    curl -fL --progress-bar "$LATEST/$bundle" -o "$tmp/app.tar.gz"
    rm -rf "$dest/TestHound.app"
    tar -xzf "$tmp/app.tar.gz" -C "$dest"
    xattr -cr "$dest/TestHound.app" 2>/dev/null || true

    echo "Installed $dest/TestHound.app"
    ;;
Linux)
    [ "$arch" = "x86_64" ] ||
        fail "unsupported Linux architecture: $arch (only x86_64 builds are published)"

    url=$(curl -fsSL "$API" |
        grep -o '"browser_download_url": *"[^"]*_amd64\.AppImage"' |
        head -n 1 | sed 's/.*"\(https[^"]*\)"$/\1/')
    [ -n "$url" ] || fail "could not find an AppImage in the latest release"

    dest="$HOME/.local/bin"
    mkdir -p "$dest"

    echo "Downloading ${url##*/} ..."
    curl -fL --progress-bar "$url" -o "$dest/testhound"
    chmod +x "$dest/testhound"

    echo "Installed $dest/testhound"
    case ":$PATH:" in
    *":$dest:"*) ;;
    *) echo "note: $dest is not on your PATH; add it to run 'testhound'" ;;
    esac
    ;;
*)
    fail "unsupported OS: $os (on Windows, download the installer from https://github.com/$REPO/releases/latest)"
    ;;
esac
