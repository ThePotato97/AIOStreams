import { describe, expect, it, vi } from 'vitest';

vi.mock('@aiostreams/core', () => ({
  constants: { PLAYBACK_CHECK_MARKER: 'check', PLAY_PATH_MARKER: 'via' },
}));

const { sendPlaybackError, wantsRealErrors } =
  await import('./static-errors.js');

function response() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    location: undefined as string | undefined,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    redirect(code: number, location: string) {
      res.statusCode = code;
      res.location = location;
    },
  };
  return res;
}

const request = (query: Record<string, string>) => ({ query }) as never;

describe('playback errors', () => {
  it('sends a Stremio player the video that stands in for the error', () => {
    const res = response();
    sendPlaybackError(request({}), res as never, {
      code: 'DOWNLOAD_FAILED',
      message: 'dead',
    });
    expect(res.statusCode).toBe(307);
    expect(res.location).toBe('/static/download_failed.mp4');
  });

  it('answers AIOStreams’ apps with the error itself', () => {
    const queries: Record<string, string>[] = [
      { via: 'jellyfin' },
      { check: '1' },
    ];
    for (const query of queries) {
      expect(wantsRealErrors(request(query))).toBe(true);
      const res = response();
      sendPlaybackError(request(query), res as never, {
        code: 'NO_MATCHING_FILE',
        message: 'not in the release',
      });
      expect(res.statusCode).toBe(404);
      expect(res.location).toBeUndefined();
      expect(res.body).toEqual({
        ok: false,
        error: { code: 'NO_MATCHING_FILE', message: 'not in the release' },
      });
    }
  });

  it('treats a link listed for Stremio as Stremio’s', () => {
    expect(wantsRealErrors(request({ via: 'stremio' }))).toBe(false);
  });
});
