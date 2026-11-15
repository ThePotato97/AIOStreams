// FFmpeg's decoders for atmos-render's packages (src/package.rs): decodes one packet to interleaved
// float PCM in FFmpeg's channel order, as the native renderer's FFmpeg child does.
// - codec 0: AC-3 / E-AC-3, with the Reference Player's loudness (loudness.rs: drc_scale 1,
//   heavy_compr 0, target_level -31);
// - codec 1: DTS (and its DTS-HD extensions), with FFmpeg's defaults.
// Built with the WebGPU player's own FFmpeg recipe (build.sh); FFmpeg is LGPL-2.1-or-later.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/dict.h>
#include <libavutil/samplefmt.h>

typedef struct FfCore {
    AVCodecContext *context;
    AVPacket *packet;
    AVFrame *frame;
    float *pcm;
    size_t capacity;
    size_t frames;
    int channels;
    uint32_t mask;
    int sample_rate;
} FfCore;

FfCore *ffcore_new(int which) {
    const AVCodec *codec = avcodec_find_decoder(which == 0 ? AV_CODEC_ID_EAC3 : AV_CODEC_ID_DTS);
    if (!codec) return NULL;
    FfCore *core = calloc(1, sizeof *core);
    if (!core) return NULL;
    core->context = avcodec_alloc_context3(codec);
    core->packet = av_packet_alloc();
    core->frame = av_frame_alloc();
    AVDictionary *options = NULL;
    if (which == 0) {
        av_dict_set(&options, "drc_scale", "1", 0);
        av_dict_set(&options, "heavy_compr", "0", 0);
        av_dict_set(&options, "target_level", "-31", 0);
    }
    int opened = core->context && core->packet && core->frame ? avcodec_open2(core->context, codec, &options) : -1;
    // Every option must have been taken: a leftover one is an option this decoder doesn't know.
    int leftover = av_dict_count(options);
    av_dict_free(&options);
    if (opened < 0 || leftover) {
        avcodec_free_context(&core->context);
        av_packet_free(&core->packet);
        av_frame_free(&core->frame);
        free(core);
        return NULL;
    }
    return core;
}

void ffcore_free(FfCore *core) {
    if (!core) return;
    avcodec_free_context(&core->context);
    av_packet_free(&core->packet);
    av_frame_free(&core->frame);
    free(core->pcm);
    free(core);
}

static int append(FfCore *core, const AVFrame *frame) {
    int channels = frame->ch_layout.nb_channels;
    uint32_t mask = frame->ch_layout.order == AV_CHANNEL_ORDER_NATIVE ? (uint32_t)frame->ch_layout.u.mask : 0;
    if (core->frames && (channels != core->channels || mask != core->mask)) return -1; // one layout per packet
    core->channels = channels;
    core->mask = mask;
    core->sample_rate = frame->sample_rate;
    size_t need = (core->frames + (size_t)frame->nb_samples) * (size_t)channels;
    if (need > core->capacity) {
        float *grown = realloc(core->pcm, need * sizeof *grown);
        if (!grown) return -1;
        core->pcm = grown;
        core->capacity = need;
    }
    float *out = core->pcm + core->frames * (size_t)channels;
    if (frame->format == AV_SAMPLE_FMT_FLTP) {
        for (int s = 0; s < frame->nb_samples; s++)
            for (int c = 0; c < channels; c++)
                *out++ = ((const float *)frame->extended_data[c])[s];
    } else if (frame->format == AV_SAMPLE_FMT_FLT) {
        memcpy(out, frame->extended_data[0], (size_t)frame->nb_samples * (size_t)channels * sizeof *out);
    } else {
        return -1;
    }
    core->frames += (size_t)frame->nb_samples;
    return 0;
}

// Decodes one packet; returns the frames now held (ffcore_pcm), or -1. A packet FFmpeg rejects decodes to none.
int ffcore_decode(FfCore *core, const uint8_t *data, int size) {
    core->frames = 0;
    core->packet->data = (uint8_t *)data;
    core->packet->size = size;
    int sent = avcodec_send_packet(core->context, core->packet);
    if (sent < 0) return 0;
    for (;;) {
        int received = avcodec_receive_frame(core->context, core->frame);
        if (received == AVERROR(EAGAIN) || received == AVERROR_EOF) break;
        if (received < 0) return -1;
        int appended = append(core, core->frame);
        av_frame_unref(core->frame);
        if (appended < 0) return -1;
    }
    return (int)core->frames;
}

const float *ffcore_pcm(const FfCore *core) { return core->pcm; }
int ffcore_channels(const FfCore *core) { return core->channels; }
uint32_t ffcore_mask(const FfCore *core) { return core->mask; }
int ffcore_sample_rate(const FfCore *core) { return core->sample_rate; }

// Rust's std links getcwd (its process and env code, which the package never runs). Emscripten would import
// it from JavaScript, which a package may not, so the module defines it: no working directory.
int __syscall_getcwd(intptr_t buf, size_t size) {
    (void)buf;
    (void)size;
    return -52; // ENOSYS
}
