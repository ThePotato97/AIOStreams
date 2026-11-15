import { Readable } from 'node:stream';
import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
  type GuestFile,
  type MediaSourceRecord,
  type PlaybackMemo,
  isMemoFresh,
  openNativeUsenetStream,
  encryptString,
  decryptString,
  sharedBackend,
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
import { guestSessions, fromBeforeRestart, randomSecret } from './sessions.js';
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
/** The source a revision plays: kept with the share, so it reopens as itself after a restart. */
interface SavedRevision {
  /** Its handle, sealed with the server's key: never stored in the clear. */
  handle: string;
  /** Its handle's digest: what the source route finds the share by. */
  ref: string;
  /** The file it resolved to: what it reopens. */
  msid: string;
}
/**
 * A party's guest invitation, in the shared store (Redis when configured), so the link
 * survives a restart. Its secret and the host's token are sealed with the server's key.
 */
interface SavedShare {
  owner: string;
  expiresAt: number;
  entries: Entry[];
  bingeGroup?: string;
  ownerCheckedAt: number;
  /** The key the sealed values were sealed with: another reads as gone. */
  keyId: string;
  secret: string;
  ownerToken: string;
  revisions: Record<string, SavedRevision>;
  /**
   * A share link: one title, which whoever has the link plays on their own, with no party. Its
   * owner is the user who made it, and it lasts until they revoke it.
   */
  link?: boolean;
  createdAt?: number;
}
/** A share as this process holds it: unsealed, with what it resolved and opened here. */
interface Binding {
  party: string;
  ownerToken: string;
  owner: string;
  secret: string;
  expiresAt: number;
  entries: Map<string, Entry>;
  sources: Map<string, Promise<Source>>;
  /** Recent failures to resolve or open a source, so polling guests don't retry them. */
  failures: Map<string, { error: unknown; until: number; count: number }>;
  /** When `ownerToken` was last confirmed to belong to a signed-in host. */
  ownerCheckedAt: number;
  bingeGroup?: string;
  revisions: Record<string, SavedRevision>;
  /** When this process last read it from the store. */
  readAt: number;
  link?: boolean;
}
interface Source {
  handle: string;
  party: string;
  revision: string;
  playlistItemId: string;
  itemId: string;
  title: string;
  record: MediaSourceRecord;
  /** The shared reader's first open of the file, which /current waits for once. */
  opened?: Promise<void>;
  /** Opened: /current answers at once. */
  ready?: boolean;
  /** The host's item, found under the host's configuration: its artwork and segments. */
  host?: Located;
  artwork?: Promise<GuestArtwork>;
  segments?: Promise<GuestSegment[]>;
  /**
   * Where the source's redirects lead, followed once. Each range request of
   * the shared reader goes here directly: going back through the
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
/** Shares this process has read, unsealed; the store is the record. */
const bindings = new Map<string, Binding>();
/** How long a share read from the store is trusted without asking again. */
const SHARE_CACHE_MS = 5000;
/** The server key's id: what a sealed value was sealed with, so a rotated key reads as gone. */
const keyId = () =>
  digest(['guest-key', config.bootstrap.secretKey]).slice(0, 16);
function seal(value: string): string {
  const sealed = encryptString(value);
  if (!sealed.success || !sealed.data)
    fail(500, 'Could not keep the invitation');
  return sealed.data;
}
function unseal(value: string): string | null {
  const opened = decryptString(value);
  return opened.success ? opened.data : null;
}
const shareStore = sharedBackend().records<SavedShare>({
  name: 'guest-share',
  ownCap: true,
  save: (s) => s,
  load: (s) => s,
  // A share link that never expires is never due.
  due: (s) => (s.expiresAt === NEVER ? null : s.expiresAt),
  tags: (s) => (s.link ? [`link-owner:${s.owner}`] : []),
  refs: (s) => Object.values(s.revisions).map((r) => `src:${r.ref}`),
  receive: () => {},
  lapse: (party) => endShare(party),
});
/** A party's share, from this process for a few seconds, else from the store; none if it ended. */
async function loadBinding(party: string): Promise<Binding | undefined> {
  const cached = bindings.get(party);
  if (cached && Date.now() - cached.readAt < SHARE_CACHE_MS) {
    if (cached.expiresAt > Date.now()) return cached;
    void endShare(party);
    return undefined;
  }
  const saved = await shareStore.get(party);
  const secret = saved && saved.keyId === keyId() && unseal(saved.secret);
  const ownerToken = secret && unseal(saved.ownerToken);
  if (!saved || !secret || !ownerToken || saved.expiresAt <= Date.now()) {
    if (cached) forgetShare(party);
    if (saved && saved.expiresAt <= Date.now()) void endShare(party);
    return undefined;
  }
  const binding: Binding = cached ?? {
    party,
    ownerToken,
    owner: saved.owner,
    secret,
    expiresAt: saved.expiresAt,
    entries: new Map(),
    sources: new Map(),
    failures: new Map(),
    ownerCheckedAt: 0,
    revisions: {},
    readAt: 0,
  };
  Object.assign(binding, {
    ownerToken,
    owner: saved.owner,
    secret,
    expiresAt: saved.expiresAt,
    entries: new Map(saved.entries.map((e) => [e.ref, e])),
    bingeGroup: saved.bingeGroup,
    ownerCheckedAt: Math.max(binding.ownerCheckedAt, saved.ownerCheckedAt),
    revisions: saved.revisions,
    readAt: Date.now(),
    link: saved.link,
  });
  bindings.set(party, binding);
  return binding;
}
/** Changes a stored share (`change` may run more than once: it acts only on the record); read again next time. */
async function updateShare<R>(
  party: string,
  change: (saved: SavedShare) => R
): Promise<R | undefined> {
  const result = await shareStore.update(party, (saved) => change(saved));
  const cached = bindings.get(party);
  if (cached) cached.readAt = 0;
  return result;
}
/** Forgets a share in this process: what it resolved here goes too. */
function forgetShare(party: string): void {
  bindings.delete(party);
  for (const [handle, source] of sources)
    if (source.party === party) dropSource(handle);
}
/** Ends a share: its record, its guests' sessions (their leases freed), and its sources here. */
async function endShare(party: string): Promise<void> {
  forgetShare(party);
  await shareStore.update(party, (_s, tx) => tx.drop());
  await guestSessions.revokeParty(party);
}
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
const enabled = () => config.party.guestStreaming;
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
  if (binding.ownerToken === token) {
    const at = Date.now();
    binding.ownerCheckedAt = at;
    void updateShare(binding.party, (s) => {
      s.ownerCheckedAt = Math.max(s.ownerCheckedAt, at);
    }).catch(() => {});
  }
  return true;
}
async function active(req: Request, requireMember = true) {
  if (!enabled()) fail(410, 'Guest streaming is disabled');
  const token =
    bearer(req) || (typeof req.query.token === 'string' ? req.query.token : '');
  const session = await guestSessions.load(token);
  if (!session) {
    // A session from before guest sessions were kept: the restart dropped it.
    if (fromBeforeRestart(token))
      fail(
        401,
        'The server restarted; rejoin with the link',
        'session_restarted'
      );
    fail(401, 'This guest session has expired');
  }
  const binding = await loadBinding(session.party);
  const party = binding?.link
    ? linkParty(binding)
    : await guestPartyState(session.party);
  if (
    !binding ||
    !party ||
    binding.expiresAt <= Date.now() ||
    !(await ownerSignedIn(binding))
  )
    fail(410, 'This guest invitation has ended');
  if (
    requireMember &&
    !binding.link &&
    (!session.member || !party.members.some((m) => m.id === session.member))
  )
    fail(403, 'Join the party before playing');
  return { session, binding, party };
}
/** A share link's title, as the party state a guest's routes read: playing, with no members. */
function linkParty(binding: Binding) {
  const entry = [...binding.entries.values()][0];
  return {
    playing: entry ? { playlistItemId: LINK_ITEM, ref: entry.ref } : null,
    members: [] as { id: string; key: string }[],
  };
}
/** The one title a share link plays, as a party's playlist item. */
const LINK_ITEM = 'link';
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
  const revision = revisionOf(playing, entry);
  // Kept after it expires, so the next failure backs off longer.
  const failure = state.binding.failures.get(revision);
  if (failure && failure.until > Date.now()) throw failure.error;
  const pending = sourceFor(req, state.binding, playing, entry);
  const source = await pending;
  // The reader opens the file once (shared): a link that's gone or a placeholder fails here,
  // as the long poll's `failed`, rather than in the guest's player.
  const opened = (source.opened ??= readerFor(source).describe());
  try {
    await opened;
  } catch (error) {
    if (source.opened === opened) {
      source.opened = undefined;
      remember(state.binding, revision, error);
    }
    throw error;
  }
  source.ready = true;
  // Working again: the next failure starts from the shortest wait.
  state.binding.failures.delete(revision);
  return { ...state, source, file: fileOf(source) };
}
/** What the page is told of the file: no probe; the player reads its tracks itself. */
function fileOf(source: Source): GuestFile {
  return {
    container: source.record.container || null,
    durationMs: source.record.durationMs ?? null,
  };
}
/**
 * Remember a failure for a while: every guest polls /current every couple of seconds, and each
 * retry runs the host's whole addon pipeline.
 */
function remember(binding: Binding, revision: string, error: unknown): void {
  const status = (error as { status?: number }).status;
  logger.warn(
    {
      party: binding.party,
      status,
      error: typeof status === 'number' ? (error as Error).message : undefined,
      cause: typeof status === 'number' ? undefined : errorCause(error),
    },
    'guest source unavailable; backing off'
  );
  // A failure long past doesn't make the next wait longer.
  const previous = binding.failures.get(revision);
  const count =
    previous && previous.until > Date.now() - 5 * 60_000
      ? previous.count + 1
      : 1;
  const after = (error as { retryAfter?: number }).retryAfter;
  binding.failures.set(revision, {
    error,
    count,
    until:
      Date.now() +
      (after
        ? after * 1000
        : FAILURE_BACKOFF_MS[Math.min(count, FAILURE_BACKOFF_MS.length) - 1]),
  });
  if (binding.failures.size > 100)
    for (const [k, f] of binding.failures)
      if (f.until <= Date.now()) binding.failures.delete(k);
}
/**
 * The source a revision plays, resolved once for every guest and the page alike.
 * A revision the share kept a source for (before a restart) reopens as that source: its handle,
 * and its file. Otherwise, or if that file is gone, a new one, which the share then keeps.
 */
function sourceFor(
  req: Request,
  binding: Binding,
  playing: { playlistItemId: string },
  entry: Entry
): Promise<Source> {
  const revision = revisionOf(playing, entry);
  const known = binding.sources.get(revision);
  if (known) return known;
  const pending = (async () => {
    const user = await userForToken(binding.ownerToken);
    if (!user) fail(410, 'The host session has expired');
    const kept = binding.revisions[revision];
    const keptHandle = kept && unseal(kept.handle);
    const resolve = (choice: Entry, onLocate?: (loc: Located) => void) =>
      lookupRecord(req, user, choice, binding.bingeGroup, 'guest', onLocate);
    let host: Located | undefined;
    let record: MediaSourceRecord | undefined;
    let handle: string | undefined;
    if (keptHandle)
      try {
        // The same file it played: an explicit choice, so never another one silently.
        const same = await resolve(
          { ...entry, sourceId: kept.msid },
          (loc) => (host = loc)
        );
        if (same.msid === kept.msid) {
          record = same;
          handle = keptHandle;
        }
      } catch (error) {
        logger.info(
          { party: binding.party, cause: errorCause(error) },
          'guest source kept from before cannot be reopened; resolving again'
        );
      }
    if (!record) record = await resolve(entry, (loc) => (host = loc));
    if (!handle) handle = randomSecret();
    binding.bingeGroup = record.extension.bingeGroup;
    const source: Source = {
      handle,
      party: binding.party,
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
          binding.bingeGroup,
          'guest',
          undefined,
          true
        ),
    };
    sources.set(source.handle, source);
    // The share keeps the source this revision plays (and only it: an older handle no longer
    // opens anything), so it reopens as itself after a restart.
    const ref = digest(['handle', source.handle]);
    if (
      kept?.ref !== ref ||
      binding.revisions[revision]?.msid !== record.msid
    ) {
      const sealed = seal(source.handle);
      const msid = record.msid;
      const bingeGroup = binding.bingeGroup;
      await updateShare(binding.party, (s) => {
        s.revisions = { [revision]: { handle: sealed, ref, msid } };
        s.bingeGroup = bingeGroup;
      });
    }
    return source;
  })();
  binding.sources.set(revision, pending);
  pending.then((source) => settled.set(pending, source)).catch(() => {});
  pending.catch((error) => {
    if (binding.sources.get(revision) === pending)
      binding.sources.delete(revision);
    remember(binding, revision, error);
  });
  return pending;
}
/** A title's identity: the item playing, and the host's version of it. */
function revisionOf(
  playing: { playlistItemId: string },
  entry: { itemId: string; sourceId?: string; filename?: string }
): string {
  return digest([
    playing.playlistItemId,
    entry.itemId,
    entry.sourceId,
    entry.filename,
  ]);
}
/** Each resolved source, by the resolve that found it: whether one has finished, without waiting. */
const settled = new WeakMap<Promise<Source>, Source>();
/**
 * Where the title playing is, without waiting for it: `ready` (resolved and opened), `resolving`,
 * or `failed` (backing off after a failure). Null if there is none to play yet.
 */
function peek(state: Awaited<ReturnType<typeof active>>) {
  const playing = state.party.playing;
  const entry = playing && state.binding.entries.get(playing.ref);
  if (!playing || !entry) return null;
  const revision = revisionOf(playing, entry);
  const failure = state.binding.failures.get(revision);
  const pending = state.binding.sources.get(revision);
  const source = pending && settled.get(pending);
  const now: 'ready' | 'resolving' | 'failed' =
    failure && failure.until > Date.now()
      ? 'failed'
      : source?.ready
        ? 'ready'
        : 'resolving';
  return { revision, playing, entry, state: now, failure };
}
/** How long /current waits for the title to change before answering what it is. */
export const CURRENT_WAIT = { ms: 25_000 };
/** The party playback a media URL belongs to. */
const streaming = (req: Request) => current(req);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
// Apps that load the web app from elsewhere (TVs, the standalone build) call
// these from another origin; the guest page itself is same-origin.
router.use(
  ['/available', '/host', '/publish', '/disable', '/media', '/links'],
  jellyfinCors
);
router.get('/available', (_req, res) => res.json({ enabled: enabled() }));
router.post('/host', async (req, res) => {
  if (!enabled()) fail(503, 'Guest streaming is not enabled on this server');
  const body = hostSchema.parse(req.body);
  const { party, token } = await host(req, body);
  let binding = await loadBinding(body.party);
  if (!binding) {
    const saved: SavedShare = {
      owner: party.host,
      expiresAt: party.expiresAt,
      entries: [],
      ownerCheckedAt: Date.now(),
      keyId: keyId(),
      secret: seal(randomSecret()),
      ownerToken: seal(token),
      revisions: {},
    };
    // One that can't be read (sealed with another key, or ended) is replaced.
    if ((await shareStore.create(body.party, () => saved, 0)) === 'exists') {
      await shareStore.update(body.party, (_s, tx) => tx.drop());
      await shareStore.create(body.party, () => saved, 0);
    }
    bindings.delete(body.party);
    binding = await loadBinding(body.party);
    if (!binding) fail(503, 'The invitation could not be kept; try again');
  }
  if (binding.owner !== party.host)
    fail(403, 'Only the original sharing host may manage this invitation');
  res.json({ secret: binding.secret, expiresAt: binding.expiresAt });
});
router.post('/publish', async (req, res) => {
  const body = publishSchema.parse(req.body);
  await host(req, body);
  const binding = await loadBinding(body.party);
  if (!binding || binding.owner !== body.member)
    fail(404, 'Guest streaming is not enabled for this party');
  const ownerToken = seal(bearer(req));
  const at = Date.now();
  await updateShare(body.party, (s) => {
    s.ownerToken = ownerToken;
    s.ownerCheckedAt = at;
    s.entries = body.entries;
  });
  binding.ownerToken = bearer(req);
  binding.ownerCheckedAt = at;
  binding.entries = new Map(body.entries.map((e) => [e.ref, e]));
  // The host may have just re-selected a source that failed.
  binding.failures.clear();
  res.json({ ok: true });
});
router.post('/disable', async (req, res) => {
  const body = hostSchema.parse(req.body);
  await host(req, body);
  await endShare(body.party);
  res.json({ ok: true });
});
router.post('/exchange', async (req, res) => {
  limit(req);
  if (!enabled()) fail(410, 'Guest streaming is disabled');
  const body = z
    .object({ party: key, secret: z.string().length(43) })
    .parse(req.body);
  const binding = await loadBinding(body.party);
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
  // Revoked by a kick or the share ending, which ends its reads (`onRevoke`).
  const session = await guestSessions.create(body.party, binding.expiresAt);
  res.json({ token: session.token, expiresAt: session.expiresAt });
});
/** A share link that lasts until it's revoked: kept with no expiry. */
const NEVER = Number.MAX_SAFE_INTEGER;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a link's viewer session lasts; the page exchanges the link again after. */
const LINK_SESSION_MS = 24 * 60 * 60 * 1000;
/** The most share links one user keeps. */
const MAX_LINKS = 100;
const linkSchema = z.object({
  itemId: z.string().regex(/^[0-9a-f]{32}$/),
  sourceId: z.string().max(100).optional(),
  /** How many days the link lasts; none, until it's revoked. */
  days: z.number().int().min(1).max(365).nullable().optional(),
});
/** The signed-in user a share link request comes from. */
async function linkOwner(req: Request) {
  if (!enabled()) fail(503, 'Guest streaming is not enabled on this server');
  const token = bearer(req);
  const user = await userForToken(token);
  if (!user) fail(401, 'Sign in to share a link');
  return { user, token };
}
/** A title as a link names it: an episode with its show and number. */
async function titleOf(loc: Located | undefined): Promise<string | undefined> {
  if (!loc) return undefined;
  try {
    const item = (await itemFromDescriptor(loc.ctx, loc.descriptor)) as {
      Name?: string;
      SeriesName?: string;
      ParentIndexNumber?: number;
      IndexNumber?: number;
    } | null;
    if (!item?.Name) return undefined;
    if (!item.SeriesName) return item.Name;
    const number =
      item.ParentIndexNumber != null && item.IndexNumber != null
        ? ` S${String(item.ParentIndexNumber).padStart(2, '0')}E${String(item.IndexNumber).padStart(2, '0')}`
        : '';
    return `${item.SeriesName}${number} · ${item.Name}`;
  } catch {
    return undefined;
  }
}
/**
 * Makes a share link to a title, in the version the user plays: whoever has the link plays it on
 * their own, without an account, until the user revokes it. The version is kept by its file, so
 * the link still finds it when the user's list of versions is run again.
 */
router.post('/links', async (req, res) => {
  const { user, token } = await linkOwner(req);
  const body = linkSchema.parse(req.body);
  if ((await shareStore.tagged(`link-owner:${user.uuid}`)).length >= MAX_LINKS)
    fail(409, `You have ${MAX_LINKS} share links; revoke one first`);
  let loc: Located | undefined;
  const record = await lookupRecord(
    req,
    user,
    body,
    undefined,
    'guest',
    (found) => (loc = found)
  );
  const id = randomBytes(16).toString('base64url');
  const secret = randomSecret();
  const title = (await titleOf(loc)) ?? record.filename ?? 'Video';
  const now = Date.now();
  const saved: SavedShare = {
    owner: user.uuid,
    link: true,
    createdAt: now,
    expiresAt: body.days ? now + body.days * DAY_MS : NEVER,
    entries: [
      { ref: id, itemId: body.itemId, title, filename: record.filename },
    ],
    ownerCheckedAt: now,
    keyId: keyId(),
    secret: seal(secret),
    ownerToken: seal(token),
    revisions: {},
  };
  if ((await shareStore.create(id, () => saved, 0)) !== 'ok')
    fail(503, 'The link could not be kept; try again');
  res.json({
    id,
    secret,
    title,
    createdAt: now,
    expiresAt: saved.expiresAt === NEVER ? null : saved.expiresAt,
  });
});
/** The user's share links, newest first, with what rebuilds each address. */
router.get('/links', async (req, res) => {
  const { user } = await linkOwner(req);
  const ids = await shareStore.tagged(`link-owner:${user.uuid}`);
  const links = [];
  for (const id of ids) {
    const saved = await shareStore.get(id);
    const secret = saved?.keyId === keyId() && unseal(saved.secret);
    if (!saved?.link || saved.owner !== user.uuid || !secret) continue;
    links.push({
      id,
      secret,
      title: saved.entries[0]?.title ?? '',
      createdAt: saved.createdAt ?? 0,
      expiresAt: saved.expiresAt === NEVER ? null : saved.expiresAt,
    });
  }
  links.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ links });
});
/** Revokes a share link: its viewers' sessions and reads end with it. */
router.delete('/links/:id', async (req, res) => {
  const { user } = await linkOwner(req);
  const id = key.parse(req.params.id);
  const saved = await shareStore.get(id);
  if (!saved?.link || saved.owner !== user.uuid)
    fail(404, 'No such share link');
  await endShare(id);
  res.json({ ok: true });
});
/** A share link's viewer: a session for the link's title, as a guest's. */
router.post('/links/exchange', async (req, res) => {
  limit(req);
  if (!enabled()) fail(410, 'Guest streaming is disabled');
  const body = z
    .object({ link: key, secret: z.string().length(43) })
    .parse(req.body);
  const binding = await loadBinding(body.link);
  const a = Buffer.from(body.secret),
    b = Buffer.from(binding?.secret ?? '');
  if (
    !binding?.link ||
    a.length !== b.length ||
    !timingSafeEqual(a, b) ||
    binding.expiresAt <= Date.now()
  )
    fail(410, 'This link has been revoked');
  const session = await guestSessions.create(
    body.link,
    Math.min(binding.expiresAt, Date.now() + LINK_SESSION_MS)
  );
  res.json({ token: session.token, expiresAt: session.expiresAt });
});
/**
 * The title the party plays, its file and artwork. With `after` (what the page has: its token,
 * `<revision>:<ready|resolving|failed>`), a long poll: it answers at once when that's changed (a
 * title change, a host's version switch, a failure, a recovery), otherwise when it changes, within
 * 25 s. A title still resolving is answered as `resolving` at once, its resolve going on behind;
 * a failure as `failed`, with its message and code.
 */
router.get('/current', async (req, res) => {
  const after = typeof req.query.after === 'string' ? req.query.after : null;
  const answer = async () => {
    const { source, file } = await current(req);
    // Found once per title, shared by every guest's poll.
    const artwork = await (source.artwork ??= artworkOf(source));
    res.json({
      state: 'ready',
      token: `${source.revision}:ready`,
      revision: source.revision,
      playlistItemId: source.playlistItemId,
      itemId: source.itemId,
      title: source.title,
      file,
      artwork,
    });
  };
  if (after === null) return answer();
  const deadline = Date.now() + CURRENT_WAIT.ms;
  for (;;) {
    const now = peek(await active(req));
    // Nothing to play yet (no title, or not shared): as without `after`.
    if (!now) return answer();
    // Resolve it (once, shared), or again once a failure's back-off has passed.
    if (now.state === 'resolving') void current(req).catch(() => {});
    const token = `${now.revision}:${now.state}`;
    // A page playing this revision isn't told it's resolving again: this process reopens the
    // same source (after a restart, under its kept handle), and the page plays on meanwhile.
    const reopening =
      now.state === 'resolving' && after === `${now.revision}:ready`;
    if ((token !== after && !reopening) || Date.now() >= deadline) {
      if (now.state === 'ready') return answer();
      const failure = now.failure?.error as
        { message?: string; status?: number; code?: string } | undefined;
      return void res.json({
        state: now.state,
        token,
        revision: now.revision,
        playlistItemId: now.playing.playlistItemId,
        itemId: now.entry.itemId,
        title: now.entry.title,
        ...(now.state === 'failed'
          ? {
              error: failure?.message ?? 'The source failed',
              status: failure?.status,
              code: failure?.code,
            }
          : {}),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
});
/** The host's intro, recap and credits for the title playing, as their own player gets them. */
router.get('/segments', async (req, res) => {
  const { source, file } = await current(req);
  // The title's runtime, as the host's own segment route has it, else the file's.
  const runtimeMs =
    source.host?.memo?.runtimeMs ?? file.durationMs ?? undefined;
  const segments = await (source.segments ??= segmentsOf(source, runtimeMs));
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
 * turned on), at the title's runtime. None where segments are off or can't be looked up.
 */
async function segmentsOf(
  source: Source,
  runtimeMs: number | undefined
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
  // A clip in place of the file must not reach a guest's player as the episode.
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
/**
 * The file the party plays, for a guest's player to read directly: authorised by the guest's
 * session token and the revision it was given (a host's new title or version ends it), and read
 * through the source's shared reader, so every guest shares one read of the upstream file.
 */
router.all('/media/original', async (req, res) => {
  const { session, source } = await streaming(req);
  if (req.query.revision !== source.revision) fail(410, 'Playback changed');
  const revoke = guestSessions.onRevoke(session.token, () => res.destroy());
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void streaming(req)
      .then((now) => {
        if (now.source.revision !== source.revision) res.destroy();
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
    // Machine-readable cause, where one is known (source_failed, ...).
    code: typeof error.code === 'string' ? error.code : undefined,
  });
});
/**
 * Ends the shares this process holds whose party is gone or whose time is up. A share link has no
 * party: it ends only when it's revoked or its time is up.
 */
export function sweepShares(): void {
  guestSessions.sweep();
  for (const [id, b] of bindings) {
    if (b.link) {
      if (b.expiresAt <= Date.now()) void endShare(id);
      continue;
    }
    void guestPartyState(id)
      .then((p) => {
        if (!p || b.expiresAt <= Date.now()) return endShare(id);
      })
      .catch(() => {});
  }
}
const sweep = setInterval(sweepShares, 30000);
sweep.unref();
export default router;
