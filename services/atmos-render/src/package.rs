//! The renderer as a WebGPU-Player audio decoder package (the engine's docs/src/decoder-packages.md,
//! "Audio decoders"): version 1 of its C interface. With `renderBinaural` 1 on a stereo
//! `renderChannelMask` the blocks are our binaural render; otherwise they are the stream's stock
//! decode (FFmpeg's), which the engine folds to its layout. The module imports its memory
//! (`env.memory`); the build links it so.
//!
//! One package per codec, chosen at build time: the `package` feature builds TrueHD (all Rust),
//! `package-eac3` E-AC-3 and AC-3, and `package-dts` DTS, whose audio FFmpeg's decoder decodes in
//! the same module (`ffcore.c`, linked by the Emscripten build).

use crate::input::{Block, Element, Feed, Pipeline};

const ABI_VERSION: u32 = 1;
/// The only rate the renderer runs at; a stream at any other plays its stock decode.
const RENDER_RATE: u32 = 48_000;
const STEREO_MASK: u32 = 0x3;
/// The WAVE channel bits FFmpeg's layout bits match one for one (front left to top back right).
const WAVE_BITS: u64 = 0x3_FFFF;
/// FFmpeg's channels WAVE has no bit for, and the WAVE channel each plays as where that one is free.
const NON_WAVE: [(u64, u64); 5] = [
    (1 << 31, 1 << 9),  // wide left: side left
    (1 << 32, 1 << 10), // wide right: side right
    (1 << 33, 1 << 9),  // surround direct left: side left
    (1 << 34, 1 << 10), // surround direct right: side right
    (1 << 35, 1 << 3),  // second LFE: summed into the LFE
];

/// Option and attribute keys, as the header names them.
const OPTION_RENDER_CHANNEL_MASK: u32 = 1;
const OPTION_RENDER_BINAURAL: u32 = 2;
const ATTRIBUTE_OBJECT_COUNT: u32 = 1;
const ATTRIBUTE_LIMITED: u32 = 2;

/// Error codes, as the header names them.
const ERROR_RENDERER: u32 = 1;
const ERROR_OPTION: u32 = 2;
const ERROR_LAYOUT: u32 = 3;
const ERROR_DECODER: u32 = 4;

/// One packet's stock decode: interleaved samples, its channels, FFmpeg's channel mask and rate.
struct Stock {
    samples: Vec<f32>,
    channels: usize,
    mask: u64,
    rate: u32,
}

/// What a codec gives the wrapper: the renderer's feed, and its stock decode.
trait Source {
    fn feed(&mut self) -> &mut dyn Feed;
    /// Decodes one packet: the renderer's blocks through `out`, and the stock decode of the same
    /// packet.
    fn push(&mut self, packet: &[u8], out: &mut dyn FnMut(Block)) -> Result<Stock, u32>;
    /// The end of the track: the feed's held blocks.
    fn end(&mut self, out: &mut dyn FnMut(Block)) {
        self.feed().end(out);
    }
}

#[cfg(not(any(feature = "package-eac3", feature = "package-dts")))]
mod codec {
    use super::{Source, Stock};
    use crate::input::{Block, Feed};
    use crate::objects::Modes;
    use crate::truehd_in::TrueHd;

    pub const HEADER: &str = "\
//! id: truehd
//! name: TrueHD with the AIOStreams Atmos renderer
//! decoder: audio
//! accepts: codec in [truehd]
//! option: 1, renderChannelMask
//! option: 2, renderBinaural
//! attribute: 1, objectCount
//! attribute: 2, limited
//! error: 1, renderer
//! error: 2, option
//! error: 3, layout
//! error: 4, decoder
";

    pub struct Codec(TrueHd);

    impl Codec {
        pub fn new() -> Option<Self> {
            Some(Codec(TrueHd::new(Modes::Stream)))
        }
    }

    impl Source for Codec {
        fn feed(&mut self) -> &mut dyn Feed {
            &mut self.0
        }

        fn push(&mut self, packet: &[u8], out: &mut dyn FnMut(Block)) -> Result<Stock, u32> {
            self.0.push(packet, out);
            // The speaker presentation is FFmpeg's decode of the stream (truehd_in.rs).
            Ok(Stock { samples: self.0.take_speakers(), channels: self.0.speaker_channels(), mask: self.0.speaker_mask, rate: self.0.speaker_rate })
        }
    }
}

/// The codecs FFmpeg decodes in the module, as `ffcore.c` numbers them.
#[cfg(any(feature = "package-eac3", feature = "package-dts"))]
mod ffmpeg {
    use super::{Stock, ERROR_DECODER};

    #[repr(C)]
    pub struct FfCore {
        _private: [u8; 0],
    }

    unsafe extern "C" {
        fn ffcore_new(codec: i32) -> *mut FfCore;
        fn ffcore_free(core: *mut FfCore);
        fn ffcore_decode(core: *mut FfCore, data: *const u8, size: i32) -> i32;
        fn ffcore_pcm(core: *const FfCore) -> *const f32;
        fn ffcore_channels(core: *const FfCore) -> i32;
        fn ffcore_mask(core: *const FfCore) -> u32;
        fn ffcore_sample_rate(core: *const FfCore) -> i32;
    }

    /// FFmpeg's decoder of one codec: 0 E-AC-3 (and AC-3), set up for the Reference Player's
    /// loudness (loudness.rs); 1 DTS, with FFmpeg's defaults, as the native renderer decodes it.
    pub struct Core(*mut FfCore);

    impl Core {
        pub fn new(codec: i32) -> Option<Self> {
            // SAFETY: a plain constructor; null when FFmpeg's decoder won't open with our options.
            let core = unsafe { ffcore_new(codec) };
            (!core.is_null()).then_some(Core(core))
        }

        /// One packet's decode, interleaved in FFmpeg's channel order.
        pub fn decode(&mut self, packet: &[u8]) -> Result<Stock, u32> {
            // SAFETY: a live core; packet is readable for its length; the PCM is valid until the
            // next decode, and copied out before it.
            unsafe {
                let frames = ffcore_decode(self.0, packet.as_ptr(), packet.len() as i32);
                if frames < 0 {
                    return Err(ERROR_DECODER);
                }
                let channels = ffcore_channels(self.0).max(0) as usize;
                let samples = std::slice::from_raw_parts(ffcore_pcm(self.0), frames as usize * channels).to_vec();
                Ok(Stock { samples, channels, mask: ffcore_mask(self.0) as u64, rate: ffcore_sample_rate(self.0).max(0) as u32 })
            }
        }
    }

    impl Drop for Core {
        fn drop(&mut self) {
            // SAFETY: from ffcore_new, freed once.
            unsafe { ffcore_free(self.0) }
        }
    }
}

#[cfg(feature = "package-eac3")]
mod codec {
    use super::ffmpeg::Core;
    use super::{Source, Stock};
    use crate::eac3_in::Eac3;
    use crate::input::{Block, Feed};
    use crate::loudness::Loudness;
    use crate::objects::Modes;

    pub const HEADER: &str = "\
//! id: eac3
//! name: E-AC-3 and AC-3 with the AIOStreams Atmos renderer
//! decoder: audio
//! accepts: codec in [eac3, ac3]
//! option: 1, renderChannelMask
//! option: 2, renderBinaural
//! attribute: 1, objectCount
//! attribute: 2, limited
//! error: 1, renderer
//! error: 2, option
//! error: 3, layout
//! error: 4, decoder
";

    pub struct Codec {
        feed: Eac3,
        core: Core,
    }

    impl Codec {
        pub fn new() -> Option<Self> {
            // The Reference Player's loudness, which ffcore.c sets FFmpeg's decoder up for.
            Some(Codec { feed: Eac3::external(Modes::Stream, Loudness::Reference), core: Core::new(0)? })
        }
    }

    impl Source for Codec {
        fn feed(&mut self) -> &mut dyn Feed {
            &mut self.feed
        }

        fn push(&mut self, packet: &[u8], out: &mut dyn FnMut(Block)) -> Result<Stock, u32> {
            // The bitstream first, for its frames' EMDF (JOC, OAMD), then the core's PCM, which the
            // feed lines up with them as the native renderer's FFmpeg child output does.
            self.feed.push(packet, out);
            let stock = self.core.decode(packet)?;
            if stock.channels > 0 && !stock.samples.is_empty() {
                self.feed.push_pcm(stock.channels, stock.mask as u32, &stock.samples, out);
            }
            Ok(stock)
        }
    }
}

#[cfg(feature = "package-dts")]
mod codec {
    use super::ffmpeg::Core;
    use super::{Source, Stock};
    use crate::decoded_in::Decoded;
    use crate::input::{Block, Feed};
    use crate::objects::Modes;

    pub const HEADER: &str = "\
//! id: dts
//! name: DTS with the AIOStreams Atmos renderer
//! decoder: audio
//! accepts: codec in [dts]
//! option: 1, renderChannelMask
//! option: 2, renderBinaural
//! attribute: 1, objectCount
//! attribute: 2, limited
//! error: 1, renderer
//! error: 2, option
//! error: 3, layout
//! error: 4, decoder
";

    pub struct Codec {
        feed: Decoded,
        core: Core,
    }

    impl Codec {
        pub fn new() -> Option<Self> {
            Some(Codec { feed: Decoded::external(Modes::Stream), core: Core::new(1)? })
        }
    }

    impl Source for Codec {
        fn feed(&mut self) -> &mut dyn Feed {
            &mut self.feed
        }

        /// DTS has no objects: its channels, FFmpeg's decode of the core and its extensions, are
        /// what the renderer places, as the native renderer does.
        fn push(&mut self, packet: &[u8], out: &mut dyn FnMut(Block)) -> Result<Stock, u32> {
            let stock = self.core.decode(packet)?;
            if stock.channels > 0 && !stock.samples.is_empty() {
                self.feed.push_pcm(stock.channels, stock.mask as u32, &stock.samples, out);
            }
            Ok(stock)
        }
    }
}

pub use codec::HEADER;

struct OutBlock {
    channels: Vec<Vec<f32>>,
    mask: u32,
    rate: u32,
    timestamp: f64,
    objects: u32,
    /// Our render, which ends in Dolby's own limiter (`limiter.rs`): the engine adds none.
    limited: bool,
}

/**
 * A stock decode as planar channels in WAVE order: FFmpeg's channels WAVE has no bit for play as the
 * WAVE channel `NON_WAVE` names where the layout leaves it free (a second LFE summed into the LFE),
 * else the layout is one the engine can't play.
 */
fn to_wave(stock: &Stock) -> Result<(Vec<Vec<f32>>, u32), u64> {
    let frames = stock.samples.len() / stock.channels;
    // FFmpeg's channels are in bit order; each one's bit, then where it plays.
    let bits: Vec<u64> = (0..64).map(|b| 1u64 << b).filter(|b| stock.mask & b != 0).collect();
    if bits.len() != stock.channels {
        return Err(stock.mask);
    }
    let mut placed: Vec<u64> = Vec::with_capacity(bits.len());
    let mut mask = stock.mask & WAVE_BITS;
    for &bit in &bits {
        if bit & WAVE_BITS != 0 {
            placed.push(bit);
            continue;
        }
        let Some(&(_, to)) = NON_WAVE.iter().find(|(from, _)| *from == bit) else {
            return Err(stock.mask);
        };
        let lfe2 = bit == 1 << 35;
        if mask & to != 0 && !lfe2 {
            return Err(stock.mask);
        }
        mask |= to;
        placed.push(to);
    }
    let order: Vec<u64> = (0..18).map(|b| 1u64 << b).filter(|b| mask & b != 0).collect();
    let mut planar = vec![vec![0f32; frames]; order.len()];
    for (frame, samples) in stock.samples.chunks_exact(stock.channels).enumerate() {
        for (c, v) in samples.iter().enumerate() {
            let to = order.iter().position(|b| *b == placed[c]).expect("placed in the mask");
            planar[to][frame] += *v;
        }
    }
    Ok((planar, mask as u32))
}

/// Our binaural render, from the stream sample it started at.
struct Binaural {
    pipeline: Pipeline,
    origin: Option<u64>,
    emitted: u64,
}

pub struct Decoder {
    source: codec::Codec,
    input: Vec<u8>,
    render_mask: u32,
    binaural_asked: bool,
    binaural: Option<Binaural>,
    /// The first packet's timestamp, in microseconds: stream sample 0.
    origin_us: Option<f64>,
    /// Stock frames decoded so far, which keep the stream's time.
    stock_frames: u64,
    /// The stream's rate, from its stock decode.
    rate: u32,
    queue: std::collections::VecDeque<OutBlock>,
    current: Option<OutBlock>,
    error: (u32, u32),
}

/// A stream sample's time in whole microseconds, which is all the engine takes.
fn micros(origin_us: f64, sample: u64, rate: u32) -> f64 {
    (origin_us + sample as f64 * 1e6 / rate.max(1) as f64).round()
}

fn take_render(binaural: &mut Binaural, origin_us: f64, objects: u32, left: Vec<f32>, right: Vec<f32>) -> Option<OutBlock> {
    if left.is_empty() {
        return None;
    }
    let start = binaural.origin.unwrap_or(0) + binaural.emitted;
    binaural.emitted += left.len() as u64;
    Some(OutBlock { channels: vec![left, right], mask: STEREO_MASK, rate: RENDER_RATE, timestamp: micros(origin_us, start, RENDER_RATE), objects, limited: true })
}

impl Decoder {
    fn rendering_binaural(&self) -> bool {
        self.binaural_asked && self.render_mask == STEREO_MASK && self.rate == RENDER_RATE
    }

    fn objects(&mut self) -> u32 {
        self.source.feed().elements().iter().filter(|e| matches!(e, Element::Object)).count() as u32
    }

    fn fail(&mut self, code: u32, value: u32) {
        if self.error.0 == 0 {
            self.error = (code, value);
        }
    }

    /// Decodes one packet, rendering it binaurally or queueing its stock decode, as the options ask.
    fn send(&mut self, packet: &[u8]) {
        let origin_us = self.origin_us.unwrap_or(0.0);
        let mut blocks = Vec::new();
        let stock = match self.source.push(packet, &mut |b| blocks.push(b)) {
            Ok(stock) => stock,
            Err(code) => return self.fail(code, 0),
        };
        if stock.rate > 0 {
            self.rate = stock.rate;
        }
        let stock_frames = if stock.channels > 0 { stock.samples.len() / stock.channels } else { 0 };
        if self.rendering_binaural() {
            if self.binaural.is_none() {
                match Pipeline::new() {
                    Ok(pipeline) => self.binaural = Some(Binaural { pipeline, origin: None, emitted: 0 }),
                    Err(_) => return self.fail(ERROR_RENDERER, 0),
                }
            }
            let objects = self.objects();
            let binaural = self.binaural.as_mut().expect("created above");
            let (mut left, mut right) = (Vec::new(), Vec::new());
            for block in blocks {
                binaural.origin.get_or_insert(block.start);
                binaural.pipeline.take(self.source.feed(), block, &mut |l, r| {
                    left.extend_from_slice(l);
                    right.extend_from_slice(r);
                });
            }
            if let Some(out) = take_render(binaural, origin_us, objects, left, right) {
                self.queue.push_back(out);
            }
        } else {
            // A render switched off mid-stream gives way to the stock decode: what it still holds
            // (its latency) comes out first, so the two meet at this packet's first sample.
            if let Some(mut binaural) = self.binaural.take() {
                let objects = self.objects();
                let (mut left, mut right) = (Vec::new(), Vec::new());
                binaural.pipeline.finish(self.source.feed(), &mut |l, r| {
                    left.extend_from_slice(l);
                    right.extend_from_slice(r);
                });
                // Only up to where the stock decode takes over: the flush pads past it.
                let held = (self.stock_frames).saturating_sub(binaural.origin.unwrap_or(0) + binaural.emitted) as usize;
                left.truncate(held);
                right.truncate(held);
                if let Some(out) = take_render(&mut binaural, origin_us, objects, left, right) {
                    self.queue.push_back(out);
                }
            }
            if stock_frames > 0 {
                let (planar, mask) = match to_wave(&stock) {
                    Ok(wave) => wave,
                    Err(mask) => return self.fail(ERROR_LAYOUT, (mask >> 18) as u32),
                };
                self.queue.push_back(OutBlock {
                    channels: planar,
                    mask,
                    rate: self.rate,
                    timestamp: micros(origin_us, self.stock_frames, self.rate),
                    objects: 0,
                    limited: false,
                });
            }
        }
        self.stock_frames += stock_frames as u64;
    }

    fn drain(&mut self) {
        let origin_us = self.origin_us.unwrap_or(0.0);
        let mut blocks = Vec::new();
        self.source.end(&mut |b| blocks.push(b));
        let objects = self.objects();
        if let Some(binaural) = self.binaural.as_mut() {
            let (mut left, mut right) = (Vec::new(), Vec::new());
            let mut emit = |l: &[f32], r: &[f32]| {
                left.extend_from_slice(l);
                right.extend_from_slice(r);
            };
            for block in blocks {
                binaural.origin.get_or_insert(block.start);
                binaural.pipeline.take(self.source.feed(), block, &mut emit);
            }
            binaural.pipeline.finish(self.source.feed(), &mut emit);
            if let Some(out) = take_render(binaural, origin_us, objects, left, right) {
                self.queue.push_back(out);
            }
        }
    }
}

/// SAFETY for every export below: `handle` is one `audio_decoder_create` returned and
/// `audio_decoder_destroy` has not freed; the engine calls an instance from one thread.
fn decoder<'a>(handle: *mut Decoder) -> &'a mut Decoder {
    unsafe { &mut *handle }
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_create(_codec: i32) -> *mut Decoder {
    let Some(source) = codec::Codec::new() else {
        return std::ptr::null_mut();
    };
    Box::into_raw(Box::new(Decoder {
        source,
        input: Vec::new(),
        render_mask: 0,
        binaural_asked: false,
        binaural: None,
        origin_us: None,
        stock_frames: 0,
        rate: RENDER_RATE,
        queue: Default::default(),
        current: None,
        error: (0, 0),
    }))
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_destroy(handle: *mut Decoder) {
    if !handle.is_null() {
        // SAFETY: as `decoder`, and freed once.
        unsafe { drop(Box::from_raw(handle)) }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_reserve_input(handle: *mut Decoder, byte_length: u32) -> *mut u8 {
    let d = decoder(handle);
    d.input.resize(byte_length.max(1) as usize, 0);
    d.input.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_configure(_handle: *mut Decoder, _byte_length: u32) -> i32 {
    // These codecs carry everything in their packets.
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_set_option(handle: *mut Decoder, key: u32, value: f64) -> i32 {
    let d = decoder(handle);
    match key {
        OPTION_RENDER_CHANNEL_MASK => d.render_mask = value as u32,
        OPTION_RENDER_BINAURAL => d.binaural_asked = value != 0.0,
        _ => {
            d.fail(ERROR_OPTION, key);
            return -1;
        }
    }
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_send(handle: *mut Decoder, byte_length: u32, timestamp: f64) -> i32 {
    let d = decoder(handle);
    d.origin_us.get_or_insert(timestamp);
    let packet = std::mem::take(&mut d.input);
    d.send(&packet[..byte_length as usize]);
    d.input = packet;
    if d.error.0 != 0 { -1 } else { 0 }
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_drain(handle: *mut Decoder) -> i32 {
    let d = decoder(handle);
    d.drain();
    if d.error.0 != 0 { -1 } else { 0 }
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_receive(handle: *mut Decoder) -> i32 {
    let d = decoder(handle);
    d.current = d.queue.pop_front();
    d.current.is_some() as i32
}

fn current(handle: *mut Decoder) -> Option<&'static OutBlock> {
    decoder(handle).current.as_ref()
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_frame_count(handle: *mut Decoder) -> u32 {
    current(handle).map_or(0, |b| b.channels[0].len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_sample_rate(handle: *mut Decoder) -> u32 {
    current(handle).map_or(RENDER_RATE, |b| b.rate)
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_channel_count(handle: *mut Decoder) -> u32 {
    current(handle).map_or(0, |b| b.channels.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_channel_mask(handle: *mut Decoder) -> u32 {
    current(handle).map_or(0, |b| b.mask)
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_channel_pointer(handle: *mut Decoder, channel: u32) -> *const f32 {
    current(handle).and_then(|b| b.channels.get(channel as usize)).map_or(std::ptr::null(), |c| c.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_timestamp(handle: *mut Decoder) -> f64 {
    current(handle).map_or(-1.0, |b| b.timestamp)
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_attribute(handle: *mut Decoder, key: u32) -> f64 {
    match (key, current(handle)) {
        (ATTRIBUTE_OBJECT_COUNT, Some(b)) => b.objects as f64,
        (ATTRIBUTE_LIMITED, Some(b)) => b.limited as u32 as f64,
        _ => f64::NAN,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_clear(handle: *mut Decoder) {
    // Before a seek or a source change: the next packet starts a stream of its own, with its own
    // time, so nothing decoded, buffered or rendered from the last one carries over.
    let d = decoder(handle);
    match codec::Codec::new() {
        Some(source) => d.source = source,
        None => d.fail(ERROR_DECODER, 0),
    }
    d.binaural = None;
    d.origin_us = None;
    d.stock_frames = 0;
    d.rate = RENDER_RATE;
    d.queue.clear();
    d.current = None;
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_error_code(handle: *mut Decoder) -> u32 {
    decoder(handle).error.0
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_decoder_error_value(handle: *mut Decoder) -> u32 {
    decoder(handle).error.1
}

#[cfg(all(test, not(any(feature = "package-eac3", feature = "package-dts"))))]
mod tests {
    use super::*;

    /// A raw TrueHD stream's access units, by the length each one's header gives.
    fn access_units(bytes: &[u8]) -> Vec<&[u8]> {
        let mut units = Vec::new();
        let mut at = 0;
        while at + 4 <= bytes.len() {
            let length = ((((bytes[at] & 0x0f) as usize) << 8) | bytes[at + 1] as usize) * 2;
            if length < 4 || at + length > bytes.len() {
                break;
            }
            units.push(&bytes[at..at + length]);
            at += length;
        }
        units
    }

    /// Each block out: its timestamp, channel mask and planar samples.
    type Out = Vec<(f64, u32, Vec<Vec<f32>>)>;

    fn receive(d: *mut Decoder, out: &mut Out) {
        while audio_decoder_receive(d) == 1 {
            let channels = (0..audio_decoder_channel_count(d))
                .map(|c| {
                    let n = audio_decoder_frame_count(d) as usize;
                    // SAFETY: the package's current block holds `n` samples per channel.
                    unsafe { std::slice::from_raw_parts(audio_decoder_channel_pointer(d, c), n) }.to_vec()
                })
                .collect();
            out.push((audio_decoder_timestamp(d), audio_decoder_channel_mask(d), channels));
        }
    }

    fn send(d: *mut Decoder, unit: &[u8], timestamp: f64, out: &mut Out) {
        let at = audio_decoder_reserve_input(d, unit.len() as u32);
        // SAFETY: the package reserved `unit.len()` bytes at `at`.
        unsafe { std::ptr::copy_nonoverlapping(unit.as_ptr(), at, unit.len()) };
        assert_eq!(audio_decoder_send(d, unit.len() as u32, timestamp), 0);
        receive(d, out);
    }

    /// Decodes from unit `from` on, after decoding units `..before` and clearing (a seek) if given.
    fn decode(units: &[&[u8]], binaural: bool, before: Option<usize>, from: usize) -> Out {
        let d = audio_decoder_create(0);
        audio_decoder_set_option(d, OPTION_RENDER_CHANNEL_MASK, 0x3 as f64);
        audio_decoder_set_option(d, OPTION_RENDER_BINAURAL, binaural as u32 as f64);
        let time = |unit: usize| 5_000_000.0 + (unit * 40) as f64 * 1e6 / 48_000.0;
        let mut out = Vec::new();
        if let Some(before) = before {
            for (i, unit) in units[..before].iter().enumerate() {
                send(d, unit, time(i), &mut out);
            }
            audio_decoder_clear(d);
            out.clear();
        }
        for (i, unit) in units.iter().enumerate().skip(from) {
            send(d, unit, time(i), &mut out);
        }
        audio_decoder_drain(d);
        receive(d, &mut out);
        audio_decoder_destroy(d);
        assert!(!out.is_empty());
        assert_eq!(out[0].0, time(from).round(), "the first block after the seek starts at its packet");
        out
    }

    #[test]
    fn after_a_seek_the_output_is_a_fresh_start() {
        // A seek: the engine clears the decoder and sends packets from elsewhere in the stream.
        for (name, bytes) in [
            ("objects", &include_bytes!("../tests/fixtures/truehd/fba_atmos_obj.mlp")[..]),
            ("channel bed", &include_bytes!("../tests/fixtures/truehd/fba_atmos_cbi.mlp")[..]),
        ] {
            // Both streams are silent, so this holds the timing and the blocks to a fresh start's; the samples
            // carried over before `clear` reset everything were checked on real streams.
            let units = access_units(bytes);
            let from = 128; // the second major sync, where a seek lands
            for binaural in [true, false] {
                let fresh = decode(&units, binaural, None, from);
                let seeked = decode(&units, binaural, Some(from / 2), from);
                assert!(fresh == seeked, "{name}, binaural {binaural}: a seek's output differs from a fresh start's");
            }
        }
    }
}
