//! The renderer: every input through the analysis filterbank, its per-band gains (direct path,
//! LFE or room send) updated once per 256-sample block, the room on the FOA bus, and the two ears
//! through the synthesis filterbank.
//!
//! Absolute level as traced: the filterbank reconstructs at unity (0.999991 in the engine), the
//! common x8 undoes the metadata-gain convention and so isn't applied to linear gains, the
//! binaural output is scaled by 2^-3, the post chain applies -14 dB, and Dolby's peak limiter's
//! make-up (x40.09) brings it back to x1.0005 under a ceiling of 0.99987. Windows' audio-engine
//! limiter (0.985) follows, as on every Windows output device.
//! (The encoder's input headroom is applied to the samples in `input.rs`.)
//!
//! Post-processing: the headphone Movie profile's (`profile_rtp_by_profile.csv`), which is the
//! volume leveler at amount 4 and, with it, volmax (+4 dB) before the peak limiter (`leveler.rs`).
//! DAP processes a block at a time: the leveler measures a block's band powers and its gains apply
//! to that same block, so the renderer holds one block of QMF before synthesis.

use crate::complex::C32;
use crate::direct::{InputGains, Mode, input_gains, lfe_gains};
use crate::filterbank::{Analysis, LATENCY, Synthesis, Tables};
use crate::leveler::{Leveler, NB, VOLMAX_DB, band_of_bin, band_powers};
use crate::room::Room;
use crate::limiter::{DOLBY_BLOCK, DolbyLimiter, EngineLimiter};
use crate::tuning::{BANDS, OUTPUT_SCALE, POST_CHAIN_GAIN, Tuning};

pub const SLOT: usize = 64;
/// The Windows encoder's default ramp, samples (E `ResetMetadata`): what bed channels and
/// channel-based input keep; objects take their own from the stream's metadata (metadata item
/// 10, which Windows' decoder sets from OAMD: Q12, Q15).
pub const BED_RAMP: u32 = 480;
/// Metadata updates take effect per block of four slots.
pub const BLOCK: usize = 256;
pub use crate::filterbank::LATENCY as FILTERBANK_LATENCY;

/// What the renderer needs to know about an input for one block.
#[derive(Debug, Clone, Copy)]
pub enum Source {
    /// Dolby x/y/z, render mode, linear metadata gain, whether the element is active (an
    /// inactive element isn't in the engine's descriptor array), and its ramp duration in samples
    /// (the speaker renderer's gain ramp; the headphone renderer's smoothing is the scene's), and
    /// an object's zone constraint index (0: none; only the speaker renderer reads it).
    Positioned { pos: [f32; 3], mode: Mode, gain: f32, active: bool, ramp: u32, zone: u8 },
    Lfe { gain: f32 },
    /// One of the two stereo-bypass inputs (side 0 left, 1 right): A's bypass list (slots 17/18,
    /// `dapvr_prepare_impl` +0x32C8 = 2, routing +0x32D0) with `stereo_cp_bypass_mode` 1. Not
    /// panned, no HRTF, no room, no upmix, no virtualizer: analysed, x2^-3 like the render, the
    /// same content processing as the main mix, then summed into output L/R (A 0x18000AEC8).
    Bypass { side: usize, gain: f32 },
    Silent,
}

pub struct Renderer {
    t: Tuning,
    fb: Tables,
    analyses: Vec<Analysis>,
    synth: [Synthesis; 2],
    room: Room,
    gains: Vec<InputGains>,
    holds_room: bool,
    sends: Vec<bool>,
    /// Per input: Some((side, gain)) for a stereo-bypass input.
    bypass: Vec<Option<(usize, f32)>>,
    leveler: Leveler,
    /// The leveler's band gains for the last block finished, dB.
    leveled_db: [f64; NB],
    band_of: [usize; BANDS],
    /// This block's rendered QMF slots, per ear.
    held: Vec<[[C32; BANDS]; 2]>,
    /// The previous block's output, handed out a slot at a time.
    ready: [[f32; BLOCK]; 2],
    dolby_limiter: DolbyLimiter,
    engine_limiter: EngineLimiter,
}

impl Renderer {
    pub fn new() -> anyhow::Result<Self> {
        let t = Tuning::load()?;
        let room = Room::new(&t);
        Ok(Self {
            t,
            fb: Tables::load(),
            analyses: Vec::new(),
            synth: [Synthesis::new(), Synthesis::new()],
            room,
            gains: Vec::new(),
            holds_room: false,
            sends: Vec::new(),
            bypass: Vec::new(),
            leveler: Leveler::movie(),
            leveled_db: [0.0; NB],
            band_of: band_of_bin(),
            held: Vec::with_capacity(BLOCK / SLOT),
            ready: [[0.0; BLOCK]; 2],
            dolby_limiter: DolbyLimiter::new(),
            engine_limiter: EngineLimiter::new(48000.0),
        })
    }

    /// Set every input's gains for the next block.
    pub fn set_block(&mut self, sources: &[Source]) {
        while self.analyses.len() < sources.len() {
            self.analyses.push(Analysis::new());
        }
        self.gains.clear();
        self.sends.clear();
        self.bypass.clear();
        self.holds_room = false;
        for s in sources {
            self.bypass.push(match *s {
                Source::Bypass { side, gain } => Some((side, gain)),
                _ => None,
            });
            let g = match *s {
                Source::Positioned { pos, mode, gain, .. } => input_gains(&self.t, pos, mode, gain),
                Source::Lfe { gain } => lfe_gains(gain),
                // added after the render (`slot`)
                Source::Bypass { .. } | Source::Silent => lfe_gains(0.0),
            };
            // Any active Mid/Far element that isn't the LFE resets the room's hold, whatever its
            // gain or position.
            let active = matches!(*s, Source::Positioned { active: true, .. });
            self.holds_room |= g.holds_room && active;
            self.sends.push(g.send.iter().any(|&v| v != 0.0));
            self.gains.push(g);
        }
    }

    /// One slot: `inputs[i]` holds 64 samples of input i; writes 64 samples per ear, a block
    /// later (`latency`). Slots come four to a block, the first after `set_block`.
    pub fn slot(&mut self, inputs: &[&[f32]], left: &mut [f32], right: &mut [f32]) {
        let mut ears = [[C32::ZERO; BANDS]; 2];
        let mut send = vec![[C32::ZERO; 4]; BANDS];
        let mut bypass = [[C32::ZERO; BANDS]; 2];
        while self.analyses.len() < inputs.len() {
            self.analyses.push(Analysis::new());
        }
        for (i, x) in inputs.iter().enumerate() {
            let h = self.analyses[i].process(&self.fb, x);
            if let Some(&Some((side, gain))) = self.bypass.get(i) {
                for b in 0..BANDS {
                    bypass[side][b] += h[b].scale(gain);
                }
                continue;
            }
            // an input without state for this block (metadata not yet seen) is silent
            let Some(g) = self.gains.get(i) else { continue };
            for b in 0..BANDS {
                ears[0][b] += g.ears[0][b] * h[b];
                ears[1][b] += g.ears[1][b] * h[b];
            }
            if self.sends[i] {
                for b in 0..BANDS {
                    for k in 0..4 {
                        send[b][k] += h[b].scale(g.send[k]);
                    }
                }
            }
        }
        self.room.process(&self.t, &send, self.holds_room, &mut ears);
        // the stereo-bypass pair into output L/R; the x2^-3 and the post chain below apply to both
        for (ear, b) in ears.iter_mut().zip(bypass.iter()) {
            for (e, v) in ear.iter_mut().zip(b.iter()) {
                *e += *v;
            }
        }
        let k = self.held.len();
        left.copy_from_slice(&self.ready[0][k * SLOT..(k + 1) * SLOT]);
        right.copy_from_slice(&self.ready[1][k * SLOT..(k + 1) * SLOT]);
        self.held.push(ears);
        if self.held.len() == BLOCK / SLOT {
            self.finish_block();
        }
    }

    /// The block's post-processing and output: the leveler on both ears' band powers (one group),
    /// its gains on every hybrid bin of each band for the whole block, synthesis, the x2^-3, the
    /// post chain's -14 dB, volmax, then the limiters.
    fn finish_block(&mut self) {
        let mut held = std::mem::take(&mut self.held);
        let p: [[f64; NB]; 2] = std::array::from_fn(|ear| {
            let slots: Vec<[C32; BANDS]> = held.iter().map(|s| s[ear]).collect();
            band_powers(&slots)
        });
        let (db, _) = self.leveler.process(&p);
        self.leveled_db = db;
        // [I]: DAP converts with its own 2^x (sub_18000E770); this is the exact power
        let gain: [f32; NB] = std::array::from_fn(|b| 10f32.powf(db[b] as f32 / 20.0));
        let scale = OUTPUT_SCALE * POST_CHAIN_GAIN * 10f32.powf(VOLMAX_DB / 20.0);
        for (k, slot) in held.iter_mut().enumerate() {
            for ear in 0..2 {
                for (bin, x) in slot[ear].iter_mut().enumerate() {
                    *x = x.scale(gain[self.band_of[bin]]);
                }
            }
            let (l, r) = self.ready.split_at_mut(1);
            let (left, right) = (&mut l[0][k * SLOT..(k + 1) * SLOT], &mut r[0][k * SLOT..(k + 1) * SLOT]);
            self.synth[0].process(&self.fb, &slot[0], left);
            self.synth[1].process(&self.fb, &slot[1], right);
            for v in left.iter_mut().chain(right.iter_mut()) {
                *v *= scale;
            }
            // A slot is one of the limiter's 64-frame blocks.
            self.dolby_limiter.block(left, right);
            for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                (*l, *r) = self.engine_limiter.frame(*l, *r);
            }
            self.engine_limiter.end_buffer();
        }
        held.clear();
        self.held = held;
    }

    /// The leveler's band gains for the last block finished, dB (DAP bands, `leveler::EDGES`).
    pub fn leveled_db(&self) -> [f64; NB] {
        self.leveled_db
    }

    /// The filterbank's latency, one block held for the post-processing, then one block for
    /// Dolby's limiter and 64 frames for the engine limiter (at 48 kHz).
    pub const fn latency() -> usize {
        LATENCY + BLOCK + DOLBY_BLOCK + 64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::direct::bed_position;

    /// A left source arrives later at the right ear, and louder at the left.
    #[test]
    fn a_left_source_is_louder_and_earlier_in_the_left_ear() {
        let mut r = Renderer::new().unwrap();
        let n = 120;
        let mut l = vec![0f32; n * SLOT];
        let mut rr = vec![0f32; n * SLOT];
        let mut x = vec![0f32; n * SLOT];
        x[10 * SLOT] = 1.0;
        for s in 0..n {
            if s % 4 == 0 {
                r.set_block(&[Source::Positioned { pos: bed_position(5).unwrap(), mode: Mode::Off, gain: 1.0, active: true, ramp: BED_RAMP, zone: 0 }]);
                // Off has no HRTF: use Mid for the real test below; Off checked for the pan side
            }
            let (a, b) = (s * SLOT, s * SLOT + SLOT);
            r.slot(&[&x[a..b]], &mut l[a..b], &mut rr[a..b]);
        }
        let e = |v: &[f32]| v.iter().map(|s| s * s).sum::<f32>();
        assert!(e(&l) > e(&rr) * 10.0, "Off mode pans a left channel left");

        let mut r = Renderer::new().unwrap();
        let (mut l, mut rr) = (vec![0f32; n * SLOT], vec![0f32; n * SLOT]);
        for s in 0..n {
            if s % 4 == 0 {
                r.set_block(&[Source::Positioned { pos: bed_position(5).unwrap(), mode: Mode::Mid, gain: 1.0, active: true, ramp: BED_RAMP, zone: 0 }]);
            }
            let (a, b) = (s * SLOT, s * SLOT + SLOT);
            r.slot(&[&x[a..b]], &mut l[a..b], &mut rr[a..b]);
        }
        // direct sound: the first 3 ms after the latency
        let start = 10 * SLOT + Renderer::latency() - 64;
        let (dl, dr) = (&l[start..start + 200], &rr[start..start + 200]);
        let ild = 10.0 * (e(dl) / e(dr)).log10();
        assert!(ild > 6.0, "side source ILD {ild:.1} dB");
        // The ITD is a phase in bands 0-19 only (below ~2.6 kHz): low-pass, then cross-correlate.
        let lowpass = |v: &[f32]| {
            let mut out = v.to_vec();
            for _ in 0..4 {
                let mut y = 0f32;
                for s in out.iter_mut() {
                    y += 0.12 * (*s - y);
                    *s = y;
                }
            }
            out
        };
        let (fl, fr) = (lowpass(&l[start - 200..start + 600]), lowpass(&rr[start - 200..start + 600]));
        let corr = |d: i32| (100..700).map(|i| fl[i] * fr[(i as i32 + d) as usize]).sum::<f32>();
        let lag = (-60..60).max_by(|&a, &b| corr(a).partial_cmp(&corr(b)).unwrap()).unwrap();
        // the traced ITD at the side corner is 651 us = 31 samples
        assert!((24..=38).contains(&lag), "right ear lag {lag} samples");
        // the room follows the direct sound
        let tail = e(&l[start + 2000..start + 6000]);
        assert!(tail > 0.0 && tail < e(dl));
    }

    /// Runs one input as `source` for `n` slots; the output and the leveler's gain in `band`
    /// for each block, dB.
    fn run(source: Source, x: &[f32], band: usize) -> (Vec<f32>, Vec<f32>, Vec<f64>) {
        let n = x.len() / SLOT;
        let mut r = Renderer::new().unwrap();
        let (mut l, mut rr) = (vec![0f32; n * SLOT], vec![0f32; n * SLOT]);
        let mut gains = Vec::new();
        for s in 0..n {
            if s % 4 == 0 {
                r.set_block(&[source]);
            }
            let (a, b) = (s * SLOT, s * SLOT + SLOT);
            r.slot(&[&x[a..b]], &mut l[a..b], &mut rr[a..b]);
            if s % 4 == 3 {
                gains.push(r.leveled_db()[band]);
            }
        }
        (l, rr, gains)
    }

    fn sine(f: f32, amp: f32, n: usize) -> Vec<f32> {
        (0..n * SLOT).map(|i| amp * ((i as f32) * 2.0 * std::f32::consts::PI * f / 48000.0).sin()).collect()
    }

    #[test]
    fn the_stereo_bypass_reaches_its_ear_without_hrtf_or_room() {
        // a sine at the centre of DAP band 9 (QMF band 4, 1687.5 Hz) into the left bypass: in the
        // left ear only, at the chain's net x1.0005 times the leveler's gain for that band and
        // volmax; 4 s, so the leveler has settled
        let n = 3000;
        let (l, rr, gains) = run(Source::Bypass { side: 0, gain: 1.0 }, &sine(1687.5, 0.1, n), 9);
        let tail = &l[(n - 200) * SLOT..];
        let peak = tail.iter().fold(0f32, |m, s| m.max(s.abs())) / 0.1;
        let g = gains[gains.len() - 60..].iter().sum::<f64>() / 60.0;
        let want = 1.0005 * 10f64.powf((g + crate::leveler::VOLMAX_DB as f64) / 20.0);
        assert!(gains[gains.len() - 60..].iter().all(|v| (v - g).abs() < 0.05), "the leveler hasn't settled");
        assert!((peak as f64 / want - 1.0).abs() < 0.012, "left {peak} vs {want} (leveler {g:.2} dB)");
        let right = rr[(n - 200) * SLOT..].iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!(right < 1e-5, "right {right}");
    }

    #[test]
    fn the_lfe_stays_low() {
        // at -20 dB, below the limiters' ceilings even with the LFE's +7 dB and volmax
        let n = 300;
        let (high, ..) = run(Source::Lfe { gain: 1.0 }, &sine(5000.0, 0.1, n), 0);
        let (low, _, gains) = run(Source::Lfe { gain: 1.0 }, &sine(50.0, 0.1, n), 0);
        let power = |v: &[f32]| v[100 * SLOT..].iter().map(|s| s * s).sum::<f32>() / ((n - 100) * SLOT) as f32;
        // ~+7 dB plateau at 50 Hz at the output's net x1.0005, plus band 0's leveler gain and
        // volmax; nothing at 5 kHz
        let g = gains[gains.len() - 20..].iter().sum::<f64>() / 20.0;
        let low_db = 10.0 * (power(&low) / 0.005).log10() as f64 - g - crate::leveler::VOLMAX_DB as f64;
        assert!((low_db - 7.0).abs() < 1.0, "50 Hz {low_db:.1} dB (leveler {g:.2} dB)");
        assert!(power(&high) < power(&low) * 1e-4, "5 kHz leaks");
    }
}
