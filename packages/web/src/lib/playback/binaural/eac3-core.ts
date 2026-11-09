/*
 * The decoders for binaural rendering in the browser: FFmpeg's, built as libav.js
 * (scripts/build-libav-eac3.sh). E-AC-3 and AC-3 are set up as the transcoder's renderer sets up
 * its FFmpeg child for the Reference Player's loudness (atmos-render's loudness.rs: LINE mode,
 * dialogue at -31 dBFS); DTS with FFmpeg's defaults, as the renderer's child decodes it
 * (decoded_in.rs). Runs in the binaural worker, synchronously (libav.js in "direct" mode).
 */

/** The part of a libav.js instance (direct mode, `_sync` calls) used here. */
export interface LibAVSync {
  avcodec_find_decoder_by_name_sync(name: string): number;
  avcodec_alloc_context3_sync(codec: number): number;
  av_opt_set_sync(
    obj: number,
    name: string,
    value: string,
    flags: number
  ): number;
  avcodec_open2_sync(ctx: number, codec: number, options: number): number;
  av_packet_alloc_sync(): number;
  av_frame_alloc_sync(): number;
  ff_decode_multi_sync(
    ctx: number,
    pkt: number,
    frame: number,
    packets: { data: Uint8Array }[],
    config?: boolean | { fin?: boolean; ignoreErrors?: boolean }
  ): {
    /** Per channel for planar formats: floats, or integers for DTS-HD's lossless output. */
    data: (Float32Array | Int32Array | Int16Array)[];
    channels?: number;
    channel_layout?: number;
    nb_samples: number;
    format: number;
  }[];
  ff_free_decoder_sync(ctx: number, pkt: number, frame: number): void;
}

/** atmos-render's `loudness::ffmpeg_args(Loudness::Reference)`: the renderer's core decoder. */
export const REFERENCE_OPTIONS: [string, string][] = [
  ['drc_scale', '1'],
  ['heavy_compr', '0'],
  ['target_level', '-31'],
];
const AV_OPT_SEARCH_CHILDREN = 1;
const AV_SAMPLE_FMT_S16P = 6;
const AV_SAMPLE_FMT_S32P = 7;
const AV_SAMPLE_FMT_FLTP = 8;
/**
 * Each planar format's scale to float, as swresample converts it (the renderer's FFmpeg child
 * writes pcm_f32le): integers over 2^15 or 2^31.
 */
const SCALE: Record<number, number> = {
  [AV_SAMPLE_FMT_FLTP]: 1,
  [AV_SAMPLE_FMT_S32P]: 1 / 2 ** 31,
  [AV_SAMPLE_FMT_S16P]: 1 / 2 ** 15,
};

/** Decoded core PCM: interleaved, in FFmpeg's (WAV) channel order. */
export interface CorePcm {
  channels: number;
  /** FFmpeg's channel mask, the same bits as WAV's. */
  mask: number;
  pcm: Float32Array;
}

export interface CoreDecoder {
  /** Decodes access units (each one MP4 sample: an independent frame and its dependents). */
  decode(units: Uint8Array[]): CorePcm | null;
  close(): void;
}

/**
 * The E-AC-3 core decoder with these options; none (`[]`) is FFmpeg's defaults, as the transcoder
 * decodes E-AC-3 for speakers. It reads AC-3 too, as the renderer's FFmpeg child does.
 */
export function eac3Core(
  libav: LibAVSync,
  options: [string, string][] = REFERENCE_OPTIONS
): CoreDecoder {
  return libavDecoder(libav, 'eac3', options);
}

/** FFmpeg's decoder `name` ("eac3", "ac3", "dca") with these options. */
export function libavDecoder(
  libav: LibAVSync,
  name: string,
  options: [string, string][] = []
): CoreDecoder {
  const codec = libav.avcodec_find_decoder_by_name_sync(name);
  if (!codec) throw new Error(`libav.js has no ${name} decoder`);
  const ctx = libav.avcodec_alloc_context3_sync(codec);
  for (const [option, value] of options)
    if (libav.av_opt_set_sync(ctx, option, value, AV_OPT_SEARCH_CHILDREN) < 0)
      throw new Error(`The ${name} decoder refused ${option}`);
  if (libav.avcodec_open2_sync(ctx, codec, 0) < 0)
    throw new Error(`The ${name} decoder could not open`);
  const pkt = libav.av_packet_alloc_sync();
  const frame = libav.av_frame_alloc_sync();
  return {
    decode(units) {
      const frames = libav.ff_decode_multi_sync(
        ctx,
        pkt,
        frame,
        units.map((data) => ({ data })),
        // A damaged frame is skipped, as the transcoder's FFmpeg skips it; the renderer pads
        // what's missing at the end.
        { ignoreErrors: true }
      );
      if (!frames.length) return null;
      const first = frames[0];
      const channels = first.channels ?? first.data.length;
      const mask = first.channel_layout ?? 0;
      const total = frames.reduce((n, f) => n + f.nb_samples, 0);
      const pcm = new Float32Array(total * channels);
      let at = 0;
      for (const f of frames) {
        const scale = SCALE[f.format];
        if (scale === undefined || f.data.length !== channels)
          throw new Error(`Unexpected ${name} decoder output`);
        for (let i = 0; i < f.nb_samples; i++)
          for (let ch = 0; ch < channels; ch++)
            pcm[at++] = f.data[ch][i] * scale;
      }
      return { channels, mask, pcm };
    },
    close() {
      libav.ff_free_decoder_sync(ctx, pkt, frame);
    },
  };
}
