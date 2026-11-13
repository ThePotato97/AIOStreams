import type {
  GuestArtwork,
  GuestMedia,
  GuestPlayback,
  GuestPlaybackRequest,
  GuestPlaybackState,
} from '@aiostreams/core';
export interface GuestCurrent {
  revision: string;
  playlistItemId: string;
  itemId: string;
  title: string;
  media: GuestMedia;
  /** The host's artwork for it, where the host's server has the item. */
  artwork?: GuestArtwork;
  /** Where the title is (the long poll): resolved and probed, being resolved, or failed. */
  state?: 'ready' | 'resolving' | 'failed';
  /** What to send back as `after`, to wait for a change. */
  token?: string;
  /** A failure's message and code. */
  error?: string;
  code?: string;
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
  /**
   * The title the party plays. With `after` (the token of the last answer), a long poll: answered
   * when it changes (a title, a version, a failure, a recovery), within 25 s. A title still being
   * resolved answers `resolving` at once, without its media.
   */
  current(signal?: AbortSignal, after?: string) {
    return this.request<GuestCurrent>(
      after == null
        ? '/current'
        : `/current?after=${encodeURIComponent(after)}`,
      undefined,
      signal
    );
  }
  prepare(body: GuestPlaybackRequest, signal?: AbortSignal) {
    return this.request<GuestPlayback>('/prepare', body, signal);
  }
  /** A converted playback's state, once it changes past `after` (a long poll, 25 s at most). */
  state(lease: string, after: number, signal?: AbortSignal) {
    return this.request<GuestPlaybackState>(
      `/prepare/${lease}/state?after=${after}`,
      undefined,
      signal
    );
  }
}
export function guestBase() {
  return `${window.location.origin}${window.location.pathname.replace(/\/watch\/?$/, '')}/party/guest`;
}
