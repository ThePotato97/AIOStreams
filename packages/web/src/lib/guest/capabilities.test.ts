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
  const browser = (userAgent: string, hdrDisplay: boolean) => {
    vi.stubGlobal('document', {
      createElement: () => ({ canPlayType: () => 'probably' }),
    });
    vi.stubGlobal('navigator', { userAgent });
    vi.stubGlobal('matchMedia', () => ({ matches: hdrDisplay }));
  };
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
  const firefox =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
  afterEach(() => vi.unstubAllGlobals());

  it('plays as it is on an SDR display where the browser tone-maps it', async () => {
    browser(chrome, false);
    expect((await browserCapabilities(media)).hdr).toBe(true);
  });
  it('is tone-mapped by the server for Firefox on an SDR display', async () => {
    browser(firefox, false);
    expect((await browserCapabilities(media)).hdr).toBe(false);
  });
  it('plays as it is on an HDR display, Firefox included', async () => {
    browser(firefox, true);
    expect((await browserCapabilities(media)).hdr).toBe(true);
  });
  it('is not HDR for SDR video', async () => {
    browser(chrome, true);
    const sdr = {
      ...media,
      tracks: [{ ...media.tracks[0], hdr: false }],
    } as typeof media;
    expect((await browserCapabilities(sdr)).hdr).toBe(false);
  });
});
