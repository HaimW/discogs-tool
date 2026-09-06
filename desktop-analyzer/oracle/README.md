# The oracle

A **development tool**, not part of the analyzer. It runs [Beat This!][bt] — a
transformer beat tracker from ISMIR 2024 — over a sample of your collection and
diffs its answers against the Rust pipeline's.

It exists because tempo detection has no ground truth to test against. Two
independent detectors disagreeing tells you where to look; one detector telling
you 120 tells you nothing. Everything the analyzer does about octaves,
cross-checking and flagging was decided from numbers this produced.

## This is why the Python here is not a contradiction

`PROJECT_PLAN.md` §3b specifies pure Rust with no Python, so a friend can run
the analyzer without installing anything. That still holds: **nothing in this
directory ships**. It runs on your machine, when you are changing the
detectors, and the analyzer neither imports nor invokes it.

Beat This! is MIT-licensed, so nothing here affects the analyzer's GPL-3.0
position either.

## Setup, once

    ./oracle/setup.sh

Makes a virtualenv under `oracle/.venv` and installs PyTorch and Beat This!
(~3 GB). Model weights download themselves on first use. A CUDA GPU is used if
PyTorch finds one and it falls back to CPU otherwise — 191 tracks took 37
seconds on an RTX 5090.

## Checking a few tracks

    ./oracle/check.sh path/to/track.m4a [more...]

Decodes each file through the analyzer's own decoder, runs both detectors over
the identical samples, and prints them side by side. Use this when you disagree
with a number.

## The full comparison

    ./oracle/bench.sh backup.json [how-many]

Samples that many tracks from a backup (default 200), downloads and decodes
them, runs both pipelines, and reports how often they agree. Downloads dominate:
budget about 15 minutes for 200 tracks, then under 5 for the analysis.

Audio and results go to `oracle/work/` (gitignored). It skips anything already
downloaded, so a second run costs only the analysis.

## Reading the output

`AGREEMENT ON THE METRICAL LEVEL` is the number that matters. `1:1` means both
detectors chose the same pulse; `2:1` and the rest mean they disagreed about
*which* pulse to count, which is usually a property of the music rather than a
bug.

Then two questions worth more than the headline:

- **Does our confidence predict disagreement?** It should. Last measured: 5%
  disagreement above 0.9 confidence, 72% below 0.4.
- **Does Beat This!'s own coherence predict it?** Where its beat gaps are
  erratic (`gap CV` above 0.3) it is often the one that is wrong, not us.

[bt]: https://github.com/CPJKU/beat_this
