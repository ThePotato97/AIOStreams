/*
 * The speaker version of a track decoded in the browser, as the transcoder would have sent it with
 * headphones off: the decoded channels (TrueHD's highest presentation up to 8 channels; E-AC-3's
 * core) kept at the source's layout for a surround output, or downmixed to stereo, both through
 * FFmpeg's swresample as the transcoder runs it (`aresample=ochl=<layout>:rematrix_maxval=1`):
 * swresample 8.1's build_matrix (libswresample/rematrix.c) with its defaults (centre and surround
 * at -3 dB, the LFE left out, no matrix encoding) and the largest row normalised to 1.
 */

/** swresample's named channels (FFmpeg's channel bits 0 to 17). */
const FL = 0,
  FR = 1,
  FC = 2,
  LFE = 3,
  BL = 4,
  BR = 5,
  FLC = 6,
  FRC = 7,
  BC = 8,
  SL = 9,
  SR = 10,
  TFL = 12,
  TFC = 13,
  TFR = 14;
const NAMED = 18;
const S = Math.SQRT1_2;
/** swresample's defaults: C_30DB for both, no LFE. */
const CLEV = Math.SQRT1_2;
const SLEV = Math.SQRT1_2;
const LFE_MIX = 0;
/** The transcoder's rematrix_maxval. */
const MAXVAL = 1;

const bit = (ch: number) => 1n << BigInt(ch);
const STEREO = bit(FL) | bit(FR);

/** The transcoder's output layouts (FFmpeg's names), as channel masks. */
export const LAYOUTS = {
  stereo: STEREO,
  '5.1': STEREO | bit(FC) | bit(LFE) | bit(BL) | bit(BR),
  '7.1': STEREO | bit(FC) | bit(LFE) | bit(BL) | bit(BR) | bit(SL) | bit(SR),
} as const;
export type SpeakerLayout = keyof typeof LAYOUTS;

/**
 * The layout the transcoder converts a track to (media.mjs, ffmpegArgs): surround kept, up to 7.1,
 * where the output is surround and the track is; stereo otherwise. FLAC, so always "lossless".
 */
export function speakerLayout(
  trackChannels: number,
  surroundOutput: boolean
): SpeakerLayout {
  if (!surroundOutput || trackChannels <= 2) return 'stereo';
  return trackChannels > 6 ? '7.1' : '5.1';
}

/** The channels of a mask, in FFmpeg's order (by bit). */
export function channelsOf(mask: bigint): number[] {
  const out: number[] = [];
  for (let c = 0; c < 64; c++) if (mask & bit(c)) out.push(c);
  return out;
}

/** swresample's matrix from one layout to another: rows are output channels, in FFmpeg's order. */
export function swrMatrix(inMask: bigint, outMask: bigint): number[][] {
  const has = (mask: bigint, ch: number) => (mask & bit(ch)) !== 0n;
  const m = Array.from({ length: NAMED }, () =>
    new Array<number>(NAMED).fill(0)
  );
  const unaccounted = inMask & ~outMask;
  const fail = () => {
    throw new Error('No downmix to this layout');
  };
  for (let i = 0; i < NAMED; i++)
    if (has(inMask, i) && has(outMask, i)) m[i][i] = 1;
  if (has(unaccounted, FC)) {
    if ((outMask & STEREO) !== STEREO) fail();
    const level = inMask & STEREO ? CLEV : S;
    m[FL][FC] += level;
    m[FR][FC] += level;
  }
  if (unaccounted & STEREO) {
    if (!has(outMask, FC)) fail();
    m[FC][FL] += S;
    m[FC][FR] += S;
    if (has(inMask, FC)) m[FC][FC] = CLEV * Math.SQRT2;
  }
  if (has(unaccounted, BC)) {
    if (has(outMask, BL)) {
      m[BL][BC] += S;
      m[BR][BC] += S;
    } else if (has(outMask, SL)) {
      m[SL][BC] += S;
      m[SR][BC] += S;
    } else if (has(outMask, FL)) {
      m[FL][BC] += SLEV * S;
      m[FR][BC] += SLEV * S;
    } else if (has(outMask, FC)) m[FC][BC] += SLEV * S;
    else fail();
  }
  if (has(unaccounted, BL)) {
    if (has(outMask, BC)) {
      m[BC][BL] += S;
      m[BC][BR] += S;
    } else if (has(outMask, SL)) {
      const level = has(inMask, SL) ? S : 1;
      m[SL][BL] += level;
      m[SR][BR] += level;
    } else if (has(outMask, FL)) {
      m[FL][BL] += SLEV;
      m[FR][BR] += SLEV;
    } else if (has(outMask, FC)) {
      m[FC][BL] += SLEV * S;
      m[FC][BR] += SLEV * S;
    } else fail();
  }
  if (has(unaccounted, SL)) {
    if (has(outMask, BL)) {
      // side copied to back where the input has no back pair, else mixed into it
      const level = has(inMask, BL) ? S : 1;
      m[BL][SL] += level;
      m[BR][SR] += level;
    } else if (has(outMask, BC)) {
      m[BC][SL] += S;
      m[BC][SR] += S;
    } else if (has(outMask, FL)) {
      m[FL][SL] += SLEV;
      m[FR][SR] += SLEV;
    } else if (has(outMask, FC)) {
      m[FC][SL] += SLEV * S;
      m[FC][SR] += SLEV * S;
    } else fail();
  }
  if (has(unaccounted, FLC)) {
    if (has(outMask, FL)) {
      m[FL][FLC] += 1;
      m[FR][FRC] += 1;
    } else if (has(outMask, FC)) {
      m[FC][FLC] += S;
      m[FC][FRC] += S;
    } else fail();
  }
  if (has(unaccounted, TFL)) {
    if (has(outMask, TFC)) {
      m[TFC][TFL] += S;
      m[TFC][TFR] += S;
      if (has(inMask, TFC)) m[TFC][TFC] = CLEV * Math.SQRT2;
    } else if (has(outMask, FL)) {
      const level = has(inMask, FL) ? S : 1;
      m[FL][TFL] += level;
      m[FR][TFR] += level;
    } else if (has(outMask, FC)) {
      m[FC][TFL] += S;
      m[FC][TFR] += S;
    } else fail();
  }
  if (has(unaccounted, LFE)) {
    if (has(outMask, FC)) m[FC][LFE] += LFE_MIX;
    else if (has(outMask, FL)) {
      m[FL][LFE] += LFE_MIX * S;
      m[FR][LFE] += LFE_MIX * S;
    } else fail();
  }
  // In the layouts' own order; channels past the named ones pass through only to themselves.
  const ins = channelsOf(inMask);
  const outs = channelsOf(outMask);
  let maxcoef = 0;
  const rows = outs.map((o) => {
    const row = ins.map((i) =>
      o < NAMED && i < NAMED ? m[o][i] : o === i ? 1 : 0
    );
    maxcoef = Math.max(
      maxcoef,
      row.reduce((n, v) => n + Math.abs(v), 0)
    );
    return row;
  });
  if (maxcoef > MAXVAL) {
    const scale = maxcoef / MAXVAL;
    for (const row of rows)
      for (let i = 0; i < row.length; i++) row[i] /= scale;
  }
  return rows;
}

/** Mixes decoded channels to the transcoder's layout, sample by sample (interleaved). */
export class SpeakerMix {
  private inMask = -1n;
  private matrix: number[][] = [];
  readonly channels: number;
  private readonly outMask: bigint;

  constructor(readonly layout: SpeakerLayout) {
    this.outMask = LAYOUTS[layout];
    this.channels = channelsOf(this.outMask).length;
  }

  /** `pcm`: `channels` interleaved, FFmpeg's channel mask `mask` (their order). */
  mix(pcm: Float32Array, channels: number, mask: bigint): Float32Array {
    if (mask !== this.inMask) {
      if (channelsOf(mask).length !== channels)
        throw new Error(
          `A channel mask that doesn't match ${channels} channels`
        );
      this.matrix = swrMatrix(mask, this.outMask);
      this.inMask = mask;
    }
    const frames = pcm.length / channels;
    const out = new Float32Array(frames * this.channels);
    const m = this.matrix;
    for (let f = 0; f < frames; f++) {
      const at = f * channels;
      for (let o = 0; o < this.channels; o++) {
        const row = m[o];
        let sum = 0;
        for (let i = 0; i < channels; i++) sum += row[i] * pcm[at + i];
        out[f * this.channels + o] = sum;
      }
    }
    return out;
  }
}
