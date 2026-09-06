# Vendored native sources

The analyzer links these into itself rather than against whatever the machine
happens to have installed.

## Why

The Debian build of aubio links ffmpeg, libsndfile, libsamplerate, mpg123,
FLAC, vorbis, opus and ogg. None of that is used — audio is decoded in-process
by symphonia — but it all became a runtime dependency anyway, so the binary ran
on the machine that built it and nowhere else. `ldd` listed twenty shared
libraries.

Compiled from source with none of those backends, aubio needs only libc and
libm: its own ooura FFT is enough for the tempo path. That is the difference
between a tool you can send someone and a tool you cannot.

## What is here

`aubio/` — headers, plus the C sources for the tempo path only (the top level
and `tempo/`, `onset/`, `spectral/`, `temporal/`, `utils/`). The I/O, pitch,
notes, synth and effects trees are deliberately absent: they are what dragged
in the codecs.

Version and upstream commit are recorded in `aubio/AUBIO_VERSION`. aubio is
GPL-3.0, which the workspace already is.

libkeyfinder and FFTW are not vendored — they are built from pinned upstream
tarballs by `scripts/build-native.sh`, because FFTW's build is large and its
own configure script does the platform detection far better than we would.
