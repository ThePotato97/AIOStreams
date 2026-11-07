/* eslint-disable lingui/no-unlocalized-strings -- speaker names and test data, not UI text. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HESUVI, HRIR_CHANNELS, layout } from './hrir-layout';

describe('HeSuVi HRIR layout', () => {
  it('reads every one of the 14 channels once', () => {
    const used = Object.values(HESUVI)
      .flat()
      .sort((a, b) => a - b);
    expect(used).toEqual(Array.from({ length: HRIR_CHANNELS }, (_, i) => i));
  });
  it("takes each speaker's ears from HeSuVi's slots, the nearer ear first for the right side", () => {
    // L-left, L-right, SL-left, SL-right, BL-left, BL-right, C-left,
    // R-right, R-left, SR-right, SR-left, BR-right, BR-left, C-right.
    expect(HESUVI.L).toEqual([0, 1]);
    expect(HESUVI.R).toEqual([8, 7]);
    expect(HESUVI.SR).toEqual([10, 9]);
    expect(HESUVI.BR).toEqual([12, 11]);
    expect(HESUVI.C).toEqual([6, 13]);
  });
  it('bundles a 14-channel set', () => {
    const wav = readFileSync(new URL('./hrir/atmos.wav', import.meta.url));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(HRIR_CHANNELS);
    expect(wav.readUInt32LE(24)).toBe(48000);
  });
});

describe('speaker layout of a decoded track', () => {
  it('puts 7.1 in the order browsers decode it', () => {
    expect(layout(8)).toEqual(['L', 'R', 'C', 'LFE', 'BL', 'BR', 'SL', 'SR']);
  });
  it("treats 5.1's surrounds as side speakers", () => {
    expect(layout(6).slice(0, 6)).toEqual(['L', 'R', 'C', 'LFE', 'SL', 'SR']);
  });
  it('places stereo at the front pair', () => {
    expect(layout(2).filter(Boolean)).toEqual(['L', 'R']);
  });
});
