#!/usr/bin/env node
//
// Compares two runs of Prisma's client functional suite - the reference
// adapter's and this one's - and reports only what differs.
//
// The comparison is per test name rather than per count. A tag does not pass
// its own suite cleanly on every PostgreSQL version, so what matters is not
// how many tests failed but whether this adapter lost a test the reference
// won. Everything else is the suite's own state and is reported as context.

import { readFileSync } from 'node:fs';

/**
 * Jest colours its output, so the escape sequences come off first. Built from
 * the code point rather than written literally: an ESC in a regular expression
 * is a control character, which is both unreadable and a lint error.
 */
const RED = `${String.fromCharCode(27)}[31m`;
const GREEN = `${String.fromCharCode(27)}[32m`;
const RESET = `${String.fromCharCode(27)}[0m`;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Jest's `✕ name` / `✓ name`, keyed by file and the whole describe path.
 *
 * Both halves of the key earn their place, and each was added after a false
 * report:
 *
 * - **The matrix row.** One file runs several times - `(provider=postgresql,
 *   relationMode=prisma, js_pg)` and so on - with the same test names each
 *   time. The adapter's own label is the one part of it that is *supposed* to
 *   differ between the two runs, so that comes back out.
 * - **Every describe level under it.** `json-null-types` has a `DbNull` test
 *   under each of `requiredJsonField`, `optionalJsonField` and two more.
 *   Keying on the leaf name alone merged them, and since one passes and
 *   another fails, the single key landed in `passed` *and* `failed` - and was
 *   then reported as a regression against itself.
 *
 * Jest's verbose reporter indents by two spaces per level, so the nesting is
 * read off the indentation.
 */
function parse(path) {
  const text = readFileSync(path, 'utf8');
  const passed = new Set();
  const failed = new Set();
  let suite = '';
  let describes = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(ANSI, '');
    const header = line.match(/^\s*(?:PASS|FAIL)\s+(\S+)/);
    if (header) {
      suite = header[1];
      describes = [];
      continue;
    }
    const test = line.match(/^(\s+)([✓✕○])\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/);
    if (!test) {
      const row = line.match(/^(\s{2,})(\S.*)$/);
      if (!row) continue;
      const depth = row[1].length / 2;
      describes = describes.slice(0, depth - 1);
      describes[depth - 1] = row[2]
        .replace(/,?\s*js_[a-z0-9_]+/g, '')
        .replace(/\(\s*\)/, '')
        .trim();
      continue;
    }
    // `decimal/precision` puts a per-run random seed in its test names, so the
    // same test is called something different in each run. Normalised out, or
    // all five are reported as tests the reference ran and this one did not.
    const leaf = test[3].trim().replace(/\s*\(with seed=-?\d+\)/, '');
    const name = `${suite} :: ${describes.filter(Boolean).join(' › ')} :: ${leaf}`;
    if (test[2] === '✕') failed.add(name);
    else if (test[2] === '✓') passed.add(name);
  }
  const totals = text.match(/Tests:\s+(.*)/g)?.at(-1) ?? '';
  // A run that died has no final summary, and jest's own crash line is the
  // other half of the signal. Both are recorded so the comparison can refuse
  // to answer rather than answer about the part that ran - see below.
  const suites = (text.match(/^(?:PASS|FAIL) /gm) ?? []).length;
  const died = /SIGSEGV|Command was killed|JavaScript heap out of memory/.test(
    text,
  );
  return { passed, failed, totals, suites, died, path };
}

const [referencePath, oursPath] = process.argv.slice(2);
if (!referencePath || !oursPath) {
  console.error('usage: compare-suite-runs.mjs <reference.log> <ours.log>');
  process.exit(2);
}

const reference = parse(referencePath);
const ours = parse(oursPath);

const regressions = [...ours.failed].filter(t => reference.passed.has(t));
const recoveries = [...ours.passed].filter(t => reference.failed.has(t));
const sharedFailures = [...ours.failed].filter(t => reference.failed.has(t));
const missing = [...reference.passed].filter(
  t => !ours.passed.has(t) && !ours.failed.has(t),
);

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('', 22), pad('@prisma/adapter-pg', 20), 'prisma-postgrejs');
console.log('-'.repeat(64));
console.log(
  pad('  passed', 22),
  pad(reference.passed.size, 20),
  ours.passed.size,
);
console.log(
  pad('  failed', 22),
  pad(reference.failed.size, 20),
  ours.failed.size,
);
console.log(`\n  reference totals: ${reference.totals.trim()}`);
console.log(`  ours totals:      ${ours.totals.trim()}`);

if (sharedFailures.length) {
  console.log(
    `\n  ${sharedFailures.length} test(s) fail for both - the suite's own state on this server, not ours:`,
  );
  for (const t of sharedFailures.slice(0, 10)) console.log(`    ${t}`);
  if (sharedFailures.length > 10) {
    console.log(`    ... and ${sharedFailures.length - 10} more`);
  }
}

if (recoveries.length) {
  console.log(
    `\n  ${recoveries.length} test(s) this adapter passes that the reference does not:`,
  );
  for (const t of recoveries) console.log(`    ${t}`);
}

if (missing.length) {
  console.log(
    `\n  ${missing.length} test(s) the reference ran and this one did not:`,
  );
  for (const t of missing.slice(0, 10)) console.log(`    ${t}`);
}

/**
 * A truncated run cannot be compared, and saying so is the whole point.
 *
 * The first version of this script did not check: a run that segfaulted after
 * five suite files still had passing tests in it, still had no test it "lost"
 * to the reference - because it never reached them - and was reported green.
 * A false all-clear is worse than any finding this script can produce.
 */
for (const run of [reference, ours]) {
  const label = run === ours ? 'prisma-postgrejs' : '@prisma/adapter-pg';
  if (run.died || !run.totals) {
    console.log(
      `\n${RED}  The ${label} run did not finish - ${run.suites} suite file(s) ran` +
        `${run.died ? ', and it was killed' : ' and it printed no summary'}.` +
        ` Nothing below can be concluded from it.${RESET}`,
    );
    process.exit(2);
  }
}

// Same again by count: a run can exit cleanly having skipped most of the
// matrix, which is not a comparison either.
if (ours.suites < reference.suites * 0.9) {
  console.log(
    `\n${RED}  prisma-postgrejs ran ${ours.suites} suite file(s) against the reference's` +
      ` ${reference.suites}. Too few to compare.${RESET}`,
  );
  process.exit(2);
}

if (regressions.length) {
  console.log(
    `\n${RED}  ${regressions.length} test(s) this adapter loses that the reference wins:${RESET}`,
  );
  for (const t of regressions) console.log(`    ${t}`);
  process.exit(1);
}

if (ours.passed.size === 0) {
  console.log(
    `\n${RED}  No tests were recognised as passing - the run probably did not start.${RESET}`,
  );
  process.exit(2);
}

console.log(
  `\n${GREEN}  No test this adapter loses that @prisma/adapter-pg wins.${RESET}`,
);
