/**
 * The workloads, the schema and the client factory - one definition, imported
 * by both the latency runner and the memory worker.
 *
 * It has to be one definition. The timing pass and the memory pass must run
 * the identical call, or the two columns of a single row in the report are
 * describing different work; a workload written out twice drifts the first
 * time one copy is edited.
 *
 * ## Two levels, which is this package's own wrinkle
 *
 * Every scenario is defined twice over, and both are measured:
 *
 * - **engine** - through a real `PrismaClient`. What a user gets.
 * - **adapter** - through the `SqlDriverAdapter` alone, no Rust engine, no
 *   `ColumnType` flattening, running the *same SQL the engine emits*.
 *
 * The reason is a rule this repository already relies on elsewhere: a shared
 * cost large enough to matter compresses the ratio towards 1. The engine is
 * exactly such a cost - it sits on both sides of every call and it is not
 * small. Measured only through it, a real difference in protocol handling can
 * read as no difference at all, and there is no way to tell that from the
 * adapter genuinely being no better.
 *
 * So the two levels answer two different questions, and both are worth having:
 *
 * - adapter: is PostgreJS's protocol handling actually cheaper? (the premise)
 * - engine: does any of it survive to the caller? (the promise)
 *
 * The adapter-level SQL is not a paraphrase. It was captured from
 * `PrismaClient`'s own `query` event and is re-checked by `describeScenarios()`,
 * so it cannot drift from what the engine really sends.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaPostgreJS } from '../build/index.js';
import { PrismaClient } from './generated/client.js';

export const CONTROL = '@prisma/adapter-pg';
export const DRIVER = 'prisma-postgrejs';

/** The two levels every scenario is measured at. */
export const LEVELS = ['engine', 'adapter'];

export const CONN = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database: process.env.BENCH_DATABASE ?? 'prisma_bench',
};

export const SEED_ROWS = 10_000;

/** Rows in the per-row payload tables - the spread half of the pair. */
export const PAYLOAD_ROWS = 5000;

/** Values in the packed payloads. */
export const ARRAY_VALUES = 100_000;

/**
 * The schema, as Prisma generates it - not hand-written.
 *
 * Taken verbatim from `prisma migrate diff --from-empty --to-schema` over
 * `benchmark/schema.prisma`, because the types Prisma picks are the hot path:
 * `DateTime` is `TIMESTAMP(3)`, not `timestamptz`, and a benchmark against
 * hand-chosen column types measures a schema nobody actually has.
 *
 * Applied as raw SQL rather than by `prisma db push` so the harness needs no
 * migration engine and no consent prompt; `schema.prisma` and this list are
 * kept in step by `npm run bench -- --check-schema`.
 */
export const DDL = [
  `drop table if exists "User", "Wide", "Wr", "Row", "Num", "Ident", "Payload", "PayloadW" cascade`,
  `CREATE TABLE "User" (
     "id" SERIAL NOT NULL,
     "email" TEXT NOT NULL,
     "name" TEXT,
     "active" BOOLEAN NOT NULL DEFAULT true,
     "score" DOUBLE PRECISION NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "User_pkey" PRIMARY KEY ("id"))`,
  `CREATE TABLE "Wide" (
     "id" SERIAL NOT NULL,
     "big" BIGINT NOT NULL,
     "amount" DECIMAL(20,4) NOT NULL,
     "at" TIMESTAMP(3) NOT NULL,
     CONSTRAINT "Wide_pkey" PRIMARY KEY ("id"))`,
  // unlogged: WAL costs both sides the same and is big enough to hide what
  // does not.
  `CREATE UNLOGGED TABLE "Wr" (
     "id" SERIAL NOT NULL,
     "v" TEXT NOT NULL,
     "n" INTEGER NOT NULL,
     CONSTRAINT "Wr_pkey" PRIMARY KEY ("id"))`,
  `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`,
  `insert into "User" ("email","name","active","score","createdAt")
     select 'u'||g||'@e.com',
            case when g%7=0 then null else 'name '||g end,
            g%5<>0, g*1.5,
            timestamp '2024-01-01 00:00:00' + (g || ' seconds')::interval
     from generate_series(1,${SEED_ROWS}) g`,
  `insert into "Wide" ("big","amount","at")
     select 9007199254740993::int8 + g,
            (g*1.2345)::decimal(20,4),
            timestamp '2024-01-01 00:00:00' + (g || ' seconds')::interval
     from generate_series(1,${SEED_ROWS}) g`,
  `CREATE TABLE "Row" (
     "id" SERIAL NOT NULL, "name" TEXT NOT NULL, "email" TEXT NOT NULL,
     "active" BOOLEAN NOT NULL, "score" DOUBLE PRECISION NOT NULL,
     "amount" DECIMAL(12,2) NOT NULL, "big" BIGINT NOT NULL,
     "at" TIMESTAMP(3) NOT NULL, "note" TEXT,
     CONSTRAINT "Row_pkey" PRIMARY KEY ("id"))`,
  `CREATE TABLE "Num" (
     "id" SERIAL NOT NULL, "v" DOUBLE PRECISION NOT NULL,
     CONSTRAINT "Num_pkey" PRIMARY KEY ("id"))`,
  `CREATE TABLE "Ident" (
     "id" SERIAL NOT NULL, "u" UUID NOT NULL,
     CONSTRAINT "Ident_pkey" PRIMARY KEY ("id"))`,
  `CREATE TABLE "Payload" (
     "id" INTEGER NOT NULL, "blob" BYTEA NOT NULL,
     "ints" INTEGER[], "floats" DOUBLE PRECISION[],
     CONSTRAINT "Payload_pkey" PRIMARY KEY ("id"))`,
  `CREATE UNLOGGED TABLE "PayloadW" (
     "id" SERIAL NOT NULL, "blob" BYTEA, "ints" INTEGER[],
     CONSTRAINT "PayloadW_pkey" PRIMARY KEY ("id"))`,
  // Uncompressed and out of line. `repeat('x', n)` and a sequential int4[]
  // compress to nothing, and TOAST decompression is not what is being
  // compared - it is a cost the server pays identically for both clients and
  // large enough to bury what is not.
  `ALTER TABLE "Payload" ALTER COLUMN "blob" SET STORAGE EXTERNAL,
                         ALTER COLUMN "ints" SET STORAGE EXTERNAL,
                         ALTER COLUMN "floats" SET STORAGE EXTERNAL`,
  `ALTER TABLE "PayloadW" ALTER COLUMN "blob" SET STORAGE EXTERNAL,
                          ALTER COLUMN "ints" SET STORAGE EXTERNAL`,

  `insert into "Row" ("name","email","active","score","amount","big","at","note")
     select 'name '||g, 'r'||g||'@e.com', g%3<>0, random()*1e6,
            (random()*1e6)::decimal(12,2), 9007199254740993::int8 + g,
            timestamp '2024-01-01 00:00:00' + (g || ' seconds')::interval,
            case when g%4=0 then null else repeat('n', 40) end
     from generate_series(1,${PAYLOAD_ROWS}) g`,
  // Full width on purpose: eight bytes against seventeen significant digits
  // is the whole point of the comparison, and round numbers hide it.
  `insert into "Num" ("v") select random() * 1e9 from generate_series(1,${PAYLOAD_ROWS}) g`,
  `insert into "Ident" ("u") select gen_random_uuid() from generate_series(1,${PAYLOAD_ROWS}) g`,
  `analyze "User"`,
  `analyze "Wide"`,
  `analyze "Row"`,
  `analyze "Num"`,
  `analyze "Ident"`,
];

/**
 * The one `Payload` row, seeded from here rather than from SQL.
 *
 * Generating it server-side would make the values the server's choice; these
 * have to use the whole width of their types or the binary format's advantage
 * is measured against numbers that happen to be short. The blob is random for
 * the same reason - `repeat('x', n)` is compressible even with storage set to
 * external on some paths.
 */
export async function seedPayload(connection) {
  const blob = Buffer.allocUnsafe(4 * 1024 * 1024);
  for (let i = 0; i < blob.length; i += 4)
    blob.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
  const ints = Array.from(
    { length: ARRAY_VALUES },
    () => Math.floor(Math.random() * 2 ** 31) - 2 ** 30,
  );
  const floats = Array.from(
    { length: PAYLOAD_ROWS },
    () => Math.random() * 1e9,
  );
  await connection.query(
    `insert into "Payload" ("id","blob","ints","floats") values (1,$1,$2,$3)`,
    { params: [blob, ints, floats] },
  );
}

/** The columns the engine selects, spelled as it spells them. */
const USER_COLS = ['id', 'email', 'name', 'active', 'score', 'createdAt']
  .map(c => `"public"."User"."${c}"`)
  .join(', ');

const WIDE_COLS = ['id', 'big', 'amount', 'at']
  .map(c => `"public"."Wide"."${c}"`)
  .join(', ');

const ROW_COLS = [
  'id',
  'name',
  'email',
  'active',
  'score',
  'amount',
  'big',
  'at',
  'note',
]
  .map(c => `"public"."Row"."${c}"`)
  .join(', ');

const int = { scalarType: 'int', arity: 'scalar' };
const bigint = { scalarType: 'bigint', arity: 'scalar' };
const string = { scalarType: 'string', arity: 'scalar' };

const q = (sql, args = [], argTypes = []) => ({ sql, args, argTypes });

/**
 * Prisma renders `take`/`skip` as `bigint` parameters carrying strings - see
 * the captured SQL in `describeScenarios()`. Reproducing that exactly matters:
 * a parameter's declared type is what decides whether the statement can reuse
 * a prepared plan.
 */
const LIMIT = ['1', '0'];

let pk = 0;
const nextPk = () => (pk = (pk % SEED_ROWS) + 1);

let rowId = 0;
const nextRow = () => (rowId = (rowId % PAYLOAD_ROWS) + 1);

export const SCENARIOS = [
  {
    name: 'primary-key lookup',
    group: 'Read',
    note: '1 row of 6 columns',
    iters: 50,
    pairs: 101,
    engine: db => db.user.findUnique({ where: { id: nextPk() } }),
    adapter: db =>
      db.queryRaw(
        q(
          `SELECT ${USER_COLS} FROM "public"."User" WHERE ("public"."User"."id" = $1 AND 1=1) LIMIT $2 OFFSET $3`,
          [nextPk(), ...LIMIT],
          [int, bigint, bigint],
        ),
      ),
  },
  {
    name: '10k rows, mixed scalars',
    group: 'Read',
    note: `${SEED_ROWS} rows of 6 columns: int, text, bool, float8, timestamp(3)`,
    iters: 2,
    pairs: 101,
    engine: db => db.user.findMany(),
    adapter: db =>
      db.queryRaw(
        q(
          `SELECT ${USER_COLS} FROM "public"."User" WHERE 1=1 OFFSET $1`,
          ['0'],
          [bigint],
        ),
      ),
  },
  {
    name: '10k rows, int8/numeric/timestamp',
    group: 'Read',
    note: `${SEED_ROWS} rows of the three types whose representations differ most`,
    iters: 2,
    pairs: 101,
    engine: db => db.wide.findMany(),
    adapter: db =>
      db.queryRaw(
        q(
          `SELECT ${WIDE_COLS} FROM "public"."Wide" WHERE 1=1 OFFSET $1`,
          ['0'],
          [bigint],
        ),
      ),
  },
  {
    name: 'point read',
    group: 'Read',
    note: '1 row of 9 columns, mixed types',
    iters: 50,
    pairs: 101,
    engine: db => db.row.findUnique({ where: { id: nextRow() } }),
    adapter: db =>
      db.queryRaw(
        q(
          `SELECT ${ROW_COLS} FROM "public"."Row" WHERE ("public"."Row"."id" = $1 AND 1=1) LIMIT $2 OFFSET $3`,
          [nextRow(), ...LIMIT],
          [int, bigint, bigint],
        ),
      ),
  },
  {
    name: 'page of 200',
    group: 'Read',
    note: '200 rows of 9 columns, mixed types',
    iters: 20,
    pairs: 101,
    engine: (db, i) =>
      db.row.findMany({
        orderBy: { id: 'asc' },
        skip: (i % 10) * 200,
        take: 200,
      }),
    adapter: (db, i) =>
      db.queryRaw(
        q(
          `SELECT ${ROW_COLS} FROM "public"."Row" WHERE 1=1 ORDER BY "public"."Row"."id" ASC LIMIT $1 OFFSET $2`,
          ['200', String((i % 10) * 200)],
          [bigint, bigint],
        ),
      ),
  },
  {
    name: 'uuid of 5k rows',
    group: 'Read',
    note: `${PAYLOAD_ROWS} rows of 1 value: sixteen bytes against thirty-six characters`,
    iters: 10,
    pairs: 101,
    engine: db => db.ident.findMany(),
    adapter: db =>
      db.queryRaw(
        q(
          `SELECT "public"."Ident"."id", "public"."Ident"."u" FROM "public"."Ident" WHERE 1=1 OFFSET $1`,
          ['0'],
          [bigint],
        ),
      ),
  },
  {
    name: 'float8 of 5k rows',
    group: 'Read',
    note: `${PAYLOAD_ROWS} rows of 1 value: eight bytes against seventeen significant digits`,
    iters: 10,
    pairs: 101,
    engine: db => db.num.findMany(),
    adapter: db =>
      db.queryRaw(
        q(
          `SELECT "public"."Num"."id", "public"."Num"."v" FROM "public"."Num" WHERE 1=1 OFFSET $1`,
          ['0'],
          [bigint],
        ),
      ),
  },
  {
    name: 'float8[] of 5k in one row',
    group: 'Read',
    note: `1 row holding 1 array of ${PAYLOAD_ROWS} values - the same values as the row above`,
    iters: 10,
    pairs: 101,
    engine: db =>
      db.payload.findUnique({ where: { id: 1 }, select: { floats: true } }),
    adapter: db =>
      db.queryRaw(
        q(
          `SELECT "public"."Payload"."id", "public"."Payload"."floats" FROM "public"."Payload" WHERE ("public"."Payload"."id" = $1 AND 1=1) LIMIT $2 OFFSET $3`,
          [1, ...LIMIT],
          [int, bigint, bigint],
        ),
      ),
  },
  {
    name: 'int4[] of 100k in one row',
    group: 'Read',
    note: `1 row holding 1 array of ${ARRAY_VALUES} values that use the whole type`,
    iters: 3,
    pairs: 61,
    engine: db =>
      db.payload.findUnique({ where: { id: 1 }, select: { ints: true } }),
    adapter: db =>
      db.queryRaw(
        q(
          `SELECT "public"."Payload"."id", "public"."Payload"."ints" FROM "public"."Payload" WHERE ("public"."Payload"."id" = $1 AND 1=1) LIMIT $2 OFFSET $3`,
          [1, ...LIMIT],
          [int, bigint, bigint],
        ),
      ),
  },
  {
    name: 'bytea of 4MB',
    group: 'Read',
    note: '1 row holding 1 value of 4 MB',
    iters: 3,
    pairs: 61,
    engine: db =>
      db.payload.findUnique({ where: { id: 1 }, select: { blob: true } }),
    adapter: db =>
      db.queryRaw(
        q(
          `SELECT "public"."Payload"."id", "public"."Payload"."blob" FROM "public"."Payload" WHERE ("public"."Payload"."id" = $1 AND 1=1) LIMIT $2 OFFSET $3`,
          [1, ...LIMIT],
          [int, bigint, bigint],
        ),
      ),
  },
  {
    name: '20 inserts in one transaction',
    group: 'Write',
    note: '1 interactive transaction holding 20 single-row inserts',
    iters: 1,
    pairs: 101,
    // Outside the clock. The table has to start empty or the inserts slow
    // down as it grows, which would be measured as the client slowing down.
    setup: (db, level) =>
      level === 'engine'
        ? db.wr.deleteMany()
        : db.executeRaw(q('DELETE FROM "public"."Wr" WHERE 1=1')),
    engine: db =>
      db.$transaction(
        async tx => {
          for (let i = 0; i < 20; i++) {
            await tx.wr.create({ data: { v: `x${i}`, n: i } });
          }
        },
        // Prisma aborts an interactive transaction on a wall clock, and the
        // default is 5s. The memory pass runs a 1ms sampler and `--trace-gc`
        // over the same work, which is enough on a loaded machine to push one
        // of these past it - a run died with `P2028` after a transaction took
        // 12s. The guard is client-side and identical for both adapters, so
        // raising it removes an instrument artifact rather than hiding a cost;
        // the transaction itself is timed, and that timing is unaffected.
        { timeout: 120_000, maxWait: 120_000 },
      ),
    adapter: async db => {
      const tx = await db.startTransaction();
      for (let i = 0; i < 20; i++) {
        await tx.queryRaw(
          q(
            `INSERT INTO "public"."Wr" ("v","n") VALUES ($1,$2) RETURNING "public"."Wr"."id", "public"."Wr"."v", "public"."Wr"."n"`,
            [`x${i}`, i],
            [string, int],
          ),
        );
      }
      // What the engine does under `usePhantomQuery: false`: it sends the word
      // itself, then calls the method.
      await tx.executeRaw(q('COMMIT'));
      await tx.commit();
    },
  },
  {
    name: '32 concurrent count(), pool of 4',
    group: 'Concurrency',
    note: '32 calls at once over a pool of 4',
    iters: 1,
    pairs: 61,
    pooled: true,
    engine: db =>
      Promise.all(Array.from({ length: 32 }, () => db.user.count())),
    adapter: db =>
      Promise.all(
        Array.from({ length: 32 }, () =>
          db.queryRaw(
            q(
              `SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE 1=1 OFFSET $1) AS "sub"`,
              ['0'],
              [bigint],
            ),
          ),
        ),
      ),
  },
  {
    name: '32 concurrent findFirst, pool of 4',
    group: 'Concurrency',
    note: '32 calls at once over a pool of 4',
    iters: 1,
    pairs: 61,
    pooled: true,
    engine: db =>
      Promise.all(
        Array.from({ length: 32 }, () =>
          db.user.findFirst({ where: { id: nextPk() } }),
        ),
      ),
    adapter: db =>
      Promise.all(
        Array.from({ length: 32 }, () =>
          db.queryRaw(
            q(
              `SELECT ${USER_COLS} FROM "public"."User" WHERE "public"."User"."id" = $1 LIMIT $2 OFFSET $3`,
              [nextPk(), ...LIMIT],
              [int, bigint, bigint],
            ),
          ),
        ),
      ),
  },
  {
    name: '32 concurrent findMany, pool of 4',
    group: 'Concurrency',
    note: '32 calls at once over a pool of 4, 1 row each',
    iters: 1,
    pairs: 61,
    pooled: true,
    engine: db =>
      Promise.all(
        Array.from({ length: 32 }, () => db.user.findMany({ take: 1 })),
      ),
    adapter: db =>
      Promise.all(
        Array.from({ length: 32 }, () =>
          db.queryRaw(
            q(
              `SELECT ${USER_COLS} FROM "public"."User" WHERE 1=1 ORDER BY "public"."User"."id" ASC LIMIT $1 OFFSET $2`,
              LIMIT,
              [bigint, bigint],
            ),
          ),
        ),
      ),
  },
];

/**
 * The clients, one pair per level.
 *
 * `asyncErrorHandling: false` and `rollbackOnError: false` for every number.
 * `pg` offers neither, so leaving either on bills PostgreJS for a feature the
 * other side does not have - `rollbackOnError` is forced off by the adapter
 * anyway, and `asyncErrorHandling` is its default. Stated here because this is
 * where someone editing the harness will look for it.
 */
export function openClients(level, pooled = false) {
  const max = pooled ? 4 : 10;
  const factories = {
    [CONTROL]: () => new PrismaPg({ ...CONN, max }),
    [DRIVER]: () => new PrismaPostgreJS({ ...CONN, max }),
  };

  const opened = [];
  const dbs = {};
  for (const [name, makeAdapter] of Object.entries(factories)) {
    const adapter = makeAdapter();
    if (level === 'engine') {
      const client = new PrismaClient({ adapter, log: [] });
      opened.push(() => client.$disconnect());
      dbs[name] = client;
    } else {
      // Connected lazily below, because `connect()` is async and this is not.
      dbs[name] = { factory: adapter };
    }
  }

  return {
    dbs,
    async ready() {
      if (level !== 'adapter') return dbs;
      for (const name of Object.keys(dbs)) {
        const adapter = await dbs[name].factory.connect();
        opened.push(() => adapter.dispose());
        dbs[name] = adapter;
      }
      return dbs;
    },
    async close() {
      for (const fn of opened.reverse()) await fn().catch(() => undefined);
    },
  };
}

/**
 * What each scenario really sends, captured rather than restated.
 *
 * The engine's SQL comes off `PrismaClient`'s own `query` event, and the
 * adapter's off the `SqlQuery` the scenario builds. Printing both side by side
 * is how the adapter level is kept honest: if the engine's SQL changes with a
 * Prisma release, the two stop matching and the mismatch is visible rather
 * than silently measuring different work.
 */
export async function describeScenarios(scenarios = SCENARIOS) {
  const captured = [];
  // Its own client, because `openClients` deliberately runs with `log: []` -
  // logging is not free and must not be on while anything is being timed.
  const client = new PrismaClient({
    adapter: new PrismaPostgreJS({ ...CONN, max: 4 }),
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query', e => captured.push(e.query));

  const rows = [];
  for (const scenario of scenarios) {
    if (scenario.setup) await scenario.setup(client, 'engine');
    // After setup, not before: its SQL is not part of what is measured.
    captured.length = 0;
    await scenario.engine(client, 0);
    const engineSql = captured.filter(s => s !== 'COMMIT' && s !== 'ROLLBACK');

    const adapterSql = [];
    const recorder = {
      queryRaw: query => (adapterSql.push(query.sql), Promise.resolve()),
      executeRaw: query => (adapterSql.push(query.sql), Promise.resolve(0)),
      startTransaction: () => Promise.resolve(recorderTx),
    };
    const recorderTx = {
      queryRaw: recorder.queryRaw,
      executeRaw: recorder.executeRaw,
      commit: () => Promise.resolve(),
    };
    await scenario.adapter(recorder, 0);

    rows.push({
      name: scenario.name,
      engine: [...new Set(engineSql)],
      adapter: [...new Set(adapterSql.filter(s => s !== 'COMMIT'))],
    });
  }
  await client.$disconnect();
  return rows;
}

/**
 * How many prepared statements each adapter leaves on the backend.
 *
 * The explanation the README gives for the ordinary rows - PostgreJS names and
 * caches a statement per connection, so each distinct SQL is parsed and
 * planned once - is a claim about the server, and it is counted on the server
 * rather than argued from either client's source. A pool of one, so the
 * session and the connection are the same thing and `pg_prepared_statements`
 * is about the queries just issued.
 *
 * `@prisma/adapter-pg` passes `name: this.pgOptions?.statementNameGenerator?.(query)`
 * (its `dist/index.js`), so without that option the statement is unnamed and
 * `pg` does not prepare it. That is a default rather than a limitation, which
 * is why the figure is reported as one.
 */
export async function countPreparedStatements() {
  const counted = { queries: 4 };
  for (const [name, makeAdapter] of [
    [CONTROL, () => new PrismaPg({ ...CONN, max: 1 })],
    [DRIVER, () => new PrismaPostgreJS({ ...CONN, max: 1 })],
  ]) {
    const client = new PrismaClient({ adapter: makeAdapter(), log: [] });
    await client.user.findFirst({ where: { id: 1 } });
    await client.user.count();
    await client.wide.findMany({ take: 3 });
    const rows = await client.$queryRawUnsafe(
      `select count(*)::int as n from pg_prepared_statements`,
    );
    counted[name] = rows[0].n;
    await client.$disconnect();
  }
  return counted;
}

export const scenariosMatching = only =>
  only ? SCENARIOS.filter(s => s.name.includes(only)) : SCENARIOS;
