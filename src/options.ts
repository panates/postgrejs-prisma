import { parseConnectionString, type PoolConfiguration } from 'postgrejs';

export interface PrismaPostgreJSOptions {
  /**
   * The schema the engine qualifies its generated SQL with, reported through
   * `getConnectionInfo()`. Falls back to `?schema=` on the connection string.
   */
  schema?: string;
  /**
   * Whether a statement may share a pooled connection with statements already
   * in flight. Off in PostgreJS by default; this adapter turns it on, because
   * Prisma issues genuinely concurrent statements and sharing is what makes
   * them overlap on the wire instead of queueing for a connection.
   *
   * Measured on a pool of four with 32 concurrent statements: `findFirst` went
   * from -17% to -60% against `@prisma/adapter-pg`, with a 61/61 sign test. Set
   * `false` for one statement per connection at a time.
   * @default true
   */
  pipeline?: boolean;
  /**
   * Called with the error when a pooled connection is lost or one could not be
   * opened. Prisma has nowhere to report either, so without this they are only
   * observable as the failure of whatever query was in flight.
   */
  onPoolError?: (error: Error) => void;
}

/**
 * The PostgreJS settings this adapter fixes, and why.
 *
 * `rollbackOnError` puts a savepoint around every statement inside a
 * transaction, so a failed one is rolled back to and the transaction carries
 * on. PostgreSQL does not work that way and neither does `pg`: there, one
 * failed statement poisons the transaction and everything after it raises
 * `25P02`. Measured, the difference is not subtle - after a failed statement,
 * `true` commits the work either side of it and `false` commits nothing, which
 * is what `pg` does. An adapter meant to be swapped in must not change that, so
 * it is fixed off. It also costs 23% on a twenty-statement transaction, about
 * 55µs a statement (slower in 97 of 101 alternated iterations).
 *
 * It is no longer a requirement, though: PostgreJS used to wrap
 * `SET TRANSACTION` in that savepoint too, which made every isolation level
 * impossible to set. That was reported from this round and fixed upstream.
 *
 * `asyncErrorHandling` is a default rather than a requirement. PostgreJS
 * captures the caller's stack across the `await` so a thrown error points at
 * application code - but Prisma rewrites every adapter error into a
 * `DriverAdapterError` carrying a plain object and attaches its own callsite,
 * so not one frame of that capture reaches the user. It costs about 13% of a
 * concurrent burst once `pipeline` is on. A caller reaching past Prisma for
 * `$queryRaw` debugging can turn it back on.
 */
export function poolConfig(
  config: PoolConfiguration | string,
  options: PrismaPostgreJSOptions | undefined,
): PoolConfiguration {
  const base: PoolConfiguration =
    typeof config === 'string' ? parseConnectionString(config) : { ...config };
  return {
    asyncErrorHandling: false,
    pipeline: options?.pipeline ?? true,
    ...base,
    // Not overridable: see above.
    rollbackOnError: false,
  };
}
