import { ColumnTypeEnum } from '@prisma/driver-adapter-utils';
import { expect } from 'expect';
import { type LiveAdapter, openLiveAdapter } from '../_support/live.js';

/**
 * What each type actually comes back as, against a real server, as an explicit
 * table of expected values.
 *
 * `test/C-differential` proves these agree with `@prisma/adapter-pg` where they
 * should; this file is what says *what* the value is, so a change of shape is
 * visible here rather than only as a disagreement with another package.
 */
describe('B-live: value representations', () => {
  let live: LiveAdapter;

  before(async () => {
    live = await openLiveAdapter();
  });

  after(async () => {
    await live?.close();
  });

  /** [label, SQL expression, expected ColumnType, expected value] */
  const cases: [string, string, number, unknown][] = [
    ['bool', `true::bool`, ColumnTypeEnum.Boolean, true],
    ['int2', `12::int2`, ColumnTypeEnum.Int32, 12],
    ['int4', `34::int4`, ColumnTypeEnum.Int32, 34],
    ['float4', `1.5::float4`, ColumnTypeEnum.Float, 1.5],
    ['float8', `1.5::float8`, ColumnTypeEnum.Double, 1.5],
    ['text', `'txt'::text`, ColumnTypeEnum.Text, 'txt'],
    ['varchar', `'vc'::varchar`, ColumnTypeEnum.Text, 'vc'],
    ['bpchar', `'ab'::bpchar`, ColumnTypeEnum.Text, 'ab'],
    ['name', `'nm'::name`, ColumnTypeEnum.Text, 'nm'],
    ['bit', `B'101'::bit(3)`, ColumnTypeEnum.Text, '101'],
    ['varbit', `B'101'::varbit`, ColumnTypeEnum.Text, '101'],
    ['inet', `'10.0.0.1'::inet`, ColumnTypeEnum.Text, '10.0.0.1'],
    ['cidr', `'10.0.0.0/8'::cidr`, ColumnTypeEnum.Text, '10.0.0.0/8'],
    ['xml', `'<a/>'::xml`, ColumnTypeEnum.Text, '<a/>'],
    [
      'uuid',
      `'00000000-0000-0000-0000-000000000001'::uuid`,
      ColumnTypeEnum.Uuid,
      '00000000-0000-0000-0000-000000000001',
    ],
    // int8 past 2^53: a number would round it and a BigInt is refused, so the
    // only representation left is the server's own text.
    [
      'int8',
      `9007199254740993::int8`,
      ColumnTypeEnum.Int64,
      '9007199254740993',
    ],
    ['oid', `42::oid`, ColumnTypeEnum.Int64, 42],
    // numeric likewise - a double cannot carry what the column can.
    [
      'numeric',
      `1234567890123456789.12::numeric`,
      ColumnTypeEnum.Numeric,
      '1234567890123456789.12',
    ],
    // json/jsonb are handed over as text: Prisma refuses a parsed object.
    ['json', `'{"a":1}'::json`, ColumnTypeEnum.Json, '{"a":1}'],
    ['jsonb', `'{"a": 1}'::jsonb`, ColumnTypeEnum.Json, '{"a": 1}'],
    // timetz is moved to UTC and the offset removed - Prisma appends a `Z` of
    // its own on both the raw and the model path, so a value already at UTC
    // reads back as the right instant on either. The reference adapter drops
    // the offset without moving the clock, which is the wrong instant on any
    // offset but zero. See type-map.ts and test/C-differential.
    ['timetz', `'10:20:30+00'::timetz`, ColumnTypeEnum.Time, '10:20:30'],
    ['timetz at +03', `'10:20:30+03'::timetz`, ColumnTypeEnum.Time, '07:20:30'],
    ['timetz at -05', `'01:02:03-05'::timetz`, ColumnTypeEnum.Time, '06:02:03'],
    // The shift wraps within the day: a timetz has no date to carry into.
    [
      'timetz wrapping',
      `'01:00:00+03'::timetz`,
      ColumnTypeEnum.Time,
      '22:00:00',
    ],
    // `time` is asked for as text rather than decoded: it is what the engine
    // wants, `DateStyle` cannot reach a time of day, and naming the OID here
    // covers `time[]` too.
    ['time', `'10:20:30'::time`, ColumnTypeEnum.Time, '10:20:30'],
  ];

  for (const [label, expr, columnType, expected] of cases) {
    it(`reads ${label}`, async () => {
      const result = await live.query(`select ${expr} as v`);
      expect(result.columnNames).toStrictEqual(['v']);
      expect(result.columnTypes).toStrictEqual([columnType]);
      expect(result.rows[0][0]).toStrictEqual(expected);
    });
  }

  it('reads bytea as bytes', async () => {
    const v = (await live.one(`select '\\x0102'::bytea as v`)) as Buffer;
    expect(Buffer.isBuffer(v) || v instanceof Uint8Array).toStrictEqual(true);
    expect([...v]).toStrictEqual([1, 2]);
  });

  /**
   * Prisma's `Decimal` needs a plain decimal string; PostgreJS hands over a
   * number - exact, and promoted to a string at the int64 extremes - and the
   * server's own text is `-$1,234.50` under `lc_monetary`, which is a
   * rendering for a human rather than a number. `String()` on the decoded
   * value is exact for everything the column can hold, which is why the
   * conversion belongs here: see type-map.ts.
   *
   * The reference adapter starts from the server's text instead and does
   * `text.slice(1)`, so every negative and every four-figure value throws
   * `DecimalError` in Prisma + `@prisma/adapter-pg`. Asserted in
   * test/C-differential.
   */
  describe('money', () => {
    const money: [string, string][] = [
      ['12.34', '12.34'],
      ['-0.05', '-0.05'],
      // No trailing zero: the conversion runs on the decoded number, and the
      // column's scale is the server's to know. It makes no difference to
      // Prisma, whose Decimal reads `1234.5` and `1234.50` as the same value.
      ['1234.50', '1234.5'],
      ['-1234.50', '-1234.5'],
      ['92233720368547758.07', '92233720368547758.07'],
      ['-92233720368547758.08', '-92233720368547758.08'],
    ];

    for (const [input, expected] of money) {
      it(`reads ${input} as an exact decimal string`, async () => {
        const result = await live.query(`select '${input}'::money as v`);
        expect(result.columnTypes).toStrictEqual([ColumnTypeEnum.Numeric]);
        expect(result.rows[0][0]).toStrictEqual(expected);
      });
    }
  });

  describe('temporal types, decoded from the binary form', () => {
    it('reads timestamp as a Date at the wall clock the column holds', async () => {
      const v = await live.one(
        `select '2024-01-02 10:20:30.123'::timestamp as v`,
      );
      expect(v).toBeInstanceOf(Date);
      expect((v as Date).toISOString()).toStrictEqual(
        '2024-01-02T10:20:30.123Z',
      );
    });

    it('reads timestamptz as the instant, whatever the session zone', async () => {
      const v = await live.one(
        `select '2024-01-02 10:20:30.123+00'::timestamptz as v`,
      );
      expect((v as Date).toISOString()).toStrictEqual(
        '2024-01-02T10:20:30.123Z',
      );
    });

    it('reads date as midnight UTC', async () => {
      const v = await live.one(`select '2024-01-02'::date as v`);
      expect((v as Date).toISOString()).toStrictEqual(
        '2024-01-02T00:00:00.000Z',
      );
    });
  });

  describe('arrays', () => {
    it('reads int4[] as numbers', async () => {
      expect(await live.one(`select array[1,2]::int4[] as v`)).toStrictEqual([
        1, 2,
      ]);
    });

    it('reads text[] as strings, keeping a quoted empty element', async () => {
      expect(await live.one(`select array['','b']::text[] as v`)).toStrictEqual(
        ['', 'b'],
      );
    });

    it('stringifies int8[] element by element, where a BigInt would be refused', async () => {
      expect(
        await live.one(`select array[9007199254740993::int8] as v`),
      ).toStrictEqual(['9007199254740993']);
    });

    it('stringifies numeric[], where a number would lose precision', async () => {
      expect(
        await live.one(`select array[1234567890123456789.12::numeric] as v`),
      ).toStrictEqual(['1234567890123456789.12']);
    });

    // money[] needs no rule of its own: an array inherits its element's
    // decoder from the type map.
    it('stringifies money[]', async () => {
      expect(
        await live.one(`select array['1.00'::money,'-2.50'::money] as v`),
      ).toStrictEqual(['1', '-2.5']);
    });

    it('reads jsonb[] as the server wrote it, where a parsed object would be refused', async () => {
      // The elements come back as text from the wire, so the whitespace is
      // PostgreSQL's own rather than a re-serialization of a parsed object.
      expect(
        await live.one(`select array['{"a":1}'::jsonb] as v`),
      ).toStrictEqual(['{"a": 1}']);
    });

    it('reads time[] as times of day, where a Date element would read as null', async () => {
      expect(
        await live.one(`select array['10:20:30'::time, null] as v`),
      ).toStrictEqual(['10:20:30', null]);
    });

    it('keeps a null element', async () => {
      expect(
        await live.one(`select array[1::int8, null::int8] as v`),
      ).toStrictEqual(['1', null]);
    });

    it('reads char[] as an array, which the reference adapter leaves as a literal', async () => {
      expect(await live.one(`select array['a'::"char"] as v`)).toStrictEqual([
        'a',
      ]);
    });
  });

  /**
   * Prisma's `ColumnType` has no member for these, so the column is refused
   * rather than guessed at. Every one is a type PostgreJS decodes richly -
   * which is the measured reason none of that richness reaches a Prisma user.
   */
  describe('types Prisma cannot carry', () => {
    const refused = [
      ['interval', `'1 day'::interval`],
      ['point', `'(1,2)'::point`],
      ['circle', `'<(1,2),3>'::circle`],
      ['int4range', `'[1,5)'::int4range`],
      ['tsvector', `'a b'::tsvector`],
      ['macaddr', `'01:02:03:04:05:06'::macaddr`],
      ['"char"', `'a'::"char"`],
    ];

    for (const [label, expr] of refused) {
      it(`refuses ${label} with UnsupportedNativeDataType`, async () => {
        await expect(live.query(`select ${expr} as v`)).rejects.toMatchObject({
          cause: { kind: 'UnsupportedNativeDataType' },
        });
      });
    }
  });

  /**
   * Every type whose representation Prisma is particular about, with a null in
   * it. A null takes the branch a conversion does not, and anything that
   * assumed a value would turn it into `"null"` or throw - which is as true of
   * a decoder inside the client as it was of the pass over rows this package
   * no longer has.
   *
   */
  describe('nulls through the converted types', () => {
    const nulls: [string, string, unknown][] = [
      ['money', `null::money`, null],
      ['money[]', `array['1.00'::money, null]`, ['1', null]],
      ['timetz', `null::timetz`, null],
      ['timetz[]', `array['10:20:30+03'::timetz, null]`, ['07:20:30', null]],
      ['time[]', `array['10:20:30'::time, null]`, ['10:20:30', null]],
      ['timestamp', `null::timestamp`, null],
      ['int8[]', `array[1::int8, null]`, ['1', null]],
      ['numeric[]', `array[1.5::numeric, null]`, ['1.5', null]],
      ['jsonb[]', `array['{"a":1}'::jsonb, null]`, ['{"a": 1}', null]],
    ];

    for (const [label, expr, expected] of nulls) {
      it(`reads ${label}`, async () => {
        expect(await live.one(`select ${expr} as v`)).toStrictEqual(expected);
      });
    }
  });

  it('reads an enum as text, which needs unknownTypesAsString', async () => {
    const name = `e_${Math.random().toString(36).slice(2, 8)}`;
    await live.adapter.executeScript(
      `create type ${name} as enum ('RED','BLUE')`,
    );
    try {
      const result = await live.query(`select 'RED'::${name} as v`);
      expect(result.columnTypes).toStrictEqual([ColumnTypeEnum.Text]);
      expect(result.rows[0][0]).toStrictEqual('RED');
    } finally {
      await live.adapter.executeScript(`drop type ${name}`);
    }
  });
});
