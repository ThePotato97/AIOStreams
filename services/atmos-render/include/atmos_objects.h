/*
 * atmos-render's Atmos objects for Windows' spatial audio (src/objects_api.rs): TrueHD and
 * E-AC-3 JOC decoded to the objects Windows' own DD+ decoder hands Dolby Atmos for Headphones.
 *
 * Blocks are ATMOS_OBJECTS_BLOCK samples of ATMOS_OBJECTS_CHANNELS planar float channels at the
 * stream's rate. Each channel is one spatial audio object for the block: static bed (its
 * AudioObjectType bit, channels 0-11 = E slots 0-11), dynamic (type 1, channel 12 + d = E slot
 * 19 + d, activated in this order), or unused (type 0, silent). The samples carry each element's
 * gain and no -3 dB headroom or clip (E applies those); positions are the stream's targets in
 * Windows' coordinates (E smooths them).
 */
#ifndef ATMOS_OBJECTS_H
#define ATMOS_OBJECTS_H

#include <stddef.h>
#include <stdint.h>

#define ATMOS_OBJECTS_CHANNELS 32
#define ATMOS_OBJECTS_BLOCK 256

#define ATMOS_OBJECTS_TRUEHD 0
/* E-AC-3 (and its JOC): push the bitstream, then FFmpeg's decode of the core with
 * atmos_objects_push_pcm (eac3 decoder with drc_scale 1, heavy_compr 1, target_level -31, as
 * Windows' decoder's RF mode). */
#define ATMOS_OBJECTS_EAC3 1

typedef struct AtmosObjects AtmosObjects;

typedef struct AtmosObject {
    uint32_t object_type; /* AudioObjectType: 0 unused, 1 dynamic, else a static bit */
    float x, y, z;        /* dynamic only: Windows' position */
    uint32_t active;      /* 0: inactive, its samples silent */
} AtmosObject;

AtmosObjects *atmos_objects_create(int32_t codec);
void atmos_objects_destroy(AtmosObjects *handle);
void atmos_objects_push(AtmosObjects *handle, const uint8_t *data, size_t size);
/* E-AC-3 only: interleaved floats, `channels` channels in FFmpeg's order for its mask. */
void atmos_objects_push_pcm(AtmosObjects *handle, uint32_t channels, uint32_t mask,
                            const float *samples, size_t frames);
void atmos_objects_end(AtmosObjects *handle);
/* 1: a block written (planes[ATMOS_OBJECTS_CHANNELS], each ATMOS_OBJECTS_BLOCK floats;
 * objects[ATMOS_OBJECTS_CHANNELS]; *start its first stream sample); 0: none ready. */
int32_t atmos_objects_receive(AtmosObjects *handle, float *const *planes,
                              AtmosObject *objects, uint64_t *start);

#endif
