//! Rendering [`Progress`] events for a human.
//!
//! Two audiences, one renderer. On a terminal this redraws a single status line
//! so a 900-track run does not scroll thousands of lines past; piped to a file
//! or a CI log it emits plain lines with no escape codes, because a log full of
//! carriage returns is unreadable.
//!
//! Everything goes to stderr, leaving stdout free for the summary a script
//! might want to consume.

use std::io::Write;

use analyzer_core::pipeline::{Progress, Summary};

pub struct Renderer<W: Write> {
    out: W,
    /// Redraw in place rather than appending a line per event.
    interactive: bool,
    /// Width of the last in-place line, so the next one can erase it fully.
    last_len: usize,
}

impl<W: Write> Renderer<W> {
    pub fn new(out: W, interactive: bool) -> Renderer<W> {
        Renderer { out, interactive, last_len: 0 }
    }

    pub fn handle(&mut self, event: &Progress) {
        match event {
            Progress::Started { total, already_done } => {
                if *already_done > 0 {
                    self.line(&format!(
                        "Resuming: {already_done} already analysed, {total} to go."
                    ));
                } else {
                    self.line(&format!("Analysing {total} track(s)."));
                }
            }
            Progress::Downloading { index, total, title, .. } => {
                self.status(&format!("[{index}/{total}] downloading  {}", trim(title)));
            }
            Progress::Reusing { index, total, title, .. } => {
                self.status(&format!("[{index}/{total}] cached       {}", trim(title)));
            }
            Progress::Analyzing { index, total, title, .. } => {
                self.status(&format!("[{index}/{total}] analysing    {}", trim(title)));
            }
            Progress::Completed { index, total, item_id, bpm, key } => {
                self.line(&format!("[{index}/{total}] {item_id}  {bpm:.2} BPM  {key}"));
            }
            Progress::Failed { index, total, item_id, error, will_retry } => {
                let tail = if *will_retry { " (will retry)" } else { " (giving up)" };
                self.line(&format!("[{index}/{total}] {item_id}  FAILED: {error}{tail}"));
            }
            Progress::LedgerUnsaved { message } => {
                // Loud, because the user's mental model of "I can stop this any
                // time" has just stopped being true.
                self.line(&format!(
                    "WARNING: cannot save progress: {message}\n\
                     Results from here on will be lost if this run is interrupted."
                ));
            }
            Progress::Blocked { failures } => {
                self.line(&format!(
                    "YouTube refused {failures} downloads in a row, asking each to prove it is \
                     not automated. Stopping — nothing has been charged against those tracks. \
                     Wait a while and re-run with fewer downloads at once, or pass \
                     --cookies-from-browser to sign the requests in."
                ));
            }
            Progress::LedgerSaved => {
                self.line("Progress saving again — the run is resumable once more.");
            }
            Progress::Finished(summary) => {
                self.clear();
                self.summary(summary);
            }
        }
    }

    /// A transient line: overwritten by whatever comes next on a terminal,
    /// suppressed entirely when piped (the Completed/Failed lines carry the
    /// same information and are the ones worth keeping in a log).
    fn status(&mut self, text: &str) {
        if !self.interactive {
            return;
        }
        let _ = write!(self.out, "\r{text}");
        // Erase whatever the previous, longer line left behind.
        if self.last_len > text.len() {
            let _ = write!(self.out, "{}", " ".repeat(self.last_len - text.len()));
        }
        let _ = self.out.flush();
        self.last_len = text.len();
    }

    /// A permanent line, which must not be clobbered by the status line.
    fn line(&mut self, text: &str) {
        self.clear();
        let _ = writeln!(self.out, "{text}");
        let _ = self.out.flush();
    }

    fn clear(&mut self) {
        if self.interactive && self.last_len > 0 {
            let _ = write!(self.out, "\r{}\r", " ".repeat(self.last_len));
            self.last_len = 0;
        }
    }

    fn summary(&mut self, s: &Summary) {
        let _ = writeln!(self.out);
        let _ = writeln!(self.out, "  analysed      {}", s.analyzed);
        let _ = writeln!(self.out, "  failed        {}", s.failed);
        let _ = writeln!(self.out, "  skipped       {}  (your own data — use --force to redo)", s.skipped);
        let _ = writeln!(self.out, "  needs review  {}  (too long, or title did not match)", s.needs_review);
        let _ = self.out.flush();
    }

    pub fn into_inner(self) -> W {
        self.out
    }
}

/// Keep a title to one line's worth, so the in-place redraw does not wrap and
/// leave orphaned fragments on screen.
fn trim(title: &str) -> String {
    const MAX: usize = 48;
    let chars: Vec<char> = title.chars().collect();
    if chars.len() <= MAX {
        return title.to_string();
    }
    let cut: String = chars[..MAX - 1].iter().collect();
    format!("{cut}\u{2026}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(interactive: bool, events: &[Progress]) -> String {
        let mut r = Renderer::new(Vec::new(), interactive);
        for e in events {
            r.handle(e);
        }
        String::from_utf8(r.into_inner()).unwrap()
    }

    fn downloading() -> Progress {
        Progress::Downloading {
            index: 1,
            total: 2,
            item_id: "1_abc".into(),
            title: "Blue Monday".into(),
        }
    }

    #[test]
    fn a_pipe_gets_no_escape_codes_or_carriage_returns() {
        let out = render(
            false,
            &[
                Progress::Started { total: 2, already_done: 0 },
                downloading(),
                Progress::Completed {
                    index: 1,
                    total: 2,
                    item_id: "1_abc".into(),
                    bpm: 128.0,
                    key: "8A".into(),
                },
            ],
        );
        assert!(!out.contains('\r'), "carriage returns make a log file unreadable: {out:?}");
        assert!(!out.contains('\u{1b}'), "no ANSI escapes when not a terminal");
        assert!(out.contains("128.00 BPM  8A"));
    }

    #[test]
    fn a_terminal_redraws_the_status_line_in_place() {
        let out = render(true, &[downloading()]);
        assert!(out.starts_with('\r'), "expected an in-place redraw, got {out:?}");
        assert!(out.contains("downloading"));
    }

    #[test]
    fn resuming_says_so_rather_than_looking_like_a_fresh_start() {
        let out = render(false, &[Progress::Started { total: 5, already_done: 400 }]);
        assert!(out.contains("Resuming"), "{out}");
        assert!(out.contains("400"));
    }

    #[test]
    fn a_failure_says_whether_it_will_be_tried_again() {
        let fail = |will_retry| Progress::Failed {
            index: 1,
            total: 1,
            item_id: "1_abc".into(),
            error: "network timeout".into(),
            will_retry,
        };
        assert!(render(false, &[fail(true)]).contains("will retry"));
        assert!(render(false, &[fail(false)]).contains("giving up"));
    }

    #[test]
    fn a_ledger_that_cannot_be_saved_is_reported_loudly() {
        let out = render(
            false,
            &[Progress::LedgerUnsaved { message: "No space left on device".into() }],
        );
        assert!(out.contains("WARNING"), "{out}");
        assert!(out.contains("No space left on device"));
        // The consequence matters more than the error string.
        assert!(out.contains("interrupted"), "must say what is now at risk: {out}");
    }

    #[test]
    fn recovering_from_a_save_failure_is_reported_too() {
        let out = render(false, &[Progress::LedgerSaved]);
        assert!(out.contains("resumable"), "{out}");
    }

    #[test]
    fn the_summary_reports_every_category() {
        let out = render(
            false,
            &[Progress::Finished(Summary {
                analyzed: 10,
                failed: 2,
                skipped: 3,
                needs_review: 1,
            })],
        );
        for expected in ["analysed      10", "failed        2", "skipped       3", "needs review  1"] {
            assert!(out.contains(expected), "missing {expected:?} in:\n{out}");
        }
        // The skip count is meaningless unless it says how to override it.
        assert!(out.contains("--force"));
    }

    #[test]
    fn long_titles_are_trimmed_so_the_redraw_cannot_wrap() {
        let long = "A".repeat(200);
        let out = render(true, &[Progress::Downloading {
            index: 1,
            total: 1,
            item_id: "1_abc".into(),
            title: long,
        }]);
        assert!(out.contains('\u{2026}'), "expected an ellipsis");
        assert!(out.lines().all(|l| l.chars().count() < 100), "line too long to redraw safely");
    }

    #[test]
    fn trimming_counts_characters_not_bytes() {
        // Byte slicing here would panic on a multi-byte boundary.
        let title = "é".repeat(120);
        let out = render(true, &[Progress::Downloading {
            index: 1,
            total: 1,
            item_id: "1_abc".into(),
            title,
        }]);
        assert!(out.contains('\u{2026}'));
    }
}
