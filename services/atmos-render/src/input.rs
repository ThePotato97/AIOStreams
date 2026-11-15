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
    /// One of the stereo-bypass inputs (0 left, 1 right): summed into output L/R, never rendered
    /// in the room (E slots 17/18).
    Bypass(usize),
    /// The second LFE.
    Lfe2,
    /// A channel with no bed ID, by its code (`channels::Channel`).
    Channel(u32),
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
    /// Each input's slot in Windows' renderer, in `sources` order, for the debug view (nothing
    /// without one).
    fn windows_slots(&self) -> Vec<Option<u16>> {
        Vec::new()
    }
    /// Per input, in `sources` order: whether E folds it into the stereo-bypass pair, which gets
    /// neither its -3 dB headroom nor its clip (those belong to `SetAudioObject` alone:
    /// stereo_bypass.md section 1.3). Inputs past the end get both.
    fn bypassed(&self) -> Vec<bool> {
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
    slots: Vec<Option<u16>>,
    sums: Vec<f64>,
    count: usize,
}

/// Blocks between snapshots: 1024 samples, about 47 a second.
const EVERY: u64 = 4;
pub const SNAPSHOT_FIELDS: usize = 10;

impl Snapshots {
    fn close(&mut self) {
        let Some(o) = self.open.take() else { return };
        if o.count == 0 {
            return;
        }
        self.data.push(o.sample as f64);
        self.data.push(o.sources.len() as f64);
        for (i, s) in o.sources.iter().enumerate() {
            // kind (0 object, 1 bed, 2 LFE, 3 ISF, 4 stereo bypass, 5 named channel, -1 unknown),
            // bed ID (LFE: 1, LFE2: 2; bypass: side; named channel: its code), render mode (Off 0, Near 1, Far 2, Mid 3; -1 none), active, x, y, z (NaN:
            // none), metadata gain, RMS level, Windows slot (-1 none)
            let (kind, bed) = match o.elements.get(i) {
                Some(Element::Object) => (0.0, 0.0),
                Some(Element::Bed(id)) => (1.0, *id as f64),
                Some(Element::Lfe) => (2.0, 1.0),
                Some(Element::Lfe2) => (2.0, 2.0),
                Some(Element::Isf) => (3.0, 0.0),
                Some(Element::Bypass(side)) => (4.0, *side as f64),
                Some(Element::Channel(code)) => (5.0, *code as f64),
                None => (-1.0, 0.0),
            };
            let level = (o.sums.get(i).copied().unwrap_or(0.0) / o.count as f64).sqrt();
            let (mode, active, pos, gain) = match *s {
                Source::Positioned { pos, mode, gain, active, .. } => (mode as i32 as f64, active as u8 as f64, pos.map(f64::from), gain as f64),
                Source::Lfe { gain } => (-1.0, 1.0, [f64::NAN; 3], gain as f64),
                // no render mode and no place in the room: straight to output L/R
                Source::Bypass { gain, .. } => (-1.0, 1.0, [f64::NAN; 3], gain as f64),
                Source::Silent => (-1.0, 0.0, [f64::NAN; 3], 0.0),
            };
            let slot = o.slots.get(i).copied().flatten().map_or(-1.0, f64::from);
            self.data.extend_from_slice(&[kind, bed, mode, active, pos[0], pos[1], pos[2], gain, level, slot]);
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
/// 256-sample block (counted from the first sample). A block is rendered once all of it is
/// buffered, so every access unit that starts in it has been pushed and the feed's state for it
/// (`sources`) is the same however the input was pushed. The output is the input's length and
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
    /// The debug view's switched-off inputs (in `sources` order): rendered as silence.
    disabled: Vec<bool>,
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
        Ok(Self { renderer, pending: Vec::new(), at: 0, origin: None, taken: 0, rendered: 0, emitted: 0, snapshots: None, disabled: Vec::new() })
    }

    /// Keeps snapshots of the scene for the debug view, or stops.
    pub fn debug(&mut self, on: bool) {
        self.snapshots = on.then(|| Snapshots { data: Vec::new(), open: None });
    }

    /// For the debug view: render these inputs (indices in `sources` order) as silence, every
    /// other one as usual; an empty list renders them all. The snapshots keep every input's own
    /// level.
    pub fn disable(&mut self, inputs: &[usize]) {
        self.disabled = vec![false; inputs.iter().max().map_or(0, |m| m + 1)];
        for &i in inputs {
            self.disabled[i] = true;
        }
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
        // The Windows encoder's input headroom, then its clip to +/-1 (`SetAudioObject`), on every
        // sample of every input but the stereo-bypass pair, which E's bed fold mixes in at 1.0.
        let bypassed = feed.bypassed();
        for (i, (p, s)) in self.pending.iter_mut().zip(block.samples).enumerate() {
            if bypassed.get(i).copied().unwrap_or(false) {
                p.extend(s);
            } else {
                p.extend(s.into_iter().map(|v| (v * INPUT_HEADROOM).clamp(-1.0, 1.0)));
            }
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
        // whole blocks only (`at` is always a block's first sample)
        let whole = have - have % BLOCK;
        while offset < whole {
            let sample = self.at + offset as u64;
            if (sample - origin) % BLOCK as u64 == 0 {
                let sources = feed.sources(sample);
                self.renderer.set_block(&sources);
                if let Some(snap) = self.snapshots.as_mut() {
                    snap.close();
                    if ((sample - origin) / BLOCK as u64) % EVERY == 0 {
                        let n = self.pending.len();
                        snap.open = Some(Open {
                            sample: sample - origin,
                            elements: feed.elements(),
                            slots: feed.windows_slots(),
                            sources,
                            sums: vec![0.0; n],
                            count: 0,
                        });
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
            const SILENCE: [f32; SLOT] = [0.0; SLOT];
            let refs: Vec<&[f32]> =
                refs.iter().enumerate().map(|(i, r)| if self.disabled.get(i).copied().unwrap_or(false) { &SILENCE[..] } else { *r }).collect();
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

    /// At the end: pad with silence so the last input samples come out of the filterbank, in
    /// whole blocks.
    pub fn finish(&mut self, feed: &mut dyn Feed, emit: &mut dyn FnMut(&[f32], &[f32])) {
        if self.pending.is_empty() {
            return;
        }
        let pad = Renderer::latency() + 2 * SLOT + BLOCK;
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
        let f = SNAPSHOT_FIELDS;
        let (object, lfe) = (&second[2..2 + f], &second[2 + f..2 + 2 * f]);
        // object, Near, active, at (0, 0, 0); its level after the input headroom
        assert_eq!(&object[..8], &[0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert!((object[8] - 0.5 * crate::tuning::INPUT_HEADROOM as f64).abs() < 1e-6);
        assert_eq!(lfe[0], 2.0);
        assert_eq!(lfe[2], -1.0);
        assert!(lfe[4].is_nan());
        assert!((lfe[8] - 0.25 * crate::tuning::INPUT_HEADROOM as f64).abs() < 1e-6);
    }

    /// A stereo stream on the bypass pair.
    struct Stereo;
    impl Feed for Stereo {
        fn push(&mut self, _: &[u8], _: &mut dyn FnMut(Block)) {}
        fn sources(&mut self, _: u64) -> Vec<Source> {
            vec![Source::Bypass { side: 0, gain: 1.0 }, Source::Bypass { side: 1, gain: 1.0 }]
        }
        fn elements(&self) -> Vec<Element> {
            vec![Element::Bypass(0), Element::Bypass(1)]
        }
        fn bypassed(&self) -> Vec<bool> {
            vec![true, true]
        }
    }

    #[test]
    fn the_bypass_pair_gets_neither_headroom_nor_clip() {
        let mut p = Pipeline::new().unwrap();
        p.debug(true);
        // above full scale: E's bed fold doesn't clip
        let block = Block { start: 0, samples: vec![vec![1.25; 4096], vec![-0.5; 4096]] };
        p.take(&mut Stereo, block, &mut |_, _| {});
        let d = &p.snapshots.as_ref().unwrap().data;
        let size = 2 + 2 * SNAPSHOT_FIELDS;
        let f = SNAPSHOT_FIELDS;
        let (l, r) = (&d[size + 2..size + 2 + f], &d[size + 2 + f..size + 2 + 2 * f]);
        assert!((l[8] - 1.25).abs() < 1e-6 && (r[8] - 0.5).abs() < 1e-6, "{} {}", l[8], r[8]);
        // the bypass pair, left then right, with no render mode and no position
        assert_eq!((l[0], l[1], r[0], r[1], l[2]), (4.0, 0.0, 4.0, 1.0, -1.0));
        assert!(l[4].is_nan() && r[4].is_nan());
    }

    #[test]
    fn a_disabled_input_renders_as_silence_and_keeps_its_level() {
        let n = 8192;
        let run = |off: &[usize], second: f32| {
            let mut p = Pipeline::new().unwrap();
            p.debug(true);
            p.disable(off);
            let block = Block { start: 0, samples: vec![vec![0.5; n], vec![second; n]] };
            let mut out = Vec::new();
            p.take(&mut Two, block, &mut |l, r| out.extend([l[0], r[0]]));
            (out, p.snapshots.as_ref().unwrap().data.clone())
        };
        // switching the LFE off is the same as feeding it silence
        let (off, snap_off) = run(&[1], -0.25);
        let (silent, _) = run(&[], 0.0);
        assert_eq!(off, silent);
        // and the snapshots still show its own level
        let (_, snap_on) = run(&[], -0.25);
        let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&snap_off), bits(&snap_on));
        // everything off: nothing out
        let (none, _) = run(&[0, 1], -0.25);
        assert!(none.iter().all(|v| *v == 0.0));
    }
}

#[cfg(test)]
mod feed_tests {
    use super::*;
    use crate::objects::{Modes, Scene};
    use oamd::{BlockUpdateInfo, MDUpdateInfo, ObjectAudioMetadataPayload, ObjectBasicInfo, ObjectElement, ObjectInfoBlock, ObjectRenderInfo};

    /// Dynamic objects through a `Scene`, as the TrueHD and E-AC-3 feeds drive theirs.
    struct Objects(Scene);
    impl Feed for Objects {
        fn push(&mut self, _: &[u8], _: &mut dyn FnMut(Block)) {}
        fn sources(&mut self, sample: u64) -> Vec<Source> {
            self.0.advance(sample);
            self.0.sources()
        }
        fn elements(&self) -> Vec<Element> {
            self.0.elements()
        }
    }

    /// An update moving `count` objects to `x` (front, at full level), stamped `offset` samples into its access unit.
    fn moved_to(x: f64, offset: usize, count: usize) -> ObjectAudioMetadataPayload {
        let block = ObjectInfoBlock {
            object_basic_info: ObjectBasicInfo { object_gain: 0, ..Default::default() },
            object_render_info: ObjectRenderInfo { pos3d: [x, 0.0, 0.0], ..Default::default() },
            ..Default::default()
        };
        ObjectAudioMetadataPayload {
            object_count: count,
            object_element: Some(ObjectElement {
                md_update_info: MDUpdateInfo {
                    sample_offset: offset,
                    num_obj_info_blocks: 1,
                    block_update_info: vec![BlockUpdateInfo { ramp_duration: 256, ..Default::default() }],
                },
                object_data: vec![vec![block]; count],
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    const UNIT: usize = 40;

    /// Renders 120 access units of noise, each with the payload `metadata` gives it and as many channels as
    /// the last payload pushed declares (as the feeds shape their blocks), pushing `ahead` units before
    /// rendering any (as a feed handed many at once does).
    fn render(metadata: &dyn Fn(u64) -> Option<ObjectAudioMetadataPayload>, ahead: usize) -> Vec<f32> {
        let mut feed = Objects(Scene::new(Modes::Stream));
        let mut pipeline = Pipeline::new().unwrap();
        let mut out = Vec::new();
        let mut noise = 1u32;
        let mut channels = 1;
        let units: Vec<Block> = (0..120u64)
            .map(|u| {
                if let Some(p) = metadata(u * UNIT as u64) {
                    channels = p.object_count;
                }
                let samples = (0..channels)
                    .map(|_| {
                        (0..UNIT)
                            .map(|_| {
                                noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                                (noise >> 8) as f32 / (1u32 << 24) as f32 - 0.5
                            })
                            .collect()
                    })
                    .collect();
                Block { start: u * UNIT as u64, samples }
            })
            .collect();
        let mut pushed = 0;
        for (u, block) in units.into_iter().enumerate() {
            while pushed < (u + ahead).min(120) || pushed == u {
                let start = (pushed * UNIT) as u64;
                if let Some(p) = metadata(start) {
                    feed.0.update(&p, start);
                }
                pushed += 1;
            }
            pipeline.take(&mut feed, block, &mut |l, r| out.extend_from_slice(&[l[0], r[0]]));
        }
        pipeline.finish(&mut feed, &mut |l, r| out.extend_from_slice(&[l[0], r[0]]));
        out
    }

    #[test]
    fn output_does_not_depend_on_how_far_input_is_pushed_ahead() {
        // The first payload (the layout) in the unit at 840, stamped at 875: in the block from 768, past its
        // first slot. A move in the unit at 2000, stamped at 2010: in the block from 1792, also past its first
        // slot. A second object from the unit at 3480 (a new layout), in the block from 3328.
        let metadata = |start: u64| match start {
            840 => Some(moved_to(0.0, 35, 1)),
            2000 => Some(moved_to(1.0, 10, 1)),
            3480 => Some(moved_to(0.5, 20, 2)),
            s if s % 400 == 0 && s > 840 => Some(moved_to(if s < 2000 { 0.0 } else { 1.0 }, 0, if s < 3480 { 1 } else { 2 })),
            _ => None,
        };
        let per_unit = render(&metadata, 0);
        assert_eq!(per_unit.len(), 120 * UNIT * 2);
        assert!(per_unit.iter().any(|v| *v != 0.0));
        for ahead in [1, 3, 7, 50, 120] {
            assert_eq!(render(&metadata, ahead), per_unit, "pushed {ahead} units ahead");
        }
    }
}
