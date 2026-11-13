/*
 * Which media buffer the browser rejected. A MediaSource failure reaches the player through Shaka
 * without saying which stream (audio or video) it was, but the SourceBuffer that failed fires its
 * own error event: recorded here with the type it was created for.
 *
 * Once one buffer fails the media pipeline stops, and the other buffer's append in progress can
 * fail after it, so it's the first failure of a burst that says what went wrong (and the one
 * Shaka reports), not the last.
 */

export interface BufferError {
  /** The SourceBuffer's type, e.g. `video/mp4; codecs="hvc1.2.4.L153.B0"`. */
  mimeType: string;
  /** performance.now() when it failed. */
  at: number;
}

/** How long after a failure the other buffers' failures count as its consequences. */
const BURST_MS = 5000;

let first: BufferError | null = null;
let installed = false;

/** Records the errors of every SourceBuffer created from now on (once per page). */
export function watchBufferErrors() {
  if (installed || typeof MediaSource === 'undefined') return;
  installed = true;
  const sources = [
    MediaSource,
    (globalThis as { ManagedMediaSource?: typeof MediaSource })
      .ManagedMediaSource,
  ];
  for (const source of sources) {
    if (!source) continue;
    const add = source.prototype.addSourceBuffer;
    source.prototype.addSourceBuffer = function (
      this: MediaSource,
      mimeType: string
    ) {
      const buffer = add.call(this, mimeType);
      buffer.addEventListener('error', () => {
        const now = performance.now();
        if (!first || now - first.at > BURST_MS) first = { mimeType, at: now };
      });
      return buffer;
    };
  }
}

/** The SourceBuffer that failed first in the last burst of failures, within `withinMs`. */
export function lastBufferError(withinMs = BURST_MS): BufferError | null {
  return first && performance.now() - first.at <= withinMs ? first : null;
}

/** Forgets the last failure (a new stream starts). */
export function clearBufferError() {
  first = null;
}
