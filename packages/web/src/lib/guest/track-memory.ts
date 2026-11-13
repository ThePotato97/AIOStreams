/*
 * A guest's track languages, kept in their browser: guests have no account, so no settings of
 * their own. The language of the audio and subtitle tracks they last picked themselves (or that
 * they turned subtitles off) becomes the preferences the next file opens with, picked by the
 * same rules as a signed-in user's.
 */
import type { EngineFactory } from '../playback/engine';
import { storage } from '../storage';
import type { GuestCurrent } from './api';
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

/** Keeps the language of a track the guest picked; null for subtitles turned off. */
export function rememberTrack(
  type: 'audio' | 'subtitle',
  lang: string | null
): void {
  if (type === 'audio') {
    if (lang) storage.set(KEY, { ...read(), audio: lang });
  } else storage.set(KEY, { ...read(), subtitle: lang });
}

/**
 * The guest engine, remembering the language of each track the guest picks (not the ones the
 * player picks as a file opens, which it does while reporting it loaded), and saying when the
 * stream has loaded.
 */
export function rememberingEngine(
  factory: EngineFactory,
  current: () => Pick<GuestCurrent, 'media'>,
  onLoaded: () => void,
  onRemembered: () => void
): EngineFactory {
  return (emit, opts) => {
    let opening = false;
    const engine = factory((event) => {
      if (event.type !== 'loaded') return emit(event);
      onLoaded();
      opening = true;
      try {
        emit(event);
      } finally {
        opening = false;
      }
    }, opts);
    const language = (id: string) =>
      current().media.tracks.find((t) => String(t.index) === id)?.language;
    return new Proxy(engine, {
      get(target, key, receiver) {
        if (key === 'setAudio')
          return (id: string) => {
            const lang = language(id);
            if (!opening && lang) {
              rememberTrack('audio', lang);
              onRemembered();
            }
            target.setAudio(id);
          };
        if (key === 'setSubtitle')
          return (id: string | null) => {
            if (!opening) {
              const lang = id === null ? null : language(id);
              if (lang !== undefined) {
                rememberTrack('subtitle', lang);
                onRemembered();
              }
            }
            target.setSubtitle(id);
          };
        return Reflect.get(target, key, receiver);
      },
    });
  };
}
