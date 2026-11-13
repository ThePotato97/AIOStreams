import '../../utils/general.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteDriver } from '../../db/driver/sqlite.js';
import type { DbDriver } from '../../db/driver/types.js';
import { PersistedBackend, backendFor } from './persisted.js';
import { RedisBackend } from './redis.js';
import { SharedTx, type SharedKind } from './types.js';

interface Thing {
  name: string;
  tag: string;
  ref: string;
  due: number | null;
  settled?: boolean;
}
/** A kind as the relay's and the guest records are: saved as itself, tagged, found by ref. */
function kindOf(
  overrides: Partial<SharedKind<Thing>> = {},
  seen: { orphaned: string[]; lapsed: string[] } = { orphaned: [], lapsed: [] }
): SharedKind<Thing> {
  return {
    name: 'thing',
    ownCap: true,
    save: (t) => ({ ...t }),
    load: (saved: Thing) => ({ ...saved }),
    due: (t) => t.due,
    tags: (t) => [t.tag],
    refs: (t) => [t.ref],
    receive: () => {},
    lapse: (id) => void seen.lapsed.push(id),
    orphaned: async (replica) => void seen.orphaned.push(replica),
    ...overrides,
  };
}

let dir: string;
let file: string;
/** The databases the suite runs on: SQLite always, Postgres where PERSISTED_PG_URI names one. */
const databases: [string, () => Promise<() => DbDriver>][] = [
  ['SQLite', async () => () => new SqliteDriver(file)],
];
if (process.env.PERSISTED_PG_URI)
  databases.push([
    'Postgres',
    async () => {
      const { PostgresDriver } = await import('../../db/driver/postgres.js');
      const pg = new PostgresDriver(process.env.PERSISTED_PG_URI!);
      await pg.exec('DROP TABLE IF EXISTS fork_shared_records');
      return () => pg;
    },
  ]);
let open: () => DbDriver;
const rows = async (db: DbDriver) =>
  db.query<{ kind: string; id: string; saved: string; log: string | null }>(
    "SELECT kind, id, saved, log FROM fork_shared_records WHERE kind <> '__meta' ORDER BY id"
  );

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'persisted-'));
  file = path.join(dir, 'db.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

for (const [name, make] of databases)
  describe(`the shared store kept in the database (${name})`, () => {
    beforeEach(async () => {
      open = await make();
    });
    it('outlasts a restart: the same records, tags, refs, deadlines and logs', async () => {
      const db = open();
      const before = new PersistedBackend(() => db);
      const things = before.records(kindOf());
      await before.start();
      assert.equal(
        things.create(
          'a',
          () => ({ name: 'A', tag: 'party:1', ref: 'src:x', due: null }),
          10
        ),
        'ok'
      );
      things.update('a', (t) => void (t.name = 'A2'));
      things.append('a', 'hello', 10, new SharedTx());
      things.append('a', 'again', 10, new SharedTx());
      await before.stop();

      const after = new PersistedBackend(() => db);
      const again = after.records(kindOf());
      await after.start();
      assert.equal(again.peek('a')?.name, 'A2');
      assert.deepEqual(again.tagged('party:1'), ['a']);
      assert.equal(again.find('src:x'), 'a');
      assert.deepEqual(again.log('a'), ['hello', 'again']);
      await after.stop();
    });

    it('forgets a dropped record, its log included', async () => {
      const db = open();
      const backend = new PersistedBackend(() => db);
      const things = backend.records(kindOf());
      await backend.start();
      things.create(
        'a',
        () => ({ name: 'A', tag: 't', ref: 'r', due: null }),
        0
      );
      things.append('a', 'line', 5, new SharedTx());
      await backend.flush();
      assert.equal((await rows(db)).length, 1);
      things.update('a', (_t, tx) => tx.drop());
      await backend.stop();
      assert.deepEqual(await rows(db), []);
    });

    it('reports the process before it gone, so its members show away', async () => {
      const db = open();
      const before = new PersistedBackend(() => db);
      before.records(kindOf());
      await before.start();
      await before.stop();
      const seen = { orphaned: [] as string[], lapsed: [] as string[] };
      const after = new PersistedBackend(() => db);
      after.records(kindOf({}, seen));
      await after.start();
      assert.deepEqual(seen.orphaned, [before.replica]);
      await after.stop();
    });

    it('fills a kind registered after start at once, before its first read', async () => {
      const db = open();
      const before = new PersistedBackend(() => db);
      const things = before.records(kindOf());
      await before.start();
      things.create(
        'late',
        () => ({ name: 'L', tag: 't', ref: 'r', due: null }),
        0
      );
      await before.stop();
      const after = new PersistedBackend(() => db);
      await after.start();
      // As the guest sessions register: lazily, on their first request.
      const again = after.records(kindOf());
      assert.equal(again.peek('late')?.name, 'L');
      await after.stop();
    });

    it('lets a record already past its deadline lapse as usual', async () => {
      const db = open();
      const before = new PersistedBackend(() => db);
      const things = before.records(kindOf());
      await before.start();
      things.create(
        'old',
        () => ({ name: 'O', tag: 't', ref: 'r', due: Date.now() - 1 }),
        0
      );
      await before.stop();
      const seen = { orphaned: [] as string[], lapsed: [] as string[] };
      const after = new PersistedBackend(() => db);
      after.records(kindOf({}, seen));
      await after.start();
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepEqual(seen.lapsed, ['old']);
      await after.stop();
    });

    it('writes, on stop, a change made just before it, after it settles', async () => {
      const db = open();
      const backend = new PersistedBackend(() => db);
      const things = backend.records(
        kindOf({
          before: () => null,
          settle: (t) => void (t.settled = true),
        })
      );
      await backend.start();
      things.create(
        'a',
        () => ({ name: 'A', tag: 't', ref: 'r', due: null }),
        0
      );
      await backend.flush();
      // As the relay marks its members away on shutdown, just before the store stops.
      things.update('a', (t) => void (t.name = 'away'));
      await backend.stop();
      const saved = JSON.parse((await rows(db))[0].saved) as Thing;
      assert.equal(saved.name, 'away');
      assert.equal(saved.settled, true);
    });

    it('writes no row for messages about no record', async () => {
      const db = open();
      const backend = new PersistedBackend(() => db);
      const things = backend.records(kindOf());
      await backend.start();
      things.broadcast(new SharedTx());
      things.publish('nobody', new SharedTx());
      await backend.stop();
      assert.deepEqual(await rows(db), []);
    });

    it('keeps a change whose write failed, and writes it next time', async () => {
      const db = open();
      let fail = false;
      const flaky: DbDriver = Object.assign(Object.create(db), {
        exec: (text: unknown, params?: readonly unknown[]) => {
          if (fail && String(text).includes('INSERT'))
            return Promise.reject(new Error('disk full'));
          return db.exec(text as string, params);
        },
        query: db.query.bind(db),
        dialect: db.dialect,
      });
      const backend = new PersistedBackend(() => flaky);
      const things = backend.records(kindOf());
      await backend.start();
      fail = true;
      things.create(
        'a',
        () => ({ name: 'A', tag: 't', ref: 'r', due: null }),
        0
      );
      await backend.flush();
      assert.deepEqual(await rows(db), []);
      fail = false;
      await backend.flush();
      assert.equal((await rows(db)).length, 1);
      await backend.stop();
    });

    it('skips a stored record it cannot read, and starts without a database it cannot use', async () => {
      const db = open();
      const before = new PersistedBackend(() => db);
      const things = before.records(kindOf());
      await before.start();
      things.create(
        'good',
        () => ({ name: 'G', tag: 't', ref: 'r1', due: null }),
        0
      );
      things.create(
        'bad',
        () => ({ name: 'B', tag: 't', ref: 'r2', due: null }),
        0
      );
      await before.stop();
      const after = new PersistedBackend(() => db);
      const again = after.records(
        kindOf({
          load: (saved: Thing) => {
            if (saved.name === 'B') throw new Error('unreadable');
            return { ...saved };
          },
        })
      );
      await after.start();
      assert.equal(again.peek('good')?.name, 'G');
      assert.equal(again.peek('bad'), undefined);
      await after.stop();
      // No database at all: kept in memory, and the server still starts.
      const none = new PersistedBackend(() => {
        throw new Error('no database');
      });
      const kept = none.records(kindOf());
      await none.start();
      kept.create('m', () => ({ name: 'M', tag: 't', ref: 'r', due: null }), 0);
      assert.equal(kept.peek('m')?.name, 'M');
      await none.stop();
    });

    it('is chosen when the server has no Redis; Redis is chosen when it has', () => {
      const redis = () =>
        new RedisBackend(() => {
          throw new Error('not connected in this test');
        });
      const db = () => open();
      assert.ok(backendFor(undefined, redis, db) instanceof PersistedBackend);
      assert.ok(backendFor('', redis, db) instanceof PersistedBackend);
      assert.ok(
        backendFor('redis://localhost:6379', redis, db) instanceof RedisBackend
      );
    });
  });
