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
  workerDown: false,
  logs: [] as { level: string; data: unknown; message: string }[],
  // A fake source server, so the pre-probe check sees real HTTP answers.
  upstream: '',
  // This server's internal address: a second port on the same fake server.
  internal: '',
  hits: { public: 0, internal: 0 },
  probeInputs: [] as string[],
  sourcePath: '/media/private-token',
  probes: 0,
  probeFailures: 0,
  probeError: 'Source probe failed: Invalid data found when processing input',
  scopes: [] as (string | undefined)[],
  chain: { hits: 0, expireA: false, thenTo: '/media/B' },
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
  ensureMemo: async () => (
    ++fixture.memoCalls,
    {
      sources: fixture.noSources
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
import guestRouter from './routes.js';
import { guestSessions } from './sessions.js';
const originalFetch = globalThis.fetch;
let server: Server, base: string;
const media = {
  durationMs: 12000,
  container: 'matroska',
  bitrate: 1000000,
  tracks: [{ index: 0, type: 'video', codec: 'h264', title: 'Video' }],
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
    if (url.endsWith('/prepare')) {
      if (fixture.slow)
        await new Promise<void>((resolve) =>
          fixture.prepares.push({ resolve })
        );
      return Response.json({ mode: 'direct', meta: media });
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
    expect((await first).status).toBe(409);
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
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Transcoder unavailable' });
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
    expect(probed.tracks).toHaveLength(1);
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
      expect(await errorOf(response)).toBe(
        'The download failed; pick another source'
      );
      expect(fixture.probes).toBe(0);
    });
    it('refuses a page that is not media', async () => {
      fixture.sourcePath = '/html';
      const token = await joined();
      const response = await api('/current', token);
      expect(response.status).toBe(502);
      expect(await errorOf(response)).toBe(
        "The source didn't return a media file"
      );
    });
    it('reports a source that answers with an error', async () => {
      fixture.sourcePath = '/missing';
      const token = await joined();
      const response = await api('/current', token);
      expect(response.status).toBe(502);
      expect(await errorOf(response)).toBe('The source answered 404');
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
