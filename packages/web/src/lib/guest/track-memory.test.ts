/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerController } from '../playback/controller';

const saved = new Map<string, unknown>();
vi.mock('../storage', () => ({
  storage: {
    get: (key: string) => saved.get(key) ?? null,
    set: (key: string, value: unknown) => saved.set(key, value),
  },
}));
const { guestPrefs, rememberingEngine } = await import('./track-memory');

const media = {
  media: {
    tracks: [
      { index: 1, type: 'audio', language: 'jpn' },
      { index: 2, type: 'audio', language: 'eng' },
      { index: 3, type: 'subtitle', language: 'eng' },
    ],
  },
} as never;

type Picker = {
  setAudio(id: string): void;
  setSubtitle(id: string | null): void;
};

/**
 * The guest engine wrapped as the guest page wraps it, with `onReport` as the player page's
 * handler for what the engine reports; `report` makes the engine report.
 */
const player = (
  onReport: (event: { type: string }, engine: Picker) => void = () => {}
) => {
  const calls: (string | null)[] = [];
  const remembered: number[] = [];
  let loaded = 0;
  let report: (event: { type: string }) => void = () => {};
  const engine = rememberingEngine(
    ((emit: typeof report) => {
      report = emit;
      return {
        setAudio: (id: string) => calls.push(id),
        setSubtitle: (id: string | null) => calls.push(id),
      };
    }) as never,
    () => media,
    () => loaded++,
    () => remembered.push(1)
  )((event) => onReport(event, engine), {}) as unknown as Picker;
  return {
    engine,
    calls,
    remembered,
    loaded: () => loaded,
    report: (event: { type: string }) => report(event),
  };
};

beforeEach(() => saved.clear());

describe("a guest's track languages", () => {
  it('leave the file’s default tracks until the guest picks one', () => {
    expect(guestPrefs()).toEqual({ PlayDefaultAudioTrack: false });
  });
  it('are the languages of the tracks the guest picked, for the next file', () => {
    const { engine, calls, remembered } = player();
    engine.setAudio('2');
    engine.setSubtitle('3');
    expect(calls).toEqual(['2', '3']);
    expect(remembered).toHaveLength(2);
    expect(guestPrefs()).toEqual({
      PlayDefaultAudioTrack: false,
      AudioLanguagePreference: 'eng',
      SubtitleLanguagePreference: 'eng',
      SubtitleMode: 'Always',
    });
  });
  it('keep subtitles off once the guest turns them off', () => {
    const { engine } = player();
    engine.setSubtitle('3');
    engine.setSubtitle(null);
    expect(guestPrefs()).toMatchObject({ SubtitleMode: 'None' });
    expect(guestPrefs().SubtitleLanguagePreference).toBeUndefined();
  });
  it("aren't the tracks the player picks as the file opens", () => {
    // The player page picks a file's tracks in its handler for the engine reporting it loaded.
    const { calls, remembered, loaded, report } = player((event, engine) => {
      if (event.type !== 'loaded') return;
      engine.setAudio('1');
      engine.setSubtitle(null);
    });
    report({ type: 'state' });
    expect(loaded()).toBe(0);
    report({ type: 'loaded' });
    expect(loaded()).toBe(1);
    expect(calls).toEqual(['1', null]);
    expect(remembered).toHaveLength(0);
    expect(guestPrefs()).toEqual({ PlayDefaultAudioTrack: false });
  });
});
