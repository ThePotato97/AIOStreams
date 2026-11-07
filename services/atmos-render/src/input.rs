//! What a decoder hands the renderer, and the slot/block scheduling between them.

use crate::render::{BLOCK, Renderer, SLOT, Source};
use crate::tuning::INPUT_HEADROOM;

/// Decoded audio: one Vec per input channel, all the same length, starting at sample `start`.
pub struct Block {
    pub start: u64,
    pub samples: Vec<Vec<f32>>,
}

pub trait Feed {
    /// Push bitstream bytes; decoded audio comes out through `out`.
    fn push(&mut self, bytes: &[u8], out: &mut dyn FnMut(Block));
    /// The inputs' state at `sample` (start of a renderer block).
    fn sources(&mut self, sample: u64) -> Vec<Source>;
    /// The input has ended: emit what's still buffered.
    fn end(&mut self, _out: &mut dyn FnMut(Block)) {}
}

/// Buffers decoded audio into 64-sample slots and renders them; gains change once per
/// 256-sample block (counted from the first sample). The output is the input's length and
/// lines up with it: the filterbank latency is dropped at the start and flushed at the end.
pub struct Pipeline {
    pub renderer: Renderer,
    pending: Vec<Vec<f32>>,
    /// Stream sample of pending[..][0], and of the first sample ever taken.
    at: u64,
    origin: Option<u64>,
    taken: u64,
    rendered: u64,
    emitted: u64,
}

impl Pipeline {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self { renderer: Renderer::new()?, pending: Vec::new(), at: 0, origin: None, taken: 0, rendered: 0, emitted: 0 })
    }

    pub fn take(&mut self, feed: &mut dyn Feed, block: Block, emit: &mut dyn FnMut(&[f32], &[f32])) {
        if self.origin.is_none() {
            self.origin = Some(block.start);
            self.at = block.start;
        }
        let n = block.samples.first().map(|s| s.len()).unwrap_or(0);
        if self.pending.len() != block.samples.len() {
            // the input count changed: carry what's buffered over as silence
            let have = self.pending.first().map(|p| p.len()).unwrap_or(0);
            self.pending = vec![vec![0.0; have]; block.samples.len()];
        }
        // The Windows encoder's input headroom, then its clip to +/-1, on every sample.
        for (p, s) in self.pending.iter_mut().zip(block.samples) {
            p.extend(s.into_iter().map(|v| (v * INPUT_HEADROOM).clamp(-1.0, 1.0)));
        }
        self.taken += n as u64;
        self.render(feed, emit);
    }

    fn render(&mut self, feed: &mut dyn Feed, emit: &mut dyn FnMut(&[f32], &[f32])) {
        let have = self.pending.first().map(|p| p.len()).unwrap_or(0);
        let origin = self.origin.unwrap_or(0);
        let latency = Renderer::latency() as u64;
        let (mut l, mut r) = ([0f32; SLOT], [0f32; SLOT]);
        let mut offset = 0;
        while have - offset >= SLOT {
            let sample = self.at + offset as u64;
            if (sample - origin) % BLOCK as u64 == 0 {
                let sources = feed.sources(sample);
                self.renderer.set_block(&sources);
            }
            let refs: Vec<&[f32]> = self.pending.iter().map(|p| &p[offset..offset + SLOT]).collect();
            self.renderer.slot(&refs, &mut l, &mut r);
            // output sample k of this slot is input sample (rendered + k - latency)
            for k in 0..SLOT {
                let out_index = self.rendered + k as u64;
                if out_index >= latency && out_index - latency >= self.emitted && self.emitted < self.taken {
                    emit(&l[k..k + 1], &r[k..k + 1]);
                    self.emitted += 1;
                }
            }
            self.rendered += SLOT as u64;
            offset += SLOT;
        }
        for p in self.pending.iter_mut() {
            p.drain(..offset);
        }
        self.at += offset as u64;
    }

    /// At the end: pad with silence so the last input samples come out of the filterbank.
    pub fn finish(&mut self, feed: &mut dyn Feed, emit: &mut dyn FnMut(&[f32], &[f32])) {
        if self.pending.is_empty() {
            return;
        }
        let pad = Renderer::latency() + 2 * SLOT;
        for p in self.pending.iter_mut() {
            p.extend(std::iter::repeat_n(0.0, pad));
        }
        self.render(feed, emit);
    }
}
