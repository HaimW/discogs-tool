"""Diff the Rust pipeline's answers against the oracle's.

    compare.py ours.jsonl beatthis.jsonl [--detail] [--tracks tracks.jsonl]

Disagreements are classified by their musical ratio rather than by how many BPM
apart they are, because those are different failures: 3% apart is a precision
difference, 2:1 is a disagreement about which pulse to count.
"""
import json
import statistics
import sys
from collections import Counter

# How close two figures must be to count as the same ratio. Wide enough to
# absorb the ~1% the two detectors normally differ by.
RATIO_TOLERANCE = 0.04

RATIOS = [
    ("1:1", 1.0), ("2:1", 2.0), ("1:2", 0.5), ("3:2", 1.5), ("2:3", 2 / 3),
    ("4:3", 4 / 3), ("3:4", 0.75), ("4:1", 4.0), ("1:4", 0.25),
    ("3:1", 3.0), ("1:3", 1 / 3),
]


def load(path):
    out = {}
    for line in open(path):
        line = line.strip()
        if line.startswith("{"):
            d = json.loads(line)
            out[d["file"]] = d
    return out


def ratio_label(ours, theirs):
    if ours <= 0 or theirs <= 0:
        return "?"
    r = theirs / ours
    for name, value in RATIOS:
        if abs(r / value - 1.0) <= RATIO_TOLERANCE:
            return name
    return "other"


def main(argv):
    detail = "--detail" in argv
    args = [a for a in argv if not a.startswith("--")]
    titles = {}
    if "--tracks" in argv:
        path = argv[argv.index("--tracks") + 1]
        titles = {t["yt"]: t.get("title", "") for t in (json.loads(l) for l in open(path))}

    ours, theirs = load(args[0]), load(args[1])
    common = [k for k in ours if k in theirs
              and "error" not in ours[k] and "error" not in theirs[k]]
    if not common:
        print("nothing to compare")
        return
    print(f"compared: {len(common)} tracks (ours {len(ours)}, oracle {len(theirs)})\n")

    buckets, close, disagree = Counter(), [], []
    for k in common:
        a, b = ours[k]["bpm"], theirs[k]["bpm_median"]
        label = ratio_label(a, b)
        buckets[label] += 1
        (close if label == "1:1" else disagree).append(
            abs(a - b) / a * 100 if label == "1:1" else (k, a, b, label))

    print("AGREEMENT ON THE METRICAL LEVEL")
    for label, n in buckets.most_common():
        print(f"  {label:<6} {n:>4}  ({100 * n / len(common):>5.1f}%)")

    if close:
        close.sort()
        print(f"\nWHERE THEY AGREE ON THE LEVEL ({len(close)} tracks), how far apart:")
        print(f"  median {statistics.median(close):.2f}%   "
              f"p90 {close[int(len(close) * 0.9)]:.2f}%   max {close[-1]:.2f}%")

    print("\nDOES OUR CONFIDENCE PREDICT DISAGREEMENT?")
    for lo, hi in [(0.0, 0.4), (0.4, 0.7), (0.7, 0.9), (0.9, 1.01)]:
        grp = [k for k in common if lo <= ours[k]["bpm_confidence"] < hi]
        if grp:
            bad = sum(1 for k in grp
                      if ratio_label(ours[k]["bpm"], theirs[k]["bpm_median"]) != "1:1")
            print(f"  confidence {lo:.1f}-{hi:.1f}: {len(grp):>3} tracks, "
                  f"{bad:>3} disagree ({100 * bad / len(grp):.0f}%)")

    print("\nDOES THE ORACLE'S OWN COHERENCE PREDICT IT? (gap CV; low = steady)")
    for lo, hi in [(0.0, 0.1), (0.1, 0.3), (0.3, 1.0), (1.0, 99.0)]:
        grp = [k for k in common if lo <= theirs[k].get("gap_cv", 9) < hi]
        if grp:
            bad = sum(1 for k in grp
                      if ratio_label(ours[k]["bpm"], theirs[k]["bpm_median"]) != "1:1")
            print(f"  gap CV {lo:.1f}-{hi:.1f}: {len(grp):>3} tracks, "
                  f"{bad:>3} disagree ({100 * bad / len(grp):.0f}%)")

    if disagree:
        print(f"\nDISAGREEMENTS ({len(disagree)}), worst first:")
        disagree.sort(key=lambda d: -abs(d[2] / d[1] - 1))
        for k, a, b, label in disagree[: (len(disagree) if detail else 25)]:
            o, t = ours[k], theirs[k]
            print(f"  {a:>7.2f} vs {b:>7.2f}  {label:<6} conf {o['bpm_confidence']:.2f} "
                  f"{o['method']:<20} cv {t.get('gap_cv', 0):.2f} "
                  f"b/bar {t.get('beats_per_bar')} | {titles.get(k, k)[:40]}")

    print("\nOUR METHOD DISTRIBUTION")
    for method, n in Counter(ours[k]["method"] for k in common).most_common():
        bad = sum(1 for k in common if ours[k]["method"] == method
                  and ratio_label(ours[k]["bpm"], theirs[k]["bpm_median"]) != "1:1")
        print(f"  {method:<22} {n:>4}   disagreeing with the oracle: {bad}")


if __name__ == "__main__":
    main(sys.argv[1:])
