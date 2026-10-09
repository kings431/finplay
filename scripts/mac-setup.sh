#!/usr/bin/env bash
# Bootstrap Finplay for local macOS development (Apple Silicon or Intel).
# Run from the repo root: ./scripts/mac-setup.sh
# Optional: ./scripts/mac-setup.sh --run   # also start `npm run desktop`
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN=0
for arg in "$@"; do
  case "$arg" in
    --run|-r) RUN=1 ;;
    -h|--help)
      echo "Usage: $0 [--run]"
      echo "  Bundles libmpv into src-tauri/libmpv, installs npm deps, checks Rust."
      echo "  --run  starts the desktop app after setup."
      exit 0
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only (current OS: $(uname -s))." >&2
  exit 1
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    echo "Install Xcode CLT, Homebrew, Node 22+, and Rust (rustup), then retry." >&2
    exit 1
  fi
}

need brew
need node
need npm
need cargo
need rustc

echo "==> Node $(node -v) · npm $(npm -v) · Rust $(rustc --version)"

echo "==> Homebrew: mpv, molten-vk, dylibbundler"
brew list mpv >/dev/null 2>&1 || brew install mpv
brew list molten-vk >/dev/null 2>&1 || brew install molten-vk
brew list dylibbundler >/dev/null 2>&1 || brew install dylibbundler

DEST="$ROOT/src-tauri/libmpv"
echo "==> Bundling libmpv → $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$(brew --prefix mpv)/lib/libmpv.2.dylib" "$DEST/"
chmod u+w "$DEST/libmpv.2.dylib"
install_name_tool -id @loader_path/libmpv.2.dylib "$DEST/libmpv.2.dylib"
cp "$(brew --prefix molten-vk)/lib/libMoltenVK.dylib" "$DEST/"
chmod u+w "$DEST/libMoltenVK.dylib"
install_name_tool -id @loader_path/libMoltenVK.dylib "$DEST/libMoltenVK.dylib"
sed -E 's#"library_path"[^,]*#"library_path": "./libMoltenVK.dylib"#' \
  "$(brew --prefix molten-vk)/etc/vulkan/icd.d/MoltenVK_icd.json" > "$DEST/MoltenVK_icd.json"
dylibbundler -of -b \
  -x "$DEST/libmpv.2.dylib" \
  -x "$DEST/libMoltenVK.dylib" \
  -d "$DEST" \
  -p @loader_path/ \
  -s "$(brew --prefix)/lib"
chmod u+w "$DEST"/*.dylib
# dylibbundler can add @loader_path/ twice; recent dyld refuses to load that.
for lib in "$DEST"/*.dylib; do
  while [[ "$(otool -l "$lib" | grep -A2 LC_RPATH | grep -c '@loader_path/ ')" -gt 1 ]]; do
    install_name_tool -delete_rpath @loader_path/ "$lib"
  done
done
codesign --force --sign - "$DEST"/*.dylib
test -f "$DEST/libmpv.2.dylib"
echo "    libmpv ready ($(du -sh "$DEST" | awk '{print $1}'))"

# Optional: yt-dlp so YouTube trailers can play in mpv instead of the embed window.
if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "==> Optional: brew install yt-dlp  (trailers in mpv; without it Finplay embeds YouTube)"
fi

echo "==> npm ci"
npm ci

echo "==> Typecheck / Vite build"
npm run build

echo "==> cargo check (src-tauri)"
cargo check --manifest-path src-tauri/Cargo.toml

echo
echo "Setup OK. Current version: $(node -p "require('./package.json').version")"
echo "Read HANDOFF.md for the Mac test checklist."
echo "Start the app with:  npm run desktop"

if [[ "$RUN" -eq 1 ]]; then
  echo "==> Starting desktop…"
  exec npm run desktop
fi
