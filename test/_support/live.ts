import type {
  SqlDriverAdapter,
  SqlQuery,
  SqlResultSet,
} from '@prisma/driver-adapter-utils';
import {
  PrismaPostgreJS,
  type PrismaPostgreJSOptions,
} from '../../src/index.js';

/**
 * The adapter's own contract, tested directly rather than through a generated
 * `PrismaClient`.
 *
 * That is deliberate: `queryRaw`/`executeRaw`/`startTransaction` *are* the
 * surface Prisma uses, and driving them straight keeps the suite free of a
 * generated client and a `prisma generate` step. What the engine then does with
 * a `SqlResultSet` is Prisma's business, and the places where it matters -
 * which representations it accepts - are pinned in `test/C-differential`
 * against the reference adapter instead.
 */
export interface LiveAdapter {
  adapter: SqlDriverAdapter;
  /** `queryRaw` with no parameters, for the common case. */
  query(sql: string): Promise<SqlResultSet>;
  /** The first column of the first row. */
  one(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

export function sqlQuery(sql: string, args: unknown[] = []): SqlQuery {
  return { sql, args, argTypes: [] };
}

export async function openLiveAdapter(
  options: PrismaPostgreJSOptions = {},
): Promise<LiveAdapter> {
  const factory = new PrismaPostgreJS({ max: 4 }, options);
  const adapter = await factory.connect();
  const query = (sql: string) => adapter.queryRaw(sqlQuery(sql));
  return {
    adapter,
    query,
    async one(sql: string) {
      return (await query(sql)).rows[0][0];
    },
    async close() {
      await adapter.dispose();
    },
  };
}

/** A table name nothing else in the suite will collide with. */
export function tableName(hint: string): string {
  return `t_${hint}_${Math.random().toString(36).slice(2, 8)}`;
}
