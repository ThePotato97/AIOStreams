//! The output limiters.
//!
//! `EngineLimiter` is Windows' audio-engine limiter (`CAudioLimiter` in AudioEng.dll 10.0.26100,
//! `ProcessLimiterBuffer` 0x1800083A0, `AllocateDelayLine` 0x18000CD08, `Initialize` 0x18000CE10),
//! which runs on every Windows output device after Dolby Atmos for Headphones.

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
            release: x.exp(),
            decay: (-x).exp(),
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
