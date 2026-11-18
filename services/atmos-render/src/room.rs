//! The room (tuning A), per QMF slot and hybrid band, on a 4-channel FOA bus (W, X, Y, Z), as
//! `hpv_rev_*` runs it in both engines:
//!   late:  0.7071 W -> allpass diffusers -> 4-line FDN; line outputs tapped later, scaled by EQ
//!   early: sum_j H_j(b) M_j send(b, n - d_j)   (Atmos for Headphones: 6 taps)
//!   out:   L/R += sum_k B[b][k] (EQ[b][k] line_k + ER_k)
//! Atmos for Headphones keeps the room running: the hold of `room_hold` slots after the last Mid
//! or Far element only stops it when tag 60 is set, which the shipped tuning doesn't, and then it
//! freezes (nothing is cleared), as the Reference Player's does (`sub_180018B70`).

use crate::complex::C32;
use crate::tuning::{BANDS, Tuning};

struct Allpass {
    delay: usize,
    gain: f32,
    x: Vec<C32>,
    y: Vec<C32>,
    pos: usize,
}

impl Allpass {
    fn new(delay: usize, gain: f32) -> Self {
        Self { delay, gain, x: vec![C32::ZERO; delay], y: vec![C32::ZERO; delay], pos: 0 }
    }
    /// H(z) = (g + z^-D) / (1 + g z^-D)
    fn process(&mut self, x: C32) -> C32 {
        let (xd, yd) = (self.x[self.pos], self.y[self.pos]);
        let y = x.scale(self.gain) + xd - yd.scale(self.gain);
        self.x[self.pos] = x;
        self.y[self.pos] = y;
        self.pos = (self.pos + 1) % self.delay;
        y
    }
}

struct Band {
    allpass: Vec<Allpass>,
    /// Line histories, newest at `pos`.
    lines: [Vec<C32>; 4],
    send: Vec<[C32; 4]>,
}

pub struct Room {
    bands: Vec<Band>,
    pos: usize,
    ring: usize,
    since_mid_far: usize,
}

impl Room {
    pub fn new(t: &Tuning) -> Self {
        let max_line = *t.fdn_delays.iter().max().unwrap() + t.fdn_tap + 1;
        let max_er = t.er_delays.iter().copied().max().unwrap_or(0) + 1;
        let ring = max_line.max(max_er);
        let bands = (0..BANDS)
            .map(|_| Band {
                allpass: t
                    .allpass_delays
                    .iter()
                    .zip(&t.allpass_gains)
                    .map(|(&d, &g)| Allpass::new(d, g))
                    .collect(),
                lines: std::array::from_fn(|_| vec![C32::ZERO; ring]),
                send: vec![[C32::ZERO; 4]; ring],
            })
            .collect();
        Self { bands, pos: 0, ring, since_mid_far: usize::MAX }
    }

    /// One slot: `send[b]` is this slot's FOA send per band; adds the room to `ears`.
    pub fn process(&mut self, t: &Tuning, send: &[[C32; 4]], mid_far: bool, ears: &mut [[C32; BANDS]; 2]) {
        self.since_mid_far = if mid_far { 0 } else { self.since_mid_far.saturating_add(1) };
        if t.near_send_off && self.since_mid_far > t.room_hold {
            return;
        }
        let ring = self.ring;
        let at = |pos: usize, back: usize| (pos + ring - back) % ring;
        let p = self.pos;
        for (b, band) in self.bands.iter_mut().enumerate() {
            band.send[p] = send[b];
            // Late: mono W send through the diffusers
            let mut x = send[b][0].scale(std::f32::consts::FRAC_1_SQRT_2);
            for ap in band.allpass.iter_mut() {
                x = ap.process(x);
            }
            // tmp_c = in + sum_k G[4k + c] line_k(n - D_k); line_c = tmp_c * decay[b][c]
            let delayed: [C32; 4] = std::array::from_fn(|k| band.lines[k][at(p, t.fdn_delays[k])]);
            for c in 0..4 {
                let mut tmp = x;
                for (k, d) in delayed.iter().enumerate() {
                    tmp += d.scale(t.fdn_feedback[4 * k + c]);
                }
                band.lines[c][p] = tmp * C32::from(t.fdn_decay[b][c]);
            }
            // Bus: EQ'd line outputs, tapped later, plus the early reflections
            let mut bus: [C32; 4] =
                std::array::from_fn(|c| band.lines[c][at(p, t.fdn_tap)].scale(t.fdn_eq[b][c]));
            for (j, &d) in t.er_delays.iter().enumerate() {
                let s = band.send[at(p, d)];
                let h = C32::from(t.er_filters[j][b]);
                let m = &t.er_matrices[j];
                for c in 0..4 {
                    let mut acc = C32::ZERO;
                    for (k, sk) in s.iter().enumerate() {
                        acc += sk.scale(m[c * 4 + k]);
                    }
                    bus[c] += h * acc;
                }
            }
            for (k, x) in bus.iter().enumerate() {
                ears[0][b] += C32::from(t.decoder[b][k][0]) * *x;
                ears[1][b] += C32::from(t.decoder[b][k][1]) * *x;
            }
        }
        self.pos = (p + 1) % ring;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decays_and_keeps_running_after_the_hold() {
        let t = Tuning::load().unwrap();
        let mut room = Room::new(&t);
        let mut energy = Vec::new();
        for slot in 0..700 {
            let mut send = vec![[C32::ZERO; 4]; BANDS];
            if slot == 0 {
                for s in send.iter_mut() {
                    s[0] = C32::real(1.0);
                }
            }
            let mut ears = [[C32::ZERO; BANDS]; 2];
            room.process(&t, &send, slot == 0, &mut ears);
            energy.push(ears.iter().flatten().map(|c| c.norm2()).sum::<f32>());
        }
        // nothing before the first early reflection or line output
        assert_eq!(energy[0], 0.0);
        assert!(energy[1] > 0.0, "the FDN output is tapped one slot later");
        // decays: 200 ms later it is far quieter than in the first 30 ms
        let early: f32 = energy[1..23].iter().sum();
        let later: f32 = energy[150..172].iter().sum();
        assert!(later < early * 1e-2, "{later} vs {early}");
        // and keeps running past the hold (tag 60 = 0): the tail is still there, decaying
        assert!(energy[t.room_hold + 2] > 0.0);
        assert!(energy[t.room_hold + 2] < energy[t.room_hold - 50]);
    }

    #[test]
    fn interaural_coherence_of_the_tail_follows_the_decoder() {
        // The lowest band's decoder puts W (and X, Z) equally in both ears: high coherence.
        let t = Tuning::load().unwrap();
        let mut room = Room::new(&t);
        let (mut lr, mut ll, mut rr) = (0f32, 0f32, 0f32);
        for slot in 0..200 {
            let mut send = vec![[C32::ZERO; 4]; BANDS];
            if slot == 0 {
                send[0][0] = C32::real(1.0);
            }
            let mut ears = [[C32::ZERO; BANDS]; 2];
            room.process(&t, &send, true, &mut ears);
            let (l, r) = (ears[0][0], ears[1][0]);
            lr += (l * r.conj()).re;
            ll += l.norm2();
            rr += r.norm2();
        }
        let coh = lr / (ll * rr).sqrt();
        assert!(coh > 0.8, "{coh}");
    }
}
