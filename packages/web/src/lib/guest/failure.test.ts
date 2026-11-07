/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  elementFailure,
  interrupted,
  shakaFailure,
  recovery,
  MEDIA_RECOVERIES,
  NETWORK_RECOVERIES,
} from './failure';

describe('failures', () => {
  it('keeps what Shaka reported, with the status of a refused request', () => {
    expect(
      shakaFailure({
        category: 1,
        code: 1001,
        severity: 2,
        data: ['https://aio.example/chunk-0-00069.m4s', 404, '', {}],
      })
    ).toEqual({
      kind: 'network',
      status: 404,
      detail: 'BAD_HTTP_STATUS, HTTP 404',
    });
    expect(shakaFailure({ category: 1, code: 1003 })).toEqual({
      kind: 'network',
      status: undefined,
      detail: 'TIMEOUT',
    });
    expect(shakaFailure({ category: 3, code: 3016 }).kind).toBe('media');
    // Unknown codes are named by number.
    expect(shakaFailure({ category: 5, code: 5999 })).toEqual({
      kind: 'other',
      status: undefined,
      detail: 'Shaka error 5999',
    });
  });
  it('treats a manifest the browser can decode nothing of as a decoding failure', () => {
    // The only video is a codec this browser lacks: converting it changes that.
    expect(shakaFailure({ category: 4, code: 4032 }).kind).toBe('media');
    expect(shakaFailure({ category: 4, code: 4012 }).kind).toBe('media');
    // A manifest that won't parse is not.
    expect(shakaFailure({ category: 4, code: 4001 }).kind).toBe('other');
  });
  it('knows a load cut short by another, or by closing', () => {
    expect(interrupted({ category: 7, code: 7000 })).toBe(true);
    expect(interrupted({ category: 7, code: 7003 })).toBe(true);
    expect(interrupted({ category: 1, code: 7000 })).toBe(false);
    expect(interrupted({ category: 1, code: 1001 })).toBe(false);
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
