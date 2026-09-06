//! Deciding which browser origins may drive the analyzer.
//!
//! # Why the obvious check does not work
//!
//! The first version of this server accepted anything whose TCP peer was
//! loopback. That is not a security boundary: when a page does
//! `fetch("http://127.0.0.1:8733/api/run")`, the connection comes from the
//! browser, and the browser is on loopback. The check passed for precisely the
//! attack it was meant to stop. Paired with `Access-Control-Allow-Origin: *`,
//! any site the user visited while the UI was running could have made the
//! analyzer write a file of its choosing and execute a binary of its choosing.
//!
//! # What does work
//!
//! `Origin` is a forbidden header name: browsers set it on cross-origin
//! requests and page script cannot change it. So an allow-list of origins is a
//! real boundary — a malicious page's requests arrive stamped with its own
//! origin and are refused.
//!
//! Requests with no `Origin` at all are allowed. They are not browser
//! cross-origin requests: they are curl, or a script. Anything that can make
//! them is already running as the user and does not need this server to read a
//! file or start a process.
//!
//! The `Host` header is checked too, so a name that resolves to 127.0.0.1
//! cannot be used to make a page look same-origin (DNS rebinding).

/// The spellings of loopback a browser treats as different origins.
///
/// `http://localhost:8080` and `http://127.0.0.1:8080` are the same server and
/// different origins, and which one you get depends on what you typed. Allowing
/// one and refusing the other is a trap with no security value: a page can only
/// carry a loopback origin if it was served from loopback on that same port, so
/// naming one spelling has already trusted whatever is listening there.
///
/// Other ports are *not* expanded — that would trust every local server.
const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

/// Expand a loopback origin to the other spellings of the same address and
/// port. Anything else is returned unchanged.
fn loopback_aliases(origin: String) -> Vec<String> {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return vec![origin];
    };
    let (host, port) = match rest.rsplit_once(':') {
        // Keep the bracket on an IPv6 literal: "[::1]" splits at the last colon.
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => (h, Some(p)),
        _ => (rest, None),
    };
    if !LOOPBACK_HOSTS.contains(&host) {
        return vec![origin];
    }
    LOOPBACK_HOSTS
        .iter()
        .map(|alias| match port {
            Some(p) => format!("{scheme}://{alias}:{p}"),
            None => format!("{scheme}://{alias}"),
        })
        .collect()
}

/// Origins allowed to drive this server, beyond its own.
#[derive(Debug, Clone, Default)]
pub struct Allowed {
    /// Origins the user opted into with `--allow-origin`.
    extra: Vec<String>,
    /// This server's own origins, so its own page works.
    own: Vec<String>,
}

impl Allowed {
    pub fn new(port: u16, extra: Vec<String>) -> Allowed {
        Allowed {
            extra: extra
                .into_iter()
                .flat_map(|o| loopback_aliases(o.trim_end_matches('/').to_lowercase()))
                .collect(),
            own: vec![
                format!("http://127.0.0.1:{port}"),
                format!("http://localhost:{port}"),
                format!("http://[::1]:{port}"),
            ],
        }
    }

    /// Whether a request carrying this `Origin` may proceed.
    pub fn permits(&self, origin: Option<&str>) -> bool {
        match origin {
            // Not a browser cross-origin request. See the module docs.
            None => true,
            Some(value) => {
                let value = value.trim().trim_end_matches('/').to_lowercase();
                self.own.iter().chain(self.extra.iter()).any(|a| *a == value)
            }
        }
    }

    /// The value to echo back in `Access-Control-Allow-Origin`.
    ///
    /// The specific origin, never `*`: a wildcard would tell every other site
    /// that it may read the response, which is the other half of the hole.
    pub fn echo(&self, origin: Option<&str>) -> Option<String> {
        let value = origin?.trim().trim_end_matches('/').to_string();
        self.permits(Some(&value)).then_some(value)
    }

    /// Reject a `Host` that is not a loopback name, so a domain that resolves
    /// to 127.0.0.1 cannot be used to make a foreign page look same-origin.
    pub fn host_is_loopback(host: Option<&str>) -> bool {
        let Some(host) = host else { return true };
        let host = host.trim().to_lowercase();
        let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(&host);
        let name = name.trim_start_matches('[').trim_end_matches(']');
        name == "127.0.0.1" || name == "localhost" || name == "::1"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed() -> Allowed {
        Allowed::new(8733, vec!["https://haimw.github.io".into()])
    }

    #[test]
    fn the_servers_own_page_is_allowed() {
        for origin in ["http://127.0.0.1:8733", "http://localhost:8733"] {
            assert!(allowed().permits(Some(origin)), "{origin}");
        }
    }

    #[test]
    fn an_origin_the_user_opted_into_is_allowed() {
        assert!(allowed().permits(Some("https://haimw.github.io")));
        // A trailing slash is the same origin.
        assert!(allowed().permits(Some("https://haimw.github.io/")));
    }

    #[test]
    fn the_other_spelling_of_loopback_is_the_same_server() {
        // localhost and 127.0.0.1 are one server and two origins, and which you
        // get depends on what you typed into the address bar. Naming either is
        // naming both.
        let local = Allowed::new(8733, vec!["http://127.0.0.1:8080".into()]);
        assert!(local.permits(Some("http://127.0.0.1:8080")));
        assert!(local.permits(Some("http://localhost:8080")));
        assert!(local.permits(Some("http://[::1]:8080")));

        let named = Allowed::new(8733, vec!["http://localhost:8080".into()]);
        assert!(named.permits(Some("http://127.0.0.1:8080")));
    }

    #[test]
    fn expanding_one_port_does_not_trust_another() {
        // The expansion is per address, not a blanket trust of loopback: some
        // other local server must not inherit this.
        let local = Allowed::new(8733, vec!["http://127.0.0.1:8080".into()]);
        assert!(!local.permits(Some("http://localhost:9999")));
        assert!(!local.permits(Some("http://127.0.0.1:3000")));
    }

    #[test]
    fn a_remote_origin_is_not_expanded() {
        let remote = Allowed::new(8733, vec!["https://haimw.github.io".into()]);
        assert!(remote.permits(Some("https://haimw.github.io")));
        assert!(!remote.permits(Some("http://localhost")));
    }

    #[test]
    fn any_other_site_is_refused() {
        // The attack this exists for: a page the user happened to visit.
        for origin in [
            "https://evil.example",
            "http://haimw.github.io",          // wrong scheme
            "https://haimw.github.io.evil.example",
            "https://nothaimw.github.io",
            "http://127.0.0.1:9999",           // another local server
            "null",
        ] {
            assert!(!allowed().permits(Some(origin)), "{origin} should be refused");
        }
    }

    #[test]
    fn a_request_with_no_origin_is_not_a_browser_cross_origin_request() {
        assert!(allowed().permits(None));
    }

    #[test]
    fn nothing_is_allowed_by_default_beyond_the_server_itself() {
        let bare = Allowed::new(8733, Vec::new());
        assert!(bare.permits(Some("http://127.0.0.1:8733")));
        assert!(!bare.permits(Some("https://haimw.github.io")));
    }

    #[test]
    fn the_echoed_origin_is_never_a_wildcard() {
        assert_eq!(
            allowed().echo(Some("https://haimw.github.io")),
            Some("https://haimw.github.io".to_string())
        );
        assert_eq!(allowed().echo(Some("https://evil.example")), None);
        assert_eq!(allowed().echo(None), None);
    }

    #[test]
    fn a_rebound_hostname_is_refused() {
        // The DNS rebinding case: evil.example resolves to 127.0.0.1, so the
        // connection is loopback and the page believes it is same-origin.
        assert!(!Allowed::host_is_loopback(Some("evil.example:8733")));
        assert!(Allowed::host_is_loopback(Some("127.0.0.1:8733")));
        assert!(Allowed::host_is_loopback(Some("localhost:8733")));
        assert!(Allowed::host_is_loopback(Some("[::1]:8733")));
        assert!(Allowed::host_is_loopback(None));
    }
}
