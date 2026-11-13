/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DoviCapture } from './capture';
import { RpuParser, rpuFromNal } from './rpu';
import {
  declaresDovi,
  segmentRpus,
  videoInit,
  withoutDoviConfig,
} from './segments';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const init = fixture('p5-init.m4s');
const segment = fixture('p5-segment.m4s');
/** Frames' presentation times (ffprobe on the DASH manifest), decoding order. */
const TIMES = [0, 2556 / 12288, 1536 / 12288, 516 / 12288];

describe('Dolby Vision in DASH segments', () => {
  it('reads the init segment, edit list included', () => {
    expect(videoInit(init)).toEqual({
      timescale: 12288,
      lengthSize: 4,
      shift: 1020 / 12288,
    });
  });

  it('drops the configuration box Chrome refuses, keeping the size', () => {
    expect(declaresDovi(init)).toBe(true);
    const out = withoutDoviConfig(init);
    expect(declaresDovi(out)).toBe(false);
    expect(out.length).toBe(init.length);
    expect(videoInit(out)).toEqual(videoInit(init));
  });

  it("finds each frame's RPU at the time the video presents the frame", () => {
    const rpus = segmentRpus(segment, videoInit(init)!);
    expect(rpus.map((r) => r.time)).toEqual(
      TIMES.map((t) => expect.closeTo(t, 9))
    );
    // NAL type 62
    for (const r of rpus) expect((r.nal[0] >> 1) & 0x3f).toBe(62);
    const parser = new RpuParser();
    const params = rpus.map((r) => parser.parse(rpuFromNal(r.nal)));
    // dovi_tool's profile 5 RPU: I to 0, P and T to 0.5
    for (const p of params) {
      expect(p?.comp.map((k) => k.poly[0])).toEqual([
        [0, 0, 0],
        [0.5, 0, 0],
        [0.5, 0, 0],
      ]);
    }
  });
});

describe('RPU parsing', () => {
  it('matches the dolby_vision crate for an MMR RPU', () => {
    // dovi_tool's file: a start code, then the RPU without its NAL header
    const bin = fixture('fel_orig.bin').subarray(4);
    const nal = new Uint8Array(bin.length + 2);
    nal.set([0x7c, 0x01]);
    nal.set(bin, 2);
    const p = new RpuParser().parse(rpuFromNal(nal))!;
    const close = (values: number[], want: number[]) =>
      expect(values).toEqual(want.map((v) => expect.closeTo(v, 6)));
    close(
      p.nonlinear,
      [
        1.168701, 0, 1.684814, 1.168701, -0.187988, -0.652832, 1.168701,
        2.149658, 0,
      ]
    );
    close(p.nonlinearOffset, [0.0625, 0.5, 0.5]);
    close(
      p.linear,
      [
        0.440796, 0.535339, 0.023804, 0.161987, 0.758667, 0.079346, 0, 0.025757,
        0.974243,
      ]
    );
    close([p.minPq, p.maxPq], [0.001709, 0.751893]);
    close(
      p.comp[0].pivots,
      [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.999023]
    );
    expect(p.comp[0].poly.map((c) => c.slice(0, 2))).toEqual(
      new Array(8).fill([0, 1])
    );
    const cb = p.comp[1];
    close(cb.pivots, [0, 0.999023]);
    expect(cb.method).toEqual([1]);
    expect(cb.mmrOrder).toEqual([3]);
    close([cb.mmrConstant[0]], [0.053524733]);
    close(
      cb.mmr[0][0],
      [
        -0.150448799, 0.968273401, -0.20304513, 0.19337213, 0.096387148,
        -0.09888041, -0.001604438,
      ]
    );
    close(
      cb.mmr[0][2],
      [
        -0.021615148, -0.038720489, -0.263852596, -0.085357428, 0.090823174,
        0.043533325, 0.303446531,
      ]
    );
    const cr = p.comp[2];
    close([cr.mmrConstant[0]], [0.003619671]);
    close(
      cr.mmr[0][1],
      [
        0.161716461, 0.213271856, -0.394763589, -0.163559318, -0.542946935,
        -0.065334201, 0.086107135,
      ]
    );
  });
});

describe('capturing RPUs as Shaka fetches the video', () => {
  const video = { stream: { type: 'video' } };
  const fetchInit = (c: DoviCapture) => {
    const response = { data: init.slice().buffer as ArrayBuffer | Uint8Array };
    c.filter(1, response, { ...video, type: 0 });
    return response;
  };

  it('hands Shaka an init segment without the Dolby Vision box', () => {
    const response = fetchInit(new DoviCapture());
    expect(declaresDovi(response.data as Uint8Array)).toBe(false);
  });

  it("keeps each frame's RPU by the video's time, with the segment's offset", () => {
    const c = new DoviCapture();
    const seen = vi.fn();
    c.onSeen(seen);
    fetchInit(c);
    expect(c.at(0)).toBeNull();
    c.filter(
      1,
      { data: segment },
      { ...video, type: 1, segment: { timestampOffset: 10 } }
    );
    expect(c.seen).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    for (const t of TIMES) expect(c.at(10 + t)).not.toBeNull();
    // between frames (a frame is 1/24 s): the nearest within half a frame
    expect(c.at(10 + 0.01)).not.toBeNull();
    expect(c.at(10 + 0.5)).toBeNull();
    expect(c.at(0)).toBeNull();
    // the same segment again (Shaka refetching): replaced, still one listener call
    c.filter(
      1,
      { data: segment },
      { ...video, type: 1, segment: { timestampOffset: 10 } }
    );
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('leaves audio, and video before its init segment, alone', () => {
    const c = new DoviCapture();
    c.filter(1, { data: segment }, { ...video, type: 1 });
    expect(c.seen).toBe(false);
    const audio = { data: init.slice() };
    c.filter(1, audio, { stream: { type: 'audio' }, type: 0 });
    expect(declaresDovi(audio.data)).toBe(true);
  });
});
