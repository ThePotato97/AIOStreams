import { describe, it, expect, vi } from 'vitest';
import { GuestSessions } from './sessions.js';
describe('guest session boundaries', () => {
  it('revokes only the removed member, then the whole party', () => {
    const store = new GuestSessions();
    const one = store.create('party', Date.now() + 60000);
    one.member = 'one';
    const two = store.create('party', Date.now() + 60000);
    two.member = 'two';
    const other = store.create('other', Date.now() + 60000);
    store.revokeMember('party', 'one');
    expect(store.get(one.token)).toBeUndefined();
    expect(store.get(two.token)).toBe(two);
    store.revokeParty('party');
    expect(store.get(two.token)).toBeUndefined();
    expect(store.get(other.token)).toBe(other);
  });
  it('notifies active streams and sockets immediately on revocation', () => {
    const store = new GuestSessions();
    const session = store.create('party', Date.now() + 60000);
    session.member = 'one';
    const close = vi.fn();
    store.onRevoke(session.token, close);
    store.revokeMember('party', 'one');
    store.revokeParty('party');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('expires tokens and never accepts fabricated credentials', () => {
    const store = new GuestSessions();
    const token = store.create('party', Date.now() + 1000).token;
    expect(store.get('guest.forged')).toBeUndefined();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    expect(store.get(token)).toBeUndefined();
    vi.restoreAllMocks();
  });
  it('caps sessions per party by dropping the oldest unjoined one', () => {
    const store = new GuestSessions();
    const expires = Date.now() + 60000;
    const joined = store.create('party', expires, 3);
    joined.member = 'one';
    const first = store.create('party', expires, 3);
    const second = store.create('party', expires, 3);
    const other = store.create('other', expires, 3);
    const third = store.create('party', expires, 3);
    expect(store.get(first.token)).toBeUndefined();
    expect(store.get(joined.token)).toBe(joined);
    expect(store.get(second.token)).toBe(second);
    expect(store.get(third.token)).toBe(third);
    expect(store.get(other.token)).toBe(other);
    second.member = 'two';
    third.member = 'three';
    expect(() => store.create('party', expires, 3)).toThrow(
      expect.objectContaining({ status: 403 })
    );
  });
});
