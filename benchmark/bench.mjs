/**
 * The latency pass: both adapters, both levels, one process.
 *
 * ## Why paired differencing rather than two medians
 *
 * The machine this runs on is shared, and absolute figures drift by up to 25%
 * between runs - the same `@prisma/adapter-pg` baseline has come out at both
 * 0.613 ms and 0.788 ms in one session. Two independent medians would carry
 * that drift straight into the comparison.
 *
 * So the two clients are run **inside** each iteration, the order reversed on
 * odd iterations, and the statistic is the median of the per-iteration
 * differences. Drift that moves both clients together cancels; what is left is
 * the difference. Beside it, a sign test over the same pairs counts only which
 * client won, discarding by how much - which is the part that survives a noisy
 * machine intact.
 *
 * Nothing is sampled inside the timed window. Polling `process.memoryUsage()`
 * there costs more than some of these calls and lands unevenly on the two
 * clients; memory is a separate pass, in child processes, for that reason.
 *
 * Usage:
 *   node benchmark/bench.mjs                      everything
 *   node benchmark/bench.mjs --scenario=primary    one, by substring
 *   node benchmark/bench.mjs --level=adapter       one level
 *   node benchmark/bench.mjs --pairs=11            fewer, while iterating
 *   node benchmark/bench.mjs --heap-pairs=3        fewer memory children
 *   node benchmark/bench.mjs --no-memory           timings only
 *   node benchmark/bench.mjs --describe            print the SQL and exit
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Connection } from 'postgrejs';
import {
  CONN,
  CONTROL,
  countPreparedStatements,
  DDL,
  describeScenarios,
  DRIVER,
  LEVELS,
  openClients,
  scenariosMatching,
  seedPayload,
} from './scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEAP_WORKER = join(HERE, 'heap-worker.mjs');
const exec = promisify(execFile);
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => process.argv.includes(`--${name}`);

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The probability of a split at least this lopsided from a fair coin, two
 * tailed. Exact rather than normal-approximated: at 61 pairs the tail is
 * small enough that the approximation misreports it by orders of magnitude.
 */
function signTest(wins, n) {
  const k = Math.min(wins, n - wins);
  let logTail = -Infinity;
  const logAdd = (a, b) =>
    a === -Infinity
      ? b
      : b === -Infinity
        ? a
        : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));
  let logC = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    logTail = logAdd(logTail, logC);
  }
  return Math.min(1, 2 * Math.exp(logTail - n * Math.LN2));
}

/**
 * The benchmark's own database, created if it is not there.
 *
 * It used to be assumed, so `npm run bench` on a fresh checkout failed with
 * `3D000` and no hint of which database it meant. Nothing here writes to a
 * database anyone else uses: the name is `BENCH_DATABASE`, and the schema is
 * dropped and rebuilt on every run.
 */
async function createDatabase() {
  const c = new Connection({ ...CONN, database: 'postgres' });
  await c.connect();
  try {
    await c.execute(`create database "${CONN.database}"`);
    console.log(`  created ${CONN.database}`);
  } catch (e) {
    if (e.code !== '42P04') throw e;
  } finally {
    await c.close();
  }
}

/** Applies the schema, seeds the payload tables, and reports the server. */
async function applyDdl() {
  await createDatabase();
  const c = new Connection({ ...CONN });
  await c.connect();
  for (const statement of DDL) await c.execute(statement);
  await seedPayload(c);
  // Recorded rather than written into the report by hand. The README said
  // "PostgreSQL 18.4" for two server upgrades; a version nobody measured is
  // the cheapest number in the document to get wrong.
  const { rows } = await c.query(`select current_setting('server_version')`);
  await c.close();
  return rows[0][0];
}

/** One timed unit: `iters` calls, divided. */
async function timedBatch(scenario, level, db, i) {
  const started = process.hrtime.bigint();
  for (let k = 0; k < scenario.iters; k++)
    await scenario[level](db, i * scenario.iters + k);
  return Number(process.hrtime.bigint() - started) / 1e6 / scenario.iters;
}

/**
 * Memory for one adapter, one scenario, one level - in a process of its own.
 *
 * Not an option. Measured in this process, with both adapters already up, the
 * baseline sits above everything a client allocated once and kept, so a pool,
 * a decoder table and a grown send buffer all fall outside the window. That is
 * most of the difference on the payload scenarios, which is where the whole
 * argument for this package is.
 */
async function memoryInChild(scenario, level, adapter) {
  const { stdout } = await exec(
    process.execPath,
    ['--expose-gc', '--trace-gc', HEAP_WORKER, adapter, scenario.name, level],
    { env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  const measured = JSON.parse(
    stdout.split('\n').find(line => line.startsWith('{')),
  );
  return { ...measured, reclaimedKb: reclaimedBetweenMarks(stdout) };
}

/**
 * What the same client still holds once the calls stop. One run per adapter
 * per level rather than one per pair: it costs a six-second wall-clock wait,
 * and unlike the high-water it does not move between pairs.
 */
async function idleHeapInChild(scenario, level, adapter) {
  const { stdout } = await exec(
    process.execPath,
    ['--expose-gc', HEAP_WORKER, adapter, scenario.name, level, 'idle'],
    { env: process.env },
  );
  return JSON.parse(stdout).idleHeldKb;
}

/**
 * What every collection handed back while the measured calls were running,
 * added up, from `--trace-gc`'s `before (capacity) -> after (capacity) MB`.
 *
 * A second instrument on the same quantity, arrived at a completely different
 * way. It is carried rather than reported: `--trace-gc` cannot see a `Buffer`
 * at all, so the two agree on the narrow rows and must not agree on `bytea` -
 * and a run where they stop disagreeing there is a run where the sampled
 * figure has quietly gone blind to external memory too.
 */
function reclaimedBetweenMarks(stdout) {
  const mark = Number(/MARK (\d+)/.exec(stdout)?.[1]);
  const end = Number(/END (\d+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(mark) || !Number.isFinite(end)) return 0;
  const line =
    /^\[\d+:0x[0-9a-f]+\]\s+(\d+) ms: \S+.*?([\d.]+) \([\d.]+\) -> ([\d.]+) \(/;
  let total = 0;
  for (const text of stdout.split('\n')) {
    const found = line.exec(text);
    if (!found) continue;
    const at = Number(found[1]);
    if (at >= mark && at <= end) total += Number(found[2]) - Number(found[3]);
  }
  return total * 1024;
}

/**
 * The memory pass for one scenario at one level: children, alternated and
 * paired exactly like the timings, and counted the same way.
 *
 * The split is taken on what a call allocates, because that is the column the
 * report leads with. The high-water is counted separately and on purpose: it
 * is where the runtime chose to collect, so the two rank the adapters
 * differently and are not two views of one number.
 */
async function measureMemory(scenario, level, pairs, withIdle) {
  const names = [CONTROL, DRIVER];
  const columns = [
    'heldKb',
    'allocPerCallKb',
    'sustainedKb',
    'sustainedRssKb',
    'wireKb',
    'wireOutKb',
  ];
  const seen = Object.fromEntries(
    names.map(name => [name, Object.fromEntries(columns.map(c => [c, []]))]),
  );
  const reclaimed = Object.fromEntries(names.map(name => [name, []]));
  let calls = 0;
  let allocWins = 0;
  let sustainedWins = 0;

  for (let pair = 0; pair < pairs; pair++) {
    const order = pair % 2 ? [DRIVER, CONTROL] : names;
    const measured = {};
    for (const name of order)
      measured[name] = await memoryInChild(scenario, level, name);
    for (const name of names) {
      for (const column of columns)
        seen[name][column].push(measured[name][column]);
      reclaimed[name].push(
        measured[name].reclaimedKb / measured[name].iterations,
      );
      calls = measured[name].iterations;
    }
    if (measured[DRIVER].allocPerCallKb < measured[CONTROL].allocPerCallKb)
      allocWins++;
    if (measured[DRIVER].sustainedKb < measured[CONTROL].sustainedKb)
      sustainedWins++;
  }

  // Only where the report prints it, which is the engine level: it costs a
  // six-second wall-clock wait per adapter per scenario, and it answers a
  // question about the client that the level does not change.
  const idle = {};
  if (withIdle) {
    for (const name of names)
      idle[name] = await idleHeapInChild(scenario, level, name);
  }

  return {
    heapPairs: pairs,
    memoryCalls: calls,
    heapWins: allocWins,
    heapP: signTest(allocWins, pairs),
    sustainedWins,
    byAdapter: Object.fromEntries(
      names.map(name => [
        name,
        {
          ...Object.fromEntries(columns.map(c => [c, median(seen[name][c])])),
          reclaimedKb: median(reclaimed[name]),
          idleHeldKb: idle[name],
        },
      ]),
    ),
  };
}

async function runScenario(scenario, level, pairs) {
  const clients = openClients(level, scenario.pooled);
  const dbs = await clients.ready();

  // Warm up through the same path the scenario uses: JIT, pool connections,
  // and on PostgreJS the prepared statement each distinct SQL earns.
  const warmup = Math.min(scenario.iters * 4, 60);
  for (const name of [CONTROL, DRIVER]) {
    if (scenario.setup) await scenario.setup(dbs[name], level);
    for (let k = 0; k < warmup; k++) await scenario[level](dbs[name], k);
  }

  const ms = { [CONTROL]: [], [DRIVER]: [] };
  const diffs = [];
  let wins = 0;

  for (let pair = 0; pair < pairs; pair++) {
    const order = pair % 2 ? [DRIVER, CONTROL] : [CONTROL, DRIVER];
    const took = {};
    for (const name of order) {
      if (scenario.setup) await scenario.setup(dbs[name], level);
      took[name] = await timedBatch(scenario, level, dbs[name], pair);
    }
    ms[CONTROL].push(took[CONTROL]);
    ms[DRIVER].push(took[DRIVER]);
    diffs.push(took[DRIVER] - took[CONTROL]);
    if (took[DRIVER] < took[CONTROL]) wins++;
  }

  await clients.close();

  return {
    level,
    pairs,
    wins,
    p: signTest(wins, pairs),
    pairedDiffMs: median(diffs),
    rows: [CONTROL, DRIVER].map(name => ({ name, ms: median(ms[name]) })),
  };
}

/**
 * Read off disk, not imported: a package whose `exports` map does not list
 * `./package.json` cannot be resolved that way, and several here do not.
 */
const versionOf = pkg => {
  try {
    return JSON.parse(
      readFileSync(
        join(HERE, '..', 'node_modules', pkg, 'package.json'),
        'utf8',
      ),
    ).version;
  } catch {
    return null;
  }
};

const scenarios = scenariosMatching(arg('scenario'));
const levels = arg('level') ? [arg('level')] : LEVELS;
/**
 * Fewer pairs than the timings get, because the memory splits are lopsided
 * where the timings' are close, and because each one is a process rather than
 * a loop iteration.
 */
const heapPairs = has('no-memory') ? 0 : Number(arg('heap-pairs', 9));
const kb = value =>
  value >= 1024 ? `${(value / 1024).toFixed(1)} MB` : `${value.toFixed(0)} KB`;

if (has('describe')) {
  for (const row of await describeScenarios(scenarios)) {
    console.log(`\n## ${row.name}`);
    for (const sql of row.engine) console.log(`   ${sql.replace(/\s+/g, ' ')}`);
  }
  process.exit(0);
}

console.log(`Preparing ${CONN.database} …`);
const postgres = await applyDdl();
// Before anything is timed, and on clients of its own, so it cannot warm or
// disturb the pools the measured runs open.
const prepared = await countPreparedStatements();
console.log(
  `  prepared statements after ${prepared.queries} queries: ` +
    `${CONTROL} ${prepared[CONTROL]}, ${DRIVER} ${prepared[DRIVER]}`,
);

const results = [];
for (const scenario of scenarios) {
  const pairs = Number(arg('pairs', scenario.pairs));
  const measured = {
    name: scenario.name,
    group: scenario.group,
    note: scenario.note,
    iters: scenario.iters,
    levels: {},
  };
  for (const level of levels) {
    process.stdout.write(`  ${scenario.name} · ${level} … `);
    const out = await runScenario(scenario, level, pairs);
    const [control, driver] = out.rows;
    process.stdout.write(
      `${control.ms.toFixed(3)} → ${driver.ms.toFixed(3)} ms, ${out.wins}/${pairs}`,
    );

    // Merged onto the same rows the timings produced, so one row of the
    // report is one workload and the two columns of it cannot come from
    // different work.
    if (heapPairs > 0) {
      const heap = await measureMemory(
        scenario,
        level,
        heapPairs,
        level === levels[0],
      );
      Object.assign(out, heap);
      for (const row of out.rows) Object.assign(row, heap.byAdapter[row.name]);
      delete out.byAdapter;
      process.stdout.write(
        ` · ${kb(out.rows[0].allocPerCallKb)} → ${kb(out.rows[1].allocPerCallKb)}/call,` +
          ` ${heap.heapWins}/${heapPairs}`,
      );
    }

    console.log('');
    measured.levels[level] = out;
  }
  results.push(measured);
}

const payload = {
  measuredAt: new Date().toISOString(),
  // Provenance, not a result. The paired design holds the ratios steady while
  // the absolute figures move - two runs of this file an hour apart put the
  // same insert row at 5.1 ms and 12.8 ms and agreed on its ratio to within
  // 1% - so a reader comparing runs needs to know which machine each was
  // taken on and how busy it was.
  machine: {
    cpus: cpus().length,
    loadAverage: loadavg().map(n => Number(n.toFixed(2))),
  },
  versions: {
    node: process.version,
    postgrejs: versionOf('postgrejs'),
    pg: versionOf('pg'),
    '@prisma/client': versionOf('@prisma/client'),
    '@prisma/adapter-pg': versionOf('@prisma/adapter-pg'),
    postgres,
  },
  control: CONTROL,
  driver: DRIVER,
  prepared,
  scenarios: results,
};

mkdirSync(join(HERE, 'results'), { recursive: true });
const out = arg('out', join(HERE, 'results', 'latest.json'));
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\nwrote ${out}`);
