import { describe, expect, it } from 'vitest';
import { simklRequestOf } from './requests.js';

describe('simklRequestOf', () => {
  it('scrobbles a movie with its progress', () => {
    expect(
      simklRequestOf({
        kind: 'pause',
        type: 'movie',
        positionMs: 30 * 60_000,
        durationMs: 120 * 60_000,
        providerIds: { Imdb: 'tt1375666', Tmdb: '27205' },
      })
    ).toEqual({
      path: '/scrobble/pause',
      body: {
        progress: 25,
        movie: { ids: { imdb: 'tt1375666', tmdb: 27205 } },
      },
    });
  });

  it('sends a show episode with season and number on show-level ids', () => {
    expect(
      simklRequestOf({
        kind: 'stop',
        type: 'series',
        season: 2,
        episode: 5,
        positionMs: 900,
        durationMs: 1000,
        providerIds: { Imdb: 'tt0903747', Kitsu: '123' },
      })
    ).toEqual({
      path: '/scrobble/stop',
      body: {
        progress: 90,
        show: { ids: { imdb: 'tt0903747' } },
        episode: { season: 2, number: 5 },
      },
    });
  });

  it('sends an anime entry id with the episode number alone', () => {
    expect(
      simklRequestOf({
        kind: 'start',
        type: 'anime',
        season: 1,
        episode: 3,
        providerIds: { Kitsu: '42' },
      })
    ).toEqual({
      path: '/scrobble/start',
      body: {
        progress: 0,
        anime: { ids: { kitsu: 42 } },
        episode: { number: 3 },
      },
    });
  });

  it('writes a manual mark to history', () => {
    expect(
      simklRequestOf(
        {
          kind: 'played',
          type: 'series',
          season: 1,
          episode: 2,
          providerIds: { Tvdb: '81189' },
        },
        Date.UTC(2026, 0, 1)
      )
    ).toEqual({
      path: '/sync/history',
      body: {
        shows: [
          {
            ids: { tvdb: 81189 },
            watched_at: '2026-01-01T00:00:00.000Z',
            seasons: [{ number: 1, episodes: [{ number: 2 }] }],
          },
        ],
      },
    });
    expect(
      simklRequestOf({
        kind: 'unplayed',
        type: 'movie',
        providerIds: { Imdb: 'tt1' },
      })
    ).toEqual({
      path: '/sync/history/remove',
      body: { movies: [{ ids: { imdb: 'tt1' } }] },
    });
  });

  it('skips events without ids and events Simkl has no call for', () => {
    expect(simklRequestOf({ kind: 'start', type: 'movie' })).toBeNull();
    expect(
      simklRequestOf({
        kind: 'watchlisted',
        type: 'movie',
        providerIds: { Imdb: 'tt1' },
      })
    ).toBeNull();
  });
});
