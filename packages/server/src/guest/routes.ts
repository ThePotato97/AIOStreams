import { Readable } from 'node:stream';
import { offsetWebVtt } from './subtitles.js';
import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { request } from 'undici';
import { z } from 'zod';
import {
  config,
  type GuestMedia,
  type GuestPlayback,
  type MediaSourceRecord,
} from '@aiostreams/core';
import {
  userForToken,
  contextFromCredentials,
} from '../routes/jellyfin/context.js';
import { locate, ensureMemo } from '../routes/jellyfin/playback.js';
import { guestPartyState } from '../party/relay.js';
import { ticketExpiry } from '../party/ticket.js';
import { guestSessions, randomSecret, type GuestSession } from './sessions.js';

const router: Router = Router();
const key = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const hostSchema = z.object({
  party: key,
  member: z.string().max(30),
  seat: key,
  ticket: z.string().max(100),
});
const publishSchema = hostSchema.extend({
  entries: z
    .array(
      z.object({
        ref: z.string().max(16384),
        itemId: z.string().regex(/^[0-9a-f]{32}$/),
        title: z.string().max(500),
        filename: z.string().max(1000).optional(),
        sourceId: z.string().max(100).optional(),
      })
    )
    .max(20),
});
type Entry = z.infer<typeof publishSchema>['entries'][number];
interface Binding {
  ownerToken: string;
  owner: string;
  secret: string;
  expiresAt: number;
  entries: Map<string, Entry>;
  sources: Map<string, Promise<Source>>;
  bingeGroup?: string;
}
interface Source {
  handle: string;
  party: string;
  revision: string;
  playlistItemId: string;
  itemId: string;
  title: string;
  record: MediaSourceRecord;
  media?: GuestMedia;
}
const bindings = new Map<string, Binding>();
const sources = new Map<string, Source>();
const requests = new Map<string, number>();
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bearer = (req: Request) =>
  req.get('authorization')?.replace(/^Bearer /i, '') ?? '';
const enabled = () =>
  config.party.guestStreaming &&
  !!config.party.transcoderUrl &&
  (config.party.transcoderSecret?.length ?? 0) >= 32 &&
  !!config.party.internalUrl;
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
function limit(req: Request) {
  const id = `${req.ip}:${Math.floor(Date.now() / 60000)}`;
  const count = (requests.get(id) ?? 0) + 1;
  requests.set(id, count);
  if (count > 60) fail(429, 'Too many guest requests; retry shortly');
  if (requests.size > 10000)
    for (const [k] of requests)
      if (!k.endsWith(`:${Math.floor(Date.now() / 60000)}`)) requests.delete(k);
}
async function worker(path: string, body?: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    const res = await fetch(
      `${config.party.transcoderUrl!.replace(/\/$/, '')}${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.party.transcoderSecret}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const error = (await res.json().catch(() => ({}))) as { error?: string };
      fail(
        res.status === 503 ? 503 : 502,
        error.error ?? 'Transcoder unavailable'
      );
    }
    return await res.json();
  } catch (error) {
    if (typeof (error as any).status === 'number') throw error;
    fail(502, 'Transcoder unavailable');
  } finally {
    clearTimeout(timer);
  }
}
const input = (s: Source) =>
  `${config.party.internalUrl!.replace(/\/$/, '')}/party/guest/source/${s.handle}`;
async function host(req: Request, proof: z.infer<typeof hostSchema>) {
  const token = bearer(req);
  const [user, party] = await Promise.all([
    userForToken(token),
    guestPartyState(proof.party),
  ]);
  if (
    !user ||
    !party ||
    party.homeUuid !== user.uuid ||
    party.host !== proof.member ||
    !party.members.some((m) => m.id === proof.member && m.key === proof.seat) ||
    !ticketExpiry(proof.party, proof.ticket, 'host')
  )
    fail(403, 'Only the signed-in party host can share a stream');
  return { user, party, token };
}
async function active(req: Request, requireMember = true) {
  if (!enabled()) fail(410, 'Guest streaming is disabled');
  const token =
    bearer(req) || (typeof req.query.token === 'string' ? req.query.token : '');
  const session = guestSessions.get(token);
  if (!session) fail(401, 'This guest session has expired');
  const binding = bindings.get(session.party);
  const party = await guestPartyState(session.party);
  if (
    !binding ||
    !party ||
    binding.expiresAt <= Date.now() ||
    !(await userForToken(binding.ownerToken))
  )
    fail(410, 'This guest invitation has ended');
  if (
    requireMember &&
    (!session.member || !party.members.some((m) => m.id === session.member))
  )
    fail(403, 'Join the party before playing');
  return { session, binding, party };
}
async function current(req: Request) {
  const state = await active(req);
  const playing = state.party.playing;
  if (!playing) fail(409, 'Waiting for the host to choose a title');
  const entry = state.binding.entries.get(playing.ref);
  if (!entry) fail(409, 'Waiting for the host to share this title');
  const revision = digest([
    playing.playlistItemId,
    entry.itemId,
    entry.sourceId,
    entry.filename,
  ]);
  let pending = state.binding.sources.get(revision);
  if (!pending) {
    pending = (async () => {
      const user = await userForToken(state.binding.ownerToken);
      if (!user) fail(410, 'The host session has expired');
      // Sources are fetched by this server, not from the guest's public IP.
      const guestIp = req.userIp;
      let ctx;
      try {
        req.userIp = undefined;
        ctx = await contextFromCredentials(
          req,
          user.uuid,
          user.payload.p,
          user.persona?.id
        );
      } finally {
        req.userIp = guestIp;
      }

      if (!ctx) fail(410, 'The host configuration is unavailable');
      const ownerScope = ctx.scope();
      ctx.scope = () => `guest:${ownerScope}`;
      const old = req.jf;
      req.jf = ctx;
      let loc;
      try {
        loc = await locate(req, entry.itemId);
      } finally {
        req.jf = old;
      }
      const memo = loc && (await ensureMemo(loc, { current: true }));
      const playable = memo?.sources.filter(
        (s) => !s.notice && s.needs !== 'youtube'
      );
      const record =
        playable?.find((s) => s.msid === entry.sourceId) ??
        playable?.find(
          (s) => entry.filename && s.filename === entry.filename
        ) ??
        playable?.find(
          (s) =>
            state.binding.bingeGroup &&
            s.extension.bingeGroup === state.binding.bingeGroup
        ) ??
        playable?.[0];
      if (!record) fail(404, 'No playable source for this episode');
      // An explicit host selection must never silently select another file.
      if (
        entry.sourceId &&
        record.msid !== entry.sourceId &&
        (!entry.filename || record.filename !== entry.filename)
      )
        fail(
          409,
          'The selected source expired; ask the host to select it again'
        );
      state.binding.bingeGroup = record.extension.bingeGroup;
      const source: Source = {
        handle: randomSecret(),
        party: state.session.party,
        revision,
        playlistItemId: playing.playlistItemId,
        itemId: entry.itemId,
        title: entry.title,
        record,
      };
      sources.set(source.handle, source);
      return source;
    })();
    state.binding.sources.set(revision, pending);
    pending.catch(() => state.binding.sources.delete(revision));
  }
  const source = await pending;
  source.media ??= await worker('/probe', { input: input(source) });
  return { ...state, source };
}
const capabilitySchema = z.object({
  video: z.boolean(),
  audio: z.boolean(),
  container: z.boolean(),
  hdr: z.boolean(),
});
const playbackSchema = z.object({
  revision: z.string().length(64),
  capabilities: capabilitySchema,
  quality: z.enum(['original', '1080p', '720p']),
  audio: z.number().int().nonnegative().optional(),
  subtitle: z.number().int().nonnegative().optional(),
  positionMs: z.number().finite().min(0).max(1e9),
  force: z.boolean().optional(),
});
async function release(session: GuestSession) {
  const job = session.job;
  session.job = undefined;
  if (job)
    await worker(`/jobs/${job}/touch`, {
      viewer: session.lease,
      release: true,
    }).catch(() => {});
}
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
router.get('/available', (_req, res) => res.json({ enabled: enabled() }));
router.post('/host', async (req, res) => {
  if (!enabled())
    fail(503, 'Configure and enable the transcoder companion first');
  const body = hostSchema.parse(req.body);
  const { party, token } = await host(req, body);
  let binding = bindings.get(body.party);
  if (!binding) {
    binding = {
      ownerToken: token,
      owner: party.host,
      secret: randomSecret(),
      expiresAt: party.expiresAt,
      entries: new Map(),
      sources: new Map(),
    };
    bindings.set(body.party, binding);
  }
  if (binding.owner !== party.host)
    fail(403, 'Only the original sharing host may manage this invitation');
  res.json({ secret: binding.secret, expiresAt: binding.expiresAt });
});
router.post('/publish', async (req, res) => {
  const body = publishSchema.parse(req.body);
  await host(req, body);
  const binding = bindings.get(body.party);
  if (!binding || binding.owner !== body.member)
    fail(404, 'Guest streaming is not enabled for this party');
  binding.ownerToken = bearer(req);
  binding.entries = new Map(body.entries.map((e) => [e.ref, e]));
  res.json({ ok: true });
});
router.post('/disable', async (req, res) => {
  const body = hostSchema.parse(req.body);
  await host(req, body);
  bindings.delete(body.party);
  guestSessions.revokeParty(body.party);
  for (const [handle, source] of sources)
    if (source.party === body.party) sources.delete(handle);
  res.json({ ok: true });
});
router.post('/exchange', async (req, res) => {
  limit(req);
  if (!enabled()) fail(410, 'Guest streaming is disabled');
  const body = z
    .object({ party: key, secret: z.string().length(43) })
    .parse(req.body);
  const binding = bindings.get(body.party);
  const party = await guestPartyState(body.party);
  const a = Buffer.from(body.secret),
    b = Buffer.from(binding?.secret ?? '');
  if (
    !binding ||
    !party ||
    a.length !== b.length ||
    !timingSafeEqual(a, b) ||
    binding.expiresAt <= Date.now()
  )
    fail(410, 'This guest invitation has expired');
  if (party.joinsClosed || party.members.length >= 16)
    fail(403, 'This party is closed or full');
  const session = guestSessions.create(body.party, binding.expiresAt);
  guestSessions.onRevoke(session.token, () => {
    void release(session);
  });
  res.json({ token: session.token, expiresAt: session.expiresAt });
});
router.get('/current', async (req, res) => {
  const { source } = await current(req);
  res.json({
    revision: source.revision,
    playlistItemId: source.playlistItemId,
    itemId: source.itemId,
    title: source.title,
    media: source.media,
  });
});
router.post('/prepare', async (req, res) => {
  const body = playbackSchema.parse(req.body);
  const { source, session } = await current(req);
  if (body.revision !== source.revision)
    fail(409, 'The party has changed titles');
  const generation = (session.generation ?? 0) + 1;
  session.generation = generation;
  const lease = randomSecret();
  await release(session);
  const result = await worker('/prepare', {
    input: input(source),
    viewer: lease,
    request: body,
  });
  // A seek or episode change can finish while FFmpeg is starting.
  let valid = false;
  try {
    const latest = await current(req);
    valid =
      latest.source.revision === source.revision &&
      session.generation === generation;
  } catch {}
  if (!valid) {
    if (result.id)
      await worker(`/jobs/${result.id}/touch`, {
        viewer: lease,
        release: true,
      });
    fail(409, 'The party has changed titles');
  }
  if (session.job && session.job !== result.id) await release(session);
  session.job = result.id;
  session.lease = lease;
  session.offsetMs = result.offsetMs ?? 0;
  session.source = source.handle;
  session.revision = source.revision;
  const query = `?token=${encodeURIComponent(session.token)}&lease=${lease}`;
  const base = `${req.baseUrl}/media/`;
  const response: GuestPlayback = {
    lease,
    revision: source.revision,
    playlistItemId: source.playlistItemId,
    itemId: source.itemId,
    title: source.title,
    media: source.media!,
    mode: result.mode,
    offsetMs: result.offsetMs ?? 0,
    url: `${base}${result.mode === 'direct' ? 'original' : `${result.id}/index.m3u8`}${query}`,
  };
  if (
    body.subtitle != null &&
    source.media!.tracks.some(
      (t) =>
        t.type === 'subtitle' &&
        t.index === body.subtitle &&
        ['subrip', 'webvtt', 'mov_text', 'text'].includes(t.codec)
    )
  )
    response.subtitleUrl = `${req.baseUrl}/subtitle/${body.subtitle}${query}`;
  res.json(response);
});
router.post('/touch', async (req, res) => {
  const { session } = await active(req);
  const body = z
    .object({
      positionMs: z.number().finite().min(0).max(1e9),
      release: z.boolean().optional(),
      lease: z.string().length(43),
    })
    .parse(req.body);
  if (body.lease !== session.lease) return void res.json({ ok: true });
  if (body.release) await release(session);
  else if (session.job)
    await worker(`/jobs/${session.job}/touch`, {
      viewer: session.lease,
      positionMs: body.positionMs,
    });
  res.json({ ok: true });
});
async function forward(source: Source, req: Request, res: Response) {
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(source.record.requestHeaders ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ])
  );
  if (req.headers.range) headers.range = req.headers.range;
  const target = new URL(source.record.url, config.bootstrap.baseUrl);
  let upstream = await request(target, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
    bodyTimeout: 0,
    headersTimeout: 30000,
  });
  let next = target;
  for (
    let hop = 0;
    hop < 5 &&
    upstream.statusCode >= 300 &&
    upstream.statusCode < 400 &&
    upstream.headers.location;
    hop++
  ) {
    const location = new URL(String(upstream.headers.location), next);
    if (!['http:', 'https:'].includes(location.protocol)) {
      upstream.body.destroy();
      fail(502, 'Invalid source redirect');
    }
    await upstream.body.dump();
    if (location.origin !== next.origin) {
      delete headers.authorization;
      delete headers.cookie;
    }
    next = location;
    upstream = await request(next, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      bodyTimeout: 0,
      headersTimeout: 30000,
    });
  }
  for (const name of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
  ])
    if (upstream.headers[name]) res.set(name, String(upstream.headers[name]));
  res.status(upstream.statusCode);
  const abort = () => upstream.body.destroy();
  res.on('close', abort);
  try {
    if (req.method === 'HEAD') {
      upstream.body.destroy();
      res.end();
    } else await pipeline(upstream.body, res);
  } finally {
    res.off('close', abort);
  }
}
// Opaque input handles are known only to this server and its private companion.
router.all('/source/:handle', async (req, res) => {
  const source = sources.get(String(req.params.handle));
  if (
    !enabled() ||
    !source ||
    !bindings.has(source.party) ||
    !(await guestPartyState(source.party))
  )
    fail(404, 'Source expired');
  if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Method not allowed');
  await forward(source, req, res);
});
router.get('/subtitle/:index', async (req, res) => {
  const { source, session } = await current(req);
  if (
    session.revision !== source.revision ||
    session.source !== source.handle ||
    req.query.lease !== session.lease
  )
    fail(410, 'Source changed');
  const index = Number(req.params.index);
  if (
    !source.media!.tracks.some(
      (t) =>
        t.type === 'subtitle' &&
        t.index === index &&
        ['subrip', 'webvtt', 'mov_text', 'text'].includes(t.codec)
    )
  )
    fail(404, 'Subtitle not found');
  const upstream = await fetch(`${config.party.transcoderUrl}/subtitle`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.party.transcoderSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: input(source), index }),
    signal: AbortSignal.timeout(65000),
  });
  if (!upstream.ok) fail(502, 'Subtitle extraction failed');
  res
    .type('text/vtt')
    .send(offsetWebVtt(await upstream.text(), session.offsetMs ?? 0));
});
router.get('/media/:job/:file', async (req, res) => {
  const { session, source } = await current(req);
  if (
    session.revision !== source.revision ||
    session.job !== req.params.job ||
    req.query.lease !== session.lease
  )
    fail(410, 'Playback changed');
  const file = String(req.params.file);
  if (!/^(index\.m3u8|init\.mp4|segment-\d+\.m4s)$/.test(file))
    fail(404, 'Media not found');
  const upstream = await fetch(
    `${config.party.transcoderUrl}/jobs/${session.job}/${file}`,
    {
      headers: { Authorization: `Bearer ${config.party.transcoderSecret}` },
      signal: AbortSignal.timeout(30000),
    }
  );
  if (!upstream.ok) fail(502, 'Conversion is unavailable');
  if (file.endsWith('.m3u8')) {
    const playlist = (await upstream.text())
      .replace(
        /(URI=")([^"\n]+)(")/g,
        (_m, a, name, b) =>
          `${a}${name}?token=${encodeURIComponent(session.token)}&lease=${session.lease}${b}`
      )
      .split('\n')
      .map((line) =>
        line && !line.startsWith('#')
          ? `${line}?token=${encodeURIComponent(session.token)}&lease=${session.lease}`
          : line
      )
      .join('\n');
    res.type('application/vnd.apple.mpegurl').send(playlist);
  } else {
    if (!upstream.body) fail(502, 'Conversion returned no media');
    res.type('video/mp4');
    const length = upstream.headers.get('content-length');
    if (length) res.set('Content-Length', length);
    const stream = Readable.fromWeb(
      upstream.body as import('node:stream/web').ReadableStream
    );
    const revoke = guestSessions.onRevoke(session.token, () => res.destroy());
    const close = () => stream.destroy();
    res.on('close', close);
    try {
      await pipeline(stream, res);
    } finally {
      revoke();
      res.off('close', close);
    }
  }
});
router.all('/media/original', async (req, res) => {
  const { session, source } = await current(req);
  if (
    session.revision !== source.revision ||
    session.source !== source.handle ||
    req.query.lease !== session.lease
  )
    fail(410, 'Playback changed');
  const revoke = guestSessions.onRevoke(session.token, () => res.destroy());
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void current(req)
      .then((now) => {
        if (
          now.source.revision !== source.revision ||
          req.query.lease !== session.lease
        )
          res.destroy();
      })
      .catch(() => res.destroy())
      .finally(() => {
        checking = false;
      });
  }, 2000);
  try {
    await forward(source, req, res);
  } finally {
    clearInterval(timer);
    revoke();
  }
});
router.use((error: any, _req: Request, res: Response, _next: unknown) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = error instanceof z.ZodError ? 400 : (error.status ?? 500);
  res.status(status).json({
    error:
      status === 500
        ? 'Guest playback failed'
        : error instanceof z.ZodError
          ? 'Invalid request'
          : error.message,
  });
});
const sweep = setInterval(() => {
  guestSessions.sweep();
  for (const [id, b] of bindings)
    void guestPartyState(id)
      .then((p) => {
        if (!p || b.expiresAt <= Date.now()) {
          bindings.delete(id);
          guestSessions.revokeParty(id);
          for (const [h, s] of sources) if (s.party === id) sources.delete(h);
        }
      })
      .catch(() => {});
}, 30000);
sweep.unref();
export default router;
