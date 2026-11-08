//! What a decoder hands the renderer, and the slot/block scheduling between them.

use crate::render::{BLOCK, Renderer, SLOT, Source};
use crate::speaker_render::SpeakerRenderer;
use crate::tuning::INPUT_HEADROOM;

/// Decoded audio: one Vec per input channel, all the same length, starting at sample `start`.
pub struct Block {
    pub start: u64,
    pub samples: Vec<Vec<f32>>,
}

/// What an input is, for the browser's debug view of the scene.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Element {
    Object,
    /// A bed channel, by its ID (`direct::bed_position`).
    Bed(u32),
    Lfe,
    /// An intermediate spatial format element.
    Isf,
}

pub trait Feed {
    /// Rendering for built-in speakers (`Scene::speakers`): set before the first push, since
    /// it decides how decoded layouts are placed. Off by default.
    fn set_speakers(&mut self, _on: bool) {}
    /// Push bitstream bytes; decoded audio comes out through `out`.
    fn push(&mut self, bytes: &[u8], out: &mut dyn FnMut(Block));
    /// The inputs' state at `sample` (start of a renderer block).
    fn sources(&mut self, sample: u64) -> Vec<Source>;
    /// The input has ended: emit what's still buffered.
    fn end(&mut self, _out: &mut dyn FnMut(Block)) {}
    /// What each input is, in `sources` order (for the debug view; nothing without one).
    fn elements(&self) -> Vec<Element> {
        Vec::new()
    }
}

/// Snapshots of the scene as rendered, for the browser's debug view: every `EVERY` blocks, each
/// input's kind, what the renderer was given for it, and its input level over that block.
pub struct Snapshots {
    /// Closed snapshots, flat: sample (from the first one taken), element count, then per element
    /// `SNAPSHOT_FIELDS` values (see `close`).
    pub data: Vec<f64>,
    open: Option<Open>,
}

struct Open {
    sample: u64,
    sources: Vec<Source>,
    elements: Vec<Element>,
    sums: Vec<f64>,
    count: usize,
}

/// Blocks between snapshots: 1024 samples, about 47 a second.
const EVERY: u64 = 4;
pub const SNAPSHOT_FIELDS: usize = 9;

impl Snapshots {
    fn close(&mut self) {
        let Some(o) = self.open.take() else { return };
        if o.count == 0 {
            return;
        }
        self.data.push(o.sample as f64);
        self.data.push(o.sources.len() as f64);
        for (i, s) in o.sources.iter().enumerate() {
            // kind (0 object, 1 bed, 2 LFE, 3 ISF, -1 unknown), bed ID, render mode (Off 0,
            // Near 1, Far 2, Mid 3; -1 none), active, x, y, z (NaN: none), metadata gain, RMS level
            let (kind, bed) = match o.elements.get(i) {
                Some(Element::Object) => (0.0, 0.0),
                Some(Element::Bed(id)) => (1.0, *id as f64),
                Some(Element::Lfe) => (2.0, 0.0),
                Some(Element::Isf) => (3.0, 0.0),
                None => (-1.0, 0.0),
            };
            let level = (o.sums.get(i).copied().unwrap_or(0.0) / o.count as f64).sqrt();
            let (mode, active, pos, gain) = match *s {
                Source::Positioned { pos, mode, gain, active, .. } => (mode as i32 as f64, active as u8 as f64, pos.map(f64::from), gain as f64),
                Source::Lfe { gain } => (-1.0, 1.0, [f64::NAN; 3], gain as f64),
                Source::Silent => (-1.0, 0.0, [f64::NAN; 3], 0.0),
            };
            self.data.extend_from_slice(&[kind, bed, mode, active, pos[0], pos[1], pos[2], gain, level]);
        }
    }
}

/// What the pipeline renders to: two ears (Dolby Atmos for Headphones) or two built-in speakers
/// (Dolby Atmos for built-in speakers).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Output {
    #[default]
    Binaural,
    Speakers,
}

pub enum Engine {
    Binaural(Renderer),
    Speakers(Box<SpeakerRenderer>),
}

impl Engine {
    fn set_block(&mut self, sources: &[Source]) {
        match self {
            Engine::Binaural(r) => r.set_block(sources),
            Engine::Speakers(r) => r.set_block(sources),
        }
    }
    fn slot(&mut self, inputs: &[&[f32]], left: &mut [f32], right: &mut [f32]) {
        match self {
            Engine::Binaural(r) => r.slot(inputs, left, right),
            Engine::Speakers(r) => r.slot(inputs, left, right),
        }
    }
}

/// Buffers decoded audio into 64-sample slots and renders them; gains change once per
/// 256-sample block (counted from the first sample). The output is the input's length and
/// lines up with it: the filterbank latency is dropped at the start and flushed at the end.
/// Both outputs have the same latency (`Renderer::latency`).
pub struct Pipeline {
    pub renderer: Engine,
    pending: Vec<Vec<f32>>,
    /// Stream sample of pending[..][0], and of the first sample ever taken.
    at: u64,
    origin: Option<u64>,
    taken: u64,
    rendered: u64,
    emitted: u64,
    /// Kept only for the debug view (`debug`).
    pub snapshots: Option<Snapshots>,
}

impl Pipeline {
    pub fn new() -> anyhow::Result<Self> {
        Self::with_output(Output::Binaural)
    }

    pub fn with_output(output: Output) -> anyhow::Result<Self> {
        let renderer = match output {
            Output::Binaural => Engine::Binaural(Renderer::new()?),
            Output::Speakers => Engine::Speakers(Box::new(SpeakerRenderer::new())),
        };
        Ok(Self { renderer, pending: Vec::new(), at: 0, origin: None, taken: 0, rendered: 0, emitted: 0, snapshots: None })
    }

    /// Keeps snapshots of the scene for the debug view, or stops.
    pub fn debug(&mut self, on: bool) {
        self.snapshots = on.then(|| Snapshots { data: Vec::new(), open: None });
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
                if let Some(snap) = self.snapshots.as_mut() {
                    snap.close();
                    if ((sample - origin) / BLOCK as u64) % EVERY == 0 {
                        let n = self.pending.len();
                        snap.open = Some(Open { sample: sample - origin, elements: feed.elements(), sources, sums: vec![0.0; n], count: 0 });
                    }
                }
            }
            let refs: Vec<&[f32]> = self.pending.iter().map(|p| &p[offset..offset + SLOT]).collect();
            if let Some(o) = self.snapshots.as_mut().and_then(|s| s.open.as_mut()) {
                for (sum, r) in o.sums.iter_mut().zip(&refs) {
                    *sum += r.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>();
                }
                o.count += SLOT;
            }
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

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    use crate::direct::Mode;

    /// An object at the front left at half level, and an LFE at a quarter.
    struct Two;
    impl Feed for Two {
        fn push(&mut self, _: &[u8], _: &mut dyn FnMut(Block)) {}
        fn sources(&mut self, _: u64) -> Vec<Source> {
            vec![Source::Positioned { pos: [0.0, 0.0, 0.0], mode: Mode::Near, gain: 1.0, active: true, ramp: crate::render::BED_RAMP, zone: 0 }, Source::Lfe { gain: 1.0 }]
        }
        fn elements(&self) -> Vec<Element> {
            vec![Element::Object, Element::Lfe]
        }
    }

    #[test]
    fn snapshots_say_what_was_rendered_and_how_loud() {
        let mut p = Pipeline::new().unwrap();
        p.debug(true);
        let n = 48_000;
        let block = Block { start: 0, samples: vec![vec![0.5; n], vec![-0.25; n]] };
        p.take(&mut Two, block, &mut |_, _| {});
        let d = &p.snapshots.as_ref().unwrap().data;
        let size = 2 + 2 * SNAPSHOT_FIELDS;
        // one opened every 1024 samples, closed after its 256-sample block: 0, 1024 .. 47104
        assert_eq!(d.len() / size, 47);
        assert_eq!(d.len() % size, 0);
        let second = &d[size..2 * size];
        assert_eq!(second[0], 1024.0);
        assert_eq!(second[1], 2.0);
        let (object, lfe) = (&second[2..11], &second[11..20]);
        // object, Near, active, at (0, 0, 0); its level after the input headroom
        assert_eq!(&object[..8], &[0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert!((object[8] - 0.5 * crate::tuning::INPUT_HEADROOM as f64).abs() < 1e-6);
        assert_eq!(lfe[0], 2.0);
        assert_eq!(lfe[2], -1.0);
        assert!(lfe[4].is_nan());
        assert!((lfe[8] - 0.25 * crate::tuning::INPUT_HEADROOM as f64).abs() < 1e-6);
    }
}
