//! E-AC-3 Joint Object Coding: the EMDF container (found anywhere in a frame's bits, as the
//! payloads sit in skip fields), the JOC payload, and the upmix of the core channels to objects in
//! the 64-band JOC QMF domain. The structure is ported from Cavern (`ExtensibleMetadataDecoder`,
//! `JointObjectCoding*`); the values follow Windows' DD+ decoder (`DolbyDecMFT.dll`, parameters doc
//! Q16): its Huffman trees, band tables and QMF prototype are the ones here, its dequantisation
//! steps (410 and 205 in Q15, x16), clip gain, surround stage and output clip are applied as it
//! applies them. Each frame's 24 interpolated matrices come from that frame's payload.

use crate::bits::Bits;
use crate::complex::C32;
use crate::joc_tables::*;
use crate::qmf::{Analysis, Modulation, SUBBANDS, Synthesis};

const SYNC: u32 = 0x5838;
const OAMD_ID: u32 = 11;
const JOC_ID: u32 = 14;
const MAX_CHANNELS: usize = 7;
/// Windows' decoder takes at most 15 objects.
const MAX_OBJECTS: usize = 15;
/// Slots per frame.
const FRAME_SLOTS: usize = 24;
/// The surround stage's band-0 filter (re 0x1800EEE40, im 0x1800EEDE0), and the delay the other
/// bands and channels get to line up with it.
const SURROUND_FIR_RE: [f32; 21] = [
    0.0013996040, 0.0038391508, 0.0075126425, 0.0124193737, 0.0183674283, 0.0249701627, 0.0316790082,
    0.0378500037, 0.0428341255, 0.0460756160, 0.0472001210, 0.0460756160, 0.0428341255, 0.0378500037,
    0.0316790082, 0.0249701627, 0.0183674283, 0.0124193737, 0.0075126425, 0.0038391508, 0.0013996040,
];
const SURROUND_FIR_IM: [f32; 21] = [
    -0.0006242550, -0.0019234687, -0.0042654648, -0.0081683081, -0.0143272011, -0.0237598605,
    -0.0375723280, -0.0557756945, -0.0756827668, -0.0917247236, -0.5979374051, -0.0917247236,
    -0.0756827668, -0.0557756945, -0.0375723280, -0.0237598605, -0.0143272011, -0.0081683081,
    -0.0042654648, -0.0019234687, -0.0006242550,
];
const SURROUND_DELAY: usize = 10;

/// What one frame's EMDF container held.
pub struct Container {
    pub oamd: Option<(Vec<u8>, u32)>,
    pub joc: Option<JocFrame>,
}

/// Search a frame for a valid EMDF container (sync word at any bit offset).
pub fn find_container(frame: &[u8]) -> Option<Container> {
    let bits = frame.len() * 8;
    let mut b = Bits::new(frame);
    let mut pos = 0;
    while pos + 16 <= bits {
        b.pos = pos;
        if b.read(16) == Some(SYNC) {
            if let Some(c) = parse_container(frame, pos + 16) {
                if c.joc.is_some() || c.oamd.is_some() {
                    return Some(c);
                }
            }
        }
        pos += 1;
    }
    None
}

fn parse_container(frame: &[u8], start: usize) -> Option<Container> {
    let mut b = Bits::at(frame, start, frame.len() * 8);
    let length = b.read(16)? as usize;
    let end = b.pos + length * 8;
    if end > b.end {
        return None;
    }
    let mut version = b.read(2)?;
    if version == 3 {
        version += b.variable(2)?;
    }
    let mut key = b.read(3)?;
    if key == 7 {
        key += b.variable(3)?;
    }
    if version != 0 || key > 1 {
        return None;
    }
    let mut out = Container { oamd: None, joc: None };
    while b.pos < end {
        let mut id = b.read(5)?;
        if id == 0 {
            break;
        }
        if id == 0x1F {
            id += b.variable(5)?;
        }
        if id > JOC_ID {
            return None;
        }
        let has_offset = b.bit()?;
        let mut offset = 0;
        if has_offset {
            offset = b.read(12)? >> 1;
        }
        if b.bit()? {
            b.variable(11)?;
        }
        if b.bit()? {
            b.variable(2)?;
        }
        if b.bit()? {
            b.skip(8)?;
        }
        if !b.bit()? {
            let mut aligned = false;
            if !has_offset {
                aligned = b.bit()?;
                if aligned {
                    b.skip(2)?;
                }
            }
            if has_offset || aligned {
                b.skip(7)?;
            }
        }
        let payload_end = b.variable(8)? as usize * 8 + b.pos;
        if payload_end > end {
            return None;
        }
        match id {
            JOC_ID => out.joc = Some(JocFrame::read(&mut Bits::at(frame, b.pos, payload_end))?),
            OAMD_ID => out.oamd = Some((Bits::slice(frame, b.pos, payload_end), offset)),
            _ => {}
        }
        b.pos = payload_end;
    }
    Some(out)
}

#[derive(Clone, Default)]
struct ObjectInfo {
    active: bool,
    bands_index: usize,
    bands: usize,
    sparse: bool,
    quant: usize,
    steep: bool,
    points: usize,
    offsets: [usize; 2],
    /// sparse: channel index deltas and vector values per data point
    channel: [[i32; 23]; 2],
    vector: [[i32; 23]; 2],
    /// generic: per data point, channel, band
    matrix: Vec<[[i32; 23]; MAX_CHANNELS]>,
}

/// One frame's JOC payload.
pub struct JocFrame {
    /// `joc_dmx_config_idx`.
    pub dmx: u32,
    pub channels: usize,
    pub objects: usize,
    /// Clip gain: 2^(x - 4) (32 + y) / 512.
    pub gain: f32,
    info: Vec<ObjectInfo>,
}

fn huff(table: &[[i16; 2]], b: &mut Bits) -> Option<i32> {
    let mut node = 0i32;
    loop {
        node = table[node as usize][b.bit()? as usize] as i32;
        if node <= 0 {
            return Some(!node);
        }
    }
}

impl JocFrame {
    fn read(b: &mut Bits) -> Option<Self> {
        let dmx = b.read(3)?;
        if dmx > 4 {
            return None;
        }
        let channels = if dmx == 0 || dmx == 3 { 5 } else { 7 };
        let objects = b.read(6)? as usize + 1;
        if objects > MAX_OBJECTS {
            return None;
        }
        if b.read(3)? != 0 {
            return None; // joc_ext_config_idx
        }
        let x = b.read(3)? as i32;
        let y = b.read(5)? as f32;
        let gain = (2f32).powi(x - 4) * (32.0 + y) / 512.0;
        b.skip(10)?; // sequence counter
        let mut info = vec![ObjectInfo::default(); objects];
        for o in info.iter_mut() {
            o.active = b.bit()?;
            if o.active {
                o.bands_index = b.read(3)? as usize;
                o.bands = JOC_NUM_BANDS[o.bands_index] as usize;
                o.sparse = b.bit()?;
                o.quant = b.read(1)? as usize;
                o.steep = b.bit()?;
                o.points = b.read(1)? as usize + 1;
                if o.steep {
                    // Slot offsets: below 24 and increasing (Windows); used as offset + 1 (Cavern).
                    for dp in 0..o.points {
                        let raw = b.read(5)? as usize;
                        if raw >= FRAME_SLOTS || (dp > 0 && raw + 1 <= o.offsets[dp - 1]) {
                            return None;
                        }
                        o.offsets[dp] = raw + 1;
                    }
                }
            }
        }
        for o in info.iter_mut() {
            if !o.active {
                continue;
            }
            if o.sparse {
                let idx: &[[i16; 2]] =
                    if channels == 7 { &JOC_HUFF_CODE_7CH_POS_INDEX_SPARSE } else { &JOC_HUFF_CODE_5CH_POS_INDEX_SPARSE };
                let vec: &[[i16; 2]] =
                    if o.quant == 1 { &JOC_HUFF_CODE_FINE_COEFF_SPARSE } else { &JOC_HUFF_CODE_COARSE_COEFF_SPARSE };
                for dp in 0..o.points {
                    o.channel[dp][0] = b.read(3)? as i32;
                    for pb in 1..o.bands {
                        o.channel[dp][pb] = huff(idx, b)?;
                    }
                    for pb in 0..o.bands {
                        o.vector[dp][pb] = huff(vec, b)?;
                    }
                }
            } else {
                let table: &[[i16; 2]] =
                    if o.quant == 1 { &JOC_HUFF_CODE_FINE_GENERIC } else { &JOC_HUFF_CODE_COARSE_GENERIC };
                o.matrix = vec![[[0; 23]; MAX_CHANNELS]; o.points];
                for dp in 0..o.points {
                    for ch in 0..channels {
                        for pb in 0..o.bands {
                            o.matrix[dp][ch][pb] = huff(table, b)?;
                        }
                    }
                }
            }
        }
        Some(Self { dmx, channels, objects, gain, info })
    }
}

/// Parameter band of each QMF band, per band-count index.
fn band_map() -> [[usize; SUBBANDS]; 8] {
    std::array::from_fn(|i| {
        let starts = PARAMETER_BAND_STARTS[i];
        std::array::from_fn(|sb| starts.iter().rposition(|&s| s as usize <= sb).unwrap_or(0))
    })
}

/// The upmix state: previous matrices per object, the QMF banks, this frame's interpolation.
pub struct Upmix {
    m: Modulation,
    analysis: Vec<Analysis>,
    synthesis: Vec<Synthesis>,
    prev: Vec<[[f32; SUBBANDS]; MAX_CHANNELS]>,
    /// [object][timeslot][channel][band]
    interp: Vec<Vec<[[f32; SUBBANDS]; MAX_CHANNELS]>>,
    map: [[usize; SUBBANDS]; 8],
    pub channels: usize,
    pub objects: usize,
    dmx: u32,
    /// Clip gain: the previous frame's, and this frame's (ramped to over its first 256 samples).
    gain_from: f32,
    gain: f32,
    timeslot: usize,
    /// The surround stage's history: the last 21 slots of every channel's bands.
    history: Vec<[[C32; SUBBANDS]; MAX_CHANNELS]>,
}

impl Upmix {
    pub fn new() -> Self {
        Self {
            m: Modulation::new(),
            analysis: Vec::new(),
            synthesis: Vec::new(),
            prev: Vec::new(),
            interp: Vec::new(),
            map: band_map(),
            channels: 0,
            objects: 0,
            dmx: 0,
            gain_from: 1.0 / 16.0,
            gain: 1.0 / 16.0,
            timeslot: 0,
            history: Vec::new(),
        }
    }

    /// Take a frame's payload; `timeslots` = the frame's samples / 64.
    pub fn frame(&mut self, joc: &JocFrame, timeslots: usize) {
        self.channels = joc.channels;
        self.objects = joc.objects;
        self.dmx = joc.dmx;
        self.gain_from = self.gain;
        self.gain = joc.gain;
        while self.analysis.len() < MAX_CHANNELS {
            self.analysis.push(Analysis::new());
        }
        while self.synthesis.len() < joc.objects {
            self.synthesis.push(Synthesis::new());
            self.prev.push([[0.0; SUBBANDS]; MAX_CHANNELS]);
        }
        self.interp = (0..joc.objects).map(|o| self.matrices(joc, o, timeslots)).collect();
        self.timeslot = 0;
    }

    fn matrices(&mut self, joc: &JocFrame, obj: usize, timeslots: usize) -> Vec<[[f32; SUBBANDS]; MAX_CHANNELS]> {
        let ch_count = joc.channels;
        let o = &joc.info[obj];
        let mut out = vec![[[0f32; SUBBANDS]; MAX_CHANNELS]; timeslots];
        if !o.active {
            return out;
        }
        // Nq = 96 or 192 indices; dequantised as 410 (idx - 48) or 205 (idx - 96) in Q15, x16 in
        // the kernel: steps of 0.2001953 and 0.1000977.
        let nq = if o.quant == 1 { 192 } else { 96 };
        let center = nq / 2;
        let step = (if o.quant == 1 { 205.0 } else { 410.0 }) * 16.0 / 32768.0;
        // mix[dp][ch][pb]
        let mut mix = vec![[[0f32; 23]; MAX_CHANNELS]; o.points];
        if o.sparse {
            // one channel per band, the others at the centre; values offset 50 / 100
            let offset = if o.quant == 1 { 100 } else { 50 };
            for dp in 0..o.points {
                let mut channel = o.channel[dp][0];
                let mut value = offset;
                for pb in 0..o.bands {
                    if pb != 0 {
                        channel = (channel + o.channel[dp][pb]).rem_euclid(ch_count as i32);
                    }
                    value = (value + o.vector[dp][pb]).rem_euclid(nq);
                    for ch in 0..ch_count {
                        let v = if ch as i32 == channel { value } else { center };
                        mix[dp][ch][pb] = (v - center) as f32 * step;
                    }
                }
            }
        } else {
            // band 0 = (Nq/2 + s) mod Nq, then each band = previous + s, mod Nq
            for dp in 0..o.points {
                for ch in 0..ch_count {
                    let src = &o.matrix[dp][ch];
                    let mut idx = center;
                    for pb in 0..o.bands {
                        idx = (idx + src[pb]).rem_euclid(nq);
                        mix[dp][ch][pb] = (idx - center) as f32 * step;
                    }
                }
            }
        }
        let map = &self.map[o.bands_index];
        let prev = self.prev[obj];
        let expand = |m: &[[f32; 23]; MAX_CHANNELS]| -> [[f32; SUBBANDS]; MAX_CHANNELS] {
            std::array::from_fn(|ch| std::array::from_fn(|sb| m[ch][map[sb]]))
        };
        let first = expand(&mix[0]);
        if o.points == 1 {
            if o.steep {
                let split = o.offsets[0];
                for (ts, slot) in out.iter_mut().enumerate() {
                    *slot = if ts < split { prev } else { first };
                }
            } else {
                for (ts, slot) in out.iter_mut().enumerate() {
                    let a = (ts + 1) as f32 / timeslots as f32;
                    for ch in 0..ch_count {
                        for sb in 0..SUBBANDS {
                            slot[ch][sb] = prev[ch][sb] + (first[ch][sb] - prev[ch][sb]) * a;
                        }
                    }
                }
            }
        } else {
            let second = expand(&mix[1]);
            if o.steep {
                for (ts, slot) in out.iter_mut().enumerate() {
                    *slot = if ts < o.offsets[0] { prev } else if ts < o.offsets[1] { first } else { second };
                }
            } else {
                let half = timeslots / 2;
                for (i, slot) in out.iter_mut().enumerate() {
                    let ts = i + 1;
                    let (from, to, a) = if ts <= half {
                        (&prev, &first, ts as f32 / half as f32)
                    } else {
                        (&first, &second, (ts - half) as f32 / (timeslots - half) as f32)
                    };
                    for ch in 0..ch_count {
                        for sb in 0..SUBBANDS {
                            slot[ch][sb] = from[ch][sb] + (to[ch][sb] - from[ch][sb]) * a;
                        }
                    }
                }
            }
        }
        self.prev[obj] = expand(&mix[o.points - 1]);
        out
    }

    /// One timeslot: `core[ch]` 64 samples per JOC input channel (L R C Ls Rs [Lb Rb]);
    /// writes 64 samples per object.
    pub fn slot(&mut self, core: &[&[f32]], objects: &mut [Vec<f32>]) {
        let mut bands = [[C32::ZERO; SUBBANDS]; MAX_CHANNELS];
        // The clip gain multiplies the time-domain downmix, ramping from the previous frame's
        // to this frame's over the first 256 samples.
        let mut scaled = [0f32; SUBBANDS];
        for ch in 0..self.channels {
            for (k, v) in scaled.iter_mut().enumerate() {
                let n = self.timeslot * SUBBANDS + k;
                let g = if n < 256 { self.gain_from + (self.gain - self.gain_from) * n as f32 / 256.0 } else { self.gain };
                *v = core[ch][k] * g;
            }
            self.analysis[ch].process(&self.m, &scaled, &mut bands[ch]);
        }
        if self.dmx == 3 || self.dmx == 4 {
            bands = self.surround(bands);
        }
        let ts = self.timeslot.min(self.interp.first().map(|v| v.len().saturating_sub(1)).unwrap_or(0));
        for (obj, out) in objects.iter_mut().enumerate().take(self.objects) {
            let mtx = &self.interp[obj][ts];
            let mut q = [C32::ZERO; SUBBANDS];
            for ch in 0..self.channels {
                for sb in 0..SUBBANDS {
                    q[sb] += bands[ch][sb].scale(mtx[ch][sb]);
                }
            }
            out.resize(SUBBANDS, 0.0);
            self.synthesis[obj].process(&self.m, &q, out);
            // x16, clipped to +/-1
            for s in out.iter_mut() {
                *s = (*s * 16.0).clamp(-1.0, 1.0);
            }
        }
        self.timeslot += 1;
    }

    /// Downmix configs 3 and 4: channels 3 and 4 (the surrounds) times -j, in band 0 through a
    /// 21-tap complex filter across slots; every other band and channel delayed 10 slots to line
    /// up with it. Channels 3 and 4's bands from 1 up are delayed too [I: the notes say "the other
    /// channels"]; the matrices aren't delayed [I].
    fn surround(&mut self, bands: [[C32; SUBBANDS]; MAX_CHANNELS]) -> [[C32; SUBBANDS]; MAX_CHANNELS] {
        let taps = SURROUND_FIR_RE.len();
        if self.history.len() != taps {
            self.history = vec![[[C32::ZERO; SUBBANDS]; MAX_CHANNELS]; taps];
        }
        self.history.rotate_right(1);
        self.history[0] = bands;
        let mut out = self.history[SURROUND_DELAY];
        let minus_j = C32::new(0.0, -1.0);
        for ch in [3, 4] {
            for sb in 1..SUBBANDS {
                out[ch][sb] = out[ch][sb] * minus_j;
            }
            let mut acc = C32::ZERO;
            for t in 0..taps {
                acc += self.history[t][ch][0] * C32::new(SURROUND_FIR_RE[t], SURROUND_FIR_IM[t]);
            }
            out[ch][0] = acc;
        }
        out
    }
}
