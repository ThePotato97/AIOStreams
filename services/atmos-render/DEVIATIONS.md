# Where atmos-render departs from the traced engine

The reference is the traced DAP-VR 8.1.0 engine, its Atmos for Headphones tuning, Windows' encoder
(`DolbyHrtfEnc.dll`) and DD+ decoder (`DolbyDecMFT.dll`), and the Reference Player's OAMD parser
(`dlb_oamdi`): the `dolby-render-parameters.md` and `dolby-atmos-for-headphones.md` notes, through
their second question batch (§10). Everything the renderer does that isn't read from that trace is
listed here: what it does, why, and what would settle it. An entry is added or removed in the same
commit as the code it describes.

`--output speakers` renders for two built-in speakers instead (Dolby Atmos for built-in speakers,
`speaker_render.rs`): the speaker-path trace (`dolby-speaker-render.md`, `renderer.md`,
`virtualizer.md`, `postchain.md`, `profile.md`, 2026-11-08), DAP-VR output mode 11 with Dolby
Access's built-in-speaker settings (speaker angles 10/10/10, height filter off, the 8->2 matrix,
dynamic speaker optimization off) for a stereo endpoint. The speaker path's own entries are
under "Speaker path" below.

`--modes stream` (default) takes each element's render mode from the stream, as the Reference
Player does; `--modes windows` renders everything Near, as Windows does. `--modes far` renders
everything Far, which no Dolby product does: it's the listener's choice (the player's headphone mode
setting), with Far's traced tuning, otherwise as `stream`. Everything else is Atmos for Headphones'
chain in every mode, the Windows encoder's input headroom included.

## Not implemented

| # | What | Why | Settled by |
|---|---|---|---|
| 1 | DAP's post-processing: the volume leveler with volmax, IEQ, regulator, surround boost, dialogue enhancer, graphic EQ, media intelligence and the surround decoder. With all of it off the post chain is unity (Q1). **Object (Atmos) input:** both outputs match the Game profile's settings. The other headphone profiles add: Movie the leveler (amount 4) and with it volmax, +4 dB (64, the same in every headphone profile but applied only while the leveler is on: `v20 = leveler ? volmax : 0`, postchain.md §1); Music the leveler (amount 0) with volmax and IEQ; Dynamic the leveler (amount 4) with volmax, IEQ, media intelligence and the regulator; Custom the graphic EQ. The speaker profiles have the leveler off everywhere, so their volmax (144) is inactive; Movie adds the dialogue enhancer and surround boost, Music IEQ, Dynamic the dialogue enhancer, IEQ, media intelligence and regulator, Custom the dialogue enhancer, surround boost and graphic EQ. **Channel-based input** (TrueHD without Atmos, DD+ without JOC): Game, Movie, Dynamic and Custom also turn the surround decoder on, and in the Reference Player its gate needs no object stream (not stereo input), so it runs on 5.1 and 7.1 channel input too: for those no profile is matched exactly. | Only parameter values are traced, not the algorithms (surround boost is, except the dB reference of its level estimate, virtualizer.md §6). | Tracing them, if a profile with any of them on is wanted. |
| 2 | After Atmos for Headphones, Windows' playback resamples to the device's rate (E's 48 to 44.1 kHz on a 44.1 kHz device) and converts to int16 with dither. Neither is applied: they belong to one device's output path, and the listener's own device and OS apply theirs. Windows' engine limiter (0.985), which every Windows output device has, is applied. | Device-specific. | — |
| 3 | Sample rates other than 48 kHz. The renderer assumes 48 kHz; a 96 or 192 kHz TrueHD (non-Atmos 7.1 can be) would render at the wrong speed. | A gap of ours. | Resampling, or keeping such sources off the server path. To be fixed. |

## Assumed

| # | What | Why | Settled by |
|---|---|---|---|
| 4 | Decoder loudness (`loudness.rs`, §11). `--loudness reference` (default): the Reference Player's LINE mode, FFmpeg `drc_scale 1`, `heavy_compr 0`, `target_level -31` (exact), so dialogue sits at -31 dBFS in both formats; `--loudness windows`: DD+ as Windows' RF mode, through FFmpeg with `heavy_compr 1`, `target_level -31` and the RF offset as a per-frame factor. TrueHD: the Reference Player's dialnorm (DN - 31 dB) in both, no DRC. Approximations, all in windows loudness except (e) and (f): (a) RF frames with compr = 0 lose dynrng (Dolby uses dynrng + 11/6; FFmpeg applies compr's 0 dB); (b) the RF factor steps at frame boundaries on the PCM instead of per block before the inverse MDCT; (c) a 7.1 E-AC-3 stream's factor comes from the independent substream's compr, applied to every channel; (d) JOC streams are gained on the core before the upmix, where Windows gains the objects through a FIFO aligned to the JOC latency; (e) TrueHD dialnorm is applied at once, where Dolby smooths its target per access unit; (f) TrueHD channel presentations get no DRC (the element default, disabled; follow, in this machine's ini, would apply a flagged stream's DRC). | (a)-(d) need gains FFmpeg doesn't expose; (e), (f) not reproduced. | A decoder that exposes per-block gains, if the differences matter. |
| 5 | Atmos for Headphones' calibration boost is 0. | The Reference Player's is 0 [C]; A's default isn't read. | A's default. |
| 5a | The post chain's gain is 0.19962984: the trace's reading, taking `sub_18006A8E0` as floor (otherwise 0.19953), and the branch with leveler, IEQ, EQ and regulator off (flags +1936, +1976, +2016 and the EQ term taken as 0). | Both are the trace's own open items. | `sub_18006A8E0`; those flags at the defaults. |
| 6 | Smoothing (Q12): the one-pole's rounding (`sub_18006A8E0`) isn't reproduced (float). An update takes effect in the renderer block containing its sample. There's no interpolation within a block. ISF objects are smoothed like dynamic ones. An object flagged not active ramps to gain 0 through the smoothing. | The rounding, the SIMD kernel `sub_180042A10` and the landing block for A aren't decoded; Q7 says not-active sets the gain to 0 but not whether A's smoothing applies (R hard-cuts it sample-accurately). | Those functions. |
| 7 | JOC metadata of frame k applies to FFmpeg's decoded PCM of frame k (no decoder delay between them). | Not verified. | A JOC stream with a known object onset. |
| 8 | Object x and y are code/62. | Dolby maps the 6-bit codes through a table (62 -> 32767) whose entries aren't in the notes; code/62 matches it if it's linear. | The table. |
| 9 | Extended-precision position offsets (OA element 5) are added to object positions (the oamd crate). | Q11 doesn't say whether Dolby's parser applies them. | Element 5 in `dlb_oamdi`. |
| 10 | Channel-based input (TrueHD without Atmos, DD+ without JOC) follows the Windows encoder's static slots (`channels.rs`). Channels with no Windows slot: top side and wide channels at their Dolby bed IDs (11/12, 15/16); front left/right of centre (and TrueHD Lsc/Rsc) at x = 0.25/0.75 on the front wall; top centre, top front centre and top back centre on the ceiling at (0.5, 0.5), (0.5, 0) and (0.5, 1); TrueHD Lsd/Rsd as the sides. | Windows has no slot for them; the bed table has no ID for some. | How Windows' decoder and encoder place them. |
| 11 | In windows mode a 5.1 bed's or layout's surrounds render at the side slots (IDs 5/6, ±90°), with no retype. Stream mode retypes them to 7/8 (±135°), as Dolby's renderer does. | Windows never retypes (its bed always has 7/8) [C], but whether it maps 5.1 surrounds to Side or Back isn't decided in the traced binaries (Q10). | Where Windows' audio engine sends a 5.1 channel mask. |
| 12 | In windows mode, OAMD bed channels Windows has no static slot for (top sides, wides) render at their bed positions. | Windows' encoder has no slot for them; how its decoder passes them on isn't traced. | `PackMetaData` with such a bed. |
| 13 | ISF object positions are the Reference Player's table. | A's table differs by 1 LSB in 60 entries; those entries aren't listed. | A's table. |
| 14 | E-AC-3 downmix configs 3 and 4 (surround stage): channels 3 and 4's bands from 1 up are delayed 10 slots like every other band; the JOC matrices aren't delayed; the LFE and OAMD timing aren't delayed either, so those streams' objects come out 10 slots (13.3 ms) after them. | The notes say the other channels are delayed "to line up", not what else moves. A measurement on Leaf (config 3) couldn't tell the variants apart. | Whether `DolbyDecMFT.dll` delays the matrices, the LFE and the metadata for configs 3/4. |
| 15 | Steep JOC interpolation switches at slot offset + 1, for one or two data points. | The + 1 is Cavern's; Windows' trace gives the 5-bit offset's range (< 24, increasing), not how it's applied. | `joc_parse_info` / the matrix kernel. |

## Changed from the oamd crate (to match `dlb_oamdi`)

| # | What |
|---|---|
| 16 | The per-object headphone code's clamp to 0-2 is removed: 3 is Mid. |
| 17 | In `hp_mode` 3, ISF objects after the first read their own codes and discard them (the crate didn't read them, misaligning every later object's). |
| 18 | Only the first headphone element counts; one for an alternate object set is skipped. A block count other than the object element's fails the payload. |
| 19 | Object z uses Dolby's step, 2185 in Q15 (the crate's is 1/15, 0.02% smaller). |

## Changed from Cavern (E-AC-3 JOC)

| # | What | Why |
|---|---|---|
| 20 | Each frame's 24 interpolated matrices are computed from that frame's JOC payload and applied in order. Cavern's applier steps its timeslot against the input channel count (7), out of step with frames. | Follows the frame structure. |
| 21 | Smooth two-point interpolation maps parameter bands in both halves; Cavern maps only the second. Steep two-point applies the second matrix from its offset; Cavern never uses it. | Follows the format's logic. |
| 22 | The values follow Windows' decoder: clip gain 2^(x-4)(32+y)/512 on the time-domain downmix, ramped over 256 samples, with the object output x16 and clipped to ±1 (Cavern's gain agrees only when x = 4); dequantisation steps 0.2001953 and 0.1000977, wrapped in integers; at most 15 objects; JOC only on a 3/2 core; the surround stage for configs 3 and 4. Its Huffman trees, band tables and QMF prototype are identical to the ones here (checked). | Dolby's decoder is the reference. |
| 23 | The core is decoded by an FFmpeg child, not linked libavcodec and not Cavern's decoder (no AHT). | No dependency on one FFmpeg build's library ABI. |

## Behaviour around seeks

| # | What | Why |
|---|---|---|
| 24 | After a seek, inputs are silent until their first OAMD; TrueHD access units before the first major sync come out as silence. | Positions are unknown until then; silence keeps the timing. |

## Speaker path

| # | What | Why | Settled by |
|---|---|---|---|
| 25 | An object update takes effect in the block containing its sample, as on the headphone path; its gains then ramp linearly over 8 slots starting with that block's first slot. | The trace gives the ramp (renderer.md §10: ceil(480/64) slots, constant within a slot) and says gains are updated every slot; when E's 10 ms buffers' updates reach a slot, and whether a ramp's first step falls in its first slot, aren't. | The slot an update lands in, in A `sub_18004BAE0`. |
| 26 | OAMD zone masks aren't applied: every object pans over the whole 5.1.2 layout. | The zone masks are traced (`zone_masks.csv`), but their flag inputs a2[0..2] aren't (renderer.md §14 item 2), and the input doesn't read zone metadata yet. | The flags' meaning; reading zone control from OAMD. |
| 27 | Bed channels outside Windows' 0x33FF bed (top middles 11/12, wides 15/16) pan from their Dolby bed positions (wides at y = 5461/32768); Dolby's speaker table puts Lw/Rw at y = 5285/32768. | The trace maps bed IDs to the speaker table only for the 0x33FF channels. | `dword_1800FB5F0` for those IDs. |
| 28 | The mixer holds each gain constant within a slot. | A's SIMD mixer reads one gain vector per object (renderer.md §14 item 3); not confirmed for a ramp. | `sub_18004BFB0` during a ramp. |
| 29 | Only a stereo endpoint: Dolby Access's 8->2 matrix. | Other endpoint channel counts hit A's mode recalculation, which discards its own result (profile.md §7). | Not needed for built-in speakers. |
