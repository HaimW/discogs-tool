//! Prints the Camelot colour table. Run with:
//!   cargo test --test dump_colors -- --nocapture
//! The web app's src/camelot.js hardcodes this exact table; if the derivation
//! in camelot.rs ever changes, regenerate that table from this output.
#[test]
fn dump_camelot_table() {
    for c in analyzer_core::camelot::wheel() {
        println!("{}\t{}\t{}", c.code(), c.color(), c.to_musical().name());
    }
}
