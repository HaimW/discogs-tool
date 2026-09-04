//! Locates aubio and libkeyfinder, generates aubio's bindings, and compiles the
//! C++ shim that fronts libkeyfinder.
//!
//! aubio's `smpl_t` is `float` or `double` depending on how the library was
//! compiled, so the bindings are generated from the installed headers rather
//! than hand-written against a guess.
//!
//! libkeyfinder usually lives in a user prefix (it has no Ubuntu package and we
//! install it without sudo), so `~/.local` is searched when pkg-config comes up
//! empty. Override with `LIBKEYFINDER_PREFIX`.

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=shim/keyfinder_shim.cpp");
    println!("cargo:rerun-if-env-changed=LIBKEYFINDER_PREFIX");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");

    let aubio = pkg_config::Config::new()
        .probe("aubio")
        .expect("aubio not found. Install libaubio-dev (Debian/Ubuntu) or aubio (brew).");

    let keyfinder = find_keyfinder();

    // --- aubio bindings ---
    let mut builder = bindgen::Builder::default()
        .header_contents("aubio_wrapper.h", "#include <aubio/aubio.h>\n")
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
    for path in &aubio.include_paths {
        builder = builder.clang_arg(format!("-I{}", path.display()));
    }

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR set by cargo"));
    builder
        .generate()
        .expect("failed to generate aubio bindings")
        .write_to_file(out.join("aubio_bindings.rs"))
        .expect("failed to write aubio bindings");

    // --- libkeyfinder shim ---
    let mut build = cc::Build::new();
    build.cpp(true).std("c++11").file("shim/keyfinder_shim.cpp");
    for inc in &keyfinder.include_paths {
        build.include(inc);
    }
    build.compile("keyfinder_shim");

    for dir in &keyfinder.link_paths {
        println!("cargo:rustc-link-search=native={}", dir.display());
        // Published to dependent crates as DEP_KEYFINDER_RPATH so their
        // binaries can bake in the same rpath — see `links` in Cargo.toml.
        println!("cargo:rpath={}", dir.display());
        // Baked into the binary so it finds a library in a user prefix at run
        // time without the user having to set LD_LIBRARY_PATH.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
    }
    for lib in &keyfinder.libs {
        println!("cargo:rustc-link-lib=dylib={lib}");
    }
}

struct Keyfinder {
    include_paths: Vec<PathBuf>,
    link_paths: Vec<PathBuf>,
    libs: Vec<String>,
}

fn find_keyfinder() -> Keyfinder {
    if let Ok(lib) = pkg_config::Config::new().probe("libkeyfinder") {
        return Keyfinder {
            include_paths: lib.include_paths,
            link_paths: lib.link_paths,
            libs: lib.libs,
        };
    }

    let prefix = env::var("LIBKEYFINDER_PREFIX")
        .map(PathBuf::from)
        .or_else(|_| env::var("HOME").map(|h| PathBuf::from(h).join(".local")))
        .expect("set LIBKEYFINDER_PREFIX to where libkeyfinder is installed");

    let include = prefix.join("include");
    let lib = prefix.join("lib");
    assert!(
        include.join("keyfinder").join("keyfinder.h").exists(),
        "libkeyfinder headers not found under {}. Build it with:\n  \
         git clone https://github.com/mixxxdj/libkeyfinder && cd libkeyfinder && \
         cmake -DCMAKE_INSTALL_PREFIX=$HOME/.local -DBUILD_TESTING=OFF -S . -B build && \
         cmake --build build && cmake --install build",
        include.display()
    );

    Keyfinder {
        include_paths: vec![include],
        link_paths: vec![lib],
        libs: vec!["keyfinder".to_string()],
    }
}
