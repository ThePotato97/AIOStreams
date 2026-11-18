import type { Request, Response } from 'express';
import { constants } from '@aiostreams/core';

export enum StaticFiles {
  DOWNLOAD_FAILED = 'download_failed.mp4',
  DOWNLOADING = 'downloading.mp4',
  UNAVAILABLE_FOR_LEGAL_REASONS = 'unavailable_for_legal_reasons.mp4',
  STORE_LIMIT_EXCEEDED = 'store_limit_exceeded.mp4',
  CONTENT_PROXY_LIMIT_REACHED = 'content_proxy_limit_reached.mp4',
  INTERNAL_SERVER_ERROR = '500.mp4',
  TOO_MANY_REQUESTS = '429.mp4',
  FORBIDDEN = '403.mp4',
  UNAUTHORIZED = '401.mp4',
  NO_MATCHING_FILE = 'no_matching_file.mp4',
  PAYMENT_REQUIRED = 'payment_required.mp4',
  OK = '200.mp4',
}

/**
 * Map a DebridError code to the fallback video served in its place. Playback
 * endpoints answer a player, so a failure has to be watchable to be legible.
 */
export function mapDebridErrorToStaticFile(code: string | undefined): string {
  switch (code) {
    case 'UNAVAILABLE_FOR_LEGAL_REASONS':
      return StaticFiles.UNAVAILABLE_FOR_LEGAL_REASONS;
    case 'STORE_LIMIT_EXCEEDED':
      return StaticFiles.STORE_LIMIT_EXCEEDED;
    case 'PAYMENT_REQUIRED':
      return StaticFiles.PAYMENT_REQUIRED;
    case 'TOO_MANY_ACTIVE_CONNECTIONS':
      return StaticFiles.CONTENT_PROXY_LIMIT_REACHED;
    case 'TOO_MANY_REQUESTS':
      return StaticFiles.TOO_MANY_REQUESTS;
    case 'FORBIDDEN':
      return StaticFiles.FORBIDDEN;
    case 'UNAUTHORIZED':
      return StaticFiles.UNAUTHORIZED;
    case 'UNPROCESSABLE_ENTITY':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'STORE_MAGNET_INVALID':
    case 'DOWNLOAD_FAILED':
    case 'BAD_GATEWAY':
    case 'GONE':
      return StaticFiles.DOWNLOAD_FAILED;
    case 'NO_MATCHING_FILE':
      return StaticFiles.NO_MATCHING_FILE;
    case 'SERVICE_UNAVAILABLE':
      return StaticFiles.DOWNLOAD_FAILED;
    case 'TIMEOUT':
      return StaticFiles.DOWNLOADING;
    default:
      return StaticFiles.INTERNAL_SERVER_ERROR;
  }
}

/**
 * Whether the request is from AIOStreams' own apps: a playback check, or a
 * link listed for the Jellyfin path, which the apps play through. These get a
 * real error rather than a video, which only a Stremio player needs.
 */
export function wantsRealErrors(req: Request<any>): boolean {
  return (
    req.query[constants.PLAYBACK_CHECK_MARKER] !== undefined ||
    req.query[constants.PLAY_PATH_MARKER] === 'jellyfin'
  );
}

/** HTTP status for a DebridError code, answered as a real error. */
export function statusForDebridError(code: string | undefined): number {
  switch (code) {
    case 'UNAVAILABLE_FOR_LEGAL_REASONS':
      return 451;
    case 'PAYMENT_REQUIRED':
      return 402;
    case 'TOO_MANY_ACTIVE_CONNECTIONS':
    case 'TOO_MANY_REQUESTS':
      return 429;
    case 'FORBIDDEN':
      return 403;
    case 'UNAUTHORIZED':
      return 401;
    case 'NO_MATCHING_FILE':
      return 404;
    case 'GONE':
      return 410;
    case 'SERVICE_UNAVAILABLE':
      return 503;
    case 'TIMEOUT':
    case 'DOWNLOADING':
      return 409;
    case 'INTERNAL_SERVER_ERROR':
      return 500;
    default:
      return 422;
  }
}

/**
 * A playback failure: for AIOStreams' own apps the error as JSON
 * (`{ ok: false, error: { code, message } }`), for anyone else the video that
 * stands in for it.
 */
export function sendPlaybackError(
  req: Request<any>,
  res: Response,
  error: { code?: string; message: string; file?: string },
  redirectStatus: 302 | 307 = 307
): void {
  res.setHeader('Cache-Control', 'no-store');
  if (wantsRealErrors(req)) {
    res.status(statusForDebridError(error.code)).json({
      ok: false,
      error: { code: error.code, message: error.message },
    });
    return;
  }
  res.redirect(
    redirectStatus,
    `/static/${error.file ?? mapDebridErrorToStaticFile(error.code)}`
  );
}
