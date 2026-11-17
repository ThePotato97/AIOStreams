/* What each playback event becomes in Simkl's API. No I/O. */

export interface SimklPlaybackEvent {
  kind: 'start' | 'pause' | 'stop' | 'played' | 'unplayed' | string;
  type: string;
  season?: number | null;
  episode?: number | null;
  positionMs?: number;
  durationMs?: number;
  /** Jellyfin-style keys: Imdb, Tmdb, Tvdb, Kitsu, MyAnimeList, AniList, AniDB, Simkl. */
  providerIds?: Record<string, string>;
  title?: string;
  year?: number;
}

const WESTERN: Record<string, string> = {
  Simkl: 'simkl',
  Imdb: 'imdb',
  Tmdb: 'tmdb',
  Tvdb: 'tvdb',
};
const ANIME: Record<string, string> = {
  MyAnimeList: 'mal',
  AniList: 'anilist',
  AniDB: 'anidb',
  Kitsu: 'kitsu',
};

function pick(src: Record<string, string>, map: Record<string, string>) {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(src)) {
    const key = map[k];
    if (!key || !v) continue;
    out[key] = /^\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

/**
 * The media object for a scrobble or history write, or null with no id.
 * Show-level ids (simkl/imdb/tmdb/tvdb) pair with season + number; an anime
 * entry id names one cour, so it takes the episode number alone.
 */
export function simklMediaOf(event: SimklPlaybackEvent): {
  key: 'movie' | 'show' | 'anime';
  media: Record<string, unknown>;
  episode?: Record<string, number>;
} | null {
  const ids = event.providerIds ?? {};
  const western = pick(ids, WESTERN);
  const anime = pick(ids, ANIME);
  const base: Record<string, unknown> = {};
  if (event.title) base.title = event.title;
  if (event.year) base.year = event.year;
  const isEpisode = event.episode != null;

  if (!isEpisode) {
    const all = { ...anime, ...western };
    if (!Object.keys(all).length) return null;
    return {
      key: event.type === 'movie' ? 'movie' : 'show',
      media: { ...base, ids: all },
    };
  }
  if (Object.keys(western).length)
    return {
      key: 'show',
      media: { ...base, ids: western },
      episode: { season: event.season ?? 1, number: event.episode! },
    };
  if (Object.keys(anime).length)
    return {
      key: 'anime',
      media: { ...base, ids: anime },
      episode: { number: event.episode! },
    };
  return null;
}

function progressOf(event: SimklPlaybackEvent): number {
  const { positionMs, durationMs } = event;
  if (!durationMs || positionMs == null) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round((positionMs / durationMs) * 10000) / 100)
  );
}

/** The request for one event, or null when Simkl has nothing for it. */
export function simklRequestOf(
  event: SimklPlaybackEvent,
  at = Date.now()
): { path: string; body: unknown } | null {
  const target = simklMediaOf(event);
  if (!target) return null;
  switch (event.kind) {
    case 'start':
    case 'pause':
    case 'stop': {
      const body: Record<string, unknown> = {
        progress: progressOf(event),
        [target.key]: target.media,
      };
      if (target.episode) body.episode = target.episode;
      return { path: `/scrobble/${event.kind}`, body };
    }
    case 'played':
    case 'unplayed': {
      const entry: Record<string, unknown> = { ...target.media };
      if (event.kind === 'played')
        entry.watched_at = new Date(at).toISOString();
      if (target.episode) {
        if (target.key === 'anime')
          entry.episodes = [{ number: target.episode.number }];
        else
          entry.seasons = [
            {
              number: target.episode.season,
              episodes: [{ number: target.episode.number }],
            },
          ];
      }
      const list =
        target.key === 'movie'
          ? 'movies'
          : target.key === 'anime'
            ? 'anime'
            : 'shows';
      return {
        path:
          event.kind === 'played' ? '/sync/history' : '/sync/history/remove',
        body: { [list]: [entry] },
      };
    }
    default:
      return null;
  }
}
