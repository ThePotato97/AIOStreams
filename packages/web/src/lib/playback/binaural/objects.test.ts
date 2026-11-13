/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it } from 'vitest';
import {
  readSnapshots,
  sceneStore,
  silentElements,
  type SceneSnapshot,
} from './objects';

const snap = (time: number, levels: number[]): SceneSnapshot => ({
  time,
  elements: levels.map((level) => ({
    kind: 'object',
    mode: 'mid',
    active: true,
    pos: [0, 0, 0],
    gain: 1,
    level,
    slot: null,
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

describe('silent elements, against a noise floor', () => {
  it("count a decoder's idle objects (-123 dB) as silent", () => {
    const quiet = 10 ** (-123 / 20);
    const recent = [snap(0, [0.1, quiet]), snap(1, [0.1, quiet])];
    expect([...silentElements(recent, recent[1])]).toEqual([1]);
  });
});

describe('switched-off elements', () => {
  it('switch on and off one at a time or together, and tell the player each change', () => {
    let changes = 0;
    const stop = sceneStore.subscribeDisabled(() => changes++);
    sceneStore.toggleElement(3);
    sceneStore.toggleElement(5);
    sceneStore.setElements([1, 2], false);
    expect(sceneStore.disabledList()).toEqual([1, 2, 3, 5]);
    sceneStore.toggleElement(3);
    expect(sceneStore.disabledList()).toEqual([1, 2, 5]);
    sceneStore.only(0, 4);
    expect(sceneStore.disabledList()).toEqual([1, 2, 3]);
    // the same set again is no change
    sceneStore.only(0, 4);
    sceneStore.allOn();
    expect(sceneStore.disabledList()).toEqual([]);
    expect(changes).toBe(6);
    stop();
  });
  it('are all switched on again when the view closes', () => {
    if (!sceneStore.shown) sceneStore.toggle();
    sceneStore.setElements([0, 1], false);
    sceneStore.toggle();
    expect(sceneStore.disabledList()).toEqual([]);
  });
});

describe('snapshots from the renderer', () => {
  it('read the stereo-bypass pair as such, with no place in the room', () => {
    // one snapshot at sample 0 with two elements: kind 4 (bypass), side, no mode, active,
    // no position, gain, level, Windows slot
    const n = NaN;
    const data = new Float64Array([
      0,
      2,
      4,
      0,
      -1,
      1,
      n,
      n,
      n,
      1,
      0.5,
      17,
      4,
      1,
      -1,
      1,
      n,
      n,
      n,
      1,
      0.25,
      -1,
    ]);
    const [snapshot] = readSnapshots(data, 10, 48000);
    expect(snapshot.time).toBe(10);
    expect(
      snapshot.elements.map((e) => [e.kind, e.bed, e.pos, e.mode, e.slot])
    ).toEqual([
      ['bypass', 0, null, null, 17],
      ['bypass', 1, null, null, null],
    ]);
  });
});

describe('named channels and LFE2', () => {
  it('are read with their codes', () => {
    const n = NaN;
    // kind 2 (LFE) numbered 2, and kind 5 (named channel) with code 3, back centre
    const data = new Float64Array([
      0,
      2,
      2,
      2,
      -1,
      1,
      n,
      n,
      n,
      1,
      0.5,
      -1,
      5,
      3,
      1,
      1,
      0.5,
      1,
      0,
      1,
      0.25,
      16,
    ]);
    const [snapshot] = readSnapshots(data, 0, 48000);
    expect(snapshot.elements.map((e) => [e.kind, e.bed, e.slot])).toEqual([
      ['lfe', 2, null],
      ['channel', 3, 16],
    ]);
  });
});
