# A Prisma driver adapter on PostgreJS - what it wins, what it costs, and whether to build it

Reconnaissance for `postgrejs-prisma`, answering `.claude/prisma-adapter-recon.md` - and then the
record of what the answers turned into. The round was written before any of `src/` existed, from
measurements taken with a throwaway prototype. `src/` exists now, the figures have been re-taken
from it, and the places where the round's conclusions did not survive contact are marked in place
rather than edited away. See *What happened after this was written*, below.

Measured against `@prisma/client` / `prisma` / `@prisma/adapter-pg` /
`@prisma/driver-adapter-utils` **7.10.0**, `pg@8.23.0`, PostgreSQL **18.4** on loopback, session
`TimeZone=UTC`, machine UTC+03.

The round opened on 2026-09-21 against PostgreJS **3.8.0** (`../postgrejs` `dev`, `f5f9d79`) and
closed on 2026-09-22 against `ac5ba39`, twenty commits later - five of them fixes this round
reported. Where a measurement depends on which, it says so.

**Recommendation: proceed.** The argument CLAUDE.md said this package would have to rest on -
protocol throughput and nothing else - holds up under measurement, and it holds up *through* the
flattening, which is the part that was in doubt. Details in §1 and in `Recommendation` at the end.

---

## What happened after this was written

This began as reconnaissance and the recommendation at the bottom was "proceed". It was acted on:
`src/` exists, and 330 tests pass against a live server. Several things below were superseded on the
way, and they are marked in place - but the trajectory is worth having in one piece, because most of
it is the round feeding back into PostgreJS itself.

**Six defects went upstream, all six fixed.** Each was measured here, written up as a task file in
`../postgrejs/.claude/`, and fixed in that repo's own session. Three *more* were filed and had to be
withdrawn, which is its own lesson - see *What this round got wrong*:

| reported | what it was | fixed by |
| --- | --- | --- |
| `SET TRANSACTION` in a subtransaction | `rollbackOnError`'s savepoint made every isolation level impossible to set | `a89fcf3` |
| the decorated `message` | no undecorated copy of the server's text, so an anchored pattern could not match | `e413ae9`, adding `serverMessage` |
| `money` unregistered | `money[]` came back as a literal where `pg` gives an array - the only one of 44 array types that lost its shape | `285097e` |
| `startTransaction()` took no arguments | an isolated transaction cost two round trips, or bypassing the API | `4703ec4` - and then the adapter stopped using it, because the engine has to be the one sending `BEGIN`; see §4 |
| `postgresql://` dropped the database | `parseConnectionString` read the database out of a `postgres://` URL but not out of the longer spelling, which is the one Prisma's own docs use | `ffbd971` |
| an array parameter declared its element type | `float8[]`/`int4[]` written into the Parse message, so a parameter could not be compared with four of the six numeric array types - the same defect the earlier rounds fixed for scalars, one level down | `660aa54` |

**Where the two Prisma-shaped conversions live, decided three times.** This is worth reading in
full, because the final answer is the one the round started with and the two detours each cost a
day.

1. They began as a **pass over the result rows** - decode, then walk every cell and repair the ones
   Prisma cannot read. Two passes, and a separate rule for every array type.
2. They moved into **decoders on a `DataTypeMap`** copied from `GlobalTypeMap`: one pass, inside the
   decode, and an array inherits its element's rule. Better, and still the same thing.
3. They were then **deleted entirely** and reported upstream, on the reading that *a gap in
   PostgreJS is reported, not worked around*.
4. Step 3 was wrong, and the correction is the point: **there is no gap.** PostgreSQL's text for a
   `money` is `-$1,234.50` and for a `timetz` is `10:20:30+03`. Prisma's deserializer takes neither
   - and `pg` hands back exactly the same two strings, which is why `@prisma/adapter-pg` converts
   them in its own code (`normalize_money`, `normalize_timez`). The mismatch is between PostgreSQL
   and Prisma, not between PostgreJS and Prisma. Bending the driver to Prisma's expectations would
   push a Prisma-shaped decision onto every other caller of it.

So they are back, as step 2 had them: `src/type-map.ts`, two decoders on a copied `DataTypeMap`.
**Nothing in `src/` walks a row**, and the driver is left alone.

The two types, and what each conversion is:

| type | decoded value | what Prisma needs | the conversion |
| --- | --- | --- | --- |
| `money` | `-1234.5`, a number (a string at the `int64` extremes) - exact | a plain decimal string | `String()`, exact for everything the column holds |
| `timetz` | `"10:20:30+03"` - right, and what `pg` gives too | no offset, **already at UTC** | shift to UTC, then drop the offset |

**The `timetz` conversion is not the reference's, and that is deliberate.** `normalize_timez` is
`time.replace(/[+-]\d{2}(:\d{2})?$/, '')` - it drops the offset and keeps the wall clock, so
`10:20:30+03` and `10:20:30-05` become the same value. Prisma appends a `Z` to a `Time` on both
paths it reads one (`deserializeRawResults.ts:29-31` for `$queryRaw`,
`client-engine-runtime`'s `normalizeDateTime` for a model read, which appends it when it finds no
offset), so a value moved to UTC first is read as the right instant on either. Measured end to end
on a `DateTime @db.Timetz` field holding `10:20:30+03`, the instant `07:20:30Z`:

| | model read | `$queryRaw` |
| --- | --- | --- |
| `@prisma/adapter-pg` | `10:20:30Z` - out by the offset | `10:20:30Z` - out by the offset |
| `prisma-postgrejs` | **`07:20:30Z`** | **`07:20:30Z`** |

**`money` is narrower than it looks**, and the first write-up of it was too broad. On a *model* read
the query compiler emits `"m"::numeric` - verified by logging the SQL - so the column arrives as a
`numeric` and neither adapter's `money` handling is reached. The divergence is real only in raw SQL
that selects a bare `money` column, and there `@prisma/adapter-pg` throws `DecimalError` on every
negative and every four-figure value.

**Two findings of this round turned out to be wrong, and are corrected in place:**

- §3 said an empty array could not reach the adapter. It can - Prisma sends 13 of them in a single
  `create` over a model with every list type, under a `scalarType` this round had not observed
  (`unknown`).
- §1's `asyncErrorHandling` figure was measured with a contaminated arm. The isolated number is in
  that section now, and it depends on a setting that did not exist when the round started.

**One decision the report left open was settled by measurement rather than by choosing.** Decision 1
was framed as a trade between speed and staying inside the declared `ResultValue`. It is not a
trade: under any `DateStyle` other than `ISO` the text policy throws on every temporal column. See
§2.

## 0. Corrections to the starting assumptions

Four things in `CLAUDE.md` are wrong or stale, and two of them change the design.

| claim | what is actually true |
| --- | --- |
| `ArgType` is "Prisma's own enum" whose values map to OIDs | `ArgType` is a **struct**: `{ scalarType: ArgScalarType; dbType?: string; arity: 'scalar' \| 'list' }` (`driver-adapter-utils@7.10.0` `dist/index.d.ts:12-20`). `dbType` is a free string. See §3. |
| the interface sketch omits `AdapterInfo` | `SqlDriverAdapterFactory`, `SqlDriverAdapter` **and `Transaction`** all extend `AdapterInfo`, which requires `provider: Provider` and `adapterName: string` (`:7-10`, `:339`, `:382`). A `Transaction` without them produces a broken error message rather than a type error at runtime. |
| the peer floor is "whatever ships the fixes; 3.7.0 is published and does not contain them" | **PostgreJS 3.8.0 is published and contains all three fixes** (`git tag --contains cd52507` → `v3.8.0`). The floor is `postgrejs@^3.8.0`, with no working-copy dependency. |
| `PrismaPg` implements `SqlMigrationAwareDriverAdapterFactory`, so migrations are part of the deliverable | True of the type, irrelevant in practice: **nothing in `prisma` or `@prisma/client` calls `connectToShadowDb`**. See §5. |

And one thing nobody predicted: **in Prisma 7 the driver adapter is not an alternative to the
connection string, it is the only way to connect.** `url` in a `datasource` block is a hard schema
validation error at 7.10.0:

```
error: The datasource property `url` is no longer supported in schema files. Move connection URLs
for Migrate to `prisma.config.ts` and pass either `adapter` for a direct database connection or
`accelerateUrl` for Accelerate to the PrismaClient constructor.
```

That raises the ceiling for this package considerably. A driver adapter is no longer an opt-in
performance choice a few users make; at 7.x every non-Accelerate `PrismaClient` has one.

`PrismaClient({ adapter })` is confirmed GA: `@prisma/client@7.10.0` `runtime/client.d.ts:782` is
`adapter?: SqlDriverAdapterFactory`, and the string `driverAdapters` appears **0 times** in both
`runtime/client.d.ts` and `runtime/client.js`.

---

## 1. Is there anything left to win? - **Yes, and it is round trips**

The objection the TypeORM round raised is correct and is not answered by anything below:
**PostgreJS's rich decoding is worth nothing to Prisma.** §2 quantifies it - 23 of 74 types throw
`UnsupportedNativeDataType` in *both* adapters, and every type Prisma does accept it wants as a
primitive. `Interval`, `Range`, `Numeric`, the geometric family: all dead weight here.

What is left is Parse/Bind/Execute, the socket, the decode into primitives, and pooling. That was
measured end to end, through a real `PrismaClient`, against a live server.

### Method

One process, three `PrismaClient`s over one schema, alternating **inside** one run: every iteration
runs every workload through every adapter, and the order of the adapters is reversed on odd
iterations. The statistic is the **median of the per-iteration paired differences** (`postgrejs
minus adapter-pg`, same iteration), not the difference of two independent medians - paired
differencing is what makes the result survive a loaded machine, and this machine was loaded
(two sibling sessions were driving their own PostgreSQL containers throughout). `faster in n/101`
is a sign test over the same pairs.

The schema is the one **Prisma itself generates** (`prisma db push`), not a hand-written one - so
`DateTime` is `timestamp(3)` without time zone, which is Prisma's PostgreSQL default and therefore
the hot path.

Both PostgreJS settings that have no `pg` counterpart are **off** for every number in this
document - `asyncErrorHandling: false` and `rollbackOnError: false`. `pg` does not capture an async
stack trace across the `await` and does not wrap statements in savepoints, so leaving either on
would bill PostgreJS for a feature the other side does not offer. PostgreJS's own documentation says
as much about the first (`database-connection-params.ts:116-128`: *"which is also what makes an
apples-to-apples benchmark against a client that does not offer this fair"*). `rollbackOnError:
false` is separately mandatory for correctness (§4). The price of `asyncErrorHandling` is measured
below rather than assumed.

Two PostgreJS policies are measured, because the choice between them turns out to decide the whole
result (§2):

- **`pgjs/text`** - every temporal type is requested from the server as text via `fetchAsString`
  and handed on as a string, the way `adapter-pg` does. Strictly inside `ResultValue`.
- **`pgjs/dates`** - temporal types are decoded natively to JS `Date` and handed to the engine as
  `Date`. Outside the declared `ResultValue`, accepted by the engine, and lossless at the
  millisecond precision Prisma delivers (§2).

### Result

```
Prisma 7.10.0 · PostgreSQL 18.4 · loopback · 101 alternated iterations, 7 warmup
paired = per-iteration (postgrejs - adapter-pg), median of the pairs

## pk lookup (1 row)                       round-trip bound
    adapter-pg    0.788 ms      (baseline)
    pgjs          0.555 ms      1.42x      faster in 90/101

## mixed scalars (10k rows)                decode bound
    adapter-pg   17.006 ms      (baseline)
    pgjs         14.828 ms      1.15x      faster in 85/101

## int8/numeric/timestamp (10k rows)       representations differ most
    adapter-pg   18.793 ms      (baseline)
    pgjs         15.066 ms      1.25x      faster in 86/101

## tx write batch (20 inserts)             round-trip bound
    adapter-pg   14.179 ms      (baseline)
    pgjs          9.878 ms      1.44x      faster in 87/101

## 32 concurrent statements, pool of 4     what a pooled workload actually looks like
    adapter-pg    4.84 ms       (baseline)
    pgjs          1.95 ms       2.48x      faster in 60/61
```

**These are from `src/`, not from the prototype**, re-measured after the adapter was written. They
were reproduced six times over the session with the same shape and no row ever changed sign, which
matters because the absolute baselines drift by up to 25% between runs on a shared machine - the
same `adapter-pg` pk-lookup baseline came out at both 0.613 ms and 0.788 ms. That is why the
conclusions rest on the sign test rather than on the medians.

**The concurrent row was added late and is the one that changed the shape of the argument.** This
round's first concurrency measurement found pipelining "neutral through Prisma", which was wrong:
it benchmarked `findUnique` in a `Promise.all`, and Prisma's DataLoader coalesces those into **one**
adapter call, so the adapter never saw any concurrency. `findFirst`, `findMany` and `count` are not
coalesced - 32 client calls become 32 adapter calls - and there pipelining is worth 2.4x rather than
nothing.

### Where the difference comes from

The Prisma-level numbers do not say which layer moved, so the same comparison was run at the driver
level with no Prisma in the process, isolating each policy lever:

```
driver level, no Prisma · 61 alternated iterations

## pk lookup                                                    ## int8/numeric/timestamp (10k)
   pg + adapter-pg parsers              0.719 ms   baseline        6.907 ms   baseline
   pgjs fetchAsString + fixup           0.413 ms   -42.6%          8.956 ms   +29.7%
   pgjs fetchAsString, no fixup         0.375 ms   -47.8%          7.731 ms   +11.9%
   pgjs fetchAsString, no unknownTAS    0.375 ms   -47.8%          7.793 ms   +12.8%
   pgjs native decode                   0.543 ms   -24.4%          6.421 ms    -7.0%   (wins 55/61)
```

This is the whole story of the package in one table:

- **PostgreJS's protocol and socket path is genuinely faster than `pg`'s.** Native decode beats
  `pg` on the single-row lookup by 24% and on a 10k-row read of `int8`/`numeric`/`timestamp` by
  7.0% (55/61). That is the win, and it is real.
- **`fetchAsString` is a tax, not a lever.** Asking the server for text costs 13-14 points on bulk
  reads: the text form is bigger on the wire and PostgreJS's binary decoders are faster than not
  decoding at all. It is the *opposite* of the assumption in `CLAUDE.md` that `fetchAsString` would
  be the main advantage over `adapter-pg`'s parser-disabling. It is required for correctness on a
  handful of types (§2) and should be used **only** on those.
- **The post-decode fixup costs another 13-17 points** on bulk reads - a per-value `replace()` over
  10k rows. Most of it turned out to be unnecessary (§2, `timestamptz`).
- `unknownTypesAsString: true` is free within noise (`+11.9%` vs `+12.8%`, and the sign of the
  difference flips between runs), and is not optional.

### What `asyncErrorHandling` costs, and why the adapter should turn it off anyway

PostgreJS captures the caller's stack before the `await` so a thrown error points at application
code rather than an internal async frame. Node gives no such thing for free and `pg` does not offer
it, so it has to be off for the comparison above to mean anything. Isolated - same pool config,
only the flag differing, alternated, 201 iterations:

| workload | `false` | `true` | paired cost of `true` |
| --- | --- | --- | --- |
| burst of 20, pipelining **off** | 1.358 ms | 1.337 ms | **+0.9%, slower in 84/151 - noise** |
| burst of 20, pipelining **on** | 0.960 ms | 1.058 ms | **+11.1%, slower in 117/151** |

Which matches what the option's own doc comment predicts: the cost appears "when many calls are in
flight at once", and pipelining is what puts them there - so it is a function of the other setting
rather than a fixed price. Sequentially it is unmeasurable.

**An earlier pass reported 0.3 ms per call, and that was wrong.** That arm had a second pool of its
own competing for connections and a sixth position in the alternation; the isolated A/B above is the
number to trust. It is recorded here rather than quietly replaced because the mistake is the same
one this document warns about elsewhere - a benchmark arm that differs in more than the thing being
measured.

**Independently of benchmarking, the adapter should default it to `false`,** because under Prisma
the captured stack is paid for and then discarded. Measured by throwing a `42P01` through the
prototype with the flag both ways and inspecting what reaches the caller:

| | `asyncErrorHandling: true` | `asyncErrorHandling: false` |
| --- | --- | --- |
| error the user sees | `PrismaClientKnownRequestError`, `42P01` | identical |
| PostgreJS frames in the stack | **0** | **0** |
| frames pointing at the caller | 1 | 1 |

Prisma rewrites every adapter error into a `DriverAdapterError` carrying a plain `MappedError`
object (§6) and attaches its own callsite; the driver's `Error` instance, and the stack it went to
trouble to capture, never leave the adapter. Turning the capture off changes nothing a Prisma user
can observe. It should still be exposed as an option for anyone reaching past Prisma for
`$queryRaw` debugging.


So: **the win is round trips and the socket; the loss is conforming to Prisma's text
representations.** Which of the two dominates depends entirely on the temporal policy, and with
`pgjs/dates` PostgreJS wins every workload measured.

**This is not a decode win being re-converted away.** The 10k `pgjs/dates` win is a *decode* win and
the engine does re-convert it - but it re-converts `adapter-pg`'s strings too, and parsing
`"2024-01-02T10:20:30.123456+00:00"` in the engine is not cheaper than consuming a `Date`. The
round-trip wins (-35%, -30%) are untouched by any of this and are the part that would survive even
if the engine's conversion got faster.

---

## 2. Value representations, type by type

Measured by calling `queryRaw()` on the real `PrismaPg` adapter and on the prototype for the same
SQL, over 74 scalar and array types, and comparing `columnTypes` and `rows[0][0]`.

### The ceiling both adapters share

**23 of 74 types throw `UnsupportedNativeDataType` in both.** `fieldToColumnType` has no mapping
for them and the default branch throws for any OID below 16384 (`adapter-pg` `dist/index.js:291-296`):

```
"char"(18), point, lseg, path, box, polygon, line, circle, macaddr, macaddr8, interval,
tsvector, pg_lsn, jsonpath, int4range, numrange, tsrange, tstzrange, daterange, int8range,
point[], interval[], int4range[]
```

Every one of these is a type PostgreJS decodes richly - `Interval`, `Range`, `Point`, `Circle`,
`Line`, `Box`, `Path`, `Polygon`. **None of it can be delivered.** This is the single clearest
confirmation of the TypeORM round's objection, and it is not a divergence to fix: it is Prisma's
ceiling, identical for both adapters. An OID at or above 16384 (enum, composite, extension type)
falls through to `Text`, which is why `unknownTypesAsString: true` is mandatory - without it an
enum column arrives as a raw `Buffer`.

**`fieldToColumnType` agrees 74/74.** The port of `adapter-pg`'s switch is exact, including
`oid`→`Int64`, `money`→`Numeric`, `timetz`→`Time`, and the `>= 16384 → Text` fallback.

### What the engine actually accepts

`ResultValue` is `number | string | boolean | null | ResultValue[] | Uint8Array`, but the declared
type is not the constraint that matters. Feeding the engine each candidate representation through a
stub adapter gives the real contract:

| ColumnType | representation | engine yields | verdict |
| --- | --- | --- | --- |
| `DateTime` | `"2024-01-01T00:00:00+00:00"` (adapter-pg) | `2024-01-01T00:00:00.000Z` | ok |
| `DateTime` | `"2024-01-01 00:00:00+00"` (**server text, verbatim**) | `2024-01-01T00:00:00.000Z` | **ok - no fixup needed** |
| `DateTime` | `"2024-01-01 00:00:00"` (no offset) | `2023-12-31T21:00:00.000Z` | **silently local time** |
| `DateTime` | `new Date(...)` | `2024-01-01T00:00:00.000Z` | ok, **out of `ResultValue`** |
| `DateTime` | `"...00:00:00.123456+00"` (microseconds) | `...00:00:00.123Z` | **Prisma truncates to ms regardless** |
| `Time` | `"10:20:30"` | `1970-01-01T10:20:30.000Z` | ok |
| `Time` | `"10:20:30+00"` (server `timetz` text) | **`null`** | **silent data loss** |
| `Time` | `new Date(...)` | **`null`** | **silent data loss** |
| `Int64` | `"9007199254740993"` | `9007199254740993n` | ok |
| `Int64` | `9007199254740993` (number) | **`9007199254740992n`** | **silent precision loss** |
| `Int64` | `9007199254740993n` (BigInt) | **throws** `Cannot serialize value of type bigint as Int64` | fatal |
| `Numeric` | `"1234567890123456789.12"` | exact | ok |
| `Numeric` | `1234567890123456789.12` (number) | **`"1234567890123456800"`** | **silent precision loss** |
| `Double`/`Float` | `"1.5"` (string) | **`"1.5"`** | **silently stays a string** |
| `Boolean` | `"t"` (server text) | **`false`** | **silently wrong** |
| `Json` | `'{"a":1}'` (string) | `{a:1}` | ok |
| `Json` | `{a:1}` (parsed) | **throws** `Cannot serialize value of type object as Json` | fatal |
| `Int32` | `"42"` (string) | `42` | ok (coerced) |
| `Bytes` | `Uint8Array` / `Buffer` | bytes | ok |

The `Time`/`Date` behaviour is explained by the client's own deserializer, visible in
`@prisma/client@7.10.0` `runtime/client.js` (minified, function `st`):

```js
case "bigint":   return BigInt(t);
case "bytes":    return new Uint8Array(Buffer.from(t,"base64"));
case "decimal":  return new Decimal(t);
case "datetime":
case "date":     return new Date(t);
case "time":     return new Date(`1970-01-01T${t}Z`);
```

`new Date("1970-01-01T10:20:30+00Z")` is `Invalid Date`, hence the silent `null` for a `timetz`
that still carries its offset.

Three consequences settle the decode policy:

1. **`timestamptz` needs no fixup at all.** The engine parses the server's own `+00` offset form.
   `adapter-pg`'s `normalize_timestamptz` (`dist/index.js:310-312`) is not just unnecessary, it is
   **wrong on a non-UTC session** - it replaces whatever offset the server sent with `+00:00`
   instead of converting. Measured:

   | session `TimeZone` | server text | adapter-pg yields | true instant |
   | --- | --- | --- | --- |
   | `UTC` | `2024-01-01 00:00:00+00` | `2024-01-01T00:00:00Z` | `2024-01-01T00:00:00Z` |
   | `Europe/Istanbul` | `2024-01-01 03:00:00+03` | **`2024-01-01T03:00:00Z`** | `2024-01-01T00:00:00Z` |

   A three-hour error, silent. Passing the server text through unmodified is correct in both cases.
   **This is an upstream Prisma bug, not a PostgreJS one**, and it means this adapter would be more
   correct than the reference - which the differential harness has to be told about, or it will
   report it as our failure.

2. **`timestamp` (no time zone) *does* need the `+00:00` suffix**, since the engine otherwise reads
   the wall clock in the *client's* local zone. This is the common case, because Prisma's default
   PostgreSQL type for `DateTime` is `timestamp(3)` - verified by `prisma db push`, not by the docs.
   It is a string concat, not a regex.

3. **`Date` objects are accepted for `DateTime`/`Date` and lose nothing**, because Prisma truncates
   to milliseconds anyway. This is the `pgjs/dates` policy, and it is where the §1 bulk-read win
   comes from. It is out of the declared `ResultValue`, so it is a decision (§ Decisions), not a
   settled fact. `Time`/`timetz` must stay text under either policy.

### `DateStyle` settles the temporal policy, and it is not a trade

This round framed the temporal decode as a choice between speed and staying inside the declared
`ResultValue`. Measured later, it is not a choice.

Prisma's deserializer builds a `Date` from whatever string an adapter hands it. The server only
writes ISO under `DateStyle = ISO`; under the other three it writes `05/03/2024 06:07:08`,
`Tue 05 Mar 06:07:08 2024` or `05.03.2024 06:07:08`, and none of those parse. Measured over seven
settings, on `timestamp`, `timestamptz` and `date`:

| `DateStyle` | `adapter-pg` | text policy | binary policy |
| --- | --- | --- | --- |
| `ISO, MDY` / `ISO, DMY` / `ISO, YMD` | ok | ok | ok |
| `SQL, MDY` / `SQL, DMY` | **throws** `Invalid time value` | **throws** | ok |
| `Postgres, MDY` | **throws** | **throws** | ok |
| `German, DMY` | **throws** | **throws** | ok |

It is the *style* that breaks it, not the field order - ISO works with any order. The binary form
carries no formatting, so nothing in `DateStyle` can reach it.

So the binary policy is the correct one rather than the fast one - and it is now the only one. The
text policy shipped for a while as a `dateTimeAs: 'string'` option, a way back should a Prisma
release stop accepting a `Date`; it was implemented by rendering the decoded value, which is a
per-value rewrite, so it went with `src/type-map.ts` and the option is gone. If that day comes, the
thing to ask PostgreJS for is temporal text in ISO regardless of the session's `DateStyle` -
`fetchAsString` cannot supply it, because `4c1154b` makes the client read the server's text in the
style the server declares, which is exactly the style Prisma's engine cannot parse.

### `money` - decodable now, and the reference adapter cannot read it

When this round measured the type table, `money` was unregistered in PostgreJS: `money[]` came back
as the array literal in one string, the only one of 44 array types that lost its shape against
stock `pg`. That was written up upstream and fixed (`285097e`) - by asking the server what a minor
unit is, once per connection and only when a result actually contains a `money` column, since the
scale and symbol come from `lc_monetary` and no client can know them.

The adapter then does **not** put `money` in `fetchAsString`, which is where this round's first
prototype had a bug it inherited by copying. `normalize_money` in `@prisma/adapter-pg` is
`text.slice(1)`, which takes the first character off the server's rendering
(`@prisma/adapter-pg@7.10.0` `dist/index.js:319`):

| server text | `normalize_money` | valid decimal? |
| --- | --- | --- |
| `$12.34` | `12.34` | yes |
| `-$0.05` | `$0.05` | **no** - it took the minus sign |
| `$1,234.50` | `1,234.50` | **no** - the separators are still there |
| `-$1,234.50` | `$1,234.50` | **no** - both |

So in Prisma + `@prisma/adapter-pg`, **every negative and every four-figure `money` value throws
`DecimalError`**. The first pass of the type table missed it by testing only `12.34` and `1.00`,
which are the one shape that works.

Stringifying the decoded value is exact for every value a `money` column can hold, including the
int64 extremes, because PostgreJS promotes whatever a double cannot carry - so that is what the
adapter does, in `src/type-map.ts`. It loses the column's scale (`-1234.5`, not `-1234.50`), which
only the server knows and which Prisma's `Decimal` reads as the same value either way.

### The `fetchAsString` list, derived for Prisma

Only the types where PostgreJS's native value is not something the engine accepts:

```
int8 (20), numeric (1700), json (114), jsonb (3802), time (1083)
```

`money` and `timetz` were in this list in the first prototype, copied from the reference adapter.
Neither belongs: the server's text for `money` is `-$1,234.50`, and its text for `timetz` keeps the
offset Prisma cannot read. Asking for text makes both worse rather than better, which is why they
are upstream tasks instead.

`int8` is non-negotiable: PostgreJS decodes it to `number` (silent precision loss) or `BigInt`
(throws). `json`/`jsonb` are non-negotiable: parsed objects throw.

This list is **much shorter than the TypeORM round's** and overlaps it only partly - `interval`, the
range family and the geometric family are all absent here because Prisma cannot carry them at all.
Copying that list wholesale would be a 13-point performance loss for nothing.

### Arrays - where the actual work is

> **Superseded.** This section is what was true when the round measured it. Two things changed
> after it.
>
> First, PostgreJS's `313c71e` (2026-09-22) lets `fetchAsString` name an array column by its
> **element's** OID: `int8` asks for the elements of an `int8[]` as strings, an array with its
> nulls intact, rather than for the literal in one string, which is what naming `_int8` would do.
> That replaced five of the seven per-element fixups with a wire-level request - `int8[]`,
> `numeric[]`, `json[]`, `jsonb[]` and `time[]` - and made all five byte-identical to
> `@prisma/adapter-pg` instead of merely equivalent after the engine.
>
> Second, the two that remain - `money[]`, whose server text carries a currency symbol under
> `lc_monetary`, and `timetz[]`, whose offset has to come off - are handled by a decoder on a copied
> `DataTypeMap` (`src/type-map.ts`), which an array inherits from its element, so neither needs a
> rule of its own and the array literal is never parsed by hand. **No code in `src/` walks a result
> row.**
>
> The table below is therefore a record of what the engine accepts, not of what the adapter does.


`fetchAsString` is useless for arrays: it returns the whole array literal as one string. Every array
divergence has to be fixed element by element after decoding. Measured against `adapter-pg`:

| array type | `adapter-pg` | PostgreJS native | engine's verdict on the native value | fix |
| --- | --- | --- | --- | --- |
| `int8[]` | `["9007199254740993"]` | `[9007199254740993n]` | **throws** | `.map(String)` - exact |
| `json[]`, `jsonb[]` | `['{"a":1}']` | `[{a:1}]` | **throws** | `.map(JSON.stringify)` |
| `time[]` | `["10:20:30"]` | `[Date]` | **`[null]`** | format each element |
| `money[]` | `["1.00"]` | `"{$1.00}"` (one string) | wrong shape | parse literal, strip `$` |
| `numeric[]` | `["1.5"]` | `[1.5]` | accepted, **lossy past 2^53** | `.map(String)` |
| `date[]`, `timestamp[]`, `timestamptz[]` | `["2024-01-02T..."]` | `[Date]` | accepted, same value | none needed |
| `"char"[]` | **`"{a}"` (a raw string)** | `["a"]` | ours is right | none - a divergence in our favour |
| everything else (23 types) | — | — | identical | none |

`_char` is worth flagging: `adapter-pg` reports `CharacterArray` and hands back the unparsed literal
`"{a}"`, because `pg` has no parser registered for OID 1002. PostgreJS returns `["a"]`. Ours is
correct; the harness must not treat it as a regression.

---

## 3. Parameters - `argTypes` exists, and it does not help the way it looked like it would

**Settled by measurement: do not drive `BindParam(oid, value)` from `argTypes`.**

`SqlQuery.argTypes` is not an enum of types to map onto OIDs. It is
`{ scalarType: ArgScalarType; dbType?: string; arity: 'scalar' | 'list' }`, and the decisive fact is
what the *values* look like by the time the adapter sees them. Instrumenting a real `PrismaClient`
over a model with every Prisma scalar type and array type, 28 distinct `(scalarType, dbType, arity)`
triples were observed:

| scalarType | dbType | arity | JS value handed to the adapter |
| --- | --- | --- | --- |
| `string` | `TEXT` / `VARCHAR` / `UUID` / *(none, for enums)* | scalar, list | `string`, `string[]` |
| `int` | `INTEGER` | scalar | `number` |
| `bigint` | `BIGINT` / `INTEGER` / *(none)* | scalar, list | **`string`**, `string[]` |
| `decimal` | `DECIMAL` | scalar, list | **`string`**, `string[]` |
| `decimal` | `DOUBLEPRECISION` | scalar, list | `number`, `string[]` |
| `boolean` | `BOOLEAN` | scalar, list | `boolean`, `boolean[]` |
| `bytes` | `BYTEA` | scalar, list | **base64 `string`** |
| `json` | `JSONB` | scalar, list | **`string`** |
| `datetime` | `DATE` / `TIME` / `TIMETZ` / `TIMESTAMP` / `TIMESTAMPTZ` | scalar | **`Date`** |
| `datetime` | `TIMESTAMP` | list | `string[]` (ISO) |

**Prisma has already rendered everything to a primitive before the adapter sees it.** `bigint`,
`decimal` and `json` arrive as strings; `bytes` as base64. The only value that is not ready to send
is `Date`, and the only reason `dbType` is needed at all is to decide how to format it
(`DATE` → date only, `TIME`/`TIMETZ` → time only, everything else → date and time). That is exactly
what `adapter-pg`'s `mapArg` does (`dist/index.js:360-402`), and there is nothing to improve on.

Three policies were then run end to end against the live server - create, read-back, filter,
updateMany, array containment filter, and an interactive transaction, over 26 columns covering every
scalar and array type - and deep-compared against `adapter-pg`:

| policy | what it does | score |
| --- | --- | --- |
| `raw` | `mapArg`, then hand the value to PostgreJS untouched | **6/6** |
| `bind0` | `mapArg`, then wrap in `new BindParam(0, v)` | **6/6** |
| `oid` | `mapArg`, then `new BindParam(oidFor(argType), v)` | **0/6 - fails outright** |

`oid` fails on the first `timetz` parameter:

```
"10:20:30.123" has no time zone offset - give it one ("12:34:56+03"),
or pass a Date, whose own offset is used
```

and the reason generalises: **naming the OID forces PostgreJS's typed encoder, which is stricter
than the server's own text parser.** Prisma's values are already rendered for the server's parser,
so declaring a type can only reject values the server would have accepted. It never adds
information the server does not already have from the column.

This is a different answer from all three previous rounds, and for a good reason. Those rounds had
to guess the type because nothing told them; here nothing needs to be guessed, because the value
arrives pre-rendered. `argTypes` is used for two conversions and then discarded.

The shapes that broke in earlier rounds all pass under `raw`: `Date` into `timestamptz` and into
`timestamp`, JS arrays (`int4[]`, `text[]`, `uuid[]`, `bytea[]`, `jsonb[]`), `null`, `Buffer`,
`9007199254740993` as a big integer, `numeric` at 20 digits, and json.

> **Correction.** This section first said the `[]`-into-`text[]` case "cannot arise here, because
> Prisma sends `string[]` and an empty list filter is compiled without a bind". That is wrong, and
> it was wrong when written - a later probe found **13 empty arrays in a single `create`** over a
> model with every list type, one per empty list column. They also arrive under a `scalarType` this
> round had not observed anywhere else: **`unknown`**, which is in the union but absent from the
> 28-triple table above. It makes no difference to the outcome - the published PostgreJS 3.8.0
> already handles `[]` and `[null]` into any array type, verified against it directly - but the
> claim was a guess dressed as a conclusion, which is the failure this document is supposed to
> avoid. `49c045d` upstream fixes a narrower case that Prisma cannot produce: a *nested* array,
> typed from `value[0]` as `_int2vector`.

PostgreJS 3.8.0's two fixes - strings and `Date`s going out unspecified - are what make `raw` work.
On 3.7.0 the `Date` fix is absent and `timestamptz` parameters would be silently shifted.

---

## 4. Transactions

Read off the engine, not the docs. `@prisma/query-plan-executor@7.10.0` `dist/index.js:107947-107990`:

```js
if (tx.transaction.options.usePhantomQuery) {
  await withQuerySpanAndEvent(PHANTOM_COMMIT_QUERY(), tx.transaction, () => tx.transaction.commit());
} else {
  const query = COMMIT_QUERY();                         // { sql: 'COMMIT', args: [], argTypes: [] }
  await withQuerySpanAndEvent(query, tx.transaction, () => tx.transaction.executeRaw(query))
       .then(() => tx.transaction.commit(), err => tx.transaction.rollback().then(fail, fail));
}
```

- **`usePhantomQuery: false`** (what `adapter-pg` reports, `dist/index.js:740`): the engine sends
  literal `COMMIT` / `ROLLBACK` through `executeRaw`, then calls `commit()`/`rollback()` purely for
  cleanup - `adapter-pg`'s `commit()` only does `this.client.release()` (`:712-721`).
- **`usePhantomQuery: true`**: the engine calls `commit()`/`rollback()` and nothing else; the adapter
  issues the SQL itself.
- **`BEGIN` is the adapter's job either way.** There is no `BEGIN_QUERY` in the executor;
  `startTransaction()` issues it.

> **Superseded, and this was the round's most expensive wrong turn.** The recommendation below was
> acted on and shipped, and Prisma's own functional suite rejected it five tests at a time -
> `batching` asserts the query log, `tracing` asserts the span tree, and both count the word
> `COMMIT`. Under `usePhantomQuery: true` the engine logs the boundary as
> `-- Implicit "COMMIT" query via underlying driver`, so `BEGIN`, `COMMIT` and `ROLLBACK` are not
> in the query event or the `db.query.text` attribute that a user reads to see their transaction.
>
> It is also not cheaper, which was the argument for it. With `false` the engine sends `COMMIT`
> through `executeRaw` and then calls `commit()`, which only releases the connection: one round trip
> either way. The adapter reports **`usePhantomQuery: false`**, as the reference does.
>
> The "keeps `_transactionDepth` in step" half was the reasoning that made it look right, and it is
> backwards. `connection.startTransaction()` is what keeps bookkeeping of its own, and a `COMMIT`
> that goes past `connection.commit()` does **not** clear it: the next `startTransaction()` on that
> pooled connection fails with *cannot set transaction modes on a transaction that is already open*.
> `inTransaction` does go false - it reads the `ReadyForQuery` status - which is exactly what made
> the claim survive a check. It is a different flag from the one that refuses.
>
> So the adapter opens, commits and rolls back entirely through SQL and leaves PostgreJS's
> transaction API alone. `BEGIN ISOLATION LEVEL <level>` is still one statement, so the round-trip
> saving in §1 stands, and the `BEGIN` now appears in the log like every other statement.

**Recommendation: report `usePhantomQuery: true`** and drive PostgreJS's own
`startTransaction()`/`commit()`/`rollback()`. It costs no extra round trip (the same `COMMIT` goes
over the wire), and it keeps PostgreJS's `_transactionDepth` in step with the server instead of
letting a raw `COMMIT` string desynchronise it. The prototype does this and matches `adapter-pg` on
every transaction test.

**Isolation levels.** `IsolationLevel` is `'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ'
| 'SNAPSHOT' | 'SERIALIZABLE'`. `SNAPSHOT` never reaches the adapter - the engine rejects it first
(`#validateOptions`, `dist/index.js:108002-108005`), and both adapters produce the identical
`Transaction API error: Invalid isolation level: SNAPSHOT`. The other four arrive as the string and
are applied with `SET TRANSACTION ISOLATION LEVEL ${level}` after `BEGIN`.

**`rollbackOnError: false`, and the reason changed under us.**

When this round started it was a hard requirement: PostgreJS wrapped every statement inside a
transaction in its own savepoint, and `SET TRANSACTION ISOLATION LEVEL` is refused inside one, so
every isolation level Prisma asked for failed. That was reported upstream and **fixed** (`a89fcf3`),
and re-measured here: both settings now take an isolation level.

It is still fixed off, for a reason that was always the better one. The savepoint means a failed
statement is rolled back to and the transaction carries on - which is neither PostgreSQL's behaviour
nor `pg`'s. Measured, after one failed statement inside a transaction:

```
rollbackOnError: true   -> the next statement succeeds; COMMIT keeps the work either side of it
rollbackOnError: false  -> the next statement raises 25P02; COMMIT keeps nothing
pg                      -> the next statement raises 25P02; COMMIT keeps nothing
```

An adapter meant to be swapped in for `@prisma/adapter-pg` must not change that. The cost is the
second argument rather than the first: 20 statements in one transaction, 101 alternated iterations,
**23% more, about 55µs a statement, slower in 97 of 101**.

**The transaction's modes go on the `BEGIN`.** `startTransaction()` took no arguments when this
round started, so an isolated transaction cost either a second round trip or a raw `BEGIN ISOLATION
LEVEL ...` that left PostgreJS's own nesting counter out of step. Both were measured, and the gap
was written up upstream and filled (`4703ec4`): `startTransaction({ isolationLevel, readOnly,
deferrable })` now emits them on the BEGIN itself.

```
BEGIN; SET TRANSACTION ISOLATION LEVEL ...   0.740 ms   two round trips
BEGIN ISOLATION LEVEL ...                    0.500 ms   1.48x, faster in 195/201
```

Through Prisma, a short isolated transaction went from -5% to -15% against `adapter-pg` on that
change alone. The levels are mapped from a table rather than interpolated, so no caller string
reaches the SQL.

**`asyncErrorHandling: false` is the right default too**, for the reason given in §1: Prisma
discards the captured stack, so the capture costs CPU under concurrency and buys the user nothing.
Unlike `rollbackOnError` this one is a default rather than a requirement - expose it as an option.

**Savepoints.** `createSavepoint` / `rollbackToSavepoint` are required for nested interactive
transactions; `releaseSavepoint` is genuinely optional. The client refuses to nest without them:

```js
#n(t){ if(t.createSavepoint) return t.createSavepoint.bind(t);
       throw new ue(`Nested transactions are not supported by adapter "${t.adapterName}" (${t.provider}): createSavepoint is not implemented.`) }
#a(t){ return `prisma_sp_${t.savepointCounter++}` }
```

(`@prisma/client@7.10.0` `runtime/client.js`.) Names are generated by the client as
`prisma_sp_<n>` - always a safe identifier, which is why `adapter-pg` interpolates them raw. They
map straight onto PostgreJS's `savepoint()` / `rollbackToSavepoint()` / `releaseSavepoint()`, whose
own validator (`/^[a-zA-Z]\w*$/`) accepts them. Note the error message reads `adapterName` and
`provider` **off the `Transaction`** - another reason `Transaction` must carry `AdapterInfo`.

All of it verified end to end against `adapter-pg`: commit, rollback-on-throw, three isolation
levels, `SNAPSHOT` rejection, nested interactive transaction, nested rollback leaving the outer
transaction alive, and batch `$transaction([...])` - **9/9 identical**.

**Cursors do not arise.** The adapter interface has no streaming method; every read is a whole
result set. PostgreJS's portal lifetime is therefore not a constraint here.

---

## 5. Migrations and the shadow database - **not part of the deliverable**

`connectToShadowDb` is referenced in exactly four places in a full install: the two adapter
packages that define it, `driver-adapter-utils` that types it, and `query-plan-executor` (which
bundles copies of the adapters). **Neither `prisma` nor `@prisma/client` ever calls it.**

Confirmed by running it. `prisma db push` and `prisma migrate diff` at 7.10.0 take their connection
from `datasource.url` in `prisma.config.ts` and connect with the CLI's own built-in connector; the
`PrismaConfig` type (`@prisma/config@7.10.0` `dist/index.d.ts:144-197`) has **no `adapter` field at
all**, only `datasource?: { url?, shadowDatabaseUrl? }`. A `db push` against a fresh database
succeeded with no adapter in the picture.

So:

- **Do not implement `SqlMigrationAwareDriverAdapterFactory`.** Implement the plain
  `SqlDriverAdapterFactory`. Adding `connectToShadowDb` would be dead code that has to be kept
  working.
- **`executeScript(script)` is still needed** - it is on `SqlDriverAdapter`, not on the migration
  factory. PostgreJS's `Pool.execute()` runs multi-statement scripts natively, which is a better
  fit than `adapter-pg`'s naive `script.split(';')` (`dist/index.js:771`) - that splitter breaks on
  a semicolon inside a string literal or a dollar-quoted function body.
- **The README must say that `prisma migrate` needs a URL in `prisma.config.ts`**, separate from the
  adapter. Users will otherwise expect the adapter to cover it.

One operational note found the hard way: **`prisma migrate` refuses to run when it detects an AI
agent** and demands explicit user consent via `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`. Any CI
or test harness that shells out to `prisma db push` will hit this.

---

## 6. Errors

### The driver side maps almost exactly

`adapter-pg` decides an object is a database error with a structural check
(`dist/index.js:578-580`): `code`, `message`, `severity` must be strings, and `detail`, `column`,
`hint` must be strings or `undefined`. PostgreJS's `DatabaseError`
(`src/protocol/database-error.ts`) declares every one of those plus `table`, `constraint`, `schema`,
`position`, `where`, `dataType`. Measured over six error classes, field by field against `pg`:

| error | fields carried by both, identical |
| --- | --- |
| `23505` unique | `code`, `severity`, `message`, `detail`, `table`, `constraint`, `schema` |
| `23502` not null | `code`, `severity`, `message`, `detail`, `column`, `table`, `schema` |
| `42P01` no table | `code`, `severity`, `message`, `position` |
| `42703` no column | `code`, `severity`, `message`, `position` |
| `22P02` bad input | `code`, `severity`, `message`, `position` |
| `22003` overflow | `code`, `severity`, `message`, `detail` |

Every field `convertDriverError` reads has a source. Nothing is missing.

### The one real divergence: PostgreJS decorates `message`

`Connection._handleError` (`../postgrejs/src/connection/connection.ts:888-900`) appends a source
excerpt to `message` whenever `position` is set:

```
pg   : "column \"nosuchcol\" does not exist"
pgjs : "column \"nosuchcol\" does not exist\n    at line 1 column 8\n  1| select nosuchcol from \"User\"\n    .-------^"
```

Copying `mapDriverError` verbatim would therefore break **exactly one** case, and silently:

| code | how `adapter-pg` extracts | survives the decoration? |
| --- | --- | --- |
| `42703` `ColumnNotFound` | `/^column (.+) does not exist$/` | **no** - anchored `$`, yields `undefined` |
| `42P01` `TableDoesNotExist` | `message.split(' ').at(1)` | yes |
| `3D000`, `28000`, `28P01`, `42P04` | `split`-based | yes |
| `23505`, `23502`, `23503`, `23001` | read `detail` / `constraint` / `column`, not `message` | yes |

**Reported upstream and fixed** (`e413ae9`): `DatabaseError.serverMessage` now carries the text
exactly as PostgreSQL sent it, always set, and equal to `message` where nothing was decorated. The
mapping reads that rather than `message`, which is what keeps the column name in every
`ColumnNotFound` and keeps a caret diagram out of a `P2010`.

`message.split('\n')[0]` would also have worked and is what this round proposed; the property is
better because it does not require every consumer to know that the decoration is a suffix.

### Socket and TLS errors

`convertDriverError` also recognises raw socket errors (`ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`,
`ETIMEDOUT` with `syscall` and `errno` present) and a TLS error set. PostgreJS reports a dead
pooled connection as a `ConnectionLostError` with `code: '08006'` and the socket error as `cause` -
so the mapping has to look one level down, at `err.cause`, rather than at the top-level object, and
`08006` itself should map to `{ kind: 'ConnectionClosed' }`. This is the one place the error code
needs original work rather than a port.

### End to end

The prototype deliberately did **not** implement error mapping, and the consequence is visible:
`P2002` becomes a bare `23505`, `P2010` becomes a bare `42P01`. This is not a divergence to solve,
it is confirmation that the ~150-line port of `errors.ts` is load-bearing and must land with the
first commit, not after. `P2025` (record not found) matched without any adapter involvement,
because the engine derives it from a row count.

---

## 7. `getConnectionInfo()`

Called **once**, at client initialisation (verified by instrumenting it), and reaching the engine
via `#db.getConnectionInfo?.() ?? { supportsRelationJoins: false }`
(`query-plan-executor` `dist/index.js:111915`).

**`maxBindValues`** overrides the provider default in `#maxChunkSize()` (`:107571-107576`); the
PostgreSQL default is **32766** (`:107586`). It controls how long an `IN` list may get before the
engine splits the query. Demonstrated with `maxBindValues: 3` and a 7-element `IN`:

```
maxBindValues unset -> 1 statement,  IN ($1,$2,$3,$4,$5,$6,$7)
maxBindValues: 3    -> 6 statements: <<startTransaction>>, 4 chunked SELECTs, COMMIT
```

Note the chunks run inside an explicit transaction. **Leave it unset.** PostgreSQL's real limit is
65535 parameters (the protocol's int16 count) and PostgreJS imposes no lower one, so 32766 is
already conservative and correct.

**`schemaName`** is the schema the engine qualifies its generated SQL with. `adapter-pg` takes it
from its own `schema` option. This adapter should do the same, and should also accept it from the
connection string's `?schema=` since PostgreJS parses one.

**`supportsRelationJoins`** decides whether the query compiler may emit a single joined query
instead of one query per relation. Report **`true`** - PostgreSQL supports `LATERAL` joins and
`adapter-pg` reports `true` (`dist/index.js:783`). Honesty about what was measured: at 7.10.0 with
the `prisma-client-js` generator, a `findMany({ include })` produced **two** statements under both
`true` and `false`, and `relationLoadStrategy: 'join'` is not an accepted argument. The flag is read
by the WASM query compiler, which is not readable from here; it is currently latent for this
configuration. Reporting `true` matches the reference and costs nothing.

---

## 8. Peer range

The contract is `@prisma/driver-adapter-utils`'s `dist/index.d.ts`, diffed across every published
major and minor that matters:

| version | lines | `Uint8Array` in `ResultValue` | savepoints on `Transaction` | `RestrictViolation` / `InvalidInputValue` |
| --- | --- | --- | --- | --- |
| 6.19.3 | 387 | no | no | no |
| 7.0.0 - 7.1.0 | 387 | no | no | no |
| **7.2.0** - 7.4.2 | 391 | **yes** | no | no |
| **7.5.0** - 7.9.1 | 403 | yes | **yes** | no |
| **7.10.0** | 413 | yes | yes | **yes** |
| 8.1.0-dev.7 | 413 | yes | yes | yes |

**7.10.0 and 8.1.0-dev.7 are byte-identical.** 6.19.3 and 7.0.0 are byte-identical to each other -
the major bump did not touch this file.

So the range is set by three features, not by the major:

- `>= 7.2.0` to return `Uint8Array`/`Buffer` for `bytea`. Below it, `Bytes` would have to be a
  number array.
- `>= 7.5.0` for nested interactive transactions.
- `>= 7.10.0` to emit `RestrictViolation` (PostgreSQL `23001`) and `InvalidInputValue` (`22P02`).
  Below it those are unknown kinds and must fall through to `kind: 'postgres'`.

**Recommended floor: `@prisma/client` and `@prisma/driver-adapter-utils` `>= 7.10.0 < 9`.** It is
the only floor at which the full error vocabulary is available, and the contract is unchanged all
the way into 8.x-dev.

**The PostgreJS floor is `>=3.10.0 <4`.** 3.9.0 - published 2026-09-22, while this round was still
open - was the first release to carry `money` decoding, `serverMessage`, transaction modes on
`startTransaction()`, opt-in pooled pipelining and `fetchAsString` naming an array column by its
element type, four of which exist because this round reported them. The floor is one release higher
than that for one reason: `parseConnectionString` read the database out of a `postgres://` URL but
not out of `postgresql://`, which is the spelling Prisma's own documentation uses, so a connection
string that looked right silently landed in the wrong database. Fixed in `ffbd971`, which ships in
3.10.0.

Two cautions:

- `@prisma/adapter-pg` pins `@prisma/driver-adapter-utils` as an **exact `dependency`**, not a peer
  (`"@prisma/driver-adapter-utils": "7.10.0"`). Copying that would force a release per Prisma patch.
  A caret range as a peer dependency is the better shape for a third-party adapter, and is a
  decision below.
- The Prisma monorepo's `main` has been reorganised into `packages/2-sql/...` and
  `packages/9-public/@prisma/orm-target-postgres` - the 7.10.0 layout (`packages/adapter-pg`) is
  gone. **The contract file is unchanged, but the packaging around it is in motion for 8.x.** That
  affects the test-suite patch in §9 more than the adapter code.

---

## 9. A test oracle - Prisma's own functional suite, behind a five-hunk patch

**There is no published conformance package.** `@prisma/adapter-test-utils` and
`@prisma/driver-adapter-test-suite` do not exist on npm. `driver-adapter-utils` exports
`mockAdapter`, `mockAdapterFactory` and `mockMigrationAwareAdapterFactory`, but those are
reject-everything stubs for testing *Prisma*, not a conformance suite for an adapter.

**There is a real suite, and it is pluggable with a small patch.** At tag `7.10.0` the client's
functional suite holds **88 test-suite directories / 182 `tests.ts` files** and runs the whole matrix
against a chosen driver adapter. The adapter is selected by a closed enum and a hard-coded if-chain:

- `packages/client/tests/functional/_utils/providers.ts:10-24` - `enum AdapterProviders`
- `:33-40` - `adaptersForProvider[POSTGRESQL] = [JS_PG, JS_NEON]`
- `:42-53` - `relationModesForAdapter`
- `packages/client/tests/functional/_utils/setupTestSuiteClient.ts:181-295` - one `if` per adapter,
  ending in `throw new Error(\`No Driver Adapter support for ${driverAdapter}\`)`

Adding `js_postgrejs` is **five** hunks, not the four this round counted. The fifth is in
`setupTestSuiteEnv.ts`, in `getDbUrlFromFlavor`: a `match` over the same enum picks which
environment variable holds the server URL, and an adapter missing from it falls through to a
different variable and fails every test with `P1010`. The five: one enum member, one entry in
`adaptersForProvider`, one in `relationModesForAdapter`, one `if` branch that constructs the
adapter, and one `.with()` arm that points it at `TEST_FUNCTIONAL_POSTGRES_URI` - deliberately the
same server the reference adapter runs against, since the two runs are compared to each other.

What it does not cover: it is the *client's* suite, so it exercises the adapter only through
whatever SQL the engine happens to emit. It will not test error-field extraction directly, will not
cover the types Prisma cannot carry, and will not notice a representation that is wrong in the same
way for both adapters.

**And one trap that has to be disarmed before any of it means anything.** Jest keys a stored
snapshot by the full test name, and this suite's describe name carries the adapter label - so every
`toMatchSnapshot()` in the repository is recorded as `... (provider=postgresql, js_pg) <test> 1`,
and for a third-party adapter there is no entry at all. Jest's default for a missing snapshot is to
write it and pass. Those tests therefore compare this adapter **against itself** and cannot fail,
while the same test in the control run is compared against a recorded value: the runs are not
measuring the same thing, and the difference shows up as this adapter "winning" tests the reference
loses. It did, on the first full run - nine of them, every one an artefact.

`scripts/seed-suite-snapshots.mjs` copies each `js_pg` entry onto a `js_postgrejs` key before our
run, which turns those tests into what they should be here: this adapter's output checked against
the reference adapter's recorded output. The script also drops any `js_postgrejs` entries an
earlier run wrote, and the runner restores the snapshot files from git before the control run, so
neither run can inherit the other's leftovers.

**Build the differential harness as well.** It is what caught the `timestamptz` divergence, the
`_char` divergence and the `Time`-returns-`null` case in this round, none of which a pass/fail suite
would have surfaced. It is cheap: run the same `PrismaClient` calls against `PrismaPg` and against
this adapter in one process and deep-compare, normalising autoincrement ids.

Also worth mirroring: `adapter-pg`'s own unit tests, `packages/adapter-pg/src/__tests__/` -
`conversion.test.ts`, `errors.test.ts`, `pg.test.ts`. Three files, and they are the closest thing to
a specification of the parts the client suite does not reach.

### Running it

`npm run test:prisma-suite`, or `scripts/run-prisma-suite.sh` directly. It clones the tag into
`$WORK_DIR` (default `$TMPDIR/prisma-postgrejs-suite`), applies the patch, installs and builds the
monorepo with the pnpm version it pins, copies `build/` and PostgreJS's dependency closure into the
checkout's root `node_modules`, and runs the matrix twice. `SKIP_INSTALL=1` re-runs in minutes;
`ONLY='<jest name pattern>'` narrows it while iterating.

Three things it does not do, deliberately:

- **It does not symlink this repository into the checkout.** `postgrejs` and its dependencies are
  copied, because a symlink would make them resolve out of this repository's flat `node_modules`
  rather than the checkout's, and the resolution path is the one thing that must be identical
  between the two runs. Dependencies the checkout already has are left alone for the same reason:
  replacing its `tslib` would change the control run too.
- **It does not ship an expected-failure list.** The tag does not pass its own suite on every
  PostgreSQL version, and a pinned list would be wrong on the next machine. The control run
  measures the baseline instead, and `compare-suite-runs.mjs` fails on exactly one condition: a
  test this adapter loses that the reference wins.
- **It does not run in CI.** It clones the Prisma monorepo and installs several GB. It is a tool to
  run before a release, not on every push.

One operational note: the suite creates a database per test-suite configuration through Prisma
Migrate, and Migrate refuses to run under an AI agent without the user's explicit consent
(`packages/migrate/src/utils/ai-safety.ts`, which detects `CLAUDECODE` among others). The script
does not carry that consent - it has to be passed in as
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`, in the user's own words. A human running it by hand
needs nothing.

### What it found

Tag 7.10.0, PostgreSQL 18.4, 191 of 263 suite files selected for `provider=postgresql`:

| | `@prisma/adapter-pg` | `prisma-postgrejs` |
| --- | --- | --- |
| passed | 1251 | 1251 |
| failed | 81 | 82 |

The 81 shared failures are the checkout's own: inline snapshots that expect the CI's `/client/...`
path, which no local clone has. They are identical in both runs, which is the entire reason the
control run exists rather than a hand-written expected-failure list.

**Nothing this adapter loses that the reference wins**, as of the last run. Two tests were on that
list and both are gone:

- `typed-sql/postgres-lists :: Decimal - input` - an array parameter went out declared `float8[]`,
  so `numeric[] = $1` was `42883`. A real client defect, fixed upstream in `660aa54`.
- `issues/TML-1664 :: returns P2007 …` - its setup runs a two-statement `$executeRawUnsafe`. The
  adapter's own gap, fixed here; the reasoning is below and it took two passes to get right.

The 82nd failure is `issues/10229`, which the reference never runs: it is skipped for all five of
Prisma's own driver adapters, and `js_postgrejs` is not on that list. Not a regression by the
comparison's definition, and not the adapter's behaviour either - the seventh patch hunk.

**The remaining one is the reference adapter inheriting a `pg` quirk, and it was nearly reported as
a PostgreJS defect.** The contract is explicit about which method takes what:
`executeRaw(params: Query)` is *"Execute a query"*, and `executeScript(script: string)` is
*"Execute **multiple** SQL statements separated by semicolon"* (`driver-adapter-utils@7.10.0`
`dist/index.d.ts:297-324`). Prisma has a method for scripts, and `$executeRawUnsafe` is not it.

It works through `@prisma/adapter-pg` because `pg` picks its protocol from whether the caller
happened to pass parameters: `requiresPreparation()` returns false when `values` is absent
(`pg@8.23.0` `lib/query.js:53-57`), and `submit()` then sends a simple `Query` instead of
Parse/Bind/Execute. So the same call silently loses its prepared statement and its per-statement
error boundary, and gains the right to carry several commands - decided by something the caller did
not think they were choosing. PostgreJS uses the extended protocol for `query()` and has `execute()`
for scripts, which is the distinction the Prisma contract itself draws.

That reasoning is sound as far as it goes, and it is where this round stopped - "the way to run
several statements is the method named for it". It is wrong, and what makes it wrong takes one
grep: **`@prisma/client` never calls `executeScript`.** The string does not appear in
`runtime/client.js`. So the contract's separation does not exist on any path a user can reach:
`$executeRaw` is the only raw-exec API Prisma offers, and both a statement and a script arrive at
`executeRaw`. "Use the other method" is advice about a method nobody can call.

PostgreJS is still right on both counts - `query()` is the extended protocol, `execute()` is for
scripts, and a `pg`-style switch decided by whether the caller happened to pass parameters is the
wrong way to choose. The layer that sees both sides is the adapter, and choosing was its job all
along.

**How it chooses took two attempts, and the first was wrong in a way worth keeping.** It asked the
server: send the statement as itself, and if PostgreSQL answers *cannot insert multiple commands
into a prepared statement*, send it again through `execute()`. That is exact - no guessing - and it
costs nothing until it fires, because Parse fails before Execute and nothing has run. It is also
unusable inside a transaction, where the refusal aborts the transaction and the retry comes back
`25P02 current transaction is aborted`: a worse error than the one it replaced.

So the choice is made by reading the statement instead, before anything is sent: one pass, skipping
`'...'`, `E'...'`, `"..."`, `$tag$...$tag$`, `--` and nested `/* */`.

**The idea that this needed a splitter *from* the driver was wrong twice over - neither client has
one.** `pg` does not split; it hands the whole string to the server in a simple `Query` message and
lets the server parse it. PostgreJS's `execute()` does exactly the same (`_execute` →
`sendQueryMessage` → `FrontendMessageCode.Query`) and counts the `CommandComplete`s that come back.
Nobody splits SQL because nobody needs to: only a layer that must choose a protocol *before* sending
needs the answer in advance.

Checked against the server rather than against belief: 53 hand-written cases and 300 generated ones
run through the extended protocol, with PostgreSQL's `42601` as ground truth. Full agreement, in
both directions. The one place the scanner and the server part company is under
`standard_conforming_strings = off`, on SQL that is malformed anyway (`select 'a\'; select 2`,
which the server calls an unterminated string) - an error either way.

**The scanner is no longer here.** It was written in this package, and the same reasoning that says
the choice belongs to the adapter says the *answer* belongs to the driver: anything routing between
`query()` and `execute()` needs it, and nothing about it is Prisma-shaped. It was offered upstream
with the corpus and the measurements, and landed as `isMultiStatement()` in PostgreJS 3.11.0 - which
is the peer floor now. `test/B-live/multi-statement.spec.ts` stayed: 34 of the cases run against a
live server on every test run, because this adapter's routing is only as good as that answer.

The count comes back as the sum over the script, which is what "the number of affected rows" asks
for. `@prisma/adapter-pg` answers `0` for any script, because `pg` hands it an *array* of results
and an array has no `rowCount`. Worth knowing that the contract agrees a script's count is not
worth much: `executeScript` returns `Promise<void>`. It is just that nothing calls it - the only
reference to it outside the adapters that implement it is
`query-plan-executor/src/logic/adapter.ts:135`, which re-wraps it for the same interface.

**Five more were real and are fixed**, which is the return on building this at all - nothing else in
this round would have found them. `batching` counts `COMMIT` in the query log and `tracing` compares
the span tree, and both failed on `usePhantomQuery: true` (§4). No unit test, no differential test
and no amount of reading the `.d.ts` would have raised it: the option is a boolean with no doc
comment, and both values work.

**Six more were the harness, not the adapter**, and each cost a full run to recognise:

- the stored-snapshot keys, above - 9 tests that this adapter appeared to *win*;
- `_utils/relationMode/conditionalError.ts`, where the expected error text is also keyed by adapter
  label, so six tests compared against the literal string `TODO: add error for
  provider=postgresql and driverAdapter=js_postgrejs`. That is the sixth patch hunk;
- and two in `compare-suite-runs.mjs` itself: keying on the leaf test name merged four different
  `DbNull` tests into one, which then reported as a regression against itself, and
  `decimal/precision` puts a per-run random seed in its test names.

The lesson is worth more than the tests: **a suite parameterised by adapter label has oracles keyed
by that label**, and every one of them silently reads as an adapter difference. Snapshots, error
tables, and the comparison's own keys all had to be dealt with before a single number from it meant
anything.

---

## 10. Proposed layout

Following the sibling split.

```
src/
  index.ts                 PrismaPostgreJS factory (SqlDriverAdapterFactory - NOT migration-aware)
  adapter.ts               SqlDriverAdapter: queryRaw, executeRaw, executeScript,
                           startTransaction, getConnectionInfo, dispose
  transaction.ts           Transaction over one acquired Connection; usePhantomQuery: false,
                           BEGIN/COMMIT/ROLLBACK as statements, savepoints delegated to PostgreJS
  queryable.ts             shared base: mapArg, perform, result assembly
  column-types.ts          fieldToColumnType - the OID -> ColumnType switch (74 cases verified)
  conversion.ts            the fetchAsString list: which columns are asked for as the server's
                           own text rather than decoded
  type-map.ts              buildTypeMap: a DataTypeMap copied from GlobalTypeMap, with decoders
                           for the two types Prisma wants in a shape PostgreSQL does not write
  params.ts                mapArg: Date -> text by dbType, base64 -> Buffer, list recursion
  errors.ts                DatabaseError/ConnectionLostError -> MappedError; first-line message
  options.ts               PrismaPostgreJSOptions (schema, pipeline, onPoolError);
                           forces rollbackOnError: false, defaults asyncErrorHandling: false

test/
  A-common/                no server: fieldToColumnType over every OID, mapArg over every
                           (scalarType, dbType, arity) triple, error mapping from synthetic
                           DatabaseErrors, options normalisation
  B-live/                  one server: the 74-type table from §2 as an explicit expected-value
                           table, the parameter round-trip table from §3, transaction semantics
                           from §4, getConnectionInfo effects from §7
  C-differential/          same Prisma calls through this adapter and @prisma/adapter-pg,
                           deep-compared, with the known-and-intended divergences listed
                           explicitly (timestamptz on a non-UTC session, "char"[])
scripts/
  run-prisma-suite.sh      clone prisma/prisma at the pinned tag, apply the five-hunk patch
                           from §9, run the functional matrix twice - js_pg as the control and
                           js_postgrejs - and diff the two
  compare-suite-runs.mjs   parse both jest logs and report only what differs; fails on a test
                           this adapter loses that the reference wins, and on nothing else
  seed-suite-snapshots.mjs copy the reference's stored snapshots onto this adapter's keys, so a
                           snapshot test compares the two rather than comparing ours to itself
```

---

## Effort estimate - and what it actually took

> **Written before the work, kept for calibration.** The actuals: **1178 lines of `src/`** against
> the ~1100 estimated, and **2068 lines of test** against the ~1250 estimated. Three things it got
> wrong: `errors.ts` came in at 251 lines rather than ~180 because `ConnectionLostError` needed more
> than a port; the "biggest risk" named below turned out not to be a risk at all (see Decisions, 1);
> and the test estimate was low by two thirds, almost all of it in `B-live`, because every
> measurement in §2 and §3 turned into a pinned expectation rather than a spot check.
>
> The **array element fixups** line - the one item marked *medium* on the grounds that `money[]`
> meant parsing an array literal by hand - is no lines at all now, and the reason is not that it
> got cheaper. Five of the seven became a `fetchAsString` request; the other two turned out to be
> work this package is not allowed to do, and are upstream tasks instead. The estimate priced a
> fix before anyone had asked whose fix it was.

## Effort estimate

| part | size | confidence | why |
| --- | --- | --- | --- |
| factory / adapter / transaction | ~250 lines | **high** | the prototype already does all of it and passes 9/9 transaction tests and 6/6 parameter tests |
| `fieldToColumnType` | ~90 lines | **high** | verified 74/74 against the reference; a mechanical transcription |
| `mapArg` | ~40 lines | **high** | a port of a function whose entire input space (28 triples) has been enumerated |
| scalar fixups + `fetchAsString` list | ~40 lines | **high** | measured type by type |
| **array element fixups** | ~80 lines | **medium** | 6 array types need work, each straightforward, but `money[]` means parsing an array literal by hand and the literal grammar has quoting and escapes |
| `errors.ts` | ~180 lines | **medium** | a port of a known file, plus original work for `ConnectionLostError`/`08006` and the `message` first-line fix |
| pooling, `dispose`, error events | ~60 lines | medium | PostgreJS's `Pool` differs from `pg.Pool`; `'destroy'`/`'error'` carry `ConnectionLostError` and need routing to an `onPoolError` callback |
| test/A-common | ~400 lines | high | no server, table-driven |
| test/B-live | ~600 lines | high | the §2 and §3 tables are already written, as measurements |
| test/C-differential | ~250 lines | high | the harness in this round is most of it |
| `scripts/run-prisma-suite.sh` + patch | ~150 lines | **low** | the hunks are identified at tag 7.10.0, but the monorepo layout has already moved on `main` (§8), so the patch will need re-deriving per tag. It came in at ~330 lines across a runner, a comparer and a snapshot seeder, and the estimate had no idea the last of those would be needed at all |

Roughly **2100 lines**, of which ~900 is test. Mechanical: the column-type switch, `mapArg`, the
adapter/transaction skeleton. Unknown: none that would change the design.

**The biggest risk is not technical.** It is that the only argument for the package is throughput,
and the measured advantage - `-32%` on a round-trip-bound query, `-12%` on bulk reads -
depends on the `pgjs/dates` policy, which puts a JS `Date` into a slot the published `ResultValue`
type does not include. It works, it is lossless at Prisma's own precision, and the engine's own
deserializer handles it - but it is undeclared behaviour, and a Prisma minor could tighten it
without warning. Under the strictly-in-contract `pgjs/text` policy the package still wins the
round-trip cases decisively and **loses 17-20% on bulk reads**, which is a much weaker sales pitch.

> The escape hatch named there no longer exists: a text policy can only be built by rewriting
> decoded values, and this package does not do that. If Prisma tightens `ResultValue`, the fix is a
> PostgreJS decode mode, not an option here.

Second risk: Prisma 8's packaging reorganisation (§8). The contract file is unchanged, which is the
thing that matters, but the test-suite integration will need maintenance per major.

---

## Decisions that need you

Two of the four this round raised have since been settled by measurement rather than by choosing,
and are written up as settled above. They are listed here with what settled them, because a reader
who saw the earlier version will look for them.

1. ~~**Temporal decode policy - A or B?**~~ **Settled: binary, and it is the only one.** Not a
   trade between speed and the declared contract - the text policy throws on every temporal column
   on any server whose `DateStyle` is not `ISO` (§2). It shipped for a while as an option for the
   day a Prisma release stops accepting a `Date`; it was implemented by rewriting decoded values,
   so it came out with `src/type-map.ts`. If that day comes, the ask is on PostgreJS.
2. ~~**Match `adapter-pg` on `timestamptz`, or stay correct?**~~ **Dissolved by 1.** The binary
   decode yields the instant whatever the session zone is, so there is nothing left to choose.
3. ~~**Peer dependency shape**~~ **Settled.** `@prisma/driver-adapter-utils` at `>=7.10.0 <9` and
   `postgrejs` at `>=3.10.0 <4`, both as peer dependencies. The driver floor moved up one release
   after 3.9.0, for the `postgresql://` fix (§8).
4. **`postgrejs` as a peer or a regular dependency** - still open, and probably just copy the
   siblings.

And one the implementation raised that this round did not:

5. **Is `pipeline: true` the right default?** It is what the adapter ships. It is neutral on
   sequential work, worth 2.4x on concurrent work, and verified safe - error attribution is correct
   on a shared connection, and `acquire()`d connections (which is every transaction) are never
   shared. The argument against is that it is a behaviour `pg` does not have, so a user migrating
   gets concurrency semantics they did not ask for. `pipeline: false` is one option away.

## Recommendation: proceed - and it was, so here is what it cost

The question this round existed to answer was whether anything survives Prisma's flattening. It
does, and it is specifically what CLAUDE.md said it would have to be: protocol and round-trip work,
not decoding. That held up when the adapter was written and measured again from `src/`.

- **PostgreJS's protocol path is faster**, end to end through a real `PrismaClient`: 1.42x on a
  primary-key lookup, 1.15-1.25x on 10k-row reads, 1.44x on a twenty-insert transaction, 2.48x on
  32 concurrent statements over a pool of four. Every row reproduced with the same sign across six
  runs.
- **The seam was as cheap as advertised** - 413 lines of `.d.ts`, byte-identical from 7.10.0 into
  8.x-dev. The adapter is **1178 lines of `src/`** against the 845 of the reference, and a good
  part of that difference is comments: both convert the same two Prisma-shaped representations,
  this one in a `DataTypeMap` rather than in a pass over the rows.
- **Correctness was demonstrated rather than argued**: 324 tests of its own, all passing, of which a
  differential suite runs every case through `@prisma/adapter-pg` as well and compares - **plus
  Prisma's own functional suite** with the reference adapter as the control (§9). The differential
  suite found a divergence nobody had predicted (`executeRaw` on a `SELECT`, where `pg` reports the
  row count and PostgreJS reports nothing), and Prisma's suite found one this round had recommended
  on purpose (§4). Two of the three cases where the adapters disagree on a value are ones where
  **the reference is silently wrong**: `timetz` on any non-zero offset, and `money` in raw SQL.
- **The addressable surface got bigger while nobody was looking.** At Prisma 7 a driver adapter is
  not an optimisation, it is the connection mechanism: `url` in a `datasource` block is a validation
  error.

### What this round got wrong, kept in one place

Worth reading before trusting any single number in a future round.

- **Pipelining called "neutral"** on a benchmark that could not show it, because `findUnique` in a
  `Promise.all` is coalesced by Prisma into one adapter call. The workload, not the option, was the
  problem.
- **`asyncErrorHandling` priced at 0.3 ms/call** from an arm that had its own second pool and a
  different position in the alternation. The real figure is ~11% of a concurrent burst, and only
  when pipelining is on.
- **Empty arrays declared impossible** (§3) on reasoning rather than measurement. Prisma sends 13
  of them in one `create`.
- **Three "PostgreJS gaps" filed that were not gaps**, all three caught by the user rather than by
  me, and all three withdrawn. A multi-statement `executeRaw` (Prisma has `executeScript`; `pg` only
  accepts it by silently downgrading its protocol), `timetz` (this adapter is the *correct* one),
  and `money` (`605e91e` shipped for it, and did not need to).

  Two tells were there to be read. The first: each file's own conclusion was "the client should
  probably change nothing", which is a finished argument rather than a task - **a report whose
  recommendation is "do nothing" belongs in this repository's documentation, not in another
  repository's queue.** The second is the general form of it, and is the thing to carry forward:
  **PostgreSQL's text is not Prisma's representation, and `pg` is in exactly the same position.**
  Whenever `pg` has the same problem and `@prisma/adapter-pg` solves it in its own code, the work is
  the adapter's by definition - there is nothing for a driver to fix, and a driver that "fixed" it
  would be worse for everyone not using Prisma. That test would have caught all three, and it takes
  one grep of `adapter-pg`'s source.
- **And then the same mistake from the other side.** Having withdrawn the multi-statement report as
  "nobody's defect", this round left it at that for a day - a user-facing difference, documented as
  deliberate, with the justification "Prisma puts scripts on `executeScript`". One grep of
  `runtime/client.js` shows the client never calls `executeScript`, so the justification was empty
  and the work was the adapter's (§9). *Not the driver's* and *nobody's* are different conclusions,
  and the first does not imply the second: when `pg` and PostgreJS both behave correctly and the two
  adapters still differ, what is left is the adapter.
- **The conversions were moved three times before landing where they started** (§2): a row pass, a
  `DataTypeMap`, deleted, then the `DataTypeMap` again. Only the second move was informative.
- **`money` tested only at `12.34`**, which is the single shape `@prisma/adapter-pg`'s
  `normalize_money` handles - so a bug that throws on every negative and every four-figure value
  went unnoticed through the whole type table. And then the opposite error: the bug was written up
  as affecting every `money` read, when a model read never reaches it - the query compiler emits
  `"m"::numeric`. One `$on('query')` log settled it.
- **`pipeline()` recommended for the transaction open** when PostgreSQL takes the modes on the
  `BEGIN` and needs no pipelining at all.
- **`usePhantomQuery: true` recommended** (§4) on an argument about PostgreJS's internal
  bookkeeping that is the opposite of true, and without checking what the option does to the query
  log. Prisma's own suite rejected it five tests at a time.

Four of the five are the same failure: a conclusion reached by reasoning where a measurement was
available and cheap.

And one that is not a measurement failure at all, kept here because it cost a day's work twice:

- **"Remove the fixups" was read as "move them somewhere tidier".** Asked to get rid of the
  per-value corrections, this round rewrote them from a pass over the result rows into decoders
  registered on a copied `DataTypeMap` - PostgreJS's own extension point, one pass instead of two,
  arrays inheriting from their elements. It was a better implementation of the wrong thing. The
  rule is *a gap in PostgreJS is reported, not worked around*, and where a rewrite is registered has
  no bearing on whether it is one. Both were then deleted and filed upstream, which is what should
  have happened the first time. The tell was there to be read: the argument for keeping them was
  always "the reference adapter does the same in its own code", which is an argument about what is
  normal, not about whose job it is.

### What is still open

- **One upstream fix not yet in a build here.** `660aa54` stops an array parameter declaring its
  element type; the working copy's `build/` predates it, so `typed-sql/postgres-lists :: Decimal -
  input` still fails in Prisma's suite until it is rebuilt. `../postgrejs/.claude/` is otherwise
  empty - nothing of this round's is outstanding.
- **`decimalAsString` (`605e91e`) is now redundant here, and that is worth saying out loud.** It
  was added because this round reported `money` as a client gap; the gap was mine to fill, and
  `src/type-map.ts` fills it. The option is not wrong - an exact decimal string is a reasonable
  thing for any caller to want, and it carries the column's scale, which a conversion here cannot -
  but this adapter does not need it.
- **`issues/10229` fails for a reason that is not the adapter's**, and the seventh patch hunk is not
  written. The test connects with an invalid URL from the schema and expects `P1001`; a driver
  adapter takes its URL from the adapter, so nothing fails and `expect.assertions(2)` sees none.
  Prisma lists all five of its own adapters in that test's `skipDriverAdapter`; `js_postgrejs` is
  not on the list. Same class as the snapshot keys and the `conditionalError` table.
- **A temporal text policy, if Prisma ever stops accepting a `Date`.** There is no way to ask this
  client for ISO temporal text independent of `DateStyle`, and building one here would mean
  rewriting decoded values. Nothing needs it today, so it is not filed - recorded so the next round
  does not rediscover it from scratch (§2).
- **Question 9 is finished.** The suite runs, and what it found is in §9. It is the only thing in
  this round that caught the `usePhantomQuery` mistake.
