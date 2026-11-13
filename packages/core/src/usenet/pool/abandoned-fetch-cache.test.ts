import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
// Load the core entry point first; core modules import each other.
import '../../index.js';
import { MultiProviderPool } from './multi-provider-pool.js';
import { SegmentCache } from './segment-cache.js';
import { StatsAccumulator } from '../stats/accumulator.js';
import { CommandPriority, EngineOptions, NzbSegmentRef } from '../types.js';

const MESSAGE_ID = 'abandoned-1@test';

/**
 * A single-part yEnc article. The encoded payload is plain letters (no escapes,
 * no dot-stuffing), so each decoded byte is simply `encoded - 42`.
 */
function article(): { raw: string; decoded: Buffer } {
  const lines: string[] = [];
  for (let i = 0; i < 64; i++) {
    let line = '';
    for (let j = 0; j < 128; j++) {
      line += String.fromCharCode(65 + ((i * 128 + j) % 26));
    }
    lines.push(line);
  }
  const encoded = Buffer.from(lines.join(''), 'latin1');
  const decoded = Buffer.from(encoded.map((c) => (c - 42) & 0xff));
  const raw =
    `=ybegin line=128 size=${decoded.length} name=test.bin\r\n` +
    lines.join('\r\n') +
    `\r\n=yend size=${decoded.length}\r\n`;
  return { raw, decoded };
}

/**
 * Minimal NNTP server: greets, and answers BODY only when the test releases
 * it, so the test can abandon a fetch while it is on the wire.
 */
async function startServer(raw: string): Promise<{
  port: number;
  bodyCount: () => number;
  bodyRequested: () => Promise<void>;
  release: () => void;
  close: () => Promise<void>;
}> {
  let bodies = 0;
  let onBody: (() => void) | undefined;
  let released = false;
  const pending: (() => void)[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    sock.write('200 test server ready\r\n');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let nl: number;
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const m = /^BODY (<.*>)/i.exec(line);
        if (!m) {
          sock.write('500 unknown command\r\n');
          continue;
        }
        bodies++;
        const reply = (): void => {
          sock.write(`222 0 ${m[1]}\r\n${raw}.\r\n`);
        };
        if (released) reply();
        else pending.push(reply);
        onBody?.();
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    bodyCount: () => bodies,
    bodyRequested: () =>
      bodies > 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => (onBody = resolve)),
    release: () => {
      released = true;
      for (const r of pending.splice(0)) r();
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

function engineOptions(): EngineOptions {
  return {
    maxConcurrentDownloads: 4,
    prefetchSegments: 4,
    streamingPriority: 0.5,
    segmentDiskCacheBytes: 0,
    segmentTimeoutMs: 10_000,
    segmentStallTimeoutMs: 10_000,
    dialTimeoutMs: 5_000,
    idleConnectionMs: 60_000,
    streamIdleTimeoutMs: 60_000,
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 1_000,
    verifyMode: 'none',
    verifyBudgetMs: 0,
    censusShadowConcurrency: 1,
    censusMaxLifetimeMs: 60_000,
    lazyRarResolution: false,
    strictArchiveMembership: false,
    verifyArticleCrc: true,
  };
}

async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const segment = (raw: string): NzbSegmentRef => ({
  messageId: MESSAGE_ID,
  number: 1,
  bytes: raw.length,
});

/** Abandon a fetch after BODY was sent, let the article arrive, then re-read. */
async function abandonThenReread(
  cache: SegmentCache,
  fetchFirst: (
    pool: MultiProviderPool,
    seg: NzbSegmentRef,
    signal: AbortSignal
  ) => Promise<unknown>,
  fetchAgain: (pool: MultiProviderPool, seg: NzbSegmentRef) => Promise<Buffer>
): Promise<void> {
  const { raw, decoded } = article();
  const server = await startServer(raw);
  const pool = new MultiProviderPool(
    [
      {
        id: 'p1',
        host: '127.0.0.1',
        port: server.port,
        tls: false,
        maxConnections: 2,
        priority: 0,
      },
    ],
    engineOptions(),
    cache,
    new StatsAccumulator()
  );
  try {
    const seg = segment(raw);
    const ctl = new AbortController();
    const first = fetchFirst(pool, seg, ctl.signal);
    const firstSettled = first.then(
      () => assert.fail('abandoned fetch must reject'),
      (err: Error) => assert.match(err.message, /aborted/)
    );

    // Abandon while BODY is on the wire, then let the article arrive.
    await server.bodyRequested();
    ctl.abort();
    server.release();
    await firstSettled;
    await waitFor(() => pool.downloadsInUse === 0);

    const body = await fetchAgain(pool, seg);
    assert.equal(body.compare(decoded), 0, 'served bytes match the article');
    assert.equal(server.bodyCount(), 1, 'the article was fetched only once');
  } finally {
    pool.close();
    await cache.close();
    await server.close();
  }
}

test('abandoned shared fetch: arrived article is served from the arena', async () => {
  await abandonThenReread(
    new SegmentCache({ arenaBytes: 8 << 20 }),
    (pool, seg, signal) => pool.fetchSegmentShared(seg, 'nzb', signal),
    async (pool, seg) => (await pool.fetchSegment(seg, 'nzb', undefined)).body
  );
});

test('abandoned slot fetch: arrived article is served from the cache', async () => {
  let slot: Buffer | undefined;
  await abandonThenReread(
    new SegmentCache({ memBytes: 8 << 20 }),
    (pool, seg, signal) =>
      pool.fetchSegmentInto(
        seg,
        'nzb',
        signal,
        CommandPriority.High,
        () => (slot ??= Buffer.alloc(1 << 20))
      ),
    async (pool, seg) => {
      // The stream recycles its slot after abandoning; the cached body must
      // not alias it.
      slot?.fill(0);
      const data = await pool.fetchSegmentInto(
        seg,
        'nzb',
        undefined,
        CommandPriority.High,
        () => Buffer.alloc(1 << 20)
      );
      return Buffer.from(data.body);
    }
  );
});
