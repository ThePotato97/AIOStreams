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

use crate::complex::C32;
use crate::direct::{InputGains, Mode, input_gains, lfe_gains};
use crate::filterbank::{Analysis, LATENCY, Synthesis, Tables};
use crate::room::Room;
use crate::limiter::{DOLBY_BLOCK, DolbyLimiter, EngineLimiter};
use crate::tuning::{BANDS, OUTPUT_SCALE, POST_CHAIN_GAIN, Tuning};

pub const SLOT: usize = 64;
/// Metadata updates take effect per block of four slots.
pub const BLOCK: usize = 256;
pub use crate::filterbank::LATENCY as FILTERBANK_LATENCY;

/// What the renderer needs to know about an input for one block.
#[derive(Debug, Clone, Copy)]
pub enum Source {
    /// Dolby x/y/z, render mode, linear metadata gain, and whether the element is active
    /// (an inactive element isn't in the engine's descriptor array).
    Positioned { pos: [f32; 3], mode: Mode, gain: f32, active: bool },
    Lfe { gain: f32 },
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
        self.holds_room = false;
        for s in sources {
            let g = match *s {
                Source::Positioned { pos, mode, gain, .. } => input_gains(&self.t, pos, mode, gain),
                Source::Lfe { gain } => lfe_gains(gain),
                Source::Silent => lfe_gains(0.0),
            };
            // Any active Mid/Far element that isn't the LFE resets the room's hold, whatever its
            // gain or position.
            let active = matches!(*s, Source::Positioned { active: true, .. });
            self.holds_room |= g.holds_room && active;
            self.sends.push(g.send.iter().any(|&v| v != 0.0));
            self.gains.push(g);
        }
    }

    /// One slot: `inputs[i]` holds 64 samples of input i; writes 64 samples per ear.
    pub fn slot(&mut self, inputs: &[&[f32]], left: &mut [f32], right: &mut [f32]) {
        let mut ears = [[C32::ZERO; BANDS]; 2];
        let mut send = vec![[C32::ZERO; 4]; BANDS];
        while self.analyses.len() < inputs.len() {
            self.analyses.push(Analysis::new());
        }
        for (i, x) in inputs.iter().enumerate() {
            let h = self.analyses[i].process(&self.fb, x);
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
        self.synth[0].process(&self.fb, &ears[0], left);
        self.synth[1].process(&self.fb, &ears[1], right);
        for v in left.iter_mut().chain(right.iter_mut()) {
            *v = *v * OUTPUT_SCALE * POST_CHAIN_GAIN;
        }
        // A slot is one of the limiter's 64-frame blocks.
        self.dolby_limiter.block(left, right);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            (*l, *r) = self.engine_limiter.frame(*l, *r);
        }
        self.engine_limiter.end_buffer();
    }

    /// The filterbank's latency, then one block for Dolby's limiter and 64 frames for the
    /// engine limiter (at 48 kHz).
    pub const fn latency() -> usize {
        LATENCY + DOLBY_BLOCK + 64
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
                r.set_block(&[Source::Positioned { pos: bed_position(5).unwrap(), mode: Mode::Off, gain: 1.0, active: true }]);
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
                r.set_block(&[Source::Positioned { pos: bed_position(5).unwrap(), mode: Mode::Mid, gain: 1.0, active: true }]);
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

    #[test]
    fn the_lfe_stays_low() {
        let mut r = Renderer::new().unwrap();
        let n = 300;
        // at -20 dB, below the limiters' ceilings even with the LFE's +7 dB
        let x: Vec<f32> = (0..n * SLOT).map(|i| 0.1 * ((i as f32) * 2.0 * std::f32::consts::PI * 5000.0 / 48000.0).sin()).collect();
        let lo: Vec<f32> = (0..n * SLOT).map(|i| 0.1 * ((i as f32) * 2.0 * std::f32::consts::PI * 50.0 / 48000.0).sin()).collect();
        let run = |r: &mut Renderer, x: &[f32]| {
            let (mut l, mut rr) = (vec![0f32; n * SLOT], vec![0f32; n * SLOT]);
            for s in 0..n {
                if s % 4 == 0 {
                    r.set_block(&[Source::Lfe { gain: 1.0 }]);
                }
                let (a, b) = (s * SLOT, s * SLOT + SLOT);
                r.slot(&[&x[a..b]], &mut l[a..b], &mut rr[a..b]);
            }
            l[100 * SLOT..].iter().map(|s| s * s).sum::<f32>() / (n - 100) as f32 / SLOT as f32
        };
        let high = run(&mut r, &x);
        let mut r2 = Renderer::new().unwrap();
        let low = run(&mut r2, &lo);
        // ~+7 dB plateau at 50 Hz, at the output's net x1.0005; nothing at 5 kHz
        let low_db = 10.0 * (low / 0.005).log10();
        assert!((low_db - 7.0).abs() < 1.0, "50 Hz {low_db:.1} dB");
        assert!(high < low * 1e-4, "5 kHz leaks");
    }
}
