#!/usr/bin/env node
//
// Copies the reference adapter's stored snapshots onto this adapter's keys.
//
// Jest keys a stored snapshot by the full test name, and the functional
// suite's describe name carries the adapter label - so every
// `toMatchSnapshot()` in the repository is recorded as
// `... (provider=postgresql, js_pg) <test> 1` and there is no entry at all for
// a third-party adapter. Left alone, jest treats a missing snapshot as a new
// one, writes it and passes: the test compares this adapter against itself and
// can never fail, while the same test in the control run is compared against a
// recorded value. The two runs would then not be measuring the same thing.
//
// Duplicating each `js_pg` entry under a `js_postgrejs` key turns those tests
// into what they should be here - this adapter's output checked against the
// reference adapter's recorded output. Existing `js_postgrejs` entries are
// overwritten, since they can only have come from an earlier run of this
// adapter writing its own answer.
//
// Usage: seed-suite-snapshots.mjs <prisma checkout> [fromLabel] [toLabel]

import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [checkout, fromLabel = 'js_pg', toLabel = 'js_postgrejs'] =
  process.argv.slice(2);
// Matched with the closing bracket of the matrix row attached. The labels are
// prefixes of one another - `js_pg` is the start of `js_pg_cockroachdb` - and
// a bare substring match would seed a `js_postgrejs_cockroachdb` key that no
// test will ever ask for.
const from = `${fromLabel})`;
const to = `${toLabel})`;
if (!checkout) {
  console.error('usage: seed-suite-snapshots.mjs <prisma checkout>');
  process.exit(2);
}

const files = globSync(
  'packages/client/tests/functional/**/__snapshots__/*.snap',
  {
    cwd: checkout,
  },
);

let seeded = 0;
for (const relative of files) {
  const path = join(checkout, relative);
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = [];
  const copies = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const key = lines[i].match(/^exports\[`(.*)`\] = `/);
    if (!key) continue;
    // Take the whole record: it ends at the first line that is exactly '`;',
    // which is the one delimiter jest's own writer guarantees and the only one
    // that cannot occur inside an escaped value.
    const block = [lines[i]];
    if (!/`;$/.test(lines[i])) {
      while (++i < lines.length) {
        out.push(lines[i]);
        block.push(lines[i]);
        if (lines[i] === '`;') break;
      }
    }
    if (!key[1].includes(from)) continue;
    copies.push(block.join('\n').replace(key[1], key[1].replaceAll(from, to)));
    // key[1] is replaced as a whole, so nothing inside the recorded value is
    // touched - an error message can name the adapter too.
  }
  if (!copies.length) continue;

  // Drop whatever this adapter wrote for itself on an earlier run, then append
  // the copies. Order does not matter to jest; it reads the file as a module.
  const kept = [];
  for (let i = 0; i < out.length; i++) {
    const key = out[i].match(/^exports\[`(.*)`\] = `/);
    if (key?.[1].includes(to)) {
      if (!/`;$/.test(out[i])) while (++i < out.length && out[i] !== '`;');
      continue;
    }
    kept.push(out[i]);
  }
  writeFileSync(
    path,
    `${kept.join('\n').replace(/\n+$/, '')}\n\n${copies.join('\n\n')}\n`,
  );
  seeded += copies.length;
  console.log(`  ${relative}: ${copies.length}`);
}
console.log(`  ${seeded} snapshot(s) copied from ${fromLabel} to ${toLabel}`);
