import { expect } from 'expect';

/**
 * `benchmark/render-report.mjs` is plain ESM outside `src/`, so it is reached
 * through a specifier TypeScript cannot resolve statically. That is the point:
 * the benchmark tooling is not part of the published package and must not be
 * pulled into its type graph.
 */
const render = await import(
  new URL('../../benchmark/render-report.mjs', import.meta.url).href
);
const {
  ALPHA,
  at,
  bullets,
  mb,
  need,
  odds,
  pairsPhrase,
  percent,
  readmeRegions,
  replaceRegion,
  table,
  verdict,
  versionLine,
  wrap,
} = render;

/** One adapter's memory columns, scaled off its allocation so they move together. */
const cell = (allocPerCallKb?: number) =>
  allocPerCallKb == null
    ? {}
    : {
        allocPerCallKb,
        heldKb: allocPerCallKb / 4,
        idleHeldKb: allocPerCallKb / 8,
        sustainedKb: allocPerCallKb * 2,
        sustainedRssKb: allocPerCallKb * 4,
        reclaimedKb: allocPerCallKb / 2,
        wireKb: allocPerCallKb / 10,
        wireOutKb: 0.2,
      };

const level = (
  controlMs: number,
  driverMs: number,
  wins: number,
  pairs: number,
  p: number,
  memory?: { control: number; driver: number; heapWins: number; heapP: number },
) => ({
  pairs,
  wins,
  p,
  pairedDiffMs: driverMs - controlMs,
  ...(memory
    ? {
        heapPairs: 9,
        memoryCalls: 100,
        heapWins: memory.heapWins,
        heapP: memory.heapP,
      }
    : {}),
  rows: [
    { name: '@prisma/adapter-pg', ms: controlMs, ...cell(memory?.control) },
    { name: 'prisma-postgrejs', ms: driverMs, ...cell(memory?.driver) },
  ],
});

const scenario = (
  name: string,
  group: string,
  engine: ReturnType<typeof level>,
  adapter: ReturnType<typeof level>,
) => ({
  name,
  group,
  note: `${name}, described`,
  iters: 1,
  levels: { engine, adapter },
});

const heap = (control: number, driver: number) => ({
  control,
  driver,
  heapWins: driver < control ? 9 : 0,
  heapP: 0.004,
});

/**
 * The smallest results file the report can be rendered from: every workload
 * the prose names by hand, and nothing else. A run that loses one of these is
 * meant to fail loudly rather than print the wrong workload, and one of the
 * tests below is what holds that.
 */
const RESULTS = {
  measuredAt: '2026-09-29T18:33:25.418Z',
  versions: {
    node: 'v24.15.0',
    postgrejs: '3.12.1',
    pg: '8.23.0',
    '@prisma/client': '7.10.0',
    '@prisma/adapter-pg': '7.10.0',
    postgres: '18.6',
  },
  control: '@prisma/adapter-pg',
  driver: 'prisma-postgrejs',
  prepared: { queries: 4, '@prisma/adapter-pg': 0, 'prisma-postgrejs': 4 },
  scenarios: [
    scenario(
      'point read',
      'Read',
      level(2, 1, 100, 101, 1e-28, heap(40, 30)),
      level(2, 1, 99, 101, 1e-26, heap(20, 15)),
    ),
    scenario(
      'primary-key lookup',
      'Read',
      level(2, 1, 100, 101, 1e-28, heap(40, 30)),
      level(2, 1, 99, 101, 1e-26, heap(20, 15)),
    ),
    scenario(
      'float8 of 5k rows',
      'Read',
      level(2, 1, 101, 101, 1e-30, heap(1400, 1500)),
      level(2, 1, 101, 101, 1e-30, heap(900, 950)),
    ),
    scenario(
      'float8[] of 5k in one row',
      'Read',
      level(4, 1, 101, 101, 1e-30, heap(2800, 240)),
      level(4, 1, 101, 101, 1e-30, heap(2600, 120)),
    ),
    scenario(
      'int4[] of 100k in one row',
      'Read',
      level(30, 10, 61, 61, 1e-18, heap(28000, 14000)),
      level(30, 10, 61, 61, 1e-18, heap(26000, 6000)),
    ),
    scenario(
      'bytea of 4MB',
      'Read',
      level(30, 15, 61, 61, 1e-18, heap(70000, 22000)),
      level(30, 15, 61, 61, 1e-18, heap(52000, 4200)),
    ),
    scenario(
      '32 concurrent count(), pool of 4',
      'Concurrency',
      level(5, 4, 51, 61, 9.6e-8, heap(1300, 1250)),
      level(5, 4, 56, 61, 1e-11, heap(900, 850)),
    ),
  ],
};

/** The same run as it comes back from `npm run bench -- --no-memory`. */
const TIMINGS_ONLY = {
  ...RESULTS,
  scenarios: RESULTS.scenarios.map(s => ({
    ...s,
    levels: Object.fromEntries(
      Object.entries(s.levels).map(([name, one]) => [
        name,
        {
          ...one,
          heapPairs: undefined,
          heapP: undefined,
          rows: one.rows.map(r => ({ name: r.name, ms: r.ms })),
        },
      ]),
    ),
  })),
};

describe('render-report/formatting', () => {
  it('pads every column to the width of its longest cell', () => {
    const lines = table(['a', 'bb'], [['cccc', 'd']]).split('\n');
    expect(lines).toStrictEqual([
      '| a    | bb |',
      '| ---- | -- |',
      '| cccc | d  |',
    ]);
    expect(new Set(lines.map(line => line.length)).size).toStrictEqual(1);
  });

  it('wraps prose without breaking a word', () => {
    const wrapped = wrap('one two three four five', 9);
    expect(wrapped).toStrictEqual('one two\nthree\nfour five');
    for (const line of wrapped.split('\n'))
      expect(line.length).toBeLessThanOrEqual(9);
  });

  it('collapses the whitespace a template literal leaves in a paragraph', () => {
    expect(wrap('a\n     b\n\n   c', 80)).toStrictEqual('a b c');
  });

  it('writes a list a reader can scan, because workload names carry commas', () => {
    expect(
      bullets(['10k rows, mixed scalars - 1.33x', 'point read - 1.19x']),
    ).toStrictEqual('- 10k rows, mixed scalars - 1.33x\n- point read - 1.19x');
  });

  /**
   * A memory figure at or below the baseline is real rather than a fault: the
   * baseline is taken before a client exists, and six seconds of idle gives
   * the runtime time to collect things that were live then. It has to read as
   * "nothing measurable", not as `-365.0 KB`.
   */
  it('writes memory in the unit that says something, and never as a negative', () => {
    expect(mb(0.4)).toStrictEqual('~0');
    expect(mb(-365)).toStrictEqual('~0');
    expect(mb(31.4)).toStrictEqual('31 KB');
    expect(mb(4.25)).toStrictEqual('4.3 KB');
    expect(mb(2048)).toStrictEqual('2.0 MB');
  });

  /**
   * The one number in the report a reader is invited to weigh, so it is worth
   * pinning: an unsettled split says so in words, a small tail is an exponent,
   * and a marginal one keeps three decimals rather than becoming `10^1`.
   */
  it('says what a sign test is worth', () => {
    expect(odds(0.2)).toStrictEqual('not distinguishable');
    expect(odds(ALPHA)).toStrictEqual('not distinguishable');
    expect(odds(0.04)).toStrictEqual('p = 0.040');
    expect(odds(8.04e-29)).toStrictEqual('< 1 in 10^28');
  });

  it('reports an unsettled comparison as level, whichever way the medians fell', () => {
    expect(verdict(false, 2.5)).toStrictEqual('level');
    expect(verdict(false, 0.4)).toStrictEqual('level');
    expect(verdict(true, 2.5)).toStrictEqual('**2.50x**');
    expect(verdict(true, 0.5)).toStrictEqual('2.00x the other way');
  });

  it('carries the direction of a memory change in its sign', () => {
    expect(percent(true, 100, 50)).toStrictEqual('**-50%**');
    expect(percent(true, 100, 129)).toStrictEqual('+29%');
    expect(percent(false, 100, 50)).toStrictEqual('level');
  });

  it('says the pair counts as a sentence rather than as a list of integers', () => {
    expect(pairsPhrase([101, 101])).toStrictEqual('101 alternated pairs');
    expect(pairsPhrase([61, 101])).toStrictEqual(
      '101 alternated pairs, or 61 where one of them costs more',
    );
    expect(pairsPhrase([61, 101, 21])).toStrictEqual(
      '101 alternated pairs, or 61 and 21 where one of them costs more',
    );
  });
});

describe('render-report/reading the results', () => {
  it('picks the two adapters out by the names the results file carries', () => {
    const s = at(RESULTS, RESULTS.scenarios[0], 'engine');
    expect(s.control.name).toStrictEqual('@prisma/adapter-pg');
    expect(s.driver.name).toStrictEqual('prisma-postgrejs');
    expect(s.ratio).toStrictEqual(2);
    expect(s.won).toStrictEqual(true);
  });

  it('works out the memory comparison alongside the timing one', () => {
    const s = at(RESULTS, need(RESULTS, 'bytea of 4MB'), 'adapter');
    expect(s.measuredHeap).toStrictEqual(true);
    expect(s.allocRatio).toBeCloseTo(52000 / 4200, 5);
    expect(s.heapSettled).toStrictEqual(true);
  });

  it('reads a timings-only run as having no memory rather than none allocated', () => {
    const s = at(TIMINGS_ONLY, TIMINGS_ONLY.scenarios[0], 'engine');
    expect(s.measuredHeap).toStrictEqual(false);
    expect(s.allocRatio).toBeNull();
    expect(s.heapSettled).toStrictEqual(false);
  });

  it('refuses a level the run did not measure', () => {
    expect(() => at(RESULTS, RESULTS.scenarios[0], 'memory')).toThrow(
      /not measured/,
    );
  });

  /**
   * The guarantee the prose rests on. Renaming a workload in `scenarios.mjs`
   * must break the renderer, not make it quietly describe a different one -
   * the sentences quote figures by workload, and a paragraph about the wrong
   * one reads exactly like a paragraph about the right one.
   */
  it('fails loudly when a workload the prose names is gone', () => {
    expect(() => need(RESULTS, 'bytea of 4MB')).not.toThrow();
    expect(() => need(RESULTS, 'bytea of 8MB')).toThrow(/matches 0 scenarios/);
    expect(() => need(RESULTS, 'float8')).toThrow(/matches 2 scenarios/);
  });
});

describe('render-report/writing', () => {
  const README = [
    'before',
    '<!-- bench:x -->',
    'stale',
    '<!-- /bench:x -->',
    'after',
  ].join('\n');

  it('replaces a region and leaves the markers in place', () => {
    expect(replaceRegion(README, 'x', 'fresh')).toStrictEqual(
      'before\n<!-- bench:x -->\n\nfresh\n\n<!-- /bench:x -->\nafter',
    );
  });

  it('is idempotent, so re-rendering an unchanged run changes no bytes', () => {
    const once = replaceRegion(README, 'x', 'fresh');
    expect(replaceRegion(once, 'x', 'fresh')).toStrictEqual(once);
  });

  it('refuses a region the README does not have', () => {
    expect(() => replaceRegion(README, 'y', 'fresh')).toThrow(
      /has no <!-- bench:y -->/,
    );
    expect(() =>
      replaceRegion('<!-- /bench:x --><!-- bench:x -->', 'x', 'f'),
    ).toThrow(/closes bench:x before it opens it/);
  });

  /**
   * Every version in the report comes off the results file, the server
   * included. The README said "PostgreSQL 18.4" for two server upgrades,
   * which is the cheapest kind of number in a benchmark to get wrong and the
   * hardest to notice.
   */
  it('names the versions the run was measured on, and no others', () => {
    expect(versionLine(RESULTS)).toStrictEqual(
      '`@prisma/client` 7.10.0, `@prisma/adapter-pg` 7.10.0, `postgrejs` 3.12.1, `pg` 8.23.0, ' +
        'PostgreSQL 18.6 and Node 24.15.0, on loopback. Medians per call.',
    );
  });

  it('leaves the server out rather than inventing one, on a run that predates it', () => {
    const older = {
      ...RESULTS,
      versions: { ...RESULTS.versions, postgres: undefined },
    };
    expect(versionLine(older)).not.toContain('PostgreSQL');
    expect(versionLine(older)).toContain('Node 24.15.0');
  });

  it('renders every README region from the results file alone', () => {
    const regions = readmeRegions(RESULTS);
    expect(Object.keys(regions)).toStrictEqual([
      'intro',
      'payload',
      'memory',
      'binary',
      'prepared',
      'engine',
      'headline',
      'shape',
      'method',
      'signtest',
    ]);
    expect(regions.headline).toContain(
      '[`doc/BENCHMARKS.md`](doc/BENCHMARKS.md)',
    );
    expect(regions.signtest).toContain('< 1 in 10^18');

    // the two-shape pair is the argument, so both of its figures are quoted
    expect(regions.shape).toContain('2.00x');
    expect(regions.shape).toContain('4.00x');
    expect(regions.method).toContain(
      '101 iterations, or 61 where one of them costs more',
    );
  });

  /**
   * The mistake this table shape was corrected for: the two lines of a cell
   * are the time and the memory of one call, which is how the sibling
   * driver's document reads them. The level is a separate table, not a second
   * line that happens to look like one.
   */
  it('puts the time and the memory of one call in one cell', () => {
    const { headline } = readmeRegions(RESULTS);
    expect(headline).toContain('`@prisma/adapter-pg`<br>time / allocated');
    expect(headline).toContain('30.000 ms<br>68.4 MB/call');
    expect(headline).toContain('**15.000 ms**<br>**21.5 MB**/call');
    expect(headline).toContain('**2.00x**<br>**-69%**');
  });

  it('drops every memory column on a run that measured none', () => {
    const { headline, shape, method, intro, memory } =
      readmeRegions(TIMINGS_ONLY);
    expect(headline).toContain('| `@prisma/adapter-pg` |');
    expect(headline).not.toContain('time / allocated');
    expect(headline).not.toContain('/call');
    expect(shape).not.toContain('allocating');
    expect(method).not.toContain('child process');
    expect(intro).not.toContain('allocates');
    expect(memory).toContain('not measured');
  });

  /**
   * The top of the README has to answer "why this rather than the reference
   * adapter" in both currencies, because either half on its own invites the
   * question about the other.
   */
  it('answers why, in time and in memory, with the figures behind it', () => {
    const { intro } = readmeRegions(RESULTS);
    expect(intro).toContain('15.000 ms against 30.000 ms');
    expect(intro).toContain('21.5 MB against 68.4 MB');
    // counted at the socket: the reference asks for the same value as hex text
    expect(intro).toContain('`\\x`-prefixed hex');
    expect(intro.replace(/\s+/g, ' ')).toContain(
      '6.8 MB off the socket where this adapter pulls 2.1 MB',
    );
    expect(intro).toContain('100 of 101 alternated pairs');
  });

  it('counts the prepared statements rather than asserting them', () => {
    expect(readmeRegions(RESULTS).prepared).toContain(
      '4 queries through this adapter leave 4 prepared statements behind',
    );
    const unmeasured = { ...RESULTS, prepared: undefined };
    expect(readmeRegions(unmeasured).prepared).not.toContain(
      'Counted from the backend',
    );
  });

  it('gives the adapter level its own paragraph rather than a second line', () => {
    const { engine } = readmeRegions(RESULTS);
    expect(engine).toContain('2.00x');
    expect(engine).toContain('the one a caller actually gets');
  });
});
