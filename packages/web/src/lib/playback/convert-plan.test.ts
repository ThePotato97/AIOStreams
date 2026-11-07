/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { describe, expect, it } from 'vitest';
import { afterOpenError, MAX_WAIT_MS } from './convert-plan';

describe('afterOpenError', () => {
  it('waits for a file that is still downloading, as long as the server says', () => {
    expect(
      afterOpenError(
        {
          status: 425,
          retryAfter: 10,
          message: 'The file is still downloading',
        },
        0,
        0
      )
    ).toEqual({ action: 'wait', ms: 10_000 });
  });
  it('waits for a busy service too', () => {
    expect(afterOpenError({ status: 503, retryAfter: 15 }, 3, 30_000)).toEqual({
      action: 'wait',
      ms: 15_000,
    });
  });
  it('waits for a restarting transcoder, as the server says', () => {
    expect(
      afterOpenError(
        { status: 503, retryAfter: 5, code: 'transcoder_unreachable' },
        2,
        10_000
      )
    ).toEqual({ action: 'wait', ms: 5_000 });
  });
  it('fails once the download has been waited for too long', () => {
    expect(
      afterOpenError(
        {
          status: 425,
          retryAfter: 10,
          message: 'The file is still downloading',
        },
        40,
        MAX_WAIT_MS - 5_000
      )
    ).toEqual({ action: 'fail', reason: 'The file is still downloading' });
  });
  it('retries a failed request twice, then fails', () => {
    expect(afterOpenError({ message: 'Failed to fetch' }, 0, 0)).toEqual({
      action: 'wait',
      ms: 2_000,
    });
    expect(afterOpenError({ message: 'Failed to fetch' }, 1, 2_000)).toEqual({
      action: 'wait',
      ms: 2_000,
    });
    expect(afterOpenError({ message: 'Failed to fetch' }, 2, 4_000)).toEqual({
      action: 'fail',
      reason: 'Failed to fetch',
    });
  });
  it('fails on a source or probe failure, keeping the reason', () => {
    expect(
      afterOpenError(
        {
          status: 502,
          message:
            'Source probe failed: Invalid data found when processing input',
        },
        0,
        0
      )
    ).toEqual({
      action: 'fail',
      reason: 'Source probe failed: Invalid data found when processing input',
    });
    expect(afterOpenError({ status: 401 }, 0, 0)).toEqual({
      action: 'fail',
      reason: undefined,
    });
  });
  it('fails on a 503 without a retry time (no transcoder set up)', () => {
    expect(
      afterOpenError({ status: 503, message: 'Conversion is not set up' }, 0, 0)
    ).toEqual({ action: 'fail', reason: 'Conversion is not set up' });
  });
});
