import type { SqlDriverAdapter } from '@prisma/driver-adapter-utils';
import { expect } from 'expect';
import { Pool } from 'postgrejs';
import { ADAPTER_NAME, PrismaPostgreJS } from '../../src/index.js';
import { sqlQuery } from '../_support/live.js';

const CONFIG = {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
};

const connectionString = () =>
  `postgresql://${CONFIG.user}:${CONFIG.password}@${CONFIG.host}:${CONFIG.port}/${CONFIG.database}`;

describe('B-live: the factory', () => {
  it('identifies itself, on the factory and on everything it makes', async () => {
    // `AdapterInfo` is required on the factory, the adapter *and* the
    // transaction - the client reads adapterName and provider off the
    // transaction to explain that nested transactions are unsupported.
    const factory = new PrismaPostgreJS({ ...CONFIG, max: 1 });
    expect(factory.provider).toStrictEqual('postgres');
    expect(factory.adapterName).toStrictEqual(ADAPTER_NAME);

    const adapter = await factory.connect();
    try {
      expect(adapter.provider).toStrictEqual('postgres');
      expect(adapter.adapterName).toStrictEqual(ADAPTER_NAME);
      const tx = await adapter.startTransaction();
      expect(tx.provider).toStrictEqual('postgres');
      expect(tx.adapterName).toStrictEqual(ADAPTER_NAME);
      await tx.rollback();
    } finally {
      await adapter.dispose();
    }
  });

  it('connects from a connection string', async () => {
    const adapter = await new PrismaPostgreJS(connectionString()).connect();
    try {
      const result = await adapter.queryRaw(
        sqlQuery('select current_database()'),
      );
      expect(result.rows[0][0]).toStrictEqual(CONFIG.database);
    } finally {
      await adapter.dispose();
    }
  });

  describe('a pool the caller owns', () => {
    let pool: Pool;
    let adapter: SqlDriverAdapter;

    before(async () => {
      pool = new Pool({ ...CONFIG, max: 2 });
      adapter = await new PrismaPostgreJS(pool).connect();
    });

    after(async () => {
      await pool?.close(0);
    });

    it('uses it', async () => {
      const result = await adapter.queryRaw(sqlQuery('select 1'));
      expect(result.rows[0][0]).toStrictEqual(1);
    });

    it('leaves it open on dispose, because closing it is the caller"s to do', async () => {
      await adapter.dispose();
      // Still usable: `PrismaClient.$disconnect()` must not take a pool the
      // caller is sharing with something else down with it.
      const result = await pool.query('select 2', { rowDecoder: 'array' });
      expect(result.rows![0][0]).toStrictEqual(2);
    });
  });

  it('closes a pool it opened itself', async () => {
    const factory = new PrismaPostgreJS({ ...CONFIG, max: 1 });
    const adapter = await factory.connect();
    const pool = (adapter as unknown as { pool: Pool }).pool;
    await adapter.queryRaw(sqlQuery('select 1'));
    expect(pool.totalConnections).toBeGreaterThan(0);

    await adapter.dispose();
    expect(pool.totalConnections).toStrictEqual(0);
    // Asserted this way rather than by querying a disposed adapter: a pooled
    // query after close() opens a fresh connection rather than raising, so a
    // `rejects` assertion would both fail and leave the pool open behind it.
  });

  describe('getConnectionInfo()', () => {
    it('reports the schema from the options', async () => {
      const adapter = await new PrismaPostgreJS(
        { ...CONFIG, max: 1 },
        { schema: 'my_schema' },
      ).connect();
      try {
        expect(adapter.getConnectionInfo!().schemaName).toStrictEqual(
          'my_schema',
        );
      } finally {
        await adapter.dispose();
      }
    });

    it('falls back to ?schema= on the connection string', async () => {
      const adapter = await new PrismaPostgreJS(
        `${connectionString()}?schema=from_url`,
      ).connect();
      try {
        expect(adapter.getConnectionInfo!().schemaName).toStrictEqual(
          'from_url',
        );
      } finally {
        await adapter.dispose();
      }
    });

    it('leaves maxBindValues unset', async () => {
      // Naming one only makes the engine chunk `IN` lists more aggressively
      // than PostgreSQL's own 65535-parameter ceiling requires.
      const adapter = await new PrismaPostgreJS({
        ...CONFIG,
        max: 1,
      }).connect();
      try {
        const info = adapter.getConnectionInfo!();
        expect(info.maxBindValues).toStrictEqual(undefined);
        expect(info.supportsRelationJoins).toStrictEqual(true);
      } finally {
        await adapter.dispose();
      }
    });
  });

  describe('executeScript', () => {
    it('runs several statements', async () => {
      const adapter = await new PrismaPostgreJS({
        ...CONFIG,
        max: 1,
      }).connect();
      const table = `t_script_${Math.random().toString(36).slice(2, 8)}`;
      try {
        await adapter.executeScript(
          `create table "${table}"(a text); insert into "${table}" values('x');`,
        );
        const result = await adapter.queryRaw(
          sqlQuery(`select a from "${table}"`),
        );
        expect(result.rows).toStrictEqual([['x']]);
      } finally {
        await adapter
          .executeScript(`drop table if exists "${table}"`)
          .catch(() => undefined);
        await adapter.dispose();
      }
    });

    it('survives a semicolon inside a literal and a dollar-quoted body', async () => {
      // A naive `script.split(';')` breaks on both, and a migration contains
      // both. PostgreJS splits the script itself, so this does not.
      const adapter = await new PrismaPostgreJS({
        ...CONFIG,
        max: 1,
      }).connect();
      const table = `t_semi_${Math.random().toString(36).slice(2, 8)}`;
      const fn = `f_${Math.random().toString(36).slice(2, 8)}`;
      try {
        await adapter.executeScript(
          `create table "${table}"(a text);
           insert into "${table}" values ('a;b');
           create function ${fn}() returns int as $$ begin return 1; end; $$ language plpgsql;`,
        );
        const result = await adapter.queryRaw(
          sqlQuery(`select a from "${table}"`),
        );
        expect(result.rows).toStrictEqual([['a;b']]);
      } finally {
        await adapter
          .executeScript(`drop table if exists "${table}"`)
          .catch(() => undefined);
        await adapter
          .executeScript(`drop function if exists ${fn}()`)
          .catch(() => undefined);
        await adapter.dispose();
      }
    });

    it('maps an error out of a script', async () => {
      const adapter = await new PrismaPostgreJS({
        ...CONFIG,
        max: 1,
      }).connect();
      try {
        await expect(
          adapter.executeScript('select * from "NoSuchTable_F"'),
        ).rejects.toMatchObject({
          cause: { kind: 'TableDoesNotExist', table: 'NoSuchTable_F' },
        });
      } finally {
        await adapter.dispose();
      }
    });
  });

  it('routes a pool error to onPoolError rather than taking the process down', async () => {
    // An unhandled 'error' on an EventEmitter is fatal, and Prisma has nowhere
    // to report one - so a handler is always attached even without this option.
    const seen: Error[] = [];
    const factory = new PrismaPostgreJS(
      { ...CONFIG, max: 1 },
      { onPoolError: e => seen.push(e) },
    );
    const adapter = await factory.connect();
    try {
      const pool = (adapter as unknown as { pool: Pool }).pool;
      const boom = new Error('pool went away');
      pool.emit('error', boom);
      expect(seen).toStrictEqual([boom]);
    } finally {
      await adapter.dispose();
    }
  });

  it('attaches a handler even when the caller gave none', async () => {
    const adapter = await new PrismaPostgreJS({ ...CONFIG, max: 1 }).connect();
    try {
      const pool = (adapter as unknown as { pool: Pool }).pool;
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
      // Must not throw, which is the whole point.
      pool.emit('error', new Error('ignored'));
    } finally {
      await adapter.dispose();
    }
  });
});
