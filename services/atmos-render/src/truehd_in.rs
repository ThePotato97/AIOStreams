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
    /// The speaker presentation of what's been pushed since `take_speakers`, for a player playing
    /// it to speakers instead of the binaural render: the highest presentation up to 8 channels,
    /// as FFmpeg decodes TrueHD (`mlpdec.c`: at most the third substream), interleaved in FFmpeg's
    /// channel order (`speaker_mask`), with no dialnorm (FFmpeg applies none). One sample for each
    /// sample rendered, silence included.
    speakers: Vec<f32>,
    /// FFmpeg's channel mask of `speakers` (its `thd_layout`), 0 until a presentation is decoded.
    pub speaker_mask: u64,
    /// For each output channel, its index in the decoded presentation.
    speaker_order: Vec<usize>,
}

/// FFmpeg's channel bit for a TrueHD channel label (`mlp_parse.h`'s `thd_layout`, by the same
/// channel assignment bit the crate reads the label from; the 8-channel assignment's alternate
/// top pair, Tsl/Tsr, is the same bit as Tfl/Tfr, which FFmpeg reads as top front).
fn ffmpeg_bit(label: ChannelLabel) -> u64 {
    use ChannelLabel::*;
    match label {
        L => 1 << 0,
        R => 1 << 1,
        C => 1 << 2,
        LFE => 1 << 3,
        Lb => 1 << 4,
        Rb => 1 << 5,
        Lsc => 1 << 6,
        Rsc => 1 << 7,
        Cb => 1 << 8,
        Ls => 1 << 9,
        Rs => 1 << 10,
        Tc => 1 << 11,
        Tfl | Tsl => 1 << 12,
        Tfc => 1 << 13,
        Tfr | Tsr => 1 << 14,
        Tbl => 1 << 15,
        Tbr => 1 << 17,
        Lw => 1 << 31,
        Rw => 1 << 32,
        Lsd => 1 << 33,
        Rsd => 1 << 34,
        LFE2 => 1 << 35,
    }
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
            speakers: Vec::new(),
            speaker_mask: 0,
            speaker_order: Vec::new(),
        }
    }

    /// The speaker samples since the last call (`speakers`), `speaker_channels` interleaved.
    pub fn take_speakers(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.speakers)
    }

    pub fn speaker_channels(&self) -> usize {
        self.speaker_order.len()
    }

    /// The speaker presentation's channels, in FFmpeg's order (by channel bit).
    fn speaker_layout(&mut self, d: &DecodedAccessUnit) {
        let bits: Vec<u64> = d.channel_labels.iter().map(|&l| ffmpeg_bit(l)).collect();
        let mask = bits.iter().fold(0, |m, b| m | b);
        if mask != self.speaker_mask || self.speaker_order.len() != bits.len() {
            let mut order: Vec<usize> = (0..bits.len()).collect();
            order.sort_by_key(|&i| bits[i]);
            self.speaker_order = order;
            self.speaker_mask = mask;
        }
    }

    /// `n` samples of the speaker presentation: decoded, or silence where there's none.
    fn push_speakers(&mut self, decoded: Option<&DecodedAccessUnit>, n: usize) {
        if let Some(d) = decoded.filter(|d| d.sample_length == n) {
            self.speaker_layout(d);
            let scale = 1.0 / (1u32 << 23) as f32;
            for s in 0..n {
                for &c in &self.speaker_order {
                    self.speakers.push(d.pcm_data[s][c] as f32 * scale);
                }
            }
        } else {
            let len = self.speakers.len() + n * self.speaker_order.len();
            self.speakers.resize(len, 0.0);
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
            self.channel_beds = channels::routed(statics, self.scene.modes, self.scene.speakers);
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
        self.push_speakers(None, n);
    }
}

impl Feed for TrueHd {
    fn set_speakers(&mut self, on: bool) {
        self.scene.speakers = on;
    }

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
                    // FFmpeg's: the highest presentation up to 8 channels
                    let speakers = decoded[..3].iter().rev().flatten().next().cloned();
                    if let Some(d) = chosen {
                        let d = d.clone();
                        let n = d.sample_length;
                        // the speaker layout first, so the lead's silence has its channels
                        if let Some(s) = speakers.as_ref().filter(|_| self.speaker_order.is_empty()) {
                            self.speaker_layout(s);
                        }
                        for _ in 0..std::mem::take(&mut self.lead) {
                            out(Block { start: self.samples, samples: vec![vec![0.0; n]; d.channel_count] });
                            self.samples += n as u64;
                            self.push_speakers(None, n);
                        }
                        self.take(&d, out);
                        self.push_speakers(speakers.as_ref(), n);
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

    fn windows_slots(&self) -> Vec<Option<u16>> {
        if self.atmos == Some(true) {
            self.scene.windows_slots()
        } else {
            channels::windows_slots(&self.channel_beds)
        }
    }

    fn bypassed(&self) -> Vec<bool> {
        if self.atmos == Some(true) {
            Vec::new()
        } else {
            self.channel_beds.iter().map(|s| matches!(s, Static::Bypass(_))).collect()
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
