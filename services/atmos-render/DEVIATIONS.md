# Where atmos-render departs from the traced engine

The reference is the traced DAP-VR 8.1.0 engine and its Atmos for Headphones tuning (the
`dolby-render-parameters.md` and `dolby-atmos-for-headphones.md` notes). Everything the renderer
does that is not read from that trace is listed here: what it does, why, and what would settle it.
An entry is added in the same commit as the code it describes.

## Not implemented

| # | What | Why | Settled by |
|---|---|---|---|
| 1 | DAP post-processing (leveler, IEQ, regulator, surround boost, ...). Output matches a profile with all of it off (Game). | Only parameter values are traced, not the algorithms. | Tracing the leveler and the surround-boost path, if a profile other than none is wanted. |
| 2 | The AIDE path (objects rendered to 7.1.4 by OAR, then as a bed). Objects are always rendered at their own positions. | When AIDE is active is unknown. | Tracing what enables AIDE in `DolbyHrtfEnc.dll`. |
| 3 | OAMD zone constraints, snap, screen and depth factors. Ignored. Object size is ignored as the notes say. | Not covered by the trace. | Whether the headphone renderer reads them. |
| 4 | No limiter; output can exceed full scale (the LFE's +10 dB on a full-scale test signal does). | The regulator is off in the traced headphone profiles except Dynamic. | Only needed if a profile with the regulator is matched. |
| 18 | Sample rates other than 48 kHz. The renderer assumes 48 kHz throughout; a 96 or 192 kHz TrueHD (non-Atmos 7.1 can be) would render at the wrong speed. | A gap of ours, not a trace question. | Resampling to 48 kHz, or keeping such sources off the server path. To be fixed. |
| 19 | DRC and dialnorm are inconsistent between inputs. E-AC-3: FFmpeg's decoder applies the stream's DRC at its default `drc_scale` 1. TrueHD: the truehd crate applies none. Dialnorm is applied by neither. | Undecided. | What Windows' Dolby decoding applies (trace), or a decision; the proposal is DRC off for both, dialnorm unapplied. |

## Assumed

| # | What | Why | Settled by |
|---|---|---|---|
| 5 | Absolute level: the engine's common x8 is dropped and the filterbank reconstructs at unity. Relative levels are as traced. | The x8 presumably offsets a fixed-point scaling elsewhere; where is not traced. | Tracing the input/output scaling around `dap_vr_process`. |
| 6 | Inside r0, the omni term's weight is 0.707 (`direct.rs`). | From the notes' wording ("fade toward an omni term (k = 0, x0.707)"), not code. | The weights in `sub_18003E550`. |
| 7 | Off-mode pan uses the Reference Player's formula with Atmos for Headphones' mode-0 values. | Confirmed only in the Reference Player (the notes say so). | The pan in Atmos for Headphones. |
| 8 | Whole-payload headphone modes (`hp_mode` 0-2): the oamd crate's reading (0 = every object Off, 1/2 = that mode). Per-object codes (`hp_mode` 3) pass through 0-3 (vendored crate, clamp removed). | The element-level semantics are not in the trace. | `hpv_meta_hp_render_mode_headtrack`. |
| 9 | Channels outside Dolby's bed table (TrueHD Cb, Tc, Tfc, Lsc/Rsc, Lsd/Rsd; WAV back centre and top channels) take the nearest table position. | Not in the bed table; the notes infer the extra statics render as positioned objects. | The positions the encoder gives its 5 extra statics. |
| 10 | Positions and gains update per 256-sample block, from OAMD's own ramps, with no further smoothing. | The notes saw no filter crossfade. | — |
| 11 | JOC metadata of frame k applies to FFmpeg's decoded PCM of frame k (no decoder delay between them). | Not verified. | A JOC stream with a known object onset. |
| 20 | Stream bed labels map to Dolby channel IDs as L 1, R 2, C 3, Lss/Rss 5/6, Lrs/Rrs 7/8, Lfh/Rfh 9/10, Lts/Rts 11/12, Lrh/Rrh 13/14, Lw/Rw 15/16; LFE/LFE2 go to the LFE path (`objects.rs`). | Our own mapping. | `hpv_bedconfig_channel_position` (the second, undecoded bed table). |
| 21 | The 5.1 surround retype (5/6 rendered at 7/8 when the bed has no 7/8) is applied in Atmos for Headphones too. | Traced only in the Reference Player (`sub_18001D370`). | The same check in Atmos for Headphones. |
| 22 | Object positions: x and y are clamped to 0..1 and z to -1..1 (the oamd crate), with no other scaling before the warp. `b_enable_elevation` is ignored (z is used as sent). Negative z goes into the warp as is, i.e. below ear level. | Not covered by the trace. | Whether the encoder side scales or clamps; what the engine does with elevation off and with z < 0. |
| 23 | Ramps: gain and position both move linearly (position linearly inside the cube) over `ramp_duration` samples, starting at the update's own sample (sample offset + block offset x 32 + evo offset). The renderer reads the state at the first sample of each 256-sample block. An object flagged not active goes silent at once, without a ramp. | The notes saw no crossfade but do not give the ramp shape or which block an update lands in. | Gain/position ramp handling in the engine. |
| 24 | The LFE gets the same -3 dB input headroom as every other input. | The notes say "presumably included". | The LFE path's gain chain. |
| 25 | When the 263-slot room hold runs out, the room's state (allpass, FDN, early reflections) is cleared, not just muted. | Not covered by the trace. | Whether the engine clears or only stops the output. |
| 26 | The ITD phase on the conjugated hybrid image bands (1 and 3) is the same phase as their neighbours, not its conjugate. | Not covered by the trace. | `hpv_itd_phase_ramp` on those bands. |
| 27 | The JOC decode (dequantisation, interpolation, the 640-tap QMF prototype) is a port of Cavern's, not checked against Dolby's own JOC decoder. | No trace of Dolby's decoder. | Optional: tracing Dolby's JOC decoder. |

## Changed from the trace

| # | What | Why | Settled by |
|---|---|---|---|
| 12 | ITD phase applied as e^(+j w_b tau) (w_b < 0). The notes give e^(-j w_b tau). | Through the traced filterbank the notes' sign puts the farther ear 31 samples early at the side corner (test in `render.rs`). | The sign in `hpv_itd_phase_ramp`. |
| 13 | The oamd crate's clamp of the per-object headphone code to 0-2 is removed, so Mid (3) is not read as Far (2). | The trace has a 2-bit code, 3 = Mid. | — |

## Changed from Cavern (E-AC-3 JOC)

| # | What | Why |
|---|---|---|
| 14 | Each frame's 24 interpolated matrices are computed from that frame's JOC payload and applied in order. Cavern's applier steps its timeslot against the input channel count (7), out of step with frames. | Follows the frame structure. |
| 15 | Steep slope with two data points applies the second one from its offset; Cavern never uses it. Smooth two-point interpolation maps parameter bands in both halves; Cavern maps only the second. | Follows the format's logic. |
| 16 | The core is decoded by an FFmpeg child, not linked libavcodec and not Cavern's decoder (no AHT). | No dependency on one FFmpeg build's library ABI. |

## Behaviour around seeks

| # | What | Why |
|---|---|---|
| 17 | After a seek, inputs are silent until their first OAMD; TrueHD access units before the first major sync come out as silence. | Positions are unknown until then; silence keeps the timing. |
