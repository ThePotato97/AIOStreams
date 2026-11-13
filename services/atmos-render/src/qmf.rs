//! The 64-band complex QMF (640-tap prototype), as used by E-AC-3 JOC: analysis of 64 real
//! samples per slot into 64 complex subbands, and synthesis back. Ported from Cavern's
//! `QuadratureMirrorFilterBank`.

use crate::complex::C32;
use crate::qmf_window::QMF_WINDOW;

pub const SUBBANDS: usize = 64;
/// Samples an analysis + synthesis round trip delays its input by.
pub const ROUND_TRIP_DELAY: usize = 577;
const DOUBLE: usize = SUBBANDS * 2;
const TAPS: usize = 640;

pub struct Modulation {
    fwd: Vec<[C32; DOUBLE]>,
    inv: Vec<[C32; DOUBLE]>,
}

impl Modulation {
    pub fn new() -> Self {
        let mut fwd = vec![[C32::ZERO; DOUBLE]; SUBBANDS];
        let mut inv = vec![[C32::ZERO; DOUBLE]; SUBBANDS];
        for sb in 0..SUBBANDS {
            for j in 0..DOUBLE {
                let e = std::f64::consts::PI * (sb as f64 + 0.5) * (j as f64 - 0.5) / SUBBANDS as f64;
                fwd[sb][j] = C32::new(libm::cos(e) as f32, libm::sin(e) as f32);
                let e = std::f64::consts::PI * (sb as f64 + 0.5) * (j as f64 - DOUBLE as f64 + 0.5)
                    / SUBBANDS as f64;
                inv[sb][j] = C32::new((libm::cos(e) / SUBBANDS as f64) as f32, (libm::sin(e) / SUBBANDS as f64) as f32);
            }
        }
        Self { fwd, inv }
    }
}

pub struct Analysis {
    stream: [f32; TAPS],
}

impl Analysis {
    pub fn new() -> Self {
        Self { stream: [0.0; TAPS] }
    }

    /// One slot: 64 new samples in, 64 complex subbands out.
    pub fn process(&mut self, m: &Modulation, input: &[f32], out: &mut [C32; SUBBANDS]) {
        self.stream.copy_within(0..TAPS - SUBBANDS, SUBBANDS);
        for i in 0..SUBBANDS {
            self.stream[i] = input[SUBBANDS - 1 - i];
        }
        let mut grouping = [0f32; DOUBLE];
        for (g, z) in grouping.iter_mut().enumerate() {
            let mut acc = 0.0;
            let mut s = g;
            while s < TAPS {
                acc += self.stream[s] * QMF_WINDOW[s];
                s += DOUBLE;
            }
            *z = acc;
        }
        for (sb, o) in out.iter_mut().enumerate() {
            let f = &m.fwd[sb];
            let (mut re, mut im) = (0.0, 0.0);
            for j in 0..DOUBLE {
                re += f[j].re * grouping[j];
                im += f[j].im * grouping[j];
            }
            *o = C32::new(re, im);
        }
    }
}

pub struct Synthesis {
    stream: Vec<f32>,
}

impl Synthesis {
    pub fn new() -> Self {
        Self { stream: vec![0.0; TAPS * 2] }
    }

    /// One slot: 64 complex subbands in, 64 samples out.
    pub fn process(&mut self, m: &Modulation, input: &[C32; SUBBANDS], out: &mut [f32]) {
        let len = self.stream.len();
        self.stream.copy_within(0..len - DOUBLE, DOUBLE);
        for j in 0..DOUBLE {
            let mut v = 0.0;
            for sb in 0..SUBBANDS {
                let c = m.inv[sb][j];
                v += c.re * input[sb].re - c.im * input[sb].im;
            }
            self.stream[j] = v;
        }
        for (n, o) in out.iter_mut().take(SUBBANDS).enumerate() {
            let mut acc = 0.0;
            for j in 0..TAPS / DOUBLE {
                let time = SUBBANDS * 4 * j;
                let coef = DOUBLE * j;
                acc += self.stream[time + n] * QMF_WINDOW[coef + n]
                    + self.stream[time + SUBBANDS * 3 + n] * QMF_WINDOW[coef + SUBBANDS + n];
            }
            *o = acc;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Analysis then synthesis returns the input, delayed, at unity gain.
    #[test]
    fn reconstructs_its_input() {
        let m = Modulation::new();
        let (mut a, mut s) = (Analysis::new(), Synthesis::new());
        let n = 64 * 64;
        let input: Vec<f32> = (0..n).map(|i| ((i as f32 * 0.0137).sin() + (i as f32 * 0.31).cos()) * 0.5).collect();
        let mut output = vec![0f32; n];
        let mut bands = [C32::ZERO; SUBBANDS];
        for slot in 0..n / 64 {
            a.process(&m, &input[slot * 64..slot * 64 + 64], &mut bands);
            s.process(&m, &bands, &mut output[slot * 64..slot * 64 + 64]);
        }
        // find the delay by cross-correlation, then compare
        let (mut best, mut delay) = (0f32, 0usize);
        for d in 0..1024 {
            let c: f32 = (2048..3072).map(|i| output[i] * input[i - d]).sum();
            if c > best {
                best = c;
                delay = d;
            }
        }
        let err: f32 = (2048..n).map(|i| (output[i] - input[i - delay]).powi(2)).sum::<f32>()
            / (2048..n).map(|i| input[i - delay].powi(2)).sum::<f32>();
        assert!(err < 1e-4, "delay {delay}, relative error {err}");
        assert_eq!(delay, ROUND_TRIP_DELAY);
    }
}
