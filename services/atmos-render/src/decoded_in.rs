//! Decoded channel input: a codec that carries channels only, DTS (with its DTS-HD extensions),
//! decoded by FFmpeg's decoder with its default options. Natively an FFmpeg child decodes the bytes
//! the renderer reads; in the browser libav.js (the same decoder) does, and the caller pushes its
//! PCM in (`push_pcm`). Windows has no decoder of its own for these: a player decodes them and
//! hands Windows the PCM, which it renders as any channel stream (`channels.rs`, Windows' routing,
//! §10). The PCM here is FFmpeg's, as a player built on FFmpeg would hand over.

use std::io::Write;

use crate::channels::{self, Static};
use crate::eac3_in::{Decoder, Pcm};
use crate::input::{Block, Feed};
use crate::objects::Modes;
use crate::render::Source;

pub struct Decoded {
    /// None: the caller decodes and pushes the PCM (`push_pcm`).
    decoder: Option<Decoder>,
    layout: Option<(usize, u32)>,
    /// Decoded samples not yet emitted (under one frame, between pushes).
    pcm: Vec<f32>,
    modes: Modes,
    speakers: bool,
    samples: u64,
    /// Each channel's static, routed (`channels::routed`).
    statics: Vec<Static>,
    /// The channels' Windows slots (`channels::windows_slots_of`).
    slots: Vec<Option<u16>>,
}

impl Decoded {
    /// `ffmpeg` decodes raw `format` (FFmpeg's demuxer name, e.g. "dts") with its defaults.
    pub fn new(ffmpeg: &str, format: &str, modes: Modes) -> anyhow::Result<Self> {
        let mut feed = Self::external(modes);
        feed.decoder = Some(Decoder::spawn(ffmpeg, &[], format)?);
        Ok(feed)
    }

    /// A feed whose PCM the caller decodes (FFmpeg's decoder, its defaults) and pushes in with
    /// `push_pcm`.
    pub fn external(modes: Modes) -> Self {
        Self {
            decoder: None,
            layout: None,
            pcm: Vec::new(),
            modes,
            speakers: false,
            samples: 0,
            statics: Vec::new(),
            slots: Vec::new(),
        }
    }

    fn set_layout(&mut self, channels: usize, mask: u32) {
        if self.layout == Some((channels, mask)) {
            return;
        }
        // what's left of the old layout is under one frame: dropped
        self.pcm.clear();
        self.layout = Some((channels, mask));
        self.statics = channels::routed(channels::wav_mask(mask), self.modes, self.speakers);
        self.slots = channels::windows_slots_of(channels::wav_mask(mask));
    }

    /// The decoder's output, in order: interleaved f32 in WAV channel order (FFmpeg's), `channels`
    /// channels with the WAV/FFmpeg channel mask `mask`.
    pub fn push_pcm(&mut self, channels: usize, mask: u32, samples: &[f32], out: &mut dyn FnMut(Block)) {
        self.set_layout(channels, mask);
        self.pcm.extend_from_slice(samples);
        self.emit(out);
    }

    /// Every whole frame decoded so far, as one block.
    fn emit(&mut self, out: &mut dyn FnMut(Block)) {
        let Some((channels, _)) = self.layout else { return };
        if channels == 0 {
            self.pcm.clear();
            return;
        }
        let frames = self.pcm.len() / channels;
        if frames == 0 {
            return;
        }
        let samples = (0..channels)
            .map(|c| (0..frames).map(|f| self.pcm[f * channels + c]).collect())
            .collect();
        self.pcm.drain(..frames * channels);
        out(Block { start: self.samples, samples });
        self.samples += frames as u64;
    }

    /// Take what the decoder has sent; with `wait`, until its output closes.
    fn drain(&mut self, wait: bool, out: &mut dyn FnMut(Block)) {
        loop {
            let Some(decoder) = self.decoder.as_ref() else { return };
            let msg = if wait {
                match decoder.pcm.recv() {
                    Ok(m) => m,
                    Err(_) => return,
                }
            } else {
                match decoder.pcm.try_recv() {
                    Ok(m) => m,
                    Err(_) => return,
                }
            };
            match msg {
                Pcm::Layout { channels, mask } => self.set_layout(channels, mask),
                Pcm::Samples(v) => {
                    self.pcm.extend(v);
                    self.emit(out);
                }
            }
        }
    }
}

impl Feed for Decoded {
    fn set_speakers(&mut self, on: bool) {
        self.speakers = on;
    }

    fn push(&mut self, bytes: &[u8], out: &mut dyn FnMut(Block)) {
        if let Some(stdin) = self.decoder.as_mut().and_then(|d| d.stdin.as_mut()) {
            let _ = stdin.write_all(bytes);
        }
        self.drain(false, out);
    }

    fn end(&mut self, out: &mut dyn FnMut(Block)) {
        if let Some(d) = self.decoder.as_mut() {
            drop(d.stdin.take()); // EOF to the decoder
        }
        self.drain(true, out);
        if let Some(mut d) = self.decoder.take() {
            d.finish();
        }
    }

    fn elements(&self) -> Vec<crate::input::Element> {
        channels::elements(&self.statics)
    }

    fn windows_slots(&self) -> Vec<Option<u16>> {
        self.slots.clone()
    }

    fn bypassed(&self) -> Vec<bool> {
        self.statics.iter().map(|s| matches!(s, Static::Bypass(_))).collect()
    }

    fn sources(&mut self, _sample: u64) -> Vec<Source> {
        self.statics.iter().map(|&s| channels::source(s, self.modes)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::Element;

    #[test]
    fn channels_come_out_as_blocks_in_order_and_whole_frames() {
        let mut feed = Decoded::external(Modes::Windows);
        let mut blocks = Vec::new();
        // 5.1 (side), 3 frames and a half pushed in two parts
        let pcm: Vec<f32> = (0..21).map(|i| i as f32).collect();
        feed.push_pcm(6, 0x60F, &pcm[..9], &mut |b| blocks.push(b));
        feed.push_pcm(6, 0x60F, &pcm[9..], &mut |b| blocks.push(b));
        assert_eq!(blocks.len(), 2);
        assert_eq!((blocks[0].start, blocks[0].samples[0].len()), (0, 1));
        assert_eq!((blocks[1].start, blocks[1].samples[0].len()), (1, 2));
        assert_eq!(blocks[1].samples[3], vec![9.0, 15.0]);
        // the LFE (WAV's fourth) is an LFE; the rest are channels at Windows' positions
        let elements = feed.elements();
        assert_eq!(elements.len(), 6);
        assert_eq!(elements[3], Element::Lfe);
        assert_eq!(feed.sources(0).len(), 6);
        assert_eq!(feed.windows_slots().len(), 6);
    }

    #[test]
    fn stereo_takes_the_bypass_as_any_stereo_stream() {
        let mut feed = Decoded::external(Modes::Windows);
        feed.push_pcm(2, 0x3, &[0.5, -0.5], &mut |_| {});
        assert_eq!(feed.bypassed(), vec![true, true]);
    }
}
