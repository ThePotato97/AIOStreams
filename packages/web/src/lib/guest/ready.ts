/** A wait that ends early when the signal aborts. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/**
 * Fetches a file the server may still be preparing (a subtitle extracted
 * from the whole source): 425 or 503 with Retry-After mean "come back".
 */
export async function whenReady(
  url: string,
  signal: AbortSignal
): Promise<Response> {
  for (;;) {
    const res = await fetch(url, { signal });
    if (res.status !== 425 && res.status !== 503) return res;
    const after = Number(res.headers.get('retry-after')) || 5;
    await sleep(after * 1000, signal);
  }
}
