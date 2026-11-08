//! Dolby Atmos for built-in speakers, as Windows renders it for a stereo endpoint (the speaker-path
//! trace: renderer.md, virtualizer.md, postchain.md, profile.md): DAP-VR output mode 11 with Dolby
//! Access's built-in-speaker settings.
//!
//! Per 64-sample slot: each input's 5.1.2 gains (speaker.rs), ramped linearly over ceil(ramp/64)
//! slots (an object's ramp from the stream's metadata, the encoder's 480 for beds), mix the inputs
//! in the time domain into L R C LFE Ls Rs Ltm
//! Rtm; each channel through the analysis filterbank; the speaker virtualizer on the front pair
//! (heard at 30 degrees), the surround pair and the top pair (90 degrees), all over two speakers
//! at 10 degrees, the profile's angle; Dolby Access's 8->2 matrix; the two outputs through the
//! synthesis filterbank, then the same gain chain and limiters as headphones.
//!
//! The profiles' post-processing (surround boost, dialogue enhancer, IEQ, regulator, graphic EQ,
//! media intelligence) isn't applied, as for headphones (DEVIATIONS.md 1); the height filter is
//! off in every speaker profile.

use crate::complex::C32;
use crate::filterbank::{Analysis, Synthesis, Tables};
use crate::limiter::{DolbyLimiter, EngineLimiter};
use crate::render::{SLOT, Source};
use crate::speaker::{C, CHANNELS, L, LFE, LS, LTM, R, RS, RTM, pan};
use crate::spkvirt::Pair;
use crate::tuning::{BANDS, OUTPUT_SCALE, POST_CHAIN_GAIN};

/// The profile's speaker angle for every pair, degrees (front / surround / height).
pub const SPEAKER_ANGLE: i32 = 10;

/// Dolby Access's mix matrix (Q14, identical to A's own 2-channel table for modes 10/11):
/// L, Ls and Ltm to the left at 1.0, R, Rs and Rtm to the right, C to both at 11583, the LFE to
/// both at 8192 (it enters at full level: the -10 dB LFE branch only runs without a matrix).
const MIX_C: f32 = 11583.0 / 16384.0;
const MIX_LFE: f32 = 8192.0 / 16384.0;

/// One input's gains: where it is now, where it's going, and how.
#[derive(Clone, Copy, Default)]
struct Ramp {
    cur: [f32; CHANNELS],
    target: [f32; CHANNELS],
    step: [f32; CHANNELS],
    left: u32,
}

pub struct SpeakerRenderer {
    fb: Tables,
    analyses: Vec<Analysis>,
    synth: [Synthesis; 2],
    /// front (0/1), surround (4/5), top (6/7)
    pairs: [Pair; 3],
    ramps: Vec<Ramp>,
    dolby_limiter: DolbyLimiter,
    engine_limiter: EngineLimiter,
}

impl SpeakerRenderer {
    pub fn new() -> Self {
        Self {
            fb: Tables::load(),
            analyses: (0..CHANNELS).map(|_| Analysis::new()).collect(),
            synth: [Synthesis::new(), Synthesis::new()],
            pairs: [
                Pair::new(30, SPEAKER_ANGLE),
                Pair::new(90, SPEAKER_ANGLE),
                Pair::new(90, SPEAKER_ANGLE),
            ],
            ramps: Vec::new(),
            dolby_limiter: DolbyLimiter::new(),
            engine_limiter: EngineLimiter::new(48000.0),
        }
    }

    /// Every input's target gains for the next block. A new input count starts every input from
    /// silence (new objects fade in); an input that turns off fades out.
    pub fn set_block(&mut self, sources: &[Source]) {
        if self.ramps.len() != sources.len() {
            self.ramps = vec![Ramp::default(); sources.len()];
        }
        for (ramp, s) in self.ramps.iter_mut().zip(sources) {
            let target = match *s {
                Source::Positioned { pos, gain, active: true, zone, .. } => pan(pos, zone).map(|g| g * gain),
                // the LFE goes to its channel untrimmed, never panned
                Source::Lfe { gain } => {
                    let mut t = [0.0; CHANNELS];
                    t[LFE] = gain;
                    t
                }
                _ => [0.0; CHANNELS],
            };
            if target != ramp.target {
                // linear over ceil(ramp / 64) slots; a ramp of 0 steps at once
                let slots = match *s {
                    Source::Positioned { ramp: samples, .. } => samples.div_ceil(SLOT as u32),
                    _ => crate::render::BED_RAMP.div_ceil(SLOT as u32),
                };
                ramp.target = target;
                if slots == 0 {
                    ramp.cur = target;
                    ramp.left = 0;
                } else {
                    ramp.step = std::array::from_fn(|c| (target[c] - ramp.cur[c]) / slots as f32);
                    ramp.left = slots;
                }
            }
        }
    }

    /// One slot: `inputs[i]` holds 64 samples of input i; writes 64 samples per speaker.
    pub fn slot(&mut self, inputs: &[&[f32]], left: &mut [f32], right: &mut [f32]) {
        let mut mix = [[0f32; SLOT]; CHANNELS];
        for (i, x) in inputs.iter().enumerate() {
            let Some(ramp) = self.ramps.get_mut(i) else { continue };
            // a gain per slot, constant within it
            if ramp.left > 0 {
                ramp.left -= 1;
                ramp.cur = if ramp.left == 0 { ramp.target } else { std::array::from_fn(|c| ramp.cur[c] + ramp.step[c]) };
            }
            for c in 0..CHANNELS {
                let g = ramp.cur[c];
                if g == 0.0 {
                    continue;
                }
                for (m, v) in mix[c].iter_mut().zip(x.iter()) {
                    *m += g * v;
                }
            }
        }
        let mut h: [[C32; BANDS]; CHANNELS] = std::array::from_fn(|c| self.analyses[c].process(&self.fb, &mix[c]));
        let [front, surround, top] = &mut self.pairs;
        let (lo, hi) = h.split_at_mut(LS);
        let (l, r) = lo.split_at_mut(R);
        front.process(&mut l[L], &mut r[0]);
        let (ls, rest) = hi.split_at_mut(RS - LS);
        let (rs, tops) = rest.split_at_mut(LTM - RS);
        surround.process(&mut ls[0], &mut rs[0]);
        let (ltm, rtm) = tops.split_at_mut(RTM - LTM);
        top.process(&mut ltm[0], &mut rtm[0]);
        let mut out = [[C32::ZERO; BANDS]; 2];
        for b in 0..BANDS {
            let shared = h[C][b].scale(MIX_C) + h[LFE][b].scale(MIX_LFE);
            out[0][b] = h[L][b] + h[LS][b] + h[LTM][b] + shared;
            out[1][b] = h[R][b] + h[RS][b] + h[RTM][b] + shared;
        }
        self.synth[0].process(&self.fb, &out[0], left);
        self.synth[1].process(&self.fb, &out[1], right);
        for v in left.iter_mut().chain(right.iter_mut()) {
            *v = *v * OUTPUT_SCALE * POST_CHAIN_GAIN;
        }
        // linked across both speakers, as across both ears
        self.dolby_limiter.block(left, right);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            (*l, *r) = self.engine_limiter.frame(*l, *r);
        }
        self.engine_limiter.end_buffer();
    }
}

impl Default for SpeakerRenderer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::direct::Mode;
    use crate::render::Renderer;

    /// The steady level of a 1 kHz sine at `amp` through the renderer, per speaker.
    fn level(sources: &[Source], amp: f32) -> (f32, f32) {
        let mut r = SpeakerRenderer::new();
        let n = 48000;
        let x: Vec<f32> = (0..n).map(|i| amp * (i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0).sin()).collect();
        let (mut pl, mut pr) = (0f32, 0f32);
        let (mut l, mut rr) = ([0f32; SLOT], [0f32; SLOT]);
        for s in 0..n / SLOT {
            if s % 4 == 0 {
                r.set_block(sources);
            }
            let slot = &x[s * SLOT..(s + 1) * SLOT];
            let inputs: Vec<&[f32]> = sources.iter().map(|_| slot).collect();
            r.slot(&inputs, &mut l, &mut rr);
            if s * SLOT > n / 2 {
                pl = l.iter().fold(pl, |m, v| m.max(v.abs()));
                pr = rr.iter().fold(pr, |m, v| m.max(v.abs()));
            }
        }
        (pl / amp, pr / amp)
    }

    #[test]
    fn a_front_centre_object_reaches_each_speaker_at_the_traced_level() {
        // postchain.md section 7: x 0.70795 (the input headroom, applied before the renderer) x 1.0
        // x 0.99995 x 0.70697 = 0.5005 per speaker; here without the headroom: 0.99995 x 0.70697
        let centre = Source::Positioned { pos: [0.5, 0.0, 0.0], mode: Mode::Mid, gain: 1.0, active: true, ramp: 480, zone: 0 };
        let (l, r) = level(&[centre], 0.1);
        let want = 0.99995 * MIX_C;
        assert!((l - want).abs() < 2e-3 && (r - want).abs() < 2e-3, "{l} {r} vs {want}");
        // with the headroom the input stage applies: the trace's 0.5005 (-6.0 dB)
        assert!((l * crate::tuning::INPUT_HEADROOM - 0.5005).abs() < 2e-3, "{}", l * crate::tuning::INPUT_HEADROOM);
    }

    #[test]
    fn the_lfe_reaches_each_speaker_at_half() {
        let (l, r) = level(&[Source::Lfe { gain: 1.0 }], 0.1);
        let want = 0.99995 * MIX_LFE;
        assert!((l - want).abs() < 2e-3 && (r - want).abs() < 2e-3, "{l} {r} vs {want}");
    }

    #[test]
    fn a_left_object_is_cancelled_into_both_speakers() {
        // L-only content: no centre to extract, so the canceller acts fully below 5.1 kHz and
        // puts anti-phase crosstalk in the right speaker
        let left = Source::Positioned { pos: [0.0, 0.0, 0.0], mode: Mode::Mid, gain: 1.0, active: true, ramp: 480, zone: 0 };
        let (l, r) = level(&[left], 0.1);
        assert!(l > 0.0 && r > 0.0 && r < l, "{l} {r}");
    }

    #[test]
    fn gains_ramp_over_the_elements_own_ramp() {
        let at = |ramp| Source::Positioned { pos: [0.5, 0.0, 0.0], mode: Mode::Mid, gain: 1.0, active: true, ramp, zone: 0 };
        let silence = [0f32; SLOT];
        let (mut l, mut r) = ([0f32; SLOT], [0f32; SLOT]);
        // a ramp of 0 steps at once
        let mut sr = SpeakerRenderer::new();
        sr.set_block(&[at(0)]);
        sr.slot(&[&silence], &mut l, &mut r);
        assert_eq!(sr.ramps[0].cur[C], 1.0);
        // 960 samples: 15 slots, a fifteenth each, the target on the last
        let mut sr = SpeakerRenderer::new();
        sr.set_block(&[at(960)]);
        sr.slot(&[&silence], &mut l, &mut r);
        assert!((sr.ramps[0].cur[C] - 1.0 / 15.0).abs() < 1e-6);
        for _ in 0..14 {
            sr.slot(&[&silence], &mut l, &mut r);
        }
        assert_eq!(sr.ramps[0].cur[C], 1.0);
    }

    #[test]
    fn same_latency_as_headphones() {
        // nothing in the virtualizer delays; the filterbank and limiters are the same
        assert_eq!(Renderer::latency(), crate::filterbank::LATENCY + crate::limiter::DOLBY_BLOCK + 64);
    }
}
