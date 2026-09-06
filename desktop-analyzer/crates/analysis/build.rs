//! Compiles the native pieces the analyzer links, and generates aubio's
//! bindings.
//!
//! Everything here exists to make the resulting binary self-contained. The
//! distribution-packaged aubio drags in ffmpeg, libsndfile, libsamplerate,
//! mpg123 and four codec libraries — none of which are used, because audio is
//! decoded in-process by symphonia — and every one of them becomes a runtime
//! dependency. A binary built that way runs on the machine that built it and
//! nowhere else, which is fatal for a tool whose whole point is being handed to
//! a friend.
//!
//! So aubio is compiled here from vendored sources with none of those backends,
//! using its own ooura FFT, and libkeyfinder and FFTW are linked as static
//! archives built by `scripts/build-native.sh`.
//!
//! Set `NATIVE_PREFIX` to point at those archives if they are not in
//! `desktop-analyzer/native`.

use std::env;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=shim/keyfinder_shim.cpp");
    println!("cargo:rerun-if-changed=../../vendor/aubio");
    println!("cargo:rerun-if-env-changed=NATIVE_PREFIX");

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("set by cargo"));
    let workspace = manifest
        .ancestors()
        .nth(2)
        .expect("crates/analysis sits two levels below the workspace root")
        .to_path_buf();
    let aubio_src = workspace.join("vendor/aubio");
    let prefix = env::var("NATIVE_PREFIX")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace.join("native"));

    // Both, so a half-finished build-native.sh fails here with an explanation
    // rather than later as `cannot find -lfftw3`.
    for archive in ["lib/libkeyfinder.a", "lib/libfftw3.a"] {
        if !prefix.join(archive).exists() {
            panic!(
                "{} not found under {}.\n\
                 Run desktop-analyzer/scripts/build-native.sh first, or set NATIVE_PREFIX.",
                archive,
                prefix.display()
            );
        }
    }

    build_aubio(&aubio_src);
    generate_aubio_bindings(&aubio_src);
    build_keyfinder_shim(&prefix);

    // Static archives, so nothing has to be installed on the machine that runs
    // the binary. Order matters to the linker: keyfinder before the FFTW it
    // calls into.
    println!("cargo:rustc-link-search=native={}", prefix.join("lib").display());
    println!("cargo:rustc-link-lib=static=keyfinder");
    println!("cargo:rustc-link-lib=static=fftw3");
    // libkeyfinder is C++, so its standard library has to come along. This is
    // the one system library we still take dynamically: it is present wherever
    // there is a C++ program, which is everywhere.
    if cfg!(target_os = "macos") {
        println!("cargo:rustc-link-lib=c++");
    } else {
        println!("cargo:rustc-link-lib=stdc++");
    }
}

/// Compile aubio's tempo path into a static archive of our own.
fn build_aubio(src: &Path) {
    let mut build = cc::Build::new();
    build
        .include(src)
        .include(src.join(".."))
        // aubio's sources include "aubio_priv.h", which wants a config header.
        // Ours declares only what the tempo path touches: no codecs, no I/O.
        .define("HAVE_STDLIB_H", "1")
        .define("HAVE_STDIO_H", "1")
        .define("HAVE_MATH_H", "1")
        .define("HAVE_STRING_H", "1")
        .define("HAVE_LIMITS_H", "1")
        .define("HAVE_STDARG_H", "1")
        .warnings(false);

    let mut count = 0;
    for dir in [".", "tempo", "onset", "spectral", "temporal", "utils"] {
        let dir = src.join(dir);
        let entries = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()));
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "c") {
                build.file(&path);
                count += 1;
            }
        }
    }
    assert!(count > 20, "expected aubio's tempo sources, found {count} files");
    build.compile("aubio_vendored");
}

fn generate_aubio_bindings(src: &Path) {
    let builder = bindgen::Builder::default()
        .header_contents("aubio_wrapper.h", "#include <aubio.h>\n")
        .clang_arg(format!("-I{}", src.display()))
        // Only the tempo surface we actually call, plus the vector type it
        // takes. Binding all of aubio would be a large, brittle blob.
        .allowlist_function("new_aubio_tempo")
        .allowlist_function("del_aubio_tempo")
        .allowlist_function("aubio_tempo_do")
        .allowlist_function("aubio_tempo_get_bpm")
        .allowlist_function("aubio_tempo_get_confidence")
        // Exact beat positions in samples. The tempo is derived from these
        // rather than from aubio's running estimate — see bpm.rs.
        .allowlist_function("aubio_tempo_get_last")
        .allowlist_function("new_fvec")
        .allowlist_function("del_fvec")
        .allowlist_type("fvec_t")
        .allowlist_type("smpl_t")
        .allowlist_type("uint_t")
        .layout_tests(false)
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()));

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR set by cargo"));
    builder
        .generate()
        .expect("failed to generate aubio bindings")
        .write_to_file(out.join("aubio_bindings.rs"))
        .expect("failed to write aubio bindings");
}

fn build_keyfinder_shim(prefix: &Path) {
    cc::Build::new()
        .cpp(true)
        .std("c++11")
        .file("shim/keyfinder_shim.cpp")
        .include(prefix.join("include"))
        .compile("keyfinder_shim");
}
