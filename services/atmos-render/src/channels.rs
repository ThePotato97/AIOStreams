//! Channel-based input (TrueHD without Atmos, E-AC-3 without JOC), placed as the Windows encoder
//! (`DolbyHrtfEnc.dll`) places its static slots: FL..TopBR as bed channel IDs (Q10), and its five
//! extra statics, the bottoms and back centre, as positioned objects (Q8). Channels Windows has no
//! static slot for are marked [I] where they're placed.

use crate::direct::{Mode, bed_position};
use crate::objects::Modes;
use crate::render::{BED_RAMP, Source};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Static {
    Bed(u32),
    Lfe,
    /// A positioned object, Dolby x/y/z.
    At([f32; 3]),
    /// One of E's two stereo-bypass objects (0 left, 1 right), which A takes as bypass inputs.
    Bypass(usize),
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
/// does, in stream mode. Windows' bed always has its backs, so it never retypes [Q10]; Virtual
/// Surround places 5.1 surrounds by the stream's mask (side or back bits), as `wav_mask` and the
/// TrueHD labels already do (section 10).
/// `speakers`: rendering for built-in speakers, whose renderer doesn't retype.
pub fn retyped(statics: Vec<Static>, modes: Modes, speakers: bool) -> Vec<Static> {
    let has = |id| statics.contains(&Static::Bed(id));
    if !speakers && modes.retypes() && has(5) && has(6) && !has(7) && !has(8) {
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

/// How Windows routes a channel stream (parameters doc section 10), in Windows mode on headphones
/// and always on built-in speakers (a render only Windows has):
/// - a stream that opens no more channels than the 2-channel endpoint mix doesn't qualify for
///   Virtual Surround, so it's mixed into the device pipe's stereo bed; E's `MixChannelBed` /
///   `FoldDownAndMixChannelBed` (E 0x1800076E8 / 0x180007930) put FL and FR straight into its two
///   stereo-bypass objects (index log2(type) - 1 < 2 selects the object itself), and A takes
///   slots 17/18 as bypass inputs (`ConfigureEncoder` list {17, 18}, `dapvr_prepare_impl`), never
///   the Off pan;
/// - anything wider with a mappable mask goes to Virtual Surround, one static per channel at its
///   slot (5.1 surrounds by the mask: back bits at +-135 degrees, side bits at +-90), Near, LFE
///   kept, never retyped: the statics as they are.
///
/// Mono, and layouts with FLC/FRC/TC/TFC/TBC, don't qualify either; Windows' audio engine converts
/// them to the stereo device format with coefficients that aren't traced, so they stay per channel
/// (DEVIATIONS.md 10c).
pub fn routed(statics: Vec<Static>, modes: Modes, speakers: bool) -> Vec<Static> {
    let statics = retyped(statics, modes, speakers);
    if (speakers || modes == Modes::Windows) && statics == [Static::Bed(1), Static::Bed(2)] {
        vec![Static::Bypass(0), Static::Bypass(1)]
    } else {
        statics
    }
}

/// What a static input is, for the debug view.
pub fn element(s: Static) -> crate::input::Element {
    use crate::input::Element;
    match s {
        Static::Bed(id) => Element::Bed(id),
        Static::Lfe => Element::Lfe,
        Static::At(_) => Element::Object,
        Static::Bypass(side) => Element::Bypass(side),
    }
}

/// The renderer source of a static at unity gain. Windows renders every static Near; the stream
/// carries no headphone element for channel-based audio, so stream mode renders it Mid.
/// The stereo bypass at unity: ASAR's bed volume is 1.0 (AudioEng 0x1800FA429), the fold takes FL
/// and FR at 1.0 and the bypass objects' +196 is always 1.0; it gets neither the -3 dB nor the clip
/// (`Feed::bypassed`; stereo_bypass.md section 1).
pub fn source(s: Static, modes: Modes) -> Source {
    let mode = match modes {
        Modes::Windows => Mode::Near,
        Modes::Far => Mode::Far,
        Modes::Stream => Mode::Mid,
    };
    match s {
        Static::Lfe => Source::Lfe { gain: 1.0 },
        Static::Bed(id) => Source::Positioned { pos: bed_position(id).unwrap(), mode, gain: 1.0, active: true, ramp: BED_RAMP, zone: 0 },
        Static::At(pos) => Source::Positioned { pos, mode, gain: 1.0, active: true, ramp: BED_RAMP, zone: 0 },
        Static::Bypass(side) => Source::Bypass { side, gain: 1.0 },
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_headphone_renderer_retypes_a_5_1_beds_surrounds() {
        use super::{Modes, Static, retyped};
        let five_one = || vec![Static::Bed(1), Static::Bed(2), Static::Bed(3), Static::Lfe, Static::Bed(5), Static::Bed(6)];
        let surrounds = |s: Vec<Static>| (s[4], s[5]);
        assert_eq!(surrounds(retyped(five_one(), Modes::Stream, false)), (Static::Bed(7), Static::Bed(8)));
        // the speaker renderer maps Ls/Rs directly (renderer.md 9.1)
        assert_eq!(surrounds(retyped(five_one(), Modes::Stream, true)), (Static::Bed(5), Static::Bed(6)));
    }

    #[test]
    fn every_channel_renders_in_the_chosen_mode() {
        use crate::direct::Mode;
        let mode = |modes| match super::source(super::Static::Bed(1), modes) {
            super::Source::Positioned { mode, .. } => mode,
            _ => unreachable!(),
        };
        assert_eq!(mode(super::Modes::Stream), Mode::Mid);
        assert_eq!(mode(super::Modes::Windows), Mode::Near);
        assert_eq!(mode(super::Modes::Far), Mode::Far);
        // Far keeps Dolby's 5.1 retype; Windows doesn't
        assert!(super::Modes::Far.retypes() && !super::Modes::Windows.retypes());
    }

    use super::*;

    #[test]
    fn stereo_takes_the_bypass_on_windows_and_on_speakers() {
        let stereo = || wav_mask(0x3);
        let bypass = vec![Static::Bypass(0), Static::Bypass(1)];
        assert_eq!(routed(stereo(), Modes::Windows, false), bypass);
        assert_eq!(routed(stereo(), Modes::Stream, true), bypass);
        // the Reference Player and Far render it as two beds
        assert_eq!(routed(stereo(), Modes::Stream, false), stereo());
        assert_eq!(routed(stereo(), Modes::Far, false), stereo());
        assert!(matches!(source(Static::Bypass(1), Modes::Windows), Source::Bypass { side: 1, .. }));
    }

    #[test]
    fn wider_streams_keep_one_static_per_channel_by_their_mask() {
        for speakers in [false, true] {
            // 2.1 and 3.0 open more channels than the mix: Virtual Surround, LFE kept
            assert_eq!(routed(wav_mask(0xB), Modes::Windows, speakers), vec![Static::Bed(1), Static::Bed(2), Static::Lfe]);
            assert_eq!(routed(wav_mask(0x7), Modes::Windows, speakers), vec![Static::Bed(1), Static::Bed(2), Static::Bed(3)]);
            // 5.1 back (0x3F) at +-135 degrees, 5.1 side (0x60F) at +-90, never retyped
            let five_one = |s: Vec<Static>| (s[4], s[5]);
            assert_eq!(five_one(routed(wav_mask(0x3F), Modes::Windows, speakers)), (Static::Bed(7), Static::Bed(8)));
            assert_eq!(five_one(routed(wav_mask(0x60F), Modes::Windows, speakers)), (Static::Bed(5), Static::Bed(6)));
            // 7.1 as it is
            assert_eq!(routed(wav_mask(0x63F), Modes::Windows, speakers), wav_mask(0x63F));
        }
    }

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
