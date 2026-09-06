//! Bridges the analysis crate to the pipeline's [`Analyzer`] trait.
//!
//! This lives in the CLI rather than in `analyzer-analysis` so that crate stays
//! ignorant of the pipeline, and the pipeline stays ignorant of aubio and
//! libkeyfinder. It is also where analysis failures get classified.

use std::path::Path;

use analyzer_analysis::decode::DecodeError;
use analyzer_analysis::{bpm::BpmError, key::KeyError, AnalysisError};
use analyzer_core::meta::AnalysisResult;
use analyzer_core::pipeline::{Analyzer, Clock, StepError};
use analyzer_core::tempo::{SecondOpinion, TempoHint};

/// Runs the real detectors over a downloaded file.
pub struct FileAnalyzer<'a> {
    clock: &'a dyn Clock,
    version: String,
    second_opinion: SecondOpinion,
}

impl<'a> FileAnalyzer<'a> {
    pub fn new(clock: &'a dyn Clock, version: impl Into<String>) -> FileAnalyzer<'a> {
        FileAnalyzer { clock, version: version.into(), second_opinion: SecondOpinion::default() }
    }

    pub fn with_second_opinion(mut self, policy: SecondOpinion) -> FileAnalyzer<'a> {
        self.second_opinion = policy;
        self
    }
}

impl Analyzer for FileAnalyzer<'_> {
    fn analyze(&self, path: &Path, hint: TempoHint) -> Result<AnalysisResult, StepError> {
        match analyzer_analysis::analyze_file_with(path, self.second_opinion, hint) {
            Ok(analysis) => {
                Ok(analysis.into_result(self.clock.now_iso8601(), self.version.clone()))
            }
            Err(e) => Err(classify(&e)),
        }
    }
}

/// Decide whether an analysis failure deserves another download.
///
/// The asymmetry matters over a long run: retrying a permanent failure wastes a
/// download on every future run forever, while writing off a transient one
/// means a track can never be analysed again. So the rule is "retry when a
/// *different download* could plausibly succeed" — which is exactly the
/// truncated-file case — and give up when the audio itself is the problem.
pub fn classify(error: &AnalysisError) -> StepError {
    let message = error.to_string();
    let retryable = match error {
        // A half-written file from a dropped connection decodes as garbage;
        // fetching it again is likely to work.
        AnalysisError::Decode(DecodeError::Decode(_)) => true,
        // Opening what we just downloaded failed — a full disk or a permissions
        // blip, not a property of the audio.
        AnalysisError::Decode(DecodeError::Open(_)) => true,
        // The codec is not one symphonia supports. A second download of the
        // same video yields the same codec.
        AnalysisError::Decode(DecodeError::Unsupported(_)) => false,
        AnalysisError::Decode(DecodeError::Empty) => false,
        // Running out of memory for aubio's detector is a machine condition.
        AnalysisError::Bpm(BpmError::DetectorUnavailable) => true,
        // The audio is what it is: too short, or has no plausible tempo.
        AnalysisError::Bpm(BpmError::TooShort { .. }) => false,
        AnalysisError::Bpm(BpmError::Implausible { .. }) => false,
        // libkeyfinder is deterministic, so it will fail the same way next time.
        AnalysisError::Key(
            KeyError::Silence
            | KeyError::DetectionFailed
            | KeyError::UnknownKey(_)
            | KeyError::TooShort { .. },
        ) => false,
    };
    if retryable {
        StepError::retryable(message)
    } else {
        StepError::permanent(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_truncated_download_is_worth_fetching_again() {
        let e = AnalysisError::Decode(DecodeError::Decode("bad frame".into()));
        assert!(classify(&e).retryable);
    }

    #[test]
    fn an_unsupported_codec_is_never_retried() {
        // This is the Opus-in-WebM case. Re-downloading gets the same codec, so
        // retrying it would burn a download on every future run forever.
        let e = AnalysisError::Decode(DecodeError::Unsupported("unsupported codec".into()));
        assert!(!classify(&e).retryable);
    }

    #[test]
    fn audio_that_cannot_carry_an_answer_is_permanent() {
        for e in [
            AnalysisError::Decode(DecodeError::Empty),
            AnalysisError::Bpm(BpmError::TooShort { samples: 10 }),
            AnalysisError::Bpm(BpmError::Implausible { bpm: 3.0 }),
            AnalysisError::Key(KeyError::Silence),
            AnalysisError::Key(KeyError::DetectionFailed),
        ] {
            assert!(!classify(&e).retryable, "should be permanent: {e}");
        }
    }

    #[test]
    fn a_machine_level_failure_is_retryable() {
        assert!(classify(&AnalysisError::Bpm(BpmError::DetectorUnavailable)).retryable);
    }

    #[test]
    fn the_message_survives_classification() {
        let e = AnalysisError::Key(KeyError::UnknownKey(99));
        assert_eq!(classify(&e).message, e.to_string());
        assert!(classify(&e).message.contains("99"));
    }
}
