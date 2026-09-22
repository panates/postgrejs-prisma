import type {
  Provider,
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
} from '@prisma/driver-adapter-utils';
import { Pool, type PoolConfiguration } from 'postgrejs';
import { PrismaPostgreJSAdapter } from './adapter.js';
import { poolConfig, type PrismaPostgreJSOptions } from './options.js';
import { ADAPTER_NAME } from './queryable.js';

export type { PrismaPostgreJSOptions } from './options.js';
export { ADAPTER_NAME } from './queryable.js';

/**
 * A Prisma driver adapter over PostgreJS.
 *
 * ```ts
 * const adapter = new PrismaPostgreJS({ host: 'localhost', database: 'app' });
 * const prisma = new PrismaClient({ adapter });
 * ```
 *
 * Takes the same configuration `new Pool()` does, a connection string, or a
 * `Pool` you already have - in which case closing it stays yours to do, and
 * `PrismaClient.$disconnect()` leaves it open.
 *
 * **This is the plain `SqlDriverAdapterFactory`, not the migration-aware one.**
 * `prisma migrate` and `prisma db push` do not go through a driver adapter at
 * 7.x: the CLI connects with its own built-in connector using `datasource.url`
 * from `prisma.config.ts`, and nothing in `prisma` or `@prisma/client` calls
 * `connectToShadowDb`. Migrations need that URL configured separately.
 */
export class PrismaPostgreJS implements SqlDriverAdapterFactory {
  readonly provider: Provider = 'postgres';
  readonly adapterName = ADAPTER_NAME;
  protected readonly config: PoolConfiguration;
  protected readonly options: PrismaPostgreJSOptions | undefined;
  protected readonly externalPool: Pool | undefined;

  constructor(
    poolOrConfig: Pool | PoolConfiguration | string,
    options?: PrismaPostgreJSOptions,
  ) {
    this.options = options;
    if (poolOrConfig instanceof Pool) {
      this.externalPool = poolOrConfig;
      this.config = poolOrConfig.config;
    } else {
      this.config = poolConfig(poolOrConfig, options);
    }
  }

  async connect(): Promise<SqlDriverAdapter> {
    if (this.externalPool) {
      const onError = this.errorHandler();
      this.externalPool.on('error', onError);
      return new PrismaPostgreJSAdapter(
        this.externalPool,
        this.options,
        async () => {
          // Someone else owns it - unhook and leave it running.
          this.externalPool!.removeListener('error', onError);
        },
      );
    }
    const pool = new Pool(this.config);
    pool.on('error', this.errorHandler());
    return new PrismaPostgreJSAdapter(pool, this.options);
  }

  /**
   * `Pool` reports both a lost pooled connection and a connection it could not
   * open on `'error'`, and Prisma has nowhere to put either - an unhandled
   * `'error'` on an EventEmitter takes the process down, so one is always
   * attached even when the caller gave no handler.
   */
  protected errorHandler(): (error: Error) => void {
    const handler = this.options?.onPoolError;
    return (error: Error) => handler?.(error);
  }
}
