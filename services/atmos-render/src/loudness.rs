//! Decoder loudness: DRC and dialnorm as Dolby's decoders apply them (parameters doc §11).
//!
//! DD+ / AC-3 (`ddp_compute_block_gain_drc_dialnorm`, identical in Windows' `DolbyDecMFT.dll` and the
//! Reference Player's `dlb_udclib.dll`): a word becomes gain as (1 + frac x) 2^floor x, with
//! x = compr / 16 or dynrng / 32, applied per 256-sample block to the MDCT coefficients; dialnorm
//! brings dialogue to -31 dBFS. FFmpeg's decoder does the same (same law, same place, dialnorm as
//! 2^((target - dialnorm) / 6) with dn = 0 as 31), so:
//! - Reference Player (LINE, cut/boost 100/100): FFmpeg `drc_scale 1`, `heavy_compr 0`,
//!   `target_level -31`. Exact.
//! - Windows (RF): FFmpeg `heavy_compr 1`, `target_level -31`, which uses compr where the frame
//!   carries it and dynrng otherwise, as RF does; then, on frames carrying compr, the RF offset
//!   (+11/6, inside the word) as the factor G(C/16 + 11/6) / G(C/16) per frame.
//!
//! TrueHD (Reference Player, `dlb_truehddec.dll`): dialnorm always, DN - 31 dB (DN = 0 as 31); no
//! DRC on the Atmos presentation (follow mode passes 0 as its DRC flag), and none here on channel
//! presentations either.

/// Whose decoder loudness to follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Loudness {
    /// Windows' DD+ decoder: RF mode. TrueHD as the Reference Player (Windows doesn't decode it).
    #[default]
    Windows,
    /// The Reference Player: DD+ in LINE mode, TrueHD with dialnorm and no DRC.
    Reference,
}

/// The RF offset added to the X.Y word: 11/6 as the code has it (16 x 0.11457825).
const RF_OFFSET: f64 = 16.0 * 0.11457825;

/// A DRC word's gain: (1 + frac x) 2^floor x.
pub fn word_gain(x: f64) -> f64 {
    let f = x.floor();
    (1.0 + (x - f)) * 2f64.powf(f)
}

/// FFmpeg's arguments for the AC-3 / E-AC-3 decoder.
pub fn ffmpeg_args(l: Loudness) -> [&'static str; 6] {
    match l {
        Loudness::Windows => ["-drc_scale", "1", "-heavy_compr", "1", "-target_level", "-31"],
        Loudness::Reference => ["-drc_scale", "1", "-heavy_compr", "0", "-target_level", "-31"],
    }
}

/// The factor taking FFmpeg's output (see the module notes) to Dolby's for one frame, from the
/// frame's compr word (None: compre = 0).
pub fn frame_factor(l: Loudness, compr: Option<i8>) -> f32 {
    match (l, compr) {
        (Loudness::Windows, Some(c)) => {
            let x = c as f64 / 16.0;
            // compr = 0: Dolby falls back to dynrng + 11/6; FFmpeg has applied compr's 0 dB and
            // ignored dynrng, so only the offset is added here [I: dynrng is lost].
            (word_gain(x + RF_OFFSET) / word_gain(x)) as f32
        }
        _ => 1.0,
    }
}

/// compr of an AC-3 or E-AC-3 frame's header (None when compre = 0 or the header is short).
pub fn frame_compr(frame: &[u8]) -> Option<i8> {
    let mut b = crate::bits::Bits::new(frame);
    b.pos = 16;
    let bsid = (*frame.get(5)? >> 3) as u32;
    if bsid <= 10 {
        // AC-3: crc1, fscod, frmsizecod, bsid, bsmod, acmod, mix levels, lfeon, dialnorm
        b.skip(16 + 2 + 6 + 5 + 3)?;
        let acmod = b.read(3)?;
        if acmod & 1 != 0 && acmod != 1 {
            b.skip(2)?;
        }
        if acmod & 4 != 0 {
            b.skip(2)?;
        }
        if acmod == 2 {
            b.skip(2)?;
        }
        b.skip(1 + 5)?;
    } else {
        // E-AC-3: strmtyp, substreamid, frmsiz, fscod, fscod2/numblkscod, acmod, lfeon, bsid,
        // dialnorm
        b.skip(2 + 3 + 11 + 2 + 2 + 3 + 1 + 5 + 5)?;
    }
    if b.bit()? { Some(b.read(8)? as u8 as i8) } else { None }
}

/// TrueHD dialnorm gain: DN - 31 dB, DN = 0 as 31.
pub fn truehd_dialnorm(dn: u8) -> f32 {
    let dn = if dn == 0 { 31 } else { dn.min(31) };
    10f32.powf((dn as f32 - 31.0) / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rf_offset_is_about_11_db_with_the_traced_ripple() {
        let db = |c: i8| 20.0 * (frame_factor(Loudness::Windows, Some(c)) as f64).log10();
        // compr = 0: +11.29 dB (the notes)
        assert!((db(0) - 11.29).abs() < 0.01, "{}", db(0));
        // every compr value within a 0.56 dB spread around 11.04 dB (2^(11/6)): -0.31..+0.25 here,
        // the notes' -0.24..+0.31 with the opposite sign
        let base = 20.0 * 2f64.powf(11.0 / 6.0).log10();
        for c in i8::MIN..=i8::MAX {
            let d = db(c) - base;
            assert!((-0.32..=0.25).contains(&d), "compr {c}: {d}");
        }
        assert_eq!(frame_factor(Loudness::Windows, None), 1.0);
        assert_eq!(frame_factor(Loudness::Reference, Some(40)), 1.0);
    }

    #[test]
    fn word_gain_is_a_linear_mantissa_with_6_db_steps() {
        assert_eq!(word_gain(0.0), 1.0);
        assert_eq!(word_gain(1.0), 2.0);
        assert_eq!(word_gain(-1.0), 0.5);
        assert_eq!(word_gain(0.5), 1.5);
    }

    #[test]
    fn truehd_dialnorm_brings_dialogue_to_minus_31() {
        assert_eq!(truehd_dialnorm(31), 1.0);
        assert_eq!(truehd_dialnorm(0), 1.0);
        assert!((20.0 * truehd_dialnorm(20).log10() + 11.0).abs() < 1e-4);
    }
}
