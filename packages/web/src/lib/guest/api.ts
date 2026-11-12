import type {
  GuestArtwork,
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
  /** The host's artwork for it, where the host's server has the item. */
  artwork?: GuestArtwork;
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
    const text = await res.text();
    let data: { error?: string; retryAfter?: number; code?: string };
    try {
      data = JSON.parse(text);
    } catch {
      // A proxy's own error page, such as Cloudflare's 524.
      throw Object.assign(new Error(`The server answered ${res.status}`), {
        status: res.status,
      });
    }
    if (!res.ok)
      throw Object.assign(
        new Error(data.error ?? 'Guest playback unavailable'),
        {
          status: res.status,
          retryAfter: data.retryAfter as number | undefined,
          // Why, where the server knows: transcoder_unreachable, transcoder_busy, ...
          code: typeof data.code === 'string' ? data.code : undefined,
        }
      );
    return data as unknown as T;
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
