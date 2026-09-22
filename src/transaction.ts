import {
  DriverAdapterError,
  type IsolationLevel,
  type Transaction,
  type TransactionOptions,
} from '@prisma/driver-adapter-utils';
import type { Connection } from 'postgrejs';
import { convertError } from './errors.js';
import { PostgreJSQueryable, QUERY_OPTIONS } from './queryable.js';

/**
 * One interactive transaction, on a connection of its own.
 *
 * **`usePhantomQuery: false`, which is what the reference adapter reports and
 * is not the obvious choice.** With `true` the engine calls `commit()` here
 * instead of sending anything, and logs the transaction boundary as
 * `-- Implicit "COMMIT" query via underlying driver`. That reads like the
 * better option - PostgreJS's own `connection.commit()` doing the work - and
 * it is the wrong one:
 *
 * - The literal words `BEGIN`, `COMMIT` and `ROLLBACK` disappear from
 *   `PrismaClient`'s `query` event and from its `db.query.text` tracing
 *   attribute, which is what a user reads to see their transaction.
 * - It is not cheaper. With `false` the engine sends `COMMIT` through
 *   `executeRaw` and then calls `commit()`, which only has to release the
 *   connection - one round trip either way.
 * It does have one consequence, and it is why the `BEGIN` is a statement here
 * too. `connection.startTransaction()` keeps bookkeeping of its own, and a
 * `COMMIT` that goes past `connection.commit()` does not clear it - the next
 * `startTransaction()` on that pooled connection then refuses with *cannot set
 * transaction modes on a transaction that is already open*. `inTransaction`
 * reads the `ReadyForQuery` status and does go false, which is what made this
 * look safe at first; it is a different flag from the one that check reads. So
 * the transaction is opened, committed and rolled back entirely through SQL,
 * and PostgreJS's own transaction API is left out of it.
 *
 * Found by Prisma's own functional suite, which asserts both the query log
 * (`batching`) and the span tree (`tracing`).
 */
export class PostgreJSTransaction
  extends PostgreJSQueryable
  implements Transaction
{
  readonly options: TransactionOptions = { usePhantomQuery: false };
  protected readonly connection: Connection;
  protected readonly release: () => Promise<void>;

  constructor(connection: Connection, release: () => Promise<void>) {
    super((sql, params) => connection.query(sql, { ...QUERY_OPTIONS, params }));
    this.connection = connection;
    this.release = release;
  }

  /**
   * The engine has already sent `COMMIT`; this only gives the connection back.
   *
   * It still checks the transaction status first. The engine calls `rollback()`
   * when its own `COMMIT` fails, and a connection handed to the pool with a
   * transaction still open on it would carry that transaction to whoever picks
   * it up next. `@prisma/adapter-pg` releases unconditionally and has the same
   * hole; the check is one flag read and no round trip when it is clear.
   */
  async commit(): Promise<void> {
    await this.finish();
  }

  async rollback(): Promise<void> {
    await this.finish();
  }

  protected async finish(): Promise<void> {
    try {
      if (this.connection.inTransaction) {
        await this.connection.query('ROLLBACK', QUERY_OPTIONS);
      }
    } catch (e) {
      throw new DriverAdapterError(convertError(e));
    } finally {
      await this.release();
    }
  }

  /**
   * Prisma generates the names itself as `prisma_sp_<n>`, which is why they can
   * be handed straight to PostgreJS - whose own validator accepts
   * `/^[a-zA-Z]\w*$/` and rejects anything else.
   */
  async createSavepoint(name: string): Promise<void> {
    await this.savepointOp(() => this.connection.savepoint(name));
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    await this.savepointOp(() => this.connection.rollbackToSavepoint(name));
  }

  async releaseSavepoint(name: string): Promise<void> {
    await this.savepointOp(() => this.connection.releaseSavepoint(name));
  }

  protected async savepointOp(op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (e) {
      throw new DriverAdapterError(convertError(e));
    }
  }
}

/**
 * The isolation levels PostgreSQL has, spelled as PostgreSQL spells them.
 *
 * Prisma's `IsolationLevel` strings are already the SQL words, so this is a
 * membership test rather than a mapping - and it is what makes interpolating
 * one into a statement safe. `SNAPSHOT` is in Prisma's union and has no
 * PostgreSQL equivalent; the engine rejects it before the adapter is asked, so
 * it is listed as unsupported rather than left to fall off the end.
 */
const ISOLATION_LEVELS: Record<IsolationLevel, boolean> = {
  'READ UNCOMMITTED': true,
  'READ COMMITTED': true,
  'REPEATABLE READ': true,
  SERIALIZABLE: true,
  SNAPSHOT: false,
};

/**
 * The statement that opens a transaction at `level`.
 *
 * PostgreSQL takes the level on the `BEGIN` itself, so this is one round trip
 * where `@prisma/adapter-pg` sends `BEGIN` and then `SET TRANSACTION ISOLATION
 * LEVEL` - worth about 12 points on a short isolated transaction.
 *
 * It is a statement rather than a call to `connection.startTransaction()` for
 * two reasons: PostgreJS's own transaction bookkeeping then never diverges
 * from what the engine is doing over the wire (see above), and the `BEGIN`
 * appears in `PrismaClient`'s query event and tracing span like every other
 * statement.
 */
export function beginStatement(level: IsolationLevel | undefined): string {
  if (level === undefined) return 'BEGIN';
  if (!ISOLATION_LEVELS[level]) {
    throw new DriverAdapterError({
      kind: 'InvalidIsolationLevel',
      level,
    });
  }
  return `BEGIN ISOLATION LEVEL ${level}`;
}
