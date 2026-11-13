import { randomBytes, createHash } from 'node:crypto';
import {
  createLogger,
  sharedBackend,
  type MaybePromise,
  type SharedRecords,
} from '@aiostreams/core';

export const randomSecret = () => randomBytes(32).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const status = (code: number, message: string, code2?: string) =>
  Object.assign(new Error(message), {
    status: code,
    ...(code2 && { code: code2 }),
  });
const logger = createLogger('guest');

/** A playback's stream jobs at the transcoder: video, and audio and subtitles when converted. */
export interface PlaybackJobs {
  video: string;
  audio?: string;
  subtitle?: string;
}
/** What a guest session keeps, in the shared store: never its token, only the token's digest as its id. */
export interface SavedGuestSession {
  party: string;
  member?: string;
  expiresAt: number;
  createdAt: number;
  /** The converted playback's jobs at the transcoder, held by `lease`. */
  jobs?: PlaybackJobs;
  lease?: string;
  generation?: number;
  /** The playing source: its handle's digest (the handle itself is kept, sealed, with the share). */
  sourceRef?: string;
  offsetMs?: number;
  revision?: string;
}
/** A guest session as this process holds it: what's stored, with the token it was asked by. */
export interface GuestSession extends SavedGuestSession {
  token: string;
}
/** Tokens minted since sessions were kept in the store; older ones were in memory only. */
const TOKEN_PREFIX = 'guest.v2.';
/** How long a session read from the store is trusted without asking again. */
const CACHE_MS = 5000;
/** How long a revocation is remembered here, past the store write. */
const TOMBSTONE_MS = 60_000;

/** Whether a token is from before sessions were kept in the store (a restart dropped it). */
export function fromBeforeRestart(token: string): boolean {
  return token.startsWith('guest.') && !token.startsWith(TOKEN_PREFIX);
}

/**
 * Guest sessions, kept in the shared store (Redis when configured), so a guest's link and
 * session survive a restart. This process keeps a short cache of what it read, and its own
 * revocation listeners (a stream or socket to close).
 */
export class GuestSessions {
  private listeners = new Map<string, Set<() => void>>();
  private cache = new Map<string, { session: GuestSession; at: number }>();
  private tombstones = new Map<string, number>();
  private records: SharedRecords<SavedGuestSession> | undefined;
  /** Frees a lease at the transcoder: the guest server sets it. */
  releaseLease: (lease: string) => Promise<void> = async () => {};

  private store(): SharedRecords<SavedGuestSession> {
    return (this.records ??= sharedBackend().records<SavedGuestSession>({
      name: 'guest-session',
      ownCap: true,
      save: (s) => s,
      load: (s) => s,
      due: (s) => s.expiresAt,
      tags: (s) => [`party:${s.party}`],
      receive: () => {},
      lapse: (id) => this.drop(id),
    }));
  }

  onRevoke(token: string, listener: () => void): () => void {
    const key = digest(token);
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  /** Revoked here at once (a tombstone `load` honours), then in the store, its lease freed. */
  private revoke(key: string): void {
    this.tombstones.set(key, Date.now() + TOMBSTONE_MS);
    this.cache.delete(key);
    for (const listener of this.listeners.get(key) ?? []) {
      try {
        listener();
      } catch {}
    }
    this.listeners.delete(key);
  }

  /** Removes a stored session and frees what it held at the transcoder. */
  private async drop(key: string): Promise<void> {
    this.revoke(key);
    const lease = await this.store().update(key, (s, tx) => {
      tx.drop();
      return s.jobs ? s.lease : undefined;
    });
    if (lease) await this.releaseLease(lease).catch(() => {});
  }

  /**
   * One party may hold at most `perParty` sessions. At that limit the oldest session that never
   * joined is dropped, so one invite holder cannot fill the server or lock other guests out of
   * their own party.
   */
  async create(
    party: string,
    expiresAt: number,
    perParty = 64
  ): Promise<GuestSession> {
    const store = this.store();
    const ids = await store.tagged(`party:${party}`);
    const held: [string, SavedGuestSession][] = [];
    for (const id of ids) {
      const saved = await store.get(id);
      if (saved && saved.expiresAt > Date.now()) held.push([id, saved]);
    }
    if (held.length >= perParty) {
      const unjoined = held
        .filter(([, s]) => !s.member)
        .sort(([, a], [, b]) => a.createdAt - b.createdAt)[0];
      if (!unjoined) throw status(403, 'This party is closed or full');
      await this.drop(unjoined[0]);
    }
    const token = `${TOKEN_PREFIX}${randomSecret()}`;
    const saved: SavedGuestSession = {
      party,
      expiresAt,
      createdAt: Date.now(),
    };
    const made = await store.create(digest(token), () => ({ ...saved }), 16000);
    if (made === 'busy')
      throw status(503, 'Guest session capacity reached; retry later');
    if (made !== 'ok')
      throw status(503, 'Guest session could not be created; retry');
    return this.remember(token, saved);
  }

  private remember(token: string, saved: SavedGuestSession): GuestSession {
    const session = { ...saved, token };
    this.cache.set(digest(token), { session, at: Date.now() });
    return session;
  }

  /** The session a token holds: from this process for a few seconds, else from the store. */
  async load(token: string): Promise<GuestSession | undefined> {
    const key = digest(token);
    if ((this.tombstones.get(key) ?? 0) > Date.now()) return undefined;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      if (cached.session.expiresAt > Date.now()) return cached.session;
      void this.drop(key);
      return undefined;
    }
    const saved = await this.store().get(key);
    if ((this.tombstones.get(key) ?? 0) > Date.now()) return undefined;
    if (!saved || saved.expiresAt <= Date.now()) {
      this.cache.delete(key);
      if (saved) void this.drop(key);
      return undefined;
    }
    return this.remember(token, saved);
  }

  /** What this process last read for a token, without asking the store: may be stale or absent. */
  get(token: string): GuestSession | undefined {
    const key = digest(token);
    if ((this.tombstones.get(key) ?? 0) > Date.now()) return undefined;
    const session = this.cache.get(key)?.session;
    return session && session.expiresAt > Date.now() ? session : undefined;
  }

  /**
   * Changes a stored session: `change` runs on the stored record (it may run more than once, so
   * it acts only through it) and returns what it decided; this process's copy follows.
   */
  async update<R>(
    token: string,
    change: (saved: SavedGuestSession) => R
  ): Promise<R | undefined> {
    const key = digest(token);
    let after: SavedGuestSession | undefined;
    const result = await this.store().update(key, (saved) => {
      const r = change(saved);
      after = { ...saved };
      return r;
    });
    if (after && !((this.tombstones.get(key) ?? 0) > Date.now()))
      this.remember(token, after);
    return result;
  }

  /** Takes a seat for the session, unless another seat has it (a concurrent join). */
  async claimSeat(token: string, seat: string): Promise<boolean> {
    const claimed = await this.update(token, (s) => {
      if (s.member && s.member !== seat) return false;
      s.member = seat;
      return true;
    });
    return claimed === true;
  }

  /** Gives a seat back, if the session still holds it. */
  async releaseSeat(token: string, seat: string): Promise<void> {
    await this.update(token, (s) => {
      if (s.member === seat) s.member = undefined;
    });
  }

  private revokeWhere(
    party: string,
    match: (s: SavedGuestSession) => boolean
  ): MaybePromise<void> {
    // At once here, for the sessions this process knows; the store's own list follows.
    for (const [key, { session }] of this.cache)
      if (session.party === party && match(session)) this.revoke(key);
    const store = this.store();
    return (async () => {
      for (const id of await store.tagged(`party:${party}`)) {
        const saved = await store.get(id);
        if (saved && match(saved)) await this.drop(id);
      }
    })().catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'guest session revoke failed'
      )
    );
  }

  revokeParty(party: string): MaybePromise<void> {
    return this.revokeWhere(party, () => true);
  }

  revokeMember(party: string, member: string): MaybePromise<void> {
    return this.revokeWhere(party, (s) => s.member === member);
  }

  /** Forgets what this process has read and remembered past its time. */
  sweep(): void {
    const now = Date.now();
    for (const [key, { session, at }] of this.cache)
      if (session.expiresAt <= now || now - at > CACHE_MS)
        this.cache.delete(key);
    for (const [key, until] of this.tombstones)
      if (until <= now) this.tombstones.delete(key);
  }
}
export const guestSessions = new GuestSessions();
