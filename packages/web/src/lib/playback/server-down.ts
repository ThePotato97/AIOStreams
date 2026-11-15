import { unreachable } from '@/lib/jellyfin/connection';

/** What a proxy answers for a server that is down or restarting. */
const DOWN = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);

const PROBE_MS = 5_000;

/**
 * Whether the file's server stopped answering, asked after an engine failed: a server
 * restarting fails every engine, which would otherwise blame the browser. False when it
 * answers, or when the browser can't tell (another site's file, unreadable without CORS).
 */
export async function serverDown(
  url: string,
  headers: Record<string, string> | undefined,
  serverBase: string
): Promise<boolean> {
  let down: boolean;
  try {
    const res = await fetch(url, {
      headers: { ...headers, Range: 'bytes=0-0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_MS),
    });
    void res.body?.cancel().catch(() => {});
    down = DOWN.has(res.status);
  } catch {
    down = sameOrigin(url, serverBase);
  }
  // The app's own banner then says so, and asks again until the server is back.
  if (down) unreachable();
  return down;
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return (
      new URL(url, location.href).origin === new URL(base, location.href).origin
    );
  } catch {
    return false;
  }
}
