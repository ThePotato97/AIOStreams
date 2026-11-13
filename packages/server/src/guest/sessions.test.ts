import { describe, it, expect, vi } from 'vitest';

const quiet = vi.hoisted(
  () => () =>
    Object.fromEntries(
      ['warn', 'error', 'info', 'debug'].map((l) => [l, () => {}])
    )
);
vi.mock('../../../core/src/logging/logger.js', () => ({ createLogger: quiet }));
// The shared store as a server without Redis has it: in this process.
vi.mock('@aiostreams/core', async () => {
  const { MemoryBackend } =
    await import('../../../core/src/sync/store/memory.js');
  const backend = new MemoryBackend();
  return { createLogger: quiet, sharedBackend: () => backend };
});

import { GuestSessions, fromBeforeRestart } from './sessions.js';

/** A session store sharing its records with `of`: what another process (or this one after a restart) reads. */
function restarted(of: GuestSessions): GuestSessions {
  const next = new GuestSessions();
  (next as unknown as { records: unknown }).records = (
    of as unknown as { records: unknown }
  ).records;
  return next;
}

describe('guest session boundaries', () => {
  it('revokes only the removed member, then the whole party', async () => {
    const store = new GuestSessions();
    const one = await store.create('party', Date.now() + 60000);
    await store.claimSeat(one.token, 'one');
    const two = await store.create('party', Date.now() + 60000);
    await store.claimSeat(two.token, 'two');
    const other = await store.create('other', Date.now() + 60000);
    await store.revokeMember('party', 'one');
    expect(await store.load(one.token)).toBeUndefined();
    expect((await store.load(two.token))?.member).toBe('two');
    await store.revokeParty('party');
    expect(await store.load(two.token)).toBeUndefined();
    expect((await store.load(other.token))?.party).toBe('other');
  });
  it('notifies active streams and sockets immediately on revocation', async () => {
    const store = new GuestSessions();
    const session = await store.create('party', Date.now() + 60000);
    await store.claimSeat(session.token, 'one');
    const close = vi.fn();
    store.onRevoke(session.token, close);
    void store.revokeMember('party', 'one');
    // At once, before the store's write: a reconnect now is refused.
    expect(close).toHaveBeenCalledTimes(1);
    expect(await store.load(session.token)).toBeUndefined();
    await store.revokeParty('party');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('expires tokens and never accepts fabricated credentials', async () => {
    const store = new GuestSessions();
    const token = (await store.create('party', Date.now() + 1000)).token;
    expect(await store.load('guest.v2.forged')).toBeUndefined();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    expect(await store.load(token)).toBeUndefined();
    vi.restoreAllMocks();
  });
  it('caps sessions per party by dropping the oldest unjoined one', async () => {
    const store = new GuestSessions();
    const expires = Date.now() + 60000;
    const joined = await store.create('party', expires, 3);
    await store.claimSeat(joined.token, 'one');
    const first = await store.create('party', expires, 3);
    const second = await store.create('party', expires, 3);
    const other = await store.create('other', expires, 3);
    const third = await store.create('party', expires, 3);
    expect(await store.load(first.token)).toBeUndefined();
    expect(await store.load(joined.token)).toBeDefined();
    expect(await store.load(second.token)).toBeDefined();
    expect(await store.load(third.token)).toBeDefined();
    expect(await store.load(other.token)).toBeDefined();
    await store.claimSeat(second.token, 'two');
    await store.claimSeat(third.token, 'three');
    await expect(store.create('party', expires, 3)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('guest sessions through a restart', () => {
  it('a session made before a restart is found after it, seat and playback included', async () => {
    const before = new GuestSessions();
    const session = await before.create('party', Date.now() + 60000);
    await before.claimSeat(session.token, 'seat');
    await before.update(session.token, (s) => {
      s.lease = 'lease';
      s.jobs = { video: 'v1' };
      s.generation = 3;
    });
    const after = restarted(before);
    // Nothing in this process yet: not a revocation.
    expect(after.get(session.token)).toBeUndefined();
    const found = await after.load(session.token);
    expect(found).toMatchObject({
      party: 'party',
      member: 'seat',
      lease: 'lease',
      jobs: { video: 'v1' },
      generation: 3,
    });
    // A reconnect after the restart takes the same seat back.
    expect(await after.claimSeat(session.token, 'seat')).toBe(true);
  });
  it('a concurrent join with the same token is refused another seat', async () => {
    const store = new GuestSessions();
    const session = await store.create('party', Date.now() + 60000);
    expect(await store.claimSeat(session.token, 'a')).toBe(true);
    expect(await store.claimSeat(session.token, 'b')).toBe(false);
    await store.releaseSeat(session.token, 'b');
    expect((await store.load(session.token))?.member).toBe('a');
    await store.releaseSeat(session.token, 'a');
    expect(await store.claimSeat(session.token, 'b')).toBe(true);
  });
  it('frees the stored lease when a session is revoked, read from the record after a restart', async () => {
    const before = new GuestSessions();
    const session = await before.create('party', Date.now() + 60000);
    await before.claimSeat(session.token, 'seat');
    await before.update(session.token, (s) => {
      s.lease = 'lease-1';
      s.jobs = { video: 'v1' };
    });
    const after = restarted(before);
    const released: string[] = [];
    after.releaseLease = async (lease) => void released.push(lease);
    await after.revokeParty('party');
    expect(released).toEqual(['lease-1']);
    expect(await after.load(session.token)).toBeUndefined();
  });
  it('keeps no token in what it stores', async () => {
    const store = new GuestSessions();
    const session = await store.create('party', Date.now() + 60000);
    const records = (
      store as unknown as { records: { live: Map<string, unknown> } }
    ).records;
    expect(JSON.stringify([...records.live])).not.toContain(session.token);
    expect(JSON.stringify([...records.live])).not.toContain(
      session.token.slice('guest.v2.'.length)
    );
  });
  it('tells tokens from before sessions were stored from today’s', async () => {
    const store = new GuestSessions();
    const session = await store.create('party', Date.now() + 60000);
    expect(fromBeforeRestart(session.token)).toBe(false);
    expect(fromBeforeRestart('guest.' + 'x'.repeat(43))).toBe(true);
    expect(fromBeforeRestart('own.' + 'x'.repeat(43))).toBe(false);
  });
});
