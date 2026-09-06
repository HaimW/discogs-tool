#!/usr/bin/env bash
# Build the two native libraries the analyzer links, as static archives.
#
# Everything lands in `native/` (gitignored). Run once; `cargo build` finds it
# afterwards. Re-run only to change versions.
#
# aubio is not here: its sources are vendored and compiled by the crate's own
# build script. FFTW and libkeyfinder are built from pinned upstream tarballs
# instead, because FFTW's configure does platform detection far better than we
# would and libkeyfinder is a normal CMake project.
set -euo pipefail

FFTW_VERSION=3.3.10
KEYFINDER_TAG=v2.2.6

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PREFIX="${NATIVE_PREFIX:-$ROOT/native}"
BUILD="$PREFIX/build"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

mkdir -p "$BUILD"

if [ ! -f "$PREFIX/lib/libfftw3.a" ]; then
  echo "building FFTW $FFTW_VERSION"
  cd "$BUILD"
  [ -f "fftw-$FFTW_VERSION.tar.gz" ] ||
    curl -fsSL -o "fftw-$FFTW_VERSION.tar.gz" "https://www.fftw.org/fftw-$FFTW_VERSION.tar.gz"
  rm -rf "fftw-$FFTW_VERSION"
  tar xzf "fftw-$FFTW_VERSION.tar.gz"
  cd "fftw-$FFTW_VERSION"
  # Position-independent so it can be linked into our binary on every platform.
  ./configure --prefix="$PREFIX" --enable-static --disable-shared \
    --disable-fortran --disable-doc --with-pic > /dev/null
  make -j"$JOBS" > /dev/null
  make install > /dev/null
else
  echo "FFTW already built"
fi

if [ ! -f "$PREFIX/lib/libkeyfinder.a" ]; then
  echo "building libkeyfinder $KEYFINDER_TAG"
  cd "$BUILD"
  [ -d libkeyfinder ] ||
    git clone --depth 1 --branch "$KEYFINDER_TAG" https://github.com/mixxxdj/libkeyfinder.git
  cd libkeyfinder
  cmake -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_PREFIX_PATH="$PREFIX" \
        -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
        -DCMAKE_POSITION_INDEPENDENT_CODE=ON -S . -B build > /dev/null
  cmake --build build -j"$JOBS" > /dev/null
  cmake --install build > /dev/null
else
  echo "libkeyfinder already built"
fi

echo
echo "static libraries in $PREFIX/lib:"
ls -1 "$PREFIX"/lib/*.a 2>/dev/null | sed 's/^/  /'
echo
echo "now run: cargo build --release"
