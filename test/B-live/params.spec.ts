import type { ArgType } from '@prisma/driver-adapter-utils';
import { expect } from 'expect';
import { type LiveAdapter, openLiveAdapter } from '../_support/live.js';

/**
 * What the server makes of a parameter, in a context that lets it decide.
 *
 * Prisma renders every value to a primitive before the adapter sees it and
 * hands over its own `argTypes`, so `mapArg` has almost nothing to do (see
 * `src/params.ts`). The thing that can still go wrong is a *declared* type: a
 * parameter sent with an OID on it can only be narrower than one sent without,
 * and the use site is the only place that knows which type is wanted. Each case
 * below compares the parameter against a column of a type it must be readable
 * as; a declared type that disagrees raises `42883` rather than converting.
 */
describe('B-live: parameters take their type from the use site', () => {
  let live: LiveAdapter;

  before(async () => {
    live = await openLiveAdapter();
  });

  after(async () => {
    await live?.close();
  });

  const list: ArgType = { scalarType: 'unknown', arity: 'list' };
  const scalar: ArgType = { scalarType: 'unknown', arity: 'scalar' };

  /**
   * The array rows are a regression test for a defect this package reported
   * upstream and PostgreJS fixed in `660aa54`. An array of numbers used to be
   * declared from its elements - `int4[]` when all were integral, `float8[]`
   * when one was not - so it could not be compared with four of the six
   * numeric array types. Scalars had already been fixed in an earlier round.
   */
  const cases: [string, string, unknown, ArgType][] = [
    ['numeric[]', `array[1.5,2.5]::numeric[]`, [1.5, 2.5], list],
    ['int8[]', `array[1,2]::int8[]`, [1, 2], list],
    ['int2[]', `array[1,2]::int2[]`, [1, 2], list],
    ['float4[]', `array[1.5,2.5]::float4[]`, [1.5, 2.5], list],
    ['float8[]', `array[1.5,2.5]::float8[]`, [1.5, 2.5], list],
    ['int4[]', `array[1,2]::int4[]`, [1, 2], list],
    ['text[]', `array['a','b']::text[]`, ['a', 'b'], list],
    ['numeric', `1.5::numeric`, 1.5, scalar],
    ['int8', `1::int8`, 1, scalar],
    [
      'uuid',
      `'00000000-0000-0000-0000-000000000001'::uuid`,
      '00000000-0000-0000-0000-000000000001',
      scalar,
    ],
    // jsonb, not json: PostgreSQL gives the `json` type no equality operator
    // at all, so `json = anything` is a syntax-level error either way.
    ['jsonb', `'{"a":1}'::jsonb`, '{"a":1}', scalar],
  ];

  for (const [label, expr, value, argType] of cases) {
    it(`compares a parameter with a ${label} column`, async () => {
      const result = await live.adapter.queryRaw({
        sql: `select ${expr} = $1 as v`,
        args: [value],
        argTypes: [argType],
      });
      expect(result.rows[0][0]).toStrictEqual(true);
    });
  }

  it('sends an empty list without inventing an element type', async () => {
    // Prisma sends 13 of these in a single `create` over a model with every
    // list type, under `scalarType: 'unknown'` - and an empty array has no
    // element to infer anything from.
    const result = await live.adapter.queryRaw({
      sql: `select cardinality($1::int[]) as v`,
      args: [[]],
      argTypes: [list],
    });
    expect(result.rows[0][0]).toStrictEqual(0);
  });
});
