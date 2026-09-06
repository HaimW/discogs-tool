#!/usr/bin/env bash
# Compare both detectors on specific audio files.
#
#   ./oracle/check.sh track.m4a [more...]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
VENV="$HERE/.venv"
WORK="${ORACLE_WORK:-$HERE/work}"
[ -x "$VENV/bin/python" ] || { echo "run ./oracle/setup.sh first" >&2; exit 1; }
[ $# -gt 0 ] || { echo "usage: check.sh <audio files...>" >&2; exit 2; }

source "$HOME/.cargo/env" 2>/dev/null || true
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
mkdir -p "$WORK/wav"

# Decode through the analyzer's own decoder, so both detectors see identical
# samples and any difference between them is the algorithm, not the decoder.
wavs=()
for f in "$@"; do
  stem="$(basename "${f%.*}")"
  wav="$WORK/wav/$stem.wav"
  [ -f "$wav" ] || (cd "$ROOT" && cargo run --release -q -p analyzer-analysis --example to_wav -- "$f" "$wav" >/dev/null)
  wavs+=("$wav")
done

(cd "$ROOT" && cargo run --release -q -p analyzer-analysis --example batch_json -- "${wavs[@]}") > "$WORK/ours.jsonl"
"$VENV/bin/python" "$HERE/oracle.py" "${wavs[@]}" > "$WORK/beatthis.jsonl"
"$VENV/bin/python" "$HERE/compare.py" "$WORK/ours.jsonl" "$WORK/beatthis.jsonl" --detail
