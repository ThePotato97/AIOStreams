/*
 * A guest's track languages, kept in their browser: guests have no account, so no settings of
 * their own. The player keeps the tracks a viewer picks for a show in display preferences
 * (`show-tracks.ts`), which the guest's client keeps here; the languages of the last pick also
 * become the preferences the next file opens with, a film's included, picked by the same rules as
 * a signed-in user's.
 */
import { storage } from '@/lib/storage';
import type { PlaybackPrefs } from '@/lib/jellyfin/user-config';

const KEY = 'aiostreams-web-guest-tracks';
/** How the player writes "subtitles off" in a pick. */
const OFF = 'off';

interface Remembered {
  audio?: string;
  /** null: subtitles turned off. */
  subtitle?: string | null;
  /** The display preferences the player keeps, by their id. */
  picks?: Record<string, Record<string, string>>;
  /** What the guest set in the player's settings, as an account's configuration. */
  settings?: PlaybackPrefs;
}

/** The settings a later pick of tracks replaces. */
const PICKED: (keyof PlaybackPrefs)[] = [
  'AudioLanguagePreference',
  'SubtitleLanguagePreference',
  'SubtitleMode',
];

const read = (): Remembered => storage.get<Remembered>(KEY) ?? {};

export function guestPrefs(): PlaybackPrefs {
  const { audio, subtitle, settings } = read();
  return {
    PlayDefaultAudioTrack: false,
    ...(audio ? { AudioLanguagePreference: audio } : {}),
    ...(subtitle === null
      ? { SubtitleMode: 'None' as const }
      : subtitle
        ? {
            SubtitleLanguagePreference: subtitle,
            SubtitleMode: 'Always' as const,
          }
        : {}),
    ...settings,
  };
}

/**
 * Keeps what the guest set in the player's settings: it stands until they pick other tracks, whose
 * languages then take over from the ones set here.
 */
export function keepSettings(settings: PlaybackPrefs): void {
  storage.set(KEY, { ...read(), settings });
}

/** The display preferences kept under `id`. */
export const keptPicks = (id: string): Record<string, string> =>
  read().picks?.[id] ?? {};

/**
 * Keeps the display preferences the player writes under `id`. A pick that changed (`audio|subtitle`,
 * as `show-tracks.ts` writes them) also sets the languages the next file opens with.
 */
export function keepPicks(id: string, prefs: Record<string, string>): void {
  const remembered = read();
  const before = remembered.picks?.[id] ?? {};
  let { audio, subtitle, settings } = remembered;
  for (const [show, pick] of Object.entries(prefs)) {
    if (!pick || pick === before[show]) continue;
    settings =
      settings &&
      Object.fromEntries(
        Object.entries(settings).filter(
          ([key]) => !PICKED.includes(key as keyof PlaybackPrefs)
        )
      );
    const [pickedAudio, pickedSubtitle] = pick.split('|');
    if (pickedAudio) audio = pickedAudio;
    if (pickedSubtitle === OFF) subtitle = null;
    else if (pickedSubtitle) subtitle = pickedSubtitle.split(':')[0];
  }
  const kept = Object.fromEntries(
    Object.entries({ ...before, ...prefs }).filter(([, pick]) => !!pick)
  );
  storage.set(KEY, {
    ...remembered,
    audio,
    subtitle,
    settings,
    picks: { ...remembered.picks, [id]: kept },
  });
}
