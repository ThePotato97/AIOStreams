/*
 * atmos-render's renderer through a plain C interface (src/wasm.rs, the browser build's own
 * interface): a session takes a TrueHD or E-AC-3/AC-3 elementary stream in chunks and gives back
 * stereo at 48 kHz, interleaved f32, rendered for headphones (binaural) or, after
 * ar_render_for_speakers, for two built-in speakers (Dolby Atmos for built-in speakers, DAP-VR
 * output mode 11). Output sample k is the stream's sample k: the renderer's latency is taken out.
 *
 * For E-AC-3 and AC-3, push the bitstream with ar_push, then FFmpeg's eac3/ac3 decode of the same
 * bytes with ar_push_pcm (decoder set up as atmos-render's loudness asks: with windows_loudness,
 * drc_scale 1, heavy_compr 1, target_level -31).
 *
 * Each push or finish replaces the output: read ar_output's frames before the next call.
 */
#ifndef ATMOS_RENDER_H
#define ATMOS_RENDER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct AtmosRenderSession AtmosRenderSession;

/* modes: 0 the stream's render modes, 1 every element Near (as Windows), 2 every element Far. */
AtmosRenderSession *ar_new(uint32_t modes);
AtmosRenderSession *ar_new_eac3(uint32_t modes, bool windows_loudness);
void ar_drop(AtmosRenderSession *session);

/* Before the first push, for a stream rendered for built-in speakers throughout. */
bool ar_render_for_speakers(AtmosRenderSession *session);

/* Each returns how many stereo frames ar_output now holds. */
size_t ar_push(AtmosRenderSession *session, const uint8_t *data, size_t len);
/* E-AC-3/AC-3: `len` floats, interleaved in FFmpeg's channel order for `mask`. */
size_t ar_push_pcm(AtmosRenderSession *session, const float *samples, size_t len,
                   size_t channels, uint32_t mask);
size_t ar_finish(AtmosRenderSession *session);
const float *ar_output(AtmosRenderSession *session);

#endif
