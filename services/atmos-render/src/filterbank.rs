//! DAP-VR's filterbank in the low-delay configuration that `dap_vr_prepare` installs (traced in
//! both engines): 64-band complex QMF analysis/synthesis with the low-delay window, and the N = 11
//! hybrid split of QMF bands 0-2 into 16 sub-bands (77 bands in all). A translation of the
//! code-translated emulator (`hybrid_re/emulate_hybrid.py`, `qmf_synthesis_ld.py`), checked
//! against its output in the tests.

use crate::complex::C32;
use crate::tuning::BANDS;

const TABLES: &str = include_str!("../data/dapvr-filterbank.json");
pub const QMF_BANDS: usize = 64;
const HYB_TAPS: usize = 11;
/// Slots QMF bands 3-63 are delayed by, to line up with the split bands.
pub const HYB_DELAY: usize = 3;
/// Samples from analysis input to synthesis output, through the hybrid stage.
pub const LATENCY: usize = 256 + HYB_DELAY * 64;

pub struct Tables {
    /// c[j][p]: 10 window phases x 64.
    c: [[f32; 64]; 10],
    tw: [C32; 64],
    /// Synthesis view of the same window and twiddles: 160 and 32 four-lane vectors.
    wv: Vec<[f32; 4]>,
    tv: Vec<[f32; 4]>,
    a: [C32; HYB_TAPS],
    b: [C32; HYB_TAPS],
    perm: [usize; 16],
    fft64: Fft,
}

fn floats(v: &serde_json::Value) -> Vec<f32> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect()
}

impl Tables {
    pub fn load() -> Self {
        let t: serde_json::Value = serde_json::from_str(TABLES).expect("filterbank tables");
        let w = floats(&t["win_ld"]);
        let tw = floats(&t["tw_ld"]);
        let cplx = |v: Vec<f32>| -> [C32; HYB_TAPS] { std::array::from_fn(|i| C32::new(v[2 * i], v[2 * i + 1])) };
        let perm: Vec<usize> = t["perm"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as usize).collect();
        Self {
            c: std::array::from_fn(|j| std::array::from_fn(|p| w[(10 * (p / 4) + j) * 4 + p % 4])),
            tw: std::array::from_fn(|p| C32::new(tw[(2 * (p / 4)) * 4 + p % 4], tw[(2 * (p / 4) + 1) * 4 + p % 4])),
            wv: w.chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect(),
            tv: tw.chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect(),
            a: cplx(floats(&t["A11"])),
            b: cplx(floats(&t["B11"])),
            perm: std::array::from_fn(|i| perm[i]),
            fft64: Fft::new(64),
        }
    }
}

/// Forward DFT, X[k] = sum x[n] e^(-j 2 pi k n / N), radix-2.
struct Fft {
    n: usize,
    tw: Vec<C32>,
    rev: Vec<usize>,
}

impl Fft {
    fn new(n: usize) -> Self {
        let bits = n.trailing_zeros();
        let rev = (0..n).map(|i| (i.reverse_bits() >> (usize::BITS - bits)) as usize).collect();
        let tw = (0..n / 2)
            .map(|k| {
                let a = -2.0 * std::f64::consts::PI * k as f64 / n as f64;
                C32::new(libm::cos(a) as f32, libm::sin(a) as f32)
            })
            .collect();
        Self { n, tw, rev }
    }
    fn forward(&self, x: &mut [C32]) {
        let n = self.n;
        for i in 0..n {
            let j = self.rev[i];
            if j > i {
                x.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let step = n / len;
            for start in (0..n).step_by(len) {
                for k in 0..len / 2 {
                    let w = self.tw[k * step];
                    let u = x[start + k];
                    let v = x[start + k + len / 2] * w;
                    x[start + k] = u + v;
                    x[start + k + len / 2] = u - v;
                }
            }
            len *= 2;
        }
    }
}

fn dft_small(x: &[C32]) -> Vec<C32> {
    let n = x.len();
    (0..n)
        .map(|k| {
            let mut acc = C32::ZERO;
            for (i, v) in x.iter().enumerate() {
                acc += *v * C32::cis(-2.0 * std::f32::consts::PI * (k * i) as f32 / n as f32);
            }
            acc
        })
        .collect()
}

/// QMF analysis (low-delay) followed by the hybrid split: 64 real samples -> 77 complex bands.
pub struct Analysis {
    ring: [[f32; 64]; 9],
    idx: usize,
    taps: [[C32; 3]; HYB_TAPS],
    delay: [[C32; 64]; HYB_DELAY],
    dpos: usize,
}

impl Analysis {
    pub fn new() -> Self {
        Self { ring: [[0.0; 64]; 9], idx: 0, taps: [[C32::ZERO; 3]; HYB_TAPS], delay: [[C32::ZERO; 64]; HYB_DELAY], dpos: 0 }
    }

    pub fn qmf(&mut self, t: &Tables, x: &[f32]) -> [C32; 64] {
        let new: [f32; 64] = std::array::from_fn(|p| 0.5 * x[p]);
        let b = |j: usize| -> &[f32; 64] { if j == 9 { &new } else { &self.ring[(self.idx + j) % 9] } };
        let mut z = [C32::ZERO; 64];
        for p in 0..64 {
            let c = &t.c;
            let ev = c[0][p] * b(0)[p] - c[2][p] * b(2)[p] + c[4][p] * b(4)[p] - c[6][p] * b(6)[p] + c[8][p] * b(8)[p];
            let od = c[1][p] * b(1)[p] - c[3][p] * b(3)[p] + c[5][p] * b(5)[p] - c[7][p] * b(7)[p] + c[9][p] * b(9)[p];
            z[p] = C32::new(od, ev) * t.tw[p];
        }
        let slot = self.idx % 9;
        self.ring[slot] = new;
        self.idx += 1;
        t.fft64.forward(&mut z);
        let mut out = [C32::ZERO; 64];
        for v in 0..32 {
            out[2 * v] = z[v].scale(1.0 / 64.0);
            out[2 * v + 1] = z[63 - v].scale(1.0 / 64.0).conj();
        }
        out
    }

    pub fn process(&mut self, t: &Tables, x: &[f32]) -> [C32; BANDS] {
        let q = self.qmf(t, x);
        self.taps.copy_within(1.., 0);
        self.taps[HYB_TAPS - 1] = [q[0], q[1], q[2]];
        let mut u = [C32::ZERO; 16];
        for tap in 0..HYB_TAPS {
            let r = tap as i32 - HYB_TAPS as i32 + 1 + HYB_DELAY as i32;
            u[(r & 7) as usize] += self.taps[tap][0] * t.a[tap];
            u[8 + (r & 3) as usize] += self.taps[tap][1] * t.b[tap];
            u[12 + (r & 3) as usize] += self.taps[tap][2] * t.b[tap];
        }
        let mut tmp = dft_small(&u[0..8]);
        tmp.extend(dft_small(&u[8..12]));
        tmp.extend(dft_small(&u[12..16]));
        let mut out = [C32::ZERO; BANDS];
        for n in 0..16 {
            let v = tmp[t.perm[n]];
            out[n] = if n == 1 || n == 3 { v.conj() } else { v };
        }
        let delayed = self.delay[self.dpos];
        out[16..BANDS].copy_from_slice(&delayed[3..64]);
        self.delay[self.dpos] = q;
        self.dpos = (self.dpos + 1) % HYB_DELAY;
        out
    }
}

/// Hybrid synthesis back to QMF bands 0-2, then QMF synthesis (low-delay): 77 bands -> 64 samples.
pub struct Synthesis {
    state: Vec<[f32; 4]>,
}

fn rev4(v: [f32; 4]) -> [f32; 4] {
    [v[3], v[2], v[1], v[0]]
}
fn mul(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    std::array::from_fn(|i| a[i] * b[i])
}
fn add(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    std::array::from_fn(|i| a[i] + b[i])
}
fn sub(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    std::array::from_fn(|i| a[i] - b[i])
}

impl Synthesis {
    pub fn new() -> Self {
        Self { state: vec![[0.0; 4]; 144] }
    }

    pub fn hybrid(h: &[C32; BANDS]) -> [C32; 64] {
        let mut q = [C32::ZERO; 64];
        q[0] = h[0] + h[2] + h[4] + h[6] + h[7] + h[9] + h[3].conj() + h[1].conj();
        q[1] = h[12] + h[5] + h[8] + h[10];
        q[2] = h[13] + h[14] + h[15] + h[11];
        q[3..64].copy_from_slice(&h[16..BANDS]);
        q
    }

    pub fn qmf(&mut self, t: &Tables, x: &[C32; 64], out: &mut [f32]) {
        // pre-shuffle (sub_180009E80): conj(X[2k]) then X[63 - 2k]
        let mut z = [C32::ZERO; 64];
        for k in 0..32 {
            z[k] = x[2 * k].conj();
            z[32 + k] = x[63 - 2 * k];
        }
        t.fft64.forward(&mut z); // unscaled
        let (wv, tv, s) = (&t.wv, &t.tv, &mut self.state);
        for i in 0..16 {
            let v8 = 10 * (15 - i);
            let (rw, iw) = (tv[2 * i], tv[2 * i + 1]);
            let fre: [f32; 4] = std::array::from_fn(|l| z[4 * i + l].re);
            let fim: [f32; 4] = std::array::from_fn(|l| z[4 * i + l].im);
            let v17 = sub(mul(rw, fre), mul(iw, fim));
            let v18 = add(mul(rw, fim), mul(iw, fre));
            let (v19, v20) = (rev4(v17), rev4(v18));
            let r = 9 * i + 2;
            let v21 = add(mul(wv[v8 + 9], v19), s[r - 2]);
            let v22 = rev4(v21);
            s[r - 2] = add(mul(wv[v8 + 8], v20), s[r - 1]);
            for l in 0..4 {
                out[4 * i + l] = v22[l] + v22[l];
            }
            let v23 = sub(s[r + 1], mul(wv[v8 + 6], v20));
            s[r - 1] = sub(s[r], mul(wv[v8 + 7], v19));
            s[r] = v23;
            let v24 = add(mul(wv[v8 + 4], v20), s[r + 3]);
            s[r + 1] = add(mul(wv[v8 + 5], v19), s[r + 2]);
            s[r + 2] = v24;
            let v25 = sub(s[r + 5], mul(wv[v8 + 2], v20));
            s[r + 3] = sub(s[r + 4], mul(wv[v8 + 3], v19));
            s[r + 4] = v25;
            s[r + 5] = add(mul(wv[v8 + 1], v19), s[r + 6]);
            s[r + 6] = mul(wv[v8], v20);
        }
    }

    pub fn process(&mut self, t: &Tables, h: &[C32; BANDS], out: &mut [f32]) {
        let q = Self::hybrid(h);
        self.qmf(t, &q, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/fixtures/filterbank-golden.json")).unwrap()
    }

    #[test]
    fn matches_the_traced_emulator() {
        let g = golden();
        let t = Tables::load();
        let x = floats(&g["input"]);
        let (mut a, mut s) = (Analysis::new(), Synthesis::new());
        let mut out = [0f32; 64];
        let (mut herr, mut href, mut oerr, mut oref) = (0f64, 0f64, 0f64, 0f64);
        for m in 0..25 {
            let h = a.process(&t, &x[m * 64..m * 64 + 64]);
            s.process(&t, &h, &mut out);
            if let Some(exp) = g["hybrid"].get(m.to_string()) {
                for (b, e) in exp.as_array().unwrap().iter().enumerate() {
                    let (re, im) = (e[0].as_f64().unwrap(), e[1].as_f64().unwrap());
                    herr += (h[b].re as f64 - re).powi(2) + (h[b].im as f64 - im).powi(2);
                    href += re * re + im * im;
                }
                for (i, e) in g["output"][m.to_string()].as_array().unwrap().iter().enumerate() {
                    let e = e.as_f64().unwrap();
                    oerr += (out[i] as f64 - e).powi(2);
                    oref += e * e;
                }
            }
        }
        let (hd, od) = (10.0 * (herr / href).log10(), 10.0 * (oerr / oref).log10());
        assert!(hd < -100.0 && od < -100.0, "hybrid {hd:.1} dB, output {od:.1} dB vs the emulator");
    }

    #[test]
    fn reconstructs_with_the_traced_latency() {
        let t = Tables::load();
        let (mut a, mut s) = (Analysis::new(), Synthesis::new());
        let n = 200 * 64;
        let x: Vec<f32> = (0..n).map(|i| ((i * 7919 % 1013) as f32 / 1013.0 - 0.5)).collect();
        let mut y = vec![0f32; n];
        for m in 0..200 {
            let h = a.process(&t, &x[m * 64..m * 64 + 64]);
            s.process(&t, &h, &mut y[m * 64..m * 64 + 64]);
        }
        let d = LATENCY;
        let (mut e, mut r) = (0f64, 0f64);
        for i in 64 * 20..n {
            e += ((y[i] - x[i - d]) as f64).powi(2);
            r += (x[i - d] as f64).powi(2);
        }
        let db = 10.0 * (e / r).log10();
        assert!(db < -65.0, "{db:.1} dB at {d} samples");
    }
}
