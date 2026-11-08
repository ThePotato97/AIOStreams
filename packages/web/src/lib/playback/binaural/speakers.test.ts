/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it } from 'vitest';
import { SpeakerMix, speakerLayout, swrMatrix } from './speakers';

// FFmpeg's channel masks (its layout names)
const SIDE_51 = 0x60fn; // 5.1(side): FL FR FC LFE SL SR
const L71 = 0x63fn; // 7.1: FL FR FC LFE BL BR SL SR
const L61 = 0x70fn; // 6.1: FL FR FC LFE BC SL SR
const STEREO = 0x3n;
const L51 = 0x3fn; // 5.1: FL FR FC LFE BL BR

/** Matrices measured from FFmpeg 8.1 (the transcoder's), aresample=ochl=..:rematrix_maxval=1. */
const close = (got: number[][], want: number[][]) =>
  expect(got).toEqual(want.map((r) => r.map((v) => expect.closeTo(v, 7))));

describe("the transcoder's downmix, as swresample builds it", () => {
  it('matches FFmpeg for 7.1, 5.1 and 6.1 to stereo', () => {
    close(swrMatrix(L71, STEREO), [
      [0.3203772, 0, 0.2265409, 0, 0.2265409, 0, 0.2265409, 0],
      [0, 0.3203772, 0.2265409, 0, 0, 0.2265409, 0, 0.2265409],
    ]);
    close(swrMatrix(SIDE_51, STEREO), [
      [0.4142136, 0, 0.2928932, 0, 0.2928932, 0],
      [0, 0.4142136, 0.2928932, 0, 0, 0.2928932],
    ]);
    close(swrMatrix(L61, STEREO), [
      [0.3431458, 0, 0.2426407, 0, 0.1715729, 0.2426407, 0],
      [0, 0.3431458, 0.2426407, 0, 0.1715729, 0, 0.2426407],
    ]);
  });

  it("moves 5.1's sides to the back for a 5.1 output, and keeps 7.1 as it is", () => {
    const sides = swrMatrix(SIDE_51, L51);
    // FL FR FC LFE as they are; SL to BL, SR to BR
    expect(sides.map((r) => r.indexOf(1))).toEqual([0, 1, 2, 3, 4, 5]);
    const identity = swrMatrix(L71, L71);
    identity.forEach((r, i) =>
      expect(r).toEqual(r.map((_, j) => (i === j ? 1 : 0)))
    );
  });

  it('mixes interleaved samples by the matrix', () => {
    const mix = new SpeakerMix('stereo');
    expect(mix.channels).toBe(2);
    // one 5.1(side) frame: centre only
    const out = mix.mix(new Float32Array([0, 0, 1, 0, 0, 0]), 6, SIDE_51);
    expect(Array.from(out)).toEqual([
      expect.closeTo(0.2928932, 7),
      expect.closeTo(0.2928932, 7),
    ]);
    expect(() => mix.mix(new Float32Array(6), 6, L71)).toThrow();
  });
});

describe('the layout the transcoder converts to', () => {
  it('keeps surround for a surround output, up to 7.1', () => {
    expect(speakerLayout(8, true)).toBe('7.1');
    expect(speakerLayout(6, true)).toBe('5.1');
    expect(speakerLayout(2, true)).toBe('stereo');
    expect(speakerLayout(8, false)).toBe('stereo');
  });
});
