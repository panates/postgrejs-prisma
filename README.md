# prisma-postgrejs

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]
[![Test Coverage][coveralls-image]][coveralls-url]

A [Prisma](https://www.prisma.io) driver adapter for
[PostgreJS](https://github.com/panates/postgrejs). Swap it in where `@prisma/adapter-pg` goes and
everything above it stays the same - your schema, your queries, your migrations.

<!-- bench:intro -->

It is faster where it counts, and it asks the runtime for far less memory doing it. A 4 MB `bytea`
comes back in 50.756 ms against 108.827 ms, and one call allocates 21.6 MB against 69.2 MB - `pg`
asks for that column as `\x`-prefixed hex, two characters a byte, so it pulls 8.0 MB off the socket
where this adapter pulls 4.0 MB, and then holds it as a string off the JS heap where a heap figure
alone cannot see it. An `int4[]` of 100k values runs 3.28x, at 13.4 MB against 27.3 MB - values that
use the whole type on purpose, because a column of single digits is shorter as text than as binary
and quoting that would be choosing the answer. Ordinary queries gain less and gain it repeatably: a
point read is the faster of the two in 99 of 101 alternated pairs. All of it through an unmodified
`PrismaClient`, against `@prisma/adapter-pg` on the same server in the same run.

<!-- /bench:intro -->

### ➜ [**THE FULL BENCHMARK**](doc/BENCHMARKS.md)

Fourteen workloads, time and memory, measured twice over - once through `PrismaClient` and once
through the adapter alone. Every figure on this page comes out of that run.

And two values the reference adapter gets silently wrong come back right.

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

## Why

It is a drop-in swap for `@prisma/adapter-pg`: the same `PrismaClient({ adapter })`, the same
schema, the same queries, the same migrations. What you get for it:

<!-- bench:payload -->

- **Faster where the payload is large** - 2.14x on a 4 MB `bytea`, and 3.28x on a 100k-element
  `int4[]` whose values use the whole type, because the values arrive in PostgreSQL's binary format
  rather than as text to be parsed.

<!-- /bench:payload -->

<!-- bench:memory -->

- **And lighter on the same rows** - one call allocates 21.6 MB against 69.2 MB on that `bytea`,
  and 984 KB against 3.6 MB on an array of 5000 `float8`. On rows too narrow to carry a payload the
  two are within a few percent, and on the smallest of them this adapter asks for slightly more.

<!-- /bench:memory -->

- **Slightly faster on ordinary round trips**, repeatably - statements are prepared and reused
  without anyone asking for it.
- **Two values the reference adapter gets wrong** - `timetz` on any offset but zero, and `money`
  outside a narrow range - come back right. [What changes when you switch](#what-changes-when-you-switch)
  is the full list.
- **A client that can do what Prisma has no way to ask for** - cursors, `COPY`, `LISTEN`/`NOTIFY`,
  large objects, logical replication and pipelining, on the same pool your queries use.
- **Checked against Prisma's own functional suite** - 1251 of its tests pass, with
  `@prisma/adapter-pg` run over the same server in the same invocation as the control.

<!-- bench:headline -->

| Workload                           | `@prisma/adapter-pg`<br>time / allocated | `prisma-postgrejs`<br>time / allocated |                       |
| ---------------------------------- | ---------------------------------------- | -------------------------------------- | --------------------- |
| primary-key lookup                 | 0.326 ms<br>**59 KB**/call               | **0.289 ms**<br>63 KB/call             | **1.13x**<br>+6%      |
| 10k rows, mixed scalars            | 25.165 ms<br>13.2 MB/call                | **17.019 ms**<br>**10.7 MB**/call      | **1.48x**<br>**-19%** |
| 10k rows, int8/numeric/timestamp   | 27.552 ms<br>17.0 MB/call                | **20.146 ms**<br>**14.9 MB**/call      | **1.37x**<br>**-12%** |
| point read                         | 0.641 ms<br>**65 KB**/call               | **0.560 ms**<br>69 KB/call             | **1.15x**<br>+7%      |
| page of 200                        | 1.845 ms<br>582 KB/call                  | **1.506 ms**<br>**480 KB**/call        | **1.23x**<br>**-17%** |
| uuid of 5k rows                    | 6.591 ms<br>3.4 MB/call                  | **5.149 ms**<br>**3.3 MB**/call        | **1.28x**<br>**-3%**  |
| float8 of 5k rows                  | 6.131 ms<br>3.4 MB/call                  | **4.420 ms**<br>**3.2 MB**/call        | **1.39x**<br>**-4%**  |
| float8[] of 5k in one row          | 5.819 ms<br>3.6 MB/call                  | **1.865 ms**<br>**984 KB**/call        | **3.12x**<br>**-73%** |
| int4[] of 100k in one row          | 64.125 ms<br>27.3 MB/call                | **19.561 ms**<br>**13.4 MB**/call      | **3.28x**<br>**-51%** |
| bytea of 4MB                       | 108.827 ms<br>69.2 MB/call               | **50.756 ms**<br>**21.6 MB**/call      | **2.14x**<br>**-69%** |
| 20 inserts in one transaction      | 16.008 ms<br>**1.1 MB**/call             | **14.091 ms**<br>1.1 MB/call           | **1.14x**<br>+6%      |
| 32 concurrent count(), pool of 4   | 16.786 ms<br>**1.3 MB**/call             | **10.173 ms**<br>1.3 MB/call           | **1.65x**<br>+3%      |
| 32 concurrent findFirst, pool of 4 | 11.908 ms<br>1.6 MB/call                 | **4.454 ms**<br>**1.6 MB**/call        | **2.67x**<br>**-3%**  |
| 32 concurrent findMany, pool of 4  | 10.062 ms<br>1.3 MB/call                 | **4.266 ms**<br>**1.3 MB**/call        | **2.36x**<br>**-3%**  |

`@prisma/client` 7.10.0, `@prisma/adapter-pg` 7.10.0, `postgrejs` 3.12.1, `pg` 8.23.0, PostgreSQL
18.6 and Node 24.15.0, on loopback. Medians per call. The second line of each cell is what one call
asks the runtime for, `heapUsed` and `external` together. How that was measured, and the same rows
without the query engine, are in [`doc/BENCHMARKS.md`](doc/BENCHMARKS.md).

<!-- /bench:headline -->

<!-- bench:shape -->

**The gain follows the shape of the workload, not its size.** The same 5000 `float8` values read as
5000 rows gain 1.39x; packed into one array column in one row, 3.12x - the protocol's per-row cost
is paid by both adapters, so binary decoding is worth what the rows are wide. Large payloads gain
most: 2.14x on a 4 MB `bytea`, allocating 21.6 MB against 69.2 MB, and 3.28x on an `int4[]` of 100k
values that use the whole type. And once there is more concurrency than pool, up to 2.67x - which is
what a web application under load actually looks like.

<!-- /bench:shape -->

## How the numbers were measured

<!-- bench:method -->

Both adapters run in one process and alternate on every iteration, so neither gets a warmer machine
than the other. Each figure is the median of 101 iterations, or 61 where one of them costs more.
Memory is a pass of its own, one child process per adapter, so that what a client allocates once and
keeps is inside the window rather than under it. Everything in the table above is through a real
`PrismaClient`.

<!-- /bench:method -->

The medians alone would not be worth much: this was a shared machine, and the absolute figures
drift by up to 25% between runs. What does not drift is *which* of the two won each iteration, so
that is counted separately:

<!-- bench:signtest -->

| workload                           | iterations | `prisma-postgrejs` faster in | odds of that by luck |
| ---------------------------------- | ---------- | ---------------------------- | -------------------- |
| primary-key lookup                 | 101        | 96                           | < 1 in 10^22         |
| 10k rows, mixed scalars            | 101        | 101                          | < 1 in 10^30         |
| 10k rows, int8/numeric/timestamp   | 101        | 98                           | < 1 in 10^24         |
| point read                         | 101        | 99                           | < 1 in 10^26         |
| page of 200                        | 101        | 92                           | < 1 in 10^17         |
| uuid of 5k rows                    | 101        | 101                          | < 1 in 10^30         |
| float8 of 5k rows                  | 101        | 101                          | < 1 in 10^30         |
| float8[] of 5k in one row          | 101        | 101                          | < 1 in 10^30         |
| int4[] of 100k in one row          | 61         | 61                           | < 1 in 10^18         |
| bytea of 4MB                       | 61         | 61                           | < 1 in 10^18         |
| 20 inserts in one transaction      | 101        | 96                           | < 1 in 10^22         |
| 32 concurrent count(), pool of 4   | 61         | 60                           | < 1 in 10^16         |
| 32 concurrent findFirst, pool of 4 | 61         | 61                           | < 1 in 10^18         |
| 32 concurrent findMany, pool of 4  | 61         | 61                           | < 1 in 10^18         |

<!-- /bench:signtest -->

That last column is a sign test: two adapters of equal speed would split the iterations evenly, so
it gives the probability of a split this lopsided from a fair coin. It says the differences are
real, and nothing about their size - that is what the speedup column is for.

<!-- bench:binary -->

Result columns arrive in PostgreSQL's binary format and are decoded per type, where `pg` asks for
text and parses it. On bulk that is the whole difference: a 100k-element `int4[]` costs 19.561 ms
and 13.4 MB here against 64.125 ms and 27.3 MB, because the text path has to materialise the array
literal as one string before it can parse it. It is cheaper on the wire too, where the text is
longer than the value: the 4 MB `bytea` costs 8.0 MB of network under `@prisma/adapter-pg` and 4.0
MB here, counted at the socket - 2.0 times.

<!-- /bench:binary -->

<!-- bench:prepared -->

PostgreJS names and caches a statement per connection - 64 by default, least-recently-used closed -
so each distinct SQL string is parsed and planned once rather than on every call. Counted from the
backend: 4 queries through this adapter leave 4 prepared statements behind, and the same 4 through
`@prisma/adapter-pg` leave 0. That is a default rather than a limitation - the reference adapter
names a statement when it is given a `statementNameGenerator`, and without one `pg` sends it unnamed
and the server parses it again every time. It is what the ordinary rows' margin is mostly made of.

<!-- /bench:prepared -->

<!-- bench:engine -->

Prisma's query engine sits on both sides of every call, so it compresses these ratios rather than
causing them. Measured again through the `SqlDriverAdapter` alone, on the same SQL the engine emits,
the 4 MB `bytea` is 2.30x and allocates 4.2 MB against 52.0 MB, and the `int4[]` 4.94x. The table
above is the smaller of the two numbers on purpose: it is the one a caller actually gets.

<!-- /bench:engine -->

Where Prisma wants PostgreSQL's own text - `numeric`, the date and time family, and their array
forms - PostgreJS asks the *server* for it, as a Bind format code, rather than decoding the value
and printing it again. So the string is PostgreSQL's own and nothing on this side has to track the
session's `DateStyle`, `IntervalStyle` or `TimeZone` to produce it. The reference adapter reaches
the same place by switching `pg`'s parsers off one at a time.

Run it yourself with `npm run bench`, and re-render this page with `npm run bench:report` - every
figure here is generated from one results file, and none of it is typed in by hand.
[`doc/BENCHMARKS.md`](doc/BENCHMARKS.md) has the rest of the method, the memory a client holds
between calls, and what crosses the wire.

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
`COMMIT` and `ROLLBACK` appear in `PrismaClient`'s `query` event and tracing spans exactly as they
do with `@prisma/adapter-pg`. (Neither adapter's `BEGIN` appears there: both send it themselves, and
the engine logs only the statements it issues.)

The difference is the `BEGIN`: PostgreSQL accepts `BEGIN ISOLATION LEVEL SERIALIZABLE` as a single
statement, so an isolated transaction opens in one round trip where the reference sends `BEGIN` and
then `SET TRANSACTION ISOLATION LEVEL`.

### `executeRaw` on a `SELECT`

`pg` reports the number of rows a `SELECT` returned as its `rowCount` and `@prisma/adapter-pg`
passes that through; PostgreJS reports `rowsAffected` only for `INSERT`/`UPDATE`/`DELETE`/`MERGE`.
This adapter falls back to the row count so the number `$executeRaw` gives back does not change
when you switch.

## Development

The unit tests need nothing; the live and differential ones need a PostgreSQL at `127.0.0.1:5432`
(`postgres`/`postgres`, database `postgres`), which `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and
`PGDATABASE` override.

```sh
npm test                    # unit, live and differential tests
npm run citest              # the same, with coverage
npm run test:prisma-suite   # Prisma's own functional suite, both adapters

npm run bench               # measure both adapters, write benchmark/results/latest.json
npm run bench:report        # render that file into this page and doc/BENCHMARKS.md

rman build                  # compile, and assemble the publishable tree
rman lint                   # eslint (--fix to apply what it can)
rman check                  # circular dependency check
rman format                 # prettier (--check to verify without writing)
```

The tests come in four kinds, and the split is deliberate:

- `test/A-common` - no server. The OID-to-`ColumnType` table over every type, `mapArg` over every
  `(scalarType, dbType, arity)` triple Prisma produces, and error mapping from synthetic
  `DatabaseError`s.
- `test/B-live` - against a real server. Value shapes as an explicit table, so a change in
  PostgreJS's decoding names itself rather than surfacing as a puzzle somewhere downstream.
- `test/C-differential` - the same calls through this adapter and through `@prisma/adapter-pg`,
  deep-compared. It is what catches a difference nobody thought to assert: every divergence listed
  under [What changes when you switch](#what-changes-when-you-switch) was found by running it.
- `test/D-tooling` - no server either. The benchmark's report renderer, whose job is that no figure
  on this page was typed in by hand.

`npm run test:prisma-suite` is the fifth and the slowest. It clones `prisma/prisma` at the tag
this package targets, patches `js_postgrejs` into the adapter matrix, and runs the whole functional
suite twice - once with `@prisma/adapter-pg` as the control, once with this one - then reports only
what differs. It takes about forty minutes and 4 GB of disk, nearly all of it the two suite runs,
so it is a before-a-release tool rather than a per-push one. `SKIP_INSTALL=1` reuses an existing
checkout and skips the clone and build.

`npm run bench` needs the same server, creates its own `prisma_bench` database and rebuilds the
schema in it on every run. The timings alternate the two adapters inside every pair in one process;
the memory is a second pass in a child process per adapter, which is the only way to see what a
client allocates once and keeps. `--no-memory` skips that pass, `--heap-pairs=N` shortens it, and
`--scenario=` and `--pairs=` narrow the whole thing while iterating.

`npm run bench:report` reads the results file and rewrites the marked regions of this page and all
of `doc/BENCHMARKS.md`, so the two cannot drift apart - edit the renderer, never the numbers. It
runs nothing, so an older results file renders as readily as the last one: pass its path.

## License

MIT

[npm-image]: https://img.shields.io/npm/v/prisma-postgrejs
[npm-url]: https://npmjs.org/package/prisma-postgrejs
[downloads-image]: https://img.shields.io/npm/dm/prisma-postgrejs.svg
[downloads-url]: https://npmjs.org/package/prisma-postgrejs
[ci-test-image]: https://github.com/panates/postgrejs-prisma/actions/workflows/test.yml/badge.svg
[ci-test-url]: https://github.com/panates/postgrejs-prisma/actions/workflows/test.yml
[coveralls-image]: https://img.shields.io/coveralls/panates/postgrejs-prisma/dev.svg
[coveralls-url]: https://coveralls.io/r/panates/postgrejs-prisma
