import { randomBytes, createHash } from 'node:crypto';

export const randomSecret = () => randomBytes(32).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const status = (code: number, message: string) =>
  Object.assign(new Error(message), { status: code });
/** A playback's stream jobs at the transcoder: video, and audio and subtitles when converted. */
export interface PlaybackJobs {
  video: string;
  audio?: string;
  subtitle?: string;
}
export interface GuestSession {
  token: string;
  party: string;
  member?: string;
  expiresAt: number;
  /** The converted playback's jobs at the transcoder, held by `lease`. */
  jobs?: PlaybackJobs;
  lease?: string;
  generation?: number;
  source?: string;
  offsetMs?: number;
  revision?: string;
}
/** Memory only: neither invites nor source credentials survive a restart. */
export class GuestSessions {
  private listeners = new Map<string, Set<() => void>>();
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
  private remove(key: string): void {
    this.sessions.delete(key);
    for (const listener of this.listeners.get(key) ?? []) {
      try {
        listener();
      } catch {}
    }
    this.listeners.delete(key);
  }
  private sessions = new Map<string, GuestSession>();
  /**
   * One party may hold at most `perParty` sessions. At that limit the oldest
   * session that never joined is dropped, so one invite holder cannot fill the
   * server or lock other guests out of their own party.
   */
  create(party: string, expiresAt: number, perParty = 64): GuestSession {
    this.sweep();
    let count = 0;
    let unjoined: string | undefined;
    for (const [key, session] of this.sessions)
      if (session.party === party) {
        count++;
        if (!session.member) unjoined ??= key;
      }
    if (count >= perParty) {
      if (!unjoined) throw status(403, 'This party is closed or full');
      this.remove(unjoined);
    }
    if (this.sessions.size >= 16000)
      throw status(503, 'Guest session capacity reached; retry later');
    const token = `guest.${randomSecret()}`;
    const session = { token, party, expiresAt };
    this.sessions.set(digest(token), session);
    return session;
  }
  get(token: string): GuestSession | undefined {
    const session = this.sessions.get(digest(token));
    if (!session || session.expiresAt <= Date.now()) {
      this.remove(digest(token));
      return undefined;
    }
    return session;
  }
  revokeParty(party: string): void {
    for (const [key, session] of this.sessions)
      if (session.party === party) this.remove(key);
  }
  revokeMember(party: string, member: string): void {
    for (const [key, session] of this.sessions)
      if (session.party === party && session.member === member)
        this.remove(key);
  }
  sweep(): void {
    for (const [key, session] of this.sessions)
      if (session.expiresAt <= Date.now()) this.remove(key);
  }
}
export const guestSessions = new GuestSessions();
