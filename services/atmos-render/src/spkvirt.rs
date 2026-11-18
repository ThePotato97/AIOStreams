//! DAP-VR's speaker virtualizer (the speaker-path trace, virtualizer.md; coefficients as
//! `spkvirt_model.py`): a per-band 2x2 crosstalk canceller in the 77-band hybrid-QMF domain for
//! one stereo pair, pre-compensating it for two real speakers at +/- the physical angle so it's
//! heard at the target angle. A correlated (centre) part bypasses the canceller.
//! R spkvirt_head_model 0x18000EB00, spkvirt_xtc_band 0x18000ECB0, spkvirt_area_normalize
//! 0x18000F110, spkvirt_upper_band 0x18000F740, spkvirt_apply 0x18001F620 (A identical tables and
//! processing; for multichannel input A's general solve reduces exactly to these).

use crate::complex::C32;
use crate::spkvirt_tables::{AREA_W, BAND_F, BAND_HZ, F_UPPER, GROUP_ALPHA, GROUP_END, HALF_SPACING};
use crate::tuning::BANDS;

const FS: u32 = 48000;

#[derive(Debug, Clone, Copy, PartialEq)]
struct C64 {
    re: f64,
    im: f64,
}

impl C64 {
    fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }
    fn cis(phase: f64) -> Self {
        Self::new(libm::cos(phase), libm::sin(phase))
    }
    fn conj(self) -> Self {
        Self::new(self.re, -self.im)
    }
    fn norm2(self) -> f64 {
        self.re * self.re + self.im * self.im
    }
    fn scale(self, k: f64) -> Self {
        Self::new(self.re * k, self.im * k)
    }
}
impl std::ops::Add for C64 {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self::new(self.re + o.re, self.im + o.im)
    }
}
impl std::ops::Sub for C64 {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        Self::new(self.re - o.re, self.im - o.im)
    }
}
impl std::ops::Mul for C64 {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        Self::new(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    }
}

/// The head model for a source at `angle` degrees: [ITD in samples, b0 and b1 of the ipsilateral
/// head shadow, b0 and b1 of the contralateral one] (numerators only, normalised).
fn head_model(angle: i32, fs: u32) -> [f64; 5] {
    let mut a = angle;
    if a < -90 {
        a = -180 - a;
    } else if a > 90 {
        a = 180 - a;
    }
    let a = a.abs() as f64;
    let v4 = (fs >> 1) as f64;
    // theta / 4
    let th = a * 0.004363323;
    let s = libm::sin(th * 4.0);
    // Woodworth, a = 9 cm: (0.09/343)(theta + sin theta) fs
    let tau = (0.25 * s + th) * (v4 * 0.0020991254);
    // (343/0.09)/(4 fs): the bilinear head shadow's corner
    let v11 = (1.0 / v4) * 476.3889;
    let v12 = 0.25 * s + 0.25;
    let v13 = 0.25 - 0.25 * s;
    let (v14, v15, v16, v17) = (v11 + v12, v11 + v13, v11 - v13, v11 - v12);
    let n = 0.5 / (v16.abs() + v15.abs()).max(v17.abs() + v14.abs());
    [tau, n * v14, n * v17, n * v15, n * v16]
}

/// The ipsilateral path, and the contralateral one (shadowed and delayed by the ITD as a phase),
/// at normalised frequency f.
fn paths(m: &[f64; 5], f: f64) -> (C64, C64) {
    let w = if f > 0.5 { f - 1.0 } else { f };
    let z1 = C64::cis(-2.0 * std::f64::consts::PI * w);
    let ph = m[0] * f;
    let mut fr = ph - ph.floor();
    if fr > 0.5 {
        fr -= 1.0;
    }
    let d = C64::cis(-2.0 * std::f64::consts::PI * fr);
    let i = C64::new(m[1], 0.0) + z1.scale(m[2]);
    let c = (C64::new(m[3], 0.0) + z1.scale(m[4])) * d;
    (i, c)
}

/// The per-band solve: the plant inverse times the target with 1/det replaced by conj(det), the
/// pair normalised to unit power (the inverse's phase kept, its magnitude dropped).
fn xtc_band(target: &[f64; 5], speaker: &[f64; 5], f: f64) -> (C64, C64) {
    let (iv, cv) = paths(target, f);
    let (i, c) = paths(speaker, f);
    let det = i * i - c * c;
    let fi = (iv * i - cv * c) * det.conj();
    let fc = (i * cv - iv * c) * det.conj();
    let n = 1.0 / (fi.norm2() + fc.norm2()).sqrt();
    (fi.scale(n), fc.scale(n))
}

/// The engine's log2 (a cubic on frexp's mantissa, plus the exponent).
fn log2_poly(x: f64) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return f64::NEG_INFINITY;
    }
    let mut e = libm::log2(x.abs()).floor() as i32 + 1;
    let mut m = x / 2f64.powi(e);
    // frexp's mantissa is in [0.5, 1)
    if m >= 1.0 {
        m /= 2.0;
        e += 1;
    } else if m < 0.5 {
        m *= 2.0;
        e -= 1;
    }
    1.2734375 * m * m * m - 4.23828125 * m * m + 6.12890625 * m - 3.1640625 + e as f64
}

/// The engine's 2^x (`pow2_approx` 0x18000E6B0).
fn pow2_poly(x: f64) -> f64 {
    let fl = x.floor();
    let fr = x - fl;
    (1.0 + 0.686279296875 * fr + 0.25482177734375 * fr * fr + 0.05889892578125 * fr * fr * fr) * 2f64.powi(fl as i32)
}

/// The listening-area gain for a band below 2 kHz: the mean power over 61 points on a line in
/// front of the speakers, raised to the band's exponent.
fn area_gain(fi: C64, fc: C64, speaker_deg: i32, k_hz: f64, w: f64) -> f64 {
    let h = HALF_SPACING[speaker_deg.unsigned_abs() as usize];
    let mut p = 0.0;
    let mut x = -0.2286;
    for _ in 0..61 {
        let kl = ((h + x) * (h + x) + 0.47032163).sqrt() * 0.011661808 * 6.2831855;
        let kr = ((x - h) * (x - h) + 0.47032163).sqrt() * 0.011661808 * 6.2831855;
        let v = fi * C64::cis(-k_hz * kl) + fc * C64::cis(-k_hz * kr);
        p += v.norm2();
        x += 0.00762;
    }
    pow2_poly(log2_poly(p * 0.016129032) * w)
}

/// The first band past the virtualizer (upper band count) and the parameter groups it uses, for
/// a physical angle.
fn upper_band(speaker_deg: i32) -> (usize, usize) {
    let v8 = speaker_deg.unsigned_abs() as usize;
    if v8 == 0 || v8 - 1 > 29 {
        return (BANDS, 20);
    }
    let up = F_UPPER[v8];
    let hz = &BAND_HZ;
    let (mut v9, mut v11) = (0usize, 76usize);
    if up >= hz[0] {
        if up <= hz[76] {
            let mut it = 0;
            while v11 - v9 > 1 {
                let mid = (v11 + v9) >> 1;
                if up >= hz[mid] {
                    if up <= hz[mid] {
                        v11 = mid;
                        break;
                    }
                    v9 = mid;
                } else {
                    v11 = mid;
                }
                it += 1;
                if it >= 77 {
                    break;
                }
            }
            v9 = v11;
            if v11 >= 1 && v11 - 1 <= 75 && up - hz[v11 - 1] > hz[v11] - up {
                v9 = v11 + 1;
            }
        } else {
            v9 = BANDS;
        }
    }
    let last = v9 as i64 - 1;
    let groups = GROUP_END.iter().position(|&g| g as i64 > last).map_or(21, |i| i + 1).min(20);
    (v9, groups)
}

/// One pair's coefficients and centre-extraction state.
pub struct Pair {
    fi: [C32; BANDS],
    fc: [C32; BANDS],
    upper: usize,
    groups: usize,
    em: [f32; 20],
    es: [f32; 20],
}

impl Pair {
    /// A pair heard at `target` degrees over two speakers at +/- `speaker` degrees; bass
    /// extraction off, so processing starts at band 0.
    pub fn new(target: i32, speaker: i32) -> Self {
        let (mt, ms) = (head_model(-target, FS), head_model(-speaker, FS));
        let mut fi = [C32::ZERO; BANDS];
        let mut fc = [C32::ZERO; BANDS];
        for b in 0..BANDS {
            let (mut i, mut c) = xtc_band(&mt, &ms, BAND_F[b]);
            let k = (FS as f64 * BAND_F[b]).floor();
            if (0.0..=2000.0).contains(&k) {
                let g = area_gain(i, c, speaker, k, AREA_W[b] as f64);
                i = i.scale(g);
                c = c.scale(g);
            }
            fi[b] = C32::new(i.re as f32, i.im as f32);
            fc[b] = C32::new(c.re as f32, c.im as f32);
        }
        let (upper, groups) = upper_band(speaker);
        Self { fi, fc, upper, groups, em: [0.0; 20], es: [0.0; 20] }
    }

    /// One slot of the pair, in place.
    pub fn process(&mut self, l: &mut [C32; BANDS], r: &mut [C32; BANDS]) {
        let mut g = [0f32; 20];
        let mut from = 0;
        for k in 0..self.groups {
            let to = GROUP_END[k];
            let (mut pm, mut ps) = (0f32, 0f32);
            for b in from..to {
                pm += ((l[b] + r[b]).scale(0.5)).norm2();
                ps += ((l[b] - r[b]).scale(0.5)).norm2();
            }
            let a = GROUP_ALPHA[k];
            let flush = |v: f32| if v.is_subnormal() { 0.0 } else { v };
            self.em[k] = flush(a * self.em[k] + (1.0 - a) * pm);
            self.es[k] = flush(a * self.es[k] + (1.0 - a) * ps);
            g[k] = if self.em[k] == 0.0 {
                if self.es[k] != 0.0 { 0.98 } else { 0.02 }
            } else {
                (1.0 - (self.es[k] / self.em[k]).sqrt()).clamp(0.02, 0.98)
            };
            from = to;
        }
        let mut group = 0;
        for b in 0..self.upper {
            while b >= GROUP_END[group] {
                group += 1;
            }
            let m = (l[b] + r[b]).scale(0.5);
            let d = m.scale(g[group]);
            let (xl, xr) = (l[b] - d, r[b] - d);
            l[b] = d + self.fi[b] * xl + self.fc[b] * xr;
            r[b] = d + self.fc[b] * xl + self.fi[b] * xr;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COEFFS: &str = include_str!("../tests/fixtures/speaker/R_virt_coeffs_default_48k.csv");
    const UPPER: &str = include_str!("../tests/fixtures/speaker/R_virt_upper_band.csv");

    #[test]
    fn the_head_model_has_the_traced_values() {
        let m = head_model(5, FS);
        assert!((m[0] - 2.197).abs() < 1e-3);
        for (got, want) in m[1..].iter().zip([0.26826, -0.23174, 0.22817, -0.19166]) {
            assert!((got - want).abs() < 1e-5, "{got} {want}");
        }
        assert!((head_model(30, FS)[0] - 12.89).abs() < 1e-2);
        let m90 = head_model(90, FS);
        assert!((m90[0] - 32.38).abs() < 1e-2);
        assert!((m90[3] - 0.00992).abs() < 1e-5 && (m90[4] - 0.00992).abs() < 1e-5);
    }

    #[test]
    fn the_coefficients_match_the_traced_model_at_5_degrees() {
        // pair, band, hz, processed, Fi_re, Fi_im, Fc_re, Fc_im, .., area_norm_gain
        let pairs = [("front", Pair::new(30, 5)), ("surround_height", Pair::new(90, 5))];
        let mut rows = 0;
        for line in COEFFS.lines().skip(1) {
            let f: Vec<&str> = line.split(',').collect();
            let pair = &pairs.iter().find(|p| p.0 == f[0]).unwrap().1;
            let b: usize = f[1].parse().unwrap();
            let v = |i: usize| f[i].parse::<f32>().unwrap();
            for (got, want) in [(pair.fi[b].re, v(4)), (pair.fi[b].im, v(5)), (pair.fc[b].re, v(6)), (pair.fc[b].im, v(7))] {
                assert!((got - want).abs() <= 2e-5 * want.abs().max(1.0), "{} band {b}: {got} vs {want}", f[0]);
            }
            assert_eq!(f[3] == "1", b < pair.upper, "{} band {b} processed", f[0]);
            rows += 1;
        }
        assert_eq!(rows, 2 * BANDS);
    }

    #[test]
    fn the_upper_band_and_groups_match_the_traced_table() {
        for line in UPPER.lines().skip(1) {
            let f: Vec<i64> = line.split(',').map(|v| v.parse().unwrap()).collect();
            let (upper, groups) = upper_band(f[0] as i32);
            assert_eq!((upper as i64, groups as i64), (f[2], f[3]), "angle {}", f[0]);
        }
        // the built-in-speaker profile's 10 degrees: bands 0-26, 14 groups
        assert_eq!(upper_band(10), (27, 14));
    }

    #[test]
    fn centre_content_bypasses_the_canceller_and_one_sided_content_does_not() {
        let mut p = Pair::new(30, 10);
        let x = std::array::from_fn(|b| C32::new(0.1 + b as f32 * 1e-3, 0.05));
        // identical left and right: d = 0.98 M once the energies settle
        let (mut l, mut r) = (x, x);
        for _ in 0..2000 {
            (l, r) = (x, x);
            p.process(&mut l, &mut r);
        }
        let b = 5;
        let want = x[b].scale(0.98) + (p.fi[b] + p.fc[b]) * x[b].scale(0.02);
        assert!((l[b].re - want.re).abs() < 1e-5 && (l[b].im - want.im).abs() < 1e-5);
        // bands past the upper limit pass through
        assert_eq!(l[40], x[40]);
        // left only: no centre to extract (g = 0.02 at the floor)
        let mut q = Pair::new(30, 10);
        let zero = [C32::ZERO; BANDS];
        let (mut l, mut r) = (x, zero);
        for _ in 0..2000 {
            (l, r) = (x, zero);
            q.process(&mut l, &mut r);
        }
        let d = x[b].scale(0.5 * 0.02);
        let want_l = d + q.fi[b] * (x[b] - d) + q.fc[b] * (C32::ZERO - d);
        assert!((l[b].re - want_l.re).abs() < 1e-5 && (l[b].im - want_l.im).abs() < 1e-5);
        assert!(r[b].norm2() > 0.0);
    }
}
