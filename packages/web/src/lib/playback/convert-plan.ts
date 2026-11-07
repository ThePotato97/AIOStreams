/*
 * What the player does when a conversion can't start. A file still
 * downloading (425), a busy or restarting transcoder (503 with a retry time)
 * is waited for, as the server says; a network blip is retried; anything else
 * fails, and the player says why and offers to play without the audio.
 */

export type OpenPlan =
  { action: 'wait'; ms: number } | { action: 'fail'; reason?: string };

export interface OpenError {
  status?: number;
  retryAfter?: number;
  message?: string;
  /** The server's code for the cause, such as transcoder_unreachable. */
  code?: string;
}

/** The longest a download is waited for before playing directly. */
export const MAX_WAIT_MS = 5 * 60_000;
const NETWORK_RETRIES = 2;
const NETWORK_RETRY_MS = 2_000;
const DEFAULT_RETRY_MS = 10_000;

export function afterOpenError(
  error: OpenError,
  attempt: number,
  waitedMs: number
): OpenPlan {
  // The server's own words; the player has its own default when there are none.
  const reason = error.message || undefined;
  // A 503 without a retry time (no transcoder set up, or full) won't clear.
  if (
    error.status === 425 ||
    (error.status === 503 && error.retryAfter != null)
  ) {
    const ms = Math.max(1, error.retryAfter ?? DEFAULT_RETRY_MS / 1000) * 1000;
    return waitedMs + ms <= MAX_WAIT_MS
      ? { action: 'wait', ms }
      : { action: 'fail', reason };
  }
  // No status: the request itself failed (offline, server restarting).
  if (error.status == null && attempt < NETWORK_RETRIES)
    return { action: 'wait', ms: NETWORK_RETRY_MS };
  return { action: 'fail', reason };
}
