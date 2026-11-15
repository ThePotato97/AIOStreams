import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import * as nodeCrypto from 'node:crypto';

const fixture = vi.hoisted(() => ({
  enabled: true,
  playing: { ref: 'encrypted-title', playlistItemId: 'b'.repeat(32) },
  party: 'a'.repeat(22),
  members: [{ id: 'host', key: 'h'.repeat(22) }],
  noSources: false,
  /** Holds the host's list being built (a slow resolve) until it settles. */
  memoGate: null as Promise<void> | null,
  memoCalls: 0,
  /** A list run again (`current`) comes back without the version picked from it. */
  rerunLoses: false,
  logs: [] as { level: string; data: unknown; message: string }[],
  // A fake source server, so the source is read over real HTTP.
  upstream: '',
  // This server's internal address: a second port on the same fake server.
  internal: '',
  hits: { public: 0, internal: 0 },
  /** Every path the source server was asked for. */
  requests: [] as string[],
  /** Every URL this server fetched with the global fetch. */
  fetches: [] as string[],
  sourcePath: '/media/private-token',
  /** What the resolved record says of the file. */
  container: 'mkv' as string | undefined,
  durationMs: 1_320_000 as number | undefined,
  /** The runtime the host's own list has for the title, if any. */
  hostRuntimeMs: undefined as number | undefined,
  scopes: [] as (string | undefined)[],
  chain: { hits: 0, expireA: false, thenTo: '/media/B' },
  /** The list's Drive-style token: list N sends `token-N`; the file takes tokens from `fresh` on. */
  tokens: { fresh: 1, seen: [] as string[] },
  /** The Basic logins a file was asked with. */
  logins: [] as string[],
  /** The host's item, as the host's configuration builds it. */
  hostItem: null as Record<string, unknown> | null,
  hostUserData: {} as Record<string, unknown>,
  segmentsEnabled: true,
  /** What the host's segment providers find, and what they were asked. */
  providerSegments: [] as { type: string; startMs: number; endMs: number }[],
  segmentQueries: [] as {
    runtimeMs?: number;
    types?: string[];
    key?: string;
  }[],
  /** The server's key: what sealed values in the store are sealed with. */
  secretKey: 'k'.repeat(64),
}));
// The shared reader's disk cache is core's real one; core's logger, which loads all of core, is not.
vi.mock('../../../core/src/logging/logger.js', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));
// The shared store as a server without Redis has it (kept in its database, SQLite here), and
// sealing as core's (AES-GCM, by the key). A restart stops the store and starts another on the
// same database, as a new process does.
interface Store {
  start(): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<void>;
}
const shared = vi.hoisted(() => ({
  backend: undefined as unknown as Store,
  db: undefined as unknown as {
    query(text: string): Promise<Record<string, unknown>[]>;
  },
  make: undefined as unknown as () => Store,
}));
vi.mock('@aiostreams/core', async () => ({
  sharedBackend: await (async () => {
    const { PersistedBackend } =
      await import('../../../core/src/sync/store/persisted.js');
    const { SqliteDriver } =
      await import('../../../core/src/db/driver/sqlite.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const db = new SqliteDriver(
      `${mkdtempSync(`${tmpdir()}/guest-store-`)}/db.sqlite`
    );
    shared.db = db as never;
    shared.make = () => new PersistedBackend(() => db) as never;
    shared.backend = shared.make();
    await shared.backend.start();
    return () => shared.backend;
  })(),
  encryptString: (value: string) => {
    const { createCipheriv, createHash, randomBytes } = nodeCrypto;
    const key = createHash('sha256').update(fixture.secretKey).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value), cipher.final()]);
    return {
      success: true,
      data: [iv, cipher.getAuthTag(), data]
        .map((b) => b.toString('base64url'))
        .join('.'),
    };
  },
  decryptString: (sealed: string) => {
    const { createDecipheriv, createHash } = nodeCrypto;
    try {
      const [iv, tag, data] = sealed
        .split('.')
        .map((p) => Buffer.from(p, 'base64url'));
      const key = createHash('sha256').update(fixture.secretKey).digest();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return {
        success: true,
        data: Buffer.concat([
          decipher.update(data),
          decipher.final(),
        ]).toString(),
      };
    } catch {
      return { success: false, data: null };
    }
  },
  DiskBackedCache: (
    await import('../../../core/src/utils/disk-backed-cache.js')
  ).DiskBackedCache,
  openNativeUsenetStream: async () => {
    throw new Error('no usenet in these tests');
  },
  // For serveRangeStream: core's own.
  mimeForFilename: (await import('../../../core/src/shares/mime.js'))
    .mimeForFilename,
  lookupFor: (descriptor: unknown, runtimeMs?: number) =>
    descriptor ? { descriptor, runtimeMs } : null,
  msToTicks: (ms: number) => ms * 10_000,
  segmentsEnabled: () => fixture.segmentsEnabled,
  segmentsFor: async (
    lookup: { runtimeMs?: number },
    opts: { pmdbApiKey?: string },
    types?: string[]
  ) => {
    fixture.segmentQueries.push({
      runtimeMs: lookup.runtimeMs,
      types,
      key: opts.pmdbApiKey,
    });
    return fixture.providerSegments;
  },
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
      get internalUrl() {
        return fixture.internal;
      },
    },
    bootstrap: {
      get baseUrl() {
        return fixture.upstream;
      },
      get secretKey() {
        return fixture.secretKey;
      },
    },
    builtins: { debrid: { downloadMaxWaitTime: { '*': 120000 } } },
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
vi.mock('../routes/jellyfin/items.js', () => ({
  itemFromDescriptor: async () => fixture.hostItem,
}));
vi.mock('../routes/jellyfin/playback.js', () => ({
  locate: async (req: { jf?: { scope?: () => string } }) => (
    fixture.scopes.push(req.jf?.scope?.()),
    {
      ctx: { userData: fixture.hostUserData },
      descriptor: { type: 'series', id: 'tt1', season: 1, episode: 2 },
      memo:
        fixture.hostRuntimeMs === undefined
          ? null
          : { runtimeMs: fixture.hostRuntimeMs },
    }
  ),
  ensureMemo: async (_loc: unknown, opts?: { current?: boolean }) => (
    ++fixture.memoCalls,
    await fixture.memoGate,
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
                container: fixture.container,
                durationMs: fixture.durationMs,
                requestHeaders: {
                  authorization: `Bearer token-${fixture.memoCalls}`,
                },
                subtitles: [],
                extension: { bingeGroup: 'series' },
              },
            ],
    }
  ),
}));
import { decryptString } from '@aiostreams/core';
import guestRouter, { CURRENT_WAIT } from './routes.js';
import { guestSessions } from './sessions.js';
import { BLOCK } from './source-reader.js';
/** The guest sessions of the server running now (a restart imports them anew). */
let liveSessions = guestSessions;
const originalFetch = globalThis.fetch;
let server: Server, base: string;
/** A file that serves ranges and says its size: read through the shared reader. */
const RANGED = 'The whole file, byte for byte, as the CDN has it.';
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
/** The party's file, as a guest's player reads it. */
const media = (token: string, revision: string, init?: RequestInit) =>
  originalFetch(
    `${base}/media/original?token=${encodeURIComponent(token)}&revision=${revision}`,
    init
  );
const errorOf = async (response: Response) =>
  ((await response.json()) as { error?: string }).error;
async function invitation(sourceId: string | undefined = 'source') {
  const result = await api('/host', 'host-token', proof());
  expect(result.status).toBe(200);
  await api('/publish', 'host-token', {
    ...proof(),
    entries: [
      {
        ref: fixture.playing.ref,
        itemId: 'c'.repeat(32),
        title: 'Episode',
        sourceId,
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
async function join(token: string, seat = 'guest') {
  expect(await liveSessions.claimSeat(token, seat)).toBe(true);
  fixture.members.push({ id: seat, key: 'g'.repeat(22) });
}
/** A joined guest and the title the party plays: its token, the invite and the revision. */
async function watching(sourceId: string | undefined = 'source') {
  const secret = await invitation(sourceId),
    token = await guest(secret);
  await join(token);
  const current = await api('/current', token);
  expect(current.status).toBe(200);
  const { revision } = (await current.json()) as { revision: string };
  return { secret, token, revision };
}
/** Reads a response to its end; rejects if the server cut it off. */
async function drain(response: Response): Promise<number> {
  const reader = response.body!.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.length;
  }
}
/** The party's share as the store keeps it. */
async function storedShare() {
  await shared.backend.flush();
  const rows = await shared.db.query(
    'SELECT kind, id, saved FROM fork_shared_records'
  );
  const row = rows.find(
    (r) => r.kind === 'guest-share' && r.id === fixture.party
  );
  return JSON.parse(String(row!.saved)) as {
    revisions: Record<string, { handle: string; ref: string; msid: string }>;
  };
}
let upstream: Server, internalServer: Server;
/** Source responses held open (a file that stalls), closed after each test. */
const stalled: express.Response[] = [];
beforeAll(async () => {
  // What a source can answer: the file, AIOStreams' placeholder clips (as
  // the real playback route redirects to them), an error page, or a 404.
  const files = express();
  files.use((req, _res, next) => {
    const internal =
      String(req.socket.localPort) === fixture.internal.split(':').pop();
    fixture.hits[internal ? 'internal' : 'public']++;
    fixture.requests.push(req.path);
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
  // A file that serves ranges, as a debrid CDN does.
  const ranged = (res: express.Response, body: string) =>
    res
      .status(206)
      .set({
        'content-type': 'video/mp4',
        'content-range': `bytes 0-${body.length - 1}/${body.length}`,
      })
      .send(body);
  files.get('/ranged/file', (req, res) => {
    const asked = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (!asked) return void res.type('video/mp4').send(RANGED);
    const start = Number(asked[1]);
    const end = asked[2] ? Number(asked[2]) : RANGED.length - 1;
    res
      .status(206)
      .set({
        'content-type': 'video/mp4',
        'content-range': `bytes ${start}-${end}/${RANGED.length}`,
      })
      .send(RANGED.slice(start, end + 1));
  });
  // A file of two blocks whose second never arrives: a read of it stays open.
  files.get('/stall', (_req, res) => {
    const size = 2 * BLOCK;
    res.status(206).set({
      'content-type': 'video/mp4',
      'content-range': `bytes 0-${size - 1}/${size}`,
      'content-length': String(size),
    });
    res.write(Buffer.alloc(BLOCK + 1));
    stalled.push(res);
  });
  // A WebDAV file behind a login (NzbDAV, AltMount).
  files.get('/webdav/file', (req, res) => {
    fixture.logins.push(String(req.headers.authorization ?? ''));
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from('user@x:p:ss').toString('base64')}`
    )
      return void res.status(401).end();
    ranged(res, 'W');
  });
  // A Drive file: an expired token is refused.
  files.get('/drive/file', (req, res) => {
    const token = String(req.headers.authorization ?? '');
    fixture.tokens.seen.push(token);
    const n = Number(/token-(\d+)/.exec(token)?.[1] ?? 0);
    if (n < fixture.tokens.fresh) return void res.status(401).end();
    ranged(res, 'D');
  });
  upstream = files.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => upstream.on('listening', resolve));
  fixture.upstream = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  internalServer = files.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => internalServer.on('listening', resolve));
  fixture.internal = `http://127.0.0.1:${(internalServer.address() as { port: number }).port}`;
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
/** Notes every URL this server fetches; nothing is faked. */
function spyFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    fixture.fetches.push(input instanceof Request ? input.url : String(input));
    return originalFetch(input, init);
  });
}
afterAll(async () => {
  vi.restoreAllMocks();
  for (const s of [server, upstream, internalServer]) s.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await new Promise<void>((resolve) => internalServer.close(() => resolve()));
});
afterEach(() => {
  for (const res of stalled.splice(0)) res.destroy();
});
beforeEach(() => {
  fixture.party = crypto.randomUUID().replaceAll('-', '').slice(0, 22);
  fixture.enabled = true;
  fixture.members = [{ id: 'host', key: 'h'.repeat(22) }];
  fixture.playing = { ref: 'encrypted-title', playlistItemId: 'b'.repeat(32) };
  fixture.noSources = false;
  fixture.memoGate = null;
  fixture.memoCalls = 0;
  CURRENT_WAIT.ms = 25_000;
  fixture.rerunLoses = false;
  fixture.logs = [];
  fixture.sourcePath = '/media/private-token';
  fixture.container = 'mkv';
  fixture.durationMs = 1_320_000;
  fixture.hostRuntimeMs = undefined;
  fixture.hits = { public: 0, internal: 0 };
  fixture.requests = [];
  fixture.fetches = [];
  fixture.scopes = [];
  fixture.chain = { hits: 0, expireA: false, thenTo: '/media/B' };
  fixture.tokens = { fresh: 1, seen: [] };
  fixture.logins = [];
  fixture.hostItem = null;
  fixture.hostUserData = {};
  fixture.segmentsEnabled = true;
  fixture.providerSegments = [];
  fixture.segmentQueries = [];
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
    await join(token);
    const response = await api('/current', token);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('private-token');
    expect(text).not.toContain('password');
    expect(JSON.parse(text)).toMatchObject({
      state: 'ready',
      title: 'Episode',
    });
  });
  it('scopes playback to membership and revokes invites and sessions', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    // Not yet in the party: neither the title nor its file.
    expect((await api('/current', token)).status).toBe(403);
    await join(token);
    const { revision } = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    expect((await media(token, 'x')).status).toBe(410);
    const played = await media(token, revision);
    expect(played.status).toBe(206);
    expect(await played.text()).toBe('x');
    await liveSessions.revokeMember(fixture.party, 'guest');
    expect((await api('/current', token)).status).toBe(401);
    expect((await media(token, revision)).status).toBe(401);
    await api('/disable', 'host-token', proof());
    expect(
      (await api('/exchange', '', { party: fixture.party, secret })).status
    ).toBe(410);
  });
  it('rejects an old revision and disabled streaming', async () => {
    const { token, revision } = await watching();
    fixture.playing = { ...fixture.playing, playlistItemId: 'd'.repeat(32) };
    const old = await media(token, revision);
    expect(old.status).toBe(410);
    expect(await errorOf(old)).toBe('Playback changed');
    const now = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    expect(now.revision).not.toBe(revision);
    expect((await media(token, now.revision)).status).toBe(206);
    fixture.enabled = false;
    expect((await api('/current', token)).status).toBe(410);
    expect((await media(token, now.revision)).status).toBe(410);
  });
  describe('the title, as a long poll', () => {
    type Current = {
      state: string;
      token: string;
      revision: string;
      file?: unknown;
      error?: string;
      status?: number;
      code?: string;
    };
    const poll = async (token: string, after: string) => {
      const started = Date.now();
      const res = await api(
        `/current?after=${encodeURIComponent(after)}`,
        token
      );
      return {
        status: res.status,
        body: (await res.json()) as Current,
        ms: Date.now() - started,
      };
    };
    it('answers a title still resolving at once, then when it is ready', async () => {
      let open = () => {};
      fixture.memoGate = new Promise<void>((r) => (open = r));
      const secret = await invitation(),
        token = await guest(secret);
      await join(token);
      const first = await poll(token, '');
      expect(first.status).toBe(200);
      expect(first.body.state).toBe('resolving');
      expect(first.body.token).toMatch(/^[0-9a-f]{64}:resolving$/);
      expect(first.ms).toBeLessThan(2000);
      // Waits for it, and answers once it's resolved and opened.
      const next = poll(token, first.body.token);
      await new Promise((r) => setTimeout(r, 300));
      open();
      const ready = await next;
      expect(ready.body.state).toBe('ready');
      expect(ready.body.token).toBe(
        first.body.token.replace(':resolving', ':ready')
      );
      expect(ready.body.file).toBeTruthy();
      expect(fixture.memoCalls).toBe(1);
    });
    it('holds a title the page already has, then answers what it is', async () => {
      CURRENT_WAIT.ms = 1500;
      const secret = await invitation(),
        token = await guest(secret);
      await join(token);
      // Followed until ready, as the page does.
      let first = await poll(token, '');
      for (let i = 0; i < 5 && first.body.state !== 'ready'; i++)
        first = await poll(token, first.body.token);
      expect(first.body.state).toBe('ready');
      const held = await poll(token, first.body.token);
      expect(held.body.token).toBe(first.body.token);
      expect(held.ms).toBeGreaterThanOrEqual(1400);
    });
    it('answers a failure with its message, holds it, and backs off its resolve', async () => {
      CURRENT_WAIT.ms = 1500;
      fixture.noSources = true;
      const secret = await invitation(),
        token = await guest(secret);
      await join(token);
      // The resolve fails behind the first answer; the next sees the failure.
      let failed = await poll(token, '');
      for (let i = 0; i < 20 && failed.body.state !== 'failed'; i++)
        failed = await poll(token, failed.body.token);
      expect(failed.body.state).toBe('failed');
      expect(failed.body.error).toBeTruthy();
      const held = await poll(token, failed.body.token);
      expect(held.body.state).toBe('failed');
      expect(held.ms).toBeGreaterThanOrEqual(1400);
      expect(fixture.memoCalls).toBe(1);
    });
    it('answers a source that resolves but does not open as failed, with why', async () => {
      CURRENT_WAIT.ms = 1500;
      fixture.sourcePath = '/failed';
      const secret = await invitation(),
        token = await guest(secret);
      await join(token);
      let failed = await poll(token, '');
      for (let i = 0; i < 20 && failed.body.state !== 'failed'; i++)
        failed = await poll(token, failed.body.token);
      expect(failed.body).toMatchObject({
        state: 'failed',
        error: 'The download failed; pick another source',
        status: 502,
        code: 'source_failed',
      });
      expect(fixture.memoCalls).toBe(1);
    });
  });
  it('does not re-resolve a failed source on every poll', async () => {
    fixture.noSources = true;
    const secret = await invitation(),
      token = await guest(secret);
    await join(token);
    expect((await api('/current', token)).status).toBe(404);
    expect((await api('/current', token)).status).toBe(404);
    expect(fixture.memoCalls).toBe(1);
    // Publishing again (e.g. the host re-selected a source) retries at once.
    fixture.noSources = false;
    await invitation();
    expect((await api('/current', token)).status).toBe(200);
    expect(fixture.memoCalls).toBe(2);
  });
  it('plays a picked version from the list it was picked from, without running the addons again', async () => {
    fixture.rerunLoses = true;
    await watching();
    expect(fixture.memoCalls).toBe(1);
  });
  it("looks the title up in a cache of the guests' own, not the host's", async () => {
    await watching();
    expect(fixture.scopes).toEqual(['guest:owner-scope']);
  });
  it('allows app requests from another origin', async () => {
    const response = await originalFetch(`${base}/available`, {
      headers: { Origin: 'http://tv.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://tv.example'
    );
    expect(await response.json()).toEqual({ enabled: true });
  });
  describe('sources that are not ready or not media', () => {
    async function joined() {
      const secret = await invitation(),
        token = await guest(secret);
      await join(token);
      return token;
    }
    /** The revision the party plays, from the long poll, which answers a failure too. */
    async function revisionOf(token: string) {
      const res = await api('/current?after=none', token);
      return ((await res.json()) as { revision: string }).revision;
    }
    it('reports a file that is still downloading, and does not serve it', async () => {
      fixture.sourcePath = '/downloading';
      const token = await joined();
      const response = await api('/current', token);
      expect(response.status).toBe(425);
      expect(response.headers.get('retry-after')).toBe('10');
      expect(await response.json()).toMatchObject({
        error: 'The file is still downloading',
        retryAfter: 10,
      });
      const played = await media(token, await revisionOf(token));
      expect(played.status).toBe(425);
      expect(played.headers.get('retry-after')).toBe('10');
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
      expect((await media(token, await revisionOf(token))).status).toBe(502);
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
    it('does not open a failed source again while it backs off', async () => {
      fixture.sourcePath = '/missing';
      const token = await joined();
      expect((await api('/current', token)).status).toBe(502);
      const opens = fixture.requests.filter((p) => p === '/missing').length;
      expect(opens).toBe(1);
      // Within the 5 s backoff neither the next poll nor the player opens it again.
      expect((await api('/current', token)).status).toBe(502);
      expect((await media(token, await revisionOf(token))).status).toBe(502);
      expect(fixture.requests.filter((p) => p === '/missing')).toHaveLength(1);
      expect(fixture.memoCalls).toBe(1);
    });
    it('backs off longer each time, and forgets a failure long past', async () => {
      fixture.sourcePath = '/missing';
      const token = await joined();
      const opens = () =>
        fixture.requests.filter((p) => p === '/missing').length;
      const start = Date.now();
      const at = (ms: number) =>
        vi.spyOn(Date, 'now').mockReturnValue(start + ms);
      await api('/current', token); // fails: next try after 5 s
      at(6_000);
      await api('/current', token); // fails again: next after 10 s
      expect(opens()).toBe(2);
      at(12_000);
      await api('/current', token); // still within 10 s of the last
      expect(opens()).toBe(2);
      at(17_000);
      await api('/current', token); // fails a third time: next after 30 s
      expect(opens()).toBe(3);
      // Ten minutes later it starts again from the shortest wait.
      at(10 * 60_000);
      await api('/current', token);
      at(10 * 60_000 + 6_000);
      await api('/current', token);
      expect(opens()).toBe(5);
      // The title was resolved once: only the file was opened again.
      expect(fixture.memoCalls).toBe(1);
    });
  });
  describe('where the source is read from', () => {
    /** A guest watching: reads the party's file as the player does. */
    async function playing() {
      const { token, revision } = await watching();
      return () => media(token, revision, { headers: { Range: 'bytes=0-' } });
    }
    it("reads this server's own URLs through its internal address", async () => {
      const read = await playing();
      expect((await read()).status).toBe(206);
      expect(fixture.hits.internal).toBeGreaterThan(0);
      expect(fixture.hits.public).toBe(0);
    });
    it('follows the redirects once, then reads the same file every time', async () => {
      fixture.sourcePath = '/chain';
      const read = await playing();
      expect(await (await read()).text()).toBe('A');
      expect(await (await read()).text()).toBe('A');
      // Only the first open went through the failover chain.
      expect(fixture.chain.hits).toBe(1);
    });
    it('resolves again when the pinned link stops working', async () => {
      fixture.sourcePath = '/chain';
      const read = await playing();
      fixture.chain.expireA = true;
      const response = await read();
      expect(response.status).toBe(206);
      expect(await response.text()).toBe('B');
      expect(fixture.chain.hits).toBe(2);
      expect(await (await read()).text()).toBe('B');
    });
    it('sends a login written into the URL as Basic auth', async () => {
      const port = fixture.upstream.split(':').pop();
      fixture.sourcePath = `http://user%40x:p%3Ass@127.0.0.1:${port}/webdav/file`;
      const read = await playing();
      expect(await (await read()).text()).toBe('W');
      expect(fixture.logins.length).toBeGreaterThan(0);
      expect(new Set(fixture.logins)).toEqual(
        new Set([`Basic ${Buffer.from('user@x:p:ss').toString('base64')}`])
      );
    });
    it("runs the host's configuration again once when the source refuses its credentials", async () => {
      fixture.sourcePath = '/drive/file';
      // The list made for the guest (list 1) carries a token the file no longer takes.
      fixture.tokens.fresh = 2;
      const read = await playing();
      expect(fixture.tokens.seen[0]).toBe('Bearer token-1');
      // A list made now (not the one kept) carries a token it does take.
      expect(fixture.tokens.seen).toContain('Bearer token-2');
      expect(await (await read()).text()).toBe('D');
    });
    it('never serves a placeholder clip as the file', async () => {
      fixture.sourcePath = '/chain';
      const read = await playing();
      fixture.chain.expireA = true;
      fixture.chain.thenTo = '/static/download_failed.mp4';
      const response = await read();
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
        await join(token);
        fixture.sourcePath = url;
        const response = await api('/current', token);
        expect(response.status, path).toBe(502);
        expect(await errorOf(response), path).toBe(
          'The source points at a private address'
        );
      }
    });
  });
});
describe("the party's file, played directly", () => {
  it("answers the record's container and duration, without a transcoder", async () => {
    const { token } = await watching();
    const current = (await (await api('/current', token)).json()) as {
      file: unknown;
      media?: unknown;
    };
    expect(current.file).toEqual({ container: 'mkv', durationMs: 1_320_000 });
    expect(current.media).toBeUndefined();
    expect(
      fixture.fetches.filter((u) => u.startsWith('http://worker'))
    ).toEqual([]);
    expect(fixture.requests).not.toContain('/probe');
  });
  it('answers null for what the record does not say', async () => {
    fixture.container = '';
    fixture.durationMs = undefined;
    const { token } = await watching();
    const current = (await (await api('/current', token)).json()) as {
      file: unknown;
    };
    expect(current.file).toEqual({ container: null, durationMs: null });
  });
  it("serves the file's bytes, ranges included, by the session and revision alone", async () => {
    fixture.sourcePath = '/ranged/file';
    const { token, revision } = await watching();
    const whole = await media(token, revision);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe(String(RANGED.length));
    expect(await whole.text()).toBe(RANGED);
    const part = await media(token, revision, {
      headers: { Range: 'bytes=4-8' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(
      `bytes 4-8/${RANGED.length}`
    );
    expect(await part.text()).toBe(RANGED.slice(4, 9));
    const tail = await media(token, revision, {
      headers: { Range: 'bytes=-5' },
    });
    expect(await tail.text()).toBe(RANGED.slice(-5));
    // The session token as a bearer header serves it too.
    const bearer = await originalFetch(
      `${base}/media/original?revision=${revision}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(await bearer.text()).toBe(RANGED);
    // Without a session, nothing.
    expect((await media('', revision)).status).toBe(401);
  });
  it('reads the file once for every guest', async () => {
    fixture.sourcePath = '/ranged/file';
    const first = await watching();
    const second = await guest(first.secret);
    await join(second, 'guest2');
    expect((await api('/current', second)).status).toBe(200);
    const bodies = await Promise.all(
      [first.token, second, first.token, second].map(async (token) =>
        (await media(token, first.revision)).text()
      )
    );
    expect(bodies).toEqual([RANGED, RANGED, RANGED, RANGED]);
    // One read upstream, shared: the reader's first open, kept for everyone after.
    expect(fixture.requests.filter((p) => p === '/ranged/file')).toHaveLength(
      1
    );
  });
  it('ends an open read when the host changes the title', async () => {
    fixture.sourcePath = '/stall';
    const { token, revision } = await watching();
    const response = await media(token, revision);
    expect(response.status).toBe(200);
    const reading = drain(response);
    // Still being read: the file's second block hasn't come.
    await new Promise((r) => setTimeout(r, 300));
    fixture.playing = { ...fixture.playing, playlistItemId: 'e'.repeat(32) };
    const started = Date.now();
    await expect(reading).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    // And the old revision is not served again.
    expect((await media(token, revision)).status).toBe(410);
  });
  it("refuses a revoked session's reads, and closes an open one", async () => {
    fixture.sourcePath = '/stall';
    const { token, revision } = await watching();
    const response = await media(token, revision);
    expect(response.status).toBe(200);
    const reading = drain(response);
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await liveSessions.revokeMember(fixture.party, 'guest');
    await expect(reading).rejects.toThrow();
    // At once, not at the next check.
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await media(token, revision)).status).toBe(401);
  });
});
describe("the host's artwork and segments", () => {
  const joined = async () => {
    const token = await guest(await invitation());
    await join(token);
    return token;
  };
  it("gives a guest the host's artwork, and nothing else of the item", async () => {
    fixture.hostItem = {
      Id: 'item',
      Path: 'https://debrid.example/private-token',
      MediaSources: [{ Path: 'https://debrid.example/private-token' }],
      ImageTags: { Primary: 'p-tag', Logo: 'l-tag' },
      BackdropImageTags: ['b-tag'],
      ParentLogoItemId: 'series',
      ParentLogoImageTag: 'sl-tag',
      Overview: 'What happens.',
    };
    const current = (await (await api('/current', await joined())).json()) as {
      artwork: Record<string, unknown>;
    };
    expect(current.artwork).toEqual({
      ImageTags: { Primary: 'p-tag', Logo: 'l-tag' },
      BackdropImageTags: ['b-tag'],
      ParentLogoItemId: 'series',
      ParentLogoImageTag: 'sl-tag',
      Overview: 'What happens.',
    });
  });
  it('gives none where the host has no item for it', async () => {
    const current = (await (await api('/current', await joined())).json()) as {
      artwork: Record<string, unknown>;
    };
    expect(current.artwork).toEqual({});
  });
  it("gives the host's segments, of the types the host turned on, at the title's runtime", async () => {
    fixture.hostUserData = {
      pmdbApiKey: 'host-key',
      jellyfin: { segmentTypes: ['Intro', 'Outro'] },
    };
    fixture.hostRuntimeMs = 1_260_000;
    fixture.providerSegments = [
      { type: 'Intro', startMs: 1_000, endMs: 90_000 },
      { type: 'Recap', startMs: 90_000, endMs: 120_000 },
      { type: 'Outro', startMs: 1_140_000, endMs: 1_200_000 },
    ];
    const token = await joined();
    const response = await api('/segments', token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      Items: [
        { Type: 'Intro', StartTicks: 10_000_000, EndTicks: 900_000_000 },
        { Type: 'Outro', StartTicks: 11_400_000_000, EndTicks: 12_000_000_000 },
      ],
    });
    // The host's list's runtime, not the file's.
    expect(fixture.segmentQueries).toEqual([
      { runtimeMs: 1_260_000, types: ['Intro', 'Outro'], key: 'host-key' },
    ]);
    // Looked up once for every guest's request.
    await api('/segments', token);
    expect(fixture.segmentQueries).toHaveLength(1);
  });
  it("looks segments up at the file's duration where the host's list has no runtime", async () => {
    fixture.providerSegments = [{ type: 'Intro', startMs: 0, endMs: 1_000 }];
    const response = await api('/segments', await joined());
    expect(response.status).toBe(200);
    expect(fixture.segmentQueries).toEqual([
      { runtimeMs: 1_320_000, types: undefined, key: undefined },
    ]);
  });
  it('gives none where the host turned segments off', async () => {
    fixture.hostUserData = { jellyfin: { segments: false } };
    fixture.providerSegments = [{ type: 'Intro', startMs: 0, endMs: 1 }];
    const response = await api('/segments', await joined());
    expect(await response.json()).toEqual({ Items: [] });
    expect(fixture.segmentQueries).toEqual([]);
  });
  it('refuses a guest without a seat', async () => {
    const token = await guest(await invitation());
    expect((await api('/segments', token)).status).toBe(403);
  });
});
describe('share links', () => {
  const ITEM = 'c'.repeat(32);
  const owner = (path: string, init: RequestInit = {}) =>
    originalFetch(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer host-token',
      },
    });
  async function makeLink() {
    const made = await owner('/links', {
      method: 'POST',
      body: JSON.stringify({ itemId: ITEM, sourceId: 'source' }),
    });
    expect(made.status).toBe(200);
    return (await made.json()) as { id: string; secret: string; title: string };
  }
  it('plays the title to whoever has the link, with no party and no account', async () => {
    fixture.sourcePath = '/ranged/file';
    const link = await makeLink();
    const exchanged = await api('/links/exchange', '', {
      link: link.id,
      secret: link.secret,
    });
    expect(exchanged.status).toBe(200);
    const { token } = (await exchanged.json()) as { token: string };
    const current = await api('/current', token);
    expect(current.status).toBe(200);
    const { revision, file } = (await current.json()) as {
      revision: string;
      file: unknown;
    };
    expect(file).toEqual({ container: 'mkv', durationMs: 1_320_000 });
    expect(await (await media(token, revision)).text()).toBe(RANGED);
  });
  it('is made and listed only by a signed-in user, and opened only with its secret', async () => {
    const anonymous = await api('/links', '', { itemId: ITEM });
    expect(anonymous.status).toBe(401);
    const link = await makeLink();
    const listed = (await (await owner('/links')).json()) as {
      links: { id: string; secret: string }[];
    };
    expect(listed.links).toContainEqual(
      expect.objectContaining({ id: link.id, secret: link.secret })
    );
    const wrong = await api('/links/exchange', '', {
      link: link.id,
      secret: 'x'.repeat(43),
    });
    expect(wrong.status).toBe(410);
  });
  it('ends, with its viewers, when the user revokes it', async () => {
    const link = await makeLink();
    const { token } = (await (
      await api('/links/exchange', '', { link: link.id, secret: link.secret })
    ).json()) as { token: string };
    expect((await api('/current', token)).status).toBe(200);
    expect(
      (await owner(`/links/${link.id}`, { method: 'DELETE' })).status
    ).toBe(200);
    expect((await api('/current', token)).status).toBe(401);
    const again = await api('/links/exchange', '', {
      link: link.id,
      secret: link.secret,
    });
    expect(again.status).toBe(410);
    const listed = (await (await owner('/links')).json()) as {
      links: { id: string }[];
    };
    expect(listed.links.map((l) => l.id)).not.toContain(link.id);
  });
});
describe('through a restart', () => {
  const servers: Server[] = [];
  // The process before a restart is gone (its store stopped): later tests use the one running.
  afterEach(() => {
    fixture.secretKey = 'k'.repeat(64);
  });
  afterAll(() => {
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
  });
  /** This server restarts: its routes and sessions anew, with nothing in memory, the store kept. */
  async function restart() {
    // The process goes (its store written out), and a new one starts on the same database.
    await shared.backend.stop();
    shared.backend = shared.make();
    await shared.backend.start();
    vi.resetModules();
    const fresh = await import('./routes.js');
    liveSessions = (await import('./sessions.js')).guestSessions;
    fresh.CURRENT_WAIT.ms = 1500;
    const routes = fresh.default;
    const app = express();
    app.use(express.json());
    app.use('/party/guest', routes);
    const next = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => next.on('listening', resolve));
    servers.push(next);
    base = `http://127.0.0.1:${(next.address() as { port: number }).port}/party/guest`;
  }
  /** The source a revision plays, as the share keeps it (its handle's digest). */
  const keptRef = async (revision: string) =>
    (await storedShare()).revisions[revision]?.ref;
  /** A guest playing the party's file: its token, the invite, the revision and the kept source. */
  async function playing(sourceId: string | undefined = 'source') {
    const was = await watching(sourceId);
    expect((await media(was.token, was.revision)).status).toBe(206);
    return { ...was, ref: await keptRef(was.revision) };
  }
  it('keeps the link, the session and its playback; the page asks first', async () => {
    const was = await playing();
    expect(was.ref).toMatch(/^[0-9a-f]{64}$/);
    await restart();
    // The same link.
    const host = await api('/host', 'host-token', proof());
    expect(((await host.json()) as { secret: string }).secret).toBe(was.secret);
    // The same title, from the same source.
    const current = await api('/current', was.token);
    expect(current.status).toBe(200);
    expect(((await current.json()) as { revision: string }).revision).toBe(
      was.revision
    );
    expect(await keptRef(was.revision)).toBe(was.ref);
    // The file it played, at the same address.
    const played = await media(was.token, was.revision);
    expect(played.status).toBe(206);
    expect(await played.text()).toBe('x');
  });
  it('does not tell a page playing the title that it is resolving again', async () => {
    const was = await playing();
    await restart();
    let open!: () => void;
    fixture.memoGate = new Promise<void>((resolve) => (open = resolve));
    const started = Date.now();
    const pending = api(
      `/current?after=${encodeURIComponent(`${was.revision}:ready`)}`,
      was.token
    );
    setTimeout(() => open(), 300);
    const answer = (await (await pending).json()) as {
      state: string;
      token: string;
    };
    fixture.memoGate = null;
    // Held while it reopened, then (nothing changed) until the poll's end: ready, as it was.
    expect(answer).toMatchObject({
      state: 'ready',
      token: `${was.revision}:ready`,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(await keptRef(was.revision)).toBe(was.ref);
  });
  it('reopens the source once for the player and the page asking together', async () => {
    const was = await playing();
    await restart();
    const calls = fixture.memoCalls;
    const [read, current] = await Promise.all([
      media(was.token, was.revision),
      api('/current', was.token),
    ]);
    expect(read.status).toBe(206);
    expect(current.status).toBe(200);
    expect(fixture.memoCalls - calls).toBe(1);
    expect(await keptRef(was.revision)).toBe(was.ref);
  });
  it('keeps the first playable version the host had no choice for, on the same file', async () => {
    const was = await playing(undefined);
    await restart();
    expect((await media(was.token, was.revision)).status).toBe(206);
    expect((await api('/current', was.token)).status).toBe(200);
    expect(await keptRef(was.revision)).toBe(was.ref);
  });
  it('reads nothing sealed with another key', async () => {
    const was = await playing();
    fixture.secretKey = 'r'.repeat(64);
    await restart();
    expect((await media(was.token, was.revision)).status).toBe(410);
    expect((await api('/current', was.token)).status).toBe(410);
    // The host gets a new link.
    const host = await api('/host', 'host-token', proof());
    expect(host.status).toBe(200);
    expect(((await host.json()) as { secret: string }).secret).not.toBe(
      was.secret
    );
  });
  it('no longer serves a revision the party moved on from', async () => {
    const was = await playing();
    // The party plays something else: its source replaces the one kept.
    fixture.playing = { ...fixture.playing, playlistItemId: 'e'.repeat(32) };
    const now = (await (await api('/current', was.token)).json()) as {
      revision: string;
    };
    expect(now.revision).not.toBe(was.revision);
    const kept = await storedShare();
    expect(Object.keys(kept.revisions)).toEqual([now.revision]);
    expect(kept.revisions[now.revision].ref).not.toBe(was.ref);
    await restart();
    expect((await media(was.token, was.revision)).status).toBe(410);
    expect((await media(was.token, now.revision)).status).toBe(206);
  });
  it('keeps no token, secret or handle in the clear, in the store or the logs', async () => {
    const was = await playing();
    await restart();
    await api('/current', was.token);
    await shared.backend.flush();
    const stored = JSON.stringify(
      await shared.db.query('SELECT * FROM fork_shared_records')
    );
    // The share and the guest session are what was written.
    for (const kind of ['guest-share', 'guest-session'])
      expect(stored).toContain(`"kind":"${kind}"`);
    // The source's handle, sealed in the share, opens to a secret kept nowhere in the clear.
    const sealed = (await storedShare()).revisions[was.revision].handle;
    const handle = decryptString(sealed).data;
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const secret of [was.token, was.secret, handle!, 'host-token'])
      expect(stored).not.toContain(secret);
    expect(JSON.stringify(fixture.logs)).not.toContain(handle);
    expect(JSON.stringify(fixture.logs)).not.toContain(was.token);
  });
  it("ends the guests' sessions when the share ends after a restart", async () => {
    const was = await playing();
    await restart();
    expect((await api('/disable', 'host-token', proof())).status).toBe(200);
    expect((await api('/current', was.token)).status).toBe(401);
    expect((await media(was.token, was.revision)).status).toBe(401);
  });
  it('tells tokens a restart dropped from expired ones', async () => {
    await restart();
    const code = async (response: Response) => [
      response.status,
      ((await response.json()) as { code?: string }).code,
    ];
    expect(
      await code(await api('/current', `guest.${'x'.repeat(43)}`))
    ).toEqual([401, 'session_restarted']);
    expect(
      await code(await api('/current', `guest.v2.${'x'.repeat(43)}`))
    ).toEqual([401, undefined]);
  });
});
