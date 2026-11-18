import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import type { SourceInfo } from '@/lib/jellyfin/types';

/** What the server's playback check answers. */
interface CheckAnswer {
  ok: boolean;
  /** An entry that does something (a library refresh) instead of playing. */
  action?: boolean;
  message?: string;
  error?: { code?: string; message?: string };
}

/**
 * Thrown by {@link checkPlayable} for an entry that was an action: it ran, its
 * message is shown, and there's nothing to play. Callers stay where they are
 * and show nothing more.
 */
export class PlaybackActionDone extends Error {}

/** Whether an error from playing something is only {@link PlaybackActionDone}. */
export const isActionDone = (error: unknown): boolean =>
  error instanceof PlaybackActionDone;

function reason(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case 'DOWNLOADING':
      return t`This version is still downloading to the service. Try again shortly.`;
    case 'NO_MATCHING_FILE':
      return t`This version doesn't contain the file for this title.`;
    case 'DOWNLOAD_FAILED':
    case 'GONE':
    case 'UNPROCESSABLE_ENTITY':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'STORE_MAGNET_INVALID':
    case 'BAD_GATEWAY':
      return t`This version can't be played: the release is broken or no longer available.`;
    case 'PAYMENT_REQUIRED':
      return t`The service needs an active subscription to play this version.`;
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return t`The service refused this version: check its credentials.`;
    case 'TOO_MANY_REQUESTS':
    case 'TOO_MANY_ACTIVE_CONNECTIONS':
    case 'STORE_LIMIT_EXCEEDED':
      return t`The service is at its limit right now. Try again shortly.`;
    default:
      return message || t`This version can't be played.`;
  }
}

/**
 * Asks the server whether a version will play before leaving for the player,
 * so a broken one fails here with the reason rather than as an error video.
 * Versions without a check, and checks that can't be reached, go ahead.
 */
export async function checkPlayable(source: SourceInfo): Promise<void> {
  const url = source.aiostreams?.checkUrl;
  if (!url) return;
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    return;
  }
  const answer = (await response
    .json()
    .catch(() => null)) as CheckAnswer | null;
  if (response.ok) {
    if (answer?.action) {
      toast.success(answer.message || t`Done`);
      throw new PlaybackActionDone();
    }
    return;
  }
  if (!answer || answer.ok !== false) return;
  throw new Error(reason(answer.error?.code, answer.error?.message));
}
