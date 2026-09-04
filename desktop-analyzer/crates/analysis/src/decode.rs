//! Turning whatever yt-dlp produced into mono f32 samples.
//!
//! Decoding happens in-process with symphonia (pure Rust, handles m4a/aac,
//! mp3, ogg/vorbis, flac and wav) rather than shelling out to ffmpeg. That
//! keeps the shipped app to one binary plus the yt-dlp sidecar, which is the
//! whole point of bundling a sidecar in the first place.

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug)]
pub struct DecodedAudio {
    /// Interleaved channels collapsed to mono.
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

impl DecodedAudio {
    pub fn duration_seconds(&self) -> f64 {
        self.samples.len() as f64 / self.sample_rate.max(1) as f64
    }
}

#[derive(Debug)]
pub enum DecodeError {
    Open(std::io::Error),
    /// Nothing symphonia recognised, or no audio track inside.
    Unsupported(String),
    Decode(String),
    Empty,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::Open(e) => write!(f, "could not open audio file: {e}"),
            DecodeError::Unsupported(s) => write!(f, "unsupported audio: {s}"),
            DecodeError::Decode(s) => write!(f, "decode failed: {s}"),
            DecodeError::Empty => write!(f, "audio file contained no samples"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// Decode a file to mono f32.
pub fn decode_file(path: &Path) -> Result<DecodedAudio, DecodeError> {
    let file = File::open(path).map_err(DecodeError::Open)?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| DecodeError::Unsupported(e.to_string()))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| DecodeError::Unsupported("no audio track".into()))?;
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| DecodeError::Unsupported(e.to_string()))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut buffer: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Both of these mean "the stream ended", in different ways.
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(DecodeError::Decode(e.to_string())),
        };
        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                if sample_rate == 0 {
                    sample_rate = spec.rate;
                }
                let buf = buffer.get_or_insert_with(|| {
                    SampleBuffer::<f32>::new(decoded.capacity() as u64, spec)
                });
                buf.copy_interleaved_ref(decoded);

                let channels = spec.channels.count().max(1);
                if channels == 1 {
                    samples.extend_from_slice(buf.samples());
                } else {
                    // Average the channels; key and tempo detection both want mono.
                    for frame in buf.samples().chunks_exact(channels) {
                        samples.push(frame.iter().sum::<f32>() / channels as f32);
                    }
                }
            }
            // A damaged packet mid-stream is worth skipping, not failing on —
            // YouTube rips are not always clean.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(DecodeError::Decode(e.to_string())),
        }
    }

    if samples.is_empty() || sample_rate == 0 {
        return Err(DecodeError::Empty);
    }
    Ok(DecodedAudio { samples, sample_rate })
}
