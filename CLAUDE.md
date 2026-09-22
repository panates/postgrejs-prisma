# postgrejs-prisma

A [Prisma](https://www.prisma.io) driver adapter for
[PostgreJS](https://github.com/panates/postgrejs), so a Prisma schema can run on PostgreJS's
wire-protocol client instead of `pg`.

**Nothing in `src/` yet, and nothing should be written until the recon round in
`.claude/prisma-adapter-recon.md` is done.** That round is unusual: its first question is whether
this package should exist at all, and "do not build it" is a result to report rather than a failure
to work around. Read the next section before anything else.

## Read this first: Prisma was already rejected once

The TypeORM round looked at Prisma as the alternative target and turned it down **on evidence**.
`../postgrejs-typeorm/CLAUDE.md` records it:

> its adapters must return `SqlResultSet { columnTypes: ColumnType[], columnNames, rows }`, where
> `ColumnType` is Prisma's own ~30-value enum and the doc comment says the values are *"used within
> the Query Engine to convert values from JS to Quaint values"*. Every typed value PostgreJS
> produces would be flattened for the Rust engine to re-convert, leaving socket throughput as the
> only remaining advantage.

That argument is correct as far as it goes and it is not to be argued away in prose. **PostgreJS's
decoding - 125 registered types, `Interval`, `Range`, `Numeric`, a class per geometric type - is
worth nothing here.** Prisma's engine wants primitives and re-converts them; an adapter that decodes
richly is doing work twice. Whatever this package is good for, it is not that.

What is new since that decision, measured 2026-09-21 and the reason the repo exists:

- **The seam is public, typed, tiny and separately versioned.** `@prisma/driver-adapter-utils@7.10.0`
  is its own published package with the whole contract in 413 lines of `.d.ts`. Compare Drizzle,
  where nine load-bearing members are `stripInternal`'d out of the types and reached by deep import.
  This is the lowest churn risk of any target so far.
- **The reference implementation is 845 lines.** `@prisma/adapter-pg@7.10.0` - and ~50 of those are
  one `fieldToColumnType` switch over OIDs.
- **Prisma wants raw text for most types**, and `adapter-pg` gets it by disabling `pg`'s parsers one
  by one (`normalize_numeric`, `normalize_date`, `normalize_timestamp`, `normalize_money`, …).
  PostgreJS asks the *server* for text instead: `fetchAsString` takes any OID since 3.6 and is a
  wire-format request, not a re-rendering. The thing adapter-pg works around is a first-class option
  here.
- **Reach**: `prisma` 12.3M weekly, `@prisma/client` 11.8M (npm API, week ending 2026-09-19) -
  the largest remaining target, 3.5x `knex`.

So the case for this package rests on **protocol throughput and nothing else**, and the recon round
has to price exactly that before a line of `src/` is written. If PostgreJS does not beat `pg`
measurably *through the adapter*, with the flattening in place and the engine on the other side,
then the honest deliverable is a report saying so. Say it plainly in that case; it is a useful
answer and it is cheaper than a package nobody has a reason to install.

## The seam, as verified

Read off `@prisma/driver-adapter-utils@7.10.0`'s own `dist/index.d.ts`. Re-verify rather than trust
this list - it is a starting point, not a specification.

```ts
interface SqlDriverAdapterFactory {           // what PrismaClient({ adapter }) takes
  connect(): Promise<SqlDriverAdapter>;
}
interface SqlMigrationAwareDriverAdapterFactory extends SqlDriverAdapterFactory {
  connectToShadowDb(): Promise<SqlDriverAdapter>;   // what `prisma migrate` needs
}
interface SqlQueryable {
  queryRaw(params: SqlQuery): Promise<SqlResultSet>;
  executeRaw(params: SqlQuery): Promise<number>;
}
interface SqlDriverAdapter extends SqlQueryable {
  executeScript(script: string): Promise<void>;
  startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction>;
  getConnectionInfo?(): ConnectionInfo;       // schemaName, maxBindValues, supportsRelationJoins
  dispose(): Promise<void>;
}
interface Transaction extends SqlQueryable {
  readonly options: TransactionOptions;       // { usePhantomQuery: boolean }
  commit(): Promise<void>;
  rollback(): Promise<void>;
  createSavepoint?(name: string): Promise<void>;
  rollbackToSavepoint?(name: string): Promise<void>;
  releaseSavepoint?(name: string): Promise<void>;
}

type SqlQuery = { sql: string; args: unknown[]; argTypes: ArgType[] };
type SqlResultSet = {
  columnTypes: ColumnType[];  // 0..15 scalars, 64..78 the array counterparts, 128 UnknownNumber
  columnNames: string[];
  rows: unknown[][];          // ResultValue = number | string | boolean | null | ResultValue[] | Uint8Array
  lastInsertId?: string;
};
```

Two facts worth having up front:

- **`PrismaClient({ adapter })` is GA.** `@prisma/client@7.10.0`'s `runtime/client.d.ts:782` has
  `adapter?: SqlDriverAdapterFactory`, and the string `driverAdapters` does not appear in it - the
  preview flag older guides mention is gone. Check this again for whatever the peer floor turns out
  to be.
- **Rows are arrays and column types are declared separately**, which is exactly PostgreJS's own
  result shape: `objectRows` stays off, and `QueryResult.fields[].dataTypeId` is where `columnTypes`
  comes from. That is the one place the two libraries fit together without translation.

`@prisma/adapter-pg@7.10.0` is the reference and the differential partner: `PrismaPg(poolOrConfig,
options)` implements `SqlMigrationAwareDriverAdapterFactory`.

## Where things are

- **PostgreJS**: `../postgrejs`, and its `CLAUDE.md` describes the internals. Develop against the
  working copy; the peer floor is whatever ships the fixes below (3.7.0 is published and does
  **not** contain them).
- **The Kysely dialect**: `../postgrejs-kysely` - finished.
- **The Drizzle driver**: `../postgrejs-drizzle` - finished.
- **The TypeORM facade**: `../postgrejs-typeorm` - in progress in its own session, and the most
  useful of the three to read. Its `doc/DRIVER-DESIGN.md` §5 (parameters) and §6 (a 64-type
  measurement of what `pg` returns against what PostgreJS returns) answer questions this round would
  otherwise pay for a second time. **Copy its measurements, not its conclusions** - it is a `pg`
  facade and this is not, so what it decided about being `pg`-faithful does not transfer.

Three of the defects those rounds reported upstream are **fixed on `../postgrejs`'s `dev`** and the
older notes about them are stale:

- a binary array parameter wrote lower bound 0; it writes 1 now (vectors still 0).
- a `Date` parameter was declared `timestamp` and did not round-trip through `timestamptz`; it goes
  out with no declared type now, as offset-bearing text, which is what `pg` sends.
- a string parameter was declared `varchar`, so a json column, a uuid comparison, an enum and
  `coalesce($1, 1)` all refused it; strings go out unspecified now as well.

That last one matters here more than anywhere: **Prisma hands parameters over with its own
`argTypes`**, so the question is not "what does `determine()` guess" but "does an `ArgType` map onto
a PostgreSQL OID this client can be told to use" - `new BindParam(oid, value)` names one explicitly.
Answer it with measurement; it is question 3 of the recon.

## What PostgreJS gives you

Verified across the finished rounds and brought forward. Re-check anything Prisma's expectations
touch.

- **`connection.query(sql, options)` returns every row.** `fetchCount` defaults to 0 - the
  protocol's "no limit" - and a truncated result carries `suspended: true`.
- **Rows are arrays by default**, which is what `SqlResultSet.rows` wants.
- **`QueryResult` carries `command`, `fields`, `rowType`, `rows`, `rowsAffected`.** `rowsAffected`
  is a number, set for INSERT/UPDATE/DELETE/MERGE - `executeRaw` returns a number, so they line up.
- **`fetchAsString: [oid, …]` takes any OID since 3.6** and asks the server for text rather than
  re-rendering a decoded value. This is the main lever for matching Prisma's expected
  representations, and it should be measured against a post-decode fixup rather than assumed faster.
- **`rollbackOnError` defaults to true** - every statement inside a transaction runs under a
  savepoint of its own. Prisma drives its own savepoints through the `Transaction` interface, so the
  adapter will want `false`.
- **A pooled connection that dies** is reported on `Pool`'s `'destroy'` (second argument) and
  `'error'` as a `ConnectionLostError` - `code` `'08006'`, `processID`, the socket error as `cause`;
  the in-flight query rejects with the same object.
- **Cursors read through a portal**, which lives only as long as the transaction that created it.
  The adapter interface has no streaming method, so this probably never comes up - confirm it does
  not before ignoring it.
- **A `'notice'` event reaches the connection and the pool** as of the `dev` line, if Prisma's
  logging wants it.

## Working conventions

Inherited from `../postgrejs`; they apply from the first commit.

- **No fixups here. A gap in PostgreJS is reported, not worked around.** When something this
  adapter needs is missing, wrong or slower in `postgrejs`, do not patch around it in this package:
  no post-decode value rewriting, no shim, no vendored parser, no `pg`-compatibility table, no
  monkey-patching of the client, no "temporary" branch written to suit the behaviour as it is
  today. Stop there and write the finding up as a task file in `../postgrejs/.claude/<short-name>.md`
  - what was asked of the client, what it answered, what it should answer, and the smallest
  reproduction that shows the difference. That repo's own session picks it up and fixes it at the
  source. Otherwise every adapter ends up carrying its own copy of the same correction, and the
  client's behaviour gets defined by whichever adapter last worked around it. A workaround is
  allowed only when the user is asked for one and says yes; it then carries a comment naming the
  task file it waits on, so it can be removed when the fix lands.
- **Do not sign commits or pull requests on the assistant's behalf** - no `Co-Authored-By: Claude`
  trailer, no "Generated with Claude Code" line.
- Run `git status` before staging. Commit only the files the change is about.
- Every change comes with a test.
- **Claims about how another library behaves get checked against that library's own source, not its
  documentation.** Prisma's docs lag its packages and its adapter API has moved across majors.
- Do not publish a performance number that was not measured. Comparing two implementations means
  alternating between them inside one run and taking medians - sequential blocks on a loaded machine
  produce differences that are pure ordering artifacts. This matters more here than in any previous
  round, because throughput is the *only* argument this package has.
- Code style follows `../postgrejs`'s `CLAUDE.md`: member order (properties, constructor, accessors,
  public, protected, private), `protected` over `private`.
- Work stays in this repo. `../postgrejs` belongs to its own session; a defect found here gets
  written up as a task file there, the way the TypeORM round did, rather than fixed from here.

## Local setup

PostgreSQL on `127.0.0.1:5432` (`postgres`/`postgres`, database `postgres`), from the docker compose
in the PostgreJS repo.
