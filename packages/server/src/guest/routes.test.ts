import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const fixture = vi.hoisted(() => ({
  enabled: true,
  playing: { ref: 'encrypted-title', playlistItemId: 'b'.repeat(32) },
  party: 'a'.repeat(22),
  members: [{ id: 'host', key: 'h'.repeat(22) }],
  prepares: [] as { resolve(): void }[],
  slow: false,
  noSources: false,
  memoCalls: 0,
  /** A list run again (`current`) comes back without the version picked from it. */
  rerunLoses: false,
  workerDown: false,
  logs: [] as { level: string; data: unknown; message: string }[],
  // A fake source server, so the pre-probe check sees real HTTP answers.
  upstream: '',
  // This server's internal address: a second port on the same fake server.
  internal: '',
  hits: { public: 0, internal: 0 },
  probeInputs: [] as string[],
  /** The capabilities each prepare forwarded to the transcoder. */
  prepareCapabilities: [] as Record<string, unknown>[],
  sourcePath: '/media/private-token',
  probes: 0,
  probeFailures: 0,
  probeError: 'Source probe failed: Invalid data found when processing input',
  scopes: [] as (string | undefined)[],
  chain: { hits: 0, expireA: false, thenTo: '/media/B' },
  // What the transcoder prepares, and how it sends a segment.
  prepared: { mode: 'direct' } as {
    mode: string;
    id?: string;
    binaural?: boolean;
  },
  segment: 'slow' as 'slow' | 'silent',
  segmentAborts: 0,
  // What the transcoder answers: a full one, released jobs, extraction.
  full: false,
  releases: [] as string[],
  /** What the transcoder answers a heartbeat with: 404 once it no longer has the job. */
  touchStatus: 200,
  extraction: [] as { status: number; body: string }[],
  subtitleCodec: 'subrip',
}));
vi.mock('@aiostreams/core', () => ({
  createLogger: () =>
    Object.fromEntries(
      ['warn', 'error', 'info', 'debug'].map((level) => [
        level,
        (data: unknown, message: string) =>
          fixture.logs.push({ level, data, message }),
      ])
    ),
  config: {
    party: {
      get guestStreaming() {
        return fixture.enabled;
      },
      transcoderUrl: 'http://worker',
      transcoderSecret: 's'.repeat(32),
      get internalUrl() {
        return fixture.internal;
      },
    },
    bootstrap: {
      get baseUrl() {
        return fixture.upstream;
      },
    },
  },
}));
vi.mock('../routes/jellyfin/context.js', () => ({
  userForToken: async (token: string) =>
    token === 'host-token'
      ? { uuid: 'owner', payload: { p: 'password' }, persona: null }
      : null,
  contextFromCredentials: async () => ({
    uuid: 'owner',
    scope: () => 'owner-scope',
  }),
}));
vi.mock('../party/relay.js', () => ({
  guestPartyState: async (id: string) =>
    id === fixture.party
      ? {
          id,
          host: 'host',
          homeUuid: 'owner',
          expiresAt: Date.now() + 3_600_000,
          joinsClosed: false,
          playing: fixture.playing,
          queue: [fixture.playing],
          members: fixture.members,
        }
      : null,
}));
vi.mock('../party/ticket.js', () => ({
  ticketExpiry: () => Date.now() + 60000,
}));
vi.mock('../routes/jellyfin/playback.js', () => ({
  locate: async (req: { jf?: { scope?: () => string } }) => (
    fixture.scopes.push(req.jf?.scope?.()),
    {}
  ),
  ensureMemo: async (_loc: unknown, opts?: { current?: boolean }) => (
    ++fixture.memoCalls,
    {
      // the addons run again no longer return the version (one timed out, say)
      sources:
        fixture.noSources || (fixture.rerunLoses && opts?.current)
          ? []
          : [
              {
                msid: 'source',
                url: /^https?:/.test(fixture.sourcePath)
                  ? fixture.sourcePath
                  : `${fixture.upstream}${fixture.sourcePath}`,
                filename: 'episode.mkv',
                container: 'mkv',
                subtitles: [],
                extension: { bingeGroup: 'series' },
              },
            ],
    }
  ),
}));
import guestRouter, { MEDIA_TIMEOUT, withCredentials } from './routes.js';
/** What the transcoder's DASH muxer writes, trimmed. */
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<MPD type="dynamic" minimumUpdatePeriod="PT4S">
\t<Period id="0" start="PT0.0S">
\t\t<AdaptationSet id="0" contentType="video">
\t\t\t<Representation id="0" mimeType="video/mp4" codecs="hvc1.2.4.L153.B0">
\t\t\t\t<SegmentTemplate timescale="24000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1">
\t\t\t\t\t<SegmentTimeline><S t="240360" d="236208" /></SegmentTimeline>
\t\t\t\t</SegmentTemplate>
\t\t\t</Representation>
\t\t</AdaptationSet>
\t</Period>
</MPD>`;
import { guestSessions } from './sessions.js';
const originalFetch = globalThis.fetch;
let server: Server, base: string;
const media = {
  durationMs: 12000,
  container: 'matroska',
  bitrate: 1000000,
  tracks: [
    { index: 0, type: 'video', codec: 'h264', title: 'Video' },
    {
      index: 2,
      type: 'subtitle',
      get codec() {
        return fixture.subtitleCodec;
      },
      title: 'English',
    },
  ],
  fonts: [{ index: 5, filename: 'Font.ttf', mimetype: 'font/ttf' }],
  chapters: [{ title: 'Opening', startMs: 0 }],
};
const proof = () => ({
  party: fixture.party,
  member: 'host',
  seat: 'h'.repeat(22),
  ticket: 'ticket',
});
async function api(path: string, token = '', body?: unknown) {
  return originalFetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const errorOf = async (response: Response) =>
  ((await response.json()) as { error?: string }).error;
async function invitation() {
  const result = await api('/host', 'host-token', proof());
  expect(result.status).toBe(200);
  await api('/publish', 'host-token', {
    ...proof(),
    entries: [
      {
        ref: fixture.playing.ref,
        itemId: 'c'.repeat(32),
        title: 'Episode',
        sourceId: 'source',
      },
    ],
  });
  return ((await result.json()) as { secret: string }).secret as string;
}
async function guest(secret: string) {
  const result = await api('/exchange', '', { party: fixture.party, secret });
  expect(result.status).toBe(200);
  return ((await result.json()) as { token: string }).token as string;
}
function join(token: string) {
  const session = guestSessions.get(token)!;
  session.member = 'guest';
  fixture.members.push({ id: 'guest', key: 'g'.repeat(22) });
}
let upstream: Server, internalServer: Server;
let filesApp: express.Express;
beforeAll(async () => {
  // What a source can answer: the file, AIOStreams' placeholder clips (as
  // the real playback route redirects to them), an error page, or a 404.
  const files = express();
  files.use((req, _res, next) => {
    const internal =
      String(req.socket.localPort) === fixture.internal.split(':').pop();
    fixture.hits[internal ? 'internal' : 'public']++;
    next();
  });
  files.get('/media/private-token', (_req, res) =>
    res.status(206).type('video/mp4').send('x')
  );
  files.get('/downloading', (_req, res) =>
    res.redirect(307, '/static/downloading.mp4')
  );
  files.get('/failed', (_req, res) =>
    res.redirect(307, `${fixture.upstream}/static/download_failed.mp4`)
  );
  files.get('/static/:file', (_req, res) => res.type('video/mp4').send('x'));
  files.get('/html', (_req, res) => res.type('html').send('<html></html>'));
  // A failover chain: the first resolve picks A, later ones whatever thenTo is.
  files.get('/chain', (_req, res) =>
    res.redirect(
      307,
      `${fixture.upstream}${fixture.chain.hits++ === 0 ? '/media/A' : fixture.chain.thenTo}`
    )
  );
  files.get('/media/:name', (req, res) => {
    if (
      req.params.name === 'A' &&
      fixture.chain.expireA &&
      fixture.chain.hits > 0
    )
      return void res.status(410).end();
    res.status(206).type('video/mp4').send(req.params.name);
  });
  files.get('/loop', (_req, res) => res.redirect(302, '/loop'));
  upstream = files.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => upstream.on('listening', resolve));
  fixture.upstream = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  internalServer = files.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => internalServer.on('listening', resolve));
  fixture.internal = `http://127.0.0.1:${(internalServer.address() as { port: number }).port}`;
  filesApp = files;
  spyFetch();
  const app = express();
  app.use(express.json());
  app.use('/party/guest', guestRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.on('listening', resolve);
    server.on('error', reject);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/party/guest`;
});
function spyFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('http://worker')) return originalFetch(input, init);
    if (fixture.workerDown)
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      });
    if (url.endsWith('/probe')) {
      fixture.probes++;
      fixture.probeInputs.push(
        (JSON.parse(String(init?.body ?? '{}')) as { input: string }).input
      );
      if (fixture.probeFailures > 0) {
        fixture.probeFailures--;
        return Response.json({ error: fixture.probeError }, { status: 400 });
      }
      return Response.json(media);
    }
    if (/\/jobs\/[^/]+\/touch$/.test(url)) {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        release?: boolean;
      };
      if (sent.release) fixture.releases.push(url.split('/').at(-2)!);
      if (fixture.touchStatus !== 200)
        return new Response(null, { status: fixture.touchStatus });
      return Response.json({ ok: true });
    }
    if (url.endsWith('/subtitle') || url.endsWith('/font')) {
      const next = fixture.extraction.shift() ?? {
        status: 200,
        body: 'WEBVTT',
      };
      return new Response(next.body, {
        status: next.status,
        headers: next.status === 425 ? { 'Retry-After': '5' } : {},
      });
    }
    if (url.endsWith('/prepare')) {
      fixture.prepareCapabilities.push(
        (
          JSON.parse(String(init?.body ?? '{}')) as {
            request?: { capabilities?: Record<string, unknown> };
          }
        ).request?.capabilities ?? {}
      );
      if (fixture.full)
        return Response.json(
          {
            error: 'Conversion capacity reached; try Original or retry later',
            retryAfter: 10,
          },
          { status: 503 }
        );
      if (fixture.slow)
        await new Promise<void>((resolve) =>
          fixture.prepares.push({ resolve })
        );
      return Response.json({ ...fixture.prepared, meta: media });
    }
    if (url.endsWith('/manifest.mpd'))
      return new Response(MANIFEST, {
        headers: { 'Content-Type': 'application/dash+xml' },
      });
    if (/\/jobs\/[^/]+\/chunk-\d+-\d+\.m4s$/.test(url)) {
      const signal = init?.signal;
      // Like a real fetch, an abort ends the answer, or the body mid-way.
      if (fixture.segment === 'silent')
        return new Promise<never>((_resolve, reject) =>
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        );
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            fixture.segmentAborts++;
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (sent++ === 5) return controller.close();
          controller.enqueue(new Uint8Array(1000).fill(sent));
        },
      });
      return new Response(body, {
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': '5000' },
      });
    }
    return Response.json({ ok: true });
  });
}
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await new Promise<void>((resolve) => internalServer.close(() => resolve()));
});
beforeEach(() => {
  fixture.party = crypto.randomUUID().replaceAll('-', '').slice(0, 22);
  fixture.enabled = true;
  fixture.members = [{ id: 'host', key: 'h'.repeat(22) }];
  fixture.playing = { ref: 'encrypted-title', playlistItemId: 'b'.repeat(32) };
  fixture.slow = false;
  fixture.prepares = [];
  fixture.noSources = false;
  fixture.memoCalls = 0;
  fixture.rerunLoses = false;
  fixture.workerDown = false;
  fixture.logs = [];
  fixture.sourcePath = '/media/private-token';
  fixture.probes = 0;
  fixture.probeFailures = 0;
  fixture.hits = { public: 0, internal: 0 };
  fixture.probeInputs = [];
  fixture.probeError =
    'Source probe failed: Invalid data found when processing input';
  fixture.scopes = [];
  fixture.chain = { hits: 0, expireA: false, thenTo: '/media/B' };
  fixture.prepared = { mode: 'direct' };
  fixture.segment = 'slow';
  fixture.segmentAborts = 0;
  fixture.full = false;
  fixture.releases = [];
  fixture.touchStatus = 200;
  fixture.extraction = [];
  fixture.subtitleCodec = 'subrip';
  MEDIA_TIMEOUT.headersMs = 30_000;
  vi.restoreAllMocks();
  spyFetch();
});
describe('guest playback authorization', () => {
  it('requires host credentials and rejects malformed invitations', async () => {
    expect((await api('/host', '', proof())).status).toBe(403);
    const secret = await invitation();
    expect(
      (
        await api('/exchange', '', {
          party: fixture.party,
          secret: 'x'.repeat(43),
        })
      ).status
    ).toBe(410);
    const token = await guest(secret);
    expect((await api('/current', token)).status).toBe(403);
    join(token);
    const response = await api('/current', token);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('private-token');
    expect(text).not.toContain('password');
    expect(text).toContain('Opening');
  });
  it('scopes playback to membership and revokes invites and sessions', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    const current = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    const response = await api('/prepare', token, {
      revision: current.revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: true, container: true, hdr: false },
    });
    expect(response.status).toBe(200);
    const playback = (await response.json()) as { url: string };
    expect(playback.url).toContain('/media/original');
    expect(playback.url).not.toContain('provider');
    guestSessions.revokeMember(fixture.party, 'guest');
    expect((await api('/current', token)).status).toBe(401);
    await api('/disable', 'host-token', proof());
    expect(
      (await api('/exchange', '', { party: fixture.party, secret })).status
    ).toBe(410);
  });
  it('rejects media URLs from a previous playback lease', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    const current = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    const body = {
      revision: current.revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: true, container: true, hdr: false },
    };
    const old = (await (await api('/prepare', token, body)).json()) as {
      url: string;
    };
    const replacement = await api('/prepare', token, {
      ...body,
      positionMs: 4000,
    });
    expect(replacement.status).toBe(200);
    const response = await originalFetch(new URL(old.url, base));
    expect(response.status).toBe(410);
  });
  it('rejects an old revision and disabled streaming', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    const current = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    fixture.playing = { ...fixture.playing, playlistItemId: 'd'.repeat(32) };
    expect(
      (
        await api('/prepare', token, {
          revision: current.revision,
          quality: 'original',
          positionMs: 0,
          capabilities: {
            video: true,
            audio: true,
            container: true,
            hdr: false,
          },
        })
      ).status
    ).toBe(409);
    fixture.enabled = false;
    expect((await api('/current', token)).status).toBe(410);
  });
  it('does not let an older preparation replace a newer seek', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    const current = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    const body = {
      revision: current.revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: true, container: true, hdr: false },
    };
    fixture.slow = true;
    const first = api('/prepare', token, body);
    await vi.waitFor(() => expect(fixture.prepares.length).toBe(1));
    const second = api('/prepare', token, { ...body, positionMs: 4000 });
    await vi.waitFor(() => expect(fixture.prepares.length).toBe(2));
    fixture.prepares[1].resolve();
    expect((await second).status).toBe(200);
    fixture.prepares[0].resolve();
    const lost = await first;
    expect(lost.status).toBe(409);
    expect(((await lost.json()) as { code?: string }).code).toBe('superseded');
  });
  it('reports what went wrong while it started, not a title change', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    const current = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    fixture.slow = true;
    const pending = api('/prepare', token, {
      revision: current.revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: true, container: true, hdr: false },
    });
    await vi.waitFor(() => expect(fixture.prepares.length).toBe(1));
    fixture.enabled = false;
    fixture.prepares[0].resolve();
    const res = await pending;
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toBe(
      'Guest streaming is disabled'
    );
  });
  it('does not re-resolve a failed source on every poll', async () => {
    fixture.noSources = true;
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    expect((await api('/current', token)).status).toBe(404);
    expect((await api('/current', token)).status).toBe(404);
    expect(fixture.memoCalls).toBe(1);
    // Publishing again (e.g. the host re-selected a source) retries at once.
    fixture.noSources = false;
    await invitation();
    expect((await api('/current', token)).status).toBe(200);
    expect(fixture.memoCalls).toBe(2);
  });
  it('logs why the transcoder is unavailable, without the guest token', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    fixture.workerDown = true;
    const response = await api('/current', token);
    // usually restarting: a retryable 503 that says why
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual({
      error: "The transcoder isn't reachable",
      retryAfter: 5,
      code: 'transcoder_unreachable',
    });
    expect(fixture.logs).toContainEqual({
      level: 'warn',
      data: { path: '/probe', cause: 'ECONNREFUSED', url: 'http://worker' },
      message: 'transcoder unreachable',
    });
    expect(JSON.stringify(fixture.logs)).not.toContain(token);
  });
  it("converts a signed-in user's own playback without a party", async () => {
    expect(
      (await api('/own/open', '', { itemId: 'c'.repeat(32) })).status
    ).toBe(401);
    const opened = await api('/own/open', 'host-token', {
      itemId: 'c'.repeat(32),
      sourceId: 'source',
    });
    expect(opened.status).toBe(200);
    const {
      token,
      revision,
      media: probed,
    } = (await opened.json()) as {
      token: string;
      revision: string;
      media: { tracks: unknown[] };
    };
    expect(token).toMatch(/^own\./);
    expect(probed.tracks).toHaveLength(2);
    const prepared = await api('/own/prepare', token, {
      revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: false, container: false, hdr: false },
    });
    expect(prepared.status).toBe(200);
    const playback = (await prepared.json()) as { url: string; lease: string };
    expect(playback.url).toContain('/media/original');
    expect(playback.url).toContain(encodeURIComponent(token));
    expect(playback.url).not.toContain('provider');
    // A heartbeat for its own lease is accepted.
    const touched = await api('/own/touch', token, {
      positionMs: 1000,
      lease: playback.lease,
    });
    expect(touched.status).toBe(200);
    // The wrong revision is refused, and a made-up session is unknown.
    expect(
      (
        await api('/own/prepare', token, {
          revision: 'f'.repeat(64),
          quality: 'original',
          positionMs: 0,
          capabilities: {
            video: true,
            audio: true,
            container: true,
            hdr: false,
          },
        })
      ).status
    ).toBe(409);
    expect(
      (
        await api('/own/prepare', `own.${'x'.repeat(43)}`, {
          revision,
          quality: 'original',
          positionMs: 0,
          capabilities: {
            video: true,
            audio: true,
            container: true,
            hdr: false,
          },
        })
      ).status
    ).toBe(401);
  });
  it('allows app requests from another origin', async () => {
    const response = await originalFetch(`${base}/available`, {
      headers: { Origin: 'http://tv.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://tv.example'
    );
    expect(await response.json()).toEqual({ enabled: true, conversion: true });
  });
  describe('sources that are not ready or not media', () => {
    async function joined() {
      const secret = await invitation(),
        token = await guest(secret);
      join(token);
      return token;
    }
    it('reports a file that is still downloading, and is not probed', async () => {
      fixture.sourcePath = '/downloading';
      const token = await joined();
      const response = await api('/current', token);
      expect(response.status).toBe(425);
      expect(response.headers.get('retry-after')).toBe('10');
      expect(await response.json()).toMatchObject({
        error: 'The file is still downloading',
        retryAfter: 10,
      });
      expect(fixture.probes).toBe(0);
    });
    it("passes on AIOStreams' own error clip as the error", async () => {
      fixture.sourcePath = '/failed';
      const token = await joined();
      const response = await api('/current', token);
      expect(response.status).toBe(502);
      // won't change on a retry: the player offers other versions
      expect(await response.json()).toMatchObject({
        error: 'The download failed; pick another source',
        code: 'source_failed',
      });
      expect(fixture.probes).toBe(0);
    });
    it('refuses a page that is not media', async () => {
      fixture.sourcePath = '/html';
      const token = await joined();
      const response = await api('/current', token);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: "The source didn't return a media file",
        code: 'source_failed',
      });
    });
    it('reports a source that answers with an error', async () => {
      fixture.sourcePath = '/missing';
      const token = await joined();
      const response = await api('/current', token);
      expect(response.status).toBe(502);
      // might work on a retry
      expect(await response.json()).toMatchObject({
        error: 'The source answered 404',
        code: 'source_unreachable',
      });
    });
    it('stops following a source that redirects forever', async () => {
      fixture.sourcePath = '/loop';
      const token = await joined();
      const response = await api('/current', token);
      expect(response.status).toBe(502);
      expect(await errorOf(response)).toBe(
        'The source redirects too many times'
      );
    });
    it('retries a probe that timed out, once', async () => {
      fixture.probeFailures = 1;
      fixture.probeError = 'Source probe timed out';
      const token = await joined();
      expect((await api('/current', token)).status).toBe(200);
      expect(fixture.probes).toBe(2);
    });
    it('does not retry a probe of bad data, and backs off', async () => {
      fixture.probeFailures = 99;
      const token = await joined();
      const response = await api('/current', token);
      expect(response.status).toBe(502);
      expect(await errorOf(response)).toBe(
        'Source probe failed: Invalid data found when processing input'
      );
      expect(fixture.probes).toBe(1);
      // Within the 5 s backoff the next poll doesn't probe again.
      expect((await api('/current', token)).status).toBe(502);
      expect(fixture.probes).toBe(1);
    });
    it('backs off longer each time, and forgets a failure long past', async () => {
      fixture.probeFailures = 99;
      const token = await joined();
      const start = Date.now();
      const at = (ms: number) =>
        vi.spyOn(Date, 'now').mockReturnValue(start + ms);
      await api('/current', token); // fails: next try after 5 s
      at(6_000);
      await api('/current', token); // fails again: next after 10 s
      expect(fixture.probes).toBe(2);
      at(12_000);
      await api('/current', token); // still within 10 s of the last
      expect(fixture.probes).toBe(2);
      at(17_000);
      await api('/current', token); // fails a third time: next after 30 s
      expect(fixture.probes).toBe(3);
      // Ten minutes later it starts again from the shortest wait.
      at(10 * 60_000);
      await api('/current', token);
      at(10 * 60_000 + 6_000);
      await api('/current', token);
      expect(fixture.probes).toBe(5);
    });
    it("a user's own playback reports downloading too", async () => {
      fixture.sourcePath = '/downloading';
      const response = await api('/own/open', 'host-token', {
        itemId: 'c'.repeat(32),
        sourceId: 'source',
      });
      expect(response.status).toBe(425);
      expect(response.headers.get('retry-after')).toBe('10');
    });
  });
  describe('where the source is read from', () => {
    async function handleOf() {
      const secret = await invitation(),
        token = await guest(secret);
      join(token);
      const response = await api('/current', token);
      expect(response.status).toBe(200);
      return fixture.probeInputs[0].split('/').pop()!;
    }
    const read = (handle: string) =>
      originalFetch(`${base}/source/${handle}`, {
        headers: { Range: 'bytes=0-' },
      });
    it("reads this server's own URLs through its internal address", async () => {
      await handleOf();
      expect(fixture.hits.internal).toBeGreaterThan(0);
      expect(fixture.hits.public).toBe(0);
    });
    it('follows the redirects once, then reads the same file every time', async () => {
      fixture.sourcePath = '/chain';
      const handle = await handleOf();
      expect(await (await read(handle)).text()).toBe('A');
      expect(await (await read(handle)).text()).toBe('A');
      // Only the check went through the failover chain.
      expect(fixture.chain.hits).toBe(1);
    });
    it('resolves again when the pinned link stops working', async () => {
      fixture.sourcePath = '/chain';
      const handle = await handleOf();
      fixture.chain.expireA = true;
      const response = await read(handle);
      expect(response.status).toBe(206);
      expect(await response.text()).toBe('B');
      expect(fixture.chain.hits).toBe(2);
      expect(await (await read(handle)).text()).toBe('B');
    });
    it('never serves a placeholder clip as the file', async () => {
      fixture.sourcePath = '/chain';
      const handle = await handleOf();
      fixture.chain.expireA = true;
      fixture.chain.thenTo = '/static/download_failed.mp4';
      const response = await read(handle);
      expect(response.status).toBe(502);
      expect(await errorOf(response)).toBe(
        'The download failed; pick another source'
      );
    });
    it('refuses addresses inside the cluster, by name or by number', async () => {
      const port = fixture.upstream.split(':').pop();
      for (const [path, url] of [
        ['name', `http://localhost:${port}/media/private-token`],
        ['metadata', 'http://169.254.169.254/latest/meta-data'],
      ]) {
        fixture.party = crypto.randomUUID().replaceAll('-', '').slice(0, 22);
        fixture.members = [{ id: 'host', key: 'h'.repeat(22) }];
        const secret = await invitation(),
          token = await guest(secret);
        join(token);
        fixture.sourcePath = url;
        const response = await api('/current', token);
        expect(response.status, path).toBe(502);
        expect(await errorOf(response), path).toBe(
          'The source points at a private address'
        );
      }
    });
    it('logs why a source handle was refused', async () => {
      const response = await originalFetch(`${base}/source/${'x'.repeat(43)}`);
      expect(response.status).toBe(404);
      expect(fixture.logs).toContainEqual({
        level: 'warn',
        data: { reason: 'unknown handle' },
        message: 'guest source handle refused',
      });
    });
  });
  describe("a user's own playback", () => {
    it('plays the default version, whose id is the item id', async () => {
      const response = await api('/own/open', 'host-token', {
        itemId: 'c'.repeat(32),
        sourceId: 'c'.repeat(32),
      });
      expect(response.status).toBe(200);
    });
    it("uses the user's own cache, guests a separate one", async () => {
      await api('/own/open', 'host-token', { itemId: 'c'.repeat(32) });
      const secret = await invitation(),
        token = await guest(secret);
      join(token);
      await api('/current', token);
      expect(fixture.scopes).toEqual(['owner-scope', 'guest:owner-scope']);
    });
  });
});
describe('converted media', () => {
  it('asks for binaural rendering and says when the transcoder did it', async () => {
    const opened = await api('/own/open', 'host-token', {
      itemId: 'c'.repeat(32),
      sourceId: 'source',
    });
    const { token, revision } = (await opened.json()) as {
      token: string;
      revision: string;
    };
    const ask = (binaural: boolean) =>
      api('/own/prepare', token, {
        revision,
        quality: 'original',
        positionMs: 0,
        capabilities: {
          video: true,
          audio: false,
          container: true,
          hdr: false,
          binaural,
        },
      });
    fixture.prepared = { mode: 'audio', id: 'job-binaural', binaural: true };
    const rendered = (await (await ask(true)).json()) as { binaural?: boolean };
    expect(fixture.prepareCapabilities.at(-1)?.binaural).toBe(true);
    expect(rendered.binaural).toBe(true);
    // the transcoder didn't render it (a fallback, or a track it doesn't read)
    fixture.prepared = { mode: 'audio', id: 'job-plain' };
    const plain = (await (await ask(true)).json()) as { binaural?: boolean };
    expect(plain.binaural).toBeUndefined();
  });
  async function ownSegment() {
    fixture.prepared = { mode: 'audio', id: 'job-1' };
    const opened = await api('/own/open', 'host-token', {
      itemId: 'c'.repeat(32),
      sourceId: 'source',
    });
    const { token, revision } = (await opened.json()) as {
      token: string;
      revision: string;
    };
    const prepared = await api('/own/prepare', token, {
      revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: false, container: true, hdr: false },
    });
    const { url } = (await prepared.json()) as { url: string };
    expect(url).toContain('/media/job-1/manifest.mpd');
    return new URL(url.replace('manifest.mpd', 'chunk-0-00001.m4s'), base);
  }
  it('serves the manifest with this playback in its segment URLs', async () => {
    const segment = await ownSegment();
    const manifest = new URL(
      segment.href.replace('chunk-0-00001.m4s', 'manifest.mpd')
    );
    const response = await originalFetch(manifest);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/dash+xml'
    );
    const mpd = await response.text();
    const token = encodeURIComponent(manifest.searchParams.get('token')!);
    const lease = manifest.searchParams.get('lease')!;
    // The player resolves segment URLs from these templates.
    expect(mpd).toContain(
      `initialization="init-$RepresentationID$.m4s?token=${token}&amp;lease=${lease}"`
    );
    expect(mpd).toContain(
      `media="chunk-$RepresentationID$-$Number%05d$.m4s?token=${token}&amp;lease=${lease}"`
    );
    // The rest of the manifest is untouched.
    expect(mpd).toContain('codecs="hvc1.2.4.L153.B0"');
    // A URL resolved from the template reaches the segment.
    const resolved = new URL(
      'chunk-0-00001.m4s?token=' + token + '&lease=' + lease,
      manifest
    );
    expect((await originalFetch(resolved)).status).toBe(200);
  });
  it('refuses file names the transcoder does not write', async () => {
    const segment = await ownSegment();
    for (const name of ['index.m3u8', 'init.mp4', '..%2Fsecret', 'chunk-0.m4s'])
      expect(
        (
          await originalFetch(
            new URL(segment.href.replace('chunk-0-00001.m4s', name))
          )
        ).status
      ).toBe(404);
  });
  it('adds credentials to segment templates only', () => {
    const mpd = withCredentials(
      '<SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$Number$.m4s"/><Title media="x">',
      'own.a+b/c',
      'L'
    );
    expect(mpd).toContain(
      'initialization="init-$RepresentationID$.m4s?token=own.a%2Bb%2Fc&amp;lease=L"'
    );
    expect(mpd).toContain(
      'media="chunk-$Number$.m4s?token=own.a%2Bb%2Fc&amp;lease=L"'
    );
    expect(mpd).toContain('<Title media="x">');
  });
  it('streams a segment that takes longer than the answer timeout', async () => {
    const url = await ownSegment();
    MEDIA_TIMEOUT.headersMs = 100;
    const response = await originalFetch(url);
    expect(response.status).toBe(200);
    // The whole body arrives, though it takes three times the timeout.
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(5000);
    expect(body[4999]).toBe(5);
  });
  it('answers 504 when the transcoder never answers', async () => {
    const url = await ownSegment();
    MEDIA_TIMEOUT.headersMs = 100;
    fixture.segment = 'silent';
    const started = Date.now();
    const response = await originalFetch(url);
    expect(response.status).toBe(504);
    expect(await errorOf(response)).toBe('Conversion did not answer');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(
      fixture.logs.some((l) => l.message === 'transcoder did not answer')
    ).toBe(true);
  });
  it('stops reading from the transcoder when the viewer goes away', async () => {
    const url = await ownSegment();
    const controller = new AbortController();
    const response = await originalFetch(url, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    // The server notices the closed socket and aborts its own request.
    await vi.waitFor(() => expect(fixture.segmentAborts).toBeGreaterThan(0), {
      timeout: 2000,
    });
  });
});
describe('own playback and a full transcoder', () => {
  async function open() {
    const opened = await api('/own/open', 'host-token', {
      itemId: 'c'.repeat(32),
      sourceId: 'source',
    });
    expect(opened.status).toBe(200);
    return (await opened.json()) as { token: string; revision: string };
  }
  const prepare = (token: string, revision: string, subtitle?: number) =>
    api('/own/prepare', token, {
      revision,
      quality: 'original',
      positionMs: 0,
      subtitle,
      capabilities: { video: true, audio: false, container: true, hdr: false },
    });
  it('passes on when to come back', async () => {
    const { token, revision } = await open();
    fixture.full = true;
    const response = await prepare(token, revision);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(
      ((await response.json()) as { retryAfter?: number }).retryAfter
    ).toBe(10);
  });
  it('plays a picked version from the list it was picked from, without running the addons again', async () => {
    fixture.rerunLoses = true;
    const opened = await api('/own/open', 'host-token', {
      itemId: 'c'.repeat(32),
      sourceId: 'source',
    });
    expect(opened.status).toBe(200);
    expect(fixture.memoCalls).toBe(1);
  });
  it('tells the player when the transcoder no longer has its stream', async () => {
    fixture.prepared = { mode: 'audio', id: 'job-gone' };
    const { token, revision } = await open();
    const prepared = await prepare(token, revision);
    const { lease } = (await prepared.json()) as { lease: string };
    fixture.touchStatus = 404;
    const touched = await api('/own/touch', token, { positionMs: 1000, lease });
    expect(touched.status).toBe(409);
    expect(((await touched.json()) as { code?: string }).code).toBe(
      'stream_gone'
    );
    // and stops asking the transcoder about it
    fixture.touchStatus = 200;
    expect(
      (await api('/own/touch', token, { positionMs: 2000, lease })).status
    ).toBe(200);
  });
  it('releases the earlier playback of the same item when it opens again', async () => {
    fixture.prepared = { mode: 'audio', id: 'job-first' };
    const first = await open();
    expect((await prepare(first.token, first.revision)).status).toBe(200);
    expect(fixture.releases).not.toContain('job-first');
    await open();
    expect(fixture.releases).toContain('job-first');
    // The earlier playback is gone.
    expect((await prepare(first.token, first.revision)).status).toBe(401);
  });
});

describe('subtitles for the browser', () => {
  async function playing(codec: string) {
    fixture.subtitleCodec = codec;
    fixture.prepared = { mode: 'audio', id: 'job-subs' };
    const opened = await api('/own/open', 'host-token', {
      itemId: 'c'.repeat(32),
      sourceId: 'source',
    });
    const { token, revision } = (await opened.json()) as {
      token: string;
      revision: string;
    };
    const prepared = await api('/own/prepare', token, {
      revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: false, container: true, hdr: false },
    });
    const { url } = (await prepared.json()) as { url: string };
    const query = new URL(url, base).search;
    return (path: string, format?: string) =>
      originalFetch(
        new URL(`${base}${path}${query}${format ? `&format=${format}` : ''}`)
      );
  }
  it('sends ASS and PGS to be drawn where the browser draws them', async () => {
    const prepared = async (codec: string, subtitles?: string[]) => {
      fixture.subtitleCodec = codec;
      fixture.prepared = { mode: 'direct' };
      const opened = await api('/own/open', 'host-token', {
        itemId: 'c'.repeat(32),
        sourceId: 'source',
      });
      const { token, revision } = (await opened.json()) as {
        token: string;
        revision: string;
      };
      return (await (
        await api('/own/prepare', token, {
          revision,
          quality: 'original',
          positionMs: 0,
          subtitle: 2,
          capabilities: {
            video: true,
            audio: true,
            container: true,
            hdr: false,
            subtitles,
          },
        })
      ).json()) as {
        subtitleUrl?: string;
        subtitleFormat?: string;
        fontUrls?: string[];
      };
    };
    const ass = await prepared('ass', ['ass', 'pgs']);
    expect(ass.subtitleFormat).toBe('ass');
    expect(ass.subtitleUrl).toMatch(/\/subtitle\/2\?token=.*&format=ass$/);
    expect(ass.fontUrls).toHaveLength(1);
    expect(ass.fontUrls![0]).toMatch(/\/font\/5\?token=/);
    const pgs = await prepared('hdmv_pgs_subtitle', ['ass', 'pgs']);
    expect(pgs.subtitleFormat).toBe('sup');
    expect(pgs.fontUrls).toBeUndefined();
    // A browser that doesn't draw them gets them burned in: no subtitle here.
    expect((await prepared('ass', [])).subtitleUrl).toBeUndefined();
    expect(
      (await prepared('hdmv_pgs_subtitle', ['ass'])).subtitleUrl
    ).toBeUndefined();
    // Text is always served as WebVTT.
    const text = await prepared('subrip');
    expect(text.subtitleFormat).toBe('vtt');
  });
  it('says to come back while the subtitle is extracted', async () => {
    const get = await playing('subrip');
    fixture.extraction = [{ status: 425, body: '{}' }];
    const waiting = await get('/subtitle/2');
    expect(waiting.status).toBe(425);
    expect(waiting.headers.get('retry-after')).toBe('5');
    const ready = await get('/subtitle/2');
    expect(ready.status).toBe(200);
    expect(await ready.text()).toContain('WEBVTT');
  });
  it('serves ASS as it is, and its fonts', async () => {
    const get = await playing('ass');
    fixture.extraction = [
      { status: 200, body: '[Script Info]\nTitle: x' },
      { status: 200, body: 'font bytes' },
    ];
    const ass = await get('/subtitle/2', 'ass');
    expect(ass.status).toBe(200);
    expect(await ass.text()).toContain('[Script Info]');
    const font = await get('/font/5');
    expect(font.status).toBe(200);
    expect(await font.text()).toBe('font bytes');
    expect((await get('/font/6')).status).toBe(404);
  });
  it('serves only the format a track is in', async () => {
    const get = await playing('hdmv_pgs_subtitle');
    expect((await get('/subtitle/2')).status).toBe(404);
    fixture.extraction = [{ status: 200, body: 'PG' }];
    expect((await get('/subtitle/2', 'sup')).status).toBe(200);
  });
});
