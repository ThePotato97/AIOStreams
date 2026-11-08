/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it } from 'vitest';
import { silentElements, type SceneSnapshot } from './objects';

const snap = (time: number, levels: number[]): SceneSnapshot => ({
  time,
  elements: levels.map((level) => ({
    kind: 'object',
    mode: 'mid',
    active: true,
    pos: [0, 0, 0],
    gain: 1,
    level,
  })),
});

describe('silent elements', () => {
  it('are the ones with no signal over the whole window, not a moment of quiet', () => {
    const recent = [
      snap(0, [0.1, 0, 0]),
      snap(0.5, [0.1, 0.2, 0]),
      snap(1, [0.1, 0, 0]),
    ];
    // the second only went quiet just now; the third never had signal
    expect([...silentElements(recent, recent[2])]).toEqual([2]);
  });
  it('ignore snapshots of another scene (another element count)', () => {
    const recent = [snap(0, [0.1, 0.3]), snap(1, [0.1, 0, 0])];
    expect([...silentElements(recent, recent[1])]).toEqual([1, 2]);
  });
});
