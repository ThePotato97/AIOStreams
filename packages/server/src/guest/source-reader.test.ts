import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Core's real disk cache, with a quiet logger in place of core's (which loads all of core).
const quiet = vi.hoisted(() => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));
vi.mock('../../../core/src/logging/logger.js', () => quiet);
vi.mock('@aiostreams/core', async () => ({
  DiskBackedCache: (
    await import('../../../core/src/utils/disk-backed-cache.js')
  ).DiskBackedCache,
  createLogger: quiet.createLogger,
}));
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { request } from 'undici';
import {
  BLOCK,
  BlockStore,
  SourceReader,
  type SourceOpener,
} from './source-reader.js';

/** A file of distinct bytes: byte i is (i * 7 + (i >> 16)) & 255. */
const SIZE = 40 * BLOCK + 12345;
const file = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) file[i] = (i * 7 + (i >> 16)) & 255;

let server: Server;
let base = '';
let dir = '';
/** Every upstream request: its start, and the bytes sent. */
const requests: { start: number; sent: number }[] = [];
let etag = '"v1"';
let ranges = true;
/** What the server serves: the file above unless a test sets another. */
let served = file;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guest-source-'));
  server = createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = ranges && m ? Number(m[1]) : 0;
    const entry = { start, sent: 0 };
    requests.push(entry);
    const size = served.length;
    res.writeHead(ranges && m ? 206 : 200, {
      'content-length': String(size - start),
      ...(ranges && m
        ? { 'content-range': `bytes ${start}-${size - 1}/${size}` }
        : {}),
      etag,
    });
    // Sent in small pieces, as a network would, and stopped when the reader hangs up.
    let at = start;
    const pump = () => {
      while (at < size) {
        const end = Math.min(at + 64 * 1024, size);
        entry.sent += end - at;
        const ok = res.write(served.subarray(at, end));
        at = end;
        if (!ok) return void res.once('drain', pump);
      }
      res.end();
    };
    res.on('close', () => (at = size));
    pump();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/f`;
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function opener(): SourceOpener {
  return {
    resolving: () => false,
    async open(start, signal) {
      const res = await request(base, {
        headers: { range: `bytes=${start}-` },
        signal,
      });
      const total = /\/(\d+)$/.exec(String(res.headers['content-range'] ?? ''));
      return {
        body: res.body as unknown as Readable,
        size: total
          ? Number(total[1])
          : Number(res.headers['content-length'] ?? NaN) || null,
        ranged: res.statusCode === 206,
        etag: (res.headers.etag as string) ?? null,
        lastModified: null,
      };
    },
  };
}

async function readAll(
  reader: SourceReader,
  start: number,
  end: number
): Promise<Buffer> {
  const { stream } = await reader.open(
    { start, endExclusive: end },
    new AbortController().signal
  );
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

const fresh = () => {
  requests.length = 0;
  etag = '"v1"';
  ranges = true;
  served = file;
};

/** An EBML element: its id's bytes, an 8-byte size, the payload. */
const el = (id: number[], ...payload: Buffer[]) => {
  const body = Buffer.concat(payload);
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length));
  size[0] = 0x01;
  return Buffer.concat([Buffer.from(id), size, body]);
};
const CUES = [0x1c, 0x53, 0xbb, 0x6b];
/**
 * A Matroska file as muxers write one: the EBML header, then a Segment of unknown size whose
 * SeekHead lists `listed` at its position; padding; then the Cues, 6 MB in.
 */
function matroska(listed: number[] = CUES) {
  const header = el(
    [0x1a, 0x45, 0xdf, 0xa3],
    el([0x42, 0x82], Buffer.from('matroska'))
  );
  const segmentHeader = Buffer.from([
    0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  const seekHead = (position: number) => {
    const at = Buffer.alloc(4);
    at.writeUInt32BE(position);
    return el(
      [0x11, 0x4d, 0x9b, 0x74],
      el(
        [0x4d, 0xbb],
        el([0x53, 0xab], Buffer.from(listed)),
        el([0x53, 0xac], at)
      )
    );
  };
  // Positions count from the Segment's data; the SeekHead's size doesn't depend on them.
  const cuesAt = 6 * BLOCK;
  const head = seekHead(0).length;
  const padding = el([0xec], Buffer.alloc(cuesAt - head - 9));
  const cues = el(CUES, Buffer.alloc(5000, 7));
  const data = Buffer.concat([
    header,
    segmentHeader,
    seekHead(cuesAt),
    padding,
    cues,
    el([0xec], Buffer.alloc(1000)),
  ]);
  const start = header.length + segmentHeader.length + cuesAt;
  return { data, cues: { start, end: start + cues.length } };
}

describe('SourceReader', () => {
  it('serves concurrent reads of one region from one upstream read', async () => {
    fresh();
    const store = new BlockStore(64 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 2,
      stores: true,
    });
    const [a, b] = await Promise.all([
      readAll(reader, 0, 5 * BLOCK),
      readAll(reader, 1000, 4 * BLOCK),
    ]);
    expect(a.equals(file.subarray(0, 5 * BLOCK))).toBe(true);
    expect(b.equals(file.subarray(1000, 4 * BLOCK))).toBe(true);
    expect(requests.map((r) => r.start)).toEqual([0]);
    // Read again later: from the stored blocks, nothing upstream.
    const again = await readAll(reader, 2 * BLOCK, 3 * BLOCK + 17);
    expect(again.equals(file.subarray(2 * BLOCK, 3 * BLOCK + 17))).toBe(true);
    expect(requests).toHaveLength(1);
    reader.close();
  });

  it('starts a new cursor only for a read no cursor reaches', async () => {
    fresh();
    const store = new BlockStore(64 * BLOCK, dir);
    // Reading 4 MB ahead, so the end of this 40 MB file is out of the first cursor's reach.
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 2,
      stores: true,
      readAhead: 4 * BLOCK,
    });
    await readAll(reader, 0, BLOCK);
    // The end of the file (where Matroska keeps its Cues): a second cursor.
    const tail = await readAll(reader, SIZE - 5000, SIZE);
    expect(tail.equals(file.subarray(SIZE - 5000))).toBe(true);
    expect(requests.map((r) => r.start)).toEqual([
      0,
      Math.floor((SIZE - 5000) / BLOCK) * BLOCK,
    ]);
    reader.close();
  });

  it('evicts the blocks furthest from anyone reading first', async () => {
    fresh();
    const store = new BlockStore(6 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 2,
      stores: true,
    });
    await readAll(reader, 0, 3 * BLOCK);
    // A reader stays at block 20 while blocks 20..25 are read in.
    const { stream } = await reader.open(
      { start: 20 * BLOCK, endExclusive: 26 * BLOCK },
      new AbortController().signal
    );
    for await (const _ of stream) void _;
    expect(store.size).toBeLessThanOrEqual(6 * BLOCK);
    // Blocks 0..2 were furthest from the reader at 20+: they went first.
    expect(store.has(reader, 0)).toBe(false);
    expect(store.has(reader, 25)).toBe(true);
    reader.close();
  });

  it('serves a block asked for with no read open (a probe, a retry)', async () => {
    fresh();
    const store = new BlockStore(64 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 2,
      stores: true,
    });
    const block = await Promise.race([
      reader.fetch(5),
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    expect(block?.equals(file.subarray(5 * BLOCK, 6 * BLOCK))).toBe(true);
    reader.close();
  });

  it('a cursor stops where another already read: no block is read twice', async () => {
    fresh();
    const store = new BlockStore(64 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 2,
      stores: true,
      readAhead: 4 * BLOCK,
    });
    // Every block the store is handed that it already holds.
    const twice: number[] = [];
    const put = store.put.bind(store);
    store.put = (r, block, data) => {
      if (store.has(r, block)) twice.push(block);
      put(r, block, data);
    };
    // A seek first: blocks 10 onwards are read in.
    await readAll(reader, 10 * BLOCK, 12 * BLOCK);
    expect(store.has(reader, 10)).toBe(true);
    // Then a read from the start, through the region already stored.
    const all = await readAll(reader, 0, 14 * BLOCK);
    expect(all.equals(file.subarray(0, 14 * BLOCK))).toBe(true);
    // The first read at 0 (learning the file), then the seek's; the first only follows reads it
    // serves, and stops at block 10 (give or take what was in flight), not read on through it.
    expect(requests.map((r) => r.start)).toEqual([0, 10 * BLOCK]);
    expect(twice).toEqual([]);
    // Without stopping it would read the 30 blocks left; it sent up to block 10 and what the
    // socket had taken by then.
    expect(requests[0].sent).toBeLessThan(15 * BLOCK);
    reader.close();
  });

  it('without stored blocks, the cursor takes turns rather than moving every block', async () => {
    fresh();
    const store = new BlockStore(64 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 1,
      stores: false,
    });
    const [a, b, c] = await Promise.all([
      readAll(reader, 0, 4 * BLOCK),
      readAll(reader, 20 * BLOCK, 24 * BLOCK),
      readAll(reader, 35 * BLOCK, 39 * BLOCK),
    ]);
    expect(a.equals(file.subarray(0, 4 * BLOCK))).toBe(true);
    expect(b.equals(file.subarray(20 * BLOCK, 24 * BLOCK))).toBe(true);
    expect(c.equals(file.subarray(35 * BLOCK, 39 * BLOCK))).toBe(true);
    // One open per read (each finishes within its turn), not one per block handed over.
    expect(requests.map((r) => r.start / BLOCK).sort((x, y) => x - y)).toEqual([
      0, 20, 35,
    ]);
    reader.close();
  });

  it('says the file size once the source has answered', async () => {
    fresh();
    const store = new BlockStore(64 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 2,
      stores: true,
    });
    expect(reader.size()).toBe(null);
    await reader.describe();
    expect(reader.size()).toBe(SIZE);
    reader.close();
  });

  it('finds where a Matroska file keeps its Cues, through its SeekHead', async () => {
    fresh();
    const mkv = matroska();
    served = mkv.data;
    const store = new BlockStore(64 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 2,
      stores: true,
    });
    expect(await reader.cues(new AbortController().signal)).toEqual(mkv.cues);
    // Read through the reader: the first read reaches the Cues 6 MB in (well within read-ahead).
    expect(requests.map((r) => r.start)).toEqual([0]);
    reader.close();
  });

  it('has no Cues for a file that is not Matroska, or whose SeekHead does not list them', async () => {
    fresh();
    const store = new BlockStore(64 * BLOCK, dir);
    const plain = new SourceReader('f.bin', opener(), store, {
      maxCursors: 2,
      stores: true,
    });
    expect(await plain.cues(new AbortController().signal)).toBe(null);
    plain.close();
    // The SeekHead lists the Tags (0x1254C367), not the Cues.
    served = matroska([0x12, 0x54, 0xc3, 0x67]).data;
    const unlisted = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 2,
      stores: true,
    });
    expect(await unlisted.cues(new AbortController().signal)).toBe(null);
    unlisted.close();
  });

  it("doesn't share a source that ignores ranges", async () => {
    fresh();
    ranges = false;
    const store = new BlockStore(64 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 2,
      stores: true,
    });
    await reader.describe();
    expect(reader.shareable()).toBe(false);
    reader.close();
  });

  it('drops what it kept when the file behind the source changes', async () => {
    fresh();
    const store = new BlockStore(64 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 1,
      stores: true,
      readAhead: 4 * BLOCK,
    });
    await readAll(reader, 0, 2 * BLOCK);
    expect(store.has(reader, 0)).toBe(true);
    etag = '"v2"';
    // A read the cursor doesn't reach: a new cursor, which learns the new ETag.
    await readAll(reader, 30 * BLOCK, 31 * BLOCK);
    expect(store.has(reader, 0)).toBe(false);
    reader.close();
  });

  it('without stored blocks, one cursor serves readers at the start, end and middle at once', async () => {
    fresh();
    const store = new BlockStore(64 * BLOCK, dir);
    const reader = new SourceReader('f.mkv', opener(), store, {
      maxCursors: 1,
      stores: false,
    });
    // As FFmpeg does: the header, the Cues at the end, a seek into the middle, all at once.
    const [head, tail, middle] = await Promise.all([
      readAll(reader, 0, 2 * BLOCK + 10),
      readAll(reader, SIZE - 3000, SIZE),
      readAll(reader, 17 * BLOCK + 5, 19 * BLOCK),
    ]);
    expect(head.equals(file.subarray(0, 2 * BLOCK + 10))).toBe(true);
    expect(tail.equals(file.subarray(SIZE - 3000))).toBe(true);
    expect(middle.equals(file.subarray(17 * BLOCK + 5, 19 * BLOCK))).toBe(true);
    // Nothing kept.
    expect(store.size).toBe(0);
    reader.close();
  });
});
