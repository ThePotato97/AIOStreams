//! TrueHD input: frames through the truehd crate's extractor, parser and decoder. The Atmos
//! presentation (3) gives its elements and OAMD; without it the highest channel presentation is
//! rendered as beds at Dolby's channel positions.

use truehd::process::MAX_PRESENTATIONS;
use truehd::process::decode::{DecodedAccessUnit, Decoder};
use truehd::process::extract::Extractor;
use truehd::process::parse::Parser;
use truehd::structs::channel::ChannelLabel;
use truehd::utils::errors::ExtractError;

use crate::channels::{self, Static};
use crate::input::{Block, Feed};
use crate::objects::{Modes, Scene};
use crate::render::Source;

const ALL: [bool; MAX_PRESENTATIONS] = [true; MAX_PRESENTATIONS];

pub struct TrueHd {
    extractor: Extractor,
    parser: Parser,
    decoder: Decoder,
    scene: Scene,
    /// Where a channel presentation's channels (no OAMD) are placed.
    channel_beds: Vec<Static>,
    atmos: Option<bool>,
    /// Dialnorm per presentation (2, 6, 8 and 16 channels), from the last major sync.
    dialnorm: [u8; 4],
    samples: u64,
    last_len: usize,
    resyncing: bool,
    /// Access units before the first decodable one (a stream that starts mid-way, as after a
    /// seek): they come out as silence, so the output keeps the input's timing.
    lead: usize,
}

/// Where a TrueHD channel label goes, as the Windows encoder's static slots (`channels.rs`).
/// Labels Windows has no slot for are marked [I].
fn label_static(label: ChannelLabel) -> Static {
    use ChannelLabel::*;
    match label {
        L => Static::Bed(1),
        R => Static::Bed(2),
        C => Static::Bed(3),
        LFE | LFE2 => Static::Lfe,
        Ls => Static::Bed(5),
        Rs => Static::Bed(6),
        Lb => Static::Bed(7),
        Rb => Static::Bed(8),
        Cb => Static::At([0.5, 1.0, 0.0]), // back centre, as the encoder's slot 16
        Tfl => Static::Bed(9),
        Tfr => Static::Bed(10),
        Tbl => Static::Bed(13),
        Tbr => Static::Bed(14),
        // No Windows slot: Dolby's bed table [I].
        Tsl => Static::Bed(11),
        Tsr => Static::Bed(12),
        Lw => Static::Bed(15),
        Rw => Static::Bed(16),
        // No Windows slot and no bed ID: at their labels' places [I].
        Lsd => Static::Bed(5),
        Rsd => Static::Bed(6),
        Lsc => Static::At([0.25, 0.0, 0.0]),
        Rsc => Static::At([0.75, 0.0, 0.0]),
        Tc => Static::At([0.5, 0.5, 1.0]),
        Tfc => Static::At([0.5, 0.0, 1.0]),
    }
}

impl TrueHd {
    pub fn new(modes: Modes) -> Self {
        let mut parser = Parser::default();
        parser.set_required_presentations(&ALL);
        Self {
            extractor: Extractor::default(),
            parser,
            decoder: Decoder::default(),
            scene: Scene::new(modes),
            channel_beds: Vec::new(),
            atmos: None,
            dialnorm: [0; 4],
            samples: 0,
            last_len: 40,
            resyncing: true,
            lead: 0,
        }
    }

    fn take(&mut self, decoded: &DecodedAccessUnit, out: &mut dyn FnMut(Block)) {
        let n = decoded.sample_length;
        let ch = decoded.channel_count;
        for p in &decoded.oamd {
            self.scene.update(p, self.samples);
        }
        if self.atmos == Some(false) && self.channel_beds.len() != ch {
            let statics = decoded.channel_labels.iter().map(|&l| label_static(l)).collect();
            self.channel_beds = channels::retyped(statics, self.scene.modes);
        }
        // The Reference Player's dialnorm (both loudness settings: Windows doesn't decode TrueHD):
        // the decoded presentation's, DN - 31 dB.
        let dn = if self.atmos == Some(true) {
            self.dialnorm[3]
        } else {
            match ch {
                2 => self.dialnorm[0],
                6 => self.dialnorm[1],
                _ => self.dialnorm[2],
            }
        };
        let scale = crate::loudness::truehd_dialnorm(dn) / (1u32 << 23) as f32;
        let samples: Vec<Vec<f32>> = (0..ch)
            .map(|c| (0..n).map(|s| decoded.pcm_data[s][c] as f32 * scale).collect())
            .collect();
        self.last_len = n;
        out(Block { start: self.samples, samples });
        self.samples += n as u64;
    }

    fn silence(&mut self, out: &mut dyn FnMut(Block)) {
        let ch = if self.atmos == Some(true) { self.scene.inputs.len() } else { self.channel_beds.len() };
        if ch == 0 {
            return;
        }
        let n = self.last_len;
        out(Block { start: self.samples, samples: vec![vec![0.0; n]; ch] });
        self.samples += n as u64;
    }
}

impl Feed for TrueHd {
    fn push(&mut self, bytes: &[u8], out: &mut dyn FnMut(Block)) {
        self.extractor.push_bytes(bytes);
        loop {
            let frame = match self.extractor.next() {
                Some(Ok(f)) => f,
                Some(Err(ExtractError::InsufficientData)) | None => break,
                Some(Err(_)) => continue, // the extractor resyncs itself
            };
            if self.resyncing && !frame.is_major_sync() {
                // nothing decodes before the first major sync
                if self.samples == 0 {
                    self.lead += 1;
                }
                continue;
            }
            let Some(au) = self.parser.parse_recovering(&frame) else {
                self.silence(out);
                continue;
            };
            if let Some(cm) = au.major_sync_info.as_ref().and_then(|ms| ms.channel_meaning.fba()) {
                let sixteen = cm.extra_channel_meaning.as_ref().map(|e| e.sixteench_dialogue_norm).unwrap_or(0);
                self.dialnorm = [cm.twoch_dialogue_norm, cm.sixch_dialogue_norm, cm.eightch_dialogue_norm, sixteen];
            }
            match self.decoder.decode_presentations(&au, &ALL) {
                Ok(decoded) => {
                    self.resyncing = false;
                    // Atmos is the presence of presentation 3, whether or not this access unit
                    // carries OAMD (after a seek the first ones may not).
                    if self.atmos.is_none() {
                        self.atmos = Some(decoded[3].is_some());
                    }
                    let chosen = if self.atmos == Some(true) {
                        decoded[3].as_ref()
                    } else {
                        decoded.iter().rev().flatten().next()
                    };
                    if let Some(d) = chosen {
                        let d = d.clone();
                        for _ in 0..std::mem::take(&mut self.lead) {
                            out(Block { start: self.samples, samples: vec![vec![0.0; d.sample_length]; d.channel_count] });
                            self.samples += d.sample_length as u64;
                        }
                        self.take(&d, out);
                    }
                }
                Err(_) => {
                    // resume at the next major sync; keep time with silence
                    self.decoder.reset_for_next_major_sync();
                    self.parser.reset_for_next_major_sync();
                    self.silence(out);
                }
            }
        }
    }

    fn elements(&self) -> Vec<crate::input::Element> {
        if self.atmos == Some(true) {
            self.scene.elements()
        } else {
            self.channel_beds.iter().map(|&s| channels::element(s)).collect()
        }
    }

    fn sources(&mut self, sample: u64) -> Vec<Source> {
        if self.atmos == Some(true) {
            self.scene.advance(sample);
            // Until the first OAMD the inputs are unknown: silent.
            self.scene.sources()
        } else {
            self.channel_beds.iter().map(|&s| channels::source(s, self.scene.modes)).collect()
        }
    }
}
