/* eslint-disable lingui/no-unlocalized-strings -- error codes and MIME types, not UI text. */
/*
 * How a converted (or forwarded) stream recovers when playback fails. A blip
 * fetching the stream is retried, a hiccup decoding it is recovered in place,
 * and only a stream the browser really can't decode is converted in full.
 */

/** Why playback stopped: the stream couldn't be fetched, or decoded. */
export type FailureKind = 'network' | 'media' | 'other';

export interface Failure {
  kind: FailureKind;
  /** What the browser or hls.js reported, for the error shown. */
  detail: string;
  /** The server's status, for a request it refused. */
  status?: number;
}

/** The parts of an hls.js error this reads. */
export interface HlsError {
  type: string;
  details: string;
  fatal: boolean;
  response?: { code?: number };
  error?: { message?: string };
}

/** A failure reported by hls.js. */
export function hlsFailure(data: HlsError): Failure {
  const status = data.response?.code || undefined;
  const kind: FailureKind =
    data.type === 'networkError'
      ? 'network'
      : data.type === 'mediaError'
        ? 'media'
        : 'other';
  return {
    kind,
    status,
    detail: [data.details, status && `HTTP ${status}`]
      .filter(Boolean)
      .join(', '),
  };
}

const ELEMENT_ERRORS: Record<number, [FailureKind, string]> = {
  1: ['other', 'MEDIA_ERR_ABORTED'],
  2: ['network', 'MEDIA_ERR_NETWORK'],
  3: ['media', 'MEDIA_ERR_DECODE'],
  4: ['media', 'MEDIA_ERR_SRC_NOT_SUPPORTED'],
};

/** A failure reported by the `<video>` element itself. */
export function elementFailure(
  error: { code: number; message?: string } | null | undefined
): Failure {
  const [kind, name] = (error && ELEMENT_ERRORS[error.code]) ?? [
    'other',
    'unknown media error',
  ];
  return {
    kind,
    detail: [name, error?.message].filter(Boolean).join(': '),
  };
}

/** Statuses that mean the playback itself is gone, which no retry fixes. */
export function sessionGone(status: number | undefined): boolean {
  return status === 401 || status === 410;
}

export const NETWORK_RECOVERIES = 3;
export const MEDIA_RECOVERIES = 2;

/** Recoveries tried so far; reset once a fragment plays again. */
export interface Tries {
  network: number;
  media: number;
}

export type Recovery = 'reload' | 'recover-media' | 'give-up';

/** What hls.js tries before the failure is reported. */
export function recovery(failure: Failure, tries: Tries): Recovery {
  if (failure.kind === 'network' && !sessionGone(failure.status))
    return tries.network < NETWORK_RECOVERIES ? 'reload' : 'give-up';
  if (failure.kind === 'media')
    return tries.media < MEDIA_RECOVERIES ? 'recover-media' : 'give-up';
  return 'give-up';
}

/**
 * After recovery gave up: convert everything only when the browser couldn't
 * decode what it was sent, which a full conversion changes. A stream that
 * couldn't be fetched would fail the same way converted.
 */
export function afterFailure(
  failure: Failure,
  state: { forced: boolean; convertOnDecodeError: boolean }
): 'convert-all' | 'fail' {
  return failure.kind === 'media' && !state.forced && state.convertOnDecodeError
    ? 'convert-all'
    : 'fail';
}

/**
 * Which player opens an HLS stream. hls.js, wherever it runs: browsers that
 * also claim to play HLS themselves (Chrome does) fail on some streams.
 * Safari's own player is the exception, being the reference one; it's picked
 * where Safari has ManagedMediaSource, as hls.js advises.
 */
export function hlsPlayer(browser: {
  native: boolean;
  managedMediaSource: boolean;
  hlsJs: boolean;
}): 'native' | 'hls.js' | null {
  if (browser.native && browser.managedMediaSource) return 'native';
  if (browser.hlsJs) return 'hls.js';
  return browser.native ? 'native' : null;
}
