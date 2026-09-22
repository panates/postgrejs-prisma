# prisma-postgrejs

A [Prisma](https://www.prisma.io) driver adapter for
[PostgreJS](https://github.com/panates/postgrejs), so a Prisma schema runs on PostgreJS's
wire-protocol client instead of `pg`.

## Why

Prisma's query engine converts whatever an adapter returns into its own values, so PostgreJS's
rich decoding - `Interval`, `Range`, `Numeric`, the geometric family - buys nothing here: 23 of the
74 PostgreSQL types measured are rejected by Prisma in *both* `prisma-postgrejs` and
`@prisma/adapter-pg`. The case for this package is protocol throughput and nothing else, and it was
measured before any code was written - then again from the code:

| workload | `@prisma/adapter-pg` | `prisma-postgrejs` | speedup |
| --- | --- | --- | --- |
| primary-key lookup | 0.788 ms | 0.555 ms | **1.42x** |
| 10k rows, mixed scalars | 17.006 ms | 14.828 ms | **1.15x** |
| 10k rows, `int8`/`numeric`/`timestamp` | 18.793 ms | 15.066 ms | **1.25x** |
| 20 inserts in one transaction | 14.179 ms | 9.878 ms | **1.44x** |
| 32 concurrent `count()`, pool of 4 | 8.46 ms | 5.88 ms | **1.44x** |
| 32 concurrent `findFirst`, pool of 4 | 4.84 ms | 1.95 ms | **2.48x** |
| 32 concurrent `findMany`, pool of 4 | 4.47 ms | 1.90 ms | **2.35x** |

Prisma 7.10.0, PostgreSQL 18.4, loopback, Node 24. Medians; how that was measured and how reliable
each row is are in [How the numbers were measured](#how-the-numbers-were-measured).

**Read these per workload, not as one number.** A bulk read of ordinary scalars is 1.15x; a
round-trip-bound query is 1.4x; concurrency past the pool size is where it reaches 2.5x. Nothing
here is 2.5x across the board.

The win is round trips and the socket, not decoding: Prisma converts whatever an adapter returns, so
a decode that arrives in a richer form is re-converted away. What survives is that PostgreJS needs
fewer round trips - it takes the isolation level on the `BEGIN` where the reference sends a second
statement - and that it can put more than one statement on a connection at a time, which is what
the last three rows measure.

## How the numbers were measured

Both adapters run in one process and alternate on every iteration, so neither gets a warmer machine
than the other. Each figure above is the median of 101 iterations, or 61 for the concurrent
workloads.

The medians alone would not be worth much: this was measured on a shared machine, and the absolute
figures drift by up to 25% between runs - the same `@prisma/adapter-pg` baseline came out at both
0.613 ms and 0.788 ms during one session. What does not drift is *which* of the two won each
iteration, so that is counted separately:

| workload | iterations | `prisma-postgrejs` faster in | odds of that by luck |
| --- | --- | --- | --- |
| primary-key lookup | 101 | 90 | < 1 in 10^16 |
| 10k rows, mixed scalars | 101 | 85 | < 1 in 10^12 |
| 10k rows, `int8`/`numeric`/`timestamp` | 101 | 86 | < 1 in 10^12 |
| 20 inserts in one transaction | 101 | 87 | < 1 in 10^13 |
| 32 concurrent `count()`, pool of 4 | 61 | 61 | < 1 in 10^18 |
| 32 concurrent `findFirst`, pool of 4 | 61 | 60 | < 1 in 10^16 |
| 32 concurrent `findMany`, pool of 4 | 61 | 61 | < 1 in 10^18 |

That is a sign test - only which adapter won counts, and by how much is thrown away, which is
exactly what makes it survive a noisy machine. Two adapters of equal speed would split the
iterations evenly, so the last column is the probability of seeing a split that lopsided from a fair
coin. It says the differences are real; it says nothing about their size, which is what the speedup
column is for.

## Where the speed comes from

PostgreJS's headline feature - decoding 125 PostgreSQL types into real JavaScript values, with a
class of its own for `Interval`, `Range`, `Numeric` and the geometric family - is worth **nothing**
here, and that is worth saying plainly. Prisma's engine converts whatever an adapter hands it into
its own values, so a richer decode is re-converted away; 23 of the 74 types measured cannot be
carried at all. Everything below is protocol and wire work instead, and each item was measured on
its own.

### It reads the wire format, not a rendering of it

Values arrive in PostgreSQL's binary format and are decoded per type. That is why `prisma-postgrejs`
is the only one of the two that survives a server whose `DateStyle` is not `ISO` - there is no
text to misread. Where Prisma genuinely wants the server's own text, PostgreJS asks the *server*
for it, as a Bind format code, rather than decoding the value and re-rendering it.

That lever is used sparingly, because measurement said to: asking for text costs 10-14% on a bulk
read, since the payload is bigger and the binary decoders are faster than not decoding. It is set
for exactly five OIDs - `int8`, `numeric`, `json`, `jsonb` and `timetz` - each one a type whose
decoded form Prisma would reject outright or silently round.

### It can put more than one statement on a connection at a time

A pooled query may share a connection with statements already in flight instead of waiting for one
of its own; `pg` takes the other approach and serialises statements per client. This is what the
concurrent rows above measure: with 32 statements over a pool of four, `findFirst` goes from
4.10 ms unshared to 1.95 ms shared, against 4.84 ms for the same workload through
`@prisma/adapter-pg`.

Sharing is safe here because nothing `prisma-postgrejs` runs outside a transaction carries session
state, and a transaction holds a connection of its own that is never shared. Verified: with five
concurrent statements on one shared connection and two of them failing, each caller got its own
result or its own error, and the connection stayed usable.

### It keeps prepared statements

PostgreJS names and caches a statement per connection (64 by default) and reuses it, so the server
parses and plans each distinct SQL once rather than on every call. Counted from the backend after
five identical queries, `prisma-postgrejs` leaves 2 prepared statements behind.

Isolated on a repeated parameterized query, the cache alone is worth **1.26x** (faster in 184 of 201
alternated iterations). Prisma sends the same handful of SQL strings over and over, which is the
shape that benefits most.

### It takes the transaction's modes on the `BEGIN`

PostgreSQL accepts `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY` as one statement.
`prisma-postgrejs` uses that form, so an isolated transaction opens in one round trip instead of the
two a separate `SET TRANSACTION` needs. Opening and closing one: **1.48x** (0.740 ms to 0.500 ms,
faster in 195 of 201).

### It asks the server rather than guessing

`money`'s scale and decimal separator come from `lc_monetary`, which a client cannot know. PostgreJS
probes it once per connection, and only on the first result that actually contains a `money`
column, so a `money` value is decoded exactly instead of being read off a rendering meant for a
human. `pg` has no equivalent and hands back the rendering.

## Prisma's own test suite

`prisma-postgrejs` is run against the functional suite from the `prisma/prisma` repository at the
version it targets - the same suite Prisma runs its own adapters through - with
`@prisma/adapter-pg` over the same server in the same invocation as the control. Tag 7.10.0,
PostgreSQL 18.4, 191 suite files selected for `provider=postgresql`:

| | `@prisma/adapter-pg` | `prisma-postgrejs` |
| --- | --- | --- |
| passed | 1251 | 1250 |
| failed | 81 | 83 |

The 81 failures both share are the checkout's own - inline snapshots that expect the CI's
`/client/…` path. There is no expected-failure list: the control run measures the baseline, and the
only thing that fails the comparison is a test `prisma-postgrejs` loses that the reference wins.

**One does**: `issues/TML-1664 :: returns P2007 …`, whose setup puts two statements in one
`$executeRawUnsafe` - a deliberate difference, explained below.

Run it yourself with `npm run test:prisma-suite`. It clones the tag, patches `js_postgrejs` into the
adapter matrix, and runs both adapters.

## How it differs from `@prisma/adapter-pg`

Measured against `@prisma/adapter-pg@7.10.0`, same schema, same server, by a differential test
suite that runs every case through both and compares the results.

### Values

Every row here is a case where the two hand Prisma different values.

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
reached. It is raw SQL selecting a bare `money` column where it shows, and there
`normalize_money` - `text.slice(1)` over the server's `-$1,234.50` - takes the minus sign rather
than the symbol and leaves the separators in.

The rest: the engine parsing a non-ISO date string it cannot read, where `prisma-postgrejs` decodes
from the binary form that no `DateStyle` can affect; `normalize_timestamptz` rewriting the server's
offset to `+00:00` instead of converting; and `pg` having no array parser registered for OID 1002,
so the literal leaks through where the column type promised an array.

Everywhere else the two agree, including on the cases where the raw values differ but the engine
converts them to the same thing - `int8[]`, `numeric[]`, `json[]`, and the temporal arrays. Those
were checked through a real `PrismaClient` rather than at the adapter boundary, because the raw
value is not what a user sees.

Where Prisma cannot carry a type at all, the two agree exactly: 23 of 74 PostgreSQL types -
`interval`, the range family, the geometric family, `tsvector`, `macaddr` and the rest - raise
`UnsupportedNativeDataType` in both, because Prisma's `ColumnType` has no member for them.

### `timetz`, where this adapter is right and the reference is not

PostgreSQL writes a `timetz` as `10:20:30+03`, and the offset is the column's data. Prisma appends a
`Z` to whatever it is handed for a `Time`, on both paths it reads one - so the value has to arrive
already at UTC, with no offset on it.

`@prisma/adapter-pg` drops the offset and keeps the wall clock (`normalize_timez`).
`prisma-postgrejs` moves the clock to UTC first. Measured end to end on a `DateTime @db.Timetz`
field holding `10:20:30+03` - the instant `07:20:30Z`:

| | model read | `$queryRaw` |
| --- | --- | --- |
| `@prisma/adapter-pg` | `10:20:30Z` - out by the offset | `10:20:30Z` - out by the offset |
| `prisma-postgrejs` | `07:20:30Z` | `07:20:30Z` |

Only the offset zero case agrees. Everywhere else the reference is out by it, and `10:20:30+03` and
`10:20:30-05` become the same value there.

### Several statements in one `$executeRaw`

`prisma-postgrejs` raises `42601 cannot insert multiple commands into a prepared statement`;
`@prisma/adapter-pg` runs them. Prisma's adapter contract draws the line itself -
`executeRaw(params: Query)` is *"Execute a query"* and `executeScript(script: string)` is
*"Execute multiple SQL statements separated by semicolon"* - so a script belongs on the second, and
`$executeRaw` is the first.

It works on the reference adapter because `pg` chooses its wire protocol from whether the call
happened to have parameters: with none it sends a simple `Query` instead of Parse/Bind/Execute, so
the same statement quietly loses its prepared statement and its per-statement error boundary, and
gains the right to carry several commands. `prisma-postgrejs` does not do that. Send the statements
one at a time.

### Errors

The two produce the same `PrismaClientKnownRequestError` for the same failure - `P2002` for a unique
violation, `P2010` with the same `kind` and SQLSTATE for a raw query - which took one thing this
adapter has to do differently. PostgreJS appends a source excerpt to `Error.message` wherever the
server reported a position, and `@prisma/adapter-pg` extracts detail from `message` with patterns,
one of them anchored:

```js
message.match(/^column (.+) does not exist$/)   // never matches a decorated message
```

So the mapping reads `DatabaseError.serverMessage` - the text exactly as PostgreSQL sent it - rather
than `message`. A port that missed that would lose the column name from every `ColumnNotFound` and
show users a caret diagram inside a `P2010`.

### Transactions

Both report `usePhantomQuery: false` and drive Prisma's savepoints, so nested interactive
transactions, all four isolation levels and the `SNAPSHOT` rejection behave identically, and
`BEGIN`, `COMMIT` and `ROLLBACK` appear in `PrismaClient`'s `query` event and tracing spans exactly
as they do with `@prisma/adapter-pg`.

The one difference is the `BEGIN`. PostgreSQL accepts `BEGIN ISOLATION LEVEL SERIALIZABLE` as a
single statement, so an isolated transaction opens in one round trip where the reference adapter
sends `BEGIN` and then `SET TRANSACTION ISOLATION LEVEL`.

### `executeRaw` on a `SELECT`

`pg` reports the number of rows a `SELECT` returned as its `rowCount`, and `@prisma/adapter-pg`
passes that through. PostgreJS reports `rowsAffected` only for `INSERT`/`UPDATE`/`DELETE`/`MERGE`,
where the two agree exactly. This adapter falls back to the row count so that the number
`$executeRaw` gives back does not change when you switch - it was found by the differential suite,
not by reading either implementation.

## Migrations

`prisma migrate` and `prisma db push` **do not go through the driver adapter**. At 7.10.0 the CLI
connects with its own built-in connector using `datasource.url` from `prisma.config.ts`, and
nothing in `prisma` or `@prisma/client` calls `connectToShadowDb`. You need a connection URL in
`prisma.config.ts` for migrations, separately from the adapter you pass to `PrismaClient`.

## Requirements

- Node.js >= 22
- `postgrejs` >= 3.10.0. The adapter is built on six things that release carries: `money` decoding,
  `DatabaseError.serverMessage`, opt-in pooled pipelining, `fetchAsString` naming an array column by
  its element type, a `postgresql://` connection string keeping its database, and an array parameter
  going out with no declared element type. Five of the six exist because this adapter's
  reconnaissance round measured them and reported them upstream.
- `@prisma/client` / `@prisma/driver-adapter-utils` >= 7.10.0

## License

BSD-3-Clause
