/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  elementFailure,
  hlsFailure,
  hlsPlayer,
  recovery,
  MEDIA_RECOVERIES,
  NETWORK_RECOVERIES,
} from './failure';

describe('hlsPlayer', () => {
  it('uses hls.js in Chrome, which claims HLS but fails on some streams', () => {
    expect(
      hlsPlayer({ native: true, managedMediaSource: false, hlsJs: true })
    ).toBe('hls.js');
  });
  it("uses Safari's own player", () => {
    expect(
      hlsPlayer({ native: true, managedMediaSource: true, hlsJs: true })
    ).toBe('native');
  });
  it('falls back to the native player where hls.js cannot run', () => {
    expect(
      hlsPlayer({ native: true, managedMediaSource: false, hlsJs: false })
    ).toBe('native');
    expect(
      hlsPlayer({ native: false, managedMediaSource: false, hlsJs: false })
    ).toBeNull();
  });
});

describe('failures', () => {
  it('keeps what hls.js reported', () => {
    expect(
      hlsFailure({
        type: 'networkError',
        details: 'fragLoadError',
        fatal: true,
        response: { code: 404 },
      })
    ).toEqual({
      kind: 'network',
      status: 404,
      detail: 'fragLoadError, HTTP 404',
    });
    expect(
      hlsFailure({
        type: 'mediaError',
        details: 'bufferAppendError',
        fatal: true,
      })
    ).toEqual({
      kind: 'media',
      status: undefined,
      detail: 'bufferAppendError',
    });
    // A network error with no answer at all has code 0.
    expect(
      hlsFailure({
        type: 'networkError',
        details: 'fragLoadTimeOut',
        fatal: true,
        response: { code: 0 },
      }).status
    ).toBeUndefined();
  });
  it("keeps the element's error code and message", () => {
    expect(
      elementFailure({ code: 3, message: 'PIPELINE_ERROR_DECODE' })
    ).toEqual({
      kind: 'media',
      detail: 'MEDIA_ERR_DECODE: PIPELINE_ERROR_DECODE',
    });
    expect(elementFailure({ code: 2 }).kind).toBe('network');
    expect(elementFailure({ code: 4 }).kind).toBe('media');
    expect(elementFailure(null)).toEqual({
      kind: 'other',
      detail: 'unknown media error',
    });
  });
});

describe('recovery', () => {
  const network = { kind: 'network' as const, detail: 'fragLoadError' };
  const media = { kind: 'media' as const, detail: 'bufferAppendError' };
  it('reloads a stream it could not fetch, a few times', () => {
    expect(recovery(network, { network: 0, media: 0 })).toBe('reload');
    expect(
      recovery(network, { network: NETWORK_RECOVERIES - 1, media: 0 })
    ).toBe('reload');
    expect(recovery(network, { network: NETWORK_RECOVERIES, media: 0 })).toBe(
      'give-up'
    );
  });
  it('does not reload a playback the server dropped', () => {
    expect(
      recovery({ ...network, status: 410 }, { network: 0, media: 0 })
    ).toBe('give-up');
    expect(
      recovery({ ...network, status: 401 }, { network: 0, media: 0 })
    ).toBe('give-up');
  });
  it('recovers decoding in place before giving up', () => {
    expect(recovery(media, { network: 0, media: 0 })).toBe('recover-media');
    expect(recovery(media, { network: 0, media: MEDIA_RECOVERIES })).toBe(
      'give-up'
    );
  });
  it('gives up on anything else', () => {
    expect(
      recovery({ kind: 'other', detail: 'x' }, { network: 0, media: 0 })
    ).toBe('give-up');
  });
});

describe('afterFailure', () => {
  const guest = { forced: false, convertOnDecodeError: true };
  it('converts everything only for a stream the browser cannot decode', () => {
    expect(afterFailure({ kind: 'media', detail: '' }, guest)).toBe(
      'convert-all'
    );
    expect(afterFailure({ kind: 'network', detail: '' }, guest)).toBe('fail');
    expect(afterFailure({ kind: 'other', detail: '' }, guest)).toBe('fail');
  });
  it('converts everything once at most', () => {
    expect(
      afterFailure({ kind: 'media', detail: '' }, { ...guest, forced: true })
    ).toBe('fail');
  });
  it('never converts everything where it is off', () => {
    expect(
      afterFailure(
        { kind: 'media', detail: '' },
        { forced: false, convertOnDecodeError: false }
      )
    ).toBe('fail');
  });
});
