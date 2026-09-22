import {
  type ColumnType,
  DriverAdapterError,
  type Provider,
  type SqlQuery,
  type SqlQueryable,
  type SqlResultSet,
} from '@prisma/driver-adapter-utils';
import type { QueryOptions, QueryResult } from 'postgrejs';
import { fieldToColumnType, UnsupportedColumnType } from './column-types.js';
import { fetchAsString } from './conversion.js';
import { convertError } from './errors.js';
import { mapArg } from './params.js';
import { buildTypeMap } from './type-map.js';

export const ADAPTER_NAME = 'prisma-postgrejs';

/** Runs one statement, however the caller got hold of a connection. */
export type Runner = (sql: string, params: unknown[]) => Promise<QueryResult>;

/**
 * `queryRaw` / `executeRaw`, shared by the adapter and by a transaction.
 *
 * The result shape needs no translation: PostgreJS returns rows as arrays and
 * declares each column's type separately, which is exactly what `SqlResultSet`
 * is - and nothing here walks a row. A value is whatever PostgreJS decoded it
 * to, decided once per column by `conversion.ts`'s `fetchAsString` list and,
 * for the two types Prisma wants in a shape PostgreSQL does not write, by a
 * decoder in `type-map.ts`.
 */
export abstract class PostgreJSQueryable implements SqlQueryable {
  readonly provider: Provider = 'postgres';
  readonly adapterName = ADAPTER_NAME;
  protected readonly runner: Runner;

  constructor(runner: Runner) {
    this.runner = runner;
  }

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const result = await this.perform(query);
    const fields = result.fields ?? [];
    const rows = (result.rows ?? []) as unknown[][];

    let columnTypes: ColumnType[];
    try {
      columnTypes = fields.map(f => fieldToColumnType(f.dataTypeId));
    } catch (e) {
      if (e instanceof UnsupportedColumnType) {
        throw new DriverAdapterError({
          kind: 'UnsupportedNativeDataType',
          type: e.typeName,
        });
      }
      throw e;
    }

    return {
      columnNames: fields.map(f => f.fieldName),
      columnTypes,
      rows,
    };
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    const result = await this.perform(query);
    // `rowsAffected` is set for INSERT/UPDATE/DELETE/MERGE and left undefined
    // for everything else, including SELECT - where the count would describe
    // rows returned rather than rows changed. `pg` does not draw that line: its
    // `rowCount` is the row count for a SELECT, and `@prisma/adapter-pg` passes
    // it straight through. Falling back to the row count keeps the number a
    // user sees from `$executeRaw` the same across the two adapters; a
    // statement that returns nothing answers 0 either way.
    return result.rowsAffected ?? result.rows?.length ?? 0;
  }

  protected async perform(query: SqlQuery): Promise<QueryResult> {
    const params = query.args.map((arg, i) => mapArg(arg, query.argTypes[i]));
    try {
      return await this.runner(query.sql, params);
    } catch (e) {
      throw new DriverAdapterError(convertError(e));
    }
  }
}

/**
 * The per-call options every statement runs under.
 *
 * `rowDecoder: 'array'` is the shape `SqlResultSet.rows` wants.
 * `unknownTypesAsString` is not optional: without it an enum, a composite or
 * any extension type arrives as a raw `Buffer`, and `fieldToColumnType` has
 * already promised Prisma they are text.
 *
 * Frozen and shared. Every statement spreads it into a fresh object to add its
 * parameters, so nothing mutates it, and there is no reason for an adapter or
 * a transaction to hold a copy of its own - `buildTypeMap()` copies all 125 of
 * PostgreJS's registered types, so building this per transaction, which is
 * where it used to be built, allocated that copy for every `$transaction()`.
 */
export const QUERY_OPTIONS: QueryOptions = Object.freeze({
  rowDecoder: 'array',
  fetchAsString: fetchAsString(),
  unknownTypesAsString: true,
  utcDates: true,
  typeMap: buildTypeMap(),
});
