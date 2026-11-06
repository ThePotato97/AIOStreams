import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const fixture = vi.hoisted(() => ({
  enabled: true,
  playing: { ref: 'encrypted-title', playlistItemId: 'b'.repeat(32) },
  party: 'a'.repeat(22),
  members: [{ id: 'host', key: 'h'.repeat(22) }],
  prepares: [] as { resolve(): void }[],
  slow: false,
}));
vi.mock('@aiostreams/core', () => ({
  config: {
    party: {
      get guestStreaming() {
        return fixture.enabled;
      },
      transcoderUrl: 'http://worker',
      transcoderSecret: 's'.repeat(32),
      internalUrl: 'http://internal',
    },
    bootstrap: { baseUrl: 'http://internal' },
  },
}));
vi.mock('../routes/jellyfin/context.js', () => ({
  userForToken: async (token: string) =>
    token === 'host-token'
      ? { uuid: 'owner', payload: { p: 'password' }, persona: null }
      : null,
  contextFromCredentials: async () => ({
    uuid: 'owner',
    scope: () => 'owner-scope',
  }),
}));
vi.mock('../party/relay.js', () => ({
  guestPartyState: async (id: string) =>
    id === fixture.party
      ? {
          id,
          host: 'host',
          homeUuid: 'owner',
          expiresAt: Date.now() + 60000,
          joinsClosed: false,
          playing: fixture.playing,
          queue: [fixture.playing],
          members: fixture.members,
        }
      : null,
}));
vi.mock('../party/ticket.js', () => ({
  ticketExpiry: () => Date.now() + 60000,
}));
vi.mock('../routes/jellyfin/playback.js', () => ({
  locate: async () => ({}),
  ensureMemo: async () => ({
    sources: [
      {
        msid: 'source',
        url: 'https://provider.invalid/private-token',
        filename: 'episode.mkv',
        container: 'mkv',
        subtitles: [],
        extension: { bingeGroup: 'series' },
      },
    ],
  }),
}));
import guestRouter from './routes.js';
import { guestSessions } from './sessions.js';
const originalFetch = globalThis.fetch;
let server: Server, base: string;
const media = {
  durationMs: 12000,
  container: 'matroska',
  bitrate: 1000000,
  tracks: [{ index: 0, type: 'video', codec: 'h264', title: 'Video' }],
  chapters: [{ title: 'Opening', startMs: 0 }],
};
const proof = () => ({
  party: fixture.party,
  member: 'host',
  seat: 'h'.repeat(22),
  ticket: 'ticket',
});
async function api(path: string, token = '', body?: unknown) {
  return originalFetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function invitation() {
  const result = await api('/host', 'host-token', proof());
  expect(result.status).toBe(200);
  await api('/publish', 'host-token', {
    ...proof(),
    entries: [
      {
        ref: fixture.playing.ref,
        itemId: 'c'.repeat(32),
        title: 'Episode',
        sourceId: 'source',
      },
    ],
  });
  return ((await result.json()) as { secret: string }).secret as string;
}
async function guest(secret: string) {
  const result = await api('/exchange', '', { party: fixture.party, secret });
  expect(result.status).toBe(200);
  return ((await result.json()) as { token: string }).token as string;
}
function join(token: string) {
  const session = guestSessions.get(token)!;
  session.member = 'guest';
  fixture.members.push({ id: 'guest', key: 'g'.repeat(22) });
}
beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('http://worker')) return originalFetch(input, init);
    if (url.endsWith('/probe')) return Response.json(media);
    if (url.endsWith('/prepare')) {
      if (fixture.slow)
        await new Promise<void>((resolve) =>
          fixture.prepares.push({ resolve })
        );
      return Response.json({ mode: 'direct', meta: media });
    }
    return Response.json({ ok: true });
  });
  const app = express();
  app.use(express.json());
  app.use('/party/guest', guestRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.on('listening', resolve);
    server.on('error', reject);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/party/guest`;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  fixture.party = crypto.randomUUID().replaceAll('-', '').slice(0, 22);
  fixture.enabled = true;
  fixture.members = [{ id: 'host', key: 'h'.repeat(22) }];
  fixture.playing = { ref: 'encrypted-title', playlistItemId: 'b'.repeat(32) };
  fixture.slow = false;
  fixture.prepares = [];
});
describe('guest playback authorization', () => {
  it('requires host credentials and rejects malformed invitations', async () => {
    expect((await api('/host', '', proof())).status).toBe(403);
    const secret = await invitation();
    expect(
      (
        await api('/exchange', '', {
          party: fixture.party,
          secret: 'x'.repeat(43),
        })
      ).status
    ).toBe(410);
    const token = await guest(secret);
    expect((await api('/current', token)).status).toBe(403);
    join(token);
    const response = await api('/current', token);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('private-token');
    expect(text).not.toContain('password');
    expect(text).toContain('Opening');
  });
  it('scopes playback to membership and revokes invites and sessions', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    const current = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    const response = await api('/prepare', token, {
      revision: current.revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: true, container: true, hdr: false },
    });
    expect(response.status).toBe(200);
    const playback = (await response.json()) as { url: string };
    expect(playback.url).toContain('/media/original');
    expect(playback.url).not.toContain('provider');
    guestSessions.revokeMember(fixture.party, 'guest');
    expect((await api('/current', token)).status).toBe(401);
    await api('/disable', 'host-token', proof());
    expect(
      (await api('/exchange', '', { party: fixture.party, secret })).status
    ).toBe(410);
  });
  it('rejects media URLs from a previous playback lease', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    const current = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    const body = {
      revision: current.revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: true, container: true, hdr: false },
    };
    const old = (await (await api('/prepare', token, body)).json()) as {
      url: string;
    };
    const replacement = await api('/prepare', token, {
      ...body,
      positionMs: 4000,
    });
    expect(replacement.status).toBe(200);
    const response = await originalFetch(new URL(old.url, base));
    expect(response.status).toBe(410);
  });
  it('rejects an old revision and disabled streaming', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    const current = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    fixture.playing = { ...fixture.playing, playlistItemId: 'd'.repeat(32) };
    expect(
      (
        await api('/prepare', token, {
          revision: current.revision,
          quality: 'original',
          positionMs: 0,
          capabilities: {
            video: true,
            audio: true,
            container: true,
            hdr: false,
          },
        })
      ).status
    ).toBe(409);
    fixture.enabled = false;
    expect((await api('/current', token)).status).toBe(410);
  });
  it('does not let an older preparation replace a newer seek', async () => {
    const secret = await invitation(),
      token = await guest(secret);
    join(token);
    const current = (await (await api('/current', token)).json()) as {
      revision: string;
    };
    const body = {
      revision: current.revision,
      quality: 'original',
      positionMs: 0,
      capabilities: { video: true, audio: true, container: true, hdr: false },
    };
    fixture.slow = true;
    const first = api('/prepare', token, body);
    await vi.waitFor(() => expect(fixture.prepares.length).toBe(1));
    const second = api('/prepare', token, { ...body, positionMs: 4000 });
    await vi.waitFor(() => expect(fixture.prepares.length).toBe(2));
    fixture.prepares[1].resolve();
    expect((await second).status).toBe(200);
    fixture.prepares[0].resolve();
    expect((await first).status).toBe(409);
  });
});
