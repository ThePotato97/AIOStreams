/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lingui/core/macro', () => ({
  t: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v),
}));
vi.mock('../hosts', () => ({ currentHost: () => ({ name: 'browser' }) }));
vi.mock('../hosts/shell/bridge', () => ({ appBridge: () => null }));
vi.mock('../connection', () => ({ reached: () => {}, unreachable: () => {} }));
const forgotten = vi.hoisted(() => [] as [string, string][]);
vi.mock('../cache', () => ({
  forgetUser: (base: string, user: string) => forgotten.push([base, user]),
}));
const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../storage', () => ({
  storage: {
    get: (key: string) => saved.get(key) ?? null,
    set: (key: string, value: unknown) => saved.set(key, value),
  },
}));
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});
const fetchSpy = vi.fn();
vi.stubGlobal('fetch', fetchSpy);

const { GuestJellyfinClient } = await import('./guest-client');
const { JellyfinError } = await import('../client');
const { rememberTrack } = await import('./track-memory');

const current: {
  revision: string;
  playlistItemId: string;
  itemId: string;
  title: string;
  media: {
    durationMs: number;
    container: string;
    bitrate: number;
    tracks: never[];
    chapters: never[];
  };
  artwork?: Record<string, unknown>;
} = {
  revision: 'rev-1',
  playlistItemId: 'p1',
  itemId: 'item-1',
  title: 'Show S1E2',
  media: {
    durationMs: 1_200_000,
    container: 'matroska',
    bitrate: 1,
    tracks: [],
    chapters: [],
  },
};
const queue = [
  {
    id: 'item-1',
    type: 'Episode',
    name: 'The Second',
    seriesName: 'Show',
    season: 1,
    episode: 2,
    year: 2020,
  },
  { id: 'item-2', type: 'Movie', name: 'Next One', runtimeMs: 5_400_000 },
];
const hostSegments = {
  Items: [{ Type: 'Intro', StartTicks: 0, EndTicks: 900_000_000 }],
};
const segmentRequests: number[] = [];
const client = () =>
  new GuestJellyfinClient(
    'https://aio.example/party/guest',
    () => current as never,
    () => queue,
    async () => (segmentRequests.push(1), hostSegments as never),
    'https://aio.example/jellyfin'
  );

beforeEach(() => {
  saved.clear();
  fetchSpy.mockReset();
  segmentRequests.length = 0;
  delete current.artwork;
});

describe("a guest's player page asking its server", () => {
  it('keeps nothing of what it answers', () => {
    forgotten.length = 0;
    client();
    expect(forgotten).toEqual([['https://aio.example/party/guest', 'guest']]);
  });
  it('gets the title playing, as the party describes it', async () => {
    const { Items } = await client().get<{ Items: unknown[] }>('/Items', {
      userId: 'guest',
      Ids: 'item-1',
      Fields: 'Overview',
    });
    expect(Items).toEqual([
      {
        Id: 'item-1',
        Name: 'The Second',
        Type: 'Episode',
        SeriesName: 'Show',
        ParentIndexNumber: 1,
        IndexNumber: 2,
        ProductionYear: 2020,
        RunTimeTicks: 12_000_000_000,
      },
    ]);
  });
  it("gets the party's other titles, and nothing it can't see", async () => {
    const c = client();
    const next = await c.get<{ Items: { Id: string; Type: string }[] }>(
      '/Items',
      { Ids: 'item-2' }
    );
    expect(next.Items).toMatchObject([
      { Id: 'item-2', Type: 'Movie', RunTimeTicks: 54_000_000_000 },
    ]);
    expect(
      (await c.get<{ Items: unknown[] }>('/Items', { Ids: 'other' })).Items
    ).toEqual([]);
    expect(
      (await c.get<{ Items: unknown[] }>('/Items', { SearchTerm: 'Show' }))
        .Items
    ).toEqual([]);
  });
  it("gets the party's file as the one version of the title playing", async () => {
    const c = client();
    const info = await c.post<{ MediaSources: { Id: string }[] }>(
      '/Items/item-1/PlaybackInfo',
      { UserId: 'guest', MediaSourceId: 'rev-1' },
      { userId: 'guest' }
    );
    expect(info.MediaSources).toEqual([
      expect.objectContaining({
        Id: 'rev-1',
        RunTimeTicks: 12_000_000_000,
        MediaStreams: [],
      }),
    ]);
    const other = await c.post<{ MediaSources: unknown[] }>(
      '/Items/item-2/PlaybackInfo',
      {}
    );
    expect(other.MediaSources).toEqual([]);
  });
  it("gets the guest's own track languages as its settings", async () => {
    rememberTrack('audio', 'jpn');
    const me = await client().get<{ Configuration: object }>('/Users/Me');
    expect(me.Configuration).toEqual({
      PlayDefaultAudioTrack: false,
      AudioLanguagePreference: 'jpn',
    });
  });
  it("gets the host's segments for the title playing, and none for another", async () => {
    const c = client();
    expect(await c.get('/MediaSegments/item-1')).toEqual({
      ...hostSegments,
      TotalRecordCount: 1,
    });
    expect(await c.get('/MediaSegments/item-2')).toEqual({
      Items: [],
      TotalRecordCount: 0,
    });
    expect(segmentRequests).toHaveLength(1);
  });
  it("gets the host's artwork on the title playing", async () => {
    current.artwork = {
      ImageTags: { Logo: 'l-tag' },
      ParentLogoItemId: 'series',
      ParentLogoImageTag: 'sl-tag',
      Overview: 'What happens.',
    };
    const { Items } = await client().get<{ Items: Record<string, unknown>[] }>(
      '/Items',
      { Ids: 'item-1,item-2' }
    );
    expect(Items[0]).toMatchObject({
      Id: 'item-1',
      Name: 'The Second',
      ImageTags: { Logo: 'l-tag' },
      ParentLogoItemId: 'series',
      ParentLogoImageTag: 'sl-tag',
      Overview: 'What happens.',
    });
    expect(Items[1].ImageTags).toBeUndefined();
  });
  it('has no show picks or playback records', async () => {
    const c = client();
    expect(
      await c.get('/DisplayPreferences/aiostreams-web-tracks', {
        client: 'aiostreams-web-tracks',
      })
    ).toEqual({ CustomPrefs: {} });
    await expect(
      c.post('/Sessions/Playing/Progress', {})
    ).resolves.toBeUndefined();
    expect(await c.get('/Shows/s/Episodes')).toMatchObject({ Items: [] });
  });
  it('answers anything else as the server would a missing route, and sends nothing', async () => {
    await expect(client().get('/Users/Views')).rejects.toBeInstanceOf(
      JellyfinError
    );
    await expect(client().get('/Users/Views')).rejects.toMatchObject({
      status: 404,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("loads images from the host's image route, and nothing else from there", () => {
    expect(client().url('/Items/item-1/Images/Logo', { tag: 't' })).toBe(
      'https://aio.example/jellyfin/Items/item-1/Images/Logo?tag=t'
    );
    expect(client().url('/Videos/item-1/stream')).toBe(
      'https://aio.example/party/guest/Videos/item-1/stream'
    );
  });
});
