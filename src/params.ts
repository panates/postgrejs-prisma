import type { ArgType } from '@prisma/driver-adapter-utils';

/**
 * Turns one of Prisma's argument values into something PostgreSQL will accept.
 *
 * There is very little to do, because Prisma has already rendered everything to
 * a primitive by the time the adapter sees it. Measured over every
 * `(scalarType, dbType, arity)` triple a schema covering all of Prisma's scalar
 * and list types produces - 28 of them:
 *
 * | scalarType | arrives as |
 * | --- | --- |
 * | `string`, `enum`, `uuid` | `string` |
 * | `int` | `number` |
 * | `bigint` | **`string`** |
 * | `decimal` | **`string`**, or `number` for `DOUBLEPRECISION` |
 * | `boolean` | `boolean` |
 * | `json` | **`string`** |
 * | `bytes` | **base64 `string`** |
 * | `datetime` | `Date` |
 * | `unknown` | an empty list |
 *
 * So only two conversions are left: a `Date` has to be written the way the
 * column wants it, and base64 has to become bytes. Everything else goes out
 * untouched, with no declared type, and the server resolves it from the
 * column - which is what `pg` does too.
 *
 * **Naming the OID from `argTypes` was measured and rejected.** Wrapping values
 * in `new BindParam(oid, value)` drives PostgreJS's typed encoders, which are
 * stricter than the server's own text parser: a `datetime`/`TIMETZ` parameter
 * arrives as a `Date`, is written as `10:20:30.123`, and the `timetz` encoder
 * refuses it for having no offset. Declaring a type can only reject values the
 * server would have taken, since Prisma's values are already rendered for it.
 */
export function mapArg(arg: unknown, argType: ArgType | undefined): unknown {
  if (arg === null || arg === undefined) return null;

  if (Array.isArray(arg) && argType?.arity === 'list') {
    return arg.map(value => mapArg(value, argType));
  }

  let value = arg;
  if (typeof value === 'string' && argType?.scalarType === 'datetime') {
    value = new Date(value);
  }

  if (value instanceof Date) {
    switch (argType?.dbType) {
      case 'TIME':
      case 'TIMETZ':
        return formatTime(value);
      case 'DATE':
        return formatDate(value);
      default:
        return `${formatDate(value)} ${formatTime(value)}`;
    }
  }

  if (typeof value === 'string' && argType?.scalarType === 'bytes') {
    return Buffer.from(value, 'base64');
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  return value;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function formatDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function formatTime(d: Date): string {
  const ms = d.getUTCMilliseconds();
  return (
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    (ms ? `.${pad(ms, 3)}` : '')
  );
}
