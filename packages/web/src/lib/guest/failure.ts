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
  /** What the browser or Shaka reported (its codes), for the error shown. */
  detail: string;
  /** The server's status, for a request it refused. */
  status?: number;
  /** What the browser rejected, where it rejected media: for the error shown. */
  media?: MediaFailure;
}

/** The facts of a media failure the browser gives. */
export interface MediaFailure {
  /** The stream whose buffer failed, and its codecs, where known. */
  stream?: 'audio' | 'video';
  codecs?: string;
  /** The media element's own error: its code's name and the browser's message. */
  element?: string;
  browser?: string;
  /** The segment being appended, where it wasn't an init segment. */
  segment?: string;
}

/** What the page knew when Shaka reported a media failure. */
export interface MediaContext {
  /** The media element's error, once the browser has set it. */
  element?: { code: number; message?: string } | null;
  /** The type of the SourceBuffer that fired an error (media-errors.ts). */
  buffer?: { mimeType: string } | null;
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

/** The media element's error codes. */
const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

/** A URL's file name, without its query: which segment, of which stream. */
const fileName = (uri: unknown) =>
  typeof uri === 'string' ? (uri.split('?')[0].split('/').pop() ?? '') : '';

/** Shaka's media failures where the browser rejected what was appended. */
const REJECTED = new Set([3014, 3015, 3016]);
/** Whether the browser rejected media: its element error, if not set yet, follows shortly. */
export const rejectedMedia = (error: ShakaError) => REJECTED.has(error.code);

/** A failure reported by Shaka Player; for a media failure, with what the page knew. */
export function shakaFailure(
  error: ShakaError,
  context: MediaContext = {}
): Failure {
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
  const failure: Failure = {
    kind,
    status,
    detail: [
      NAMES[error.code] ?? `Shaka error ${error.code}`,
      status && `HTTP ${status}`,
    ]
      .filter(Boolean)
      .join(', '),
  };
  if (REJECTED.has(error.code)) {
    const mime = context.buffer?.mimeType ?? '';
    const element = context.element;
    const data = error.data ?? [];
    // MEDIA_SOURCE_OPERATION_FAILED and VIDEO_ERROR carry the element's code first;
    // VIDEO_ERROR then Edge's extended code and Chrome's details.
    const code =
      element?.code ??
      (error.code !== 3015 && typeof data[0] === 'number'
        ? data[0]
        : undefined);
    // MEDIA_SOURCE_OPERATION_THREW carries what the browser threw.
    const thrown = data[0] as { name?: string; message?: string } | undefined;
    const browser =
      element?.message ||
      (error.code === 3016 &&
        [data[2], data[1]]
          .filter((v) => typeof v === 'string' && v)
          .join(', ')) ||
      (error.code === 3015 &&
        thrown &&
        [thrown.name, thrown.message].filter(Boolean).join(': ')) ||
      undefined;
    failure.media = {
      stream: mime.startsWith('video/')
        ? 'video'
        : mime.startsWith('audio/')
          ? 'audio'
          : undefined,
      codecs: /codecs="?([^";]+)/.exec(mime)?.[1],
      element: code ? MEDIA_ERROR_NAMES[code] : undefined,
      browser,
      segment: (error.code === 3014 && fileName(error.data?.[1])) || undefined,
    };
  }
  return failure;
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
