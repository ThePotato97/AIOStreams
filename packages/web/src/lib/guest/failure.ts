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
  /** What the browser or Shaka reported, for the error shown. */
  detail: string;
  /** The server's status, for a request it refused. */
  status?: number;
}

/** The parts of a Shaka Player error (shaka.util.Error) this reads. */
export interface ShakaError {
  category: number;
  code: number;
  severity?: number;
  data?: unknown[];
}

const NETWORK = 1,
  MEDIA = 3,
  MANIFEST = 4,
  PLAYER = 7;
export const CRITICAL = 2;
/** Shaka's names for the codes reported here. */
const NAMES: Record<number, string> = {
  1001: 'BAD_HTTP_STATUS',
  1002: 'HTTP_ERROR',
  1003: 'TIMEOUT',
  3014: 'MEDIA_SOURCE_OPERATION_FAILED',
  3015: 'MEDIA_SOURCE_OPERATION_THREW',
  3016: 'VIDEO_ERROR',
  3018: 'TRANSMUXING_FAILED',
  4012: 'RESTRICTIONS_CANNOT_BE_MET',
  4032: 'CONTENT_UNSUPPORTED_BY_BROWSER',
};
/** No stream the browser can decode: as much a decoding failure as a media error. */
const UNDECODABLE = new Set([4012, 4032]);

/** Whether a Shaka error only says a load was cut short by another, or by closing. */
export function interrupted(error: ShakaError): boolean {
  return (
    error.category === PLAYER && (error.code === 7000 || error.code === 7003)
  );
}

/** A failure reported by Shaka Player. */
export function shakaFailure(error: ShakaError): Failure {
  // BAD_HTTP_STATUS carries the URI, then the status.
  const status =
    error.code === 1001 && typeof error.data?.[1] === 'number'
      ? (error.data[1] as number)
      : undefined;
  const kind: FailureKind =
    error.category === NETWORK
      ? 'network'
      : error.category === MEDIA ||
          (error.category === MANIFEST && UNDECODABLE.has(error.code))
        ? 'media'
        : 'other';
  return {
    kind,
    status,
    detail: [
      NAMES[error.code] ?? `Shaka error ${error.code}`,
      status && `HTTP ${status}`,
    ]
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

/** What the player tries before the failure is reported. */
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
