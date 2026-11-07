//! Object state from OAMD (the same payload in TrueHD and E-AC-3 JOC): where each input is, its
//! gain and render mode, at any sample. Updates take effect at their sample position and move
//! linearly to the new values over the ramp they state.

use oamd::{ObjectAudioMetadataPayload, SpeakerLabels};

use crate::direct::{Mode, bed_position};

/// What an input is: a bed channel (Dolby channel ID), the LFE, or a dynamic object.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Bed(u32),
    Lfe,
    Object,
}

#[derive(Debug, Clone, Copy)]
struct Target {
    pos: [f32; 3],
    gain: f32,
}

#[derive(Debug, Clone)]
pub struct Input {
    pub kind: Kind,
    pub mode: Mode,
    pub active: bool,
    from: Target,
    to: Target,
    ramp_start: u64,
    ramp_len: u64,
}

impl Input {
    fn at(&self, sample: u64) -> Target {
        if self.ramp_len == 0 || sample >= self.ramp_start + self.ramp_len {
            return self.to;
        }
        if sample <= self.ramp_start {
            return self.from;
        }
        let a = (sample - self.ramp_start) as f32 / self.ramp_len as f32;
        let mix = |x: f32, y: f32| x + (y - x) * a;
        Target {
            pos: std::array::from_fn(|i| mix(self.from.pos[i], self.to.pos[i])),
            gain: mix(self.from.gain, self.to.gain),
        }
    }

    /// Position (Dolby x/y/z) and linear gain at `sample`.
    pub fn state(&self, sample: u64) -> ([f32; 3], f32) {
        let t = self.at(sample);
        (t.pos, if self.active { t.gain } else { 0.0 })
    }
}

/// Dolby channel ID of a bed speaker label; LFE labels map to None.
fn channel_id(label: SpeakerLabels) -> Option<u32> {
    use SpeakerLabels::*;
    Some(match label {
        L => 1,
        R => 2,
        C => 3,
        LFE | LFE2 => return None,
        Lss => 5,
        Rss => 6,
        Lrs => 7,
        Rrs => 8,
        Lfh => 9,
        Rfh => 10,
        Lts => 11,
        Rts => 12,
        Lrh => 13,
        Rrh => 14,
        Lw => 15,
        Rw => 16,
    })
}

#[derive(Default)]
pub struct Scene {
    pub inputs: Vec<Input>,
    /// Updates that start later than the sample they arrived at.
    pending: Vec<(u64, usize, Target, u64, bool, Mode)>,
}

fn db_to_gain(db: i8) -> f32 {
    if db == oamd::GAIN_MINUS_INFINITY { 0.0 } else { 10f32.powf(db as f32 / 20.0) }
}

impl Scene {
    /// Apply an OAMD payload that arrived with the access unit starting at `au_start`.
    pub fn update(&mut self, oamd: &ObjectAudioMetadataPayload, au_start: u64) {
        let count = oamd.object_count;
        let beds = oamd
            .program_assignment
            .bed_assignment
            .first()
            .map(|b| b.to_index_vec())
            .unwrap_or_default();
        // A 5.1 bed's surrounds (5/6 without 7/8) are rendered at the rear corners (7/8).
        let ids: Vec<Option<u32>> = beds
            .iter()
            .map(|&i| SpeakerLabels::from_u8(i as u8).and_then(channel_id))
            .collect();
        let has = |id| ids.contains(&Some(id));
        let retype = has(5) && has(6) && !has(7) && !has(8);
        if self.inputs.len() != count {
            self.inputs = (0..count)
                .map(|i| {
                    let kind = match beds.get(i) {
                        Some(_) => match ids[i] {
                            Some(id) => Kind::Bed(if retype && (id == 5 || id == 6) { id + 2 } else { id }),
                            None => Kind::Lfe,
                        },
                        None => Kind::Object,
                    };
                    let pos = match kind {
                        Kind::Bed(id) => bed_position(id).unwrap_or([0.5, 0.5, 0.0]),
                        _ => [0.5, 0.0, 0.0],
                    };
                    let t = Target { pos, gain: 1.0 };
                    Input { kind, mode: Mode::Mid, active: true, from: t, to: t, ramp_start: 0, ramp_len: 0 }
                })
                .collect();
        }
        let Some(element) = &oamd.object_element else { return };
        let info = &element.md_update_info;
        let hp = oamd.headphone_element.as_ref();
        let pos = oamd.get_damf_pos_raw();
        // All bed channels share the first bed element's headphone code.
        let first_bed = (0..count).find(|&i| i < beds.len());
        for (block, update) in info.block_update_info.iter().enumerate() {
            let start = au_start
                + info.sample_offset as u64
                + update.block_offset_factor_bits as u64 * 32
                + oamd.evo_sample_offset;
            let ramp = update.ramp_duration as u64;
            for i in 0..count {
                let Some(data) = element.object_data.get(i).and_then(|d| d.get(block)) else { continue };
                let gain = db_to_gain(data.object_basic_info.object_gain);
                let p = match self.inputs[i].kind {
                    Kind::Object => {
                        let raw = pos.get(i).and_then(|b| b.get(block)).copied().unwrap_or([0.5, 0.0, 0.0]);
                        [raw[0] as f32, raw[1] as f32, raw[2] as f32]
                    }
                    _ => self.inputs[i].to.pos,
                };
                let code_of = |o: usize| {
                    hp.and_then(|h| h.headphone_data.get(o)).and_then(|b| b.get(block).or(b.first()))
                        .map(|b| Mode::from_code(b.hp_render_mode))
                };
                let mode = match self.inputs[i].kind {
                    Kind::Object => code_of(i),
                    _ => first_bed.and_then(code_of),
                }
                .unwrap_or(Mode::Mid);
                self.pending.push((start, i, Target { pos: p, gain }, ramp, !data.b_object_not_active, mode));
            }
        }
        self.pending.sort_by_key(|p| p.0);
    }

    /// Start every update whose time has come by `sample`.
    pub fn advance(&mut self, sample: u64) {
        while let Some(&(start, i, target, ramp, active, mode)) = self.pending.first() {
            if start > sample {
                break;
            }
            self.pending.remove(0);
            let input = &mut self.inputs[i];
            input.from = input.at(start);
            input.to = target;
            input.ramp_start = start;
            input.ramp_len = ramp;
            input.active = active;
            input.mode = mode;
        }
    }
}

trait RawPos {
    /// Object positions per block in OAMD's own 0..1 coordinates (x left->right, y front->back,
    /// z up), extended precision included: what the renderer's warp takes.
    fn get_damf_pos_raw(&self) -> Vec<Vec<[f64; 3]>>;
}

impl RawPos for ObjectAudioMetadataPayload {
    fn get_damf_pos_raw(&self) -> Vec<Vec<[f64; 3]>> {
        // get_damf_pos maps x,y to -1..1 (DAMF); undo that for the 0..1 cube.
        self.get_damf_pos()
            .into_iter()
            .map(|blocks| {
                blocks.into_iter().map(|p| [p[0] / 2.0 + 0.5, 0.5 - p[1] / 2.0, p[2]]).collect()
            })
            .collect()
    }
}
