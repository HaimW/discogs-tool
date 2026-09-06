//! Just enough HTTP to serve one page and a handful of JSON endpoints.
//!
//! Deliberately not a web framework. This speaks to one browser on loopback,
//! and every request it will ever see is a GET for the page or a small JSON
//! POST from that page's own script.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::Arc;

use super::{oracle, origin::Allowed, state::UiState, PAGE};

/// Refuse to buffer a body larger than this. Nothing the page sends is more
/// than a few hundred bytes; the cap is here so a stray request cannot make the
/// server allocate without bound.
const MAX_BODY: usize = 64 * 1024;

pub fn handle(stream: TcpStream, state: &Arc<UiState>, allowed: &Allowed) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    let mut length = 0usize;
    let mut origin: Option<String> = None;
    let mut host: Option<String> = None;
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => return,
        }
        let trimmed = header.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0).min(MAX_BODY);
        } else if lower.starts_with("origin:") {
            origin = trimmed.split_once(':').map(|(_, v)| v.trim().to_string());
        } else if lower.starts_with("host:") {
            host = trimmed.split_once(':').map(|(_, v)| v.trim().to_string());
        }
    }

    // The only authorization this server has. `Origin` is a forbidden header
    // name, so a page cannot lie about who it is; `Host` is checked so a
    // domain rebound to 127.0.0.1 cannot pose as this server. See `origin.rs`
    // for why the peer address is not a boundary.
    let permitted = allowed.permits(origin.as_deref()) && Allowed::host_is_loopback(host.as_deref());
    if !permitted {
        let message = br#"{"error":"this origin is not allowed to drive the analyzer. Start it with --allow-origin <your app's URL> if you meant to."}"#;
        let _ = respond(stream, 403, "application/json", message, None);
        return;
    }

    let mut body = vec![0u8; length];
    if length > 0 && reader.read_exact(&mut body).is_err() {
        return;
    }

    let echo = allowed.echo(origin.as_deref());
    let (status, kind, payload) = if method == "OPTIONS" {
        (204, "text/plain", Vec::new())
    } else {
        route(&method, &path, &body, state)
    };
    let _ = respond(stream, status, kind, &payload, echo);
}

fn route(method: &str, path: &str, body: &[u8], state: &Arc<UiState>) -> (u16, &'static str, Vec<u8>) {
    // Query strings are not used by the page, but a browser may still append
    // one; route on the path alone.
    let path = path.split('?').next().unwrap_or(path);
    let json = |v: serde_json::Value| (200u16, "application/json", v.to_string().into_bytes());

    match (method, path) {
        ("GET", "/") => (200, "text/html; charset=utf-8", PAGE.as_bytes().to_vec()),
        ("GET", "/api/state") => json(state.snapshot()),
        ("GET", "/api/oracle") => json(oracle::describe()),
        ("POST", "/api/plan") => match parse(body) {
            Ok(v) => json(state.plan(&v)),
            Err(e) => json(serde_json::json!({ "error": e })),
        },
        ("POST", "/api/run") => match parse(body) {
            Ok(v) => json(state.start_run(&v)),
            Err(e) => json(serde_json::json!({ "error": e })),
        },
        ("POST", "/api/stop") => json(state.request_stop()),
        ("POST", "/api/oracle/run") => match parse(body) {
            Ok(v) => json(oracle::start(state, &v)),
            Err(e) => json(serde_json::json!({ "error": e })),
        },
        _ => (404, "application/json", br#"{"error":"no such endpoint"}"#.to_vec()),
    }
}

fn parse(body: &[u8]) -> Result<serde_json::Value, String> {
    if body.is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_slice(body).map_err(|e| format!("bad request body: {e}"))
}

fn respond(
    mut stream: TcpStream,
    status: u16,
    kind: &str,
    body: &[u8],
    allow_origin: Option<String>,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    // The specific origin, never `*`: a wildcard tells every other site it may
    // read the response, which was the other half of the hole this replaced.
    let cors = match allow_origin {
        Some(o) => format!(
            "Access-Control-Allow-Origin: {o}\r\n\
             Access-Control-Allow-Headers: Content-Type\r\n\
             Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
             Vary: Origin\r\n"
        ),
        None => String::new(),
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {kind}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         {cors}\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
