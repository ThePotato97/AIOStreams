/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it } from 'vitest';
import type { GuestTrack } from '@aiostreams/core';
import { codec } from './capabilities';

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
