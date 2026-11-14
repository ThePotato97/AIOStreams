/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const saved = new Map<string, unknown>();
vi.mock('@/lib/storage', () => ({
  storage: {
    get: (key: string) => saved.get(key) ?? null,
    set: (key: string, value: unknown) => saved.set(key, value),
  },
}));
const { guestPrefs, keepPicks, keptPicks } = await import('./track-memory');

const ID = 'aiostreams-web-tracks';

beforeEach(() => saved.clear());

describe("a guest's track languages", () => {
  it('leave the file’s default tracks until the guest picks one', () => {
    expect(guestPrefs()).toEqual({ PlayDefaultAudioTrack: false });
  });
  it('keep the picks the player writes, as display preferences', () => {
    keepPicks(ID, { show: 'jpn|eng' });
    expect(keptPicks(ID)).toEqual({ show: 'jpn|eng' });
    expect(keptPicks('other')).toEqual({});
  });
  it('are the languages of the last pick, for the next file, a film included', () => {
    keepPicks(ID, { show: 'jpn|eng:forced' });
    expect(guestPrefs()).toEqual({
      PlayDefaultAudioTrack: false,
      AudioLanguagePreference: 'jpn',
      SubtitleLanguagePreference: 'eng',
      SubtitleMode: 'Always',
    });
  });
  it('keep subtitles off once the guest turns them off', () => {
    keepPicks(ID, { show: 'jpn|off' });
    expect(guestPrefs()).toMatchObject({
      AudioLanguagePreference: 'jpn',
      SubtitleMode: 'None',
    });
  });
  it('follow the pick that changed, not the others sent with it', () => {
    keepPicks(ID, { a: 'jpn|eng' });
    keepPicks(ID, { a: 'jpn|eng', b: 'fra|off' });
    expect(guestPrefs()).toMatchObject({
      AudioLanguagePreference: 'fra',
      SubtitleMode: 'None',
    });
    // A forgotten pick is sent empty: it's dropped, and changes no language.
    keepPicks(ID, { a: '', b: 'fra|off' });
    expect(keptPicks(ID)).toEqual({ b: 'fra|off' });
    expect(guestPrefs()).toMatchObject({ AudioLanguagePreference: 'fra' });
  });
});
