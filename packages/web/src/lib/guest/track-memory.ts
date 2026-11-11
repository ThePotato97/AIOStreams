/*
 * A guest's track languages, kept in their browser: guests have no account, so no settings of
 * their own. The language of the audio and subtitle tracks they last picked themselves (or that
 * they turned subtitles off) becomes the preferences the next file opens with, picked by the
 * same rules as a signed-in user's.
 */
import type { PlayerController } from '../playback/controller';
import { storage } from '../storage';
import type { PlaybackPrefs } from '../user-config';

const KEY = 'aiostreams-web-guest-tracks';

interface Remembered {
  audio?: string;
  /** null: subtitles turned off. */
  subtitle?: string | null;
}

const read = (): Remembered => storage.get<Remembered>(KEY) ?? {};

/**
 * The preferences a guest's next file opens with. The audio language wins over the file's
 * default track, as the guest picked it over that default; without one remembered, the file's
 * default plays as before.
 */
export function guestPrefs(): PlaybackPrefs {
  const { audio, subtitle } = read();
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
  };
}

/** The player, remembering the language of each track the guest picks. */
export function rememberingTracks(player: PlayerController): PlayerController {
  return {
    ...player,
    setAudio(id) {
      const lang = player.audioTracks.find((t) => t.id === id)?.lang;
      if (lang) storage.set(KEY, { ...read(), audio: lang });
      player.setAudio(id);
    },
    setSubtitle(id) {
      if (id === null) storage.set(KEY, { ...read(), subtitle: null });
      else {
        const lang = player.subtitleTracks.find((t) => t.id === id)?.lang;
        if (lang) storage.set(KEY, { ...read(), subtitle: lang });
      }
      player.setSubtitle(id);
    },
  };
}
