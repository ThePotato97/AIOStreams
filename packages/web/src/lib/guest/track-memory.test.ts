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
const { guestPrefs, rememberingTracks } = await import('./track-memory');

const player = () => {
  const calls: (string | null)[] = [];
  const controller = {
    audioTracks: [
      { id: '1', label: 'Japanese', lang: 'jpn' },
      { id: '2', label: 'English', lang: 'eng' },
    ],
    subtitleTracks: [{ id: '3', label: 'English', lang: 'eng' }],
    setAudio: (id: string) => calls.push(id),
    setSubtitle: (id: string | null) => calls.push(id),
  } as unknown as PlayerController;
  return { controller: rememberingTracks(controller), calls };
};

beforeEach(() => saved.clear());

describe("a guest's track languages", () => {
  it('leave the file’s default tracks until the guest picks one', () => {
    expect(guestPrefs()).toEqual({ PlayDefaultAudioTrack: false });
  });
  it('are the languages of the tracks the guest picked, for the next file', () => {
    const { controller, calls } = player();
    controller.setAudio('2');
    controller.setSubtitle('3');
    expect(calls).toEqual(['2', '3']);
    expect(guestPrefs()).toEqual({
      PlayDefaultAudioTrack: false,
      AudioLanguagePreference: 'eng',
      SubtitleLanguagePreference: 'eng',
      SubtitleMode: 'Always',
    });
  });
  it('keep subtitles off once the guest turns them off', () => {
    const { controller } = player();
    controller.setSubtitle('3');
    controller.setSubtitle(null);
    expect(guestPrefs()).toMatchObject({ SubtitleMode: 'None' });
    expect(guestPrefs().SubtitleLanguagePreference).toBeUndefined();
  });
});
