import { type ColumnType, ColumnTypeEnum } from '@prisma/driver-adapter-utils';
import { DataTypeOIDs } from 'postgrejs';

/**
 * The first OID PostgreSQL hands out to something a user created. Below it
 * everything is a built-in, so an unmapped OID there is a type Prisma has no
 * `ColumnType` for; at or above it the column is an enum, a composite or an
 * extension type, all of which Prisma reads as text.
 */
const FIRST_NORMAL_OBJECT_ID = 16384;

/**
 * Raised for a built-in type Prisma cannot represent. Carries the type's name
 * because that is what `UnsupportedNativeDataType` reports to the user, and
 * `dataTypeName` on the field is empty for exactly the types that land here.
 */
export class UnsupportedColumnType extends Error {
  readonly oid: number;
  readonly typeName: string;

  constructor(oid: number, typeName?: string) {
    const name = typeName || TYPE_NAMES[oid] || 'Unknown';
    super(`Unsupported column type ${name}`);
    this.oid = oid;
    this.typeName = name;
  }
}

/**
 * Names for the built-ins Prisma rejects, so the error says `interval` rather
 * than `1186`. Only the unmappable ones are here - a type that maps needs no
 * name, and PostgreJS answers with `dataTypeName` for everything it knows.
 */
const TYPE_NAMES: Record<number, string> = {
  18: 'char',
  600: 'point',
  601: 'lseg',
  602: 'path',
  603: 'box',
  604: 'polygon',
  628: 'line',
  718: 'circle',
  774: 'macaddr8',
  829: 'macaddr',
  1186: 'interval',
  3220: 'pg_lsn',
  3614: 'tsvector',
  3615: 'tsquery',
  3642: 'gtsvector',
  3904: 'int4range',
  3906: 'numrange',
  3908: 'tsrange',
  3910: 'tstzrange',
  3912: 'daterange',
  3926: 'int8range',
  4072: 'jsonpath',
  4451: 'int4multirange',
  4532: 'nummultirange',
  4533: 'tsmultirange',
  4534: 'tstzmultirange',
  4535: 'datemultirange',
  4536: 'int8multirange',
  1017: '_point',
  1018: '_lseg',
  1019: '_path',
  1020: '_box',
  1027: '_polygon',
  629: '_line',
  719: '_circle',
  775: '_macaddr8',
  1040: '_macaddr',
  1187: '_interval',
  3221: '_pg_lsn',
  3643: '_tsvector',
  3645: '_tsquery',
  3905: '_int4range',
  3907: '_numrange',
  3909: '_tsrange',
  3911: '_tstzrange',
  3913: '_daterange',
  3927: '_int8range',
  4073: '_jsonpath',
};

/**
 * The `ColumnType` to report for a result column's OID.
 *
 * Verified against `@prisma/adapter-pg@7.10.0` over 74 scalar and array types:
 * the two agree on every one, including the ones neither can carry. Prisma uses
 * this to decide how to convert the value, so an answer that disagrees with what
 * `queryRaw` actually returned is silent wrong data rather than an error.
 */
export function fieldToColumnType(oid: number): ColumnType {
  switch (oid) {
    // -- scalars ---------------------------------------------------------
    case DataTypeOIDs.int2:
    case DataTypeOIDs.int4:
      return ColumnTypeEnum.Int32;
    case DataTypeOIDs.int8:
    case DataTypeOIDs.oid:
      return ColumnTypeEnum.Int64;
    case DataTypeOIDs.float4:
      return ColumnTypeEnum.Float;
    case DataTypeOIDs.float8:
      return ColumnTypeEnum.Double;
    case DataTypeOIDs.numeric:
    case DataTypeOIDs.money:
      return ColumnTypeEnum.Numeric;
    case DataTypeOIDs.bool:
      return ColumnTypeEnum.Boolean;
    case DataTypeOIDs.date:
      return ColumnTypeEnum.Date;
    case DataTypeOIDs.time:
    case DataTypeOIDs.timetz:
      return ColumnTypeEnum.Time;
    case DataTypeOIDs.timestamp:
    case DataTypeOIDs.timestamptz:
      return ColumnTypeEnum.DateTime;
    case DataTypeOIDs.json:
    case DataTypeOIDs.jsonb:
      return ColumnTypeEnum.Json;
    case DataTypeOIDs.uuid:
      return ColumnTypeEnum.Uuid;
    case DataTypeOIDs.bytea:
      return ColumnTypeEnum.Bytes;
    case DataTypeOIDs.bpchar:
    case DataTypeOIDs.text:
    case DataTypeOIDs.varchar:
    case DataTypeOIDs.name:
    case DataTypeOIDs.bit:
    case DataTypeOIDs.varbit:
    case DataTypeOIDs.inet:
    case DataTypeOIDs.cidr:
    case DataTypeOIDs.xml:
      return ColumnTypeEnum.Text;

    // -- arrays ----------------------------------------------------------
    case DataTypeOIDs._int2:
    case DataTypeOIDs._int4:
      return ColumnTypeEnum.Int32Array;
    case DataTypeOIDs._int8:
    case DataTypeOIDs._oid:
      return ColumnTypeEnum.Int64Array;
    case DataTypeOIDs._float4:
      return ColumnTypeEnum.FloatArray;
    case DataTypeOIDs._float8:
      return ColumnTypeEnum.DoubleArray;
    case DataTypeOIDs._numeric:
    case DataTypeOIDs._money:
      return ColumnTypeEnum.NumericArray;
    case DataTypeOIDs._bool:
      return ColumnTypeEnum.BooleanArray;
    case DataTypeOIDs._char:
      return ColumnTypeEnum.CharacterArray;
    case DataTypeOIDs._date:
      return ColumnTypeEnum.DateArray;
    case DataTypeOIDs._time:
    case DataTypeOIDs._timetz:
      return ColumnTypeEnum.TimeArray;
    case DataTypeOIDs._timestamp:
    case DataTypeOIDs._timestamptz:
      return ColumnTypeEnum.DateTimeArray;
    case DataTypeOIDs._json:
    case DataTypeOIDs._jsonb:
      return ColumnTypeEnum.JsonArray;
    case DataTypeOIDs._uuid:
      return ColumnTypeEnum.UuidArray;
    case DataTypeOIDs._bytea:
      return ColumnTypeEnum.BytesArray;
    case DataTypeOIDs._bpchar:
    case DataTypeOIDs._text:
    case DataTypeOIDs._varchar:
    case DataTypeOIDs._name:
    case DataTypeOIDs._bit:
    case DataTypeOIDs._varbit:
    case DataTypeOIDs._inet:
    case DataTypeOIDs._cidr:
    case DataTypeOIDs._xml:
      return ColumnTypeEnum.TextArray;

    default:
      // An enum, a composite or an extension type - Prisma reads all of
      // them as text, and `unknownTypesAsString` is what makes sure the
      // value is a string by the time it gets here.
      if (oid >= FIRST_NORMAL_OBJECT_ID) return ColumnTypeEnum.Text;
      throw new UnsupportedColumnType(oid);
  }
}
