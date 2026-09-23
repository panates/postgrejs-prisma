# prisma-postgrejs

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]
[![Test Coverage][coveralls-image]][coveralls-url]

A [Prisma](https://www.prisma.io) driver adapter for
[PostgreJS](https://github.com/panates/postgrejs). Swap it in where `@prisma/adapter-pg` goes and
everything above it stays the same - your schema, your queries, your migrations. Queries get
faster, and two values the reference adapter gets silently wrong come back right.

## Install

```sh
npm install prisma-postgrejs postgrejs @prisma/driver-adapter-utils
```

`postgrejs` (>=3.11.0 <4) and `@prisma/driver-adapter-utils` (>=7.10.0 <9) are peer dependencies -
the second one because `@prisma/client` does not bring it along. Node >=22.

## Quick start

At Prisma 7 the adapter is how a client connects, so the datasource block carries no `url`:

```prisma
datasource db {
  provider = "postgresql"
}
```

```ts
import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPostgreJS } from 'prisma-postgrejs';

const adapter = new PrismaPostgreJS('postgresql://user:secret@localhost:5432/mydb');
const prisma = new PrismaClient({ adapter });

await prisma.user.findMany({ where: { active: true } });
```

That is the whole change.

## Benchmarks

End to end through a real `PrismaClient`, against `@prisma/adapter-pg` on the same server.

| workload | `@prisma/adapter-pg` | `prisma-postgrejs` | speedup |
| --- | --- | --- | --- |
| primary-key lookup | 0.788 ms | 0.555 ms | **1.42x** |
| 10k rows, mixed scalars | 17.006 ms | 14.828 ms | **1.15x** |
| 10k rows, `int8`/`numeric`/`timestamp` | 18.793 ms | 15.066 ms | **1.25x** |
| 20 inserts in one transaction | 14.179 ms | 9.878 ms | **1.44x** |
| 32 concurrent `count()`, pool of 4 | 8.46 ms | 5.88 ms | **1.44x** |
| 32 concurrent `findFirst`, pool of 4 | 4.84 ms | 1.95 ms | **2.48x** |
| 32 concurrent `findMany`, pool of 4 | 4.47 ms | 1.90 ms | **2.35x** |

Prisma 7.10.0, PostgreSQL 18.4, loopback, Node 24.

**The gain grows with the shape of the workload.** A bulk read of ordinary scalars gains 1.15x; a
round-trip-bound query 1.4x; and once there is more concurrency than pool, 2.5x - which is what a
web application under load actually looks like.

### How these were measured

Both adapters run in one process and alternate on every iteration, so neither gets a warmer machine
than the other. Each figure is the median of 101 iterations, or 61 for the concurrent workloads.

The medians alone would not be worth much: this was a shared machine, and the absolute figures
drift by up to 25% between runs. What does not drift is *which* of the two won each iteration, so
that is counted separately:

| workload | iterations | `prisma-postgrejs` faster in | odds of that by luck |
| --- | --- | --- | --- |
| primary-key lookup | 101 | 90 | < 1 in 10^16 |
| 10k rows, mixed scalars | 101 | 85 | < 1 in 10^12 |
| 10k rows, `int8`/`numeric`/`timestamp` | 101 | 86 | < 1 in 10^12 |
| 20 inserts in one transaction | 101 | 87 | < 1 in 10^13 |
| 32 concurrent `count()`, pool of 4 | 61 | 61 | < 1 in 10^18 |
| 32 concurrent `findFirst`, pool of 4 | 61 | 60 | < 1 in 10^16 |
| 32 concurrent `findMany`, pool of 4 | 61 | 61 | < 1 in 10^18 |

That last column is a sign test: two adapters of equal speed would split the iterations evenly, so
it gives the probability of a split this lopsided from a fair coin. It says the differences are
real, and nothing about their size - that is what the speedup column is for.

## Usage

### Connecting

Three ways to say where the database is:

```ts
new PrismaPostgreJS('postgresql://user:secret@localhost:5432/mydb'); // a connection string
new PrismaPostgreJS({ host: 'localhost', database: 'mydb', max: 10 }); // PostgreJS's pool options
new PrismaPostgreJS(pool); // a Pool you made yourself
```

`prisma.$disconnect()` closes a pool this package opened. A `Pool` you passed in stays yours - it
is left open, so it can go on serving whatever else is using it.

### Options

```ts
new PrismaPostgreJS('postgresql://user:secret@localhost:5432/mydb', {
  schema: 'my_schema',
  pipeline: true,
  onPoolError: err => logger.error(err),
});
```

| option | default | what it does |
| --- | --- | --- |
| `schema` | `?schema=` on the connection string | the schema the engine qualifies its SQL with |
| `pipeline` | `true` | lets a statement share a pooled connection with statements already in flight instead of waiting for one of its own - this is what the concurrency rows above measure. `false` gives each statement the connection to itself |
| `onPoolError` | - | called when a pooled connection is lost or one could not be opened. Prisma has nowhere to report either, so without this they are only visible as the failure of whatever query was in flight |

### Migrations

`prisma migrate` and `prisma db push` connect with the CLI's own built-in connector rather than
through the adapter, so they need a URL of their own in `prisma.config.ts`:

```ts
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL },
});
```

## Tested against Prisma's own suite

`prisma-postgrejs` is run against the functional suite from the `prisma/prisma` repository at the
version it targets - the same suite Prisma runs its own adapters through - with
`@prisma/adapter-pg` over the same server in the same invocation as the control. Tag 7.10.0,
PostgreSQL 18.4, 191 suite files selected for `provider=postgresql`:

| | `@prisma/adapter-pg` | `prisma-postgrejs` |
| --- | --- | --- |
| tests | 1251 | 1251 |
| passed | 1251 | 1251 |

Same tests, and both pass every one of them: **not a single test that `prisma-postgrejs` loses and
`@prisma/adapter-pg` wins.** There is no expected-failure list either - the control run measures
the baseline on your machine, so that is the only thing the comparison can fail on.

Left out of the table: 81 more that fail identically on both sides and so judge neither adapter. A
local clone of the Prisma repository does not have the `/client/…` path its inline snapshots were
recorded against.

Run it yourself with `npm run test:prisma-suite`. It clones the tag, patches `js_postgrejs` into
the adapter matrix, and runs both adapters.

On top of that, 360 tests of this package's own - and a differential suite among them that runs
every case through `@prisma/adapter-pg` as well and compares the two.

## What changes when you switch

Measured against `@prisma/adapter-pg@7.10.0` on the same schema and the same server.

### Values

| case | `@prisma/adapter-pg` | `prisma-postgrejs` |
| --- | --- | --- |
| `timetz` on any offset but zero | wrong instant, silently | correct - see below |
| `money` below zero in a `$queryRaw`, e.g. `-$0.05` | **throws** `DecimalError` | `-0.05` |
| `money` at or above 1000 in a `$queryRaw` | **throws** `DecimalError` | `1234.5` |
| any temporal type on a server whose `DateStyle` is not `ISO` | **throws** `Invalid time value` | correct |
| `timestamptz` on a session whose `TimeZone` is not UTC | wrong instant, silently | correct |
| `"char"[]` | the raw literal `"{a}"` | `["a"]` |

The `money` rows say `$queryRaw` deliberately: on a **model** read the query compiler emits
`"m"::numeric`, so the column arrives as a `numeric` and neither adapter's `money` handling is
reached.

Everywhere else the two agree - including the cases where the raw values differ but the engine
converts them to the same thing, which were checked through a real `PrismaClient` rather than at
the adapter boundary. Where Prisma cannot carry a type at all they agree exactly: 23 of 74
PostgreSQL types raise `UnsupportedNativeDataType` in both.

### `timetz`

A `timetz` carries an offset and that offset is the column's data. Prisma appends a `Z` to whatever
it is handed for a `Time`, so the value has to arrive already at UTC with no offset on it.
`@prisma/adapter-pg` drops the offset and keeps the wall clock; `prisma-postgrejs` moves the clock
to UTC first. On a `DateTime @db.Timetz` field holding `10:20:30+03` - the instant `07:20:30Z`:

| | model read | `$queryRaw` |
| --- | --- | --- |
| `@prisma/adapter-pg` | `10:20:30Z` - out by the offset | `10:20:30Z` - out by the offset |
| `prisma-postgrejs` | `07:20:30Z` | `07:20:30Z` |

Only offset zero agrees. Everywhere else the reference is out by it, and `10:20:30+03` and
`10:20:30-05` arrive there as the same value.

### Several statements in one `$executeRaw`

Both run them; the row count differs:

```ts
// t holds 1, 2, 3
await prisma.$executeRawUnsafe(`update t set a = a + 1; delete from t where a = 2`);
// @prisma/adapter-pg -> 0
// prisma-postgrejs   -> 4   (3 rows updated, then 1 deleted)
```

The count is what the contract asks for - "the number of affected rows" - summed over the script.
The reference answers `0` for any script, which is a consequence rather than a decision: `pg`
returns an *array* of results for a multi-command query, and an array has no `rowCount`.

Inside an interactive transaction it works the same way, on that transaction's own connection - so
a rollback takes the script with it.

### Errors

The two produce the same `PrismaClientKnownRequestError` for the same failure - `P2002` for a
unique violation, `P2010` with the same `kind` and SQLSTATE for a raw query. Getting there took one
thing `@prisma/adapter-pg` does not have to do: PostgreJS appends a source excerpt to
`Error.message` wherever the server reported a position, so the mapping reads
`DatabaseError.serverMessage` - the text exactly as PostgreSQL sent it - and a port that missed
that would lose the column name from every `ColumnNotFound`.

### Transactions

Both report `usePhantomQuery: false` and drive Prisma's savepoints, so nested interactive
transactions, all four isolation levels and the `SNAPSHOT` rejection behave identically, and
`BEGIN`, `COMMIT` and `ROLLBACK` appear in `PrismaClient`'s `query` event and tracing spans exactly
as they do with `@prisma/adapter-pg`.

The difference is the `BEGIN`: PostgreSQL accepts `BEGIN ISOLATION LEVEL SERIALIZABLE` as a single
statement, so an isolated transaction opens in one round trip where the reference sends `BEGIN` and
then `SET TRANSACTION ISOLATION LEVEL`.

### `executeRaw` on a `SELECT`

`pg` reports the number of rows a `SELECT` returned as its `rowCount` and `@prisma/adapter-pg`
passes that through; PostgreJS reports `rowsAffected` only for `INSERT`/`UPDATE`/`DELETE`/`MERGE`.
This adapter falls back to the row count so the number `$executeRaw` gives back does not change
when you switch.

## License

BSD-3-Clause

[npm-image]: https://img.shields.io/npm/v/prisma-postgrejs
[npm-url]: https://npmjs.org/package/prisma-postgrejs
[downloads-image]: https://img.shields.io/npm/dm/prisma-postgrejs.svg
[downloads-url]: https://npmjs.org/package/prisma-postgrejs
[ci-test-image]: https://github.com/panates/postgrejs-prisma/actions/workflows/test.yml/badge.svg
[ci-test-url]: https://github.com/panates/postgrejs-prisma/actions/workflows/test.yml
[coveralls-image]: https://img.shields.io/coveralls/panates/postgrejs-prisma/dev.svg
[coveralls-url]: https://coveralls.io/r/panates/postgrejs-prisma
