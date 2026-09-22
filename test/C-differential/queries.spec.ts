import { PrismaPg } from '@prisma/adapter-pg';
import type { SqlDriverAdapter } from '@prisma/driver-adapter-utils';
import { expect } from 'expect';
import { PrismaPostgreJS } from '../../src/index.js';
import { sqlQuery } from '../_support/live.js';

/**
 * The same call through this adapter and through `@prisma/adapter-pg`, deep
 * compared.
 *
 * This is the file that earns its keep: the divergences it lists were all found
 * by running it, not by reading either implementation. Everything in
 * `intended` is a case where the two genuinely differ and this adapter is the
 * one that is right - so the assertion is the difference, and a day when it
 * stops differing is a day the reference was fixed and this file should be
 * revisited.
 */
describe('C-differential: against @prisma/adapter-pg', () => {
  let ours: SqlDriverAdapter;
  let theirs: SqlDriverAdapter;

  const config = {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  };

  before(async () => {
    ours = await new PrismaPostgreJS({ ...config, max: 2 }).connect();
    theirs = await new PrismaPg({ ...config, max: 2 }).connect();
  });

  after(async () => {
    await ours?.dispose();
    await theirs?.dispose();
  });

  /** Normalizes the shapes the two libraries return differently but equivalently. */
  const shape = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return `${v}n`;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      return `bytes:${Buffer.from(v).toString('hex')}`;
    }
    if (Array.isArray(v)) return v.map(shape);
    if (v instanceof Date) return `date:${v.toISOString()}`;
    return v;
  };

  const both = async (sql: string) => {
    const [a, b] = await Promise.all([
      ours.queryRaw(sqlQuery(sql)),
      theirs.queryRaw(sqlQuery(sql)),
    ]);
    return {
      ourTypes: a.columnTypes,
      theirTypes: b.columnTypes,
      ourValue: shape(a.rows[0]?.[0]),
      theirValue: shape(b.rows[0]?.[0]),
    };
  };

  /**
   * Types where the two must agree exactly, including on `columnTypes`.
   * Temporal types are absent on purpose - see `intended` below.
   */
  const identical = [
    `true::bool`,
    `12::int2`,
    `34::int4`,
    `9007199254740993::int8`,
    `42::oid`,
    `1.5::float4`,
    `1.5::float8`,
    `1234567890123456789.12::numeric`,
    `'txt'::text`,
    `'vc'::varchar`,
    `'ab'::bpchar`,
    `'nm'::name`,
    `B'101'::bit(3)`,
    `B'101'::varbit`,
    `'10.0.0.1'::inet`,
    `'10.0.0.0/8'::cidr`,
    `'<a/>'::xml`,
    `'00000000-0000-0000-0000-000000000001'::uuid`,
    `'{"a":1}'::json`,
    `'{"a": 1}'::jsonb`,
    `'\\x0102'::bytea`,
    // timetz is not here: the two adapters genuinely disagree about it, and
    // that disagreement is asserted once, under `intended divergences` below,
    // rather than twice. This list means "must agree".
    `'10:20:30'::time`,
    `array['10:20:30'::time]`,
    `array[9007199254740993::int8]`,
    `array[1.5::numeric]`,
    `array['{"a": 1}'::jsonb]`,
    `array['{"a": 1}'::json]`,
    `array[1,2]::int4[]`,
    `array['a','b']::text[]`,
    `array['','b']::text[]`,
    `array[true,false]::bool[]`,
    `array[1.5::float8]`,
    `array['\\x01'::bytea]`,
    `array['00000000-0000-0000-0000-000000000001'::uuid]`,
    `null::int4`,
    `null::text`,
  ];

  for (const expr of identical) {
    it(`agrees on ${expr}`, async () => {
      const r = await both(`select ${expr} as v`);
      expect(r.ourTypes).toStrictEqual(r.theirTypes);
      expect(r.ourValue).toStrictEqual(r.theirValue);
    });
  }

  /**
   * The engine converts what it is given, so two adapters can disagree on the
   * raw value and still deliver the same thing to a user. What is left here is
   * only the temporal types, which this adapter decodes to `Date` rather than
   * reading as text, and `money`, which it decodes because the server's own
   * rendering carries a currency symbol. Everything else that used to be in
   * this group became byte-identical once `fetchAsString` learned to name an
   * array by its element type.
   */
  const sameColumnTypeOnly = [
    `'2024-01-02'::date`,
    `'2024-01-02 10:20:30'::timestamp`,
    `array['2024-01-02'::date]`,
    `array['2024-01-02 10:20:30'::timestamp]`,
    `array['2024-01-02 10:20:30+00'::timestamptz]`,
    `array['1.00'::money]`,
  ];

  for (const expr of sameColumnTypeOnly) {
    it(`agrees on the ColumnType of ${expr}`, async () => {
      const r = await both(`select ${expr} as v`);
      expect(r.ourTypes).toStrictEqual(r.theirTypes);
    });
  }

  /** Types neither adapter can carry - they must refuse the same ones. */
  const refusedByBoth = [
    `'1 day'::interval`,
    `'(1,2)'::point`,
    `'<(1,2),3>'::circle`,
    `'[1,5)'::int4range`,
    `'a b'::tsvector`,
    `'01:02:03:04:05:06'::macaddr`,
    `'a'::"char"`,
    `array['(1,2)'::point]`,
    `array['1 day'::interval]`,
  ];

  for (const expr of refusedByBoth) {
    it(`both refuse ${expr}`, async () => {
      const sql = `select ${expr} as v`;
      await expect(ours.queryRaw(sqlQuery(sql))).rejects.toMatchObject({
        cause: { kind: 'UnsupportedNativeDataType' },
      });
      await expect(theirs.queryRaw(sqlQuery(sql))).rejects.toMatchObject({
        cause: { kind: 'UnsupportedNativeDataType' },
      });
    });
  }

  /**
   * Where the two adapters convert the same value differently, and this one is
   * right. `money` and `timetz` are Prisma representation requirements that
   * PostgreSQL does not write, so both adapters have to convert - the
   * reference in `normalize_money` and `normalize_timez`, this one in
   * `type-map.ts`.
   */
  describe('intended divergences', () => {
    it('money below zero: the reference loses the minus sign', async () => {
      // normalize_money is text.slice(1) over the server's `-$0.05`, so it
      // takes the sign rather than the symbol - a DecimalError in Prisma.
      const r = await both(`select '-0.05'::money as v`);
      expect(r.ourValue).toStrictEqual('-0.05');
      expect(r.theirValue).toStrictEqual('$0.05');
    });

    it('money at four figures: the reference leaves the separators in', async () => {
      const r = await both(`select '1234.50'::money as v`);
      expect(r.ourValue).toStrictEqual('1234.5');
      expect(r.theirValue).toStrictEqual('1,234.50');
    });

    it('timetz: we move the clock to UTC, the reference only drops the offset', async () => {
      // Prisma appends a `Z` to a Time on both paths it reads one -
      // deserializeRawResults.ts:29-31 for $queryRaw, and normalizeDateTime
      // for a model read, which appends it when it finds no offset. So the
      // value handed over has to already be at UTC.
      //
      // Measured end to end on a `DateTime @db.Timetz` field holding
      // 10:20:30+03, the instant 07:20:30Z, before this conversion existed:
      //
      //                        model read    $queryRaw
      //   @prisma/adapter-pg   10:20:30Z     10:20:30Z      <- out by 3h
      //   prisma-postgrejs     07:20:30Z     Invalid Date
      //
      // normalize_timez keeps the wall clock and drops the offset, so
      // 10:20:30+03 and 10:20:30-05 become the same value. Moving to UTC
      // first is right on both paths.
      const r = await both(`select '10:20:30+03'::timetz as v`);
      expect(r.ourValue).toStrictEqual('07:20:30');
      expect(r.theirValue).toStrictEqual('10:20:30');
      expect(r.ourTypes).toStrictEqual(r.theirTypes);
    });

    it('two statements in one executeRaw: we refuse, the reference runs them', async () => {
      // Prisma's contract puts scripts on a different method: executeRaw is
      // "Execute a query" and executeScript is "Execute multiple SQL statements
      // separated by semicolon" (driver-adapter-utils@7.10.0 index.d.ts:297,
      // :324). The reference takes a script here anyway because `pg` chooses
      // its protocol by whether the call had parameters - requiresPreparation()
      // is false without values (pg@8.23.0 lib/query.js:53-57), so it sends a
      // simple Query and PostgreSQL allows several commands in one. The same
      // statement silently loses its prepared statement and its per-statement
      // error boundary to get there. PostgreJS keeps query() on the extended
      // protocol and has execute() for scripts, so this one raises.
      const table = `t_multi_${Math.random().toString(36).slice(2, 8)}`;
      const sql = `create table "${table}"(a int); insert into "${table}" values(1)`;
      try {
        await expect(ours.executeRaw(sqlQuery(sql))).rejects.toMatchObject({
          cause: { kind: 'postgres', code: '42601' },
        });
        expect(await theirs.executeRaw(sqlQuery(sql))).toStrictEqual(0);
      } finally {
        await theirs
          .executeScript(`drop table if exists "${table}"`)
          .catch(() => undefined);
      }
    });

    it('executeScript is the way to run several, and it works', async () => {
      const table = `t_script_${Math.random().toString(36).slice(2, 8)}`;
      try {
        await ours.executeScript(
          `create table "${table}"(a int); insert into "${table}" values(1)`,
        );
        const r = await ours.queryRaw(sqlQuery(`select a from "${table}"`));
        expect(r.rows).toStrictEqual([[1]]);
      } finally {
        await ours
          .executeScript(`drop table if exists "${table}"`)
          .catch(() => undefined);
      }
    });

    it('char[]: the reference hands back the unparsed literal', async () => {
      // `pg` has no array parser registered for OID 1002, so the literal
      // leaks through as a string where the ColumnType promised an array.
      const r = await both(`select array['a'::"char"] as v`);
      expect(r.ourValue).toStrictEqual(['a']);
      expect(r.theirValue).toStrictEqual('{a}');
      expect(r.ourTypes).toStrictEqual(r.theirTypes);
    });

    it('timestamptz: we hand over the instant, the reference a rewritten string', async () => {
      // normalize_timestamptz replaces whatever offset the server sent with
      // +00:00 instead of converting, which is the wrong instant on any
      // session whose TimeZone is not UTC.
      const r = await both(
        `select '2024-01-02 10:20:30.123+00'::timestamptz as v`,
      );
      expect(r.ourValue).toStrictEqual('date:2024-01-02T10:20:30.123Z');
      expect(r.theirValue).toStrictEqual('2024-01-02T10:20:30.123+00:00');
      expect(r.ourTypes).toStrictEqual(r.theirTypes);
    });
  });

  describe('errors', () => {
    const cases: [string, string][] = [
      ['a missing table', 'select * from "NoSuchTable_C"'],
      ['a missing column', 'select nosuchcol_c from (select 1) t'],
      ['bad input syntax', `select 'zz'::int`],
      ['numeric overflow', `select 1e300::numeric(3,1)`],
    ];

    for (const [label, sql] of cases) {
      it(`maps ${label} the same way`, async () => {
        const of = async (a: SqlDriverAdapter) => {
          try {
            await a.queryRaw(sqlQuery(sql));
            return { kind: 'no error' };
          } catch (e) {
            const cause =
              (e as { cause?: Record<string, unknown> }).cause ?? {};
            return { kind: cause.kind, originalCode: cause.originalCode };
          }
        };
        expect(await of(ours)).toStrictEqual(await of(theirs));
      });
    }

    it('carries the column name, which needs the undecorated message', async () => {
      // PostgreJS appends a source excerpt to `message`; the anchored pattern
      // this maps with reads `serverMessage` instead, so the name survives.
      await expect(
        ours.queryRaw(sqlQuery('select nosuchcol_c from (select 1) t')),
      ).rejects.toMatchObject({
        cause: { kind: 'ColumnNotFound', column: 'nosuchcol_c' },
      });
    });
  });

  describe('connection info', () => {
    it('reports supportsRelationJoins the same way', () => {
      expect(ours.getConnectionInfo!().supportsRelationJoins).toStrictEqual(
        theirs.getConnectionInfo!().supportsRelationJoins,
      );
    });

    it('leaves maxBindValues unset, so the engine keeps its own default', () => {
      // Naming a lower one only makes the engine split IN lists into more
      // statements; PostgreSQL's real ceiling is 65535 parameters.
      expect(ours.getConnectionInfo!().maxBindValues).toStrictEqual(undefined);
    });
  });

  describe('executeRaw', () => {
    it('counts affected rows the same way', async () => {
      const table = `t_diff_${Math.random().toString(36).slice(2, 8)}`;
      await ours.executeScript(`create table "${table}"(n int)`);
      try {
        const insert = sqlQuery(`insert into "${table}" values(1),(2),(3)`);
        expect(await ours.executeRaw(insert)).toStrictEqual(
          await theirs.executeRaw(insert),
        );
        const update = sqlQuery(`update "${table}" set n = n + 1`);
        expect(await ours.executeRaw(update)).toStrictEqual(
          await theirs.executeRaw(update),
        );
      } finally {
        await ours.executeScript(`drop table "${table}"`);
      }
    });

    it('answers 0 for a statement that changes nothing', async () => {
      const select = sqlQuery('select 1');
      expect(await ours.executeRaw(select)).toStrictEqual(
        await theirs.executeRaw(select),
      );
    });
  });
});
