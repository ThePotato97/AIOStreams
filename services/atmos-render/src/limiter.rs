//! The output limiters.
//!
//! `DolbyLimiter` is Atmos for Headphones' own peak limiter (`DolbyAudioProcessing.dll` 7.3.7,
//! process `sub_18003C9F0`, state from `sub_18003C870`, constants from `sub_180017330`). With the
//! render's x1/8 and the post chain's -14 dB before it, its fixed make-up (256 G = 40.09) brings
//! the output back to x1.0005, under a ceiling of 0.99987.
//!
//! `EngineLimiter` is Windows' audio-engine limiter (`CAudioLimiter` in AudioEng.dll 10.0.26100,
//! `ProcessLimiterBuffer` 0x1800083A0, `AllocateDelayLine` 0x18000CD08, `Initialize` 0x18000CE10),
//! which runs on every Windows output device after Dolby Atmos for Headphones.

/// Dolby's limiter block (B): the engine runs 256-frame blocks in four sub-blocks.
pub const DOLBY_BLOCK: usize = 64;
/// Threshold T (`dword_1802EDFB0`) and output gain G (`dword_1802EDFAC`); the output is
/// 256 G x the limited signal (make-up 40.09375, ceiling 256 G T = 0.999869).
const DOLBY_T: f32 = f32::from_bits(0x3CCC_4B60);
const DOLBY_G: f32 = f32::from_bits(0x3E20_6000);
/// The 48 kHz, B = 64 table (0x180332150): t0, t1, t2, t3, release coefficient c.
const DOLBY_RATE: [f32; 5] = [
    f32::from_bits(0x3F7A_2800),
    f32::from_bits(0x3CBB_0000),
    f32::from_bits(0x3F7E_8600),
    f32::from_bits(0x3BBD_0000),
    f32::from_bits(0x3F54_CC00),
];
/// `dword_18032CA40`, `dword_18032CA44`, `dword_18032CA48`.
const DOLBY_ADAPT_BELOW: f32 = f32::from_bits(0x3F57_6600);
const DOLBY_ADAPT_K: f32 = f32::from_bits(0x3F98_209C);
const DOLBY_ONE: f32 = f32::from_bits(0x3F80_0000);
/// The crossfade window for B = 64 (0x1803317C0); w[i] + w[63 - i] = 1.
const DOLBY_WINDOW: [u32; DOLBY_BLOCK] = [
    0x39200000, 0x3AB00000, 0x3B760000, 0x3BF10000, 0x3C470000, 0x3C944000, 0x3CCEC000, 0x3D094000,
    0x3D2FC000, 0x3D5AA000, 0x3D850000, 0x3D9EE000, 0x3DBAD000, 0x3DD8C000, 0x3DF8A000, 0x3E0D3000,
    0x3E1EF800, 0x3E319000, 0x3E450000, 0x3E593000, 0x3E6E1800, 0x3E81D000, 0x3E8CE800, 0x3E984400,
    0x3EA3DC00, 0x3EAFB400, 0x3EBBB800, 0x3EC7E800, 0x3ED43C00, 0x3EE0A800, 0x3EED2C00, 0x3EF9B800,
    0x3F032400, 0x3F096A00, 0x3F0FAC00, 0x3F15E200, 0x3F1C0C00, 0x3F222400, 0x3F282600, 0x3F2E1200,
    0x3F33DE00, 0x3F398C00, 0x3F3F1800, 0x3F447A00, 0x3F49B400, 0x3F4EC000, 0x3F539C00, 0x3F584200,
    0x3F5CB400, 0x3F60EC00, 0x3F64E800, 0x3F68A600, 0x3F6C2400, 0x3F6F6000, 0x3F725600, 0x3F750400,
    0x3F776C00, 0x3F798A00, 0x3F7B5E00, 0x3F7CE400, 0x3F7E1E00, 0x3F7F0A00, 0x3F7FA800, 0x3F7FF600,
];

/// Atmos for Headphones' peak limiter, ported from `sub_18003C9F0` (main path: enabled, no hard
/// clip), with `sub_18003C870`'s initial state. It works on blocks of 64 frames: the gain for a
/// block comes from its peak and the previous block's, and the block is output one block later,
/// crossfaded from the previous gain to the new one through the window.
pub struct DolbyLimiter {
    /// The delayed block, per channel (+0x58).
    delay: [[f32; DOLBY_BLOCK]; 2],
    /// Previous block's peak (+0x3C), gain of the delayed block (+0x40), gain history (+0x78,
    /// one entry for B = 64), g_s (+0x4C), gain (+0x50), release state s (+0x54), G_old (+0x74).
    prev_peak: f32,
    g_old: f32,
    history: f32,
    g_s: f32,
    gain: f32,
    s: f32,
    g_prev: f32,
}

impl Default for DolbyLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl DolbyLimiter {
    pub fn new() -> Self {
        // sub_18003C870: g_old = g_s = gain = s = 1, previous peak 0, history entries 1, the
        // delay line zeroed; sub_180017330 then sets G_old = G = 0.15661621 (sub_18003C2D0).
        Self {
            delay: [[0.0; DOLBY_BLOCK]; 2],
            prev_peak: 0.0,
            g_old: 1.0,
            history: 1.0,
            g_s: 1.0,
            gain: 1.0,
            s: 1.0,
            g_prev: DOLBY_G,
        }
    }

    /// One block of 64 frames per channel in, the previous block out (in place), limited and
    /// with the make-up gain.
    pub fn block(&mut self, left: &mut [f32], right: &mut [f32]) {
        debug_assert!(left.len() == DOLBY_BLOCK && right.len() == DOLBY_BLOCK);
        let w = |i: usize| f32::from_bits(DOLBY_WINDOW[i]);
        // The block's peak over both channels.
        let mut peak = 0f32;
        for &x in left.iter().chain(right.iter()) {
            peak = peak.max(x.abs());
        }
        self.g_old = self.gain;
        let d = peak.max(self.prev_peak) * self.g_s;
        self.prev_peak = peak;
        let r = if d > DOLBY_T { (DOLBY_ONE / d) * DOLBY_T } else { DOLBY_ONE };
        // The smallest of this r and the last ones (one for B = 64), then this one kept.
        let r_min = r.min(self.history);
        self.history = r;
        let target = r * self.g_s;
        let v = if self.gain > target {
            // attack: at once
            self.s = r;
            self.gain = target;
            r
        } else {
            // release toward the smallest recent r
            let c = DOLBY_RATE[4];
            self.s = self.s * c + (r_min - c * r_min);
            self.gain = target.min((self.g_s * self.s).max(self.gain));
            self.s
        };
        self.g_s = if DOLBY_ADAPT_BELOW > v {
            self.g_s * DOLBY_RATE[0] + v * self.g_s * DOLBY_ADAPT_K * DOLBY_RATE[1]
        } else {
            self.g_s * DOLBY_RATE[2] + DOLBY_RATE[3]
        };
        // Output the delayed block, crossfaded from the old gain to the new: 256 d (g_old G_old
        // w[63 - i] + g G w[i]); this block goes into the delay line.
        let old = self.g_old * self.g_prev;
        let new = self.gain * DOLBY_G;
        for (ch, x) in [left, right].into_iter().enumerate() {
            for i in 0..DOLBY_BLOCK {
                let dl = self.delay[ch][i];
                self.delay[ch][i] = x[i];
                x[i] = (w(DOLBY_BLOCK - 1 - i) * (old * dl) + dl * new * w(i)) * 256.0;
            }
        }
        self.g_prev = DOLBY_G;
    }
}

/// 0.985f (0x3F7C28F6): the engine limiter's ceiling, and its tracked peak at rest.
const ENGINE_CEILING: f32 = f32::from_bits(0x3F7C_28F6);

/// Windows' audio-engine limiter, ported from `CAudioLimiter::ProcessLimiterBuffer`. Each output
/// frame is the frame N frames earlier (the delay line); the gain for it comes from the incoming
/// frame's peak, so a peak is caught before it leaves the delay line.
pub struct EngineLimiter {
    /// N: 16, 32, 64 or 128 frames by sample rate (`AllocateDelayLine`).
    delay: usize,
    /// 1/N (this+0xB4).
    inv_delay: f32,
    /// The delay line, interleaved stereo, and where the oldest frame is.
    line: Vec<[f32; 2]>,
    at: usize,
    /// Gain (this+0xBC), ramp target (+0xC0), ramp step (+0xC4), tracked peak (+0xC8), frames
    /// left in the ramp (+0xD0).
    gain: f32,
    target: f32,
    step: f32,
    peak: f32,
    ramp: u32,
    /// exp(2.205/fs) and exp(-2.205/fs) (+0xD8, +0xE0), in double as the code keeps them.
    release: f64,
    decay: f64,
    /// A peak above 128 silences the rest of the buffer (+0xCC, BUFFER_SILENT).
    silenced: bool,
}

impl EngineLimiter {
    pub fn new(sample_rate: f32) -> Self {
        let delay = if sample_rate <= 16000.0 {
            16
        } else if sample_rate <= 32000.0 {
            32
        } else if sample_rate <= 64000.0 {
            64
        } else {
            128
        };
        let x = 2.205 / sample_rate as f64;
        Self {
            delay,
            inv_delay: 1.0 / delay as f32,
            line: vec![[0.0; 2]; delay],
            at: 0,
            // The constructor's values (0x1800421E8): gain 1, target 1, step 0, peak 0.985.
            gain: 1.0,
            target: 1.0,
            step: 0.0,
            peak: ENGINE_CEILING,
            ramp: 0,
            release: libm::exp(x),
            decay: libm::exp(-x),
            silenced: false,
        }
    }

    /// The delay it adds, in frames.
    pub fn latency(&self) -> usize {
        self.delay
    }

    /// One frame in (left, right), the frame N earlier out, limited.
    pub fn frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let [dl, dr] = self.line[self.at];
        self.line[self.at] = [l, r];
        self.at = (self.at + 1) % self.delay;
        if self.silenced {
            return (0.0, 0.0);
        }
        // The incoming frame's peak (ComputeMaxFrameValsInBuffer: the largest magnitude).
        let v14 = l.abs().max(r.abs());
        let mut v15 = self.peak;
        if v14 > v15 {
            if v14 > 128.0 {
                self.silenced = true;
                return (0.0, 0.0);
            }
            let v32 = ENGINE_CEILING / v14;
            if self.gain > v32 {
                if self.ramp != 0 {
                    let v36 = (self.gain - v32) * self.inv_delay;
                    if self.gain - self.ramp as f32 * v36 > self.target {
                        // The ramp under way would end above the new target: carry it on at
                        // its own step for as long as it takes to get there.
                        self.ramp += ((self.target - v32) / self.step).ceil() as u32;
                    } else {
                        self.ramp = self.delay as u32;
                        self.step = v36;
                    }
                } else {
                    self.ramp = self.delay as u32;
                    self.step = (self.gain - v32) * self.inv_delay;
                }
                self.target = v32;
            }
            self.peak = v14;
            v15 = v14;
        }
        if self.ramp != 0 {
            self.gain -= self.step;
            self.ramp -= 1;
        } else if v14 + v14 <= v15 && self.gain < 1.0 {
            self.gain = (self.gain as f64 * self.release) as f32;
            self.peak = (v15 as f64 * self.decay) as f32;
            if self.gain >= 1.0 || self.peak <= ENGINE_CEILING {
                self.gain = 1.0;
                self.peak = ENGINE_CEILING;
            }
        }
        if self.gain == 1.0 { (dl, dr) } else { (dl * self.gain, dr * self.gain) }
    }

    /// The end of a buffer: a peak above 128 silenced only that buffer.
    pub fn end_buffer(&mut self) {
        self.silenced = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dolby_window_crossfades_to_one() {
        for i in 0..DOLBY_BLOCK {
            let sum = f32::from_bits(DOLBY_WINDOW[i]) + f32::from_bits(DOLBY_WINDOW[DOLBY_BLOCK - 1 - i]);
            assert_eq!(sum, 1.0);
        }
    }

    /// Runs `blocks` of a stereo signal through, returning the output.
    fn dolby(signal: impl Fn(usize) -> f32, blocks: usize) -> Vec<f32> {
        let mut lim = DolbyLimiter::new();
        let mut out = Vec::new();
        for b in 0..blocks {
            let mut l: Vec<f32> = (0..DOLBY_BLOCK).map(|i| signal(b * DOLBY_BLOCK + i)).collect();
            let mut r = l.clone();
            lim.block(&mut l, &mut r);
            out.extend(l);
        }
        out
    }

    #[test]
    fn dolby_limiter_below_its_threshold_is_a_delay_and_the_make_up_gain() {
        // a signal at half the threshold comes out one block later at 256 G = 40.09375 times
        let x = |n: usize| 0.5 * DOLBY_T * (n as f32 * 0.01).sin();
        let out = dolby(x, 40);
        for n in DOLBY_BLOCK..out.len() {
            let expected = x(n - DOLBY_BLOCK) * 256.0 * DOLBY_G;
            assert!((out[n] - expected).abs() < 1e-6, "{n}: {} vs {expected}", out[n]);
        }
        assert_eq!(256.0 * DOLBY_G, 40.09375);
    }

    #[test]
    fn dolby_limiter_holds_a_loud_signal_at_its_ceiling() {
        // four times over the threshold: never above 256 G T = 0.99987 in the output
        let x = |n: usize| 4.0 * DOLBY_T * (n as f32 * 0.05).sin();
        let out = dolby(x, 200);
        let ceiling = 256.0 * DOLBY_G * DOLBY_T;
        let max = out.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(max <= ceiling * 1.0001, "{max} vs {ceiling}");
        assert!(max > 0.9 * ceiling, "{max}");
    }

    #[test]
    fn the_engine_limiter_delays_by_64_at_48k_and_passes_what_is_below_its_ceiling() {
        let mut l = EngineLimiter::new(48000.0);
        assert_eq!(l.latency(), 64);
        let input: Vec<f32> = (0..1000).map(|i| 0.9 * (i as f32 * 0.05).sin()).collect();
        let out: Vec<f32> = input.iter().map(|&x| l.frame(x, -x).0).collect();
        for i in 64..1000 {
            assert_eq!(out[i], input[i - 64]);
        }
    }

    /// 0.5, a peak of 2.0, then 0.3: quieter than half of where the tracked peak rests, so
    /// the release can run all the way (it only runs while 2|x| <= the tracked peak).
    fn run(l: &mut EngineLimiter, peak: std::ops::Range<usize>) -> Vec<f32> {
        (0..30000)
            .map(|i| {
                let x = if peak.contains(&i) {
                    2.0
                } else if i < peak.start {
                    0.5
                } else {
                    0.3
                };
                l.frame(x, x).0
            })
            .collect()
    }

    #[test]
    fn the_engine_limiter_brings_a_peak_down_to_its_ceiling_before_it_leaves() {
        // One frame over: the ramp's N steps start on the frame the peak arrives, so they end
        // one frame before it leaves the delay line, and the release has already applied once
        // when it does: the ceiling x exp(2.205/48000), 0.985045.
        let out = run(&mut EngineLimiter::new(48000.0), 500..501);
        let out = &out[..2000];
        let max = out.iter().fold(0f32, |m, v| m.max(v.abs()));
        let expected = (ENGINE_CEILING as f64 * (2.205f64 / 48000.0).exp()) as f32;
        assert!((max - expected).abs() < 1e-6, "{max} vs {expected}");
        // A longer peak: the code releases as soon as the incoming frames drop (2|x| <= peak),
        // while the rest of the peak is still in the delay line, so those frames come out a
        // little over the ceiling (x1.0000459 per frame): 20 frames, about 0.986.
        let out = run(&mut EngineLimiter::new(48000.0), 500..520);
        let max = out.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(max > ENGINE_CEILING && max < 0.9862, "{max}");
        // and, at +19.15 dB/s, it is back at full level about 0.32 s later
        assert!((out[29999] - 0.3).abs() < 1e-6);
        assert!(out[600] < 0.3 * 0.6, "still reduced just after the peak: {}", out[600]);
    }
}
