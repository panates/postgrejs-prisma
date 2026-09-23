import {
  type ColumnType,
  DriverAdapterError,
  type Provider,
  type SqlQuery,
  type SqlQueryable,
  type SqlResultSet,
} from '@prisma/driver-adapter-utils';
import {
  isMultiStatement,
  type QueryOptions,
  type QueryResult,
  type ScriptResult,
} from 'postgrejs';
import { fieldToColumnType, UnsupportedColumnType } from './column-types.js';
import { fetchAsString } from './conversion.js';
import { convertError } from './errors.js';
import { mapArg } from './params.js';
import { buildTypeMap } from './type-map.js';

export const ADAPTER_NAME = 'prisma-postgrejs';

/** Runs one statement, however the caller got hold of a connection. */
export type Runner = (sql: string, params: unknown[]) => Promise<QueryResult>;

/** Runs a `;`-separated script - see `executeRaw`. */
export type ScriptRunner = (sql: string) => Promise<ScriptResult>;

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
  protected readonly scriptRunner: ScriptRunner;

  constructor(runner: Runner, scriptRunner: ScriptRunner) {
    this.runner = runner;
    this.scriptRunner = scriptRunner;
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
    // A statement with parameters cannot be a script - `Parse` refuses more
    // than one command before a value is ever bound - so the scan is skipped
    // for the common case entirely.
    if (query.args.length === 0 && isMultiStatement(query.sql)) {
      return this.executeAsScript(query.sql);
    }
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

  /**
   * The `;`-separated case.
   *
   * `$executeRaw` is the only way a user can run raw SQL through Prisma, and
   * people put whole scripts in it. The adapter contract has a second method
   * for that - `executeScript`, documented as "Execute multiple SQL statements
   * separated by semicolon" - but `@prisma/client` never calls it, so the
   * separation the contract draws does not exist on the path a user reaches:
   * both arrive here.
   *
   * PostgreJS draws the same line the contract does and draws it correctly -
   * `query()` speaks the extended protocol, which is what gives a statement its
   * prepared plan and its own error boundary, and `execute()` is for scripts.
   * Choosing between them is this adapter's job, and PostgreJS's
   * `isMultiStatement()` is how it chooses: one scan of the text, before
   * anything is sent. That util started here, was offered upstream because the
   * question belongs to anyone routing between the two methods rather than to
   * this package, and landed in 3.11.0.
   *
   * The first version of this asked the server instead - send it, and retry as
   * a script if PostgreSQL answered *cannot insert multiple commands*. That is
   * exact and costs nothing until it fires, and it is unusable inside a
   * transaction, where the refusal aborts the transaction and the retry comes
   * back `25P02`. Scanning costs a few microseconds against a round trip, so
   * there was no reason to keep two behaviours.
   *
   * The count is the sum over the script. `@prisma/adapter-pg` answers 0 here,
   * but not on purpose: `pg` returns an *array* of results for a multi-command
   * simple query, and `result.rowCount ?? 0` on an array is 0. The sum is what
   * the contract asks for - "the number of affected rows".
   */
  protected async executeAsScript(sql: string): Promise<number> {
    let script: ScriptResult;
    try {
      script = await this.scriptRunner(sql);
    } catch (e) {
      throw new DriverAdapterError(convertError(e));
    }
    return script.results.reduce((n, one) => n + (one.rowsAffected ?? 0), 0);
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
