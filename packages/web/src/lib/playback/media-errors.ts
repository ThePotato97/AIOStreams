/*
 * Which media buffer the browser rejected. A MediaSource failure reaches the player through Shaka
 * without saying which stream (audio or video) it was, but the SourceBuffer that failed fires its
 * own error event: recorded here with the type it was created for.
 */

export interface BufferError {
  /** The SourceBuffer's type, e.g. `video/mp4; codecs="hvc1.2.4.L153.B0"`. */
  mimeType: string;
  /** performance.now() when it failed. */
  at: number;
}

let last: BufferError | null = null;
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
        last = { mimeType, at: performance.now() };
      });
      return buffer;
    };
  }
}

/** The SourceBuffer that failed within the last `withinMs`, if one did. */
export function lastBufferError(withinMs = 5000): BufferError | null {
  return last && performance.now() - last.at <= withinMs ? last : null;
}

/** Forgets the last failure (a new stream starts). */
export function clearBufferError() {
  last = null;
}
