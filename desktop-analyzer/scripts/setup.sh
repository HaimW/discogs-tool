#!/usr/bin/env bash
# Build the analyzer from a fresh Ubuntu (including WSL on Windows) in one go.
#
# Safe to re-run: every step checks whether it is already done and skips it.
# Asks for your password once, for the system packages.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

step() { printf '\n==> %s\n' "$*"; }

# 1. Compilers and tools. libclang is for bindgen; the rest builds FFTW,
#    libkeyfinder and the vendored aubio.
PACKAGES=(build-essential cmake git curl pkg-config libclang-dev)
missing=()
for p in "${PACKAGES[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done
if [ ${#missing[@]} -gt 0 ]; then
  step "Installing system packages: ${missing[*]}"
  sudo apt-get update
  sudo apt-get install -y "${missing[@]}"
else
  step "System packages already installed"
fi

# 2. Rust.
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  step "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
else
  step "Rust already installed ($(cargo --version))"
fi

# 3. Static FFTW and libkeyfinder. Skips itself when native/ is already built.
step "Building native libraries (first time takes a few minutes)"
"$HERE/build-native.sh"

# 4. The analyzer.
step "Building the analyzer"
cargo build --release

# 5. yt-dlp, where the analyzer looks for it. Always refetched: an old copy is
#    the usual reason downloads start failing.
step "Fetching the latest yt-dlp"
mkdir -p binaries
curl -fL --progress-bar -o binaries/yt-dlp \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod +x binaries/yt-dlp
echo "yt-dlp $(binaries/yt-dlp --version)"

cat <<EOF

All set. Start the analyzer with:

    cd $ROOT
    ./target/release/discogs-analyzer --ui

then open http://127.0.0.1:8733 in your browser (Chrome on Windows works too).
Leave that window running while you use it; Ctrl-C stops it.
EOF
