/*
 * The Jellyfin client a guest's player page talks to. Guests have no account on the host's server,
 * so the requests the player page makes for its item, version, preferences and the party's titles
 * are answered here, from what the guest routes and the party already give the guest: the title
 * playing (`/current`, with the host's artwork) and the party's queue. The host's segments come
 * from the guest routes (`/segments`); nothing else is sent. Images load from the host's image
 * route, which reads the image tags without a session.
 */
import { t } from '@lingui/core/macro';
import { JellyfinClient, JellyfinError, type Query } from '../client';
import { forgetUser } from '../cache';
import type { PartyItem } from '../party/items';
import type { BaseItemDto, MediaSegmentDto, SourceInfo } from '../types';
import type { GuestCurrent } from './api';
import { guestPrefs } from './track-memory';

/** The user id the guest's session has, which keys its queries. */
export const GUEST_USER_ID = 'guest';

const TICKS_PER_MS = 10_000;

/** The party's titles the guest can see, by item id. */
export type QueueItems = () => readonly PartyItem[];

/** An item's image, as the player page asks for it. */
const IMAGE = /^\/Items\/[^/]+\/Images\//;

export class GuestJellyfinClient extends JellyfinClient {
  constructor(
    base: string,
    /** The title the party plays, as the guest routes last gave it. */
    private readonly playing: () => GuestCurrent | undefined,
    private readonly queue: QueueItems,
    /** The host's segments for the title playing, from the guest routes. */
    private readonly segments: () => Promise<{ Items: MediaSegmentDto[] }>,
    /** Where the host's server serves item images: its Jellyfin routes. */
    private readonly images: string
  ) {
    super(base);
    // Answered here and from nothing kept: a saved copy would open the next file on old answers.
    forgetUser(base, GUEST_USER_ID);
  }

  override withToken(): JellyfinClient {
    return this;
  }

  override url(path: string, query?: Query): string {
    const url = super.url(path, query);
    return IMAGE.test(path) ? this.images + url.slice(this.base.length) : url;
  }

  /** The item the guest plays, or one of the party's other titles. */
  item(id: string): BaseItemDto | null {
    const current = this.playing();
    const queued = this.queue().find((e) => e.id === id);
    if (current?.itemId === id)
      return { ...itemOf(current.itemId, queued, current), ...current.artwork };
    return queued ? itemOf(queued.id, queued) : null;
  }

  /** The version the guest plays: the party's file, as the guest routes probed it. */
  source(): SourceInfo | null {
    const current = this.playing();
    if (!current) return null;
    return {
      Id: current.revision,
      Type: 'Default',
      Protocol: 'Http',
      Name: current.title,
      RunTimeTicks: current.media.durationMs * TICKS_PER_MS,
      // The guest engine lists the file's tracks and draws its subtitles itself.
      MediaStreams: [],
    } as SourceInfo;
  }

  override async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    init: { query?: Query; body?: unknown } = {}
  ): Promise<T> {
    return (await this.answer(method, path, init.query ?? {})) as T;
  }

  private async answer(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query: Query
  ): Promise<unknown> {
    const none = { Items: [], TotalRecordCount: 0 };
    if (method === 'GET' && path === '/Items') {
      // The party's titles by id; a search or listing finds nothing beyond them.
      if (!query.Ids) return none;
      const ids = String(query.Ids).split(',');
      const items = ids
        .map((id) => this.item(id))
        .filter((i): i is BaseItemDto => !!i);
      return { Items: items, TotalRecordCount: items.length };
    }
    const playbackInfo = /^\/Items\/([^/]+)\/PlaybackInfo$/.exec(path);
    if (method === 'POST' && playbackInfo) {
      const current = this.playing();
      const source = this.source();
      // Only the title playing has a file the guest can play; the others list none.
      return {
        MediaSources:
          source && current?.itemId === playbackInfo[1] ? [source] : [],
        PlaySessionId: null,
      };
    }
    if (method === 'GET' && path === '/Users/Me')
      return { Id: GUEST_USER_ID, Configuration: guestPrefs() };
    if (path.startsWith('/DisplayPreferences/'))
      return method === 'GET' ? { CustomPrefs: {} } : undefined;
    if (method === 'GET' && path.startsWith('/MediaSegments/')) {
      // Only the title playing has the host's; another's would be the next title's own.
      const id = path.slice('/MediaSegments/'.length);
      if (this.playing()?.itemId !== id) return none;
      const { Items } = await this.segments();
      return { Items, TotalRecordCount: Items.length };
    }
    // The host's server keeps no playback record for a guest.
    if (method === 'POST' && path.startsWith('/Sessions/Playing'))
      return undefined;
    if (
      method === 'GET' &&
      (path.startsWith('/Shows/') || path.startsWith('/Playlists/'))
    )
      return none;
    // As the server answers a route it hasn't.
    const status = 404;
    throw new JellyfinError(status, t`Request failed (${status})`);
  }
}

/** A Jellyfin item from the party's sealed entry, and the guest routes' answer when it plays. */
function itemOf(
  id: string,
  entry: PartyItem | undefined,
  current?: GuestCurrent
): BaseItemDto {
  const runtimeMs = current?.media.durationMs ?? entry?.runtimeMs;
  const episode = entry?.type === 'Episode';
  return {
    Id: id,
    Name: entry?.name ?? current?.title ?? '',
    Type: episode ? 'Episode' : 'Movie',
    ...(episode
      ? {
          SeriesName: entry?.seriesName,
          ParentIndexNumber: entry?.season,
          IndexNumber: entry?.episode,
        }
      : {}),
    ProductionYear: entry?.year,
    RunTimeTicks: runtimeMs ? runtimeMs * TICKS_PER_MS : undefined,
  } as BaseItemDto;
}
