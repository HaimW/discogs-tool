//! The UI over real HTTP: a server on an OS-chosen loopback port, spoken to
//! with raw requests, so body limits, status codes and headers are tested as
//! a browser would meet them.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;

use super::origin::Allowed;
use super::test_support::*;
use super::{serve_on, UiState};
use crate::datadir::RESULT_FILE;

struct Server {
    addr: SocketAddr,
}

fn server(state: Arc<UiState>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let allowed = Arc::new(Allowed::new(addr.port(), Vec::new()));
    std::thread::spawn(move || serve_on(listener, state, allowed));
    Server { addr }
}

struct Reply {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("not JSON ({e}): {}", String::from_utf8_lossy(&self.body)))
    }
    fn header(&self, name: &str) -> Option<String> {
        let prefix = format!("{}:", name.to_ascii_lowercase());
        self.head
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with(&prefix))
            .map(|l| l[prefix.len()..].trim().to_string())
    }
}

impl Server {
    /// Send `head_extra` headers and `body`, and read the whole reply.
    /// `content_length: None` sends no Content-Length at all.
    fn raw(
        &self,
        method: &str,
        path: &str,
        head_extra: &[(&str, String)],
        content_length: Option<usize>,
        body: &[u8],
    ) -> Reply {
        let mut stream = TcpStream::connect(self.addr).unwrap();
        // A server that waits for a body it should have refused would
        // otherwise hang the test instead of failing it.
        stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {}\r\n", self.addr);
        for (k, v) in head_extra {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        if let Some(n) = content_length {
            head.push_str(&format!("Content-Length: {n}\r\n"));
        }
        head.push_str("\r\n");
        // Write failures are not fatal here: a server that refuses early may
        // stop reading, and what counts is whether its reply arrives.
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body);
        let mut raw = Vec::new();
        stream
            .read_to_end(&mut raw)
            .unwrap_or_else(|e| panic!("no reply to {method} {path} ({e}): did the server wait for the body?"));
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("a full reply");
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        Reply { status, head, body: raw[split + 4..].to_vec() }
    }

    fn get(&self, path: &str) -> Reply {
        self.raw("GET", path, &[], None, b"")
    }

    fn post(&self, path: &str, body: &[u8]) -> Reply {
        self.raw("POST", path, &[], Some(body.len()), body)
    }
}

#[test]
fn an_oversized_upload_is_refused_without_reading_it() {
    let dir = Scratch::new("http-413");
    let s = server(stub_state(&dir.0));
    // Claims one byte over 64 MiB and sends none of it: a server that tried
    // to read the body would hang here instead of answering.
    let r = s.raw("POST", "/api/backup", &[], Some(64 * 1024 * 1024 + 1), b"");
    assert_eq!(r.status, 413);
    assert_eq!(r.json()["code"], "too_large");
    assert!(!dir.0.exists());

    // JSON endpoints keep their small limit, rather than truncating.
    let r = s.raw("POST", "/api/plan", &[], Some(64 * 1024 + 1), b"");
    assert_eq!(r.status, 413);
    assert_eq!(r.json()["code"], "too_large");
}

#[test]
fn an_upload_without_a_length_is_refused() {
    let dir = Scratch::new("http-411");
    let s = server(stub_state(&dir.0));
    let r = s.raw("POST", "/api/backup", &[], None, b"");
    assert_eq!(r.status, 411);
    assert!(r.json()["error"].is_string());
    let r = s.raw("POST", "/api/ledger", &[], None, b"");
    assert_eq!(r.status, 411);
}

#[test]
fn an_oversized_header_line_is_refused_and_the_server_carries_on() {
    let dir = Scratch::new("http-431-header");
    let s = server(stub_state(&dir.0));
    let big = [("X-Big", "a".repeat(20 * 1024))];
    let r = s.raw("GET", "/api/files", &big, None, b"");
    assert!(matches!(r.status, 431 | 400), "got {}", r.status);
    assert!(r.json()["error"].is_string());
    // Still answering.
    assert_eq!(s.get("/api/files").status, 200);
}

#[test]
fn an_oversized_request_line_is_refused() {
    let dir = Scratch::new("http-431-line");
    let s = server(stub_state(&dir.0));
    let path = format!("/api/files?{}", "q".repeat(20 * 1024));
    let r = s.raw("GET", &path, &[], None, b"");
    assert!(matches!(r.status, 431 | 414 | 400), "got {}", r.status);
    assert_eq!(s.get("/api/files").status, 200);
}

#[test]
fn too_many_headers_are_refused() {
    let dir = Scratch::new("http-431-count");
    let s = server(stub_state(&dir.0));
    let many: Vec<(&str, String)> = (0..100).map(|i| ("X-Many", i.to_string())).collect();
    let r = s.raw("GET", "/api/files", &many, None, b"");
    assert!(matches!(r.status, 431 | 400), "got {}", r.status);
    // A normal number of headers is fine.
    let some: Vec<(&str, String)> = (0..20).map(|i| ("X-Some", i.to_string())).collect();
    assert_eq!(s.raw("GET", "/api/files", &some, None, b"").status, 200);
}

#[test]
fn a_chunked_body_is_refused_rather_than_read_as_empty() {
    let dir = Scratch::new("http-chunked");
    let state = stub_state(&dir.0);
    let s = server(Arc::clone(&state));
    s.post("/api/backup", analysed_backup().as_bytes());
    // Were this body read as empty, the run would go ahead with defaults; it
    // must be refused instead, whatever it says.
    let te = [("Transfer-Encoding", "chunked".to_string())];
    let chunked = b"18\r\n{\"confirm_restart\":true}\r\n0\r\n\r\n";
    let r = s.raw("POST", "/api/run", &te, None, chunked);
    assert!(matches!(r.status, 411 | 400), "got {}", r.status);
    assert!(r.json()["error"].is_string());
    assert_eq!(state.snapshot()["running"], false);
    // With a Content-Length as well, still refused.
    let r = s.raw("POST", "/api/backup", &te, Some(chunked.len()), chunked);
    assert!(matches!(r.status, 411 | 400), "got {}", r.status);
}

#[test]
fn an_early_refusal_with_a_body_still_reaches_the_client() {
    let dir = Scratch::new("http-drain");
    let s = server(stub_state(&dir.0));
    // A JSON request over its 64 KB limit, with the body actually sent: the
    // server refuses without reading it, and must not reset the connection
    // before the client has read the refusal.
    let body = vec![b' '; 64 * 1024 + 1];
    for _ in 0..5 {
        let r = s.raw("POST", "/api/plan", &[], Some(body.len()), &body);
        assert_eq!(r.status, 413);
        assert_eq!(r.json()["code"], "too_large");
    }
}

#[test]
fn upload_plan_run_and_download_over_http() {
    let dir = Scratch::new("http-flow");
    let state = stub_state(&dir.0);
    let s = server(Arc::clone(&state));

    let r = s.get("/api/result");
    assert_eq!(r.status, 404);
    assert_eq!(r.json()["code"], "no_result");
    assert_eq!(s.post("/api/plan", b"{}").json()["code"], "no_backup");

    let r = s.post("/api/backup", first_backup().as_bytes());
    assert_eq!((r.status, r.json()["videos"].clone()), (200, serde_json::json!(2)));
    assert_eq!(s.post("/api/backup", b"not a backup").json()["code"], "invalid_backup");

    let files = s.get("/api/files").json();
    assert_eq!(files["backup"]["videos"], 2);
    assert_eq!(files["result"], false);

    let plan = s.post("/api/plan", b"{}").json();
    assert_eq!(plan["analyze"], 2, "{plan}");
    assert_eq!(plan["restart"]["needed"], false);

    let r = s.post("/api/run", b"{}");
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    wait_idle(&state);

    let r = s.get("/api/result");
    assert_eq!(r.status, 200);
    assert_eq!(r.header("Content-Type").as_deref(), Some("application/json"));
    assert_eq!(
        r.header("Content-Disposition").as_deref(),
        Some("attachment; filename=\"analysis.json\"")
    );
    assert_eq!(r.body, std::fs::read(dir.join(RESULT_FILE)).unwrap());
    assert_eq!(s.get("/api/files").json()["result"], true);
}

#[test]
fn a_run_that_redoes_work_is_a_409_until_confirmed() {
    let dir = Scratch::new("http-409");
    let state = stub_state(&dir.0);
    let s = server(Arc::clone(&state));
    s.post("/api/backup", analysed_backup().as_bytes());
    let r = s.post("/api/run", b"{}");
    assert_eq!(r.status, 409);
    assert_eq!(r.json()["code"], "restart_needs_confirmation");
    assert_eq!(r.json()["restart"]["needed"], true);
    let r = s.post("/api/run", br#"{"confirm_restart":true}"#);
    assert_eq!(r.status, 200);
    wait_idle(&state);
}

#[test]
fn the_ledger_import_reads_its_options_from_the_query() {
    let dir = Scratch::new("http-ledger");
    let s = server(stub_state(&dir.0));
    let unsure = ledger_json("Unsure", &["1_aaa"]);
    let r = s.post("/api/ledger?second_opinion=unsure", unsure.as_bytes()).json();
    assert_eq!((r["ok"].clone(), r["settings_match"].clone()), (true.into(), true.into()), "{r}");

    let never = ledger_json("Never", &["1_aaa", "1_bbb"]);
    let r = s.post("/api/ledger?second_opinion=unsure", never.as_bytes()).json();
    assert_eq!(r["code"], "ledger_exists", "{r}");
    assert_eq!(r["existing_completed"], 1);
    assert_eq!(r["incoming_completed"], 2);
    let r = s.post("/api/ledger?second_opinion=unsure&replace=1", never.as_bytes()).json();
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["matching_setting"], "never");
    assert_eq!(s.post("/api/ledger", b"junk").json()["code"], "invalid_ledger");
}

#[test]
fn saved_audio_is_sized_and_deleted_over_http() {
    let dir = Scratch::new("http-audio");
    let state = stub_state(&dir.0);
    let s = server(Arc::clone(&state));
    let r = s.get("/api/audio");
    assert_eq!(r.status, 200);
    assert_eq!((r.json()["files"].clone(), r.json()["bytes"].clone()), (0.into(), 0.into()));

    s.post("/api/backup", first_backup().as_bytes());
    let body = serde_json::json!({ "keep_audio": true }).to_string();
    assert_eq!(s.post("/api/run", body.as_bytes()).status, 200);
    wait_idle(&state);
    assert_eq!(s.get("/api/audio").json()["files"], 2);

    let r = s.post("/api/audio/delete", b"");
    assert_eq!(r.status, 200);
    let reply = r.json();
    assert_eq!((reply["ok"].clone(), reply["deleted_files"].clone()), (true.into(), 2.into()), "{reply}");
    assert_eq!(s.get("/api/audio").json()["files"], 0);
}

#[test]
fn a_foreign_origin_is_refused_on_every_new_endpoint() {
    let dir = Scratch::new("http-origin");
    let s = server(stub_state(&dir.0));
    let evil = [("Origin", "https://evil.example".to_string())];
    let backup = first_backup();
    let ledger = ledger_json("Always", &["1_aaa"]);
    for (method, path, body) in [
        ("GET", "/api/files", &b""[..]),
        ("POST", "/api/backup", backup.as_bytes()),
        ("POST", "/api/ledger?second_opinion=always&replace=1", ledger.as_bytes()),
        ("GET", "/api/result", &b""[..]),
        ("POST", "/api/plan", &b"{}"[..]),
        ("POST", "/api/run", &br#"{"confirm_restart":true}"#[..]),
        ("POST", "/api/oracle/run", &b"{}"[..]),
        ("GET", "/api/audio", &b""[..]),
        ("POST", "/api/audio/delete", &b"{}"[..]),
    ] {
        let r = s.raw(method, path, &evil, Some(body.len()), body);
        assert_eq!(r.status, 403, "{method} {path}");
    }
    // Even an oversized claim is a 403 first: the origin check comes before
    // anything else looks at the request.
    let r = s.raw("POST", "/api/backup", &evil, Some(usize::MAX / 2), b"");
    assert_eq!(r.status, 403);
    assert!(!dir.0.exists(), "a refused request wrote something");

    // The page's own origin is allowed.
    let own = [("Origin", format!("http://{}", s.addr))];
    let r = s.raw("GET", "/api/files", &own, None, b"");
    assert_eq!(r.status, 200);
}
