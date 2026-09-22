import { ColumnTypeEnum } from '@prisma/driver-adapter-utils';
import { expect } from 'expect';
import { DataTypeOIDs } from 'postgrejs';
import {
  fieldToColumnType,
  UnsupportedColumnType,
} from '../../src/column-types.js';

/**
 * The table below is not a restatement of the switch - it is what
 * `@prisma/adapter-pg@7.10.0` was measured to answer for the same OID, over 74
 * scalar and array types. Prisma decides how to convert a value from this, so a
 * `ColumnType` that disagrees with what `queryRaw` returned is silent wrong
 * data rather than an error, and that is why it is pinned here rather than left
 * to `test/C-differential`.
 */
describe('fieldToColumnType()', () => {
  const scalars: [keyof typeof DataTypeOIDs, number][] = [
    ['int2', ColumnTypeEnum.Int32],
    ['int4', ColumnTypeEnum.Int32],
    ['int8', ColumnTypeEnum.Int64],
    ['oid', ColumnTypeEnum.Int64],
    ['float4', ColumnTypeEnum.Float],
    ['float8', ColumnTypeEnum.Double],
    ['numeric', ColumnTypeEnum.Numeric],
    ['money', ColumnTypeEnum.Numeric],
    ['bool', ColumnTypeEnum.Boolean],
    ['date', ColumnTypeEnum.Date],
    ['time', ColumnTypeEnum.Time],
    ['timetz', ColumnTypeEnum.Time],
    ['timestamp', ColumnTypeEnum.DateTime],
    ['timestamptz', ColumnTypeEnum.DateTime],
    ['json', ColumnTypeEnum.Json],
    ['jsonb', ColumnTypeEnum.Json],
    ['uuid', ColumnTypeEnum.Uuid],
    ['bytea', ColumnTypeEnum.Bytes],
    ['bpchar', ColumnTypeEnum.Text],
    ['text', ColumnTypeEnum.Text],
    ['varchar', ColumnTypeEnum.Text],
    ['name', ColumnTypeEnum.Text],
    ['bit', ColumnTypeEnum.Text],
    ['varbit', ColumnTypeEnum.Text],
    ['inet', ColumnTypeEnum.Text],
    ['cidr', ColumnTypeEnum.Text],
    ['xml', ColumnTypeEnum.Text],
  ];

  const arrays: [keyof typeof DataTypeOIDs, number][] = [
    ['_int2', ColumnTypeEnum.Int32Array],
    ['_int4', ColumnTypeEnum.Int32Array],
    ['_int8', ColumnTypeEnum.Int64Array],
    ['_oid', ColumnTypeEnum.Int64Array],
    ['_float4', ColumnTypeEnum.FloatArray],
    ['_float8', ColumnTypeEnum.DoubleArray],
    ['_numeric', ColumnTypeEnum.NumericArray],
    ['_money', ColumnTypeEnum.NumericArray],
    ['_bool', ColumnTypeEnum.BooleanArray],
    ['_char', ColumnTypeEnum.CharacterArray],
    ['_date', ColumnTypeEnum.DateArray],
    ['_time', ColumnTypeEnum.TimeArray],
    ['_timetz', ColumnTypeEnum.TimeArray],
    ['_timestamp', ColumnTypeEnum.DateTimeArray],
    ['_timestamptz', ColumnTypeEnum.DateTimeArray],
    ['_json', ColumnTypeEnum.JsonArray],
    ['_jsonb', ColumnTypeEnum.JsonArray],
    ['_uuid', ColumnTypeEnum.UuidArray],
    ['_bytea', ColumnTypeEnum.BytesArray],
    ['_bpchar', ColumnTypeEnum.TextArray],
    ['_text', ColumnTypeEnum.TextArray],
    ['_varchar', ColumnTypeEnum.TextArray],
    ['_name', ColumnTypeEnum.TextArray],
    ['_bit', ColumnTypeEnum.TextArray],
    ['_varbit', ColumnTypeEnum.TextArray],
    ['_inet', ColumnTypeEnum.TextArray],
    ['_cidr', ColumnTypeEnum.TextArray],
    ['_xml', ColumnTypeEnum.TextArray],
  ];

  for (const [name, expected] of [...scalars, ...arrays]) {
    it(`maps ${name}`, () => {
      expect(fieldToColumnType(DataTypeOIDs[name])).toStrictEqual(expected);
    });
  }

  /**
   * Prisma's `ColumnType` has no member for any of these, so both this adapter
   * and the reference one refuse the column rather than guess. Measured: 23 of
   * 74 types land here, and every one of PostgreJS's rich decoders -
   * `Interval`, `Range`, the geometric classes - decodes into this set.
   */
  const unsupported: [keyof typeof DataTypeOIDs, string][] = [
    ['char', 'char'],
    ['point', 'point'],
    ['lseg', 'lseg'],
    ['path', 'path'],
    ['box', 'box'],
    ['polygon', 'polygon'],
    ['line', 'line'],
    ['circle', 'circle'],
    ['macaddr', 'macaddr'],
    ['macaddr8', 'macaddr8'],
    ['interval', 'interval'],
    ['tsvector', 'tsvector'],
    ['pg_lsn', 'pg_lsn'],
    ['jsonpath', 'jsonpath'],
    ['int4range', 'int4range'],
    ['numrange', 'numrange'],
    ['tsrange', 'tsrange'],
    ['tstzrange', 'tstzrange'],
    ['daterange', 'daterange'],
    ['int8range', 'int8range'],
    ['_point', '_point'],
    ['_interval', '_interval'],
    ['_int4range', '_int4range'],
  ];

  for (const [name, typeName] of unsupported) {
    it(`refuses ${name}, which Prisma cannot carry`, () => {
      let thrown: unknown;
      try {
        fieldToColumnType(DataTypeOIDs[name]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(UnsupportedColumnType);
      expect((thrown as UnsupportedColumnType).typeName).toStrictEqual(
        typeName,
      );
      expect((thrown as UnsupportedColumnType).message).toStrictEqual(
        `Unsupported column type ${typeName}`,
      );
    });
  }

  it('reads an enum, a composite or an extension type as text', () => {
    // Anything at or above 16384 was created rather than shipped, and Prisma
    // has no way to describe it beyond text. `unknownTypesAsString` is what
    // makes the value actually be a string by then.
    expect(fieldToColumnType(16384)).toStrictEqual(ColumnTypeEnum.Text);
    expect(fieldToColumnType(999999)).toStrictEqual(ColumnTypeEnum.Text);
  });

  it('names an unmapped built-in it has no name for', () => {
    // 2249 is `record`; there is no entry for it, and the error still has to
    // say something rather than print a number.
    expect(() => fieldToColumnType(2249)).toThrow('Unsupported column type');
  });
});
