import type { GuestArtwork, GuestFile } from '@aiostreams/core';
export interface GuestCurrent {
  revision: string;
  playlistItemId: string;
  itemId: string;
  title: string;
  /** The file, as far as the server knows it; the player reads its tracks itself. */
  file: GuestFile;
  /** The host's artwork for it, where the host's server has the item. */
  artwork?: GuestArtwork;
  /** Where the title is (the long poll): resolved and opened, being resolved, or failed. */
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
    readonly token: string
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
          // Why, where the server knows: source_failed, session_restarted, ...
          code: typeof data.code === 'string' ? data.code : undefined,
        }
      );
    return data as unknown as T;
  }
  /**
   * The title the party plays. With `after` (the token of the last answer), a long poll: answered
   * when it changes (a title, a version, a failure, a recovery), within 25 s. A title still being
   * resolved answers `resolving` at once, without its file.
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
  /**
   * The file the party plays, for the player to read directly: the guest's session and the
   * revision it plays, which the server checks on every read (a new title or version ends it).
   */
  mediaUrl(revision: string): string {
    const query = new URLSearchParams({ token: this.token, revision });
    return `${this.base}/media/original?${query}`;
  }
}
export function guestBase() {
  return `${window.location.origin}${window.location.pathname.replace(/\/watch\/?$/, '')}/party/guest`;
}
