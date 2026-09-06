"""Beat This! over a corpus, one JSON line per file.

Reports the median-gap tempo, a linear fit through the beat positions (more
precise, the same trick the Rust grid fit uses), how regular the gaps were, and
how many beats the model put in a bar. The last two are what say whether the
tempo figure is worth anything: a tracker that has not locked reports beats
whose spacing wanders and whose bars are not four beats long.
"""
import sys, json, wave

import numpy as np
from beat_this.inference import Audio2Beats


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype("float64") / 32768.0, sr


def main(paths):
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device: {device}, {len(paths)} files", file=sys.stderr)
    a2b = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)

    for i, path in enumerate(paths, 1):
        stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        try:
            sig, sr = read_wav(path)
            beats, downbeats = a2b(sig, sr)
            b = np.asarray(beats, dtype=float)
            if len(b) < 16:
                print(json.dumps({"file": stem, "error": "too few beats"}), flush=True)
                continue
            g = np.diff(b)
            med = float(np.median(g))
            slope = float(np.polyfit(np.arange(len(b)), b, 1)[0])
            d = np.asarray(downbeats, dtype=float)
            bpb = float(np.median(np.diff(d)) / med) if len(d) > 3 else None
            print(json.dumps({
                "file": stem,
                "bpm_median": round(60.0 / med, 2),
                "bpm_fit": round(60.0 / slope, 2) if slope > 0 else None,
                "gap_cv": round(float(g.std() / g.mean()), 3),
                "agreement": round(float(np.mean(np.abs(g - med) / med <= 0.10)), 3),
                "beats_per_bar": round(bpb, 2) if bpb else None,
                "beats": len(b),
            }), flush=True)
        except Exception as e:
            print(json.dumps({"file": stem, "error": str(e)[:120]}), flush=True)
        if i % 25 == 0:
            print(f"  {i}/{len(paths)}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
