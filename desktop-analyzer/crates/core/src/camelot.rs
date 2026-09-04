//! Musical key <-> Camelot conversion, plus the colour wheel both this tool and
//! the web app render.
//!
//! The web app only ever parses Camelot notation (`1A`-`12B`, see
//! `src/harmonic.js:parseCamelot`), and its track-metadata editor offers nothing
//! else in its dropdown. libkeyfinder, on the other hand, reports musical keys
//! ("A minor"). Everything crossing that boundary goes through here.
//!
//! Colours are *derived*, not copied from any DJ product: each wheel position
//! gets an evenly spaced hue, minor (A) keys render deeper and major (B) keys
//! lighter, so relative major/minor pairs read as the same colour family — which
//! is the whole point of the wheel.

use std::fmt;

/// Semitone offsets from C, used to place a key on the circle of fifths.
const PITCH_NAMES: [(&str, u8); 21] = [
    ("c", 0),
    ("b#", 0),
    ("c#", 1),
    ("db", 1),
    ("d", 2),
    ("d#", 3),
    ("eb", 3),
    ("e", 4),
    ("fb", 4),
    ("f", 5),
    ("e#", 5),
    ("f#", 6),
    ("gb", 6),
    ("g", 7),
    ("g#", 8),
    ("ab", 8),
    ("a", 9),
    ("a#", 10),
    ("bb", 10),
    ("b", 11),
    ("cb", 11),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Major,
    Minor,
}

/// A key as libkeyfinder reports it: a tonic pitch class plus a mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MusicalKey {
    /// Semitones above C (0-11).
    pub pitch: u8,
    pub mode: Mode,
}

/// A position on the Camelot wheel: 1-12 paired with A (minor) or B (major).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Camelot {
    pub number: u8,
    pub mode: Mode,
}

impl MusicalKey {
    pub fn new(pitch: u8, mode: Mode) -> Self {
        MusicalKey { pitch: pitch % 12, mode }
    }

    /// Parse the shapes libkeyfinder and humans produce: "A minor", "Am",
    /// "A min", "F# major", "Gb maj", "Ebm", "C".  A bare tonic means major.
    pub fn parse(raw: &str) -> Option<MusicalKey> {
        let s = raw.trim().to_ascii_lowercase();
        if s.is_empty() || s == "silence" || s == "unknown" {
            return None;
        }
        // Normalise unicode accidentals and separators into the ascii forms
        // the pitch table uses.
        let s = s
            .replace('\u{266f}', "#")
            .replace('\u{266d}', "b")
            .replace(['-', '_'], " ");

        // Split the tonic (longest matching prefix) from the mode suffix.
        let mut best: Option<(&str, u8)> = None;
        for (name, pitch) in PITCH_NAMES {
            if s.starts_with(name) && best.is_none_or(|(b, _)| name.len() > b.len()) {
                best = Some((name, pitch));
            }
        }
        let (name, pitch) = best?;
        let suffix = s[name.len()..].trim();

        let mode = match suffix {
            "" | "maj" | "major" | "M" => Mode::Major,
            "m" | "min" | "minor" => Mode::Minor,
            other => {
                if other.starts_with("min") {
                    Mode::Minor
                } else if other.starts_with("maj") {
                    Mode::Major
                } else {
                    return None;
                }
            }
        };
        Some(MusicalKey::new(pitch, mode))
    }

    pub fn to_camelot(self) -> Camelot {
        // Position on the circle of fifths. 7 is its own inverse mod 12, so
        // multiplying the pitch class by 7 maps semitones back to fifths.
        // A minor key sits at the same wheel number as the major key three
        // semitones above it (its relative major): Am and C both land on 8.
        let relative_major = match self.mode {
            Mode::Major => self.pitch,
            Mode::Minor => (self.pitch + 3) % 12,
        };
        let fifths = (relative_major as u16 * 7) % 12;
        let number = ((fifths + 7) % 12) as u8 + 1;
        Camelot { number, mode: self.mode }
    }

    /// Canonical display name, e.g. "F# minor".
    pub fn name(self) -> String {
        const SHARP_NAMES: [&str; 12] = [
            "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
        ];
        let mode = match self.mode {
            Mode::Major => "major",
            Mode::Minor => "minor",
        };
        format!("{} {}", SHARP_NAMES[self.pitch as usize], mode)
    }
}

impl Camelot {
    pub fn new(number: u8, mode: Mode) -> Option<Camelot> {
        if (1..=12).contains(&number) {
            Some(Camelot { number, mode })
        } else {
            None
        }
    }

    /// Parse `1A`-`12B`, matching `parseCamelot` in the web app.
    pub fn parse(raw: &str) -> Option<Camelot> {
        let s = raw.trim();
        let (digits, letter) = s.split_at(s.len().checked_sub(1)?);
        let number: u8 = digits.parse().ok()?;
        let mode = match letter {
            "A" | "a" => Mode::Minor,
            "B" | "b" => Mode::Major,
            _ => return None,
        };
        Camelot::new(number, mode)
    }

    pub fn code(self) -> String {
        let letter = match self.mode {
            Mode::Minor => 'A',
            Mode::Major => 'B',
        };
        format!("{}{}", self.number, letter)
    }

    /// The musical key this wheel position denotes.
    pub fn to_musical(self) -> MusicalKey {
        // Invert to_camelot: number -> fifths -> relative major pitch class.
        let fifths = (self.number as u16 + 12 - 1 + 12 - 7) % 12;
        let relative_major = ((fifths * 7) % 12) as u8;
        let pitch = match self.mode {
            Mode::Major => relative_major,
            Mode::Minor => (relative_major + 12 - 3) % 12,
        };
        MusicalKey::new(pitch, self.mode)
    }

    /// Keys that mix harmonically: same key, one step either way on the wheel,
    /// and the relative major/minor. Mirrors `compatibleKeys` in harmonic.js.
    pub fn compatible(self) -> Vec<Camelot> {
        let next = (self.number % 12) + 1;
        let prev = ((self.number + 10) % 12) + 1;
        let flipped = match self.mode {
            Mode::Major => Mode::Minor,
            Mode::Minor => Mode::Major,
        };
        vec![
            self,
            Camelot { number: next, mode: self.mode },
            Camelot { number: prev, mode: self.mode },
            Camelot { number: self.number, mode: flipped },
        ]
    }

    /// Hex colour for this wheel position. Relative major/minor pairs share a
    /// hue; minor keys are deeper, major keys lighter.
    pub fn color(self) -> String {
        // Evenly space the twelve positions around the colour circle. The
        // offset only decides where the wheel "starts"; 1A/1B landing in the
        // blues keeps warm colours around 7-9, matching how DJs read the wheel.
        let hue = ((self.number as f32 - 1.0) * 30.0 + 210.0) % 360.0;
        let (sat, light) = match self.mode {
            Mode::Minor => (0.62, 0.46),
            Mode::Major => (0.72, 0.62),
        };
        hsl_to_hex(hue, sat, light)
    }
}

impl fmt::Display for Camelot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.code())
    }
}

/// Every wheel position, in the order a wheel renders them: 1A, 1B, 2A, 2B...
pub fn wheel() -> Vec<Camelot> {
    let mut out = Vec::with_capacity(24);
    for n in 1..=12u8 {
        out.push(Camelot { number: n, mode: Mode::Minor });
        out.push(Camelot { number: n, mode: Mode::Major });
    }
    out
}

fn hsl_to_hex(h: f32, s: f32, l: f32) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let h_prime = h / 60.0;
    let x = c * (1.0 - (h_prime % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match h_prime as u8 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let to_byte = |v: f32| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02X}{:02X}{:02X}", to_byte(r1), to_byte(g1), to_byte(b1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camelot_of(key: &str) -> String {
        MusicalKey::parse(key).unwrap().to_camelot().code()
    }

    #[test]
    fn maps_the_reference_camelot_wheel() {
        // The anchors every DJ tool agrees on.
        assert_eq!(camelot_of("C major"), "8B");
        assert_eq!(camelot_of("A minor"), "8A");
        assert_eq!(camelot_of("G major"), "9B");
        assert_eq!(camelot_of("E minor"), "9A");
        assert_eq!(camelot_of("D minor"), "7A");
        assert_eq!(camelot_of("F major"), "7B");
        assert_eq!(camelot_of("B major"), "1B");
        assert_eq!(camelot_of("G# minor"), "1A");
        assert_eq!(camelot_of("F# major"), "2B");
        assert_eq!(camelot_of("Eb minor"), "2A");
        assert_eq!(camelot_of("Bb major"), "6B");
        assert_eq!(camelot_of("G minor"), "6A");
    }

    #[test]
    fn parses_the_shapes_libkeyfinder_and_humans_produce() {
        assert_eq!(camelot_of("Am"), "8A");
        assert_eq!(camelot_of("a min"), "8A");
        assert_eq!(camelot_of("A MINOR"), "8A");
        assert_eq!(camelot_of("C"), "8B");
        assert_eq!(camelot_of("Db major"), "3B");
        assert_eq!(camelot_of("C# major"), "3B");
        assert_eq!(camelot_of("F\u{266f} minor"), "11A");
        assert!(MusicalKey::parse("silence").is_none());
        assert!(MusicalKey::parse("").is_none());
        assert!(MusicalKey::parse("H minor").is_none());
    }

    #[test]
    fn camelot_round_trips_through_musical_keys() {
        for c in wheel() {
            let back = c.to_musical().to_camelot();
            assert_eq!(back, c, "round trip failed for {}", c.code());
        }
    }

    #[test]
    fn parses_its_own_codes() {
        for c in wheel() {
            assert_eq!(Camelot::parse(&c.code()), Some(c));
        }
        assert!(Camelot::parse("13A").is_none());
        assert!(Camelot::parse("0A").is_none());
        assert!(Camelot::parse("8C").is_none());
        assert!(Camelot::parse("").is_none());
    }

    #[test]
    fn compatible_keys_match_the_web_apps_rules() {
        let c = Camelot::parse("8A").unwrap();
        let codes: Vec<String> = c.compatible().iter().map(|k| k.code()).collect();
        assert_eq!(codes, vec!["8A", "9A", "7A", "8B"]);

        // Wrap-around at both ends of the wheel.
        let c = Camelot::parse("12B").unwrap();
        let codes: Vec<String> = c.compatible().iter().map(|k| k.code()).collect();
        assert_eq!(codes, vec!["12B", "1B", "11B", "12A"]);

        let c = Camelot::parse("1A").unwrap();
        let codes: Vec<String> = c.compatible().iter().map(|k| k.code()).collect();
        assert_eq!(codes, vec!["1A", "2A", "12A", "1B"]);
    }

    #[test]
    fn colours_are_valid_hex_and_pair_relative_keys() {
        for c in wheel() {
            let hex = c.color();
            assert_eq!(hex.len(), 7, "{} produced {}", c.code(), hex);
            assert!(hex.starts_with('#'));
            assert!(hex[1..].chars().all(|ch| ch.is_ascii_hexdigit()));
        }
        // 24 positions, 12 hues: every colour is still distinct.
        let mut all: Vec<String> = wheel().iter().map(|c| c.color()).collect();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 24);
    }
}
