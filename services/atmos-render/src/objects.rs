//! Object state from OAMD (the same payload in TrueHD and E-AC-3 JOC), as Dolby's OAMD parser
//! (`dlb_oamdi`) and Atmos for Headphones read it: where each element is, its gain and render
//! mode, once per 256-sample renderer block. Dynamic and ISF objects are smoothed per block by
//! Atmos for Headphones' one-pole driven by `ramp_duration`; bed channels step.

use oamd::{ObjectAudioMetadataPayload, SpeakerLabels};

use crate::direct::{Mode, bed_position};
use crate::render::BLOCK;

/// Where render modes come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Modes {
    /// The stream's headphone element (Off/Near/Mid/Far as authored), Mid without one: the
    /// Reference Player.
    #[default]
    Stream,
    /// Every element Near, the stream's codes ignored: Windows, whose DD+ decoder drops the
    /// headphone element and whose encoder defaults every object to Near.
    Windows,
    /// Every element Far, the stream's codes ignored; otherwise as Stream (a 5.1 bed's surrounds
    /// retyped). No Dolby product renders this way: a listener's choice, with Far's traced tuning.
    Far,
}

impl Modes {
    /// Whether a 5.1 bed's surrounds render at the rear corners (7/8), as Dolby's renderer does;
    /// Windows' bed always has 7/8, so it never retypes.
    pub fn retypes(self) -> bool {
        self != Modes::Windows
    }
}

/// What an element is: a bed channel (Dolby channel ID), the LFE, or an object (dynamic, or
/// ISF at a fixed position).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Bed(u32),
    Lfe,
    Object,
    Isf,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Target {
    pos: [f32; 3],
    gain: f32,
}

#[derive(Debug, Clone, Copy)]
struct Update {
    /// Stream sample the update is stamped with.
    at: u64,
    index: usize,
    target: Target,
    ramp: u64,
    active: bool,
    mode: Mode,
}

#[derive(Debug, Clone)]
pub struct Input {
    pub kind: Kind,
    pub mode: Mode,
    pub active: bool,
    /// The smoothed state the renderer reads this block.
    cur: Target,
    target: Target,
    /// The update being ramped to: its sample and ramp duration.
    update_at: u64,
    ramp: u64,
    /// No ramp for the first update after the element count changed.
    fresh: bool,
    /// Nothing known yet: silent.
    known: bool,
}

impl Input {
    /// Position (Dolby x/y/z) and linear gain for the current block.
    pub fn state(&self) -> ([f32; 3], f32) {
        (self.cur.pos, if self.known { self.cur.gain } else { 0.0 })
    }

    pub fn is_active(&self) -> bool {
        self.known && self.active
    }
}

/// Atmos for Headphones' smoothing coefficient for one block (`sub_180025A80`, as
/// `scripts/a_ramp.py` ports it): `a5` is the update's sample relative to the block's start
/// (negative in the blocks after it), `ramp` its ramp duration.
pub fn ramp_coefficient(ramp: i64, a5: i64) -> f32 {
    let rem = (ramp - 255 + a5).max(0);
    let d = rem + a5 + 128;
    let v95 = if rem != 0 { rem + a5 } else { 0 };
    if v95 > 0 && a5 <= 255 {
        if d > 256 {
            256.0 / d as f32
        } else if a5 < 0 {
            1.0
        } else {
            0.0
        }
    } else {
        1.0
    }
}

/// Dolby channel ID of a bed bit (`hpv_bedmask_bit_to_channel_id`: bit i -> ID i + 1); LFE and
/// LFE2 go to the LFE path.
fn channel_id(bit: usize) -> Option<u32> {
    match SpeakerLabels::from_u8(bit as u8) {
        Some(SpeakerLabels::LFE) | Some(SpeakerLabels::LFE2) | None => None,
        Some(_) => Some(bit as u32 + 1),
    }
}

/// ISF object positions per `isf_idx` (types 5-10), Dolby x/y/z in Q15, from the Reference
/// Player's `hpv_bedconfig_channel_position` (`scripts/isf_angles.py`).
const ISF: [&[(i32, i32, i32)]; 6] = [
    &[(16384, 0, 0), (557, 20624, 0), (32210, 20624, 0), (16384, 16384, 32767)],
    &[(16384, 0, 0), (1785, 8945, 0), (3129, 26014, 0), (29638, 26014, 0), (30982, 8945, 0), (16384, 5419, 24349), (6891, 21866, 24349), (25876, 21866, 24349)],
    &[(16384, 0, 0), (4797, 4797, 0), (0, 16384, 0), (4797, 27970, 0), (27970, 27970, 0), (32767, 16384, 0), (27970, 4797, 0), (16384, 5419, 24349), (6891, 21866, 24349), (25876, 21866, 24349)],
    &[(16384, 0, 0), (6986, 2962, 0), (989, 10780, 0), (557, 20624, 0), (6986, 29805, 0), (25781, 29805, 0), (32210, 20624, 0), (31778, 10780, 0), (25781, 2962, 0), (16384, 5419, 24349), (5957, 12995, 24349), (9938, 25254, 24349), (22829, 25254, 24349), (26810, 12995, 24349)],
    &[(16384, 0, 0), (4797, 4797, 0), (0, 16384, 0), (4797, 27970, 0), (27970, 27970, 0), (32767, 16384, 0), (27970, 4797, 0), (16384, 5419, 24349), (5957, 12995, 24349), (9938, 25254, 24349), (22829, 25254, 24349), (26810, 12995, 24349), (16384, 5419, -24349), (5793, 19221, -24349), (26974, 19221, -24349)],
    &[(16384, 0, 0), (10511, 1087, 0), (5419, 4207, 0), (1785, 8945, 0), (88, 14670, 0), (557, 20624, 0), (3129, 26014, 0), (10511, 31680, 0), (22256, 31680, 0), (29638, 26014, 0), (32210, 20624, 0), (32679, 14670, 0), (30982, 8945, 0), (27348, 4207, 0), (22256, 1087, 0), (16384, 5419, 24349), (9335, 7985, 24349), (5586, 14480, 24349), (6891, 21866, 24349), (12635, 26686, 24349), (20132, 26686, 24349), (25876, 21866, 24349), (27181, 14480, 24349), (23432, 7985, 24349), (16384, 5419, -24349), (8631, 8631, -24349), (8631, 24136, -24349), (24136, 24136, -24349), (24136, 8631, -24349), (16384, 16384, 32767)],
];

fn isf_position(count: usize, i: usize) -> [f32; 3] {
    ISF.iter()
        .find(|t| t.len() == count)
        .and_then(|t| t.get(i))
        .map(|&(x, y, z)| [x as f32 / 32767.0, y as f32 / 32767.0, z as f32 / 32767.0])
        .unwrap_or([0.5, 0.5, 0.0])
}

fn db_to_gain(db: i8) -> f32 {
    if db == oamd::GAIN_MINUS_INFINITY { 0.0 } else { 10f32.powf(db as f32 / 20.0) }
}

#[derive(Default)]
pub struct Scene {
    pub modes: Modes,
    pub inputs: Vec<Input>,
    pending: Vec<Update>,
}

impl Scene {
    pub fn new(modes: Modes) -> Self {
        Self { modes, ..Default::default() }
    }

    /// Apply an OAMD payload that arrived with the access unit starting at `au_start`.
    pub fn update(&mut self, oamd: &ObjectAudioMetadataPayload, au_start: u64) {
        let count = oamd.object_count;
        let prog = &oamd.program_assignment;
        // Element order: bed channels (each instance's bits ascending), ISF objects, dynamic.
        let bed_bits: Vec<usize> = prog.bed_assignment.iter().flat_map(|b| b.to_index_vec()).collect();
        let ids: Vec<Option<u32>> = bed_bits.iter().map(|&b| channel_id(b)).collect();
        let has = |id| ids.contains(&Some(id));
        // A 5.1 bed's surrounds (5/6 without 7/8) render at the rear corners (7/8). On Windows
        // the bed always has 7/8 (the encoder's 7.1.4 bed), so it never happens there.
        let retype = self.modes.retypes() && has(5) && has(6) && !has(7) && !has(8);
        let isf = bed_bits.len()..bed_bits.len() + prog.num_isf_objects;
        if self.inputs.len() != count {
            self.inputs = (0..count)
                .map(|i| {
                    let (kind, pos) = if let Some(id) = ids.get(i) {
                        match *id {
                            Some(id) => {
                                let id = if retype && (id == 5 || id == 6) { id + 2 } else { id };
                                (Kind::Bed(id), bed_position(id).unwrap_or([0.5, 0.5, 0.0]))
                            }
                            None => (Kind::Lfe, [0.5, 0.5, 0.0]),
                        }
                    } else if isf.contains(&i) {
                        (Kind::Isf, isf_position(prog.num_isf_objects, i - isf.start))
                    } else {
                        // Dynamic objects default to the room centre.
                        (Kind::Object, [0.5, 0.5, 0.0])
                    };
                    let t = Target { pos, gain: 1.0 };
                    Input {
                        kind,
                        mode: Mode::Mid,
                        active: true,
                        cur: t,
                        target: t,
                        update_at: 0,
                        ramp: 0,
                        fresh: true,
                        known: false,
                    }
                })
                .collect();
            self.pending.clear();
        }
        let Some(element) = &oamd.object_element else { return };
        let info = &element.md_update_info;
        let hp = oamd.headphone_element.as_ref();
        let ext = oamd.extended_object_element.as_ref();
        for (block, update) in info.block_update_info.iter().enumerate() {
            let at = au_start
                + info.sample_offset as u64
                + update.block_offset_factor_bits as u64 * 32
                + oamd.evo_sample_offset;
            let ramp = update.ramp_duration as u64;
            for i in 0..count {
                let Some(data) = element.object_data.get(i).and_then(|d| d.get(block)) else { continue };
                let input = &self.inputs[i];
                let render = &data.object_render_info;
                let pos = match input.kind {
                    Kind::Object => {
                        // x, y: 6-bit codes over 62 (clamped by the parser); z: sign and a
                        // 4-bit magnitude in steps of 2185 (Q15). Elevation off: z = 0.
                        let mut p = [render.pos3d[0], render.pos3d[1], render.pos3d[2]];
                        p[2] = ((p[2] * 15.0).round() * 2185.0).clamp(-32767.0, 32767.0) / 32768.0;
                        if let Some(e) = ext.and_then(|e| e.ext_prec_pos_block.get(i)).and_then(|b| b.get(block)) {
                            p[0] += e.ext_prec_pos3d_x;
                            p[1] += e.ext_prec_pos3d_y;
                            p[2] += e.ext_prec_pos3d_z;
                        }
                        let z = if render.b_enable_elevation { p[2].clamp(-1.0, 1.0) } else { 0.0 };
                        [p[0].clamp(0.0, 1.0) as f32, p[1].clamp(0.0, 1.0) as f32, z as f32]
                    }
                    _ => input.target.pos,
                };
                let not_active = data.b_object_not_active;
                // Not active sets the gain to 0 (Q7).
                let gain = if not_active { 0.0 } else { db_to_gain(data.object_basic_info.object_gain) };
                let mode = match self.modes {
                    Modes::Windows => Mode::Near,
                    Modes::Far => Mode::Far,
                    // Each element its own code; ISF objects already carry the first ISF
                    // object's (the parser); Mid where the element says nothing.
                    Modes::Stream => hp
                        .and_then(|h| h.headphone_data.get(i))
                        .and_then(|b| b.get(block))
                        .map(|b| Mode::from_code(b.hp_render_mode))
                        .unwrap_or(Mode::Mid),
                };
                self.pending.push(Update { at, index: i, target: Target { pos, gain }, ramp, active: !not_active, mode });
            }
        }
        self.pending.sort_by_key(|u| u.at);
    }

    /// What each input is, in `sources` order.
    pub fn elements(&self) -> Vec<crate::input::Element> {
        use crate::input::Element;
        self.inputs
            .iter()
            .map(|i| match i.kind {
                Kind::Bed(id) => Element::Bed(id),
                Kind::Lfe => Element::Lfe,
                Kind::Object => Element::Object,
                Kind::Isf => Element::Isf,
            })
            .collect()
    }

    /// The renderer's sources for the current block (after `advance`).
    pub fn sources(&self) -> Vec<crate::render::Source> {
        use crate::render::Source;
        self.inputs
            .iter()
            .map(|i| {
                let (pos, gain) = i.state();
                match i.kind {
                    Kind::Lfe => Source::Lfe { gain },
                    _ => Source::Positioned { pos, mode: i.mode, gain, active: i.is_active() },
                }
            })
            .collect()
    }

    /// Bring every input to its state for the block starting at `start`: updates stamped within
    /// or before the block take effect, and each input moves toward its latest target by Atmos
    /// for Headphones' per-block coefficient (bed channels and the LFE step).
    pub fn advance(&mut self, start: u64) {
        let end = start + BLOCK as u64;
        while let Some(&u) = self.pending.first() {
            if u.at >= end {
                break;
            }
            self.pending.remove(0);
            let input = &mut self.inputs[u.index];
            input.target = u.target;
            input.update_at = u.at;
            input.ramp = u.ramp;
            input.active = u.active;
            input.mode = u.mode;
            if !input.known {
                input.known = true;
                input.cur = u.target;
            }
        }
        for input in self.inputs.iter_mut() {
            if !input.known {
                continue;
            }
            let smoothed = matches!(input.kind, Kind::Object | Kind::Isf);
            let c = if !smoothed || input.fresh {
                1.0
            } else {
                ramp_coefficient(input.ramp as i64, input.update_at as i64 - start as i64)
            };
            if input.update_at < end {
                input.fresh = false;
            }
            let mix = |a: f32, b: f32| a + c * (b - a);
            input.cur = Target {
                pos: std::array::from_fn(|k| mix(input.cur.pos[k], input.target.pos[k])),
                gain: mix(input.cur.gain, input.target.gain),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ramp_coefficients_follow_the_traced_table() {
        // a_ramp.py: one update at a5 = 0
        let seq = |ramp: i64| (0..5).map(|b| ramp_coefficient(ramp, -256 * b)).collect::<Vec<_>>();
        let close = |a: &[f32], b: &[f32]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 2e-3);
        assert!(close(&seq(0)[..1], &[1.0]));
        assert!(close(&seq(300)[..2], &[0.0, 1.0]));
        assert!(close(&seq(480)[..2], &[0.725, 1.0]));
        assert!(close(&seq(1024)[..3], &[0.285, 0.665, 1.0]));
        assert!(close(&seq(2048), &[0.133, 0.182, 0.285, 0.665, 1.0]));
    }

    #[test]
    fn isf_tables_have_the_traced_counts() {
        let counts: Vec<usize> = ISF.iter().map(|t| t.len()).collect();
        assert_eq!(counts, oamd::ISF_COUNT_LIST[..6]);
    }
}
