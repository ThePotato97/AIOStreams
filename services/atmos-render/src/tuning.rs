//! Atmos for Headphones tuning (DAP-VR 8.1.0), from the tag-decoded resources 255/254 of
//! `DolbyAudioProcessing.dll` 7.3.7. Tags are kept as the raw int16 values the reader sees and are
//! scaled here exactly as the engine does (plain Q15 unless an exponent tag says otherwise).

use std::collections::HashMap;

use anyhow::{Context, Result, anyhow};

pub const BANDS: usize = 77;
pub const SH_TERMS: usize = 36;
pub const ITD_BANDS: usize = 20;
pub const LFE_BANDS: usize = 16;

const TUNING_JSON: &str = include_str!("../data/dafh-tuning.json");

/// One render-mode parameter set (tags 47-50 for modes 0-3): 13 int16 values.
#[derive(Debug, Clone, Copy)]
pub struct ModeSet {
    /// Box limits: fwd min/max, lat min/max, z min/max (normalised).
    pub boxed: [f32; 6],
    /// Metres per normalised unit.
    pub p6: f32,
    /// Normalised units per metre.
    pub p7: f32,
    pub lat_scale: f32,
    pub z_scale: f32,
    pub fwd_scale: f32,
    /// Near-field radius, normalised.
    pub r0: f32,
}

pub struct Tuning {
    /// PCA HRTF: 10 components x 36 SH coefficients, per ear.
    pub hrtf_coef: [Vec<[f32; SH_TERMS]>; 2],
    /// PCA HRTF: 77 bands x 10 components spectral basis, per ear.
    pub hrtf_basis: [Vec<Vec<f32>>; 2],
    /// ITD head-shadow tables (36 SH terms), per ear.
    pub shadow: [[f32; SH_TERMS]; 2],
    /// Ear offset for the ITD path lengths (m) and head-shadow weight.
    pub ear_offset: f32,
    pub shadow_weight: f32,
    /// ITD phase: rad/sample per band 0-19 (negative), from the increment table.
    pub itd_omega: [f32; ITD_BANDS],
    pub b0: f32,
    pub beta: f32,
    pub modes: [ModeSet; 4],
    /// Zero Near-mode room sends (tag 60).
    pub near_send_off: bool,
    /// Slots the room keeps running after the last Mid/Far input.
    pub room_hold: usize,
    // Room (tuning A)
    pub allpass_delays: Vec<usize>,
    pub allpass_gains: Vec<f32>,
    pub multichannel_send: bool,
    pub fdn_delays: [usize; 4],
    pub fdn_tap: usize,
    /// G[4k + c]: from line k to line c.
    pub fdn_feedback: [f32; 16],
    /// Complex decay per band per line.
    pub fdn_decay: Vec<[(f32, f32); 4]>,
    /// Output EQ per band per line.
    pub fdn_eq: Vec<[f32; 4]>,
    pub er_delays: Vec<usize>,
    /// Per tap, per band complex gain.
    pub er_filters: Vec<Vec<(f32, f32)>>,
    /// Per tap 4x4, row = output channel, column = input channel.
    pub er_matrices: Vec<[f32; 16]>,
    /// FOA -> binaural decoder: per band, per bus channel, (L, R) complex.
    pub decoder: Vec<[[(f32, f32); 2]; 4]>,
}

fn q15(v: i32) -> f32 {
    v as f32 / 32768.0
}

impl Tuning {
    pub fn load() -> Result<Self> {
        let json: serde_json::Value = serde_json::from_str(TUNING_JSON)?;
        let tags = json["tags"].as_object().context("tags")?;
        let mut t: HashMap<u32, Vec<i32>> = HashMap::new();
        for (k, v) in tags {
            let values = v
                .as_array()
                .context("tag values")?
                .iter()
                .map(|x| x.as_i64().map(|n| n as i32).context("int"))
                .collect::<Result<Vec<_>>>()?;
            t.insert(k.parse()?, values);
        }
        let tag = |id: u32| t.get(&id).ok_or_else(|| anyhow!("tuning tag {id} missing"));
        let one = |id: u32| -> Result<i32> { Ok(tag(id)?[0]) };

        if one(3)? as usize != BANDS {
            return Err(anyhow!("tuning has {} bands, expected {BANDS}", one(3)?));
        }
        let components = one(10)? as usize;
        let hrtf_exp = (2f32).powi(one(26)?); // ids 27/28/29/30
        let basis_exp = (2f32).powi(one(12)?); // ids 34/35

        let coef = |id: u32| -> Result<Vec<[f32; SH_TERMS]>> {
            let v = tag(id)?;
            if v.len() != components * SH_TERMS {
                return Err(anyhow!("tag {id}: {} values", v.len()));
            }
            Ok((0..components)
                .map(|c| std::array::from_fn(|k| q15(v[c * SH_TERMS + k]) * hrtf_exp))
                .collect())
        };
        let basis = |id: u32| -> Result<Vec<Vec<f32>>> {
            let v = tag(id)?;
            if v.len() != BANDS * components {
                return Err(anyhow!("tag {id}: {} values", v.len()));
            }
            // band-major: value[10 b + c]
            Ok((0..BANDS)
                .map(|b| (0..components).map(|c| q15(v[components * b + c]) * basis_exp).collect())
                .collect())
        };
        let shadow = |id: u32| -> Result<[f32; SH_TERMS]> {
            let v = tag(id)?;
            Ok(std::array::from_fn(|k| q15(v[k]) * hrtf_exp))
        };

        // ITD phase per band: type 1 takes the next increment and adds it, 0 adds the previous
        // increment again, 2 holds.
        let types = tag(36)?;
        let incs: Vec<f32> = tag(37)?.iter().map(|&v| q15(v)).collect();
        let mut itd_omega = [0f32; ITD_BANDS];
        let (mut w, mut next, mut last) = (0f32, 0usize, 0f32);
        for (b, &ty) in types.iter().take(ITD_BANDS).enumerate() {
            match ty {
                1 => {
                    last = incs[next];
                    next += 1;
                    w += last;
                }
                0 => w += last,
                _ => {}
            }
            itd_omega[b] = w;
        }

        let mode = |id: u32| -> Result<ModeSet> {
            let v = tag(id)?;
            Ok(ModeSet {
                boxed: std::array::from_fn(|i| q15(v[i])),
                p6: v[6] as f32 * (2f32).powi(v[7]) / 32768.0,
                p7: q15(v[8]),
                lat_scale: q15(v[9]),
                z_scale: q15(v[10]),
                fwd_scale: q15(v[11]),
                r0: q15(v[12]),
            })
        };

        let pairs = |v: &[i32]| -> Vec<(f32, f32)> {
            v.chunks(2).map(|p| (q15(p[0]), q15(p[1]))).collect()
        };
        let decay = pairs(tag(19)?);
        let eq = tag(21)?;
        let er_delays: Vec<usize> = tag(22)?.iter().map(|&d| d as usize).collect();
        let er_raw = pairs(tag(23)?);
        let er_m = tag(24)?;
        let dec = tag(16)?;
        let g = tag(20)?;
        let delays = tag(17)?;

        Ok(Self {
            hrtf_coef: [coef(27)?, coef(28)?],
            hrtf_basis: [basis(34)?, basis(35)?],
            shadow: [shadow(29)?, shadow(30)?],
            ear_offset: q15(one(39)?),
            shadow_weight: q15(one(40)?),
            itd_omega,
            b0: q15(one(43)?),
            beta: one(44)? as f32 * 16.0 / 32768.0,
            modes: [mode(47)?, mode(48)?, mode(49)?, mode(50)?],
            near_send_off: one(60)? > 0,
            room_hold: one(46)? as usize,
            allpass_delays: tag(13)?.iter().map(|&d| d as usize).collect(),
            allpass_gains: tag(14)?.iter().map(|&v| q15(v)).collect(),
            multichannel_send: q15(one(15)?) >= 0.5,
            fdn_delays: std::array::from_fn(|i| delays[i] as usize),
            fdn_tap: one(18)? as usize,
            fdn_feedback: std::array::from_fn(|i| q15(g[i])),
            fdn_decay: (0..BANDS).map(|b| std::array::from_fn(|c| decay[b * 4 + c])).collect(),
            fdn_eq: (0..BANDS).map(|b| std::array::from_fn(|c| q15(eq[b * 4 + c]))).collect(),
            er_filters: (0..er_delays.len())
                .map(|j| er_raw[j * BANDS..(j + 1) * BANDS].to_vec())
                .collect(),
            er_matrices: (0..er_delays.len())
                .map(|j| std::array::from_fn(|i| q15(er_m[j * 16 + i])))
                .collect(),
            er_delays,
            decoder: (0..BANDS)
                .map(|b| {
                    std::array::from_fn(|k| {
                        let o = (b * 4 + k) * 4;
                        [(q15(dec[o]), q15(dec[o + 1])), (q15(dec[o + 2]), q15(dec[o + 3]))]
                    })
                })
                .collect(),
        })
    }
}

/// LFE table T (48 kHz), byte-identical in both engines: hybrid bands 0-15.
pub const LFE_TABLE: [f32; LFE_BANDS] = [
    2.6029000, 1.8074180, 0.6593424, -0.0275856, -0.1058033, -0.0699509, 0.0749056, -0.0091981,
    0.0034901, -0.0158601, -0.0007230, 0.0018819, -0.0004217, 0.0000329, 0.0000317, 0.0000006,
];

/// Input headroom the Atmos for Headphones encoder applies to every input slot.
pub const INPUT_HEADROOM: f32 = 0.7079;

/// Per-ear HRTF gain with near-field ILD off (both tunings).
pub const EAR_GAIN: f32 = 0.70711;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_the_traced_values() {
        let t = Tuning::load().unwrap();
        // mode sets as traced: Mid p6 2.6007, Far 5.2014, Near 1.0
        assert!((t.modes[3].p6 - 2.6007).abs() < 1e-3);
        assert!((t.modes[2].p6 - 5.2014).abs() < 1e-3);
        assert!((t.modes[1].p6 - 1.0).abs() < 1e-4);
        assert!((t.beta - 0.023438).abs() < 1e-5);
        assert!((t.ear_offset - 0.07).abs() < 1e-3);
        assert_eq!(t.fdn_delays, [10, 14, 13, 17]);
        assert_eq!(t.fdn_tap, 1);
        assert_eq!(t.er_delays, vec![5, 6, 9, 13, 15, 18]);
        assert_eq!(t.room_hold, 263);
        assert!(!t.near_send_off);
        assert!(!t.multichannel_send);
        // ITD phase: band 0 is 46.9 Hz, band 19 2437.5 Hz
        let hz = |w: f32| -w * 48000.0 / (2.0 * std::f32::consts::PI);
        assert!((hz(t.itd_omega[0]) - 46.875).abs() < 0.1);
        assert!((hz(t.itd_omega[19]) - 2437.5).abs() < 1.0);
        // feedback matrix is orthogonal
        let g = &t.fdn_feedback;
        for r in 0..4 {
            for c in 0..4 {
                let dot: f32 = (0..4).map(|k| g[r * 4 + k] * g[c * 4 + k]).sum();
                assert!((dot - if r == c { 1.0 } else { 0.0 }).abs() < 2e-3);
            }
        }
    }
}
