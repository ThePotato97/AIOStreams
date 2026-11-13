/* eslint-disable lingui/no-unlocalized-strings -- test data, not UI text. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  timeline: null as null | {
    playlistItemId: string;
    positionMs: number;
    when: number;
    playing: boolean;
  },
}));
vi.mock('./party', () => ({
  party: {
    request: (r: Record<string, unknown>) => fixture.requests.push(r),
    state: () => ({ status: 'live', timeline: fixture.timeline }),
    clock: () => null,
    offset: () => {},
    resumeAt: () => {},
    playOn: () => {},
  },
  positionAt: (t: { positionMs: number }) => t.positionMs,
  useParty: () => null,
}));
vi.mock('../settings', () => ({
  settings: { party: { speedSync: { read: () => false } } },
}));
import { Follower } from './playback';
import type { PlayerController, PlayerState } from '../playback/controller';

const ITEM = 'i'.repeat(32);
function controller() {
  const c = {
    state: { loaded: true, paused: false, waiting: false } as PlayerState,
    playhead: { positionMs: 0, subscribe: () => () => {} },
    setPaused: vi.fn(),
    seek: vi.fn(),
  };
  return c as unknown as PlayerController & { state: PlayerState };
}
const waits = () =>
  fixture.requests
    .filter((r) => r.type === 'IgnoreWait')
    .map((r) => r.ignoreWait);
const buffers = () => fixture.requests.filter((r) => r.type === 'Buffer');

beforeEach(() => {
  vi.useFakeTimers();
  fixture.requests = [];
  fixture.timeline = {
    playlistItemId: ITEM,
    positionMs: 0,
    when: 0,
    playing: true,
  };
});
afterEach(() => vi.useRealTimers());

describe('a player that does not hold the party', () => {
  it('tells the group not to wait for it at once, after a seek and on a rejoin, and never buffers', () => {
    const player = controller();
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => false
    );
    expect(waits()).toEqual([true]);
    follower.onCommand({
      command: 'Seek',
      positionMs: 60_000,
      when: 0,
      playlistItemId: ITEM,
    } as never);
    expect(waits()).toEqual([true, true]);
    // A (re)join: the group forgot.
    follower.syncWaiting(true);
    expect(waits()).toEqual([true, true, true]);
    // It stalls well past when a holding player would ask the group to wait.
    const previous = { ...player.state };
    player.state = { ...player.state, waiting: true };
    follower.onState(player.state, previous);
    vi.advanceTimersByTime(10_000);
    follower.tick();
    expect(buffers()).toHaveLength(0);
    // Nor does it ask to be waited for again after the seek settles.
    player.state = { ...player.state, waiting: false };
    vi.advanceTimersByTime(1_000);
    follower.tick();
    expect(waits().filter((w) => w === false)).toHaveLength(0);
  });
  it('asks to be waited for again, once, when it starts holding the party', () => {
    let holds = false;
    const player = controller();
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => holds
    );
    holds = true;
    follower.tick();
    follower.tick();
    expect(waits()).toEqual([true, false]);
  });
});

describe('a player that holds the party (as before)', () => {
  it('says nothing about waiting when made, and buffers when it stalls', () => {
    const player = controller();
    const follower = new Follower(() => player, undefined, ITEM);
    expect(waits()).toEqual([]);
    follower.syncWaiting(true);
    expect(waits()).toEqual([]);
    const previous = { ...player.state };
    player.state = { ...player.state, waiting: true };
    follower.onState(player.state, previous);
    vi.advanceTimersByTime(4_000);
    expect(buffers()).toHaveLength(1);
  });
});

describe('a guest before its player starts', () => {
  async function fresh() {
    vi.resetModules();
    return import('./playback');
  }
  it('tells the group not to wait for it; a player that holds turns waiting back on once', async () => {
    const { waitForNoPlayer, Follower } = await fresh();
    waitForNoPlayer();
    expect(waits()).toEqual([true]);
    const player = controller();
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => true
    );
    await vi.advanceTimersByTimeAsync(400);
    follower.tick();
    follower.syncWaiting();
    expect(waits()).toEqual([true, false]);
    // Its player follows the party now: a rejoin leaves telling the group to it.
    waitForNoPlayer();
    expect(waits()).toEqual([true, false]);
    follower.stop();
  });
  it('a player that does not hold never turns waiting back on', async () => {
    const { waitForNoPlayer, Follower } = await fresh();
    waitForNoPlayer();
    const player = controller();
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => false
    );
    follower.syncWaiting();
    expect(waits()).not.toContain(false);
    follower.stop();
    // Its player gone, the page tells the group again on a rejoin.
    waitForNoPlayer();
    expect(waits().at(-1)).toBe(true);
  });
  it('a signed-in member, whose page never told the group, sends nothing more when its player starts', async () => {
    const { Follower } = await fresh();
    const player = controller();
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => true
    );
    follower.syncWaiting();
    expect(waits()).toEqual([]);
    follower.stop();
  });
});

describe('a player loading while the party plays', () => {
  const loading = { loaded: false, paused: true, waiting: true } as PlayerState;
  const loaded = { loaded: true, paused: true, waiting: false } as PlayerState;
  it('plays, when it does not hold the party: the group sends it no resume', () => {
    const player = controller();
    player.state = loaded;
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => false
    );
    fixture.timeline = { ...fixture.timeline!, positionMs: 30_000 };
    fixture.requests = [];
    follower.onState(loaded, loading);
    expect(player.setPaused).toHaveBeenCalledWith(false);
    expect(player.seek).toHaveBeenCalled();
    // Its own resume: nothing asks the group to pause or play.
    expect(
      fixture.requests.filter((r) => r.type === 'Pause' || r.type === 'Unpause')
    ).toEqual([]);
    follower.stop();
  });
  it('waits for the group, when it holds the party (as before)', async () => {
    // A signed-in member: nothing on this device told the group not to wait.
    vi.resetModules();
    const { Follower: Fresh } = await import('./playback');
    const player = controller();
    player.state = loaded;
    const follower = new Fresh(
      () => player,
      undefined,
      ITEM,
      () => true
    );
    follower.onState(loaded, loading);
    expect(player.setPaused).not.toHaveBeenCalledWith(false);
    follower.stop();
  });
  it('stays paused while the party is paused', () => {
    fixture.timeline = { ...fixture.timeline!, playing: false };
    const player = controller();
    player.state = loaded;
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => false
    );
    follower.onState(loaded, loading);
    expect(player.setPaused).not.toHaveBeenCalledWith(false);
    follower.stop();
  });
});

describe('a player that holds, taking over where the group was told not to wait', () => {
  it('turns waiting back on exactly once, with its Ready', async () => {
    vi.resetModules();
    const { Follower, waitForNoPlayer } = await import('./playback');
    waitForNoPlayer();
    const player = controller();
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => true
    );
    await vi.advanceTimersByTimeAsync(400);
    follower.tick();
    follower.tick();
    follower.syncWaiting();
    expect(waits()).toEqual([true, false]);
    expect(fixture.requests.filter((r) => r.type === 'Ready')).toHaveLength(1);
    follower.stop();
  });
  it('plays as it loads while the party plays: the group, not waiting for it, sends no resume', async () => {
    vi.resetModules();
    const { Follower, waitForNoPlayer } = await import('./playback');
    waitForNoPlayer();
    const loading = {
      loaded: false,
      paused: true,
      waiting: true,
    } as PlayerState;
    const loaded = {
      loaded: true,
      paused: true,
      waiting: false,
    } as PlayerState;
    const player = controller();
    player.state = loaded;
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => true
    );
    follower.onState(loaded, loading);
    expect(player.setPaused).toHaveBeenCalledWith(false);
    follower.stop();
  });
});

describe('a signed-in member (as upstream)', () => {
  it('sends IgnoreWait:false and Ready once as its player starts, and nothing more', async () => {
    vi.resetModules();
    const { Follower } = await import('./playback');
    const player = controller();
    const follower = new Follower(
      () => player,
      undefined,
      ITEM,
      () => true
    );
    await vi.advanceTimersByTimeAsync(400);
    follower.tick();
    follower.tick();
    expect(waits()).toEqual([false]);
    expect(fixture.requests.filter((r) => r.type === 'Ready')).toHaveLength(1);
    follower.stop();
  });
});
