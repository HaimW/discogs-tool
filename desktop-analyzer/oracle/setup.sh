#!/usr/bin/env bash
# Build the oracle's virtualenv. Safe to re-run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"

if [ ! -d "$VENV" ]; then
  echo "creating $VENV"
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
echo "installing PyTorch (this is the slow part)"
"$VENV/bin/pip" install --quiet torch
echo "installing Beat This!"
"$VENV/bin/pip" install --quiet beat-this tqdm einops soxr rotary-embedding-torch
"$VENV/bin/python" - <<'PY'
import torch
print(f"torch {torch.__version__}, CUDA {'available' if torch.cuda.is_available() else 'NOT available (CPU only)'}")
PY
echo "ready"
