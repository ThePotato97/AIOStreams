import { Readable } from 'node:stream';
import { offsetWebVtt } from './subtitles.js';
import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Agent, request } from 'undici';
import { lookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  config,
  createLogger,
  type GuestMedia,
  type GuestPlayback,
  type MediaSourceRecord,
} from '@aiostreams/core';
import {
  userForToken,
  contextFromCredentials,
  type TokenUser,
} from '../routes/jellyfin/context.js';
import { jellyfinCors } from '../routes/jellyfin/cors.js';
import { locate, ensureMemo } from '../routes/jellyfin/playback.js';
import { guestPartyState } from '../party/relay.js';
import { ticketExpiry } from '../party/ticket.js';
import { guestSessions, randomSecret, type GuestSession } from './sessions.js';
import { StaticFiles } from '../utils/static-errors.js';

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
  /** Recent resolution or probe failures, so polling guests don't retry them. */
  failures: Map<string, { error: unknown; until: number; count: number }>;
  /** When `ownerToken` was last confirmed to belong to a signed-in host. */
  ownerCheckedAt: number;
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
  media?: Promise<GuestMedia>;
  /**
   * Where the source's redirects lead, followed once. Each range request of
   * a probe or conversion goes here directly: going back through the
   * playback route re-runs its failover chain, which can pick another file.
   */
  pinned?: { url: URL; headers: Record<string, string> };
}
const logger = createLogger('guest');
/**
 * What went wrong, without the details that can carry secrets: source URLs
 * (debrid tokens) and some error messages that echo their input.
 */
function errorCause(error: unknown): string {
  const e = error as {
    name?: string;
    code?: string;
    cause?: { code?: string; name?: string };
  };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'timeout';
  return e?.cause?.code ?? e?.code ?? e?.cause?.name ?? e?.name ?? 'unknown';
}
/** How long a failed source waits before it is tried again: 5 s, then 10 s, then 30 s. */
const FAILURE_BACKOFF_MS = [5000, 10000, 30000];
const OWNER_CHECK_MS = 30000;
const bindings = new Map<string, Binding>();
/** Marks a source opened by a signed-in user for their own playback. */
const OWN = 'own';
const OWN_TTL_MS = 6 * 60 * 60 * 1000;
const OWN_PER_USER = 4;
/**
 * A signed-in user's own converted playback: the web app uses it when the
 * browser can't decode a source's audio. Shaped like a guest session so the
 * media routes serve both.
 */
interface OwnSession {
  token: string;
  uuid: string;
  expiresAt: number;
  stream: Source;
  media: GuestMedia;
  revision: string;
  source: string;
  job?: string;
  lease?: string;
  offsetMs?: number;
  generation?: number;
}
const owns = new Map<string, OwnSession>();
const sources = new Map<string, Source>();
const requests = new Map<string, number>();
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bearer = (req: Request) =>
  req.get('authorization')?.replace(/^Bearer /i, '') ?? '';
/** A transcoder is configured: what both guest and own playback need. */
const transcoderReady = () =>
  !!config.party.transcoderUrl &&
  (config.party.transcoderSecret?.length ?? 0) >= 32 &&
  !!config.party.internalUrl;
const enabled = () => config.party.guestStreaming && transcoderReady();
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
const transcoder = (path: string) =>
  `${config.party.transcoderUrl!.replace(/\/+$/, '')}${path}`;
/** How soon a player asks again while the transcoder is unreachable. */
const TRANSCODER_RETRY_S = 5;
async function worker(path: string, body?: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    const res = await fetch(transcoder(path), {
      method: body === undefined ? 'GET' : 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.party.transcoderSecret}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const error = (await res.json().catch(() => ({}))) as {
        error?: string;
        retryAfter?: number;
      };
      logger.warn(
        { path, status: res.status, error: error.error },
        res.status === 401
          ? 'transcoder rejected the shared secret'
          : 'transcoder request failed'
      );
      throw Object.assign(new Error(error.error ?? 'Transcoder unavailable'), {
        status: res.status === 503 ? 503 : 502,
        // The transcoder's own condition (busy, misconfigured), or a conversion
        // that failed, which can be the file's.
        code:
          res.status === 503
            ? 'transcoder_busy'
            : res.status === 401
              ? 'transcoder_misconfigured'
              : 'conversion_failed',
        // A full transcoder says when to come back.
        retryAfter:
          res.status === 503 && typeof error.retryAfter === 'number'
            ? error.retryAfter
            : undefined,
      });
    }
    return await res.json();
  } catch (error) {
    if (typeof (error as any).status === 'number') throw error;
    logger.warn(
      { path, cause: errorCause(error), url: config.party.transcoderUrl },
      'transcoder unreachable'
    );
    // Usually restarting (a new image, a crash): the player waits and asks again.
    throw Object.assign(new Error("The transcoder isn't reachable"), {
      status: 503,
      retryAfter: TRANSCODER_RETRY_S,
      code: 'transcoder_unreachable',
      unreachable: true,
    });
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
/** The host's sign-in, rechecked at most every OWNER_CHECK_MS. */
async function ownerSignedIn(binding: Binding): Promise<boolean> {
  if (Date.now() - binding.ownerCheckedAt < OWNER_CHECK_MS) return true;
  const token = binding.ownerToken;
  if (!(await userForToken(token))) return false;
  // /publish may have swapped in a newer token while this one was checked.
  if (binding.ownerToken === token) binding.ownerCheckedAt = Date.now();
  return true;
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
    !(await ownerSignedIn(binding))
  )
    fail(410, 'This guest invitation has ended');
  if (
    requireMember &&
    (!session.member || !party.members.some((m) => m.id === session.member))
  )
    fail(403, 'Join the party before playing');
  return { session, binding, party };
}
/**
 * The source a configuration plays for an item: the selected one by id or
 * filename, else one of the same release group, else the first playable.
 * Fetched by this server, not from the viewer's public IP.
 */
async function lookupRecord(
  req: Request,
  user: TokenUser,
  entry: { itemId: string; sourceId?: string; filename?: string },
  bingeGroup?: string,
  // Guest lookups keep their own cache; a user's own playback shares theirs.
  scope: 'guest' | 'own' = 'guest'
): Promise<MediaSourceRecord> {
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
  if (scope === 'guest') {
    const ownerScope = ctx.scope();
    ctx.scope = () => `guest:${ownerScope}`;
  }
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
    playable?.find((s) => entry.filename && s.filename === entry.filename) ??
    playable?.find(
      (s) => bingeGroup && s.extension.bingeGroup === bingeGroup
    ) ??
    playable?.[0];
  if (!record) fail(404, 'No playable source for this episode');
  // An explicit host selection must never silently select another file.
  if (
    entry.sourceId &&
    record.msid !== entry.sourceId &&
    (!entry.filename || record.filename !== entry.filename)
  )
    fail(409, 'The selected source expired; ask the host to select it again');
  return record;
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
  // Kept after it expires, so the next failure backs off longer.
  const failure = state.binding.failures.get(revision);
  if (failure && failure.until > Date.now()) throw failure.error;
  // Remember a failure for a while: every guest polls /current every couple
  // of seconds, and each retry runs the host's whole addon pipeline.
  const remember = (error: unknown) => {
    const status = (error as { status?: number }).status;
    logger.warn(
      {
        party: state.session.party,
        status,
        error:
          typeof status === 'number' ? (error as Error).message : undefined,
        cause: typeof status === 'number' ? undefined : errorCause(error),
      },
      'guest source unavailable; backing off'
    );
    // A failure long past doesn't make the next wait longer.
    const previous = state.binding.failures.get(revision);
    const count =
      previous && previous.until > Date.now() - 5 * 60_000
        ? previous.count + 1
        : 1;
    const after = (error as { retryAfter?: number }).retryAfter;
    state.binding.failures.set(revision, {
      error,
      count,
      until:
        Date.now() +
        (after
          ? after * 1000
          : FAILURE_BACKOFF_MS[Math.min(count, FAILURE_BACKOFF_MS.length) - 1]),
    });
    if (state.binding.failures.size > 100)
      for (const [k, f] of state.binding.failures)
        if (f.until <= Date.now()) state.binding.failures.delete(k);
  };
  let pending = state.binding.sources.get(revision);
  if (!pending) {
    pending = (async () => {
      const user = await userForToken(state.binding.ownerToken);
      if (!user) fail(410, 'The host session has expired');
      const record = await lookupRecord(
        req,
        user,
        entry,
        state.binding.bingeGroup
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
    pending.catch((error) => {
      if (state.binding.sources.get(revision) === pending)
        state.binding.sources.delete(revision);
      remember(error);
    });
  }
  const source = await pending;
  // Concurrent polls share one probe.
  const probe = (source.media ??= probeMedia(source));
  let media: GuestMedia;
  try {
    media = await probe;
  } catch (error) {
    if (source.media === probe) {
      source.media = undefined;
      remember(error);
    }
    throw error;
  }
  // Working again: the next failure starts from the shortest wait.
  state.binding.failures.delete(revision);
  return { ...state, source, media };
}
function ownSession(token: string): OwnSession {
  const session = owns.get(digest(token));
  if (!session || session.expiresAt <= Date.now() || !transcoderReady())
    fail(401, 'This playback has expired; start it again');
  session.expiresAt = Date.now() + OWN_TTL_MS;
  return session;
}
function dropOwn(key: string, session: OwnSession) {
  owns.delete(key);
  sources.delete(session.stream.handle);
  void release(session);
}
/** The playback a media URL belongs to: a guest's party, or a user's own. */
async function streaming(req: Request) {
  const token =
    typeof req.query.token === 'string' ? req.query.token : bearer(req);
  if (token.startsWith('own.')) {
    const own = ownSession(token);
    return { session: own, source: own.stream, media: own.media };
  }
  return current(req);
}
const capabilitySchema = z.object({
  video: z.boolean(),
  audio: z.boolean(),
  container: z.boolean(),
  hdr: z.boolean(),
  surround: z.boolean().optional(),
  lossless: z.boolean().optional(),
  binaural: z.boolean().optional(),
  clientBinaural: z
    .array(z.enum(['truehd', 'eac3']))
    .max(2)
    .optional(),
  binauralMode: z.enum(['near', 'far']).optional(),
  dovi: z.boolean().optional(),
  subtitles: z
    .array(z.enum(['ass', 'pgs']))
    .max(2)
    .optional(),
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
async function release(session: { job?: string; lease?: string }) {
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
// Apps that load the web app from elsewhere (TVs, the standalone build) call
// these from another origin; the guest page itself is same-origin.
router.use(
  [
    '/available',
    '/host',
    '/publish',
    '/disable',
    '/own',
    '/media',
    '/subtitle',
  ],
  jellyfinCors
);
router.get('/available', (_req, res) =>
  res.json({ enabled: enabled(), conversion: transcoderReady() })
);
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
      failures: new Map(),
      ownerCheckedAt: Date.now(),
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
  binding.ownerCheckedAt = Date.now();
  binding.entries = new Map(body.entries.map((e) => [e.ref, e]));
  // The host may have just re-selected a source that failed.
  binding.failures.clear();
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
  const { source, media } = await current(req);
  res.json({
    revision: source.revision,
    playlistItemId: source.playlistItemId,
    itemId: source.itemId,
    title: source.title,
    media,
  });
});
router.post('/prepare', async (req, res) => {
  const body = playbackSchema.parse(req.body);
  const { source, session, media } = await current(req);
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
  res.json(
    playbackResponse(req, session.token, lease, source, media, body, result)
  );
});
function playbackResponse(
  req: Request,
  token: string,
  lease: string,
  source: Source,
  media: GuestMedia,
  body: z.infer<typeof playbackSchema>,
  result: {
    id?: string;
    mode: GuestPlayback['mode'];
    offsetMs?: number;
    binaural?: boolean;
    clientBinaural?: boolean;
    dovi?: boolean;
  }
): GuestPlayback {
  const query = `?token=${encodeURIComponent(token)}&lease=${lease}`;
  const base = `${req.baseUrl}/media/`;
  const response: GuestPlayback = {
    lease,
    revision: source.revision,
    playlistItemId: source.playlistItemId,
    itemId: source.itemId,
    title: source.title,
    media,
    mode: result.mode,
    offsetMs: result.offsetMs ?? 0,
    url: `${base}${result.mode === 'direct' ? 'original' : `${result.id}/manifest.mpd`}${query}`,
  };
  if (result.binaural) response.binaural = true;
  if (result.clientBinaural) response.clientBinaural = true;
  if (result.dovi) response.dovi = true;
  const track =
    body.subtitle == null
      ? undefined
      : media.tracks.find(
          (t) => t.type === 'subtitle' && t.index === body.subtitle
        );
  const format = track && subtitleFormat(track.codec);
  // Text is always served; ASS and PGS where the browser draws them, and
  // otherwise they're burned into the video.
  const drawn = body.capabilities.subtitles ?? [];
  if (
    format === 'vtt' ||
    (format === 'ass' && drawn.includes('ass')) ||
    (format === 'sup' && drawn.includes('pgs'))
  ) {
    response.subtitleUrl = `${req.baseUrl}/subtitle/${body.subtitle}${query}${format === 'vtt' ? '' : `&format=${format}`}`;
    response.subtitleFormat = format;
    if (format === 'ass')
      response.fontUrls = (media.fonts ?? []).map(
        (f) => `${req.baseUrl}/font/${f.index}${query}`
      );
  }
  return response;
}
const ownOpenSchema = z.object({
  itemId: z.string().regex(/^[0-9a-f]{32}$/),
  sourceId: z.string().max(100).optional(),
  filename: z.string().max(1000).optional(),
});
// The web app converts its own playback when the browser can't decode a
// source's audio. Signed in with the app's own token; no party needed.
router.post('/own/open', async (req, res) => {
  if (!transcoderReady()) fail(503, 'Conversion is not set up on this server');
  const user = await userForToken(bearer(req));
  if (!user) fail(401, 'Sign in to play this');
  const body = ownOpenSchema.parse(req.body);
  // The default version's id is the item's own: no explicit choice.
  const record = await lookupRecord(
    req,
    user,
    body.sourceId === body.itemId ? { ...body, sourceId: undefined } : body,
    undefined,
    'own'
  );
  const revision = digest([OWN, user.uuid, body.itemId, record.msid]);
  const stream: Source = {
    handle: randomSecret(),
    party: OWN,
    revision,
    playlistItemId: '',
    itemId: body.itemId,
    title: '',
    record,
  };
  sources.set(stream.handle, stream);
  let media: GuestMedia;
  try {
    media = await probeMedia(stream);
  } catch (error) {
    sources.delete(stream.handle);
    throw error;
  }
  // Opening the same item and version again (resume, retry, a reload)
  // replaces the earlier playback: its conversion is released at once,
  // rather than holding a place until its heartbeats lapse.
  for (const [key, old] of [...owns])
    if (old.uuid === user.uuid && old.revision === revision) dropOwn(key, old);
  // A user keeps a few at once (tabs, versions); the oldest go first.
  const mine = [...owns].filter(([, o]) => o.uuid === user.uuid);
  for (const [key, old] of mine.slice(
    0,
    Math.max(0, mine.length - OWN_PER_USER + 1)
  ))
    dropOwn(key, old);
  const token = `own.${randomSecret()}`;
  owns.set(digest(token), {
    token,
    uuid: user.uuid,
    expiresAt: Date.now() + OWN_TTL_MS,
    stream,
    media,
    revision,
    source: stream.handle,
  });
  res.json({ token, revision, media });
});
router.post('/own/prepare', async (req, res) => {
  const session = ownSession(bearer(req));
  const body = playbackSchema.parse(req.body);
  if (body.revision !== session.revision) fail(409, 'Playback changed');
  const generation = (session.generation ?? 0) + 1;
  session.generation = generation;
  const lease = randomSecret();
  await release(session);
  const result = await worker('/prepare', {
    input: input(session.stream),
    viewer: lease,
    request: body,
  });
  // A later seek can finish first; this one is then out of date.
  if (session.generation !== generation || !owns.has(digest(session.token))) {
    if (result.id)
      await worker(`/jobs/${result.id}/touch`, {
        viewer: lease,
        release: true,
      }).catch(() => {});
    fail(409, 'Playback changed');
  }
  session.job = result.id;
  session.lease = lease;
  session.offsetMs = result.offsetMs ?? 0;
  res.json(
    playbackResponse(
      req,
      session.token,
      lease,
      session.stream,
      session.media,
      body,
      result
    )
  );
});
router.post(['/touch', '/own/touch'], async (req, res) => {
  const token = bearer(req);
  const { session } = token.startsWith('own.')
    ? { session: ownSession(token) }
    : await active(req);
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
const CROSS_ORIGIN_HEADERS = new Set(['range', 'user-agent', 'accept']);
const MAX_REDIRECTS = 10;
/**
 * Opens the source, following its redirects. The source's headers may carry
 * the host's credentials (API keys, proxy tokens, ...): another origin only
 * gets the harmless ones.
 */
/** Calls to this server's public address go to its internal one instead. */
function internalize(url: URL): URL {
  const internal = config.party.internalUrl?.replace(/\/+$/, '');
  const base = config.bootstrap.baseUrl?.replace(/\/+$/, '');
  if (!internal || !base || internal === base) return url;
  return url.href === base || url.href.startsWith(`${base}/`)
    ? new URL(internal + url.href.slice(base.length))
    : url;
}
/** Hosts of this server, which the private-address guard lets through. */
function ownHosts(): Set<string> {
  return new Set(
    [config.bootstrap.baseUrl, config.party.internalUrl]
      .filter((u): u is string => !!u)
      .map((u) => new URL(u).hostname)
  );
}
/** Loopback, link-local (cloud metadata) and unspecified addresses. */
function privateAddress(address: string): boolean {
  const v4 = address.replace(/^::ffff:/i, '');
  return (
    /^(127\.|169\.254\.|0\.)/.test(v4) ||
    /^(::1?|fe[89ab][0-9a-f]:)/i.test(address)
  );
}
/** Addons' URLs are fetched from inside the cluster: keep them off its private addresses. */
const guarded = new Agent({
  connect: {
    lookup: (hostname, options, callback) =>
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, '', 0);
        const list = addresses as LookupAddress[];
        if (
          !ownHosts().has(hostname) &&
          list.some((a) => privateAddress(a.address))
        )
          return callback(
            Object.assign(new Error('Blocked private address'), {
              code: 'EBLOCKED',
            }),
            '',
            0
          );
        if ((options as { all?: boolean }).all)
          return callback(null, list as never);
        callback(null, list[0].address, list[0].family);
      }),
  },
});
function assertPublic(url: URL) {
  if (
    isIP(url.hostname.replace(/^\[|\]$/g, '')) &&
    !ownHosts().has(url.hostname)
  )
    if (privateAddress(url.hostname.replace(/^\[|\]$/g, '')))
      fail(502, 'The source points at a private address');
}
/**
 * Opens the source, following its redirects (or straight at `pinned`). The
 * source's headers may carry the host's credentials (API keys, proxy tokens,
 * ...): another origin only gets the harmless ones.
 */
async function openUpstream(
  source: Source,
  method: 'GET' | 'HEAD',
  range?: string,
  options: { pinned?: Source['pinned']; headersTimeout?: number } = {}
) {
  const headers: Record<string, string> = options.pinned
    ? { ...options.pinned.headers }
    : Object.fromEntries(
        Object.entries(source.record.requestHeaders ?? {}).map(
          ([name, value]) => [name.toLowerCase(), value]
        )
      );
  if (range) headers.range = range;
  const target =
    options.pinned?.url ??
    internalize(new URL(source.record.url, config.bootstrap.baseUrl));
  const open = (url: URL) => {
    assertPublic(url);
    return request(url, {
      method,
      headers,
      bodyTimeout: 0,
      headersTimeout: options.headersTimeout ?? 30000,
      dispatcher: guarded,
    });
  };
  let upstream = await open(target);
  let next = target;
  let hops = 0;
  while (
    upstream.statusCode >= 300 &&
    upstream.statusCode < 400 &&
    upstream.headers.location
  ) {
    if (++hops > MAX_REDIRECTS) {
      await upstream.body.dump().catch(() => {});
      fail(502, 'The source redirects too many times');
    }
    const location = internalize(
      new URL(String(upstream.headers.location), next)
    );
    if (!['http:', 'https:'].includes(location.protocol)) {
      await upstream.body.dump().catch(() => {});
      fail(502, 'Invalid source redirect');
    }
    await upstream.body.dump();
    if (location.origin !== next.origin)
      for (const name of Object.keys(headers))
        if (!CROSS_ORIGIN_HEADERS.has(name)) delete headers[name];
    next = location;
    upstream = await open(next);
  }
  // Landed on the file itself: later requests go straight there.
  if (!options.pinned && upstream.statusCode < 400 && !placeholderOf(next)) {
    const { range: _range, ...kept } = headers;
    source.pinned = { url: next, headers: kept };
  }
  return { upstream, url: next };
}
/**
 * Opens the pinned stream; when it stops working (expired link, error,
 * placeholder), resolves the source again once.
 */
async function openSource(
  source: Source,
  method: 'GET' | 'HEAD',
  range?: string
) {
  const pinned = source.pinned;
  if (pinned) {
    try {
      const opened = await openUpstream(source, method, range, { pinned });
      if (opened.upstream.statusCode < 400 && !placeholderOf(opened.url))
        return opened;
      await opened.upstream.body.dump().catch(() => {});
      logger.warn(
        { status: opened.upstream.statusCode, host: opened.url.hostname },
        'pinned guest source stopped working; resolving again'
      );
    } catch (error) {
      if (typeof (error as { status?: number }).status === 'number')
        throw error;
      logger.warn(
        { cause: errorCause(error) },
        'pinned guest source unreachable; resolving again'
      );
    }
    if (source.pinned === pinned) source.pinned = undefined;
  }
  return openUpstream(source, method, range);
}
/**
 * Why a source didn't play, for the player: `source_failed` won't change on a retry (pick another
 * version); `source_unreachable` might (the host was down or answered an error).
 */
type SourceCode = 'source_failed' | 'source_unreachable';
/** AIOStreams' own "downloading" / error clips, which players are sent instead of a file. */
const PLACEHOLDERS: Record<
  string,
  { status: number; message: string; code?: SourceCode }
> = {
  [StaticFiles.DOWNLOADING]: {
    status: 425,
    message: 'The file is still downloading',
  },
  [StaticFiles.DOWNLOAD_FAILED]: {
    status: 502,
    message: 'The download failed; pick another source',
    code: 'source_failed',
  },
  [StaticFiles.NO_MATCHING_FILE]: {
    status: 502,
    message: 'No matching file in that release; pick another source',
    code: 'source_failed',
  },
  [StaticFiles.TOO_MANY_REQUESTS]: {
    status: 503,
    message: 'The debrid service is rate limiting; retrying shortly',
  },
  [StaticFiles.CONTENT_PROXY_LIMIT_REACHED]: {
    status: 503,
    message: 'Too many streams through the proxy at once; retrying shortly',
  },
  [StaticFiles.STORE_LIMIT_EXCEEDED]: {
    status: 502,
    message: 'The debrid storage limit is reached',
    code: 'source_failed',
  },
  [StaticFiles.PAYMENT_REQUIRED]: {
    status: 502,
    message: 'The debrid subscription needs renewing',
    code: 'source_failed',
  },
  [StaticFiles.UNAUTHORIZED]: {
    status: 502,
    message: 'The debrid service rejected the credentials',
  },
  [StaticFiles.FORBIDDEN]: {
    status: 502,
    message: 'The debrid service refused access',
  },
  [StaticFiles.UNAVAILABLE_FOR_LEGAL_REASONS]: {
    status: 502,
    message: 'This file is unavailable for legal reasons',
  },
  [StaticFiles.INTERNAL_SERVER_ERROR]: {
    status: 502,
    message: 'The source failed with a server error',
  },
  [StaticFiles.OK]: {
    status: 502,
    message: "The source didn't return the video",
  },
};
/** Seconds a viewer waits before a retryable source state is tried again. */
const RETRY_AFTER: Record<number, number> = { 425: 10, 503: 15 };
function placeholderOf(url: URL) {
  const origins = [config.bootstrap.baseUrl, config.party.internalUrl]
    .filter((u): u is string => !!u)
    .map((u) => new URL(u).origin);
  const file = /\/static\/([\w.-]+)$/.exec(url.pathname)?.[1];
  return file && origins.includes(url.origin) ? PLACEHOLDERS[file] : undefined;
}
const sourceError = (status: number, message: string, code?: SourceCode) =>
  Object.assign(new Error(message), {
    status,
    retryAfter: RETRY_AFTER[status],
    code,
  });
/**
 * Opens a little of the source before it is probed or played: a link that
 * isn't ready lands on one of AIOStreams' placeholder clips or an error page,
 * which would otherwise be converted as if it were the episode.
 */
async function checkSource(source: Source): Promise<void> {
  let opened;
  try {
    source.pinned = undefined;
    opened = await openUpstream(source, 'GET', 'bytes=0-0', {
      headersTimeout: 15000,
    });
  } catch (error) {
    if (typeof (error as { status?: number }).status === 'number') throw error;
    logger.warn({ cause: errorCause(error) }, 'guest source unreachable');
    const blocked = errorCause(error) === 'EBLOCKED';
    throw sourceError(
      502,
      blocked
        ? 'The source points at a private address'
        : 'The source could not be reached',
      blocked ? 'source_failed' : 'source_unreachable'
    );
  }
  const { upstream, url } = opened;
  // Discarded cleanly: destroy() would raise an unhandled abort. A source
  // that ignores the range is cut off after a little.
  await upstream.body.dump({ limit: 65536 }).catch(() => {});
  const placeholder = placeholderOf(url);
  if (placeholder) {
    logger.warn(
      { file: url.pathname.split('/').pop(), status: placeholder.status },
      'guest source is a placeholder'
    );
    throw sourceError(
      placeholder.status,
      placeholder.message,
      placeholder.code
    );
  }
  if (upstream.statusCode >= 400) {
    logger.warn(
      { status: upstream.statusCode, host: url.hostname },
      'guest source returned an error'
    );
    throw sourceError(
      502,
      `The source answered ${upstream.statusCode}`,
      'source_unreachable'
    );
  }
  const type = String(upstream.headers['content-type'] ?? '');
  if (/^(text\/|image\/|application\/(json|xml|xhtml))/i.test(type)) {
    logger.warn(
      { type: type.split(';')[0], host: url.hostname },
      'guest source is not media'
    );
    throw sourceError(
      502,
      "The source didn't return a media file",
      'source_failed'
    );
  }
}
/** Probe failures a second try can get past: a slow or dropped connection. */
const TRANSIENT =
  /timed out|refused|reset|broken pipe|i\/o error|end of file|server returned 5\d\d/i;
/**
 * Checks the source, then probes it, trying once more if the probe failed in
 * a way that can change. Bad data won't, and neither will a down or full
 * transcoder.
 */
async function probeMedia(source: Source): Promise<GuestMedia> {
  await checkSource(source);
  try {
    return await worker('/probe', { input: input(source) });
  } catch (error) {
    const e = error as Error & { status?: number; unreachable?: boolean };
    if (e.status === 503 || e.unreachable || !TRANSIENT.test(e.message))
      throw error;
    await new Promise((r) => setTimeout(r, 1000));
    return await worker('/probe', { input: input(source) });
  }
}
async function forward(source: Source, req: Request, res: Response) {
  const { upstream, url: next } = await openSource(
    source,
    req.method === 'HEAD' ? 'HEAD' : 'GET',
    req.headers.range
  );
  // A clip in place of the file must not reach FFmpeg as the episode.
  const placeholder = placeholderOf(next);
  if (placeholder) {
    await upstream.body.dump().catch(() => {});
    logger.warn(
      { file: next.pathname.split('/').pop(), status: placeholder.status },
      'guest source turned into a placeholder'
    );
    throw sourceError(
      placeholder.status,
      placeholder.message,
      placeholder.code
    );
  }
  if (upstream.statusCode >= 400)
    logger.warn(
      { status: upstream.statusCode, host: next.hostname },
      'guest source returned an error'
    );
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
  const refuse = (reason: string): never => {
    logger.warn({ reason }, 'guest source handle refused');
    fail(404, 'Source expired');
  };
  if (!source) return refuse('unknown handle');
  if (source.party === OWN) {
    if (!transcoderReady()) refuse('transcoder not configured');
  } else if (!enabled()) refuse('guest streaming off');
  else if (!bindings.has(source.party)) refuse('party no longer shared');
  else if (!(await guestPartyState(source.party))) refuse('party ended');
  if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Method not allowed');
  await forward(source, req, res);
});
/**
 * How a subtitle reaches the browser, as the transcoder serves it: text as
 * WebVTT, ASS/SSA as itself (JASSUB), PGS as .sup (libpgs).
 */
export function subtitleFormat(codec: string): 'vtt' | 'ass' | 'sup' | null {
  if (['subrip', 'webvtt', 'mov_text', 'text'].includes(codec)) return 'vtt';
  if (codec === 'ass' || codec === 'ssa') return 'ass';
  if (codec === 'hdmv_pgs_subtitle') return 'sup';
  return null;
}
/** Asks the transcoder for an extracted file; it may still be extracting. */
async function extracted(
  path: string,
  body: object
): Promise<globalThis.Response> {
  const upstream = await fetch(transcoder(path), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.party.transcoderSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65000),
  });
  if (upstream.status === 425 || upstream.status === 503)
    throw Object.assign(
      new Error(
        upstream.status === 425
          ? 'Subtitles are still being extracted'
          : 'Subtitle extraction is busy'
      ),
      {
        status: upstream.status,
        retryAfter: Number(upstream.headers.get('retry-after')) || 5,
      }
    );
  if (!upstream.ok) {
    logger.warn(
      { path, status: upstream.status },
      'transcoder subtitle extraction failed'
    );
    fail(502, 'Subtitle extraction failed');
  }
  return upstream;
}
router.get('/subtitle/:index', async (req, res) => {
  const { source, session, media } = await streaming(req);
  if (
    session.revision !== source.revision ||
    session.source !== source.handle ||
    req.query.lease !== session.lease
  )
    fail(410, 'Source changed');
  const index = Number(req.params.index);
  const format =
    typeof req.query.format === 'string' ? req.query.format : 'vtt';
  const track = media.tracks.find(
    (t) => t.type === 'subtitle' && t.index === index
  );
  if (!track || subtitleFormat(track.codec) !== format)
    fail(404, 'Subtitle not found');
  const upstream = await extracted('/subtitle', {
    input: input(source),
    index,
    format,
  });
  if (format === 'vtt')
    return void res
      .type('text/vtt')
      .send(offsetWebVtt(await upstream.text(), session.offsetMs ?? 0));
  // ASS keeps the source's own times, which are the player's.
  res.type(format === 'ass' ? 'text/x-ssa' : 'application/octet-stream');
  res.send(Buffer.from(await upstream.arrayBuffer()));
});
router.get('/font/:index', async (req, res) => {
  const { source, session, media } = await streaming(req);
  if (
    session.revision !== source.revision ||
    session.source !== source.handle ||
    req.query.lease !== session.lease
  )
    fail(410, 'Source changed');
  const index = Number(req.params.index);
  if (!media.fonts?.some((f) => f.index === index)) fail(404, 'Font not found');
  const upstream = await extracted('/font', { input: input(source), index });
  res.type(upstream.headers.get('content-type') ?? 'font/ttf');
  // Fonts don't change for a file: the player may keep them.
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(await upstream.arrayBuffer()));
});
/**
 * How long the transcoder may take to start answering for converted media.
 * Only the wait is timed: a segment then streams as fast as the viewer reads
 * it, which for a copied 4K video can take a while.
 */
export const MEDIA_TIMEOUT = { headersMs: 30_000 };
/**
 * A DASH manifest whose segment URLs carry this playback's token and lease,
 * as the manifest's own URL does: the player resolves them from the
 * manifest's templates.
 */
export function withCredentials(mpd: string, token: string, lease: string) {
  // Inside an XML attribute: & is written &amp;.
  const query = `?token=${encodeURIComponent(token)}&amp;lease=${encodeURIComponent(lease)}`;
  return mpd.replace(/<SegmentTemplate\b[^>]*>/g, (tag) =>
    tag.replace(
      /(\s(?:initialization|media)=")([^"?]+)(")/g,
      (_whole, before: string, url: string, after: string) =>
        `${before}${url}${query}${after}`
    )
  );
}
router.get('/media/:job/:file', async (req, res) => {
  const { session, source } = await streaming(req);
  if (
    session.revision !== source.revision ||
    session.job !== req.params.job ||
    req.query.lease !== session.lease
  )
    fail(410, 'Playback changed');
  const file = String(req.params.file);
  if (!/^(manifest\.mpd|init-\d+\.m4s|chunk-\d+-\d+\.m4s)$/.test(file))
    fail(404, 'Media not found');
  // A viewer that goes away stops the transcoder's answer too.
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);
  const timer = setTimeout(abort, MEDIA_TIMEOUT.headersMs);
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(transcoder(`/jobs/${session.job}/${file}`), {
      headers: { Authorization: `Bearer ${config.party.transcoderSecret}` },
      signal: controller.signal,
    });
  } catch (error) {
    if (res.destroyed) return;
    logger.warn(
      { file, cause: errorCause(error) },
      'transcoder did not answer'
    );
    fail(504, 'Conversion did not answer');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    logger.warn(
      { status: upstream.status, file },
      'transcoder media request failed'
    );
    fail(502, 'Conversion is unavailable');
  }
  if (file === 'manifest.mpd') {
    res
      .type('application/dash+xml')
      .send(
        withCredentials(await upstream.text(), session.token, session.lease!)
      );
  } else {
    if (!upstream.body) fail(502, 'Conversion returned no media');
    res.type('video/mp4');
    const length = upstream.headers.get('content-length');
    if (length) res.set('Content-Length', length);
    const stream = Readable.fromWeb(
      upstream.body as import('node:stream/web').ReadableStream
    );
    const revoke = guestSessions.onRevoke(session.token, () => res.destroy());
    try {
      await pipeline(stream, res);
    } finally {
      revoke();
      res.off('close', abort);
    }
  }
  res.off('close', abort);
});
router.all('/media/original', async (req, res) => {
  const { session, source } = await streaming(req);
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
    void streaming(req)
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
  if (typeof error.retryAfter === 'number')
    res.set('Retry-After', String(error.retryAfter));
  // Path only: guest media URLs carry the session token in the query.
  if (status === 500)
    logger.error(
      { path: `${_req.baseUrl}${_req.path}`, cause: errorCause(error) },
      'guest request failed unexpectedly'
    );
  res.status(status).json({
    error:
      status === 500
        ? 'Guest playback failed'
        : error instanceof z.ZodError
          ? 'Invalid request'
          : error.message,
    retryAfter: error.retryAfter,
    // Machine-readable cause, where one is known (transcoder_unreachable, ...).
    code: typeof error.code === 'string' ? error.code : undefined,
  });
});
const sweep = setInterval(() => {
  guestSessions.sweep();
  for (const [key, own] of owns)
    if (own.expiresAt <= Date.now()) dropOwn(key, own);
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
