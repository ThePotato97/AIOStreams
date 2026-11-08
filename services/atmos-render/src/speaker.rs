//! Dolby Atmos for built-in speakers' renderer (the speaker-path trace, renderer.md): objects and
//! beds amplitude-panned to a fixed 5.1.2 layout by Dolby's separable equal-power "dual-balance"
//! panner, with its automatic trim. No HRTF and no room. R sub_18001DCD0 / A sub_18002CF70; the
//! panner R sub_180046350 / A sub_18005F7C0; the trim constants R sub_180027B40.

/// The 5.1.2 process channels, in the engine's order.
pub const CHANNELS: usize = 8;
pub const L: usize = 0;
pub const R: usize = 1;
pub const C: usize = 2;
pub const LFE: usize = 3;
pub const LS: usize = 4;
pub const RS: usize = 5;
pub const LTM: usize = 6;
pub const RTM: usize = 7;

/// The speaker table (R 0x1800D46D0 = A 0x1802F5440): Dolby x (left to right), y (front to
/// back), z (up), for every channel but the LFE. Ls/Rs sit nominally at y = 0.5 and fall back to
/// the back corners, their dependency (Lrs/Rrs) not being in the layout. The tops' x values are
/// the trace's 4-decimal reading of the Q15 entries.
const SPEAKERS: [(usize, [f32; 3]); 7] = [
    (L, [0.0, 0.0, 0.0]),
    (R, [1.0, 0.0, 0.0]),
    (C, [0.5, 0.0, 0.0]),
    (LS, [0.0, 1.0, 0.0]),
    (RS, [1.0, 1.0, 0.0]),
    (LTM, [0.2419, 0.5, 1.0]),
    (RTM, [0.7581, 0.5, 1.0]),
];

/// The automatic trim for the layout (heights h, surrounds s), dB: 5.1.2 gives -2.25.
fn layout_trim_db(heights: f32, surrounds: f32) -> f32 {
    -(4.5 - 1.5 * heights.min(4.0) / 4.0 - 3.0 * surrounds.min(4.0) / 4.0).max(0.0)
}
const TRIM_DB: f32 = -2.25;

/// One axis of the panner over sorted positions: beyond an end, that end takes all of it;
/// between neighbours a <= v <= b, cos/sin of t = (v - a)/(b - a) times pi/2.
fn axis(positions: &[f32], v: f32, out: &mut [f32]) {
    out.fill(0.0);
    let n = positions.len();
    if v <= positions[0] {
        out[0] = 1.0;
        return;
    }
    if v >= positions[n - 1] {
        out[n - 1] = 1.0;
        return;
    }
    for i in 0..n - 1 {
        let (a, b) = (positions[i], positions[i + 1]);
        if v >= a && v <= b {
            let t = (v - a) / (b - a);
            out[i] = (t * std::f32::consts::FRAC_PI_2).cos();
            out[i + 1] = (t * std::f32::consts::FRAC_PI_2).sin();
            return;
        }
    }
}

/// The panner over one height layer's speakers: rows of equal y, each sorted by x; x within a
/// row, then y across rows.
fn layer(speakers: &[(usize, [f32; 3])], x: f32, y: f32, gains: &mut [f32; CHANNELS]) {
    let mut rows: Vec<f32> = speakers.iter().map(|s| s.1[1]).collect();
    rows.sort_by(f32::total_cmp);
    rows.dedup();
    let mut row_gains = vec![0.0; rows.len()];
    axis(&rows, y, &mut row_gains);
    for (ri, &ry) in rows.iter().enumerate() {
        if row_gains[ri] == 0.0 {
            continue;
        }
        let mut row: Vec<(usize, f32)> =
            speakers.iter().filter(|s| s.1[1] == ry).map(|s| (s.0, s.1[0])).collect();
        row.sort_by(|a, b| a.1.total_cmp(&b.1));
        let xs: Vec<f32> = row.iter().map(|s| s.1).collect();
        let mut g = vec![0.0; row.len()];
        axis(&xs, x, &mut g);
        for (k, &(ch, _)) in row.iter().enumerate() {
            gains[ch] += row_gains[ri] * g[k];
        }
    }
}

/// The 5.1.2 gains of an object or bed at Dolby x/y/z (z already 0 where its elevation flag is
/// off), before its metadata gain: the panner's output (power sum 1) times the automatic trim.
pub fn pan(pos: [f32; 3]) -> [f32; CHANNELS] {
    let [x, y, z0] = pos;
    // bottoms land on the floor
    let z = z0.max(0.0);
    let floor: Vec<(usize, [f32; 3])> =
        SPEAKERS.iter().copied().filter(|s| s.1[2] > -0.1 && s.1[2] <= 0.5).collect();
    let ceiling: Vec<(usize, [f32; 3])> =
        SPEAKERS.iter().copied().filter(|s| s.1[2] > 0.5 && s.1[2] <= 1.0).collect();
    let mut fl = [0.0; CHANNELS];
    let mut ce = [0.0; CHANNELS];
    // the floor's y warp (a 5.1-type floor, Windows' warp mode 1); the ceiling's isn't warped
    layer(&floor, x, (2.0 * y).min(1.0), &mut fl);
    layer(&ceiling, x, y, &mut ce);
    let theta = z * std::f32::consts::FRAC_PI_2;
    // at the top (z >= 0x7FFF/32768) only the ceiling
    let (wf, wc) = if z >= 32767.0 / 32768.0 { (0.0, 1.0) } else { (theta.cos(), theta.sin()) };
    // the automatic trim, weighted by the object's own y and z
    let clamp = |v: f32| v.clamp(0.0, 1.0);
    let w = clamp(clamp(y / 0.6) + clamp((z0 - 0.2) / 0.8));
    let trim = 10f32.powf(w * TRIM_DB / 20.0);
    let mut out = [0.0; CHANNELS];
    for ch in 0..CHANNELS {
        out[ch] = (wf * fl[ch] + wc * ce[ch]) * trim;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::direct::bed_position;

    fn close(got: [f32; CHANNELS], want: &[(usize, f32)]) {
        for ch in 0..CHANNELS {
            let w = want.iter().find(|w| w.0 == ch).map_or(0.0, |w| w.1);
            assert!((got[ch] - w).abs() < 5e-5, "channel {ch}: {} vs {w} in {got:?}", got[ch]);
        }
    }

    #[test]
    fn the_layout_trim_is_the_traced_minus_2_25_db() {
        assert_eq!(layout_trim_db(2.0, 2.0), TRIM_DB);
        // 7.1.4: none
        assert_eq!(layout_trim_db(4.0, 4.0), 0.0);
    }

    #[test]
    fn the_traced_worked_objects() {
        close(pan([0.5, 0.0, 0.0]), &[(C, 1.0)]);
        close(pan([0.0, 0.0, 1.0]), &[(LTM, 0.7718)]);
        close(pan([0.25, 0.5, 0.0]), &[(LS, 0.7445), (RS, 0.3084)]);
        close(pan([0.5, 0.5, 0.5]), &[(LS, 0.3859), (RS, 0.3859), (LTM, 0.3859), (RTM, 0.3859)]);
    }

    #[test]
    fn the_traced_beds_and_statics() {
        let bed = |id| pan(bed_position(id).unwrap());
        close(bed(1), &[(L, 1.0)]);
        close(bed(2), &[(R, 1.0)]);
        close(bed(3), &[(C, 1.0)]);
        // Ls/Rs direct, trimmed at their nominal y = 0.5 (w = 0.833)
        close(bed(5), &[(LS, 0.8058)]);
        close(bed(6), &[(RS, 0.8058)]);
        // Lrs/Rrs onto Ls/Rs; Ltf/Ltr onto Ltm
        close(bed(7), &[(LS, 0.7718)]);
        close(bed(8), &[(RS, 0.7718)]);
        close(bed(9), &[(LTM, 0.7718)]);
        close(bed(13), &[(LTM, 0.7718)]);
        close(bed(10), &[(RTM, 0.7718)]);
        close(bed(14), &[(RTM, 0.7718)]);
        // statics: bottom front onto L, bottom back onto Ls, back centre on both surrounds
        close(pan([0.0, 0.0, -1.0]), &[(L, 1.0)]);
        close(pan([0.0, 1.0, -1.0]), &[(LS, 0.7718)]);
        close(pan([0.5, 1.0, 0.0]), &[(LS, 0.5457), (RS, 0.5457)]);
    }

    #[test]
    fn the_panner_keeps_power() {
        for &(x, y, z) in &[(0.1, 0.2, 0.0), (0.7, 0.9, 0.3), (0.33, 0.4, 0.8), (0.9, 0.1, 0.6)] {
            let g = pan([x, y, z]);
            let w = (((y / 0.6f32).clamp(0.0, 1.0) + ((z - 0.2) / 0.8f32).clamp(0.0, 1.0)).clamp(0.0, 1.0)) * TRIM_DB;
            let trim = 10f32.powf(w / 20.0);
            let power: f32 = g.iter().map(|v| v * v).sum();
            assert!((power - trim * trim).abs() < 1e-5, "{x} {y} {z}: {power}");
        }
    }
}
