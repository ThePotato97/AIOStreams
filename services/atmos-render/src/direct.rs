//! Per-input gains, as `hpv_update_object_filters` (Reference Player) and `sub_18003E550`
//! (Atmos for Headphones) compute them: position warp and distance, the PCA HRTF, the ITD as a
//! phase ramp on the farther ear, the distance law, and the room send. The common x8 of every
//! path is not applied: it undoes the metadata-gain convention (unity = 4096 = Q15 0.125), and
//! metadata gains here are already linear with unity 1.0.

use crate::complex::C32;
use crate::tuning::{BANDS, EAR_GAIN, ITD_BANDS, LFE_BANDS, LFE_TABLE, OMNI_GAIN, SH_TERMS, Tuning};

/// Speed of sound the ITD path lengths use (m/s).
const SPEED_OF_SOUND: f32 = 343.3;
const SAMPLE_RATE: f32 = 48000.0;

/// Render modes (the stream's 2-bit headphone code passes straight through).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off = 0,
    Near = 1,
    Far = 2,
    Mid = 3,
}

impl Mode {
    pub fn from_code(code: u8) -> Self {
        match code {
            0 => Mode::Off,
            1 => Mode::Near,
            2 => Mode::Far,
            _ => Mode::Mid,
        }
    }
}

/// The 36-term polynomial SH basis of the HRTF and ITD shadow tables (not orthonormal).
/// x forward, y left, z up.
pub fn basis(x: f32, y: f32, z: f32) -> [f32; SH_TERMS] {
    let (x2, y2) = (x * x, y * y);
    [
        1.0,
        x,
        y,
        z,
        x2 - 1.0 / 3.0,
        x * y,
        x * z,
        y2 - 1.0 / 3.0,
        y * z,
        (x2 - 0.6) * x,
        (x2 - 0.2) * y,
        (x2 - 0.2) * z,
        (y2 - 0.2) * x,
        x * y * z,
        (y2 - 0.6) * y,
        (y2 - 0.2) * z,
        x2 * x2 - 0.2,
        x2 * x * y,
        x2 * x * z,
        x2 * y2 - 1.0 / 15.0,
        x2 * y * z,
        x * y2 * y,
        x * y2 * z,
        y2 * y2 - 0.2,
        y2 * y * z,
        (x2 * x2 - 3.0 / 7.0) * x,
        (x2 * x2 - 3.0 / 35.0) * y,
        (x2 * x2 - 3.0 / 35.0) * z,
        (x2 * y2 - 3.0 / 35.0) * x,
        x2 * x * y * z,
        (x2 * y2 - 3.0 / 35.0) * y,
        (x2 * y2 - 1.0 / 35.0) * z,
        (y2 * y2 - 3.0 / 35.0) * x,
        x * y2 * y * z,
        (y2 * y2 - 3.0 / 7.0) * y,
        (y2 * y2 - 3.0 / 35.0) * z,
    ]
}

/// Bed channel positions, Dolby x/y/z (0..1), from `hpv_channel_id_position` /
/// `sub_1800201B0`. Index = channel ID; LFE (4, 0x11) has no position.
pub fn bed_position(id: u32) -> Option<[f32; 3]> {
    let w = 5461.0 / 32768.0;
    Some(match id {
        1 => [0.0, 0.0, 0.0],
        2 => [1.0, 0.0, 0.0],
        3 => [0.5, 0.0, 0.0],
        5 => [0.0, 0.5, 0.0],
        6 => [1.0, 0.5, 0.0],
        7 => [0.0, 1.0, 0.0],
        8 => [1.0, 1.0, 0.0],
        9 => [0.0, 0.0, 1.0],
        10 => [1.0, 0.0, 1.0],
        11 => [0.0, 0.5, 1.0],
        12 => [1.0, 0.5, 1.0],
        13 => [0.0, 1.0, 1.0],
        14 => [1.0, 1.0, 1.0],
        15 => [0.0, w, 0.0],
        16 => [1.0, w, 0.0],
        _ => return None,
    })
}

/// Everything an input contributes per band for one block.
pub struct InputGains {
    pub ears: [[C32; BANDS]; 2],
    /// FOA send scale per bus channel (W, X, Y, Z); zero when the input sends nothing.
    pub send: [f32; 4],
    /// Whether this input keeps the room running (Mid or Far).
    pub holds_room: bool,
}

pub struct Geometry {
    pub dir: [f32; 3],
    /// Normalised distance.
    pub d: f32,
    /// Distance in metres.
    pub metres: f32,
}

fn sgn(v: f32) -> f32 {
    if v < 0.0 {
        -1.0
    } else if v > 0.0 {
        1.0
    } else {
        0.0
    }
}

/// The cube -> sphere warp of `hpv_meta_to_cartesian_warp_clamp` (as `scripts/warp.py` ports
/// it): X = 1 - 2y, Y = 1 - 2x, Z = z; azimuth kept, elevation = atan(Z / max(|X|, |Y|)),
/// radius = max(|X|, |Y|, |Z|). The room centre (X = Y = 0) gives (0, 0, Z).
pub fn cube_to_sphere(pos: [f32; 3]) -> [f32; 3] {
    let (x, z) = (1.0 - 2.0 * pos[1], pos[2]);
    let v15 = 2.0 * pos[0] - 1.0; // = -Y
    if v15 == 0.0 && x == 0.0 {
        return [0.0, 0.0, z];
    }
    let (a18, mut a19) = (x.abs(), v15.abs());
    let (v21, v24) = if a19 <= a18 {
        let r = ((v15 / x).abs() * sgn(v15), sgn(x));
        a19 = a18;
        r
    } else {
        (sgn(v15), (x / v15).abs() * sgn(x))
    };
    let h = v24 * v24 + v21 * v21;
    if z == 0.0 {
        let k = 1.0 / h.sqrt();
        return [x * k, -(v15 * k), 0.0];
    }
    let (v28, v16) = if z.abs() <= a19 { ((z / a19).abs() * sgn(z), sgn(z)) } else { (sgn(z), (a19 / z).abs() * sgn(a19)) };
    let v33 = v16 * v16 + v28 * v28;
    let k = 1.0 / (h * v33).sqrt();
    [x * k, -(v15 * k), z / v33.sqrt()]
}

/// Dolby x/y/z (0..1; x left->right, y front->back, z floor->ceiling) -> direction and distance:
/// the warp, the mode's per-axis scales, d = vector length. Atmos for Headphones has no box step.
pub fn warp(t: &Tuning, pos: [f32; 3], mode: Mode) -> Geometry {
    let p = cube_to_sphere(pos);
    let m = &t.modes[mode as usize];
    let v = [p[0] * m.fwd_scale, p[1] * m.lat_scale, p[2] * m.z_scale];
    let d = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    // At (almost) zero distance the direction is straight ahead.
    let dir = if d > 1e-6 { [v[0] / d, v[1] / d, v[2] / d] } else { [1.0, 0.0, 0.0] };
    Geometry { dir, d, metres: d * t.b0 * m.p6 }
}

/// Interaural delay in samples and which ear is farther (0 left, 1 right), per
/// `hpv_ear_paths_itd_or_nfild`: path lengths to ears at +/-Y plus the head-shadow detour.
pub fn itd(t: &Tuning, g: &Geometry, mode: Mode) -> (f32, Option<usize>) {
    let m = &t.modes[mode as usize];
    let a = (g.d / m.r0).min(1.0);
    let dm = g.d.max(m.r0) * m.p6;
    let e = t.ear_offset;
    let src = [g.dir[0] * dm, g.dir[1] * dm, g.dir[2] * dm];
    let ears = [[src[0], src[1] - e, src[2]], [src[0], src[1] + e, src[2]]];
    let mut path = [0f32; 2];
    for (ear, p) in ears.iter().enumerate() {
        let n = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        let y = basis(p[0] / n, p[1] / n, p[2] / n);
        let s: f32 = t.shadow[ear].iter().zip(y.iter()).map(|(a, b)| a * b).sum();
        path[ear] = n + 2.0 * t.shadow_weight * s.max(0.0);
    }
    let tau = (path[0] - path[1]).abs() * SAMPLE_RATE / SPEED_OF_SOUND * a;
    let far = if path[0] > path[1] {
        Some(0)
    } else if path[1] > path[0] {
        Some(1)
    } else {
        None
    };
    (tau, far)
}

/// Gains of a positioned input (bed channel or object) with metadata gain `gain`. The encoder's
/// input headroom is applied to the samples, before the renderer (`input.rs`).
pub fn input_gains(t: &Tuning, pos: [f32; 3], mode: Mode, gain: f32) -> InputGains {
    let g = gain;
    let mut out = InputGains { ears: [[C32::ZERO; BANDS]; 2], send: [0.0; 4], holds_room: false };
    if mode == Mode::Off {
        // `hpv_offmode_pan_gains`: an equal-power pan from x alone, the same gain in every band;
        // no warp, HRTF, distance law or room.
        let m0 = &t.modes[0];
        let u = (m0.p6 * (1.0 - 2.0 * pos[0]) * m0.lat_scale).clamp(-1.0, 1.0);
        let theta = std::f32::consts::FRAC_PI_4 * (1.0 + u);
        let (l, r) = (g * theta.sin().max(0.0), g * theta.cos().max(0.0));
        for b in 0..BANDS {
            out.ears[0][b] = C32::real(l);
            out.ears[1][b] = C32::real(r);
        }
        return out;
    }
    let geo = warp(t, pos, mode);
    let m = &t.modes[mode as usize];
    let gd = 1.0 / (1.0 + t.beta * geo.metres * geo.metres).sqrt();
    let a = (geo.d / m.r0).min(1.0);
    let y = basis(geo.dir[0], geo.dir[1], geo.dir[2]);
    let g_dir = EAR_GAIN * g * gd * a;
    // Inside r0 the directional weights fade toward the k = 0 column (Y_0 = 1), weighted 0.70700.
    let g_omni = OMNI_GAIN * g * gd * (1.0 - a);
    for ear in 0..2 {
        let coef = &t.hrtf_coef[ear];
        let w: Vec<f32> = coef
            .iter()
            .map(|c| g_dir * c.iter().zip(y.iter()).map(|(a, b)| a * b).sum::<f32>() + g_omni * c[0])
            .collect();
        for b in 0..BANDS {
            let h: f32 = t.hrtf_basis[ear][b].iter().zip(w.iter()).map(|(a, b)| a * b).sum();
            out.ears[ear][b] = C32::real(h);
        }
    }
    let (tau, far) = itd(t, &geo, mode);
    if let Some(ear) = far {
        for b in 0..ITD_BANDS {
            // e^(-j |w_b| tau) (w_b < 0): a delay of the farther ear, `hpv_itd_phase_ramp`. The
            // conjugated image bands (1, 3) get the same phasor.
            out.ears[ear][b] = out.ears[ear][b] * C32::cis(t.itd_omega[b] * tau);
        }
    }
    let sends = !(mode == Mode::Near && t.near_send_off);
    if sends {
        let s = g * geo.metres * gd;
        out.send = [s, s * geo.dir[0], s * geo.dir[1], s * geo.dir[2]];
    }
    out.holds_room = matches!(mode, Mode::Mid | Mode::Far);
    out
}

/// The LFE path: g T[b] to both ears, bands 0-15; no HRTF, ITD or room.
pub fn lfe_gains(gain: f32) -> InputGains {
    let g = gain;
    let mut out = InputGains { ears: [[C32::ZERO; BANDS]; 2], send: [0.0; 4], holds_room: false };
    for b in 0..LFE_BANDS {
        out.ears[0][b] = C32::real(g * LFE_TABLE[b]);
        out.ears[1][b] = C32::real(g * LFE_TABLE[b]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t() -> Tuning {
        Tuning::load().unwrap()
    }

    #[test]
    fn beds_sit_on_the_cube_corners_at_mid_distance() {
        let t = t();
        let g = warp(&t, bed_position(1).unwrap(), Mode::Mid);
        assert!((g.metres - 1.5).abs() < 0.01, "{}", g.metres);
        let az = g.dir[1].atan2(g.dir[0]).to_degrees();
        assert!((az - 45.0).abs() < 0.1);
        // the top channels sit at +45 degrees (elevation = atan(Z / max(|X|, |Y|)))
        let p = cube_to_sphere(bed_position(9).unwrap());
        let el = p[2].atan2(p[0].hypot(p[1])).to_degrees();
        assert!((el - 45.0).abs() < 0.01, "{el}");
        // and the radius is the max-norm
        assert!(((p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt() - 1.0).abs() < 1e-5);
        let g = warp(&t, bed_position(8).unwrap(), Mode::Mid);
        assert!((g.dir[1].atan2(g.dir[0]).to_degrees() + 135.0).abs() < 0.1);
    }

    #[test]
    fn room_send_is_6_5_db_over_the_direct_ear_gain_at_mid() {
        let t = t();
        let gains = input_gains(&t, bed_position(3).unwrap(), Mode::Mid, 1.0);
        let geo = warp(&t, bed_position(3).unwrap(), Mode::Mid);
        let gd = 1.0 / (1.0 + t.beta * geo.metres * geo.metres).sqrt();
        let direct = EAR_GAIN * gd;
        let db = 20.0 * (gains.send[0] / direct).log10();
        assert!((db - 6.5).abs() < 0.1, "{db}");
    }

    #[test]
    fn the_farther_ear_is_delayed_and_side_sources_have_the_largest_itd() {
        let t = t();
        let (side, far) = itd(&t, &warp(&t, bed_position(5).unwrap(), Mode::Mid), Mode::Mid);
        assert_eq!(far, Some(1), "a left source reaches the right ear later");
        let (front, _) = itd(&t, &warp(&t, bed_position(1).unwrap(), Mode::Mid), Mode::Mid);
        let (centre, cfar) = itd(&t, &warp(&t, bed_position(3).unwrap(), Mode::Mid), Mode::Mid);
        assert!(side > front && front > 0.0);
        assert!(centre.abs() < 1e-3 && cfar.is_none());
        // traced formula at the bed corners: about 404 us front, 651 us side
        assert!((front / 48.0 * 1000.0 - 404.0).abs() < 5.0, "{}", front / 48.0 * 1000.0);
        assert!((side / 48.0 * 1000.0 - 651.0).abs() < 5.0, "{}", side / 48.0 * 1000.0);
    }

    #[test]
    fn near_inputs_send_weakly_and_off_inputs_not_at_all() {
        let t = t();
        let mid = input_gains(&t, [0.0, 0.0, 0.0], Mode::Mid, 1.0).send[0];
        let near = input_gains(&t, [0.0, 0.0, 0.0], Mode::Near, 1.0).send[0];
        let off = input_gains(&t, [0.0, 0.0, 0.0], Mode::Off, 1.0);
        assert!((20.0 * (mid / near).log10() - 15.4).abs() < 0.3);
        assert_eq!(off.send, [0.0; 4]);
        // the traced equal-power law: x = 0, 0.25, 0.5, 0.75, 1
        for (x, l, r) in [(0.0, 1.0, 0.0), (0.25, 0.924, 0.383), (0.5, 0.707, 0.707), (0.75, 0.383, 0.924), (1.0, 0.0, 1.0)] {
            let g = input_gains(&t, [x, 0.3, 0.7], Mode::Off, 1.0);
            assert!((g.ears[0][40].re - l).abs() < 2e-3 && (g.ears[1][40].re - r).abs() < 2e-3, "x {x}");
        }
    }

    #[test]
    fn the_warp_matches_the_port() {
        // warp.py: 'Ltm' (0, 16384, 32767) -> (0, 1, 1)/sqrt(2) direction, radius 1;
        // an object at z = -0.5 at the front left corner keeps radius 1, elevation -26.57
        let p = cube_to_sphere([0.0, 0.5, 1.0]);
        assert!((p[0]).abs() < 1e-6 && (p[1] - 0.70711).abs() < 1e-4 && (p[2] - 0.70711).abs() < 1e-4, "{p:?}");
        let p = cube_to_sphere([0.0, 0.0, -0.5]);
        let el = p[2].atan2(p[0].hypot(p[1])).to_degrees();
        assert!((el + 26.565).abs() < 0.01, "{el}");
        // the room centre: straight up, length |z|
        assert_eq!(cube_to_sphere([0.5, 0.5, 0.25]), [0.0, 0.0, 0.25]);
    }

    #[test]
    fn the_omni_term_is_the_k0_column_at_0_707() {
        let t = t();
        // At the room centre (d = 0) H = 0.707 g sum_c B[b][c] C[c][0]
        let g = input_gains(&t, [0.5, 0.5, 0.0], Mode::Mid, 1.0);
        let h: f32 = (0..t.hrtf_coef[0].len()).map(|c| t.hrtf_basis[0][20][c] * t.hrtf_coef[0][c][0]).sum();
        assert!((g.ears[0][20].re - 0.707 * h).abs() < 1e-5);
    }

    #[test]
    fn lfe_is_about_10_db_over_a_channel_in_the_lowest_bands() {
        let t = t();
        let lfe = lfe_gains(1.0);
        let ch = input_gains(&t, bed_position(3).unwrap(), Mode::Mid, 1.0);
        let p = |g: &InputGains| ((g.ears[0][0].norm2() + g.ears[0][1].norm2()) / 2.0).sqrt();
        let db = 20.0 * (p(&lfe) / p(&ch)).log10();
        assert!((7.0..=11.0).contains(&db), "{db}");
    }
}
