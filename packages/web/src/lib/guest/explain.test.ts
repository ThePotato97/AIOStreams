/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it, vi } from 'vitest';
import { explainFailure } from './explain';

vi.mock('@lingui/core/macro', () => ({
  t: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v),
}));

describe('failures as the viewer reads them', () => {
  it('say which stream the browser rejected, with its reason, then the codes', () => {
    expect(
      explainFailure({
        kind: 'media',
        detail: 'MEDIA_SOURCE_OPERATION_FAILED',
        media: {
          stream: 'video',
          codecs: 'hvc1.2.4.L153.B0',
          element: 'MEDIA_ERR_DECODE',
          browser: 'PIPELINE_ERROR_DECODE: VDA error',
          segment: 'chunk-0-00069.m4s',
        },
      })
    ).toBe(
      "Your browser couldn't decode the video (hvc1.2.4.L153.B0): PIPELINE_ERROR_DECODE: VDA error [MEDIA_ERR_DECODE, chunk-0-00069.m4s, MEDIA_SOURCE_OPERATION_FAILED]"
    );
  });
  it('say what they can when the browser gives no reason', () => {
    expect(
      explainFailure({
        kind: 'media',
        detail: 'MEDIA_SOURCE_OPERATION_FAILED',
        media: { stream: 'audio', codecs: 'flac', element: 'MEDIA_ERR_DECODE' },
      })
    ).toBe(
      "Your browser couldn't decode the audio (flac): MEDIA_ERR_DECODE [MEDIA_SOURCE_OPERATION_FAILED]"
    );
    expect(
      explainFailure({
        kind: 'media',
        detail: 'MEDIA_SOURCE_OPERATION_FAILED',
        media: {},
      })
    ).toBe(
      "Your browser couldn't decode the stream [MEDIA_SOURCE_OPERATION_FAILED]"
    );
  });
  it('say a stream that could not be fetched was not fetched', () => {
    expect(
      explainFailure({
        kind: 'network',
        status: 503,
        detail: 'BAD_HTTP_STATUS, HTTP 503',
      })
    ).toBe("The stream couldn't be fetched [BAD_HTTP_STATUS, HTTP 503]");
  });
});
