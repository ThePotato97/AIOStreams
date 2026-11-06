import { randomBytes, createHash } from 'node:crypto';

export const randomSecret = () => randomBytes(32).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export interface GuestSession {
  token: string;
  party: string;
  member?: string;
  expiresAt: number;
  job?: string;
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
  create(party: string, expiresAt: number): GuestSession {
    this.sweep();
    if (this.sessions.size >= 16000)
      throw new Error('Guest session capacity reached');
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
