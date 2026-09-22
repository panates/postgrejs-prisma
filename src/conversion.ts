import { DataTypeOIDs, type OID } from 'postgrejs';

/**
 * The OIDs whose columns are asked for as the server's own text.
 *
 * **This is the only place the adapter influences a value**, and it does it by
 * choosing a wire format rather than by touching what comes back: nothing in
 * `src/` walks a result row. These are the types whose decoded form Prisma
 * would reject outright or silently round, and whose text form it takes
 * exactly as written.
 *
 * - `int8`: a number loses precision past 2^53 and a BigInt is rejected.
 * - `numeric`: a double cannot carry what the column can.
 * - `json`, `jsonb`: Prisma wants the text and refuses a parsed object.
 * - `time`: a `Date` element of a `time[]` reads back as null.
 *
 * Asking for text is not free - a bigger payload, and the binary decoders are
 * faster than not decoding - so it is used only where it is the answer.
 *
 * **Naming an element's OID covers the array too.** `int8` here asks for the
 * elements of an `int8[]` column as strings, an array with its nulls intact,
 * rather than for the array literal in one string, which is what naming
 * `_int8` would do.
 *
 * Two types Prisma also wants in a shape of its own are **not** here, because
 * asking the server for text produces the wrong shape rather than the right
 * one - the server writes `-$1,234.50` for a `money` under `lc_monetary`, and
 * keeps the offset on a `timetz`. Both are converted from the decoded value
 * instead, by a decoder in `type-map.ts`, and a column asked for as text never
 * reaches one.
 */
export function fetchAsString(): OID[] {
  return [
    DataTypeOIDs.int8,
    DataTypeOIDs.numeric,
    DataTypeOIDs.json,
    DataTypeOIDs.jsonb,
    DataTypeOIDs.time,
  ];
}
