//! Channel-based input (TrueHD without Atmos, E-AC-3 without JOC), placed as the Windows encoder
//! (`DolbyHrtfEnc.dll`) places its static slots: FL..TopBR as bed channel IDs (Q10), and its five
//! extra statics, the bottoms and back centre, as positioned objects (Q8). Channels Windows has no
//! static slot for are marked [I] where they're placed.

use crate::direct::{Mode, bed_position};
use crate::objects::Modes;
use crate::render::Source;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Static {
    Bed(u32),
    Lfe,
    /// A positioned object, Dolby x/y/z.
    At([f32; 3]),
}

/// Back centre, slot 16: (0.5, 1, 0).
const BACK_CENTRE: [f32; 3] = [0.5, 1.0, 0.0];
/// Bottoms, slots 12-15, out of the encoder's box clamp: z = -0.70711.
pub const BOTTOMS: [[f32; 3]; 4] = [[0.0, 0.0, -0.70711], [1.0, 0.0, -0.70711], [0.0, 1.0, -0.70711], [1.0, 1.0, -0.70711]];
/// Top centre, top front centre and top back centre: no Windows slot; on the ceiling at their
/// labels' places [I].
const TOP_CENTRE: [f32; 3] = [0.5, 0.5, 1.0];
const TOP_FRONT_CENTRE: [f32; 3] = [0.5, 0.0, 1.0];
const TOP_BACK_CENTRE: [f32; 3] = [0.5, 1.0, 1.0];

/// WAV channel mask bits (FFmpeg's output), in channel order.
pub const WAV: [(u32, Static); 18] = [
    (0x1, Static::Bed(1)),               // front left
    (0x2, Static::Bed(2)),               // front right
    (0x4, Static::Bed(3)),               // front centre
    (0x8, Static::Lfe),                  // LFE
    (0x10, Static::Bed(7)),              // back left
    (0x20, Static::Bed(8)),              // back right
    (0x40, Static::At([0.25, 0.0, 0.0])), // front left of centre: no Windows slot, halfway [I]
    (0x80, Static::At([0.75, 0.0, 0.0])), // front right of centre: as above [I]
    (0x100, Static::At(BACK_CENTRE)),    // back centre
    (0x200, Static::Bed(5)),             // side left
    (0x400, Static::Bed(6)),             // side right
    (0x800, Static::At(TOP_CENTRE)),     // top centre [I]
    (0x1000, Static::Bed(9)),            // top front left
    (0x2000, Static::At(TOP_FRONT_CENTRE)), // top front centre [I]
    (0x4000, Static::Bed(10)),           // top front right
    (0x8000, Static::Bed(13)),           // top back left
    (0x10000, Static::At(TOP_BACK_CENTRE)), // top back centre [I]
    (0x20000, Static::Bed(14)),          // top back right
];

/// The statics of a WAV channel mask, in channel order. Bits above the table's are ignored,
/// so `channels` may exceed what this returns.
pub fn wav_mask(mask: u32) -> Vec<Static> {
    WAV.iter().filter(|(b, _)| mask & b != 0).map(|&(_, s)| s).collect()
}

/// A 5.1 layout's surrounds (side, without backs) at the rear corners, as Dolby's bed retype
/// does, in stream mode. Windows' bed always has its backs, so it never retypes [Q10]; whether
/// Windows maps 5.1 surrounds to its side or back slots isn't known.
pub fn retyped(statics: Vec<Static>, modes: Modes) -> Vec<Static> {
    let has = |id| statics.contains(&Static::Bed(id));
    if modes == Modes::Stream && has(5) && has(6) && !has(7) && !has(8) {
        statics
            .into_iter()
            .map(|s| match s {
                Static::Bed(id @ (5 | 6)) => Static::Bed(id + 2),
                s => s,
            })
            .collect()
    } else {
        statics
    }
}

/// The renderer source of a static at unity gain. Windows renders every static Near; the stream
/// carries no headphone element for channel-based audio, so stream mode renders it Mid.
pub fn source(s: Static, modes: Modes) -> Source {
    let mode = match modes {
        Modes::Windows => Mode::Near,
        Modes::Stream => Mode::Mid,
    };
    match s {
        Static::Lfe => Source::Lfe { gain: 1.0 },
        Static::Bed(id) => Source::Positioned { pos: bed_position(id).unwrap(), mode, gain: 1.0, active: true },
        Static::At(pos) => Source::Positioned { pos, mode, gain: 1.0, active: true },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_bits_keep_channel_order_and_cover_every_bit() {
        // 7.1 (side + back): FL FR FC LFE BL BR SL SR
        assert_eq!(
            wav_mask(0x63F),
            vec![Static::Bed(1), Static::Bed(2), Static::Bed(3), Static::Lfe, Static::Bed(7), Static::Bed(8), Static::Bed(5), Static::Bed(6)]
        );
        // every bit up to top back right is in the table, in order
        assert!(WAV.windows(2).all(|w| w[1].0 == w[0].0 << 1));
        assert_eq!(wav_mask(0x3FFFF).len(), 18);
    }
}
