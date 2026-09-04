//! Bake libkeyfinder's directory into the binary's rpath.
//!
//! libkeyfinder normally lives in a user prefix (`~/.local`) because it has no
//! distro package. The analysis crate's build script sets an rpath for its own
//! compilation, but `cargo:rustc-link-arg` does not propagate to dependents, so
//! without this the CLI links successfully and then dies at startup with
//! "libkeyfinder.so.2: cannot open shared object file".
//!
//! The path arrives as `DEP_KEYFINDER_RPATH`, published by analyzer-analysis
//! via its `links = "keyfinder"` key.

fn main() {
    println!("cargo:rerun-if-env-changed=DEP_KEYFINDER_RPATH");
    if let Ok(dirs) = std::env::var("DEP_KEYFINDER_RPATH") {
        for dir in dirs.split(',').filter(|d| !d.is_empty()) {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
        }
    }
}
