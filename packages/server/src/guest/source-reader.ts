/*
 * One reader per source, shared by everything that reads it: the transcoder's probes and
 * FFmpegs, subtitle extraction, guests playing the original file. The source is read from
 * upstream once, in blocks kept on disk, by a few sequential cursors; every range request is
 * served from those blocks. A read inside a range a cursor is already fetching waits for it;
 * anything else starts a new cursor there. When the cache is over its budget, the blocks
 * furthest from anyone reading go first.
 *
 * What a source is (how it resolves, its credentials, placeholders, re-resolving) is the
 * opener's business (routes.ts); this module only reads bytes.
 */
import { Readable } from 'node:stream';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DiskBackedCache, createLogger } from '@aiostreams/core';

const logger = createLogger('guest:source');

/**
 * Bytes of source blocks kept on disk, for every source together. The aiostreams pod's
 * /home/node/.cache volume is sized above it.
 */
export const SOURCE_CACHE_BYTES = 2 * 1024 ** 3;
/** Bytes per cached block. */
export const BLOCK = 1024 * 1024;
/** How far a cursor reads ahead of the furthest reader it serves. */
export const READ_AHEAD = 256 * BLOCK;
/** A cursor nobody reads from stops after this. */
export const CURSOR_IDLE_MS = 30_000;
/**
 * Without stored blocks (native usenet, whose engine caches the articles itself), how far ahead
 * of a cursor a read may wait for it: it reads past blocks nobody waits for, which are dropped.
 */
export const HAND_OFF_REACH = 8;
/**
 * Without stored blocks, how long a cursor keeps its place before a read elsewhere may take it,
 * unless the reads it serves go quiet first (`TURN_QUIET_MS`). Each move ends the engine's
 * stream and its fetches; one moved back within moments would ask for the same articles again,
 * while one back after a turn finds them in the engine's cache.
 */
export const TURN_MS = 1000;
export const TURN_QUIET_MS = 100;

/** One response from upstream, from `start` to the end of the file. */
export interface Upstream {
  body: Readable;
  /** The whole file's size, when upstream says it. */
  size: number | null;
  /** Upstream answered the range asked for (206), not the whole file. */
  ranged: boolean;
  etag: string | null;
  lastModified: Date | null;
  /** AIOStreams' own usenet stream, opened in-process: its engine keeps what it fetched. */
  native?: boolean;
}

export type SourceStatus =
  | { state: 'idle' | 'resolving' | 'ok' }
  | {
      state: 'failed';
      /** The source failed (not the transcoder): what `code` says, as the guest routes name it. */
      class: 'source';
      status: number;
      code?: string;
      message: string;
    };

export interface SourceOpener {
  /** Opens upstream at `start`, to the end; throws an error with `status` (and `code`). */
  open(start: number, signal: AbortSignal): Promise<Upstream>;
  /** Whether the next open has to resolve (not straight to a pinned file). */
  resolving(): boolean;
}

/** A range served to one reader. */
export interface ReadRange {
  stream: Readable;
  size: number;
  start: number;
  end: number;
  filename: string;
  etag: string;
  lastModified: Date;
}

/** Called with the bytes the cache dropped, so its owner keeps count. */
type Evict = (reader: SourceReader, block: number) => void;

/**
 * The blocks of every reader, under one budget. The disk cache below holds them; its own
 * limits are set above this budget, so it never decides what goes: this does, by distance
 * from anyone reading.
 */
export class BlockStore {
  private readonly cache: DiskBackedCache<Buffer>;
  private readonly blocks = new Map<SourceReader, Map<number, number>>();
  private bytes = 0;

  constructor(
    private readonly budget: number,
    dir = join(homedir(), '.cache', 'aiostreams')
  ) {
    // Blocks kept by an earlier process can't be found again (their keys carry its reader ids),
    // but would take disk under the cache's limit: they go before it opens.
    rmSync(join(dir, 'guest-source'), { recursive: true, force: true });
    rmSync(join(dir, 'guest-source.index.json'), { force: true });
    this.cache = new DiskBackedCache<Buffer>({
      name: 'guest-source',
      dir,
      maxMemBytes: Math.min(64 * BLOCK, budget),
      // Never reached: blocks are removed here first.
      maxDiskBytes: budget + 64 * BLOCK,
      serialize: (v) => v,
      deserialize: (b) => b,
      sizeOf: (v) => v.length,
    });
  }

  private key(reader: SourceReader, block: number) {
    return `${reader.id}:${block}`;
  }

  has(reader: SourceReader, block: number): boolean {
    return !!this.blocks.get(reader)?.has(block);
  }

  async get(reader: SourceReader, block: number): Promise<Buffer | undefined> {
    if (!this.has(reader, block)) return undefined;
    return this.cache.getAsync(this.key(reader, block));
  }

  put(reader: SourceReader, block: number, data: Buffer): void {
    let held = this.blocks.get(reader);
    if (!held) this.blocks.set(reader, (held = new Map()));
    if (held.has(block)) return;
    held.set(block, data.length);
    this.bytes += data.length;
    this.cache.set(this.key(reader, block), data);
    if (this.bytes > this.budget) this.evict();
  }

  /** Forgets a reader's blocks (a closed reader, or a file that changed). */
  drop(reader: SourceReader): void {
    const held = this.blocks.get(reader);
    if (!held) return;
    for (const [block, size] of held) {
      this.bytes -= size;
      void this.cache.delete(this.key(reader, block));
    }
    this.blocks.delete(reader);
  }

  /** Removes the blocks furthest from anyone reading until the budget fits. */
  private evict(): void {
    const candidates: { reader: SourceReader; block: number; far: number }[] =
      [];
    for (const [reader, held] of this.blocks) {
      const near = reader.activeBlocks();
      for (const block of held.keys()) {
        const far = near.length
          ? Math.min(...near.map((at) => Math.abs(block - at)))
          : Infinity;
        candidates.push({ reader, block, far });
      }
    }
    candidates.sort((a, b) => b.far - a.far);
    for (const { reader, block } of candidates) {
      if (this.bytes <= this.budget) break;
      const held = this.blocks.get(reader)!;
      this.bytes -= held.get(block)!;
      held.delete(block);
      void this.cache.delete(this.key(reader, block));
    }
  }

  get size(): number {
    return this.bytes;
  }
}

interface Waiter {
  block: number;
  resolve: (data: Buffer) => void;
  reject: (error: Error) => void;
}

/** One sequential upstream read, storing blocks as they arrive. */
class Cursor {
  /** The next block it will store. */
  next: number;
  readonly waiters: Waiter[] = [];
  private readonly controller = new AbortController();
  private body: Readable | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  stopped = false;
  private readonly openedAt = Date.now();
  /** When a read last asked it for a block. */
  usedAt = Date.now();

  constructor(
    private readonly reader: SourceReader,
    readonly start: number
  ) {
    this.next = start;
  }

  /**
   * When a read elsewhere may take this cursor's place (see `TURN_MS`). With stored blocks, at
   * once: nothing read is lost by moving.
   */
  movableAt(): number {
    if (this.reader.stores) return 0;
    return Math.min(this.openedAt + TURN_MS, this.usedAt + TURN_QUIET_MS);
  }

  /** Whether `block` comes from this cursor without starting another. */
  covers(block: number): boolean {
    const reach = this.reader.stores
      ? this.reader.readAhead / BLOCK
      : HAND_OFF_REACH;
    return !this.stopped && block >= this.next && block < this.next + reach;
  }

  async run(opener: SourceOpener): Promise<void> {
    try {
      const upstream = await opener.open(
        this.start * BLOCK,
        this.controller.signal
      );
      this.reader.learn(upstream, this);
      this.body = upstream.body;
      // A source that ignores ranges sends the file from its start: not this cursor's bytes.
      if (this.start > 0 && !upstream.ranged)
        throw Object.assign(new Error('The source ignores byte ranges'), {
          status: 502,
        });
      this.touch();
      for await (const chunk of upstream.body as AsyncIterable<Buffer>) {
        if (this.stopped) break;
        this.pending.push(chunk);
        this.pendingBytes += chunk.length;
        while (this.pendingBytes >= BLOCK) this.flush(BLOCK);
        // Caught up with blocks another cursor already read: those aren't read twice. Its waiting
        // reads are asked again (`finish`), and are served from the store.
        if (this.reader.stores && this.reader.holds(this.next)) {
          this.stop();
          break;
        }
        // Far enough ahead of every reader it serves: wait for them.
        while (!this.stopped && this.ahead()) await this.reader.moved();
      }
      if (!this.stopped && this.pendingBytes > 0) this.flush(this.pendingBytes);
      this.finish(null);
    } catch (error) {
      this.finish(this.stopped ? null : (error as Error));
    }
  }

  private ahead(): boolean {
    // Someone is waiting for a block it hasn't reached yet: never ahead.
    if (this.waiters.some((w) => w.block >= this.next)) return false;
    // Nothing kept: only blocks someone is waiting for are worth reading.
    if (!this.reader.stores) return true;
    const furthest = this.reader.furthestFor(this);
    return (
      furthest === null || this.next * BLOCK > furthest + this.reader.readAhead
    );
  }

  private flush(bytes: number): void {
    const data = Buffer.concat(this.pending, this.pendingBytes);
    const block = data.subarray(0, bytes);
    const rest = data.subarray(bytes);
    this.pending = rest.length ? [Buffer.from(rest)] : [];
    this.pendingBytes = rest.length;
    const stored = Buffer.from(block);
    if (this.reader.stores) this.reader.store(this.next, stored);
    for (const waiter of this.waiters.filter((w) => w.block === this.next))
      waiter.resolve(stored);
    this.waiters.splice(
      0,
      this.waiters.length,
      ...this.waiters.filter((w) => w.block !== this.next)
    );
    this.next++;
    // Its waiting reads are served: it may be moved now (see `fetch`).
    this.reader.served();
  }

  /** Keeps the cursor alive while someone reads within its range. */
  touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.waiters.length && !this.reader.readsNear(this)) this.stop();
      else this.touch();
    }, CURSOR_IDLE_MS);
    this.idleTimer.unref?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    this.body?.destroy();
    this.finish(null);
  }

  private finish(error: Error | null): void {
    clearTimeout(this.idleTimer);
    this.stopped = true;
    const left = this.waiters.splice(0);
    this.reader.ended(this);
    for (const waiter of left) {
      // Past the end of the file, or the cursor was stopped: the reader asks again.
      if (error) waiter.reject(error);
      else this.reader.retry(waiter);
    }
  }
}

let ids = 0;

/** One source, read once and served to everyone. */
export class SourceReader {
  readonly id = `${process.pid}-${++ids}`;
  private length: number | null = null;
  private ranged = true;
  private etag: string | null = null;
  private lastModified = new Date();
  private learned: Promise<void> | null = null;
  private learnedResolve: (() => void) | null = null;
  /** The source has answered once: its size and whether it serves ranges are known. */
  private described = false;
  private cursors: Cursor[] = [];
  /** The byte position of every open read. */
  private reads = new Set<{ at: number }>();
  private movedWaiters: (() => void)[] = [];
  private failure: SourceStatus | null = null;
  closed = false;

  /** Upstream reads at once. */
  private maxCursors: number;
  /**
   * Blocks are kept for later reads. Not for native usenet, whose engine keeps the articles:
   * there one cursor only hands blocks to the reads waiting on them.
   */
  stores: boolean;
  /** How far a cursor reads ahead of the furthest reader it serves. */
  readonly readAhead: number;

  constructor(
    readonly filename: string,
    private readonly opener: SourceOpener,
    private readonly store_: BlockStore,
    options: { maxCursors: number; stores: boolean; readAhead?: number }
  ) {
    this.maxCursors = options.maxCursors;
    this.stores = options.stores;
    this.readAhead = options.readAhead ?? READ_AHEAD;
  }

  /** The reader's state, for the transcoder to tell a source failure from its own. */
  status(): SourceStatus {
    if (this.failure) return this.failure;
    if (this.length !== null) return { state: 'ok' };
    return this.cursors.length && this.opener.resolving()
      ? { state: 'resolving' }
      : { state: 'idle' };
  }

  /** Blocks anyone is reading now, for eviction. */
  activeBlocks(): number[] {
    return [...this.reads].map((r) => Math.floor(r.at / BLOCK));
  }

  /**
   * The furthest byte read by anyone this cursor serves: reads at or after its start with no
   * other cursor started between (that one serves them). Null if none.
   */
  furthestFor(cursor: Cursor): number | null {
    let furthest: number | null = null;
    for (const r of this.reads) {
      const block = Math.floor(r.at / BLOCK);
      if (block < cursor.start) continue;
      if (this.cursors.some((c) => c.start > cursor.start && c.start <= block))
        continue;
      if (furthest === null || r.at > furthest) furthest = r.at;
    }
    return furthest;
  }

  readsNear(cursor: Cursor): boolean {
    for (const r of this.reads) {
      const block = Math.floor(r.at / BLOCK);
      if (
        block >= cursor.start &&
        block <= cursor.next + this.readAhead / BLOCK
      )
        return true;
    }
    return false;
  }

  /** Resolves when any read moves on (a cursor waiting to read further ahead). */
  moved(): Promise<void> {
    return new Promise((resolve) => this.movedWaiters.push(resolve));
  }

  private tellMoved(): void {
    for (const resolve of this.movedWaiters.splice(0)) resolve();
  }

  /** What the first response said about the file. */
  learn(upstream: Upstream, by?: Cursor): void {
    const changed =
      this.etag !== null &&
      upstream.etag !== null &&
      upstream.etag !== this.etag;
    if (changed) {
      // Another file behind the same source (re-resolved): nothing cached is it, and the other
      // cursors are still reading the old one.
      logger.info(
        { file: this.filename },
        'guest source changed; cache dropped'
      );
      for (const cursor of [...this.cursors]) if (cursor !== by) cursor.stop();
      this.store_.drop(this);
    }
    if (upstream.native && this.stores) {
      // Learned on the first open: a native usenet source keeps nothing and reads one place.
      this.stores = false;
      this.maxCursors = 1;
      this.store_.drop(this);
    }
    this.length = upstream.size ?? this.length;
    this.ranged = upstream.ranged;
    this.etag = upstream.etag ?? this.etag;
    if (upstream.lastModified) this.lastModified = upstream.lastModified;
    this.failure = null;
    this.described = true;
    this.learnedResolve?.();
  }

  /** Whether a block is stored. */
  holds(block: number): boolean {
    return this.store_.has(this, block);
  }

  store(block: number, data: Buffer): void {
    this.store_.put(this, block, data);
  }

  /** A cursor served its waiting reads, or ended. */
  served(): void {
    this.tellMoved();
  }

  ended(cursor: Cursor): void {
    this.cursors = this.cursors.filter((c) => c !== cursor);
    this.tellMoved();
  }

  retry(waiter: Waiter): void {
    if (this.closed)
      return waiter.reject(
        Object.assign(new Error('Source closed'), { status: 410 })
      );
    // Nothing is read through a source that can't be shared (it's passed through instead).
    if (this.described && !this.shareable())
      return waiter.resolve(Buffer.alloc(0));
    if (this.length !== null && waiter.block * BLOCK >= this.length)
      return waiter.resolve(Buffer.alloc(0));
    this.fetch(waiter.block).then(waiter.resolve, waiter.reject);
  }

  /** Learns the file's size and whether it serves ranges, from a first read at 0. */
  async describe(signal?: AbortSignal): Promise<void> {
    if (this.described) return;
    this.learned ??= new Promise<void>((resolve) => {
      this.learnedResolve = resolve;
    });
    const block = this.fetch(0);
    await Promise.race([
      this.learned,
      block.then(() => undefined),
      new Promise((_, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      ),
    ]);
    // Nothing is shared from a source that isn't shareable: its first read stops here.
    if (!this.shareable())
      for (const cursor of [...this.cursors]) cursor.stop();
  }

  /** One block, from the cache or from a cursor (an existing one where it reaches). */
  async fetch(block: number): Promise<Buffer> {
    if (this.stores) {
      const cached = await this.store_.get(this, block);
      if (cached) return cached;
    }
    if (this.length !== null && block * BLOCK >= this.length)
      return Buffer.alloc(0);
    let cursor = this.cursors.find((c) => c.covers(block));
    // At the cap, a cursor makes way for a read it doesn't reach, but only once it has served
    // the reads already waiting on it: otherwise readers could keep moving it without any of
    // them getting their bytes. Of those free, the one furthest from anyone reading goes.
    while (!cursor && this.cursors.length >= this.maxCursors) {
      const near = this.activeBlocks();
      const now = Date.now();
      const free = this.cursors
        .filter((c) => !c.waiters.length && c.movableAt() <= now)
        .sort((a, b) => distance(b.next, near) - distance(a.next, near));
      if (free.length) free[0].stop();
      else {
        // Until a read moves on, or the first cursor's turn is over.
        const turn = Math.min(...this.cursors.map((c) => c.movableAt())) - now;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          this.moved(),
          ...(turn > 0
            ? [new Promise<void>((r) => (timer = setTimeout(r, turn)))]
            : []),
        ]);
        clearTimeout(timer);
      }
      cursor = this.cursors.find((c) => c.covers(block));
      if (this.stores) {
        const cached = await this.store_.get(this, block);
        if (cached) return cached;
      }
    }
    if (!cursor) {
      cursor = new Cursor(this, block);
      this.cursors.push(cursor);
      const started = cursor;
      void started.run(this.opener).catch(() => {});
    }
    cursor.touch();
    cursor.usedAt = Date.now();
    const waiting = cursor;
    const data = new Promise<Buffer>((resolve, reject) =>
      waiting.waiters.push({
        block,
        resolve,
        reject: (error) => {
          this.failure = statusOf(error);
          reject(error);
        },
      })
    );
    // A cursor waiting for someone to want its next block reads on.
    this.tellMoved();
    return data;
  }

  /** The file's size, once the source has answered (`describe`); null before, or if it doesn't say. */
  size(): number | null {
    return this.length;
  }

  /**
   * Where a Matroska file keeps its Cues (its seek index), read through this reader: the byte
   * range of the Cues element, which the file's SeekHead points to. Null for anything else, for a
   * file whose SeekHead doesn't list its Cues, or for a source that isn't shared.
   */
  async cues(
    signal: AbortSignal
  ): Promise<{ start: number; end: number } | null> {
    await this.describe(signal);
    if (!this.shareable()) return null;
    const size = this.length!;
    const head = await this.bytes(0, Math.min(HEAD_BYTES, size), signal);
    const ebml = element(head, 0);
    if (!ebml || ebml.id !== EBML_ID || ebml.size === null) return null;
    const segment = element(head, ebml.dataEnd);
    if (!segment || segment.id !== SEGMENT_ID) return null;
    // The SeekHead is among the Segment's first children, before any Cluster.
    for (let at = segment.dataStart; at < head.length;) {
      const child = element(head, at);
      if (!child || child.size === null || child.id === CLUSTER_ID) return null;
      if (child.id === SEEK_HEAD_ID) {
        const position = seekPosition(head, child, CUES_ID);
        if (position === null) return null;
        const start = segment.dataStart + position;
        if (start >= size) return null;
        const found = element(
          await this.bytes(start, Math.min(16, size - start), signal),
          0
        );
        if (!found || found.id !== CUES_ID || found.size === null) return null;
        return { start, end: Math.min(start + found.dataEnd, size) };
      }
      at = child.dataEnd;
    }
    return null;
  }

  /** A range of the file, read as any reader reads it. */
  private async bytes(
    start: number,
    length: number,
    signal: AbortSignal
  ): Promise<Buffer> {
    const { stream } = await this.open(
      { start, endExclusive: start + length },
      signal
    );
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(part as Buffer);
    return Buffer.concat(parts);
  }

  /**
   * Whether this source can be shared: it serves byte ranges and says its size. One that
   * doesn't is passed through per request instead (`forward`), as before.
   */
  shareable(): boolean {
    return this.length !== null && this.ranged;
  }

  /** Opens a byte range for one reader. Only for a shareable source (see `shareable`). */
  async open(
    range:
      | { start?: number; endExclusive?: number; suffixLength?: number }
      | undefined,
    signal: AbortSignal
  ): Promise<ReadRange> {
    await this.describe(signal);
    if (!this.shareable())
      throw Object.assign(new Error('This source is not shared'), {
        status: 500,
      });
    const size = this.length!;
    const start =
      range?.suffixLength != null
        ? Math.max(0, size - range.suffixLength)
        : (range?.start ?? 0);
    const end = Math.min(range?.endExclusive ?? size, size);
    const read = { at: start };
    this.reads.add(read);
    this.tellMoved();
    const self = this;
    const stream = Readable.from(
      (async function* () {
        try {
          let at = start;
          while (at < end) {
            const block = Math.floor(at / BLOCK);
            const data = await self.fetch(block);
            if (!data.length) break;
            const from = at - block * BLOCK;
            const upto = Math.min(data.length, end - block * BLOCK);
            if (upto <= from) break;
            yield data.subarray(from, upto);
            at = block * BLOCK + upto;
            read.at = at;
            self.tellMoved();
          }
        } finally {
          self.reads.delete(read);
          self.tellMoved();
        }
      })(),
      { objectMode: false }
    );
    signal.addEventListener('abort', () => stream.destroy(), { once: true });
    return {
      stream,
      size,
      start,
      end,
      filename: this.filename,
      etag: `"${this.etag ?? this.id}"`,
      lastModified: this.lastModified,
    };
  }

  close(): void {
    this.closed = true;
    for (const cursor of [...this.cursors]) cursor.stop();
    this.store_.drop(this);
  }
}

// Matroska (EBML) element ids, with their length markers, as files store them.
const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const SEEK_HEAD_ID = 0x114d9b74;
const SEEK_ID = 0x4dbb;
const SEEK_ID_ID = 0x53ab;
const SEEK_POSITION_ID = 0x53ac;
const CUES_ID = 0x1c53bb6b;
const CLUSTER_ID = 0x1f43b675;
/** How much of a file's start is read to find its SeekHead. */
const HEAD_BYTES = 64 * 1024;

interface Element {
  id: number;
  dataStart: number;
  /** Null when the element says its size is unknown (to the end of its parent). */
  size: number | null;
  dataEnd: number;
}

/** An EBML variable-length integer at `at`: an id (marker kept) or a size (marker removed). */
function vint(
  data: Buffer,
  at: number,
  id: boolean
): { value: number; length: number; unknown: boolean } | null {
  if (at >= data.length || data[at] === 0) return null;
  const length = Math.clz32(data[at]) - 23;
  if (length > 8 || at + length > data.length) return null;
  const mask = 0xff >> length;
  let value = id ? data[at] : data[at] & mask;
  let unknown = !id && value === mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + data[at + i];
    if (data[at + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

/** The element whose header starts at `at`; null if it doesn't fit in `data`. */
function element(data: Buffer, at: number): Element | null {
  const id = vint(data, at, true);
  if (!id) return null;
  const size = vint(data, at + id.length, false);
  if (!size) return null;
  const dataStart = at + id.length + size.length;
  return size.unknown
    ? { id: id.value, dataStart, size: null, dataEnd: Infinity }
    : {
        id: id.value,
        dataStart,
        size: size.value,
        dataEnd: dataStart + size.value,
      };
}

function uint(data: Buffer, at: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + data[at + i];
  return value;
}

/** The SeekPosition a SeekHead gives for `wanted` (relative to the Segment's data); null if none. */
function seekPosition(
  data: Buffer,
  seekHead: Element,
  wanted: number
): number | null {
  if (seekHead.dataEnd > data.length) return null;
  for (let at = seekHead.dataStart; at < seekHead.dataEnd;) {
    const seek = element(data, at);
    if (!seek || seek.size === null || seek.dataEnd > seekHead.dataEnd)
      return null;
    if (seek.id === SEEK_ID) {
      let id: number | null = null;
      let position: number | null = null;
      for (let inner = seek.dataStart; inner < seek.dataEnd;) {
        const e = element(data, inner);
        if (!e || e.size === null || e.dataEnd > seek.dataEnd) return null;
        if (e.id === SEEK_ID_ID) id = uint(data, e.dataStart, e.size);
        else if (e.id === SEEK_POSITION_ID)
          position = uint(data, e.dataStart, e.size);
        inner = e.dataEnd;
      }
      if (id === wanted && position !== null) return position;
    }
    at = seek.dataEnd;
  }
  return null;
}

function distance(block: number, near: number[]): number {
  return near.length
    ? Math.min(...near.map((at) => Math.abs(block - at)))
    : Infinity;
}

function statusOf(error: unknown): SourceStatus {
  const e = error as { status?: number; code?: string; message?: string };
  return {
    state: 'failed',
    class: 'source',
    status: typeof e.status === 'number' ? e.status : 502,
    code: e.code,
    message: e.message ?? 'The source failed',
  };
}
