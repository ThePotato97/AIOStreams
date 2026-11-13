import { Readable } from 'node:stream';
import { offsetWebVtt } from './subtitles.js';
import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Agent, request, type Dispatcher } from 'undici';
import { lookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  config,
  createLogger,
  lookupFor,
  msToTicks,
  segmentsEnabled,
  segmentsFor,
  type GuestArtwork,
  type GuestSegment,
  type GuestMedia,
  type GuestPlayback,
  type GuestPlaybackSpec,
  type MediaSourceRecord,
  type PlaybackMemo,
  isMemoFresh,
  openNativeUsenetStream,
} from '@aiostreams/core';
import { serveRangeStream } from '../utils/range-stream.js';
import {
  BlockStore,
  SOURCE_CACHE_BYTES,
  SourceReader,
  type Upstream,
} from './source-reader.js';
import {
  userForToken,
  contextFromCredentials,
  type TokenUser,
} from '../routes/jellyfin/context.js';
import { jellyfinCors } from '../routes/jellyfin/cors.js';
import { locate, ensureMemo } from '../routes/jellyfin/playback.js';
import { itemFromDescriptor } from '../routes/jellyfin/items.js';
import { guestPartyState } from '../party/relay.js';
import { ticketExpiry } from '../party/ticket.js';
import {
  guestSessions,
  randomSecret,
  type GuestSession,
  type PlaybackJobs,
} from './sessions.js';
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
  /** The host's item, found under the host's configuration: its artwork and segments. */
  host?: Located;
  artwork?: Promise<GuestArtwork>;
  segments?: Promise<GuestSegment[]>;
  /**
   * Where the source's redirects lead, followed once. Each range request of
   * a probe or conversion goes here directly: going back through the
   * playback route re-runs its failover chain, which can pick another file.
   */
  pinned?: { url: URL; headers: Record<string, string> };
  /**
   * Runs the host's configuration again for a fresh list and returns this version's record:
   * what a source whose credentials expired (a Drive token) is opened with next.
   */
  refresh?: () => Promise<MediaSourceRecord>;
}
type Located = NonNullable<Awaited<ReturnType<typeof locate>>>;
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
  jobs?: PlaybackJobs;
  lease?: string;
  offsetMs?: number;
  generation?: number;
}
const owns = new Map<string, OwnSession>();
const sources = new Map<string, Source>();
/** Each source's shared reader: every read of a source goes through it. */
const readers = new Map<string, SourceReader>();
let blocks: BlockStore | undefined;
function readerFor(source: Source): SourceReader {
  let reader = readers.get(source.handle);
  if (!reader) {
    blocks ??= new BlockStore(SOURCE_CACHE_BYTES);
    reader = new SourceReader(
      source.record.filename ?? 'source',
      {
        open: (start, signal) => openRange(source, start, signal),
        resolving: () => !source.pinned,
      },
      blocks,
      { maxCursors: 2, stores: true }
    );
    readers.set(source.handle, reader);
  }
  return reader;
}
/** Forgets a source, and stops and drops its reader. */
function dropSource(handle: string): void {
  sources.delete(handle);
  readers.get(handle)?.close();
  readers.delete(handle);
}
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
function fail(status: number, message: string, code?: string): never {
  throw Object.assign(new Error(message), { status, code });
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
        class?: string;
        code?: string;
      };
      // The source failed (AIOStreams' reader said so), not the conversion: its own code.
      const sourceFailed =
        error.class === 'source' &&
        (error.code === 'source_failed' || error.code === 'source_unreachable');
      logger.warn(
        { path, status: res.status, error: error.error },
        res.status === 401
          ? 'transcoder rejected the shared secret'
          : 'transcoder request failed'
      );
      throw Object.assign(new Error(error.error ?? 'Transcoder unavailable'), {
        status: res.status === 503 ? 503 : 502,
        // What the transcoder answered, for callers that read it (a job it no longer has).
        workerStatus: res.status,
        // The transcoder's own condition (busy, misconfigured), or a conversion
        // that failed, which can be the file's.
        code:
          res.status === 503
            ? 'transcoder_busy'
            : res.status === 401
              ? 'transcoder_misconfigured'
              : sourceFailed
                ? error.code
                : 'conversion_failed',
        class: error.class,
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
  scope: 'guest' | 'own' = 'guest',
  /** The item as the configuration has it, once found. */
  onLocated?: (loc: Located) => void,
  /** A list made now, not the one kept (whose credentials may have expired). */
  fresh = false
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
  if (loc) onLocated?.(loc);
  // A named version keeps the list it was picked from, as the rest of the server's playback
  // does: its link plays as long as that list is kept, and a list run again may not have it
  // (an addon that timed out, results in another order). Only a version missing from it, or
  // no choice at all, runs the addons again.
  const find = (memo: PlaybackMemo | null) => {
    const playable = memo?.sources.filter(
      (s) => !s.notice && s.needs !== 'youtube'
    );
    const named =
      playable?.find((s) => s.msid === entry.sourceId) ??
      playable?.find((s) => entry.filename && s.filename === entry.filename);
    return { playable, named };
  };
  let kept: PlaybackMemo | null = null;
  let found: ReturnType<typeof find> | undefined;
  if (fresh)
    found = find(loc ? await ensureMemo(loc, { current: true }) : null);
  else if (entry.sourceId && loc) {
    kept = await ensureMemo(loc);
    found = find(kept);
  }
  // Run again only for a list that has versions, not this one, and is past its reuse window:
  // an empty list was just run again, and a fresh one would come back the same.
  if (
    !found ||
    (!found.named && found.playable?.length && kept && !isMemoFresh(kept))
  )
    found = find(loc ? await ensureMemo(loc, { current: true }) : null);
  const { playable, named } = found;
  const record =
    named ??
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
      let host: Located | undefined;
      const record = await lookupRecord(
        req,
        user,
        entry,
        state.binding.bingeGroup,
        'guest',
        (loc) => (host = loc)
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
        host,
        // The host's configuration again, for a fresh list of this version (its credentials).
        refresh: () =>
          lookupRecord(
            req,
            user,
            entry,
            state.binding.bingeGroup,
            'guest',
            undefined,
            true
          ),
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
  dropSource(session.stream.handle);
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
    .array(z.enum(['truehd', 'eac3', 'ac3', 'dts']))
    .max(4)
    .optional(),
  binauralMode: z.enum(['near', 'far']).optional(),
  subtitles: z
    .array(z.enum(['ass', 'pgs']))
    .max(2)
    .optional(),
  picture: z
    .array(z.enum(['dovi', 'tonemap-sdr']))
    .max(2)
    .optional(),
  display: z.enum(['sdr', 'hdr']).optional(),
  demux: z
    .array(z.enum(['matroska']))
    .max(1)
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
async function release(session: { jobs?: PlaybackJobs; lease?: string }) {
  const lease = session.lease;
  const held = session.jobs;
  session.jobs = undefined;
  if (held && lease) await releaseLease(lease);
}
/** Lets the transcoder know a playback has gone: its jobs no longer count it. */
async function releaseLease(lease: string) {
  await worker(`/viewers/${lease}/release`, {}).catch(() => {});
}
/** The source file's identity, the same across new links to it: what subtitles are kept by. */
function fileKey(source: Source): string {
  return digest([
    'file',
    source.record.msid ?? '',
    source.record.filename ?? '',
    readers.get(source.handle)?.size() ?? null,
  ]);
}
/** How long /prepare waits for a converted playback to start before the player asks again. */
const PLAYING_WAIT_MS = 60_000;
/**
 * Starts a playback at the transcoder: admitted at once (`replaces`: the playback it takes over,
 * whose jobs it may use or free), then, until the page follows the state itself, waited on here
 * until it plays. Any failure, or the wait running out, releases its lease.
 */
async function startPlayback(
  source: Source,
  lease: string,
  body: z.infer<typeof playbackSchema>,
  replaces?: string
) {
  let answer;
  try {
    answer = await worker('/prepare', {
      input: input(source),
      viewer: lease,
      request: body,
      replaces,
      file: fileKey(source),
    });
  } catch (error) {
    // The transcoder may have admitted it before failing to answer (the 75 s timeout).
    await releaseLease(lease);
    throw error;
  }
  if (answer.mode === 'direct') return answer;
  try {
    const started = Date.now();
    let state = answer;
    while (!state.ready && !state.failure) {
      if (Date.now() - started > PLAYING_WAIT_MS)
        throw Object.assign(
          new Error('Conversion is still starting; retry shortly'),
          { status: 503, retryAfter: 2, code: 'transcoder_busy' }
        );
      state = await worker(
        `/viewers/${lease}/state?after=${state.version ?? -1}`
      );
    }
    if (state.failure) {
      const sourceFailed = state.failure.class === 'source';
      throw Object.assign(
        new Error(state.failure.reason ?? 'Conversion failed'),
        {
          status: 502,
          class: state.failure.class,
          code: sourceFailed
            ? (state.failure.code ?? 'source_failed')
            : 'conversion_failed',
        }
      );
    }
    return { ...answer, ...state };
  } catch (error) {
    await releaseLease(lease);
    throw error;
  }
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
    if (source.party === body.party) dropSource(handle);
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
  // Found once per title, shared by every guest's poll.
  const artwork = await (source.artwork ??= artworkOf(source));
  res.json({
    revision: source.revision,
    playlistItemId: source.playlistItemId,
    itemId: source.itemId,
    title: source.title,
    media,
    artwork,
  });
});
/** The host's intro, recap and credits for the title playing, as their own player gets them. */
router.get('/segments', async (req, res) => {
  const { source, media } = await current(req);
  const segments = await (source.segments ??= segmentsOf(
    source,
    media.durationMs
  ));
  res.json({ Items: segments });
});
/**
 * The host's item's artwork: image tags carry each image's address, so a guest's browser loads
 * them from the image route without a session. None where the item can't be built.
 */
async function artworkOf(source: Source): Promise<GuestArtwork> {
  if (!source.host) return {};
  try {
    const item = (await itemFromDescriptor(
      source.host.ctx,
      source.host.descriptor
    )) as (GuestArtwork & Record<string, unknown>) | null;
    if (!item) return {};
    return {
      ImageTags: item.ImageTags,
      BackdropImageTags: item.BackdropImageTags,
      ParentLogoItemId: item.ParentLogoItemId,
      ParentLogoImageTag: item.ParentLogoImageTag,
      ParentBackdropItemId: item.ParentBackdropItemId,
      ParentBackdropImageTags: item.ParentBackdropImageTags,
      ParentThumbItemId: item.ParentThumbItemId,
      ParentThumbImageTag: item.ParentThumbImageTag,
      Overview: item.Overview,
    };
  } catch (error) {
    logger.warn(
      { party: source.party, cause: errorCause(error) },
      'guest artwork unavailable'
    );
    return {};
  }
}
/**
 * The host's segments for the title, by the host's configuration (its providers, the types it
 * turned on), at the file's own runtime. None where segments are off or can't be looked up.
 */
async function segmentsOf(
  source: Source,
  runtimeMs: number
): Promise<GuestSegment[]> {
  const host = source.host;
  if (!host || !segmentsEnabled()) return [];
  const { userData } = host.ctx;
  if (userData.jellyfin?.segments === false) return [];
  const lookup = lookupFor(host.descriptor, runtimeMs);
  if (!lookup) return [];
  const configured = userData.jellyfin?.segmentTypes;
  if (configured?.length === 0) return [];
  try {
    const found = await segmentsFor(
      lookup,
      { pmdbApiKey: userData.pmdbApiKey },
      configured ?? undefined
    );
    return found
      .filter((s) => !configured || configured.includes(s.type))
      .filter((s): s is typeof s & { type: GuestSegment['Type'] } =>
        ['Intro', 'Recap', 'Outro'].includes(s.type)
      )
      .map((s) => ({
        Type: s.type,
        StartTicks: msToTicks(s.startMs),
        EndTicks: msToTicks(s.endMs),
      }));
  } catch (error) {
    logger.warn(
      { party: source.party, cause: errorCause(error) },
      'guest segments unavailable'
    );
    return [];
  }
}
router.post('/prepare', async (req, res) => {
  const body = playbackSchema.parse(req.body);
  const { source, session, media } = await current(req);
  // The track numbers and capabilities sent belong to the file the guest has open: the party
  // moved on since, and the guest's page picks the new title up on its next look.
  if (body.revision !== source.revision) {
    logger.info(
      { party: session.party },
      'guest prepare for a title the party has left'
    );
    fail(409, 'The party has changed titles', 'title_changed');
  }
  const generation = (session.generation ?? 0) + 1;
  session.generation = generation;
  const lease = randomSecret();
  // This playback takes over the guest's current one (a seek, a track switch): jobs only that
  // one holds are free for it, at capacity too.
  const result = await startPlayback(source, lease, body, session.lease);
  // A seek or episode change can finish while FFmpeg is starting.
  const drop = () => releaseLease(lease);
  let latest: Awaited<ReturnType<typeof current>>;
  try {
    latest = await current(req);
  } catch (error) {
    // What's wrong now (the source failing, the host's session ending), not a title change.
    await drop();
    throw error;
  }
  if (latest.source.revision !== source.revision) {
    await drop();
    logger.info(
      { party: latest.session.party },
      'guest prepare outrun by a title change'
    );
    fail(409, 'The party has changed titles', 'title_changed');
  }
  if (session.generation !== generation) {
    await drop();
    // Another prepare from this guest started since (a seek): the newest wins.
    fail(409, 'A newer request replaced this one', 'superseded');
  }
  // The earlier playback's lease goes now (the transcoder freed it on admission already).
  if (session.jobs && session.lease !== lease) await release(session);
  session.jobs = result.jobs ? jobIds(result.jobs) : undefined;
  session.lease = lease;
  session.offsetMs = 0;
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
    mode: GuestPlayback['mode'];
    offsetMs?: number;
    spec: GuestPlaybackSpec;
    effective: GuestPlaybackSpec;
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
    url: `${base}${result.mode === 'direct' ? 'original' : `v/${lease}/manifest.mpd`}${query}`,
    spec: result.spec,
    effective: result.effective,
  };
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
  const entry =
    body.sourceId === body.itemId ? { ...body, sourceId: undefined } : body;
  const record = await lookupRecord(req, user, entry, undefined, 'own');
  const revision = digest([OWN, user.uuid, body.itemId, record.msid]);
  const stream: Source = {
    handle: randomSecret(),
    party: OWN,
    revision,
    playlistItemId: '',
    itemId: body.itemId,
    title: '',
    record,
    // The user's configuration again, for a fresh list of this version (its credentials).
    refresh: () =>
      lookupRecord(req, user, entry, undefined, 'own', undefined, true),
  };
  sources.set(stream.handle, stream);
  let media: GuestMedia;
  try {
    media = await probeMedia(stream);
  } catch (error) {
    dropSource(stream.handle);
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
  // Takes over the current playback, as for guests.
  const result = await startPlayback(
    session.stream,
    lease,
    body,
    session.lease
  );
  // A later seek can finish first; this one is then out of date.
  if (session.generation !== generation || !owns.has(digest(session.token))) {
    await releaseLease(lease);
    fail(409, 'Playback changed');
  }
  if (session.jobs && session.lease !== lease) await release(session);
  session.jobs = result.jobs ? jobIds(result.jobs) : undefined;
  session.lease = lease;
  session.offsetMs = 0;
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
  else if (session.jobs)
    try {
      await worker(`/viewers/${session.lease}/touch`, {
        positionMs: body.positionMs,
      });
    } catch (error) {
      // The transcoder no longer has the job (it ended, failed or restarted), or no longer
      // counts this viewer on it: its stream won't go on, so the player starts another.
      const answered = (error as { workerStatus?: number }).workerStatus;
      if (answered === 404 || answered === 403) {
        logger.info(
          { status: answered },
          'guest stream gone from the transcoder; the player starts another'
        );
        session.jobs = undefined;
        fail(409, 'This stream ended on the server', 'stream_gone');
      }
      throw error;
    }
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
  options: {
    pinned?: Source['pinned'];
    headersTimeout?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{ upstream: Dispatcher.ResponseData | null; url: URL }> {
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
  // A pinned file answers at once; the playback route answers only once it has resolved.
  const headersTimeout =
    options.headersTimeout ?? (options.pinned ? 30000 : resolveTimeoutMs());
  const open = (url: URL) => {
    assertPublic(url);
    return request(withoutLogin(url, headers), {
      method,
      headers,
      bodyTimeout: 0,
      headersTimeout,
      dispatcher: guarded,
      signal: options.signal,
    });
  };
  let next = target;
  // AIOStreams' own usenet stream is read in-process, not over HTTP.
  if (nativeUsenetToken(next)) return { upstream: null, url: next };
  let upstream = await open(target);
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
    if (nativeUsenetToken(next)) {
      source.pinned = { url: next, headers: {} };
      return { upstream: null, url: next };
    }
    upstream = await open(next);
  }
  // Landed on the file itself: later requests go straight there.
  if (!options.pinned && upstream.statusCode < 400 && !placeholderOf(next)) {
    const { range: _range, ...kept } = headers;
    source.pinned = { url: withoutLogin(next, kept), headers: kept };
  }
  return { upstream, url: next };
}
/**
 * The longest the playback route can take to answer: its failover chain runs under a lock held
 * for at least 180 s, and a service waiting for a download polls up to its own limit
 * (`BUILTIN_DOWNLOAD_MAX_WAIT_TIME`). A little more, so its own answer arrives first.
 */
function resolveTimeoutMs(): number {
  const waits = Object.values(
    (config.builtins?.debrid?.downloadMaxWaitTime ?? {}) as Record<
      string,
      number
    >
  ).filter((ms) => Number.isFinite(ms));
  return Math.max(180_000, ...waits) + 30_000;
}
/**
 * A login written into the URL (NzbDAV and AltMount's WebDAV links) sent as Basic auth, which
 * undici doesn't do from a URL. The URL is returned without it. `headers` gets the header.
 */
function withoutLogin(url: URL, headers: Record<string, string>): URL {
  if (!url.username && !url.password) return url;
  headers.authorization = `Basic ${Buffer.from(
    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  ).toString('base64')}`;
  const bare = new URL(url);
  bare.username = '';
  bare.password = '';
  return bare;
}
/** The token of AIOStreams' own usenet stream URL (`/api/v1/usenet/stream/:token`), if it is one. */
function nativeUsenetToken(url: URL): string | null {
  const own = [config.bootstrap.baseUrl, config.party.internalUrl]
    .filter((u): u is string => !!u)
    .map((u) => new URL(u));
  if (!own.some((u) => u.origin === url.origin)) return null;
  const base = own
    .find((u) => u.origin === url.origin)!
    .pathname.replace(/\/+$/, '');
  const m = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/v1/usenet/stream/([^/]+)`
  ).exec(url.pathname);
  return m ? decodeURIComponent(m[1]) : null;
}
/**
 * Opens the pinned stream; when it stops working (expired link, error,
 * placeholder), resolves the source again once.
 */
async function openSource(
  source: Source,
  method: 'GET' | 'HEAD',
  range?: string,
  signal?: AbortSignal
) {
  const pinned = source.pinned;
  if (pinned) {
    try {
      const opened = await openUpstream(source, method, range, {
        pinned,
        signal,
      });
      if (
        !opened.upstream ||
        (opened.upstream.statusCode < 400 && !placeholderOf(opened.url))
      )
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
  return openUpstream(source, method, range, { signal });
}
/**
 * Opens a source for its shared reader at `start`, to the end: following redirects (resolving
 * as long as the playback route takes), checking it's the file and not a placeholder clip or an
 * error page, and, when its credentials are refused (an expired Drive token), running the
 * host's configuration again once for a fresh list. AIOStreams' own usenet streams are opened
 * in-process.
 */
async function openRange(
  source: Source,
  start: number,
  signal: AbortSignal
): Promise<Upstream> {
  let refreshed = false;
  for (;;) {
    let opened;
    try {
      opened = await openSource(source, 'GET', `bytes=${start}-`, signal);
    } catch (error) {
      if (typeof (error as { status?: number }).status === 'number')
        throw error;
      if (signal.aborted) throw error;
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
    if (!upstream) return openNativeUsenet(url, start, signal);
    const placeholder = placeholderOf(url);
    if (placeholder) {
      await upstream.body.dump().catch(() => {});
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
    const status = upstream.statusCode;
    if ((status === 401 || status === 403) && source.refresh && !refreshed) {
      await upstream.body.dump().catch(() => {});
      refreshed = true;
      logger.info(
        { status, host: url.hostname },
        'guest source refused its credentials; running the configuration again'
      );
      source.record = await source.refresh();
      source.pinned = undefined;
      continue;
    }
    if (status >= 400) {
      await upstream.body.dump().catch(() => {});
      logger.warn(
        { status, host: url.hostname },
        'guest source returned an error'
      );
      throw sourceError(
        502,
        `The source answered ${status}`,
        'source_unreachable'
      );
    }
    const type = String(upstream.headers['content-type'] ?? '');
    if (/^(text\/|image\/|application\/(json|xml|xhtml))/i.test(type)) {
      await upstream.body.dump({ limit: 65536 }).catch(() => {});
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
    const total = /\/(\d+)\s*$/.exec(
      String(upstream.headers['content-range'] ?? '')
    );
    const length = Number(upstream.headers['content-length']);
    return {
      body: upstream.body as unknown as Readable,
      size: total
        ? Number(total[1])
        : status === 200 && Number.isFinite(length)
          ? length
          : null,
      ranged: status === 206,
      etag: upstream.headers.etag ? String(upstream.headers.etag) : null,
      lastModified: upstream.headers['last-modified']
        ? new Date(String(upstream.headers['last-modified']))
        : null,
    };
  }
}
/** AIOStreams' own usenet stream at `start`, from its engine in this process. */
async function openNativeUsenet(
  url: URL,
  start: number,
  signal: AbortSignal
): Promise<Upstream> {
  try {
    const opened = await openNativeUsenetStream({
      token: nativeUsenetToken(url)!,
      start,
      signal,
    });
    return {
      body: opened.stream,
      size: opened.size,
      ranged: true,
      etag: opened.etag,
      lastModified: opened.lastModified,
      native: true,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    logger.warn({ cause: errorCause(error) }, 'guest usenet source failed');
    throw sourceError(
      502,
      'The usenet source could not be read',
      'source_unreachable'
    );
  }
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
/** Probe failures a second try can get past: a slow or dropped connection. */
const TRANSIENT =
  /timed out|refused|reset|broken pipe|i\/o error|end of file|server returned 5\d\d/i;
/**
 * Opens the source through its reader (resolving it, and checking it's the file and not a
 * placeholder clip or an error page, which would otherwise be converted as if it were the
 * episode), then probes it, trying once more if the probe failed in a way that can change. Bad
 * data won't, and neither will a down or full transcoder.
 */
async function probeMedia(source: Source): Promise<GuestMedia> {
  await readerFor(source).describe();
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
/**
 * Serves a source to one reader: from its shared reader, or, for a source that doesn't serve
 * ranges or say its size, passed through per request (`forward`).
 */
async function serveSource(source: Source, req: Request, res: Response) {
  const reader = readerFor(source);
  await reader.describe();
  if (!reader.shareable()) return forward(source, req, res);
  await serveRangeStream(req, res, {
    open: (range, signal) => reader.open(range, signal),
    disposition: 'none',
  });
}
async function forward(source: Source, req: Request, res: Response) {
  const { upstream, url: next } = await openSource(
    source,
    req.method === 'HEAD' ? 'HEAD' : 'GET',
    req.headers.range
  );
  // AIOStreams' own usenet streams always serve ranges, so they're never passed through.
  if (!upstream) fail(500, 'The source is read through its reader');
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
  await serveSource(source, req, res);
});
/**
 * How the source's reader stands: `ok`, `resolving`, or `failed {class, code}`, for the
 * transcoder to tell a source that failed from its own failure.
 */
router.get('/source/:handle/status', (req, res) => {
  const handle = String(req.params.handle);
  if (!sources.has(handle)) fail(404, 'Source expired');
  res.json(readers.get(handle)?.status() ?? { state: 'idle' });
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
    // Kept by the file, not its link: extracted once across new links to it.
    file: fileKey(source),
    index,
    format,
    // Held by this playback's lease, and released with its other jobs.
    viewer: session.lease,
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
/** A playback's jobs, as the transcoder names them. */
function jobIds(
  jobs: Record<string, { id: string } | null | undefined>
): PlaybackJobs {
  return {
    video: jobs.video!.id,
    ...(jobs.audio ? { audio: jobs.audio.id } : {}),
    ...(jobs.subtitle ? { subtitle: jobs.subtitle.id } : {}),
  };
}
/**
 * A converted playback's media: its manifest (written by the transcoder for this lease from its
 * jobs' segments), and each job's init and media segments, which the manifest names relative to
 * itself (`<job>/init-0.m4s`). Only this playback's lease and its own jobs.
 */
router.get(
  ['/media/v/:lease/manifest.mpd', '/media/v/:lease/:job/:file'],
  async (req, res) => {
    const { session, source } = await streaming(req);
    const lease = String(req.params.lease);
    if (
      session.revision !== source.revision ||
      session.lease !== lease ||
      req.query.lease !== lease ||
      !session.jobs
    )
      fail(410, 'Playback changed');
    const job = req.params.job ? String(req.params.job) : null;
    const file = job ? String(req.params.file) : 'manifest.mpd';
    if (job) {
      if (!Object.values(session.jobs).includes(job))
        fail(410, 'Playback changed');
      if (!/^(init-0\.m4s|chunk-0-\d+\.m4s)$/.test(file))
        fail(404, 'Media not found');
    }
    const path = job
      ? `/jobs/${job}/${file}`
      : `/viewers/${lease}/manifest.mpd`;
    // A viewer that goes away stops the transcoder's answer too.
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    const timer = setTimeout(abort, MEDIA_TIMEOUT.headersMs);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(transcoder(path), {
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
    // Not written yet (404) and left the window (410) are the player's to handle.
    if (upstream.status === 404 || upstream.status === 410) {
      res.off('close', abort);
      fail(
        upstream.status,
        upstream.status === 410 ? 'Segment left the window' : 'Not written yet'
      );
    }
    if (!upstream.ok) {
      logger.warn(
        { status: upstream.status, file },
        'transcoder media request failed'
      );
      fail(502, 'Conversion is unavailable');
    }
    if (!job) {
      res
        .type('application/dash+xml')
        .send(withCredentials(await upstream.text(), session.token, lease));
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
      }
    }
    res.off('close', abort);
  }
);
/**
 * A playback's state, as the transcoder has it: a long poll (`after`: the version last seen),
 * for the page to follow its start (the stage), what it plays (the effective spec) and any
 * failure.
 */
router.get(
  ['/prepare/:lease/state', '/own/prepare/:lease/state'],
  async (req, res) => {
    const token = bearer(req);
    const { session } = token.startsWith('own.')
      ? { session: ownSession(token) }
      : await active(req);
    const lease = String(req.params.lease);
    if (session.lease !== lease) fail(410, 'Playback changed');
    const after = Number(req.query.after ?? -1);
    res.json(
      await worker(
        `/viewers/${lease}/state?after=${Number.isFinite(after) ? after : -1}`
      )
    );
  }
);
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
    await serveSource(source, req, res);
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
          for (const [h, s] of sources) if (s.party === id) dropSource(h);
        }
      })
      .catch(() => {});
}, 30000);
sweep.unref();
export default router;
