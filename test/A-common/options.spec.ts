import { expect } from 'expect';
import { DataTypeOIDs } from 'postgrejs';
import { fetchAsString } from '../../src/conversion.js';
import { poolConfig } from '../../src/options.js';

describe('poolConfig()', () => {
  /**
   * All three schemes must give the same config. `postgresql://` is the one
   * Prisma writes, and PostgreJS 3.9.0 took the path as the database only for
   * `pg:` and `postgres:` - so that string lost its database and the connection
   * silently landed on the server's default. Found by this test, reported
   * upstream and fixed there (`ffbd971`); the workaround it needed is gone and
   * the test stays, because the requirement did not.
   */
  for (const scheme of ['postgresql', 'postgres', 'pg']) {
    it(`parses a ${scheme}:// connection string, database included`, () => {
      const config = poolConfig(
        `${scheme}://bob:secret@db.example.com:5433/app?schema=s1`,
        undefined,
      );
      expect(config.host).toStrictEqual('db.example.com');
      expect(config.port).toStrictEqual(5433);
      expect(config.user).toStrictEqual('bob');
      expect(config.password).toStrictEqual('secret');
      expect(config.schema).toStrictEqual('s1');
      expect(config.database).toStrictEqual('app');
    });
  }

  it('leaves a string that names no database alone', () => {
    expect(poolConfig('postgresql://h', undefined).database).toStrictEqual(
      undefined,
    );
  });

  it('keeps an object config as given', () => {
    const config = poolConfig({ host: 'h', database: 'd', max: 7 }, undefined);
    expect(config.host).toStrictEqual('h');
    expect(config.database).toStrictEqual('d');
    expect(config.max).toStrictEqual(7);
  });

  /**
   * Not a preference: the savepoint `rollbackOnError` puts around every
   * statement lets a failed one be rolled back to and the transaction carry on,
   * which is neither PostgreSQL's behaviour nor `pg`'s.
   */
  it('forces rollbackOnError off, even when the caller asks for it', () => {
    expect(
      poolConfig({ rollbackOnError: true }, undefined).rollbackOnError,
    ).toStrictEqual(false);
    expect(
      poolConfig('postgresql://h/d', undefined).rollbackOnError,
    ).toStrictEqual(false);
  });

  it('defaults asyncErrorHandling off, since Prisma discards the captured stack', () => {
    expect(poolConfig({}, undefined).asyncErrorHandling).toStrictEqual(false);
  });

  it('lets a caller turn asyncErrorHandling back on', () => {
    // Unlike rollbackOnError this one is a default, for anyone reaching past
    // Prisma with $queryRaw.
    expect(
      poolConfig({ asyncErrorHandling: true }, undefined).asyncErrorHandling,
    ).toStrictEqual(true);
  });

  it('defaults pipelining on', () => {
    expect(poolConfig({}, undefined).pipeline).toStrictEqual(true);
  });

  it('lets a caller turn pipelining off', () => {
    expect(poolConfig({}, { pipeline: false }).pipeline).toStrictEqual(false);
  });
});

describe('fetchAsString()', () => {
  const { int8, numeric, json, jsonb, time, timetz, timestamp, money } =
    DataTypeOIDs;

  /**
   * Everything here is a type Prisma takes exactly as the server wrote it, so
   * nothing needs converting afterwards - and nothing in `src/` could, since
   * no code there walks a result row.
   */
  it('asks only for the types that need no conversion', () => {
    expect([...fetchAsString()].sort()).toStrictEqual(
      [int8, numeric, json, jsonb, time].sort(),
    );
  });

  /**
   * Both would come back in a shape Prisma cannot read, and neither is fixed
   * up here - see the two task files named in `src/conversion.ts`. Pinned so
   * that adding them looks like a deliberate change rather than a tidy-up.
   */
  it('never asks for money, whose text carries a currency symbol', () => {
    expect(fetchAsString()).not.toContain(money);
  });

  it('never asks for timetz, whose text carries an offset', () => {
    expect(fetchAsString()).not.toContain(timetz);
  });

  it('never asks for a date-shaped type, which is what DateStyle rewrites', () => {
    expect(fetchAsString()).not.toContain(timestamp);
  });
});
