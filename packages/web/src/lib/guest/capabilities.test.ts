/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuestTrack } from '@aiostreams/core';
import { browserCapabilities, codec } from './capabilities';

const video = (codecName: string, profile?: string, level?: number) =>
  codec({
    index: 0,
    type: 'video',
    title: '',
    codec: codecName,
    profile,
    level,
  } as GuestTrack);

describe('codec strings asked of the browser', () => {
  it('names each H.264 profile, and a level the file leaves out', () => {
    expect(video('h264', 'High', 41)).toBe('avc1.640029');
    expect(video('h264', 'High 10', 51)).toBe('avc1.6e0033');
    expect(video('h264', 'High 4:2:2', 41)).toBe('avc1.7a0029');
    expect(video('h264', 'High 4:4:4 Predictive', 41)).toBe('avc1.f40029');
    expect(video('h264', 'Main', -99)).toBe('avc1.4d4028');
  });
  it('asks about HEVC Main 10 as Main 10', () => {
    expect(video('hevc', 'Main', 120)).toBe('hvc1.1.6.L120.B0');
    expect(video('hevc', 'Main 10', -99)).toBe('hvc1.2.4.L153.B0');
  });
});

describe('HDR video', () => {
  const media = {
    durationMs: 1000,
    container: 'matroska,webm',
    bitrate: 1,
    chapters: [],
    tracks: [
      {
        index: 0,
        type: 'video',
        codec: 'hevc',
        profile: 'Main 10',
        level: 153,
        hdr: true,
        title: '',
      },
    ],
  } as unknown as Parameters<typeof browserCapabilities>[0];
  /**
   * A browser: whether it says it plays PQ HDR video (null: it rejects the
   * question; undefined: no Media Capabilities at all), and its screen.
   */
  const browser = (pq: boolean | null | undefined, hdrScreen: boolean) => {
    vi.stubGlobal('document', {
      createElement: () => ({ canPlayType: () => 'probably' }),
    });
    const asked: unknown[] = [];
    vi.stubGlobal('navigator', {
      mediaCapabilities:
        pq === undefined
          ? undefined
          : {
              decodingInfo: async (config: {
                video?: { transferFunction?: string };
              }) => {
                asked.push(config);
                if (!config.video?.transferFunction) return { supported: true };
                if (pq === null) throw new TypeError('Unsupported field');
                return { supported: pq };
              },
            },
    });
    vi.stubGlobal('matchMedia', () => ({ matches: hdrScreen }));
    return asked;
  };
  afterEach(() => vi.unstubAllGlobals());

  it('plays as it is where the browser says it plays PQ, on an SDR screen too', async () => {
    browser(true, false);
    expect((await browserCapabilities(media)).hdr).toBe(true);
  });
  it('is tone-mapped by the server where the browser says it does not', async () => {
    browser(false, true);
    expect((await browserCapabilities(media)).hdr).toBe(false);
  });
  it('asks about PQ with the rec2020 gamut and the video itself', async () => {
    const asked = browser(true, false);
    await browserCapabilities(media);
    expect(asked.at(-1)).toMatchObject({
      type: 'media-source',
      video: {
        contentType: expect.stringContaining('hvc1.2.4'),
        transferFunction: 'pq',
        colorGamut: 'rec2020',
      },
    });
  });
  it("goes by the screen where the browser can't be asked", async () => {
    browser(null, true);
    expect((await browserCapabilities(media)).hdr).toBe(true);
    browser(null, false);
    expect((await browserCapabilities(media)).hdr).toBe(false);
    browser(undefined, true);
    expect((await browserCapabilities(media)).hdr).toBe(true);
    browser(undefined, false);
    expect((await browserCapabilities(media)).hdr).toBe(false);
  });
  it('is not HDR for SDR video, and does not ask', async () => {
    const asked = browser(true, true);
    const sdr = {
      ...media,
      tracks: [{ ...media.tracks[0], hdr: false }],
    } as typeof media;
    expect((await browserCapabilities(sdr)).hdr).toBe(false);
    expect(asked.some((c) => JSON.stringify(c).includes('pq'))).toBe(false);
  });
});
