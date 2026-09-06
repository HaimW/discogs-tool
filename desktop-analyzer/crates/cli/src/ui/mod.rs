//! A local web UI for the analyzer.
//!
//! Running a collection through this tool otherwise means remembering eleven
//! flags and reading a progress bar in a terminal. The point of §3b is a friend
//! with a record collection, and that person does not have a terminal open.
//!
//! It is a *local* server rather than a desktop framework on purpose. Tauri
//! would add a toolchain, a bundler and a webview dependency; this adds a
//! hundred lines of `std::net` and nothing else, so the thing you hand to
//! someone is still one binary. The interface is a page the binary serves to
//! itself, which is also how the rest of this project already works.
//!
//! Bound to loopback, and — because that is not on its own a security boundary
//! for a browser — every request is checked against an allow-list of origins.
//! See `origin.rs`: this server reads the filesystem and starts processes, so
//! deciding who may ask it to is the whole game.

mod http;
mod oracle;
mod origin;
mod state;

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::Arc;

pub use state::UiState;

/// The page, compiled in so the binary has no data files beside it.
const PAGE: &str = include_str!("page.html");

/// Serve the UI until the process is killed.
pub fn serve(port: u16, open_browser: bool, allow_origins: Vec<String>) -> Result<(), String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = TcpListener::bind(addr)
        .map_err(|e| format!("could not listen on {addr}: {e}"))?;
    // Port 0 asks the OS for any free port, so report what we actually got.
    let bound = listener.local_addr().map_err(|e| e.to_string())?;
    let url = format!("http://{bound}");

    println!("Analyzer UI on {url}");
    if allow_origins.is_empty() {
        println!(
            "Only this page may drive the analyzer. To use the web app's Analyzer tab,\n\
             restart with --allow-origin <the app's URL>."
        );
    } else {
        println!("Also accepting requests from: {}", allow_origins.join(", "));
    }
    println!("Press Ctrl-C to stop the server.");
    if open_browser {
        try_open(&url);
    }

    let state = Arc::new(UiState::default());
    let allowed = Arc::new(origin::Allowed::new(bound.port(), allow_origins));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                let allowed = Arc::clone(&allowed);
                // One thread per connection. A single user with one browser tab
                // will never have more than a handful open at once.
                std::thread::spawn(move || http::handle(stream, &state, &allowed));
            }
            Err(e) => eprintln!("connection failed: {e}"),
        }
    }
    Ok(())
}

/// Ask the desktop to open the page. Best effort: if it fails the URL is
/// already printed, and on a headless machine there is nothing to open.
fn try_open(url: &str) {
    let candidates: [(&str, &[&str]); 3] =
        [("xdg-open", &[]), ("open", &[]), ("cmd.exe", &["/c", "start", ""])];
    for (program, prefix) in candidates {
        let mut command = std::process::Command::new(program);
        command.args(prefix).arg(url);
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        if command.spawn().is_ok() {
            return;
        }
    }
}
