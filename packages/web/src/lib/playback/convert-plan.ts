/*
 * What the player does when a conversion can't start. A file still
 * downloading (425) or a busy service (503) is waited for, as the server
 * says; a network blip is retried; anything else plays the file directly,
 * which at worst means no sound, rather than no picture.
 */

export type OpenPlan =
  { action: 'wait'; ms: number } | { action: 'direct'; reason?: string };

export interface OpenError {
  status?: number;
  retryAfter?: number;
  message?: string;
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
  if (error.status === 425 || error.status === 503) {
    const ms = Math.max(1, error.retryAfter ?? DEFAULT_RETRY_MS / 1000) * 1000;
    return waitedMs + ms <= MAX_WAIT_MS
      ? { action: 'wait', ms }
      : { action: 'direct', reason };
  }
  // No status: the request itself failed (offline, server restarting).
  if (error.status == null && attempt < NETWORK_RETRIES)
    return { action: 'wait', ms: NETWORK_RETRY_MS };
  return { action: 'direct', reason };
}
