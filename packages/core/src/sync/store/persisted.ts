import { createLogger } from '../../logging/logger.js';
import type { DbDriver } from '../../db/driver/types.js';
import { MemoryBackend } from './memory.js';
import {
  SharedTx,
  type SharedBackend,
  type SharedKind,
  type SharedPresence,
  type SharedRecords,
} from './types.js';

const logger = createLogger('party');

/** How long a change waits before it's written; a crash loses at most this much. */
const FLUSH_MS = 500;
/** The row that remembers which process last ran, so the next can tidy up after it. */
const META = { kind: '__meta', id: 'replica' } as const;

interface Row {
  kind: string;
  id: string;
  saved: string;
  bulk: string | null;
  log: string | null;
}
interface Held<L> {
  kind: SharedKind<L>;
  records: SharedRecords<L>;
  /** Ids whose record changed since it was last written. */
  dirty: Set<string>;
  /** Filling it from the database: nothing to write back. */
  filling: boolean;
}

/**
 * The shared store kept in this process (as `MemoryBackend`), with every record also written to
 * AIOStreams' own database, so parties, guest links and their playbacks survive a restart without
 * Redis. One process only: it shares nothing between replicas, as `MemoryBackend` doesn't.
 *
 * Every change of a record reaches its kind's `receive` (a commit, a settle, an append); that's
 * where it is noted, and written within `FLUSH_MS`, and on `stop`. On `start` the records are read
 * back, and the process before this one is reported gone (`orphaned`), as the Redis backend does
 * for a replica that went without saying.
 */
export class PersistedBackend implements SharedBackend {
  private readonly inner = new MemoryBackend();
  readonly replica = this.inner.replica;
  readonly presence: SharedPresence = this.inner.presence;
  private readonly held = new Map<string, Held<any>>();
  /** What the database had at start, for kinds that register later. */
  private rows: Map<string, Row[]> | null = null;
  private previous: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | null = null;

  /** `db`: the server's database, once it's open (`getDb`). */
  constructor(private readonly db: () => DbDriver) {}

  records<L>(kind: SharedKind<L>): SharedRecords<L> {
    const held: Held<L> = {
      kind,
      records: undefined as unknown as SharedRecords<L>,
      dirty: new Set(),
      filling: false,
    };
    held.records = this.inner.records<L>({
      ...kind,
      receive: (id, messages, record) => {
        if (id && !held.filling) held.dirty.add(id);
        kind.receive(id, messages, record);
      },
    });
    this.held.set(kind.name, held);
    // Registered after start: filled now, from what was read then.
    if (this.rows) this.fill(held);
    return held.records;
  }

  async start(): Promise<void> {
    try {
      await this.load();
    } catch (err) {
      // Kept in this process only, as without a database: the server still starts.
      this.rows ??= new Map();
      logger.error(
        { err: err instanceof Error ? err.message : err },
        'shared records could not be read from the database; kept in memory only'
      );
    }
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
    await this.inner.start();
  }

  /** Reads every stored record, and fills the kinds registered so far. */
  private async load(): Promise<void> {
    const db = this.db();
    const int = db.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
    await db.exec(`CREATE TABLE IF NOT EXISTS fork_shared_records (
        kind        TEXT NOT NULL,
        id          TEXT NOT NULL,
        saved       TEXT NOT NULL,
        bulk        TEXT,
        log         TEXT,
        updated_at  ${int} NOT NULL,
        PRIMARY KEY (kind, id)
      )`);
    const rows = await db.query<Row & Record<string, unknown>>(
      'SELECT kind, id, saved, bulk, log FROM fork_shared_records'
    );
    this.rows = new Map();
    for (const row of rows) {
      if (row.kind === META.kind) {
        if (row.id === META.id) this.previous = JSON.parse(row.saved);
        continue;
      }
      const list = this.rows.get(row.kind) ?? [];
      list.push(row);
      this.rows.set(row.kind, list);
    }
    for (const held of this.held.values()) this.fill(held);
    await this.write(db, META.kind, META.id, JSON.stringify(this.replica));
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    // Changes made just before (the relay marking its members away) settle on the next turn.
    await new Promise((resolve) => setImmediate(resolve));
    await this.flush();
    await this.inner.stop();
  }

  /** Puts a kind's stored records back, then reports the process before this one gone. */
  private fill<L>(held: Held<L>): void {
    const rows = this.rows?.get(held.kind.name) ?? [];
    this.rows?.delete(held.kind.name);
    held.filling = true;
    try {
      for (const row of rows) {
        try {
          const saved = JSON.parse(row.saved);
          const bulk = row.bulk === null ? null : JSON.parse(row.bulk);
          const made = held.records.create(
            row.id,
            () => held.kind.load(saved, bulk, row.id),
            0
          );
          if (made !== 'ok') continue;
          const log: string[] = row.log ? JSON.parse(row.log) : [];
          for (const entry of log)
            held.records.append(row.id, entry, log.length, new SharedTx());
        } catch (err) {
          logger.warn(
            {
              kind: held.kind.name,
              err: err instanceof Error ? err.message : err,
            },
            'stored shared record could not be read; dropped'
          );
          held.dirty.add(row.id);
        }
      }
    } finally {
      held.filling = false;
    }
    if (this.previous && this.previous !== this.replica && held.kind.orphaned)
      held.kind.orphaned(this.previous).catch((err) =>
        logger.warn(
          {
            kind: held.kind.name,
            err: err instanceof Error ? err.message : err,
          },
          'tidying up after the previous process failed'
        )
      );
  }

  /** Writes what changed: each record as it is now, or its removal. */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    const run = this.writeDirty();
    this.flushing = run;
    try {
      await run;
    } finally {
      this.flushing = null;
    }
  }

  private async writeDirty(): Promise<void> {
    let db: DbDriver;
    try {
      db = this.db();
    } catch {
      return;
    }
    for (const held of this.held.values()) {
      if (!held.dirty.size) continue;
      const ids = [...held.dirty];
      held.dirty.clear();
      for (const id of ids) {
        try {
          const live = held.records.peek(id);
          if (live === undefined) {
            await db.exec(
              'DELETE FROM fork_shared_records WHERE kind = ? AND id = ?',
              [held.kind.name, id]
            );
            continue;
          }
          const log = await held.records.log(id);
          await this.write(
            db,
            held.kind.name,
            id,
            JSON.stringify(held.kind.save(live)),
            held.kind.bulk ? JSON.stringify(held.kind.bulk(live)) : null,
            log.length ? JSON.stringify(log) : null
          );
        } catch (err) {
          // Tried again with the next flush.
          held.dirty.add(id);
          logger.warn(
            {
              kind: held.kind.name,
              err: err instanceof Error ? err.message : err,
            },
            'shared record could not be written'
          );
        }
      }
    }
  }

  private async write(
    db: DbDriver,
    kind: string,
    id: string,
    saved: string,
    bulk: string | null = null,
    log: string | null = null
  ): Promise<void> {
    await db.exec(
      `INSERT INTO fork_shared_records (kind, id, saved, bulk, log, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, id) DO UPDATE
           SET saved = EXCLUDED.saved,
               bulk = EXCLUDED.bulk,
               log = EXCLUDED.log,
               updated_at = EXCLUDED.updated_at`,
      [kind, id, saved, bulk, log, Date.now()]
    );
  }
}

/** Redis when the server has it (its replicas share parties), else this backend. */
export function backendFor(
  redisUri: string | undefined,
  redis: () => SharedBackend,
  db: () => DbDriver
): SharedBackend {
  return redisUri ? redis() : new PersistedBackend(db);
}
