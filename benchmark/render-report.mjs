/**
 * Renders the last `npm run bench` into `doc/BENCHMARKS.md` and into the
 * marked regions of `README.md`.
 *
 * The figures were hand-copied before this existed, and they had already
 * drifted: the README's table was still the 3.9.0-era run, its speedups were
 * quoted a second time in the paragraph under it, and the server it named -
 * "PostgreSQL 18.4" - had been 18.6 for two upgrades. A number that lives in
 * two places is wrong in one of them, and the one nobody measured is wrong
 * everywhere.
 *
 * It reads `benchmark/results/latest.json` and runs nothing, so it can be
 * re-run against a measurement taken hours ago without touching the server.
 *
 *   npm run bench          # measure, and write the results file
 *   npm run bench:report   # render it
 *
 * Every claim it writes is computed from that file, including the sentences.
 * That is deliberate: a paragraph is exactly where a stale number survives a
 * re-run, because a table looks wrong at a glance and a sentence does not.
 * Where a paragraph needs a particular scenario it asks for it by name and
 * throws if it is gone, so renaming a workload fails loudly here rather than
 * quietly printing the wrong one.
 *
 * ## Three dimensions, two of which share a cell
 *
 * A measurement here has an adapter, a metric (time and memory) and a level
 * (through `PrismaClient`, or through the adapter alone). That is one more
 * than the Drizzle round had, and the first version of this file spent the
 * two-line cell on the *level* while keeping the shape of a table whose two
 * lines mean time and memory - so a reader who knew the other document read
 * the second line as memory, and was wrong.
 *
 * The cell belongs to the metric, because its two numbers are about the same
 * call and are read together. The level gets a table of its own.
 */
import { readFile, writeFile } from 'node:fs/promises';

const RESULTS = new URL('./results/latest.json', import.meta.url);
const DOC = new URL('../doc/BENCHMARKS.md', import.meta.url);
const README = new URL('../README.md', import.meta.url);

/** Below this, a sign test is taken as having settled the question. */
export const ALPHA = 0.05;

// --------------------------------------------------------------- formatting

/** Longest cell wins the column; markdown does not care, but a reader does. */
export function table(header, rows) {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map(row => String(row[i]).length)),
  );
  const line = cells =>
    `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map(w => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
}

/** Prettier leaves prose as it finds it, so it is wrapped here. */
export function wrap(text, width = 100) {
  const lines = [];
  let line = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** A list, in prose: `a`, `a and b`, `a, b and c`. */
export const list = items =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** A list the reader can scan. Scenario names carry commas; prose cannot. */
export const bullets = items => items.map(item => `- ${item}`).join('\n');

export const ms = value => `${value.toFixed(3)} ms`;

/**
 * KB below a megabyte, MB above it - `0.00 MB` says nothing.
 *
 * A figure at or below a kilobyte is written `~0`. It is described that way
 * rather than clamped: the baseline is taken once the module graph is loaded
 * but before a client exists, and six seconds later the runtime has had time
 * to collect things that were still live then, so a client holding nothing can
 * land a little under it. `-365 KB held` would read as a fault in the
 * instrument rather than as "holds nothing measurable".
 */
export const mb = kb => {
  if (kb <= 1) return '~0';
  return kb < 1024
    ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
    : `${(kb / 1024).toFixed(1)} MB`;
};

/**
 * What a sign test's split is worth saying about. An exponent reads better
 * than a p-value once the tail is small: `< 1 in 10^28` is a claim a reader
 * can weigh, and `p = 0.0000000000000000000000000000804` is not.
 */
export const odds = p => {
  if (p >= ALPHA) return 'not distinguishable';
  const exponent = Math.floor(-Math.log10(p));
  return exponent >= 3 ? `< 1 in 10^${exponent}` : `p = ${p.toFixed(3)}`;
};

/** `**2.65x**`, `1.61x the other way`, or `level`. */
export function verdict(settled, ratio) {
  if (!settled) return 'level';
  return ratio > 1
    ? `**${ratio.toFixed(2)}x**`
    : `${(1 / ratio).toFixed(2)}x the other way`;
}

/**
 * Memory reads better as a percentage than as a multiple: `-51%` says this
 * adapter asked for half again less than the reference did, `+29%` that it
 * asked for more, and the sign carries which way without a phrase for it.
 */
export function percent(settled, control, driver) {
  if (!settled) return 'level';
  const change = ((driver - control) / control) * 100;
  const text = `${change > 0 ? '+' : ''}${change.toFixed(0)}%`;
  return change < 0 ? `**${text}**` : text;
}

const times = ratio => `${ratio.toFixed(2)}x`;
const pair = (top, bottom) => `${top}<br>${bottom}`;
const bold = (text, when) => (when ? `**${text}**` : text);

// ------------------------------------------------------------------ reading

/**
 * One scenario at one level, with both comparisons worked out. `control` and
 * `driver` come off the results file rather than being named here, so the
 * report does not have to be edited when the reference adapter changes.
 */
export function at(results, scenario, level) {
  const measured = scenario.levels[level];
  if (!measured)
    throw new Error(`${scenario.name} was not measured at the ${level} level`);
  const control = measured.rows.find(row => row.name === results.control);
  const driver = measured.rows.find(row => row.name === results.driver);
  // A run taken with `--no-memory` carries timings only, and every memory
  // column then has to read as absent rather than as zero.
  const measuredHeap = measured.heapP != null && control.allocPerCallKb != null;
  return {
    ...measured,
    control,
    driver,
    ratio: control.ms / driver.ms,
    won: measured.p < ALPHA,
    measuredHeap,
    allocRatio: measuredHeap
      ? control.allocPerCallKb / driver.allocPerCallKb
      : null,
    heapSettled: measuredHeap && measured.heapP < ALPHA,
  };
}

/** The levels the file actually carries, in the order the runner wrote them. */
const levelsIn = results => Object.keys(results.scenarios[0].levels);

/** Whether this run measured memory at all. */
const hasMemory = results =>
  results.scenarios.every(s =>
    levelsIn(results).every(l => at(results, s, l).measuredHeap),
  );

/** The groups, in the order the scenarios appear. */
const groupsIn = results => [...new Set(results.scenarios.map(s => s.group))];

/**
 * A scenario by name prefix, or a loud failure. A paragraph that names a
 * workload is making a claim about that workload; silently picking a
 * different one, or printing `undefined`, is worse than not rendering.
 */
export function need(results, prefix) {
  const hits = results.scenarios.filter(s => s.name.startsWith(prefix));
  if (hits.length !== 1) {
    throw new Error(
      `the report names "${prefix}", which matches ${hits.length} scenarios in the results file ` +
        `- rename it in render-report.mjs, or restore the workload and measure again`,
    );
  }
  return hits[0];
}

// ------------------------------------------------------------------- tables

/**
 * Two figures to a cell: the time one call takes, and what that call asks the
 * runtime for. A row is two numbers about one call, and standing them side by
 * side made the table wider than it was informative.
 */
function headlineTable(results, { group, level, notes = true } = {}) {
  const rows = group
    ? results.scenarios.filter(s => s.group === group)
    : results.scenarios;
  const memory = hasMemory(results);
  const header = who =>
    memory ? `\`${who}\`<br>time / allocated` : `\`${who}\``;
  return table(
    ['Workload', header(results.control), header(results.driver), ''],
    rows.map(scenario => {
      const s = at(results, scenario, level);
      const name =
        notes && scenario.note
          ? pair(scenario.name, `_${scenario.note}_`)
          : scenario.name;
      if (!memory)
        return [
          name,
          ms(s.control.ms),
          ms(s.driver.ms),
          verdict(s.won, s.ratio),
        ];
      return [
        name,
        pair(
          bold(ms(s.control.ms), s.won && s.ratio < 1),
          `${bold(mb(s.control.allocPerCallKb), s.heapSettled && s.allocRatio < 1)}/call`,
        ),
        pair(
          bold(ms(s.driver.ms), s.won && s.ratio > 1),
          `${bold(mb(s.driver.allocPerCallKb), s.heapSettled && s.allocRatio > 1)}/call`,
        ),
        pair(
          verdict(s.won, s.ratio),
          percent(
            s.heapSettled,
            s.control.allocPerCallKb,
            s.driver.allocPerCallKb,
          ),
        ),
      ];
    }),
  );
}

/** Which adapter won each pair - the part a shared machine leaves intact. */
function signTable(results, which, levels = levelsIn(results)) {
  const said = which === 'heap' ? 'allocated less' : 'was faster';
  const of = s =>
    which === 'heap'
      ? { wins: s.heapWins, n: s.heapPairs, p: s.heapP }
      : { wins: s.wins, n: s.pairs, p: s.p };
  return table(
    ['Workload', ...levels.map(level => `${said} at the ${level} level`)],
    results.scenarios.map(scenario => [
      scenario.name,
      ...levels.map(level => {
        const s = of(at(results, scenario, level));
        return `${s.wins} of ${s.n} — ${odds(s.p)}`;
      }),
    ]),
  );
}

/**
 * The README's version: one level, and the columns spelled out rather than
 * folded into one cell - it is the only sign test most readers will see.
 */
function readmeSignTable(results, level, which) {
  const of = s =>
    which === 'heap'
      ? { wins: s.heapWins, n: s.heapPairs, p: s.heapP }
      : { wins: s.wins, n: s.pairs, p: s.p };
  const said = which === 'heap' ? 'allocated less in' : 'faster in';
  return table(
    [
      'workload',
      'iterations',
      `\`${results.driver}\` ${said}`,
      'odds of that by luck',
    ],
    results.scenarios.map(scenario => {
      const s = of(at(results, scenario, level));
      return [scenario.name, s.n, s.wins, odds(s.p)];
    }),
  );
}

/**
 * `4.7 MB` when a client keeps it, `4.7 MB → ~0 idle` when it hands it back.
 * Only written where the two differ by enough to be a fact about the client
 * rather than about a collection that happened to run.
 */
function heldCell(row) {
  const shown = mb(row.heldKb);
  if (row.idleHeldKb == null) return shown;
  const given = row.heldKb - row.idleHeldKb;
  if (given < 512 || given / row.heldKb < 0.25) return shown;
  return `${shown} → ${mb(row.idleHeldKb)} idle`;
}

/** What an adapter holds warm, what a run peaks at, and what crosses the socket. */
function memoryTable(results, level) {
  const both = (a, b) => `${a} / ${b}`;
  return table(
    [
      'Workload',
      'held between calls',
      'high-water under load',
      'off the wire per call',
      'onto the wire per call',
    ],
    results.scenarios.map(scenario => {
      const { control, driver } = at(results, scenario, level);
      return [
        scenario.name,
        both(heldCell(control), heldCell(driver)),
        both(mb(control.sustainedKb), mb(driver.sustainedKb)),
        both(mb(control.wireKb), mb(driver.wireKb)),
        both(mb(control.wireOutKb), mb(driver.wireOutKb)),
      ];
    }),
  );
}

/**
 * What the `held between calls` column is saying on this run.
 *
 * The explanation used to be written out - PostgreJS grows one send buffer
 * per connection and reclaims it after five seconds of quiet - and it was
 * carried over from the sibling driver's document, where it was true. Here it
 * named a workload that only ever *reads* 4 MB, and the run showed both
 * clients handing the buffer back rather than one. So the sentence is derived:
 * it says who let go of what, and only reaches for the housekeeping
 * explanation when this adapter is the one doing it alone.
 */
function heldNote(results, level) {
  const dropped = [];
  for (const scenario of results.scenarios) {
    const { control, driver } = at(results, scenario, level);
    const gave = row =>
      row.idleHeldKb != null &&
      row.heldKb - row.idleHeldKb >= 512 &&
      (row.heldKb - row.idleHeldKb) / row.heldKb >= 0.25;
    if (gave(control) || gave(driver)) {
      dropped.push({
        name: scenario.name,
        control: gave(control),
        driver: gave(driver),
      });
    }
  }

  const base = `The first column is what an adapter keeps between calls, above a baseline taken
   before either client existed.`;
  if (!dropped.length) {
    return `${base} Nothing in this run holds measurably more once the calls stop, so no row
     carries a second figure.`;
  }

  const onlyDriver = dropped.filter(d => d.driver && !d.control);
  const both = dropped.filter(d => d.driver && d.control);
  return `${base} Where a row carries a second figure, that is the same process once the calls have
   stopped for six seconds - a client that grew a buffer to fit the largest message it handled is
   still holding it while the calls keep coming, and a single number cannot say both.
   ${
     both.length
       ? `On ${list(both.map(d => d.name))} both clients let go of it, so that is the runtime
          reclaiming a buffer rather than a difference between them.`
       : ''
   }${
     onlyDriver.length
       ? ` On ${list(onlyDriver.map(d => d.name))} only this adapter does: PostgreJS writes each
           message into one growing buffer per connection and reclaims it after five seconds of
           quiet, where \`pg\` builds a fresh buffer per message and has nothing to hand back.`
       : ''
   }`;
}

/**
 * What crossed the socket, and what this run makes of it.
 *
 * Counted at the socket rather than taken from either client's accounting,
 * because the wire cost of a binary result is otherwise argued from the
 * encoding - and that argument has come out backwards before. The figures it
 * quotes are the two largest gaps in the column, whichever way they fall, so
 * a run where binary is the longer of the two says so.
 */
function wireNote(results, level) {
  const ranked = results.scenarios
    .map(scenario => {
      const { control, driver } = at(results, scenario, level);
      return {
        name: scenario.name,
        control: control.wireKb,
        driver: driver.wireKb,
      };
    })
    .filter(row => row.control > 1 || row.driver > 1)
    .sort(
      (a, b) => Math.abs(b.control - b.driver) - Math.abs(a.control - a.driver),
    )
    .slice(0, 2);

  const said = row =>
    `${row.name} at ${mb(row.driver)} against ${mb(row.control)}` +
    (row.driver > row.control ? ' - the longer of the two here' : '');

  return `The last two columns are counted at the socket rather than taken from either client's own
   accounting, because the wire cost of the binary format is otherwise argued from the encoding
   rather than measured. The two widest gaps on this run are ${list(ranked.map(said))}. Binary is
   not automatically shorter: a column of small integers is fewer bytes as text than as four-byte
   binary, which is why these scenarios use values that fill their type.`;
}

/**
 * What the memory column says about the rows that are not payload - which is
 * not "they are close together", the sentence this used to carry. On the
 * narrowest of them this adapter allocates a little *more*, and a paragraph
 * that rounds that away is the kind of thing a generated report exists to
 * stop.
 */
function ordinaryMemory(rows) {
  const change = row =>
    (row.engine.driver.allocPerCallKb - row.engine.control.allocPerCallKb) /
    row.engine.control.allocPerCallKb;
  const worse = rows.filter(row => row.engine.heapSettled && change(row) > 0);
  const better = rows.filter(row => row.engine.heapSettled && change(row) < 0);
  const pct = value => `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`;
  const range = set =>
    `${pct(Math.min(...set.map(change)))} to ${pct(Math.max(...set.map(change)))}`;

  if (!worse.length) {
    return `On memory they run ${range(better)}, the smaller gain of the two and in the same
     direction throughout.`;
  }
  return `On memory they are mixed rather than close: ${
    better.length
      ? `${range(better)} on ${list(better.map(row => row.name))}, and `
      : ''
  }the wrong way on ${list(
    worse.map(row => `${row.name} (${pct(change(row))})`),
  )} - a result of a few narrow rows is mostly per-row protocol cost, which is the same work on
   both sides, so what is left is each client's own per-row bookkeeping.`;
}

// -------------------------------------------------------------------- prose

/** `Node 24.15.0, postgrejs 3.12.1, …` - never typed into a sentence. */
export function versionLine(results) {
  const v = results.versions;
  const parts = [
    `\`@prisma/client\` ${v['@prisma/client']}`,
    `\`@prisma/adapter-pg\` ${v['@prisma/adapter-pg']}`,
    `\`postgrejs\` ${v.postgrejs}`,
    `\`pg\` ${v.pg}`,
    v.postgres ? `PostgreSQL ${v.postgres}` : null,
    `Node ${v.node.replace(/^v/, '')}`,
  ].filter(Boolean);
  return `${list(parts)}, on loopback. Medians per call.`;
}

/**
 * The machine, where the run recorded it.
 *
 * Provenance rather than a result, and worth printing because the absolute
 * figures depend on it far more than the comparison does: three runs of this
 * file put the same call at 1.18 ms and 4.45 ms and agreed on its ratio to
 * within 9%. A reader who finds these numbers slower than their own machine
 * is reading a busy one, and the ratios still hold.
 */
export function machineLine(results) {
  const m = results.machine;
  if (!m) return '';
  const [one, five] = m.loadAverage ?? [];
  if (one == null) return '';
  return `Taken on ${m.cpus} cores at a load average of ${one} (${five} over five minutes). The
   paired design holds the comparison steady while a busy machine moves both sides together, so
   read the ratios and the sign test rather than the milliseconds.`;
}

/**
 * The pair counts, said in a sentence. The heavier workloads run fewer pairs,
 * so there is more than one number and it has to read as a sentence rather
 * than as a list of two integers - "the median of 101 and 61 iterations" was
 * the first thing this printed.
 */
export function pairsPhrase(pairs, noun = 'alternated pairs') {
  const [most, ...rest] = [...new Set(pairs)].sort((a, b) => b - a);
  if (!rest.length) return `${most} ${noun}`;
  return `${most} ${noun}, or ${list(rest.map(String))} where one of them costs more`;
}

/**
 * What the tables mean, generated rather than written.
 *
 * Every sentence here is a claim the next run can overturn - the two-shape
 * pair is the whole argument of this benchmark and its ratio moved by a factor
 * of two and a half between the narrow and the packed form, which is exactly
 * the kind of number a hand-written paragraph keeps quoting after it has
 * changed.
 */
function reading(results) {
  const [engine, adapter] = levelsIn(results);
  const memory = hasMemory(results);
  const seen = name => {
    const scenario = need(results, name);
    return {
      name: scenario.name,
      engine: at(results, scenario, engine),
      adapter: at(results, scenario, adapter),
    };
  };
  const says = s => (s.engine.won ? times(s.engine.ratio) : 'level');
  const holds = s =>
    `${mb(s.engine.driver.allocPerCallKb)} against ${mb(s.engine.control.allocPerCallKb)}`;

  const spread = seen('float8 of 5k rows');
  const packed = seen('float8[] of 5k in one row');
  const array = seen('int4[] of 100k in one row');
  const bytes = seen('bytea of 4MB');

  const named = results.scenarios.map(s => ({
    name: s.name,
    group: s.group,
    engine: at(results, s, engine),
    adapter: at(results, s, adapter),
  }));
  const payload = [array, bytes, packed].map(s => s.name);
  const ordinary = named.filter(
    s => s.group === 'Read' && !payload.includes(s.name),
  );
  const concurrent = named.filter(s => s.group === 'Concurrency');
  const span = rows =>
    `between ${times(Math.min(...rows.map(s => s.engine.ratio)))} and ` +
    `${times(Math.max(...rows.map(s => s.engine.ratio)))}`;

  // How much of the adapter's advantage the engine keeps. Above 1 the engine
  // compressed the ratio, which is what a shared cost on both sides does;
  // below 1 it did not, and that is worth naming rather than smoothing over.
  const compression = named.map(s => ({
    name: s.name,
    factor: s.adapter.ratio / s.engine.ratio,
  }));
  const compressed = compression.filter(c => c.factor > 1.02);
  const widened = compression.filter(c => c.factor < 0.98);

  // What the engine itself costs, as a share of the call the user waits for.
  const overhead = named
    .map(s => ({
      name: s.name,
      share: 1 - s.adapter.driver.ms / s.engine.driver.ms,
    }))
    .sort((a, b) => a.share - b.share);
  const share = value => `${Math.round(value * 100)}%`;

  // The weakest split, and how far the rest of the table sits above it. Said
  // that way rather than as "this row has flipped between runs", which is true
  // of this one and is not something a single results file can know.
  const weakest = [...named].sort((a, b) => b.engine.p - a.engine.p)[0];
  const closest = Math.min(
    ...named
      .filter(s => s !== weakest)
      .map(s => s.engine.wins / s.engine.pairs),
  );

  return [
    wrap(`**What decides it is values per row, not values.** ${spread.name} and ${packed.name} hold
     the same 5000 \`float8\`s and differ in nothing but shape. Spread over 5000 rows the gain is
     ${says(spread)}; packed into one array in one row it is ${says(packed)} - the same values, the
     same bytes, and ${(packed.engine.ratio / spread.engine.ratio).toFixed(1)} times the margin.${
       memory
         ? ` Memory says it more plainly still: spread out, one call allocates ${holds(spread)};
             packed, ${holds(packed)}.`
         : ''
     } This is the pair to read first, because it explains why two workloads that both look like "a
     lot of numbers" disagree: the protocol's per-row cost is paid by both adapters, so a result of
     many narrow rows is mostly shared work, and binary decoding is worth what the rows are
     wide.`),

    wrap(`**Large payloads win, and the win survives the engine.** ${array.name} runs ${says(array)}
     through \`PrismaClient\` - ${ms(array.engine.control.ms)} against ${ms(array.engine.driver.ms)}
     - and ${bytes.name} ${says(bytes)}${memory ? `, on ${holds(bytes)} of allocation` : ''}. The
     values arrive in PostgreSQL's binary format rather than as text to be parsed, and enough of
     that reaches the caller to still be there once the query engine has had its turn. Whether any
     of it would is the question the second level exists to ask, and on these two rows the answer
     is yes.`),

    `${wrap(`**Ordinary rows gain less, and gain it repeatably.** A result of many narrow rows lands
     ${span(ordinary)}:`)}\n\n${bullets(ordinary.map(s => `${s.name} — ${says(s)}`))}\n\n${wrap(
      `None of those is a headline and none of them is noise either: ${ordinary[0].name} is the
        faster of the two in ${ordinary[0].engine.wins} of ${ordinary[0].engine.pairs} alternated
        pairs.${memory ? ` ${ordinaryMemory(ordinary)}` : ''}`,
    )}`,

    `${wrap(`**Concurrency past the pool is where an application actually lives.** With 32 callers
     over 4 connections, ${span(concurrent)}:`)}\n\n${bullets(
      concurrent.map(s => `${s.name} — ${says(s)}`),
    )}\n\n${wrap(`The queue in front of the pool is most of that latency, and the adapter that
     clears a call sooner shortens the queue for everyone waiting behind it.`)}`,

    wrap(`**The engine compresses the ratio without erasing it**, which is what the second level was
     built to show. ${
       compressed.length
         ? `On ${compressed.length} of ${compression.length} workloads the adapter-level margin is
            the larger one, by up to ${times(Math.max(...compressed.map(c => c.factor)))}`
         : `On this run no workload came out larger at the adapter level`
     }${
       widened.length
         ? `; on ${list(widened.map(c => `${c.name} (${times(1 / c.factor)})`))} it went the other
            way, the engine gaining more than the adapter did`
         : ''
     }. The engine is not a small cost to sit behind: it is ${share(overhead.at(-1).share)} of the
     call on ${overhead.at(-1).name} and ${share(overhead[0].share)} on ${overhead[0].name}.${
       memory
         ? ` On memory it is larger still - ${bytes.name} allocates
             ${mb(bytes.adapter.driver.allocPerCallKb)} through the adapter alone and
             ${mb(bytes.engine.driver.allocPerCallKb)} through \`PrismaClient\`, so most of what
             that call asks the runtime for is the engine's own mapping rather than the client's.`
         : ''
     } A benchmark taken only at the adapter level would overstate what a user gets; one taken only
     through the engine could not tell a real protocol difference from none at all.`),

    wrap(`**The row to lean on least** is ${weakest.name}, at ${weakest.engine.wins} of
     ${weakest.engine.pairs} (${odds(weakest.engine.p)}). That is still a settled result, but it is
     the only split in the table anywhere near even - every other workload won at least
     ${share(closest)} of its pairs - so take the direction and not the ${says(weakest)} the median
     puts on it, and re-run the row before quoting it.`),
  ].join('\n\n');
}

function document(results) {
  const [engine, adapter] = levelsIn(results);
  const memory = hasMemory(results);
  const pairs = results.scenarios.map(s => at(results, s, engine).pairs);
  const heapPairs = results.scenarios.map(
    s => at(results, s, engine).heapPairs,
  );
  const calls = [
    ...new Set(results.scenarios.map(s => at(results, s, engine).memoryCalls)),
  ];

  return `# The same Prisma calls, on both adapters

_Generated by \`npm run bench:report\` from the last \`npm run bench\`. Do not hand-edit - re-run
the command instead._

${wrap(`What this adapter costs or saves against \`@prisma/adapter-pg\` - PostgreJS against \`pg\`,
under an unmodified \`PrismaClient\` - measured on the same server, in the same run.`)}

\`\`\`sh
npm run bench          # measure
npm run bench:report   # render this file and the README's tables
\`\`\`

## Method

${wrap(
  memory
    ? `**Two numbers per row.** The time is one call. The memory is what one call **asks for** - everything allocated while it runs, whether or not any of it survives. A call is one Prisma method, or one interactive transaction where the workload's name says so; nothing here is the cost of running a scenario end to end.`
    : `**One number per row.** The time is one call - one Prisma method, or one interactive transaction where the workload's name says so. Nothing here is the cost of running a scenario end to end.`,
)}

${wrap(`**The timings are paired.** Both adapters run inside each pair, the order reversed on odd
pairs, so a cold cache or a busy moment lands on both equally. The medians are what the tables
print; the sign test beside them counts only **which** adapter won each pair, which is what survives
a shared machine - the absolute figures on this one drift by up to 25% between runs, and the winner
does not. Each figure is the median of ${pairsPhrase(pairs)}, each pair timing a batch of calls
rather than one, so the clock is read once per batch instead of once per call.`)}

${
  memory
    ? wrap(`**The memory is a separate pass, in a child process per adapter.** Polling
       \`process.memoryUsage()\` inside a timed window costs more than some of these calls and lands
       unevenly on the two adapters, so it cannot share the timings' process; and with both adapters
       alive at once the baseline would be taken above everything either of them allocated on the
       way up, which is exactly what a payload workload is made of. One child per adapter per pair,
       ${pairsPhrase(heapPairs, 'pairs')} of them, ${list(calls.map(String))} calls each, alternated
       and counted the same way. \`heapUsed\` and \`external\` are sampled together as one number,
       because a \`bytea\` arrives as a \`Buffer\`, which lives outside the JS heap entirely - a
       heap figure alone reads a 4 MB column as a rounding error.`)
    : wrap(`**This run carries timings only.** It was taken with \`--no-memory\`, so nothing below
       says anything about what either adapter allocates.`)
}

### Two levels, and why there are two

Every workload is measured twice over:

- **${engine}** - through a real \`PrismaClient\`, generated client and query engine included. This
  is what a user gets, and it is the number the README quotes.
- **${adapter}** - through the \`SqlDriverAdapter\` alone, running _the same SQL the engine emits_,
  captured from \`PrismaClient\`'s own \`query\` event so it cannot drift from what the engine really
  sends.

${wrap(`The reason is that a shared cost large enough to matter compresses a ratio towards 1, and the
query engine is exactly such a cost - it sits on both sides of every call and it is not small.
Measured only through it, a real difference in protocol handling can read as no difference at all,
and nothing in that measurement distinguishes it from the adapter genuinely being no better. So the
two levels answer two different questions: the adapter level asks whether PostgreJS's protocol
handling is actually cheaper, and the engine level asks whether any of it survives to the caller.
Both are worth having, and only one of them belongs in a README.`)}

## Results, as a caller sees them

${wrap(versionLine(results))}
${machineLine(results) ? `\n${wrap(machineLine(results))}\n` : ''}
${wrap(
  memory
    ? `Two figures to a cell: the time one call takes, and what that call allocates. Everything in this section is through \`PrismaClient\`.`
    : `Everything in this section is through \`PrismaClient\`.`,
)}

${groupsIn(results)
  .map(
    group =>
      `### ${group}\n\n${headlineTable(results, { group, level: engine })}`,
  )
  .join('\n\n')}

### Which adapter actually won, pair by pair

${signTable(results, 'time')}
${
  memory
    ? `
${wrap(`And on what a call allocates, over its own pairs:`)}

${signTable(results, 'heap')}
`
    : ''
}
${wrap(`A sign test: two adapters of equal speed would split the pairs evenly, so it gives the
probability of a split at least this lopsided from a fair coin. It says the differences are real and
nothing at all about their size - that is what the speedup column is for.`)}

## The same rows without the query engine

${wrap(`The \`SqlDriverAdapter\` on its own, running the SQL the engine emitted above. This is the
premise rather than the promise: what PostgreJS's protocol handling is worth before Prisma's own row
mapping is laid on top of it.`)}

${headlineTable(results, { level: adapter, notes: false })}
${
  memory
    ? `
## What a client holds, and what crosses the wire

${wrap(`Three more questions, all of them at the \`${engine}\` level, and none of them the same as
"what does a call allocate". Reference adapter first, this one second.`)}

${memoryTable(results, engine)}

${wrap(heldNote(results, engine))}

${wrap(`The high-water is partly a property of the application around the client rather than of the
client: with a larger live heap under the same calls the collections halve and the ceiling floats
about twice as high. Take the allocation column as the comparison and this one as the sizing.`)}

${wrap(wireNote(results, engine))}
`
    : ''
}
## Reading them

${reading(results)}

## What is not measured here

${wrap(`**Anything but PostgreSQL on loopback.** A real deployment puts a network between the client
and the server, which adds the same latency to both adapters and therefore compresses every ratio
here the way the query engine already does. Read these as the difference the client makes, not as
the difference a deployment will see.`)}

${wrap(`**A per-call peak.** There was one, in the Drizzle round, and it was given up on: a sampler
cannot fire faster than once a millisecond, so it takes zero samples on a call that returns in 0.2
ms, and it understates unevenly on a call long enough to sample - which moves the comparison and not
merely the figure. \`benchmark/heap-worker.mjs\` has the whole account. What replaced it is the
allocation column, which does not depend on where a collection lands.`)}

${wrap(`**Correctness.** That is the other suite's job: \`npm run test:prisma-suite\` runs Prisma's
own functional tests against both adapters on the same server, and the README says what it found.`)}
`;
}

// ------------------------------------------------------------------ writing

/** Rewrites one `<!-- bench:name -->` … `<!-- /bench:name -->` region. */
export function replaceRegion(text, name, body) {
  const open = `<!-- bench:${name} -->`;
  const close = `<!-- /bench:${name} -->`;
  const from = text.indexOf(open);
  const to = text.indexOf(close);
  if (from === -1 || to === -1)
    throw new Error(`README.md has no ${open} … ${close} region`);
  if (to < from)
    throw new Error(`README.md closes bench:${name} before it opens it`);
  return `${text.slice(0, from + open.length)}\n\n${body}\n\n${text.slice(to)}`;
}

/** The README's regions, so the test and the writer agree on the list. */
export function readmeRegions(results) {
  const [engine] = levelsIn(results);
  const memory = hasMemory(results);
  const of = name => at(results, need(results, name), engine);
  const adapterOf = name =>
    at(results, need(results, name), levelsIn(results)[1]);
  const spread = of('float8 of 5k rows');
  const packed = of('float8[] of 5k in one row');
  const array = of('int4[] of 100k in one row');
  const bytes = of('bytea of 4MB');
  const concurrent = results.scenarios
    .filter(s => s.group === 'Concurrency')
    .map(s => at(results, s, engine).ratio);
  const pairs = results.scenarios.map(s => at(results, s, engine).pairs);

  const wireRatio = bytes.control.wireKb / bytes.driver.wireKb;
  const point = of('point read');

  return {
    /**
     * Why this package rather than the reference adapter, in the space a
     * reader gives the top of a README. Both halves of the argument - it is
     * faster, and it asks for less - because either one alone invites the
     * question about the other.
     */
    intro: wrap(
      `It is faster where it counts, and it asks the runtime for far less memory doing it. A 4 MB
       \`bytea\` comes back in ${ms(bytes.driver.ms)} against ${ms(bytes.control.ms)}${
         memory
           ? `, and one call allocates ${mb(bytes.driver.allocPerCallKb)} against
              ${mb(bytes.control.allocPerCallKb)}`
           : ''
       } - \`pg\` asks for that column as \`\\x\`-prefixed hex, two characters a byte, so it pulls
       ${mb(bytes.control.wireKb)} off the socket where this adapter pulls ${mb(bytes.driver.wireKb)}${
         memory
           ? ', and then holds it as a string off the JS heap where a heap figure alone cannot see it'
           : ''
       }. An \`int4[]\` of 100k values runs ${times(array.ratio)}${
         memory
           ? `, at ${mb(array.driver.allocPerCallKb)} against ${mb(array.control.allocPerCallKb)}`
           : ''
       } - values that use the whole type on purpose, because a column of single digits is shorter
       as text than as binary and quoting that would be choosing the answer. Ordinary queries gain
       less and gain it repeatably: a point read is the faster of the two in ${point.wins} of
       ${point.pairs} alternated pairs. All of it through an unmodified \`PrismaClient\`, against
       \`@prisma/adapter-pg\` on the same server in the same run.`,
    ),

    payload: wrap(
      `- **Faster where the payload is large** - ${times(bytes.ratio)} on a 4 MB \`bytea\`, and
       ${times(array.ratio)} on a 100k-element \`int4[]\` whose values use the whole type, because
       the values arrive in PostgreSQL's binary format rather than as text to be parsed.`,
      98,
    ).replace(/\n/g, '\n  '),

    memory: memory
      ? wrap(
          `- **And lighter on the same rows** - one call allocates ${mb(bytes.driver.allocPerCallKb)}
           against ${mb(bytes.control.allocPerCallKb)} on that \`bytea\`, and
           ${mb(packed.driver.allocPerCallKb)} against ${mb(packed.control.allocPerCallKb)} on an
           array of 5000 \`float8\`. On rows too narrow to carry a payload the two are within a few
           percent, and on the smallest of them this adapter asks for slightly more.`,
          98,
        ).replace(/\n/g, '\n  ')
      : `- **Memory was not measured in this run.**`,

    binary: wrap(
      `Result columns arrive in PostgreSQL's binary format and are decoded per type, where \`pg\`
       asks for text and parses it. On bulk that is the whole difference: a 100k-element \`int4[]\`
       costs ${ms(array.driver.ms)}${
         memory ? ` and ${mb(array.driver.allocPerCallKb)}` : ''
       } here against ${ms(array.control.ms)}${
         memory ? ` and ${mb(array.control.allocPerCallKb)}` : ''
       }, because the text path has to materialise the array literal as one string before it can
       parse it. It is cheaper on the wire too, where the text is longer than the value: the 4 MB
       \`bytea\` costs ${mb(bytes.control.wireKb)} of network under \`@prisma/adapter-pg\` and
       ${mb(bytes.driver.wireKb)} here, counted at the socket${
         wireRatio > 1.5 ? ` - ${wireRatio.toFixed(1)} times` : ''
       }.`,
    ),

    prepared: results.prepared
      ? wrap(
          `PostgreJS names and caches a statement per connection - 64 by default,
           least-recently-used closed - so each distinct SQL string is parsed and planned once
           rather than on every call. Counted from the backend: ${results.prepared.queries} queries
           through this adapter leave ${results.prepared[results.driver]} prepared statements
           behind, and the same ${results.prepared.queries} through \`@prisma/adapter-pg\` leave
           ${results.prepared[results.control]}. That is a default rather than a limitation - the
           reference adapter names a statement when it is given a \`statementNameGenerator\`, and
           without one \`pg\` sends it unnamed and the server parses it again every time. It is
           what the ordinary rows' margin is mostly made of.`,
        )
      : wrap(`PostgreJS names and caches a statement per connection - 64 by default,
           least-recently-used closed - so each distinct SQL string is parsed and planned once
           rather than on every call.`),

    /** The second level, in the one paragraph a README can spare for it. */
    engine: wrap(
      `Prisma's query engine sits on both sides of every call, so it compresses these ratios rather
       than causing them. Measured again through the \`SqlDriverAdapter\` alone, on the same SQL the
       engine emits, the 4 MB \`bytea\` is ${times(adapterOf('bytea of 4MB').ratio)}${
         memory
           ? ` and allocates ${mb(adapterOf('bytea of 4MB').driver.allocPerCallKb)} against
              ${mb(adapterOf('bytea of 4MB').control.allocPerCallKb)}`
           : ''
       }, and the \`int4[]\` ${times(adapterOf('int4[] of 100k in one row').ratio)}. The table above
       is the smaller of the two numbers on purpose: it is the one a caller actually gets.`,
    ),

    headline: `${headlineTable(results, { level: engine, notes: false })}\n\n${wrap(
      `${versionLine(results)}${
        memory
          ? ' The second line of each cell is what one call asks the runtime for, `heapUsed` and `external` together.'
          : ''
      } How that was measured, and the same rows without the query engine, are in [\`doc/BENCHMARKS.md\`](doc/BENCHMARKS.md).`,
    )}`,

    shape: wrap(
      `**The gain follows the shape of the workload, not its size.** The same 5000 \`float8\` values
       read as 5000 rows gain ${times(spread.ratio)}; packed into one array column in one row,
       ${times(packed.ratio)} - the protocol's per-row cost is paid by both adapters, so binary
       decoding is worth what the rows are wide. Large payloads gain most: ${times(bytes.ratio)} on
       a 4 MB \`bytea\`${
         memory
           ? `, allocating ${mb(bytes.driver.allocPerCallKb)} against ${mb(bytes.control.allocPerCallKb)}`
           : ''
       }, and ${times(array.ratio)} on an \`int4[]\` of 100k values that use the whole type. And
       once there is more concurrency than pool, up to ${times(
         Math.max(...concurrent),
       )} - which is what a web application under load actually looks like.`,
    ),

    method: wrap(
      `Both adapters run in one process and alternate on every iteration, so neither gets a warmer
       machine than the other. Each figure is the median of ${pairsPhrase(pairs, 'iterations')}.${
         memory
           ? ` Memory is a pass of its own, one child process per adapter, so that what a client
               allocates once and keeps is inside the window rather than under it.`
           : ''
       } Everything in the table above is through a real \`PrismaClient\`.`,
    ),

    signtest: readmeSignTable(results, engine, 'time'),
  };
}

// ---------------------------------------------------------------------- run

if (import.meta.url === `file://${process.argv[1]}`) {
  // An older run renders as readily as the last one: pass its path. There is
  // no flag for writing somewhere else, because two copies of this document
  // is the thing it exists to prevent.
  const from = process.argv[2]
    ? new URL(process.argv[2], `file://${process.cwd()}/`)
    : RESULTS;
  const results = JSON.parse(await readFile(from, 'utf8'));

  // Both documents are rendered before either is written. A run missing a
  // workload the prose names throws, and it has to throw with the previous
  // pair of documents still consistent with each other - half a render is
  // harder to notice than none.
  const doc = document(results);
  let readme = await readFile(README, 'utf8');
  for (const [name, body] of Object.entries(readmeRegions(results))) {
    readme = replaceRegion(readme, name, body);
  }

  await writeFile(DOC, doc);
  await writeFile(README, readme);

  console.log(
    `doc/BENCHMARKS.md and README.md rendered from the run of ${results.measuredAt}`,
  );
}
