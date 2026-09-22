import {
  type DataType,
  DataTypeMap,
  DataTypeOIDs,
  GlobalTypeMap,
} from 'postgrejs';

/**
 * The two types Prisma wants in a representation PostgreSQL does not write.
 *
 * **This is the adapter's job, not the driver's.** PostgreSQL's text for a
 * `money` is `-$1,234.50` and for a `timetz` is `10:20:30+03`; Prisma's
 * deserializer takes neither. That is a choice Prisma made about how it
 * carries values, not a gap in the client - `pg` hands back exactly the same
 * two strings, and `@prisma/adapter-pg` converts them in its own code
 * (`normalize_money`, `normalize_timez`). Bending PostgreJS to Prisma's
 * expectations would push a Prisma-shaped decision onto every other caller.
 *
 * Doing it in a `DataTypeMap` rather than by walking the result rows is the
 * point: `DataTypeMap` is the extension point PostgreJS provides for exactly
 * this, the conversion happens once inside the decoder instead of as a second
 * pass over every cell, and an array column gets it from its element type
 * rather than needing a rule of its own. **Nothing in `src/` walks a row.**
 */
export function buildTypeMap(): DataTypeMap {
  const map = new DataTypeMap(GlobalTypeMap);

  /**
   * `money`: PostgreJS decodes it to a number, or to a string when a double
   * cannot carry it, and both are exact. Prisma's `Decimal` wants a plain
   * decimal string - and it cannot take the server's own rendering, which is
   * `-$1,234.50` under `lc_monetary`. `String()` on the decoded value is exact
   * for every value the column can hold, including the int64 extremes.
   *
   * `@prisma/adapter-pg` starts from the server's text instead and does
   * `text.slice(1)`, which takes the minus sign off every negative value and
   * leaves the separators in - so every negative and every four-figure `money`
   * value throws `DecimalError` there.
   */
  register(map, DataTypeOIDs.money, DataTypeOIDs._money, decoded =>
    decoded == null ? decoded : String(decoded),
  );

  /**
   * `timetz`: the offset has to come off, because Prisma appends its own `Z` -
   * but the time has to be moved to UTC first, which is the part the reference
   * adapter skips.
   *
   * Prisma reads a `Time` in two places and both end up appending `Z` to
   * whatever they are given: `deserializeRawResults.ts:29-31` on the `$queryRaw`
   * path, and `client-engine-runtime`'s `normalizeDateTime` on a model read,
   * which appends it when it finds no offset. So a value carrying no offset and
   * already at UTC is read as the right instant on both.
   *
   * `normalize_timez` in `@prisma/adapter-pg` is
   * `time.replace(/[+-]\d{2}(:\d{2})?$/, '')` - it drops the offset and keeps
   * the local wall clock, so `10:20:30+03` is read back as `10:20:30Z` rather
   * than `07:20:30Z`. Measured over four offsets, that is wrong in three of
   * them; `10:20:30+03` and `10:20:30-05` also become the same value.
   */
  register(map, DataTypeOIDs.timetz, DataTypeOIDs._timetz, decoded =>
    typeof decoded === 'string' ? timeAtUtc(decoded) : decoded,
  );

  return map;
}

const TIMETZ =
  /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-])(\d{2})(?::(\d{2}))?(?::\d{2})?$/;

/**
 * `10:20:30+03` -> `07:20:30`: the same instant, written at UTC, with the
 * offset removed because Prisma supplies one of its own.
 *
 * A `timetz` has no date, so the shift wraps within the day - which is what
 * PostgreSQL itself does with the type, and why it advises against using it.
 * Anything that does not match is handed back untouched rather than guessed
 * at; the only way to get here is a value the server did not write.
 */
function timeAtUtc(value: string): string {
  const parts = TIMETZ.exec(value);
  if (!parts) return value;
  const [, hh, mm, ss, fraction, sign, offsetHours, offsetMinutes] = parts;
  const offset =
    (Number(offsetHours) * 60 + Number(offsetMinutes ?? 0)) *
    (sign === '+' ? 1 : -1);
  const minutes =
    (((Number(hh) * 60 + Number(mm) - offset) % 1440) + 1440) % 1440;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${ss}${fraction ?? ''}`;
}

/**
 * Wraps a registered type's decoders, and registers the array form alongside
 * it so a `money[]` column is covered by the same rule its element is.
 */
function register(
  map: DataTypeMap,
  oid: number,
  arrayOid: number,
  convert: (decoded: unknown) => unknown,
): void {
  const base = map.get(oid);
  const scalar: DataType = {
    ...base,
    decodeBinary: (...args) => convert(base.decodeBinary(...args)),
    decodeText: (...args) => convert(base.decodeText(...args)),
  };
  const array: DataType = {
    ...scalar,
    name: `_${base.name}`,
    oid: arrayOid,
    elementsOID: oid,
    isArray: true,
  };
  map.register([scalar, array]);
}
