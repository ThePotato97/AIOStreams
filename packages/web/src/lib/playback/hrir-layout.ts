/* eslint-disable lingui/no-unlocalized-strings -- speaker names and test data, not UI text. */
/** HeSuVi sets have 14 channels, one per speaker and ear. */
export const HRIR_CHANNELS = 14;

/**
 * The HeSuVi 14-channel layout: for each speaker, the channels holding its
 * left-ear and right-ear responses. The right-hand speakers list the nearer
 * ear first, as HeSuVi stores them.
 */
export const HESUVI: Record<Speaker, [left: number, right: number]> = {
  L: [0, 1],
  SL: [2, 3],
  BL: [4, 5],
  C: [6, 13],
  R: [8, 7],
  SR: [10, 9],
  BR: [12, 11],
};
export type Speaker = 'L' | 'R' | 'C' | 'SL' | 'SR' | 'BL' | 'BR';

/**
 * Which speaker each decoded channel is, by the track's channel count, in
 * the order browsers decode to (FFmpeg's: L R C LFE, then the surrounds).
 * 5.1's surrounds are side speakers; 7.1 adds the back pair before them.
 */
export function layout(channels: number): (Speaker | 'LFE' | null)[] {
  if (channels >= 8) return ['L', 'R', 'C', 'LFE', 'BL', 'BR', 'SL', 'SR'];
  if (channels >= 6) return ['L', 'R', 'C', 'LFE', 'SL', 'SR', null, null];
  return ['L', 'R', null, null, null, null, null, null];
}
