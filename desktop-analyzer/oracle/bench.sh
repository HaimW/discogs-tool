#!/usr/bin/env bash
# Full comparison over a sample of the collection.
#
#   ./oracle/bench.sh backup.json [count]
#
# Downloads dominate. Re-running skips anything already fetched.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
VENV="$HERE/.venv"
WORK="${ORACLE_WORK:-$HERE/work}"
BACKUP="${1:?usage: bench.sh <backup.json> [count]}"
COUNT="${2:-200}"

[ -x "$VENV/bin/python" ] || { echo "run ./oracle/setup.sh first" >&2; exit 1; }
source "$HOME/.cargo/env" 2>/dev/null || true
export PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
mkdir -p "$WORK/wav"

# A fixed seed, so re-running compares the same tracks and a change in the
# numbers means a change in the detectors rather than a change of sample.
python3 - "$BACKUP" "$COUNT" "$WORK" <<'PY'
import json, random, sys
backup, count, work = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = json.load(open(backup))
c = d["collection"]
releases = {r["id"]: r for r in c["releases"]}
cands = []
for v in c["videos"]:
    r = releases.get(v.get("release_id"))
    dur = v.get("duration")
    if not r or not dur or not (120 <= dur <= 600):
        continue
    cands.append({"yt": v["youtube_id"], "title": v.get("title", ""),
                  "genres": r.get("genres") or "", "styles": r.get("styles") or ""})
random.seed(20260906)
random.shuffle(cands)
sel = cands[:count]
with open(f"{work}/tracks.jsonl", "w") as f:
    for t in sel:
        f.write(json.dumps(t) + "\n")
json.dump({t["yt"]: {"genres": t["genres"], "styles": t["styles"]} for t in sel},
          open(f"{work}/hints.json", "w"))
print(f"sampled {len(sel)} of {len(cands)} eligible tracks")
PY

echo "fetching (skipping what is already here)"
n=0; ok=0; fail=0
while IFS= read -r line; do
  n=$((n + 1))
  yt=$(printf '%s' "$line" | python3 -c "import sys,json; print(json.load(sys.stdin)['yt'])")
  wav="$WORK/wav/$yt.wav"
  if [ -f "$wav" ]; then ok=$((ok + 1)); continue; fi
  src="$WORK/wav/$yt.src"
  if "$ROOT/binaries/yt-dlp" -q --no-warnings \
        -f 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best' \
        -o "$src" "https://www.youtube.com/watch?v=$yt" >/dev/null 2>&1 \
     && (cd "$ROOT" && cargo run --release -q -p analyzer-analysis --example to_wav -- "$src" "$wav" >/dev/null 2>&1); then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
  fi
  rm -f "$src"
  [ $((n % 20)) -eq 0 ] && echo "  $n fetched ($ok ok, $fail unavailable)"
done < "$WORK/tracks.jsonl"
echo "  $ok decoded, $fail unavailable"

echo "running the analyzer"
(cd "$ROOT" && cargo run --release -q -p analyzer-analysis --example batch_json -- \
   --hints "$WORK/hints.json" "$WORK"/wav/*.wav) > "$WORK/ours.jsonl"

echo "running the oracle"
"$VENV/bin/python" "$HERE/oracle.py" "$WORK"/wav/*.wav > "$WORK/beatthis.jsonl"

echo
"$VENV/bin/python" "$HERE/compare.py" "$WORK/ours.jsonl" "$WORK/beatthis.jsonl" \
  --tracks "$WORK/tracks.jsonl"
