/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it, vi } from 'vitest';

describe('the media buffer the browser rejected', () => {
  it('is the first to fail, not the one whose append failed after it', async () => {
    const buffers: EventTarget[] = [];
    class FakeMediaSource {
      addSourceBuffer(_type: string) {
        const b = new EventTarget();
        buffers.push(b);
        return b;
      }
    }
    vi.stubGlobal('MediaSource', FakeMediaSource);
    const { watchBufferErrors, lastBufferError, clearBufferError } =
      await import('./media-errors');
    watchBufferErrors();
    const ms = new FakeMediaSource() as unknown as MediaSource;
    const audio = ms.addSourceBuffer('audio/mp4; codecs="flac"');
    const video = ms.addSourceBuffer('video/mp4; codecs="hvc1.2.4.H153.90"');
    audio.dispatchEvent(new Event('error'));
    video.dispatchEvent(new Event('error'));
    expect(lastBufferError()?.mimeType).toBe('audio/mp4; codecs="flac"');
    clearBufferError();
    expect(lastBufferError()).toBeNull();
    video.dispatchEvent(new Event('error'));
    expect(lastBufferError()?.mimeType).toBe(
      'video/mp4; codecs="hvc1.2.4.H153.90"'
    );
    vi.unstubAllGlobals();
  });
});
