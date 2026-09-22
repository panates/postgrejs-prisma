import {
  type ConnectionInfo,
  DriverAdapterError,
  type IsolationLevel,
  type SqlDriverAdapter,
  type Transaction,
} from '@prisma/driver-adapter-utils';
import { Pool } from 'postgrejs';
import { convertError } from './errors.js';
import type { PrismaPostgreJSOptions } from './options.js';
import { PostgreJSQueryable, QUERY_OPTIONS } from './queryable.js';
import { beginStatement, PostgreJSTransaction } from './transaction.js';

export class PrismaPostgreJSAdapter
  extends PostgreJSQueryable
  implements SqlDriverAdapter
{
  protected readonly pool: Pool;
  protected readonly options: PrismaPostgreJSOptions | undefined;
  protected readonly dispose_: (() => Promise<void>) | undefined;

  constructor(
    pool: Pool,
    options: PrismaPostgreJSOptions | undefined,
    dispose?: () => Promise<void>,
  ) {
    super((sql, params) => pool.query(sql, { ...QUERY_OPTIONS, params }));
    this.pool = pool;
    this.options = options;
    this.dispose_ = dispose;
  }

  async startTransaction(
    isolationLevel?: IsolationLevel,
  ): Promise<Transaction> {
    // Before the connection is taken: an unsupported isolation level must not
    // cost an acquire it would only have to give back.
    const begin = beginStatement(isolationLevel);
    let connection;
    try {
      connection = await this.pool.acquire();
    } catch (e) {
      throw new DriverAdapterError(convertError(e));
    }
    const transaction = new PostgreJSTransaction(connection, () =>
      this.pool.release(connection),
    );
    try {
      await transaction.executeRaw({ sql: begin, args: [], argTypes: [] });
      return transaction;
    } catch (e) {
      await this.pool.release(connection).catch(() => undefined);
      throw e instanceof DriverAdapterError
        ? e
        : new DriverAdapterError(convertError(e));
    }
  }

  /**
   * PostgreJS splits the script itself, which is why this does not.
   * `@prisma/adapter-pg` does `script.split(';')`, and that breaks on a
   * semicolon inside a string literal or a dollar-quoted function body -
   * both of which a migration contains.
   */
  async executeScript(script: string): Promise<void> {
    try {
      await this.pool.execute(script);
    } catch (e) {
      throw new DriverAdapterError(convertError(e));
    }
  }

  getConnectionInfo(): ConnectionInfo {
    return {
      schemaName: this.options?.schema ?? this.pool.config.schema,
      // PostgreSQL supports LATERAL joins, and the reference adapter reports
      // true. The engine's query compiler reads it; at 7.10.0 no observable
      // difference followed from either value for a plain `include`.
      supportsRelationJoins: true,
      // maxBindValues is deliberately absent. Leaving it out selects the
      // engine's own PostgreSQL default of 32766, which is already below the
      // protocol's 65535 parameter ceiling; naming a lower one only makes the
      // engine split `IN` lists into more statements inside a transaction.
    };
  }

  async dispose(): Promise<void> {
    if (this.dispose_) return this.dispose_();
    await this.pool.close(0);
  }

  /** The underlying pool, for anything reaching past Prisma. */
  underlyingDriver(): Pool {
    return this.pool;
  }
}
