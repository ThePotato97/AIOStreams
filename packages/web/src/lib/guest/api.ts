import type {
  GuestMedia,
  GuestPlayback,
  GuestPlaybackRequest,
} from '@aiostreams/core';
export interface GuestCurrent {
  revision: string;
  playlistItemId: string;
  itemId: string;
  title: string;
  media: GuestMedia;
}
export class GuestApi {
  constructor(
    readonly base: string,
    // Set later for a user's own playback, once the server opens it.
    public token: string
  ) {}
  async request<T>(
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok)
      throw Object.assign(
        new Error(data.error ?? 'Guest playback unavailable'),
        { status: res.status }
      );
    return data as T;
  }
  current(signal?: AbortSignal) {
    return this.request<GuestCurrent>('/current', undefined, signal);
  }
  prepare(body: GuestPlaybackRequest, signal?: AbortSignal) {
    return this.request<GuestPlayback>('/prepare', body, signal);
  }
}
export function guestBase() {
  return `${window.location.origin}${window.location.pathname.replace(/\/watch\/?$/, '')}/party/guest`;
}
