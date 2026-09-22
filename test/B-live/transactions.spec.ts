import { expect } from 'expect';
import {
  type LiveAdapter,
  openLiveAdapter,
  sqlQuery,
  tableName,
} from '../_support/live.js';

describe('B-live: transactions', () => {
  let live: LiveAdapter;
  let table: string;

  before(async () => {
    live = await openLiveAdapter();
    table = tableName('tx');
    await live.adapter.executeScript(`create table "${table}"(n int)`);
  });

  after(async () => {
    if (live) {
      await live.adapter
        .executeScript(`drop table if exists "${table}"`)
        .catch(() => undefined);
      await live.close();
    }
  });

  const rows = async (): Promise<number[]> =>
    (await live.query(`select n from "${table}" order by n`)).rows.map(
      r => r[0] as number,
    );

  const clear = () =>
    live.adapter.executeRaw(sqlQuery(`delete from "${table}"`));

  /**
   * What the engine does under `usePhantomQuery: false`: it sends the word
   * itself through `executeRaw`, and only then calls the method, which has
   * nothing left to do but give the connection back. Every test below drives
   * the transaction this way rather than calling `commit()` on its own,
   * because calling it on its own is not a thing Prisma ever does.
   */
  const engineCommit = async (
    tx: Awaited<ReturnType<typeof live.adapter.startTransaction>>,
  ) => {
    await tx.executeRaw(sqlQuery('COMMIT'));
    await tx.commit();
  };

  const engineRollback = async (
    tx: Awaited<ReturnType<typeof live.adapter.startTransaction>>,
  ) => {
    await tx.executeRaw(sqlQuery('ROLLBACK'));
    await tx.rollback();
  };

  it('reports usePhantomQuery false, as the reference adapter does', async () => {
    // True would have the engine call commit() instead of sending anything,
    // and log the boundary as `-- Implicit "COMMIT" query via underlying
    // driver` - so the words BEGIN/COMMIT/ROLLBACK vanish from PrismaClient's
    // query event and from its db.query.text tracing attribute. It is no
    // cheaper either way: one round trip carries the COMMIT whichever sends
    // it. Prisma's own `batching` and `tracing` suites assert this.
    const tx = await live.adapter.startTransaction();
    expect(tx.options).toStrictEqual({ usePhantomQuery: false });
    await engineRollback(tx);
  });

  it('commits', async () => {
    await clear();
    const tx = await live.adapter.startTransaction();
    await tx.executeRaw(sqlQuery(`insert into "${table}" values(1)`));
    await engineCommit(tx);
    expect(await rows()).toStrictEqual([1]);
  });

  it('rolls back', async () => {
    await clear();
    const tx = await live.adapter.startTransaction();
    await tx.executeRaw(sqlQuery(`insert into "${table}" values(2)`));
    await engineRollback(tx);
    expect(await rows()).toStrictEqual([]);
  });

  it('rolls back a transaction the engine left open', async () => {
    // commit()/rollback() are only asked to release, so a transaction still
    // open at that point - which is what the engine leaves behind when its own
    // COMMIT fails - would otherwise ride the connection back into the pool.
    await clear();
    const tx = await live.adapter.startTransaction();
    await tx.executeRaw(sqlQuery(`insert into "${table}" values(3)`));
    await tx.rollback();
    expect(await rows()).toStrictEqual([]);
  });

  it('returns the connection to the pool on commit and on rollback', async () => {
    // Four connections, six transactions: a leak would deadlock rather than
    // fail, so this is the shape that catches it.
    for (let i = 0; i < 6; i++) {
      const tx = await live.adapter.startTransaction();
      await tx.queryRaw(sqlQuery('select 1'));
      await (i % 2 ? engineRollback(tx) : engineCommit(tx));
    }
    expect(await rows()).toBeDefined();
  });

  describe('isolation levels', () => {
    // PostgreSQL takes these on the BEGIN itself, which is one round trip where
    // the reference adapter sends BEGIN and then SET TRANSACTION.
    const levels: [string, string][] = [
      ['READ UNCOMMITTED', 'read uncommitted'],
      ['READ COMMITTED', 'read committed'],
      ['REPEATABLE READ', 'repeatable read'],
      ['SERIALIZABLE', 'serializable'],
    ];

    for (const [level, reported] of levels) {
      it(`applies ${level}`, async () => {
        const tx = await live.adapter.startTransaction(level as never);
        try {
          const result = await tx.queryRaw(
            sqlQuery('show transaction_isolation'),
          );
          expect(result.rows[0][0]).toStrictEqual(reported);
        } finally {
          await tx.rollback();
        }
      });
    }

    it('refuses SNAPSHOT, which PostgreSQL has no equivalent for', async () => {
      // The engine rejects it before the adapter is asked, so this can only be
      // reached by calling the adapter directly - which is what a
      // `InvalidIsolationLevel` payload is for.
      await expect(
        live.adapter.startTransaction('SNAPSHOT'),
      ).rejects.toMatchObject({
        cause: { kind: 'InvalidIsolationLevel', level: 'SNAPSHOT' },
      });
    });
  });

  /**
   * Prisma drives nested interactive transactions through these, generating the
   * names itself as `prisma_sp_<n>`.
   */
  describe('savepoints', () => {
    it('rolls back to a savepoint and leaves the transaction alive', async () => {
      await clear();
      const tx = await live.adapter.startTransaction();
      await tx.executeRaw(sqlQuery(`insert into "${table}" values(1)`));
      await tx.createSavepoint!('prisma_sp_0');
      await tx.executeRaw(sqlQuery(`insert into "${table}" values(2)`));
      await tx.rollbackToSavepoint!('prisma_sp_0');
      await tx.executeRaw(sqlQuery(`insert into "${table}" values(3)`));
      await engineCommit(tx);
      expect(await rows()).toStrictEqual([1, 3]);
    });

    it('releases a savepoint', async () => {
      await clear();
      const tx = await live.adapter.startTransaction();
      await tx.createSavepoint!('prisma_sp_1');
      await tx.executeRaw(sqlQuery(`insert into "${table}" values(4)`));
      await tx.releaseSavepoint!('prisma_sp_1');
      await engineCommit(tx);
      expect(await rows()).toStrictEqual([4]);
    });

    it('works inside an isolated transaction', async () => {
      // The BEGIN carries the level here, so the savepoint runs on a
      // transaction that was opened in one statement rather than two.
      await clear();
      const tx = await live.adapter.startTransaction('SERIALIZABLE');
      await tx.executeRaw(sqlQuery(`insert into "${table}" values(5)`));
      await tx.createSavepoint!('prisma_sp_0');
      await tx.executeRaw(sqlQuery(`insert into "${table}" values(6)`));
      await tx.rollbackToSavepoint!('prisma_sp_0');
      await engineCommit(tx);
      expect(await rows()).toStrictEqual([5]);
    });
  });

  /**
   * `rollbackOnError` puts a savepoint around every statement in a transaction,
   * and PostgreSQL refuses `SET TRANSACTION ISOLATION LEVEL` inside one - so
   * the adapter fixes it off. A statement that fails must therefore abort the
   * transaction, the way PostgreSQL and `pg` both do.
   */
  it('lets a failed statement abort the transaction, as PostgreSQL does', async () => {
    await clear();
    const tx = await live.adapter.startTransaction();
    await tx.executeRaw(sqlQuery(`insert into "${table}" values(7)`));
    await expect(
      tx.queryRaw(sqlQuery('select nosuchcol')),
    ).rejects.toBeDefined();
    await expect(
      tx.executeRaw(sqlQuery(`insert into "${table}" values(8)`)),
    ).rejects.toMatchObject({ cause: { originalCode: '25P02' } });
    await tx.rollback();
    expect(await rows()).toStrictEqual([]);
  });

  /**
   * The error paths of the transaction API itself, as distinct from a statement
   * failing inside one. Each must arrive as a `DriverAdapterError` like any
   * other, and must still let go of the connection - a leak here would show up
   * as a deadlock much later and somewhere else.
   */
  describe('when the transaction API itself fails', () => {
    it('maps a failure from a savepoint name the server rejects', async () => {
      const tx = await live.adapter.startTransaction();
      try {
        await expect(
          tx.rollbackToSavepoint!('prisma_sp_never_created'),
        ).rejects.toMatchObject({ cause: { originalCode: '3B001' } });
      } finally {
        await tx.rollback();
      }
    });

    it('releases the connection even when commit fails', async () => {
      // Poisoned first, so COMMIT itself raises: the pool must get the
      // connection back regardless, or the next test deadlocks rather than
      // fails.
      const before = live.adapter as unknown as {
        pool: { acquiredConnections: number };
      };
      const tx = await live.adapter.startTransaction();
      await tx.executeRaw(sqlQuery(`insert into "${table}" values(1)`));
      await expect(
        tx.queryRaw(sqlQuery('select nosuchcol')),
      ).rejects.toBeDefined();
      await tx.rollback();
      expect(before.pool.acquiredConnections).toStrictEqual(0);
    });
  });

  it('maps an error raised inside a transaction', async () => {
    const tx = await live.adapter.startTransaction();
    await expect(
      tx.queryRaw(sqlQuery('select * from "NoSuchTable"')),
    ).rejects.toMatchObject({
      cause: { kind: 'TableDoesNotExist', table: 'NoSuchTable' },
    });
    await tx.rollback();
  });
});
