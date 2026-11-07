//! TrueHD input: frames through the truehd crate's extractor, parser and decoder. The Atmos
//! presentation (3) gives its elements and OAMD; without it the highest channel presentation is
//! rendered as beds at Dolby's channel positions.

use truehd::process::MAX_PRESENTATIONS;
use truehd::process::decode::{DecodedAccessUnit, Decoder};
use truehd::process::extract::Extractor;
use truehd::process::parse::Parser;
use truehd::structs::channel::ChannelLabel;
use truehd::utils::errors::ExtractError;

use crate::input::{Block, Feed};
use crate::objects::{Kind, Scene};
use crate::direct::Mode;
use crate::render::Source;

const ALL: [bool; MAX_PRESENTATIONS] = [true; MAX_PRESENTATIONS];

pub struct TrueHd {
    extractor: Extractor,
    parser: Parser,
    decoder: Decoder,
    scene: Scene,
    /// Bed IDs of a channel presentation (no OAMD), per channel; None = LFE.
    channel_beds: Vec<Option<u32>>,
    atmos: Option<bool>,
    samples: u64,
    last_len: usize,
    resyncing: bool,
    /// Access units before the first decodable one (a stream that starts mid-way, as after a
    /// seek): they come out as silence, so the output keeps the input's timing.
    lead: usize,
}

/// Dolby channel ID of a TrueHD channel label (None for LFE). Labels outside Dolby's bed table
/// get the nearest of its positions [I].
fn label_id(label: ChannelLabel) -> Option<u32> {
    use ChannelLabel::*;
    Some(match label {
        L => 1,
        R => 2,
        C | Cb | Tc | Tfc => 3,
        LFE | LFE2 => return None,
        Ls | Lsd => 5,
        Rs | Rsd => 6,
        Lb => 7,
        Rb => 8,
        Tfl => 9,
        Tfr => 10,
        Tsl => 11,
        Tsr => 12,
        Tbl => 13,
        Tbr => 14,
        Lw | Lsc => 15,
        Rw | Rsc => 16,
    })
}

impl TrueHd {
    pub fn new() -> Self {
        let mut parser = Parser::default();
        parser.set_required_presentations(&ALL);
        Self {
            extractor: Extractor::default(),
            parser,
            decoder: Decoder::default(),
            scene: Scene::default(),
            channel_beds: Vec::new(),
            atmos: None,
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
            let ids: Vec<Option<u32>> = decoded.channel_labels.iter().map(|&l| label_id(l)).collect();
            let has = |id| ids.contains(&Some(id));
            let retype = has(5) && has(6) && !has(7) && !has(8);
            self.channel_beds = ids
                .into_iter()
                .map(|id| id.map(|i| if retype && (i == 5 || i == 6) { i + 2 } else { i }))
                .collect();
        }
        let scale = 1.0 / (1u32 << 23) as f32;
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

    fn sources(&mut self, sample: u64) -> Vec<Source> {
        if self.atmos == Some(true) {
            self.scene.advance(sample);
            // Until the first OAMD the inputs are unknown: silent.
            self.scene
                .inputs
                .iter()
                .map(|i| {
                    let (pos, gain) = i.state(sample);
                    match i.kind {
                        Kind::Lfe => Source::Lfe { gain },
                        _ => Source::Positioned { pos, mode: i.mode, gain },
                    }
                })
                .collect()
        } else {
            self.channel_beds
                .iter()
                .map(|id| match id {
                    None => Source::Lfe { gain: 1.0 },
                    Some(id) => Source::Positioned {
                        pos: crate::direct::bed_position(*id).unwrap(),
                        mode: Mode::Mid,
                        gain: 1.0,
                    },
                })
                .collect()
        }
    }
}
