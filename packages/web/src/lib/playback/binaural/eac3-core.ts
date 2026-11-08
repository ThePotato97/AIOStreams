/*
 * The E-AC-3 core decoder for binaural rendering in the browser: FFmpeg's decoder, built as
 * libav.js (scripts/build-libav-eac3.sh), set up as the transcoder's renderer sets up its FFmpeg
 * child for the Reference Player's loudness (atmos-render's loudness.rs: LINE mode, dialogue at
 * -31 dBFS). Runs in the binaural worker, synchronously (libav.js in "direct" mode).
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
    data: Float32Array[];
    channels?: number;
    channel_layout?: number;
    nb_samples: number;
    format: number;
  }[];
  ff_free_decoder_sync(ctx: number, pkt: number, frame: number): void;
}

/** atmos-render's `loudness::ffmpeg_args(Loudness::Reference)`. */
const REFERENCE_OPTIONS: [string, string][] = [
  ['drc_scale', '1'],
  ['heavy_compr', '0'],
  ['target_level', '-31'],
];
const AV_OPT_SEARCH_CHILDREN = 1;
const AV_SAMPLE_FMT_FLTP = 8;

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

export function eac3Core(libav: LibAVSync): CoreDecoder {
  const codec = libav.avcodec_find_decoder_by_name_sync('eac3');
  if (!codec) throw new Error('libav.js has no E-AC-3 decoder');
  const ctx = libav.avcodec_alloc_context3_sync(codec);
  for (const [name, value] of REFERENCE_OPTIONS)
    if (libav.av_opt_set_sync(ctx, name, value, AV_OPT_SEARCH_CHILDREN) < 0)
      throw new Error(`The E-AC-3 decoder refused ${name}`);
  if (libav.avcodec_open2_sync(ctx, codec, 0) < 0)
    throw new Error('The E-AC-3 decoder could not open');
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
        if (f.format !== AV_SAMPLE_FMT_FLTP || f.data.length !== channels)
          throw new Error('Unexpected E-AC-3 decoder output');
        for (let i = 0; i < f.nb_samples; i++)
          for (let ch = 0; ch < channels; ch++) pcm[at++] = f.data[ch][i];
      }
      return { channels, mask, pcm };
    },
    close() {
      libav.ff_free_decoder_sync(ctx, pkt, frame);
    },
  };
}
