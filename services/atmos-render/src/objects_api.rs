//! Atmos objects for Windows' spatial audio (`ISpatialAudioObjectRenderStream`), as Windows' own
//! DD+ decoder hands them to Dolby Atmos for Headphones: the decoder in FFmpeg's fork calls this
//! C interface, and mpv's spatial output sends each channel as one spatial audio object.
//!
//! Blocks are 256 samples of `CHANNELS` channels. A channel is a static bed object (its
//! `AudioObjectType`, E slots 0-11), or a dynamic object (E slot 19 + d, activated in OAMD order:
//! channel 12 + d), or unused (type 0, silent). What E applies itself is left to it: the samples
//! have neither the encoder's -3 dB headroom nor its clip (`SetAudioObject` applies both), and
//! positions are the stream's targets, not Atmos for Headphones' smoothed ones (E smooths with its
//! own 480-sample ramp). What E can't be given is in the samples: each element's metadata gain
//! (smoothed per block, ramped across it; `SetVolume` steps once per buffer), and silence for an
//! inactive one. LFE2, ISF elements and the stereo-bypass pair are not sent, as Windows' decoder
//! sends none of them.

use crate::eac3_in::Eac3;
use crate::input::{Block, Feed};
use crate::loudness::Loudness;
use crate::objects::Modes;
use crate::render::{BLOCK, Source};
use crate::truehd_in::TrueHd;

/// Channels per block: E's 32 active objects for Dolby Atmos (a 7.1.4 bed and 20 dynamic).
pub const CHANNELS: usize = 32;
/// Static bed slots (E 0-11, FrontLeft .. TopBackRight); dynamic objects follow.
const STATIC_SLOTS: usize = 12;
/// E's first dynamic slot.
const FIRST_DYNAMIC: u16 = 19;
/// `AudioObjectType_Dynamic`; a static slot s is `AudioObjectType_FrontLeft (0x2) << s`.
const TYPE_DYNAMIC: u32 = 0x1;
const TYPE_FRONT_LEFT: u32 = 0x2;

/// One channel's object for a block, as mpv's spatial output reads it.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct AtmosObject {
    /// `AudioObjectType`: 0 unused, 1 dynamic, else one static channel's bit.
    pub object_type: u32,
    /// Windows' position (dynamic objects only): Xw = x - 0.5, Yw = z, Zw = y - 0.5 from Dolby
    /// x/y/z, inside E's box (|Xw| <= 0.5, |Yw| <= 1, |Zw| <= 0.5), which maps them back.
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// 0 for an inactive element (its samples are silent).
    pub active: u32,
}

/// Windows' position for Dolby x/y/z (E's mapping inverted: Dolby x = Xw + 0.5, y = Zw + 0.5,
/// z = Yw, after its clamp).
pub fn windows_position(dolby: [f32; 3]) -> [f32; 3] {
    [
        (dolby[0] - 0.5).clamp(-0.5, 0.5),
        dolby[2].clamp(-1.0, 1.0),
        (dolby[1] - 0.5).clamp(-0.5, 0.5),
    ]
}

/// The channel and object type of an input at E slot `slot`, or None for one Windows isn't sent.
pub fn channel_of(slot: Option<u16>) -> Option<(usize, u32)> {
    let slot = slot?;
    if (slot as usize) < STATIC_SLOTS {
        return Some((slot as usize, TYPE_FRONT_LEFT << slot));
    }
    let d = slot.checked_sub(FIRST_DYNAMIC)? as usize;
    let channel = STATIC_SLOTS + d;
    (channel < CHANNELS).then_some((channel, TYPE_DYNAMIC))
}

/// A finished block.
pub struct ObjectBlock {
    /// The stream sample of the block's first sample.
    pub start: u64,
    pub channels: Vec<[f32; BLOCK]>,
    pub objects: [AtmosObject; CHANNELS],
}

enum Codec {
    TrueHd(TrueHd),
    Eac3(Eac3),
    #[cfg(test)]
    Test(Box<dyn Feed>),
}

/// The decoders' feeds, cut into blocks with each channel's object.
pub struct Objects {
    codec: Codec,
    /// Each input's samples not yet in a block.
    pending: Vec<Vec<f32>>,
    /// The stream sample of `pending`'s first sample.
    at: Option<u64>,
    /// Each channel's gain at the end of the last block, which the next ramps from.
    gains: [f32; CHANNELS],
    ready: std::collections::VecDeque<ObjectBlock>,
}

impl Objects {
    /// 0 TrueHD, 1 E-AC-3 (its core PCM pushed in with `push_pcm`).
    pub fn new(codec: i32) -> Option<Self> {
        let codec = match codec {
            0 => Codec::TrueHd(TrueHd::new(Modes::Windows)),
            1 => Codec::Eac3(Eac3::external(Modes::Windows, Loudness::Windows)),
            _ => return None,
        };
        Some(Objects { codec, pending: Vec::new(), at: None, gains: [0.0; CHANNELS], ready: Default::default() })
    }

    fn feed(&mut self) -> &mut dyn Feed {
        match &mut self.codec {
            Codec::TrueHd(f) => f,
            Codec::Eac3(f) => f,
            #[cfg(test)]
            Codec::Test(f) => f.as_mut(),
        }
    }

    fn take(pending: &mut Vec<Vec<f32>>, at: &mut Option<u64>, block: Block) {
        if at.is_none() {
            *at = Some(block.start);
        }
        if pending.len() != block.samples.len() {
            // the input count changed: what's buffered carries over as silence
            let have = pending.first().map(|p| p.len()).unwrap_or(0);
            *pending = vec![vec![0.0; have]; block.samples.len()];
        }
        for (p, s) in pending.iter_mut().zip(block.samples) {
            p.extend(s);
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        let (pending, at) = (&mut self.pending, &mut self.at);
        let feed: &mut dyn Feed = match &mut self.codec {
            Codec::TrueHd(f) => f,
            Codec::Eac3(f) => f,
            #[cfg(test)]
            Codec::Test(f) => f.as_mut(),
        };
        feed.push(bytes, &mut |b| Self::take(pending, at, b));
        self.blocks();
    }

    /// E-AC-3 only: FFmpeg's decode of the core, interleaved, in its channel order (`mask`).
    pub fn push_pcm(&mut self, channels: usize, mask: u32, samples: &[f32]) {
        let Codec::Eac3(feed) = &mut self.codec else { return };
        let (pending, at) = (&mut self.pending, &mut self.at);
        feed.push_pcm(channels, mask, samples, &mut |b| Self::take(pending, at, b));
        self.blocks();
    }

    pub fn end(&mut self) {
        let (pending, at) = (&mut self.pending, &mut self.at);
        let feed: &mut dyn Feed = match &mut self.codec {
            Codec::TrueHd(f) => f,
            Codec::Eac3(f) => f,
            #[cfg(test)]
            Codec::Test(f) => f.as_mut(),
        };
        feed.end(&mut |b| Self::take(pending, at, b));
        self.blocks();
    }

    pub fn next(&mut self) -> Option<ObjectBlock> {
        self.ready.pop_front()
    }

    fn blocks(&mut self) {
        while self.pending.first().map(|p| p.len()).unwrap_or(0) >= BLOCK {
            let start = self.at.unwrap_or(0);
            let sources = self.feed().sources(start);
            let targets = self.feed().targets();
            let slots = self.feed().windows_slots();
            let mut channels = vec![[0f32; BLOCK]; CHANNELS];
            let mut objects = [AtmosObject::default(); CHANNELS];
            let mut gains = [0f32; CHANNELS];
            for (i, samples) in self.pending.iter_mut().enumerate() {
                let input: Vec<f32> = samples.drain(..BLOCK).collect();
                let Some((c, object_type)) = channel_of(slots.get(i).copied().flatten()) else {
                    continue;
                };
                let (gain, active, pos) = match sources.get(i) {
                    Some(Source::Positioned { pos, gain, active, .. }) => {
                        (*gain, *active, targets.get(i).copied().unwrap_or(*pos))
                    }
                    Some(Source::Lfe { gain }) => (*gain, true, [0.5, 0.5, 0.0]),
                    _ => continue, // silent or bypass: nothing for Windows
                };
                let gain = if active { gain } else { 0.0 };
                let from = self.gains[c];
                for (n, (o, v)) in channels[c].iter_mut().zip(input).enumerate() {
                    let g = from + (gain - from) * (n + 1) as f32 / BLOCK as f32;
                    *o = v * g;
                }
                gains[c] = gain;
                let [x, y, z] = windows_position(pos);
                objects[c] = AtmosObject { object_type, x, y, z, active: active as u32 };
            }
            self.gains = gains;
            self.at = Some(start + BLOCK as u64);
            self.ready.push_back(ObjectBlock { start, channels, objects });
        }
    }
}

// The C interface, for FFmpeg's decoder.

/// # Safety
/// The handle is freed with `atmos_objects_destroy`.
#[unsafe(no_mangle)]
pub extern "C" fn atmos_objects_create(codec: i32) -> *mut Objects {
    Objects::new(codec).map_or(std::ptr::null_mut(), |o| Box::into_raw(Box::new(o)))
}

/// # Safety
/// `handle` is from `atmos_objects_create`, or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn atmos_objects_destroy(handle: *mut Objects) {
    if !handle.is_null() {
        // SAFETY: from Box::into_raw, freed once.
        drop(unsafe { Box::from_raw(handle) });
    }
}

/// # Safety
/// `handle` is live; `data` is readable for `size` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn atmos_objects_push(handle: *mut Objects, data: *const u8, size: usize) {
    // SAFETY: as documented.
    let (o, bytes) = unsafe { (&mut *handle, std::slice::from_raw_parts(data, size)) };
    o.push(bytes);
}

/// # Safety
/// `handle` is live; `samples` is readable for `frames * channels` floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn atmos_objects_push_pcm(handle: *mut Objects, channels: u32, mask: u32, samples: *const f32, frames: usize) {
    // SAFETY: as documented.
    let (o, pcm) = unsafe { (&mut *handle, std::slice::from_raw_parts(samples, frames * channels as usize)) };
    o.push_pcm(channels as usize, mask, pcm);
}

/// # Safety
/// `handle` is live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn atmos_objects_end(handle: *mut Objects) {
    // SAFETY: as documented.
    unsafe { &mut *handle }.end();
}

/// The next block: 1 with `ATMOS_OBJECTS_CHANNELS` planar channels of `ATMOS_OBJECTS_BLOCK`
/// samples written to `planes`, each channel's object to `objects` and its first sample to
/// `start`; 0 when none is ready.
///
/// # Safety
/// `handle` is live; `planes` holds `ATMOS_OBJECTS_CHANNELS` pointers, each writable for
/// `ATMOS_OBJECTS_BLOCK` floats; `objects` is writable for `ATMOS_OBJECTS_CHANNELS` objects.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn atmos_objects_receive(handle: *mut Objects, planes: *const *mut f32, objects: *mut AtmosObject, start: *mut u64) -> i32 {
    // SAFETY: as documented.
    let o = unsafe { &mut *handle };
    let Some(block) = o.next() else { return 0 };
    for (c, samples) in block.channels.iter().enumerate() {
        // SAFETY: as documented.
        unsafe { std::ptr::copy_nonoverlapping(samples.as_ptr(), *planes.add(c), BLOCK) };
    }
    // SAFETY: as documented.
    unsafe {
        std::ptr::copy_nonoverlapping(block.objects.as_ptr(), objects, CHANNELS);
        *start = block.start;
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_map_to_channels_and_types() {
        assert_eq!(channel_of(Some(0)), Some((0, 0x2))); // FrontLeft
        assert_eq!(channel_of(Some(3)), Some((3, 0x10))); // LowFrequency
        assert_eq!(channel_of(Some(11)), Some((11, 0x1000))); // TopBackRight
        assert_eq!(channel_of(Some(19)), Some((12, 0x1))); // first dynamic
        assert_eq!(channel_of(Some(38)), Some((31, 0x1)));
        assert_eq!(channel_of(Some(39)), None); // past E's 32 objects
        assert_eq!(channel_of(Some(17)), None); // stereo bypass
        assert_eq!(channel_of(None), None);
    }

    #[test]
    fn positions_invert_e_mapping() {
        for dolby in [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.25, 0.75, 0.5], [0.5, 0.5, -1.0]] {
            let [xw, yw, zw] = windows_position(dolby);
            // E: Dolby x = Xw + 0.5, y = Zw + 0.5, z = Yw
            assert_eq!([xw + 0.5, zw + 0.5, yw], dolby);
        }
        assert_eq!(windows_position([2.0, -1.0, 3.0]), [0.5, 1.0, -0.5]);
    }

    /// The TrueHD Atmos fixtures (silent: tests/fixtures/truehd/PROVENANCE.txt) through the API:
    /// blocks are contiguous; the objects stream's LFE is LowFrequency on channel 3 and its 15
    /// objects dynamic on channels 12-26, as Windows' slots 19-33; the channel-bed stream, without
    /// object metadata, is silent and sends nothing, as the renderer is until the first OAMD.
    #[test]
    fn truehd_fixtures_come_out_as_objects() {
        for (objects, bytes) in [(true, &include_bytes!("../tests/fixtures/truehd/fba_atmos_obj.mlp")[..]), (false, &include_bytes!("../tests/fixtures/truehd/fba_atmos_cbi.mlp")[..])] {
            let mut o = Objects::new(0).unwrap();
            o.push(bytes);
            o.end();
            let mut blocks = 0;
            let mut dynamic = 0;
            let mut last = None;
            while let Some(b) = o.next() {
                if let Some(prev) = last {
                    assert_eq!(b.start, prev + BLOCK as u64, "blocks are contiguous");
                }
                last = Some(b.start);
                for (c, obj) in b.objects.iter().enumerate() {
                    if obj.object_type == 0 {
                        assert!(b.channels[c].iter().all(|v| *v == 0.0), "an unused channel is silent");
                    }
                    if obj.object_type == TYPE_DYNAMIC {
                        assert!(c >= STATIC_SLOTS);
                        assert!(obj.x.abs() <= 0.5 && obj.y.abs() <= 1.0 && obj.z.abs() <= 0.5);
                        dynamic += 1;
                    } else if obj.object_type != 0 {
                        assert_eq!(obj.object_type, TYPE_FRONT_LEFT << c, "static channel c is slot c");
                    }
                }
                if objects {
                    assert_eq!(b.objects[3].object_type, 0x10);
                    let types: Vec<u32> = b.objects[12..27].iter().map(|o| o.object_type).collect();
                    assert_eq!(types, vec![TYPE_DYNAMIC; 15]);
                    assert!(b.objects[27..].iter().all(|o| o.object_type == 0));
                } else {
                    assert!(b.objects.iter().all(|o| o.object_type == 0));
                }
                blocks += 1;
            }
            assert!(blocks > 20);
            assert_eq!(dynamic > 0, objects);
        }
    }

    use crate::direct::Mode;

    /// A feed with known inputs: four inputs of constant 1.5 (above the clip), one block at a
    /// time. 0 a bed channel at E slot 0 (gain 0.5), 1 an object at slot 19 (gain 2.0, then 1.0;
    /// its smoothed position elsewhere, its target `TARGET`), 2 an inactive object at slot 20, 3
    /// the stereo-bypass left (slot 17).
    struct Known {
        block: u32,
    }

    const TARGET: [f32; 3] = [0.25, 0.75, 0.5];

    impl Feed for Known {
        fn push(&mut self, _bytes: &[u8], out: &mut dyn FnMut(Block)) {
            out(Block { start: self.block as u64 * BLOCK as u64, samples: vec![vec![1.5; BLOCK]; 4] });
            self.block += 1;
        }
        fn sources(&mut self, sample: u64) -> Vec<Source> {
            let gain = if sample == 0 { 2.0 } else { 1.0 };
            let at = |pos, gain, active| Source::Positioned { pos, mode: Mode::Near, gain, active, ramp: 0, zone: 0 };
            vec![at([0.0, 0.0, 0.0], 0.5, true), at([0.9, 0.9, 0.9], gain, true), at(TARGET, 1.0, false), Source::Bypass { side: 0, gain: 1.0 }]
        }
        fn targets(&self) -> Vec<[f32; 3]> {
            vec![[0.0, 0.0, 0.0], TARGET, TARGET, [0.0, 0.0, 0.0]]
        }
        fn windows_slots(&self) -> Vec<Option<u16>> {
            vec![Some(0), Some(19), Some(20), Some(17)]
        }
    }

    #[test]
    fn samples_are_raw_times_ramped_gain() {
        let mut o = Objects { codec: Codec::Test(Box::new(Known { block: 0 })), pending: Vec::new(), at: None, gains: [0.0; CHANNELS], ready: Default::default() };
        o.push(&[]);
        o.push(&[]);
        let first = o.next().unwrap();
        let second = o.next().unwrap();
        assert_eq!((first.start, second.start), (0, BLOCK as u64));
        // bed: ramps 0 -> 0.5 over the first block, then holds; no -3 dB, no clip (1.5 * 0.5)
        assert!((first.channels[0][BLOCK - 1] - 0.75).abs() < 1e-6);
        assert!((first.channels[0][0] - 1.5 * 0.5 / BLOCK as f32).abs() < 1e-6);
        assert!(second.channels[0].iter().all(|v| (v - 0.75).abs() < 1e-6));
        assert_eq!(first.objects[0].object_type, 0x2);
        // object: ramps to 2.0 (3.0 out, above the clip), then down to 1.0 across the second block
        assert!((first.channels[12][BLOCK - 1] - 3.0).abs() < 1e-5);
        assert!((second.channels[12][BLOCK - 1] - 1.5).abs() < 1e-5);
        assert!(second.channels[12][0] > 2.9, "the second block ramps from the first's gain");
        // its target in Windows' coordinates, not the smoothed position
        let obj = first.objects[12];
        assert_eq!((obj.object_type, obj.active), (TYPE_DYNAMIC, 1));
        assert_eq!([obj.x, obj.y, obj.z], windows_position(TARGET));
        // inactive: silent, flagged
        assert!(first.channels[13].iter().all(|v| *v == 0.0));
        assert_eq!((first.objects[13].object_type, first.objects[13].active), (TYPE_DYNAMIC, 0));
        // stereo bypass: not sent anywhere
        let used: Vec<usize> = (0..CHANNELS).filter(|&c| first.objects[c].object_type != 0).collect();
        assert_eq!(used, vec![0, 12, 13]);
    }
}

