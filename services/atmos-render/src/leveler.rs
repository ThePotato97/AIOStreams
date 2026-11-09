//! Dolby Volume, DAP's volume leveler, as the headphone Movie profile runs it on Windows (amount 4,
//! in/out targets -20 dB, MI off), and volmax, the +4 dB it brings. A line-for-line translation of
//! the trace's per-block port (`leveler.py::DVLeveler`, from R `dv_leveler_main` 0x18001A610 and
//! its callees; leveler.md sections 1-7 and 12) for engine A (`DolbyAudioProcessing.dll`): A's boost
//! cap (0.030068714) and no silence-hold reset. The tables are R's (`R_dv_tables.json`), which are
//! byte-identical in A. Like the port, it runs in f64 where the DLL uses f32.
//!
//! Per 256-sample block: the band powers of every rendered channel (`band_powers`) go in, one
//! gain per DAP band comes out, applied to every hybrid bin of the band for the whole block.

use crate::complex::C32;
use crate::tuning::BANDS;

const TABLES: &str = include_str!("../data/dv-leveler-tables.json");

pub const NB: usize = 20;
/// The DAP band edges in hybrid bins (qmfcfg+0x50 at 48 kHz): band b is bins EDGES[b-1]..EDGES[b].
pub const EDGES: [usize; NB] = [2, 4, 5, 7, 10, 12, 14, 15, 17, 18, 20, 22, 24, 27, 30, 34, 40, 46, 54, 77];
/// Groups: 0 = both ears, 1 = the silent dummy group of the headphone layout, 2 = combined.
const NG: usize = 2;
const G: usize = NG + 1;

const ONE: f64 = 0.9999999;
const LOGADD_MAX: f64 = 0.15384616;
const FLOOR: [f64; NB] = [-0.25, -0.3, -0.35, -0.35, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4, -0.4];
/// A's boost cap, N' units (A sub_180055280; R's is 0.042955305).
const MAX_BOOST: f64 = 0.030068714;
/// The 68-block time constant shared by 26350 / 236C0 / 24680.
const K985: f64 = 0.9853216;
const LEV_TC: f64 = -0.005333333;
/// Blocks (5.01 s).
const LOW_HOLD: u32 = 940;

/// Volmax, Movie's +4 dB (64 in the blob), a flat gain before the peak limiter while the leveler is
/// on (leveler.md section 7).
pub const VOLMAX_DB: f32 = 4.0;
/// Movie on headphones: amount 4, in and out targets -20 dB (-320 in the blob).
pub const MOVIE_AMOUNT: usize = 4;
const TARGET_DB: f64 = -20.0;

type Row = [f64; 6];

struct Tables {
    lut: Vec<Vec<f64>>,
    lut_slope: Vec<Vec<f64>>,
    lut_size: Vec<usize>,
    lut_off: Vec<f64>,
    lut_thr: Vec<f64>,
    f7950: [f64; NB],
    t0: [f64; NB],
    reference: f64,
    d4dd0: [f64; 8],
    exc_fast: Row,
    exc_slow: Row,
    band_smooth: [Row; NB],
    spread_k: Vec<f64>,
    spread_n: [f64; NB],
    lev_tab: [f64; 6],
    gmin: [f64; 4],
    cf6c0: Vec<Vec<f64>>,
    cfb70: Vec<Vec<f64>>,
    det_const: f64,
}

/// `NaN` (Python's JSON) marks the slope table's unused tail entries, past the last index the
/// inverse search reads; it's loaded as NaN.
fn floats(v: &serde_json::Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect()
}
fn arr<const N: usize>(v: &serde_json::Value) -> [f64; N] {
    let f = floats(v);
    std::array::from_fn(|i| f[i])
}
fn rows(v: &serde_json::Value) -> Vec<Vec<f64>> {
    v.as_array().unwrap().iter().map(floats).collect()
}

impl Tables {
    fn load() -> Self {
        let t: serde_json::Value = serde_json::from_str(&TABLES.replace("NaN", "null")).expect("leveler tables");
        let bs = rows(&t["cfg6_bandsmooth"]);
        let lev = floats(&t["cfg8_leveler"]["f"]);
        Self {
            lut: rows(&t["lut"]),
            lut_slope: rows(&t["lut_slope"]),
            lut_size: t["lut_sizes"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as usize).collect(),
            lut_off: floats(&t["lut_off"]),
            lut_thr: floats(&t["lut_thr"]),
            f7950: arr(&t["F7950"]),
            t0: arr(&t["T0"]),
            reference: t["consts"]["ref_0p80198"].as_f64().unwrap(),
            d4dd0: arr(&t["D4DD0"]),
            exc_fast: arr(&t["exc_fast"]),
            exc_slow: arr(&t["exc_slow"]),
            band_smooth: std::array::from_fn(|b| std::array::from_fn(|i| bs[b][i])),
            spread_k: floats(&t["spread"]["kernel"]),
            spread_n: arr(&t["spread"]["norm"]),
            lev_tab: std::array::from_fn(|i| lev[i]),
            gmin: arr(&t["D5DB0"]),
            cf6c0: rows(&t["lev_tab_CF6C0"]),
            cfb70: rows(&t["lev_tab_CFB70"]),
            det_const: t["qmfcfg48"]["det_const_0x60"].as_f64().unwrap(),
        }
    }
}

fn clamp1(v: f64) -> f64 {
    v.clamp(-ONE, ONE)
}

/// Power sum of two log130 levels (R inline polynomial, e.g. sub_180026350).
fn logadd130(a: f64, b: f64) -> f64 {
    let mut m = a.max(b);
    let d = (a - b).abs();
    if d < LOGADD_MAX {
        m = (((((0.23647338 - d * 0.63515127) * d - 0.030754402) * d) + 0.0014472456) * 16.0 + m).clamp(-1.0, 1.0);
    }
    m
}

fn logadd_vec(a: &[f64; NB], b: &[f64; NB]) -> [f64; NB] {
    std::array::from_fn(|i| logadd130(a[i], b[i]))
}

/// pow2_approx R 0x18000E6B0 (A sub_180010EB0): 2^x, cubic on the fractional part.
fn pow2a(x: f64) -> f64 {
    let f = x.floor();
    let r = x - f;
    (1.0 + r * 0.6862793 + r * r * 0.25482178 + r * r * r * 0.058898926) * 2f64.powi(f as i32)
}

/// sub_180034280: the leveler's static curve, `t` an 18-field table row.
fn curve(x: f64, t: &[f64]) -> f64 {
    let v = x.min(t[0]);
    if v > t[1] {
        return v * t[7] + t[6];
    }
    if v > t[2] {
        return (v - t[2]) * ((v - t[2]) * t[10] + t[9]);
    }
    if v > t[3] {
        return 0.0;
    }
    let v = t[5].max(v);
    if v > t[4] {
        return (v - t[3]) * ((v - t[3]) * t[13] + t[12]);
    }
    v * t[16] + t[15]
}

/// sub_18001A610 + sub_180034320: the CF6C0 row's upper segment blended with the CFB70 row by
/// presence c.
fn blend_table(t3: &[f64], t4: &[f64], c: f64) -> Vec<f64> {
    let mut t = t4.to_vec();
    let a1 = (1.0 - c) * t3[2] + c * t4[2];
    let a2 = (1.0 - c) * (t3[7] + 1.0) + c * (t4[7] + 1.0);
    let a3 = t4[1] - t4[2];
    t[2] = a1;
    t[1] = a1 + a3;
    t[7] = a2 - 1.0;
    t[6] = -((a3 * 0.5 + a1) * (a2 - 1.0));
    t[9] = 0.0;
    // [I] in the port: the block-float form of the same quadratic knee
    t[10] = if a3.abs() >= 1e-8 { (a2 - 1.0) / (2.0 * a3) } else { 0.0 };
    t
}

fn lohi(v: f64, lo: f64, hi: f64) -> f64 {
    if lo > v {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// R sub_1800384D0 (A sub_180053D90), non-reset path; row [o0, o1, att_cy, att_cx, rel_cy, rel_cx].
fn smooth384(y: &mut [f64; NB], x: &[f64; NB], fast: &[Row], slow: &[Row], thr: f64) {
    for b in 0..NB {
        let (xb, yb) = (x[b], y[b]);
        let att = xb > yb;
        let tab = if att && xb - yb > thr { fast } else { slow };
        let t = if tab.len() == 1 { &tab[0] } else { &tab[b] };
        let (cy, cx) = if att { (t[2], t[3]) } else { (t[4], t[5]) };
        let ty = if yb <= -1.0 { -1.0 } else { yb + t[0] };
        let tx = if xb <= -1.0 { -1.0 } else { xb + t[1] };
        y[b] = (cy * yb + cx * xb).max(tx.max(ty).max(-1.0));
    }
}

fn skewness(x: &[f64; NB]) -> f64 {
    let m: f64 = x.iter().map(|v| 0.05 * v).sum();
    let d: Vec<f64> = x.iter().map(|v| v - m).collect();
    let (dmax, dmin) = d.iter().fold((f64::MIN, f64::MAX), |(a, b), &v| (a.max(v), b.min(v)));
    if dmax == dmin {
        return 0.15;
    }
    let m2: f64 = d.iter().map(|v| 0.05 * v * v).sum();
    let m3: f64 = d.iter().map(|v| 0.05263158 * v * v * v).sum();
    let (num, den) = (m3 * 0.0555556, m2.sqrt() * m2);
    if den.abs() <= 5e-9 {
        return 0.0;
    }
    if num.abs() < den.abs() {
        return (num / den).clamp(-1.0, 1.0);
    }
    if (num < 0.0) == (den < 0.0) { 1.0 } else { -1.0 }
}

fn map23a10(a: f64) -> f64 {
    if a < 0.3770246 {
        return 0.0;
    }
    let v = a - 0.47593537;
    (0.22313015 + 0.90013355 * 4.0 * v + 0.9078114 * 32.0 * v * v + 0.6103698 * 256.0 * v * v * v).clamp(0.0, 1.0)
}

fn strength(z: f64) -> f64 {
    if z > 0.02 {
        return 1.0;
    }
    if z - 0.005 > 0.0 { (z - 0.005) * 0.5208333 * 128.0 } else { 0.0 }
}

fn wfun(v: f64) -> f64 {
    if v >= 0.042955298 {
        ONE
    } else if v <= 0.0 {
        0.0
    } else {
        (v * 23.280012) * (v * 23.280012)
    }
}

/// The loudness histogram (R sub_18003B3B0 / sub_18003B630 / reset sub_18003B310).
struct Rhythm {
    hist: [f64; 51],
    tw: f64,
    cnt: usize,
    idx: usize,
    acc: f64,
    flag: bool,
    lpk: f64,
    apk: f64,
    rbin: [usize; 80],
    rc: [f64; 80],
    rs: [f64; 80],
    rw: [f64; 80],
}

impl Rhythm {
    fn new() -> Self {
        Self { hist: [0.0; 51], tw: 0.0, cnt: 0, idx: 0, acc: 0.0, flag: true, lpk: 0.5676, apk: 0.0, rbin: [0; 80], rc: [0.0; 80], rs: [0.0; 80], rw: [0.0; 80] }
    }

    fn bin(l: f64) -> (usize, f64, f64) {
        let v = (l - 0.5688925) * 0.546875 * 256.0;
        let k = v.floor();
        if k < 0.0 {
            return (0, 1.0, 0.0);
        }
        if k > 49.0 {
            return (49, 0.0, 1.0);
        }
        // the traced constant (A and R), not exactly pi/8
        #[allow(clippy::approx_constant)]
        let ph = (v - k) * 0.3926991 * 4.0;
        (k as usize, ph.cos(), ph.sin())
    }

    fn update(&mut self, inc: f64, l: f64, aw: f64) {
        if self.flag {
            self.apk = aw;
            self.flag = false;
            self.lpk = l;
        } else if aw > self.apk {
            self.apk = aw;
            self.lpk = l;
        } else if aw == self.apk && l > self.lpk {
            self.lpk = l;
        }
        self.acc += inc;
        if self.acc >= 0.5 {
            self.flag = true;
            self.acc -= 0.5;
            let i = self.idx;
            let k0 = self.rbin[i];
            self.hist[k0] -= self.rc[i];
            self.hist[k0 + 1] -= self.rs[i];
            self.tw -= self.rw[i];
            let (k, co, si) = Self::bin(self.lpk);
            let w = self.apk * 0.00833;
            self.rbin[i] = k;
            self.rc[i] = co * w;
            self.rs[i] = si * w;
            self.rw[i] = w;
            self.hist[k] += co * w;
            self.hist[k + 1] += si * w;
            self.idx = (i + 1) % 80;
            self.cnt = (self.cnt + 1).min(80);
            self.tw += w;
        }
    }

    fn density(&self, l: f64) -> f64 {
        if self.tw == 0.0 {
            return 0.0;
        }
        let (k, co, si) = Self::bin(l);
        (si * self.hist[k + 1] + co * self.hist[k]) / self.tw
    }
}

/// What a block produced, for the tests.
#[derive(Debug, Clone, Copy)]
pub struct Trace {
    pub reset: bool,
    pub onset: bool,
    pub c: f64,
    pub e1: f64,
    pub e2: f64,
    pub l_g: f64,
    pub a_g: f64,
    pub b_g: f64,
    pub s656_g: f64,
    pub s320_g: f64,
    pub v21: f64,
}

pub struct Leveler {
    t: Tables,
    t3: Vec<f64>,
    t4raw: Vec<f64>,
    in_t: f64,
    out_t: f64,
    mi: f64,
    sys: f64,
    // 26350
    sil_prev: [f64; NB],
    sil_prev2: [f64; NB],
    sil_cnt: u32,
    sil_ctr: u32,
    c: f64,
    // 24370
    exc: [[f64; NB]; G],
    // 236C0
    e1: f64,
    e2: f64,
    evt_y: [f64; NB],
    evt_prev: [f64; NB],
    skew_s: f64,
    v31: f64,
    // 24680
    lt_s: f64,
    lt_cnt: u32,
    lt_v17: f64,
    a_tot: [f64; G],
    a_b: [[f64; NB]; G],
    b_tot: [f64; G],
    b_b: [[f64; NB]; G],
    rh: Rhythm,
    // the leveler's gain and loudness states
    s0: [[f64; NB]; G],
    s320: [f64; G],
    s336: [[f64; NB]; G],
    s656: [f64; G],
    st0: bool,
    st1: u32,
    // solver smoothing
    sol: [[f64; NB]; NG],
}

impl Leveler {
    /// The headphone Movie profile's leveler.
    pub fn movie() -> Self {
        Self::new(MOVIE_AMOUNT, TARGET_DB, TARGET_DB)
    }

    pub fn new(amount: usize, in_target_db: f64, out_target_db: f64) -> Self {
        let t = Tables::load();
        let reference = t.reference;
        let (t3, t4raw) = (t.cfb70[amount].clone(), t.cf6c0[amount].clone());
        Self {
            t,
            t3,
            t4raw,
            in_t: in_target_db / 130.0,
            out_t: out_target_db / 130.0,
            mi: 1.0,
            sys: 0f64.clamp(-ONE, 0.2307692),
            sil_prev: [-1.0; NB],
            sil_prev2: [-1.0; NB],
            sil_cnt: 47,
            sil_ctr: 1,
            c: 0.01,
            exc: [[-1.0; NB]; G],
            e1: 0.0,
            e2: 0.0,
            evt_y: [-1.0; NB],
            evt_prev: [0.0; NB],
            skew_s: 0.99999988,
            v31: 0.0,
            lt_s: 0.99999988,
            lt_cnt: 0,
            lt_v17: 0.0,
            a_tot: [reference; G],
            a_b: [[0.44002658; NB]; G],
            b_tot: [-ONE; G],
            b_b: [[-ONE; NB]; G],
            rh: Rhythm::new(),
            s0: [[0.0; NB]; G],
            s320: [0.0; G],
            s336: [[-ONE; NB]; G],
            s656: [-ONE; G],
            st0: true,
            st1: 0,
            sol: [[-1.0; NB]; NG],
        }
    }

    /// sub_180038800 / sub_180038FE0: excitation (log130) -> specific loudness (N' units).
    fn nprime(&self, b: usize, e: f64) -> f64 {
        let i = b.min(7);
        let v = 0.3125 * e - self.t.lut_thr[i];
        if v <= 0.0 {
            return -ONE;
        }
        let x = 64.0 * v;
        let k = (x.floor() as usize).min(self.t.lut_size[i] - 1);
        let lut = &self.t.lut[i];
        lut[k] + (x - x.floor()) * (lut[k + 1] - lut[k])
    }

    fn nprime_vec(&self, e: &[f64; NB]) -> [f64; NB] {
        std::array::from_fn(|b| self.nprime(b, e[b]))
    }

    /// sub_180038ED0: specific loudness -> excitation.
    fn nprime_inv(&self, b: usize, n: f64) -> f64 {
        if n <= -1.0 {
            return -1.0;
        }
        let i = b.min(7);
        let lut = &self.t.lut[i];
        let mut k = self.t.lut_size[i] - 1;
        loop {
            let last = k == 1;
            k -= 1;
            if last || lut[k] <= n {
                break;
            }
        }
        clamp1((n - lut[k]) * self.t.lut_slope[i][k] + (k as f64 * 0.05 + self.t.lut_off[i]))
    }

    /// sub_180038C40 + sub_180038A60: one group's total loudness.
    fn total_loudness(&self, e: &[f64; NB]) -> f64 {
        let w: [f64; NB] = std::array::from_fn(|b| e[b] + self.t.f7950[b]);
        let m = w.iter().cloned().fold(f64::MAX, f64::min).min(1.0);
        let d2: Vec<f64> = w.iter().map(|v| (v - m) * (v - m)).collect();
        let s2: f64 = d2.iter().sum();
        let c = if s2 == 0.0 { -1.0 } else { (w.iter().zip(&d2).map(|(a, b)| a * b).sum::<f64>() / s2 - 0.09999999).max(-1.0) };
        let mut acc: f64 = -1.0;
        for b in 0..NB {
            let mm = c.max(w[b]);
            let v = if mm > -1.0 { self.nprime(b, (mm - self.t.f7950[b]).min(1.0)) } else { self.nprime(b, e[b]) };
            let hi = acc.max(v);
            let d = (v - acc).abs();
            acc = if d < 0.2854 { ((((2.0396 - d * 2.9532) * d - 0.4921) * d + 0.043) + hi).clamp(-1.0, 1.0) } else { hi };
        }
        clamp1(acc + 0.042955305)
    }

    /// The detector (R bandlevel_analysis_groups 0x180020FC0): the group's band powers of the
    /// output-referred render (before the x2^-3), summed over channels, as log130 levels.
    fn detector_levels(&self, p: &[[f64; NB]]) -> [f64; NB] {
        let a6core = -0.18509077;
        let reference = (-0.2769231f64).max(0.0) + a6core + self.t.det_const;
        std::array::from_fn(|b| {
            let pw = p.iter().map(|c| c[b]).sum::<f64>() * 2f64.powi(-6);
            let l = if pw > 0.0 { 10.0 * pw.log10() / 130.0 } else { -1.3846154 };
            (l - reference).clamp(-1.0, 0.23076923)
        })
    }

    /// 26350: silence, onset and presence. Engine A: no silence-hold reset.
    fn silence(&mut self, eg: &[f64; NB], thr: f64) -> (bool, bool) {
        let mut tot: f64 = -1.0;
        let mut flux = 0.0;
        for b in 0..NB {
            tot = logadd130(eg[b], tot);
            flux += self.sil_prev2[b] - eg[b];
            self.sil_prev2[b] = self.sil_prev[b];
            self.sil_prev[b] = eg[b];
        }
        let mut onset = false;
        if tot < thr - 0.41538462 {
            if self.sil_cnt < 47 {
                self.sil_cnt = (self.sil_cnt + 1).min(47);
            }
        } else {
            onset = self.sil_cnt >= 47;
            self.sil_cnt = 0;
            self.c = self.c * K985 + (1.0 - K985);
        }
        if flux > 3.076923 || self.sil_ctr > 0 {
            self.sil_ctr += 1;
        }
        let reset = if self.sil_ctr > 1 {
            self.c = 0.01;
            self.sil_ctr = 0;
            true
        } else {
            false
        };
        (reset, onset)
    }

    /// 236C0: the event detector.
    fn event(&mut self, eg: &[f64; NB], rst: bool, c: f64) -> bool {
        let mx = eg.iter().cloned().fold(f64::MIN, f64::max).max(-1.0);
        let x: [f64; NB] = std::array::from_fn(|b| pow2a((eg[b] - mx) * 43.185547).min(1.0));
        let sk = skewness(&x);
        let k = c * 0.9440609;
        self.skew_s = ((sk - k * sk) + k * self.skew_s).clamp(0.044444446, 0.15);
        self.v31 = (self.skew_s - 0.044444446) * 0.59210527 * 16.0 * self.mi;
        if rst {
            self.evt_y = *eg;
        } else {
            let tab = [self.t.exc_slow];
            smooth384(&mut self.evt_y, eg, &tab, &tab, 0.0);
        }
        let n = self.nprime_vec(&self.evt_y);
        let sh = 0.5688925 - n.iter().cloned().fold(f64::MIN, f64::max).max(0.5688925);
        let m: [f64; NB] = std::array::from_fn(|b| map23a10(n[b] + sh));
        let flux = if rst { 0.0 } else { m.iter().zip(&self.evt_prev).map(|(a, b)| 0.05 * (a - b).abs()).sum() };
        self.evt_prev = m;
        let (v35, v28) = (strength(flux), strength(flux * self.v31));
        self.e1 = if v35 > self.e1 { v35 } else { self.e1 * K985 };
        let flag = v28 > self.e2;
        self.e2 = if flag { v28 } else { self.e2 * K985 };
        flag
    }

    /// 24FA0.
    fn lt_reset(&mut self) {
        self.lt_s = 0.99999988;
        self.lt_cnt = 0;
        self.lt_v17 = 0.0;
        self.b_tot = [-ONE; G];
        self.b_b = [[-ONE; NB]; G];
        self.rh = Rhythm::new();
    }

    /// 24680: the long-term loudness A and B.
    fn longterm(&mut self, lt: &[f64; G], n: &[[f64; NB]; G], e1: f64, e2: f64, c: f64) {
        let gi = NG;
        let rising = lt[gi] > self.a_tot[gi];
        let mut aw = e2;
        if rising {
            if self.lt_cnt >= 375 {
                self.lt_s *= 0.999538;
            } else {
                self.lt_cnt += 1;
            }
            aw = (ONE - self.lt_s) + self.lt_s * e1;
        } else {
            self.lt_s = 0.99999988;
            self.lt_cnt = 0;
        }
        if lt[gi] > 0.6686316 && aw > 0.1 {
            self.rh.update(0.053333335, lt[gi], aw);
        }
        let (v17, v18);
        if self.rh.cnt < 5 {
            v17 = ONE;
            v18 = ONE;
            self.lt_v17 = 0.0;
        } else {
            v17 = (ONE - K985) + K985 * self.lt_v17;
            self.lt_v17 = v17;
            v18 = ONE.min(self.rh.density(self.a_tot[gi]).min(0.075) * 0.8333333 * 16.0);
        }
        let (v19, v20, v21);
        if aw < 0.1 {
            v19 = ONE;
            v20 = ONE;
            v21 = ONE;
        } else {
            let v22 = (ONE - v17) * 0.1 + v17;
            let (v23, v24) = if rising { (2.321928, -0.003525142) } else { (4.321928, -0.000828651) };
            let v25 = v24 / (pow2a((v18 - 1.0) * v23) * v22);
            v21 = pow2a(v25) * aw + (ONE - aw);
            v19 = pow2a(-0.003525142 / v22) * aw + (ONE - aw);
            v20 = pow2a(-0.000828651 / v22) * aw + (ONE - aw);
        }
        let pick = |l: f64, a: f64| if rising { if l > a { v21 } else { v20 } } else if a >= l { v21 } else { v19 };
        let upd = |a: &mut f64, b: &mut f64, l: f64, coef: f64| {
            *a = coef * *a + (ONE - coef) * l;
            *b = (ONE - coef * c) * l + coef * c * *b;
        };
        let cg = if lt[gi] > 0.6686316 { v21 } else { ONE };
        upd(&mut self.a_tot[gi], &mut self.b_tot[gi], lt[gi], cg);
        for g in 0..gi {
            let coef = pick(lt[g], self.a_tot[g]);
            upd(&mut self.a_tot[g], &mut self.b_tot[g], lt[g], coef);
        }
        for g in 0..G {
            for b in 0..NB {
                let coef = pick(n[g][b], self.a_b[g][b]);
                upd(&mut self.a_b[g][b], &mut self.b_b[g][b], n[g][b], coef);
            }
        }
    }

    /// sub_18003B170: the static curves, low-level fade, 3A930 clamps, AD30 group minimum and
    /// AF00 offset/fade/cap.
    fn static_rows(&self, lt: &[f64; G], n: &[[f64; NB]; G], v21: f64, t4: &[f64]) -> [[f64; NB + 1]; G] {
        let gi = NG;
        let d = v21 - self.t.reference;
        let mut rows = [[0.0; NB + 1]; G];
        rows[gi][0] = curve(d + lt[gi], t4);
        for b in 0..NB {
            rows[gi][b + 1] = curve(clamp1(d + self.b_tot[gi] - self.b_b[gi][b] + n[gi][b]), t4);
        }
        for g in 0..gi {
            rows[g][0] = curve(clamp1(d + self.b_tot[gi] - self.b_tot[g] + lt[g]), t4);
            for b in 0..NB {
                rows[g][b + 1] = curve(clamp1(d + self.b_tot[gi] - self.b_b[g][b] + n[g][b]), t4);
            }
        }
        let lg = lt[gi];
        let fade = if lg >= 0.6686316 || v21 + rows[gi][0] <= 0.0 {
            ONE
        } else if lg < 0.24094655 {
            0.0
        } else {
            ((lg - 0.24094655) * 0.5845423 * 4.0).powi(5)
        };
        // 3A930
        let mg_ = self.b_tot[gi].min(self.s656[gi]);
        let cg = curve(mg_ + d, t4);
        let (lo, hi) = if lg > mg_ { (rows[gi][0], cg) } else { (cg, rows[gi][0]) };
        for v in rows[gi][1..].iter_mut() {
            *v = lohi(*v, lo, hi);
        }
        for g in 0..gi {
            let mg = self.b_tot[g].min(self.s656[g]);
            let cgg = curve((self.b_tot[gi] - self.b_tot[g] + d + mg).min(t4[0]), t4);
            rows[g][0] = lohi(rows[g][0], lo, hi);
            let (a, z) = if lt[g] > mg { (rows[g][0], cgg) } else { (cgg, rows[g][0]) };
            for v in rows[g][1..].iter_mut() {
                *v = lohi(*v, a, z);
            }
        }
        // AD30
        if self.b_tot[gi] >= lg {
            let thr_g = self.b_tot[gi] - self.t.gmin[gi];
            let thr_b = self.b_tot[gi] - 0.21077698;
            let ac20 = |row: &[f64; NB + 1], m: f64, bb: &[f64; NB]| {
                let mut m = row[0].min(m);
                for b in 0..NB {
                    if bb[b] > thr_b {
                        m = m.min(row[b + 1]);
                    }
                }
                m
            };
            let v14 = ac20(&rows[gi], rows[gi][0], &self.b_b[gi]);
            for v in rows[gi].iter_mut() {
                *v = v.min(v14);
            }
            let mut i = v14;
            for g in 0..gi {
                if self.b_tot[g] > thr_g {
                    i = i.min(ac20(&rows[g], v14, &self.b_b[g]));
                }
            }
            for row in rows.iter_mut().take(gi) {
                for v in row.iter_mut() {
                    *v = v.min(i);
                }
            }
        }
        // AF00 (A sub_180055280: A's cap)
        for row in rows.iter_mut() {
            for v in row.iter_mut() {
                *v = ((0.5 * *v + 0.5 * v21) * fade).clamp(-0.49999994, MAX_BOOST) * 2.0;
            }
        }
        rows
    }

    /// sub_1800394C0 (A sub_180054C90).
    #[allow(clippy::too_many_arguments)]
    fn modes(&mut self, e1: f64, e2: f64, flag: bool, lg: f64, s656g: f64, s320g: f64, row_g0: f64) -> ([f64; 3], bool, bool, bool) {
        let lt = &self.t.lev_tab;
        let o2 = pow2a(LEV_TC / ((ONE - e1) * 0.5 + e1 * 0.01));
        let o0 = e2 * lt[2] + (ONE - e2);
        let o1 = e2 * lt[3] + (ONE - e2);
        if flag {
            self.st0 = 0.5 * lg - 0.5 * s656g <= -0.021477653;
        }
        self.st1 = if lg >= 0.6686316 { 0 } else { (self.st1 + 1).min(LOW_HOLD) };
        let o4 = self.st1 >= LOW_HOLD;
        let o5 = lg >= s656g && row_g0 >= s320g && s656g < 0.6686316;
        ([o0, o1, o2], self.st0, o4, o5)
    }

    /// sub_180039330 (total) and the band loop of sub_180039630 (A sub_180054E10).
    fn coef(&self, o: &([f64; 3], bool, bool, bool), inp: f64, state: f64, tgt: f64, gstate: f64, w: f64) -> f64 {
        let t = &self.t.lev_tab;
        let (f, st0, o4, o5) = (o.0, o.1, o.2, o.3);
        if inp < state || tgt < gstate {
            let dd = 0.5 * inp - 0.5 * state;
            if dd > 0.021477653 {
                return t[1];
            }
            if dd > 0.0 {
                return t[0];
            }
            if dd <= -0.021477653 && st0 {
                if w > 0.0 {
                    return (ONE - w) * t[3] + w * t[5];
                }
                return if o4 && gstate > tgt { t[3] } else { f[1] };
            }
            if w > 0.0 {
                return (ONE - w) * t[2] + w * t[4];
            }
            return if o4 && gstate > tgt { t[2] } else { f[0] };
        }
        if o5 { f[2] } else { f[0] }
    }

    /// sub_1800398C0 + sub_1800382D0 (A sub_180055160 + sub_1800561A0).
    fn spread_blend(&self, s: &[f64; NB], wb: &[f64; NB]) -> [f64; NB] {
        let k = &self.t.spread_k;
        std::array::from_fn(|b| {
            let mut acc = s[b] * k[0];
            for (j, kj) in k.iter().enumerate().skip(1) {
                if b + j < NB {
                    acc += kj * s[b + j];
                }
                if b >= j {
                    acc += kj * s[b - j];
                }
            }
            let out = (acc * self.t.spread_n[b]).max(-1.0);
            if out > s[b] { wb[b] * s[b] + (1.0 - wb[b]) * out } else { out }
        })
    }

    /// sub_180023E30 (A sub_18003AA70): returns the loudness accumulator and the coupling weights.
    #[allow(clippy::too_many_arguments)]
    fn level(&mut self, reset: bool, lt: &[f64; G], n: &[[f64; NB]; G], e1: f64, e2: f64, flag: bool, v21: f64, t4: &[f64]) -> ([[f64; NB]; G], [[f64; NB]; NG]) {
        let gi = NG;
        if reset {
            self.s656 = [-ONE; G];
            self.s320 = [0.0; G];
            self.s336 = [[-ONE; NB]; G];
            self.s0 = [[0.0; NB]; G];
        }
        let rows = self.static_rows(lt, n, v21, t4);
        let o = self.modes(e1, e2, flag, lt[gi], self.s656[gi], self.s320[gi], rows[gi][0]);
        let mut acc = [[0.0; NB]; G];
        let mut w = [[ONE; NB]; NG];
        let mut vg = [0.0; NB];
        for g in (0..G).rev() {
            let wt = wfun(self.s656[g] - self.a_tot[g]);
            let wb: [f64; NB] = std::array::from_fn(|b| wt.min(wfun(self.s336[g][b] - self.a_b[g][b])));
            let c = self.coef(&o, lt[g], self.s656[g], rows[g][0], self.s320[g], wt);
            self.s656[g] = self.s656[g] * c + (ONE - c) * lt[g];
            self.s320[g] = c * self.s320[g] + (ONE - c) * rows[g][0];
            for b in 0..NB {
                let c = self.coef(&o, n[g][b], self.s336[g][b], rows[g][b + 1], self.s0[g][b], wb[b]);
                self.s336[g][b] = self.s336[g][b] * c + (ONE - c) * n[g][b];
                self.s0[g][b] = c * self.s0[g][b] + (ONE - c) * rows[g][b + 1];
            }
            let v16 = self.spread_blend(&self.s0[g], &wb);
            for b in 0..NB {
                acc[g][b] += 0.25 * v16[b].max(-1.0);
            }
            if g == gi {
                vg = v16;
            } else {
                for b in 0..NB {
                    let v45 = (v16[b] - vg[b]).abs() + (v16[b] - v21).abs();
                    w[g][b] = if v45 < 0.024999997 { (ONE - (32.0 * v45 + 8.0 * v45)).powi(2) } else { 0.0 };
                }
            }
        }
        (acc, w)
    }

    /// 25930: loudness-domain gain -> excitation.
    fn solve(&self, es: &[f64; NB], acc: &[f64; NB]) -> [f64; NB] {
        let mut n = self.nprime_vec(es);
        let mut over = [0.0; NB];
        for b in 0..NB {
            if n[b] != -1.0 {
                let v = 4.0 * acc[b] + n[b];
                let vc = clamp1(v);
                over[b] = ((v - vc) * 0.25406066).clamp(-ONE, 0.0);
                n[b] = vc;
            }
        }
        std::array::from_fn(|b| clamp1(self.sys + over[b] + self.nprime_inv(b, n[b])))
    }

    /// 25B50 + 25170.
    fn solver(&mut self, e: &[[f64; NB]; G], acc: &[[f64; NB]; G], w: &[[f64; NB]; NG], rst: bool) -> [f64; NB] {
        let mut enew = [[0.0; NB]; NG];
        let mut gains = [[0.0; NB]; NG];
        let mut esc: Option<[f64; NB]> = None;
        let band_smooth = self.t.band_smooth;
        for g in 0..NG {
            if rst {
                self.sol[g] = e[g];
            } else {
                smooth384(&mut self.sol[g], &e[g], &band_smooth, &band_smooth, 0.0);
            }
            let es = self.sol[g];
            enew[g] = self.solve(&es, &acc[g]);
            gains[g] = std::array::from_fn(|b| enew[g][b] - es[b]);
            esc = Some(match esc {
                None => es,
                Some(c) => logadd_vec(&es, &c),
            });
        }
        let enewc = self.solve(&esc.unwrap(), &acc[NG]);
        let mut lsum = enew[0];
        for en in enew.iter().skip(1) {
            lsum = logadd_vec(en, &lsum);
        }
        std::array::from_fn(|b| gains[0][b] + w[0][b] * (enewc[b] - lsum[b]).min(0.0))
    }

    /// One 256-sample block: `p[ch][band]` the block's band power of each rendered channel;
    /// returns the band gains, dB.
    pub fn process(&mut self, p: &[[f64; NB]]) -> ([f64; NB], Trace) {
        let gi = NG;
        let lev = self.detector_levels(p);
        let v30 = 0.41538462 - self.in_t.clamp(-0.30769226, f64::MAX).min(0.0);
        let v31o = 0.41538462 - self.out_t.clamp(-0.30769226, f64::MAX).min(0.0);
        let e0: [f64; NB] = std::array::from_fn(|b| (lev[b] + v30 + 0.19615382 + self.t.t0[b]).max(FLOOR[b]));
        let e = [e0, FLOOR, logadd_vec(&e0, &FLOOR)];
        let (reset, onset) = self.silence(&e[gi], v30);
        let rexc = reset || onset;
        let mut n = [[0.0; NB]; G];
        let mut lt = [0.0; G];
        let (fast, slow) = ([self.t.exc_fast], [self.t.exc_slow]);
        for g in 0..G {
            if rexc {
                self.exc[g] = e[g];
            } else {
                smooth384(&mut self.exc[g], &e[g], &fast, &slow, 0.07692307);
            }
            n[g] = self.nprime_vec(&self.exc[g]);
            lt[g] = self.total_loudness(&self.exc[g]);
        }
        let c = self.c;
        let flag = self.event(&e[gi], rexc, c);
        let (e1, e2) = (self.e1, self.e2);
        if reset {
            self.lt_reset();
        }
        self.longterm(&lt, &n, e1, e2, c);
        let v21 = curve(self.a_tot[gi] - self.t.reference, &self.t3);
        let t4 = blend_table(&self.t3, &self.t4raw, c);
        let (acc, w) = self.level(reset, &lt, &n, e1, e2, flag, v21, &t4);
        let g0 = self.solver(&e, &acc, &w, rexc);
        let diff = v30 - v31o;
        let mut hf = [0.0; NB];
        if v21 <= 0.0 {
            for b in 12..NB {
                hf[b] = if v21 > -1.0 { clamp1(v21 * 0.26953775 * self.t.d4dd0[b - 12]) } else { -1.0 };
            }
        }
        let gains = std::array::from_fn(|b| {
            let g = if hf[b] <= -1.0 || diff <= -1.0 || g0[b] <= -1.0 { -1.0 } else { (g0[b] + diff + hf[b]).clamp(-1.0, 1.0) };
            g * 130.0
        });
        let trace = Trace { reset, onset, c: self.c, e1: self.e1, e2: self.e2, l_g: lt[gi], a_g: self.a_tot[gi], b_g: self.b_tot[gi], s656_g: self.s656[gi], s320_g: self.s320[gi], v21 };
        (gains, trace)
    }
}

/// One block's band power per channel (R `qmf_band_power` 0x180020510): the sum over its slots
/// and over each DAP band's hybrid bins of |X|^2.
pub fn band_powers(slots: &[[C32; BANDS]]) -> [f64; NB] {
    let mut p = [0.0; NB];
    let mut lo = 0;
    for (b, &hi) in EDGES.iter().enumerate() {
        for s in slots {
            for x in &s[lo..hi] {
                p[b] += (x.re as f64) * (x.re as f64) + (x.im as f64) * (x.im as f64);
            }
        }
        lo = hi;
    }
    p
}

/// The hybrid bin's DAP band.
pub fn band_of_bin() -> [usize; BANDS] {
    std::array::from_fn(|bin| EDGES.iter().position(|&e| bin < e).unwrap_or(NB - 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filterbank::{Analysis, Tables as Fb};

    fn read<T, const N: usize>(name: &str, conv: fn([u8; N]) -> T) -> Vec<T> {
        let path = format!("{}/tests/fixtures/leveler/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(path).unwrap().chunks(N).map(|c| conv(c.try_into().unwrap())).collect()
    }

    #[test]
    fn matches_the_traces_port_block_by_block() {
        // the trace's DVLeveler (engine A, amount 4) on pink noise in both ears through every
        // dynamic path: onset after silence, attack, hold, an abrupt drop, a fade, silence, onset
        let p = read("powers.f32", f32::from_le_bytes);
        let want = read("gains_db.f32", f32::from_le_bytes);
        let states = read("states.f64", f64::from_le_bytes);
        let blocks = p.len() / (2 * NB);
        assert_eq!(blocks, 3938);
        let mut lev = Leveler::movie();
        let mut worst: f64 = 0.0;
        for t in 0..blocks {
            let ch: [[f64; NB]; 2] = std::array::from_fn(|c| std::array::from_fn(|b| p[(t * 2 + c) * NB + b] as f64));
            let (g, tr) = lev.process(&ch);
            for b in 0..NB {
                worst = worst.max((g[b] - want[t * NB + b] as f64).abs());
            }
            let s = &states[t * 11..t * 11 + 11];
            assert_eq!((tr.reset, tr.onset), (s[0] != 0.0, s[1] != 0.0), "block {t}");
            for (got, want) in [tr.c, tr.e1, tr.e2, tr.l_g, tr.a_g, tr.b_g, tr.s656_g, tr.s320_g, tr.v21].iter().zip(&s[2..]) {
                assert!((got - want).abs() < 1e-9, "block {t}: {got} vs {want}");
            }
        }
        // the gains were stored as f32
        assert!(worst < 1e-4, "worst band gain difference {worst} dB");
    }

    #[test]
    fn the_detector_sees_what_the_code_translated_filterbank_sees() {
        // band powers of a pink noise through our analysis vs the trace's emulator
        let x = read("pink.f32", f32::from_le_bytes);
        let want = read("pink_bandpow.f64", f64::from_le_bytes);
        let fb = Fb::load();
        let mut a = Analysis::new();
        let slots: Vec<[C32; BANDS]> = x.chunks(64).map(|s| a.process(&fb, s)).collect();
        for (k, block) in slots.chunks(4).enumerate() {
            let p = band_powers(block);
            for b in 0..NB {
                let w = want[k * NB + b];
                assert!((p[b] - w).abs() <= 1e-4 * w.max(1e-12), "block {k} band {b}: {} vs {w}", p[b]);
            }
        }
    }
}
