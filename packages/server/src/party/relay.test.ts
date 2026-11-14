import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { PartyServerMessage } from '@aiostreams/core';

const fixture = vi.hoisted(() => ({
  guestStreaming: true,
}));
const quiet = vi.hoisted(
  () => () =>
    Object.fromEntries(
      ['warn', 'error', 'info', 'debug'].map((l) => [l, () => {}])
    )
);
// Core's logger loads all of core; the store and the relay only need it quiet.
vi.mock('../../../core/src/logging/logger.js', () => ({ createLogger: quiet }));
// Core as the relay uses it: the in-memory shared store (a server without Redis), the real
// sync group and protocol, and a config with an open ('public') relay that trusts loopback
// proxies, so each test client can be given its own address by X-Forwarded-For.
vi.mock('@aiostreams/core', async () => {
  const { MemoryBackend } =
    await import('../../../core/src/sync/store/memory.js');
  const { SharedTx, andThen } =
    await import('../../../core/src/sync/store/types.js');
  const { SyncGroup } = await import('../../../core/src/sync/group.js');
  const { PARTY_LIMITS, PARTY_PROTOCOL } =
    await import('../../../core/src/sync/protocol.js');
  const backend = new MemoryBackend();
  return {
    createLogger: quiet,
    sharedBackend: () => backend,
    SharedTx,
    andThen,
    SyncGroup,
    PARTY_LIMITS,
    PARTY_PROTOCOL,
    config: {
      party: {
        relay: 'public',
        maxParties: 1000,
        scope: 'user',
        get guestStreaming() {
          return fixture.guestStreaming;
        },
      },
      api: { authRequired: false, trustedIps: ['loopback'] },
      bootstrap: { secretKey: 'k'.repeat(64) },
    },
  };
});
// Nobody signs in with a server token here; the relay is public.
vi.mock('../routes/jellyfin/context.js', () => ({
  userForToken: async () => null,
}));
vi.mock('../routes/jellyfin/users.js', () => ({
  accountName: () => 'account',
}));

import { PARTY_LIMITS, PARTY_PROTOCOL } from '@aiostreams/core';
import { attachPartyRelay, guestPartyState } from './relay.js';
import { guestSessions } from '../guest/sessions.js';
import { ticketFor } from './ticket.js';

let server: Server;
let url: string;
const open: WebSocket[] = [];

beforeAll(async () => {
  server = createServer();
  attachPartyRelay(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/party/v1`;
});

afterAll(async () => {
  for (const ws of open) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fixture.guestStreaming = true;
});

/** A party id or seat key: 16 random bytes in base64url. */
const newKey = () => randomBytes(16).toString('base64url');
/** A sealed name, as members send them. */
const NAME = 'bmFtZQ';
const resumeState = {
  items: [{ ref: 'cmVm', runtimeMs: 60_000 }],
  index: 0,
  positionMs: 0,
  playing: false,
};

let nextAddress = 1;
/** An address no other test client uses, so per-address rate limits never meet. */
const freshAddress = () => `10.9.${nextAddress >> 8}.${nextAddress++ & 255}`;

interface Client {
  ws: WebSocket;
  send(message: Record<string, unknown>): void;
  /** The first message (seen or yet to come) matching `match`, which is then used up. */
  next(
    match: (m: PartyServerMessage) => boolean,
    what?: string
  ): Promise<PartyServerMessage>;
  /** Resolves with the close code once the relay closes the connection. */
  closed: Promise<number>;
}

/** A WebSocket client to the relay, from `address` as forwarded by a trusted proxy. */
async function connect(address = freshAddress()): Promise<Client> {
  const ws = new WebSocket(url, { headers: { 'x-forwarded-for': address } });
  open.push(ws);
  const seen: PartyServerMessage[] = [];
  const waiting: {
    match: (m: PartyServerMessage) => boolean;
    resolve: (m: PartyServerMessage) => void;
  }[] = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString()) as PartyServerMessage;
    const i = waiting.findIndex((w) => w.match(m));
    if (i >= 0) waiting.splice(i, 1)[0].resolve(m);
    else seen.push(m);
  });
  const closed = new Promise<number>((resolve) =>
    ws.on('close', (code) => resolve(code))
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    send: (message) => ws.send(JSON.stringify(message)),
    next: (match, what = 'message') => {
      const i = seen.findIndex(match);
      if (i >= 0) return Promise.resolve(seen.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          4000
        );
        waiting.push({
          match,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    closed,
  };
}

type Of<T extends PartyServerMessage['t']> = Extract<
  PartyServerMessage,
  { t: T }
>;
const welcomeOrError = (client: Client) =>
  client.next((m) => m.t === 'welcome' || m.t === 'error', 'welcome or error');
const welcome = async (client: Client) => {
  const m = await welcomeOrError(client);
  expect(m).toMatchObject({ t: 'welcome' });
  return m as Of<'welcome'>;
};
const errorCode = async (client: Client) => {
  const m = await welcomeOrError(client);
  expect(m.t).toBe('error');
  return (m as Of<'error'>).code;
};

/** Starts a party; the host's client and its welcome. */
async function startParty(address?: string) {
  const host = await connect(address);
  const party = newKey();
  host.send({ t: 'create', v: PARTY_PROTOCOL, party, name: NAME });
  const hello = await welcome(host);
  return { host, party, hello };
}

const join = (client: Client, party: string, extra = {}) =>
  client.send({ t: 'join', v: PARTY_PROTOCOL, party, name: NAME, ...extra });

const resume = (client: Client, party: string, ticket: string) =>
  client.send({
    t: 'resume',
    v: PARTY_PROTOCOL,
    party,
    name: NAME,
    ticket,
    state: resumeState,
  });

/** Locks joins as the host, and waits until the relay says it did. */
async function lockJoins(host: Client, joins: boolean) {
  host.send({ t: 'lock', joins });
  await host.next(
    (m) => m.t === 'lock' && m.lock.joins === joins,
    'lock change'
  );
}

/** Waits until the store shows the guest session holds no seat. */
async function seatReleased(token: string) {
  for (let i = 0; i < 200; i++) {
    if ((await guestSessions.load(token))?.member === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('guest seat was never released');
}

describe('kick', () => {
  it('removes the member and closes their connection, without banning their address', async () => {
    const { host, party } = await startParty(freshAddress());
    // The member's address differs from the host's, so upstream's exemption for the host's own
    // address would not apply: upstream refuses the rejoin below with 'denied'.
    const address = freshAddress();
    const member = await connect(address);
    join(member, party);
    const { you } = await welcome(member);
    await host.next(
      (m) => m.t === 'members' && m.joined === you,
      'member joined'
    );

    host.send({ t: 'kick', member: you });

    // The kicked member is told it was removed, and its connection is closed.
    expect(await member.next((m) => m.t === 'closed', 'closed')).toMatchObject({
      t: 'closed',
      reason: 'removed',
    });
    expect(await member.closed).toBe(1000);
    // The rest of the party sees it leave.
    await host.next((m) => m.t === 'members' && m.left === you, 'member left');
    const after = await guestPartyState(party);
    expect(after?.members.map((s) => s.id)).not.toContain(you);

    // A new join from the same address is accepted.
    const again = await connect(address);
    join(again, party);
    const rejoined = await welcome(again);
    expect(rejoined.you).not.toBe(you);
    expect(rejoined.members.map((s) => s.id)).toEqual(
      expect.arrayContaining([rejoined.you])
    );
    expect((await guestPartyState(party))?.members).toHaveLength(2);
  });

  it('is only the host’s to do', async () => {
    const { host, party, hello } = await startParty();
    const member = await connect();
    join(member, party);
    await welcome(member);
    member.send({ t: 'kick', member: hello.you });
    // A message sent after the kick is answered, so the kick was handled first.
    member.send({ t: 'ping', t0: 1 });
    await member.next((m) => m.t === 'pong', 'pong');
    expect((await guestPartyState(party))?.members.map((s) => s.id)).toContain(
      hello.you
    );
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('locked joins', () => {
  it('admits a member resuming with the party’s ticket, refusing a newcomer and a bad ticket', async () => {
    const { host, party, hello } = await startParty();
    await lockJoins(host, true);

    // A newcomer is refused.
    const newcomer = await connect();
    join(newcomer, party);
    expect(await errorCode(newcomer)).toBe('locked');
    expect(await newcomer.closed).toBe(4000);

    // A resume with a forged ticket is refused.
    const forged = await connect();
    resume(forged, party, `${hello.ticket.split('.')[0]}.${'A'.repeat(22)}`);
    expect(await errorCode(forged)).toBe('locked');

    // A resume with a real ticket for another party is refused.
    const otherParty = await connect();
    resume(otherParty, party, ticketFor(newKey(), Date.now() + 60 * 60_000));
    expect(await errorCode(otherParty)).toBe('locked');

    // A member resuming with the ticket its welcome gave it is admitted.
    const member = await connect();
    resume(member, party, hello.ticket);
    const back = await welcome(member);
    expect(back.party).toBe(party);
    expect(back.lock.joins).toBe(true);
    expect((await guestPartyState(party))?.members).toHaveLength(2);
  });

  it('admits newcomers again once joins are unlocked', async () => {
    const { host, party } = await startParty();
    await lockJoins(host, true);
    const refused = await connect();
    join(refused, party);
    expect(await errorCode(refused)).toBe('locked');
    await lockJoins(host, false);
    const admitted = await connect();
    join(admitted, party);
    await welcome(admitted);
  });
});

describe('guest seats', () => {
  const guestFor = async (party: string) =>
    (await guestSessions.create(party, Date.now() + 60 * 60_000)).token;

  it('claims the seat on join, and refuses a second join with the same token', async () => {
    const { party } = await startParty();
    const token = await guestFor(party);

    // Two joins with one token at once: one is seated, the other refused.
    const [a, b] = await Promise.all([connect(), connect()]);
    join(a, party, { token });
    join(b, party, { token });
    const results = await Promise.all([welcomeOrError(a), welcomeOrError(b)]);
    const seated = results.filter((m) => m.t === 'welcome') as Of<'welcome'>[];
    const refused = results.filter((m) => m.t === 'error') as Of<'error'>[];
    expect(seated).toHaveLength(1);
    expect(refused).toEqual([expect.objectContaining({ code: 'denied' })]);
    expect((await guestSessions.load(token))?.member).toBe(seated[0].you);

    // And later, once the first is in, too.
    const c = await connect();
    join(c, party, { token });
    expect(await errorCode(c)).toBe('denied');
    expect((await guestPartyState(party))?.members).toHaveLength(2);
  });

  it('gives the claim back when the party is full, so a later join succeeds', async () => {
    const { party } = await startParty();
    const others: Client[] = [];
    for (let i = 1; i < PARTY_LIMITS.members; i++) {
      const other = await connect();
      join(other, party);
      await welcome(other);
      others.push(other);
    }
    expect((await guestPartyState(party))?.members).toHaveLength(
      PARTY_LIMITS.members
    );

    const token = await guestFor(party);
    const turnedAway = await connect();
    join(turnedAway, party, { token });
    expect(await errorCode(turnedAway)).toBe('full');
    await seatReleased(token);

    // A member leaves, making room; the same token now joins.
    const leaving = others.pop()!;
    leaving.send({ t: 'leave' });
    await leaving.closed;
    const guest = await connect();
    join(guest, party, { token });
    const seated = await welcome(guest);
    expect((await guestSessions.load(token))?.member).toBe(seated.you);
  });

  it('holds no seat when a locked party turns the guest away, so it joins once unlocked', async () => {
    const { host, party } = await startParty();
    const token = await guestFor(party);
    await lockJoins(host, true);
    const turnedAway = await connect();
    join(turnedAway, party, { token });
    expect(await errorCode(turnedAway)).toBe('locked');
    expect((await guestSessions.load(token))?.member).toBeUndefined();

    await lockJoins(host, false);
    const guest = await connect();
    join(guest, party, { token });
    const seated = await welcome(guest);
    expect((await guestSessions.load(token))?.member).toBe(seated.you);
  });

  it('refuses a guest token for another party, and claims no seat', async () => {
    const { party } = await startParty();
    const { party: other } = await startParty();
    const token = await guestFor(other);
    const guest = await connect();
    join(guest, party, { token });
    expect(await errorCode(guest)).toBe('denied');
    expect((await guestSessions.load(token))?.member).toBeUndefined();
    expect((await guestPartyState(party))?.members).toHaveLength(1);
  });

  it('refuses guest tokens while guest streaming is off', async () => {
    const { party } = await startParty();
    const token = await guestFor(party);
    fixture.guestStreaming = false;
    const guest = await connect();
    join(guest, party, { token });
    expect(await errorCode(guest)).toBe('denied');
    expect((await guestSessions.load(token))?.member).toBeUndefined();
    expect((await guestPartyState(party))?.members).toHaveLength(1);
  });
});
