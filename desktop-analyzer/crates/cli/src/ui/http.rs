//! Just enough HTTP to serve one page and a handful of JSON endpoints.
//!
//! Deliberately not a web framework. This speaks to one browser on loopback,
//! and every request it will ever see is a GET for the page or a small JSON
//! POST from that page's own script.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use super::{oracle, origin::Allowed, state::UiState, PAGE};

/// Refuse a JSON body larger than this. Nothing the page posts as JSON is more
/// than a few hundred bytes; the cap is here so a stray request cannot make the
/// server allocate without bound.
const MAX_JSON_BODY: usize = 64 * 1024;

/// Refuse an uploaded file larger than this. A real 3,400-video backup is a
/// few megabytes and its ledger about the same; 64 MiB is generous headroom
/// while still bounding what one request can make the server hold.
pub(crate) const MAX_UPLOAD_BODY: usize = 64 * 1024 * 1024;

/// Refuse a request line or a header line longer than this. Read through
/// `take`, so a line that never ends costs at most this much memory.
const MAX_LINE: usize = 16 * 1024;

/// Refuse a request with more header lines than this. A browser sends a
/// dozen or two.
const MAX_HEADERS: usize = 64;

/// After refusing a request without reading its body, read and discard at
/// most this much of what the client is still sending, for at most
/// `DRAIN_TIME`. Closing a socket with unread data makes the kernel send a
/// reset, which can destroy the refusal before the browser reads it; draining
/// a little first makes a clean close more likely without letting a client
/// make us read a 64 MiB upload. Twice the JSON limit, so a request refused
/// for being just over it is drained whole.
const DRAIN_BYTES: usize = 2 * MAX_JSON_BODY;
const DRAIN_TIME: Duration = Duration::from_secs(1);

/// The endpoints whose body is a whole file rather than a small JSON object.
fn is_upload(method: &str, path: &str) -> bool {
    method == "POST" && matches!(path, "/api/backup" | "/api/ledger")
}

/// A byte limit as people say it: "64 MB", "64 KB".
fn size_label(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{} MB", bytes / (1024 * 1024))
    } else {
        format!("{} KB", bytes / 1024)
    }
}

/// What `route` hands back: status, content type, extra headers, body.
struct Response {
    status: u16,
    kind: &'static str,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl Response {
    fn json(status: u16, value: serde_json::Value) -> Response {
        Response {
            status,
            kind: "application/json",
            headers: Vec::new(),
            body: value.to_string().into_bytes(),
        }
    }
}

pub fn handle(stream: TcpStream, state: &Arc<UiState>, allowed: &Allowed) {
    // A client that stops sending mid-request would otherwise hold its thread
    // (and its partly read body) for ever. Generous: a 64 MiB upload over
    // loopback takes well under a second.
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let too_large_head = || {
        Response::json(
            431,
            json!({ "error": "the request's headers are too large", "code": "headers_too_large" }),
        )
    };

    let request_line = match read_line_limited(&mut reader) {
        Line::Text(line) => line,
        Line::End => return,
        Line::TooLong => return refuse(&stream, &mut reader, too_large_head(), None),
    };
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };

    // `None` when absent; `Some(Err)` when present but not a number.
    let mut length: Option<Result<usize, ()>> = None;
    let mut expect_continue = false;
    let mut origin: Option<String> = None;
    let mut host: Option<String> = None;
    let mut transfer_encoding = false;
    let mut headers = 0usize;
    loop {
        let header = match read_line_limited(&mut reader) {
            Line::Text(line) => line,
            Line::End => break,
            Line::TooLong => return refuse(&stream, &mut reader, too_large_head(), None),
        };
        let trimmed = header.trim_end();
        if trimmed.is_empty() {
            break;
        }
        headers += 1;
        if headers > MAX_HEADERS {
            return refuse(&stream, &mut reader, too_large_head(), None);
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            length = Some(value.trim().parse().map_err(|_| ()));
        } else if lower.starts_with("transfer-encoding:") {
            transfer_encoding = true;
        } else if let Some(value) = lower.strip_prefix("expect:") {
            expect_continue = value.trim() == "100-continue";
        } else if lower.starts_with("origin:") {
            origin = trimmed.split_once(':').map(|(_, v)| v.trim().to_string());
        } else if lower.starts_with("host:") {
            host = trimmed.split_once(':').map(|(_, v)| v.trim().to_string());
        }
    }

    // The only authorization this server has. `Origin` is a forbidden header
    // name, so a page cannot lie about who it is; `Host` is checked so a
    // domain rebound to 127.0.0.1 cannot pose as this server. See `origin.rs`
    // for why the peer address is not a boundary. Checked before anything
    // else looks at the request, every endpoint included.
    let permitted = allowed.permits(origin.as_deref()) && Allowed::host_is_loopback(host.as_deref());
    if !permitted {
        let message = json!({ "error": "this origin is not allowed to drive the analyzer. Start it with --allow-origin <your app's URL> if you meant to." });
        return refuse(&stream, &mut reader, Response::json(403, message), None);
    }
    let echo = allowed.echo(origin.as_deref());

    // Only Content-Length bodies are understood. A chunked body read as
    // "no Content-Length, so empty" would run the request on defaults
    // instead of what was sent, so any Transfer-Encoding is refused.
    if transfer_encoding {
        let reply = json!({
            "error": "chunked or encoded request bodies are not supported: send a Content-Length",
            "code": "length_required",
        });
        return refuse(&stream, &mut reader, Response::json(411, reply), echo);
    }

    // Decide on the body from its declared length alone, before reading a
    // byte of it: an oversized upload is refused without being buffered.
    let upload = is_upload(&method, &path);
    let limit = if upload { MAX_UPLOAD_BODY } else { MAX_JSON_BODY };
    let length = match length {
        None if upload => {
            let reply = json!({ "error": "the upload must say how big it is (Content-Length)", "code": "length_required" });
            return refuse(&stream, &mut reader, Response::json(411, reply), echo);
        }
        None => 0,
        Some(Err(())) => {
            let reply = json!({ "error": "bad Content-Length", "code": "bad_request" });
            return refuse(&stream, &mut reader, Response::json(400, reply), echo);
        }
        Some(Ok(n)) if n > limit => {
            let what = if upload { "file" } else { "request" };
            let reply = json!({
                "error": format!("That {what} is too large: the limit is {}.", size_label(limit)),
                "code": "too_large",
            });
            return refuse(&stream, &mut reader, Response::json(413, reply), echo);
        }
        Some(Ok(n)) => n,
    };

    // curl sends this for larger bodies and waits for a go-ahead before
    // sending them; browsers never do. Answering saves it a second's stall.
    if expect_continue && length > 0 {
        let mut w = &stream;
        if w.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").is_err() {
            return;
        }
    }

    // Grown as bytes arrive rather than allocated up front, so a request that
    // claims 64 MiB and sends nothing does not pin 64 MiB.
    let mut body = Vec::with_capacity(length.min(1024 * 1024));
    if length > 0 {
        let read = (&mut reader).take(length as u64).read_to_end(&mut body);
        if read.is_err() || body.len() != length {
            return;
        }
    }

    let response = if method == "OPTIONS" {
        Response { status: 204, kind: "text/plain", headers: Vec::new(), body: Vec::new() }
    } else {
        route(&method, &path, &query, &body, state)
    };
    let _ = respond(&stream, response, echo);
}

/// One line of the request head.
enum Line {
    Text(String),
    /// The connection ended, or failed, before a line did.
    End,
    /// Longer than `MAX_LINE`.
    TooLong,
}

/// Read one CRLF- (or LF-) terminated line of at most `MAX_LINE` bytes. Read
/// through `take`, so a client that never sends a newline cannot make the
/// buffer grow past the limit.
fn read_line_limited(reader: &mut BufReader<TcpStream>) -> Line {
    let mut buf = Vec::new();
    match reader.by_ref().take(MAX_LINE as u64).read_until(b'\n', &mut buf) {
        Ok(0) | Err(_) => Line::End,
        Ok(_) if buf.ends_with(b"\n") => Line::Text(String::from_utf8_lossy(&buf).into_owned()),
        Ok(_) if buf.len() >= MAX_LINE => Line::TooLong,
        // Ended mid-line: what there is, is the last line.
        Ok(_) => Line::Text(String::from_utf8_lossy(&buf).into_owned()),
    }
}

/// Answer a request whose body (or rest of head) was not read, then close
/// cleanly: send the reply, signal end of reply, and discard a bounded amount
/// of what the client is still sending — see `DRAIN_BYTES`.
fn refuse(
    stream: &TcpStream,
    reader: &mut BufReader<TcpStream>,
    response: Response,
    allow_origin: Option<String>,
) {
    if respond(stream, response, allow_origin).is_err() {
        return;
    }
    let _ = stream.shutdown(Shutdown::Write);
    let deadline = Instant::now() + DRAIN_TIME;
    let mut left = DRAIN_BYTES;
    let mut scratch = [0u8; 8192];
    while left > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || reader.get_ref().set_read_timeout(Some(remaining)).is_err() {
            return;
        }
        let want = left.min(scratch.len());
        match reader.read(&mut scratch[..want]) {
            Ok(0) | Err(_) => return,
            Ok(n) => left -= n,
        }
    }
}

/// A query string's value for `key`. Only the page's own simple tokens are
/// expected here, so there is no percent-decoding.
fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('=').or(Some((pair, ""))))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
}

fn route(method: &str, path: &str, query: &str, body: &[u8], state: &Arc<UiState>) -> Response {
    let json = |v: serde_json::Value| Response::json(200, v);
    let with_json = |f: &dyn Fn(serde_json::Value) -> Response| match parse(body) {
        Ok(v) => f(v),
        Err(e) => json(json!({ "error": e })),
    };

    match (method, path) {
        ("GET", "/") => Response {
            status: 200,
            kind: "text/html; charset=utf-8",
            headers: Vec::new(),
            body: PAGE.as_bytes().to_vec(),
        },
        ("GET", "/api/state") => json(state.snapshot()),
        ("GET", "/api/files") => json(state.files()),
        ("GET", "/api/oracle") => json(oracle::describe()),
        ("GET", "/api/audio") => json(state.audio()),
        ("POST", "/api/audio/delete") => json(state.delete_audio()),
        ("GET", "/api/result") => match state.result_bytes() {
            Some(bytes) => Response {
                status: 200,
                kind: "application/json",
                headers: vec![(
                    "Content-Disposition",
                    format!("attachment; filename=\"{}\"", crate::datadir::RESULT_FILE),
                )],
                body: bytes,
            },
            None => Response::json(
                404,
                json!({ "error": "There is no result yet: run the analysis first.", "code": "no_result" }),
            ),
        },
        ("POST", "/api/backup") => json(state.upload_backup(body)),
        ("POST", "/api/ledger") => json(state.import_ledger(
            body,
            query_value(query, "second_opinion").unwrap_or("always"),
            query_value(query, "replace") == Some("1"),
        )),
        ("POST", "/api/plan") => with_json(&|v| json(state.plan(&v))),
        ("POST", "/api/run") => with_json(&|v| {
            let (status, reply) = state.start_run(&v);
            Response::json(status, reply)
        }),
        ("POST", "/api/stop") => json(state.request_stop()),
        ("POST", "/api/oracle/run") => with_json(&|v| json(oracle::start(state, &v))),
        _ => Response::json(404, json!({ "error": "no such endpoint" })),
    }
}

fn parse(body: &[u8]) -> Result<serde_json::Value, String> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|e| format!("bad request body: {e}"))
}

fn respond(mut stream: &TcpStream, response: Response, allow_origin: Option<String>) -> std::io::Result<()> {
    let status = response.status;
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    // The specific origin, never `*`: a wildcard tells every other site it may
    // read the response, which was the other half of the hole this replaced.
    let cors = match allow_origin {
        Some(o) => format!(
            "Access-Control-Allow-Origin: {o}\r\n\
             Access-Control-Allow-Headers: Content-Type\r\n\
             Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
             Access-Control-Expose-Headers: Content-Disposition\r\n\
             Vary: Origin\r\n"
        ),
        None => String::new(),
    };
    let extra: String = response.headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         {extra}\
         {cors}\
         Connection: close\r\n\r\n",
        response.kind,
        response.body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(&response.body)?;
    stream.flush()
}
