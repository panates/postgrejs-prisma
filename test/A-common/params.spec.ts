import type { ArgType } from '@prisma/driver-adapter-utils';
import { expect } from 'expect';
import { mapArg } from '../../src/params.js';

const arg = (
  scalarType: ArgType['scalarType'],
  dbType?: string,
  arity: ArgType['arity'] = 'scalar',
): ArgType => ({ scalarType, dbType, arity });

/**
 * Every `(scalarType, dbType, arity)` triple below was observed coming out of a
 * real `PrismaClient` over a schema covering all of Prisma's scalar and list
 * types - 28 of them, plus `unknown` for an empty list. The point of the table
 * is that it is the whole input space: Prisma has already rendered `bigint`,
 * `decimal`, `json` and `bytes` to strings by the time the adapter sees them,
 * so there is nothing left to infer.
 */
describe('mapArg()', () => {
  describe('passes through what Prisma has already rendered', () => {
    const untouched: [string, ArgType, unknown][] = [
      ['string/TEXT', arg('string', 'TEXT'), 'str'],
      ['string/VARCHAR', arg('string', 'VARCHAR'), 'vc'],
      [
        'string/UUID',
        arg('string', 'UUID'),
        '00000000-0000-0000-0000-000000000001',
      ],
      ['enum (no dbType)', arg('string'), 'RED'],
      ['int/INTEGER', arg('int', 'INTEGER'), 42],
      [
        'bigint/BIGINT as a string',
        arg('bigint', 'BIGINT'),
        '9007199254740993',
      ],
      [
        'decimal/DECIMAL as a string',
        arg('decimal', 'DECIMAL'),
        '1234567890123456.1234',
      ],
      [
        'decimal/DOUBLEPRECISION as a number',
        arg('decimal', 'DOUBLEPRECISION'),
        1.5,
      ],
      ['boolean/BOOLEAN', arg('boolean', 'BOOLEAN'), true],
      ['json/JSONB as a string', arg('json', 'JSONB'), '{"a":1}'],
    ];

    for (const [label, argType, value] of untouched) {
      it(label, () => {
        expect(mapArg(value, argType)).toStrictEqual(value);
      });
    }
  });

  describe('null', () => {
    it('maps null to null', () => {
      expect(mapArg(null, arg('string', 'TEXT'))).toStrictEqual(null);
    });

    it('maps undefined to null, so the server sees a bind rather than nothing', () => {
      expect(mapArg(undefined, arg('string', 'TEXT'))).toStrictEqual(null);
    });

    it('maps null inside a list', () => {
      expect(mapArg([null, 'a'], arg('string', 'TEXT', 'list'))).toStrictEqual([
        null,
        'a',
      ]);
    });
  });

  /**
   * A `Date` is the only value Prisma does not pre-render, and `dbType` is the
   * only reason the adapter needs `argTypes` at all: the same `Date` has to be
   * written three different ways depending on the column.
   */
  describe('datetime, the one value that needs dbType', () => {
    const d = new Date('2024-03-05T06:07:08.900Z');

    it('writes TIMESTAMP as a date and a time', () => {
      expect(mapArg(d, arg('datetime', 'TIMESTAMP'))).toStrictEqual(
        '2024-03-05 06:07:08.900',
      );
    });

    it('writes TIMESTAMPTZ the same way, letting the column resolve it', () => {
      expect(mapArg(d, arg('datetime', 'TIMESTAMPTZ'))).toStrictEqual(
        '2024-03-05 06:07:08.900',
      );
    });

    it('writes DATE without the time', () => {
      expect(mapArg(d, arg('datetime', 'DATE'))).toStrictEqual('2024-03-05');
    });

    it('writes TIME without the date', () => {
      expect(mapArg(d, arg('datetime', 'TIME'))).toStrictEqual('06:07:08.900');
    });

    it('writes TIMETZ without the date', () => {
      expect(mapArg(d, arg('datetime', 'TIMETZ'))).toStrictEqual(
        '06:07:08.900',
      );
    });

    it('drops the fraction when there is none, rather than writing .000', () => {
      expect(
        mapArg(new Date('2024-03-05T06:07:08Z'), arg('datetime', 'TIMESTAMP')),
      ).toStrictEqual('2024-03-05 06:07:08');
    });

    it('reads UTC, not the local zone - the whole point of the format', () => {
      // Would be the previous or next day in any zone off UTC if it used
      // getFullYear() and friends.
      expect(
        mapArg(new Date('2024-03-05T23:30:00Z'), arg('datetime', 'DATE')),
      ).toStrictEqual('2024-03-05');
    });

    it('accepts an ISO string where a Date was expected', () => {
      expect(
        mapArg('2024-03-05T06:07:08.900Z', arg('datetime', 'DATE')),
      ).toStrictEqual('2024-03-05');
    });

    it('writes a year below 1000 with four digits', () => {
      expect(
        mapArg(new Date('0099-01-02T00:00:00Z'), arg('datetime', 'DATE')),
      ).toStrictEqual('0099-01-02');
    });

    it('maps a list of them element by element', () => {
      expect(
        mapArg([d, d], arg('datetime', 'TIMESTAMP', 'list')),
      ).toStrictEqual(['2024-03-05 06:07:08.900', '2024-03-05 06:07:08.900']);
    });
  });

  describe('bytes, which arrive base64-encoded', () => {
    it('decodes a base64 string to bytes', () => {
      const result = mapArg('AQID', arg('bytes', 'BYTEA'));
      expect(Buffer.isBuffer(result)).toStrictEqual(true);
      expect([...(result as Buffer)]).toStrictEqual([1, 2, 3]);
    });

    it('decodes each element of a list', () => {
      const result = mapArg(
        ['AQ=='],
        arg('bytes', 'BYTEA', 'list'),
      ) as Buffer[];
      expect(result).toHaveLength(1);
      expect([...result[0]]).toStrictEqual([1]);
    });

    it('passes a Buffer through as bytes', () => {
      const result = mapArg(Buffer.from([9]), arg('bytes', 'BYTEA'));
      expect([...(result as Buffer)]).toStrictEqual([9]);
    });

    it('copies a Uint8Array view without taking the whole buffer', () => {
      const whole = new Uint8Array([1, 2, 3, 4]);
      const view = whole.subarray(1, 3);
      const result = mapArg(view, arg('bytes', 'BYTEA')) as Buffer;
      expect([...result]).toStrictEqual([2, 3]);
    });
  });

  describe('lists', () => {
    it('maps a list of strings', () => {
      expect(mapArg(['a', 'b'], arg('string', 'TEXT', 'list'))).toStrictEqual([
        'a',
        'b',
      ]);
    });

    it('maps an empty list, which Prisma does send', () => {
      // Observed 13 times in a single `create` over a model with every list
      // type, always as scalarType 'unknown'.
      expect(mapArg([], arg('unknown', 'TEXT', 'list'))).toStrictEqual([]);
    });

    it('leaves an array alone when the arity says scalar', () => {
      // A scalar arity with an array value is not a list to be mapped - it is
      // a value the column itself is an array, and PostgreJS encodes it.
      const value = [1, 2];
      expect(mapArg(value, arg('int', 'INTEGER'))).toStrictEqual(value);
    });
  });

  it('works with no argType at all', () => {
    // `$queryRaw` with no placeholders produces empty args and argTypes, and a
    // savepoint statement produces neither - nothing should read index 0.
    expect(mapArg('x', undefined)).toStrictEqual('x');
    expect(mapArg(null, undefined)).toStrictEqual(null);
  });
});
