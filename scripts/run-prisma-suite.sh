#!/usr/bin/env bash
#
# Runs Prisma's own client functional suite against this adapter, and against
# @prisma/adapter-pg in the same invocation.
#
# The suite (packages/client/tests/functional, 91 suite directories) is
# parameterised by driver adapter, but the list of adapters is a closed enum:
# scripts/prisma-suite.patch adds `js_postgrejs` to it in the five places it
# has to be named - the enum, the per-provider adapter list, the relation-mode
# table, the factory that constructs the adapter, and the table that says which
# server URL an adapter runs against. Nothing else about the checkout changes.
#
# The control run is the point. A given Prisma tag does not pass its own suite
# cleanly on every PostgreSQL version and every machine, so a fixed list of
# expected failures would be wrong somewhere. Running @prisma/adapter-pg over
# the same server in the same invocation measures the baseline instead, and the
# only thing that fails this script is a test THIS adapter loses that the
# reference adapter wins.
#
# Everything lands in $WORK_DIR; nothing outside this repository is modified,
# and nothing is installed globally - pnpm comes from corepack at the version
# the Prisma repo pins.
#
# CONSENT. The suite creates a throwaway database per test suite and drops it
# afterwards, which goes through Prisma Migrate, which refuses to run under an
# AI agent without the user's explicit consent (packages/migrate/src/utils/
# ai-safety.ts). That consent is per-session and belongs to the person giving
# it, so it is not written into this script: pass their own words in
# PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION. A human running this by hand
# needs nothing.
#
# Usage: scripts/run-prisma-suite.sh
#   PRISMA_VERSION      tag to check out (default: the @prisma/client devDependency)
#   SUITE_SERVER        server to run against, WITHOUT a database
#                       (default: built from PGHOST/PGPORT/PGUSER/PGPASSWORD)
#   WORK_DIR            where the checkout lives
#                       (default: $TMPDIR/prisma-postgrejs-suite)
#   ONLY                a jest name pattern, to run one suite while iterating
#   SKIP_INSTALL        set once the checkout is built, to re-run in seconds
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/prisma-postgrejs-suite}"
CHECKOUT="$WORK_DIR/prisma"
PRISMA_VERSION="${PRISMA_VERSION:-$(node -p "require('$REPO_DIR/package.json').devDependencies['@prisma/client'].replace(/^[^0-9]*/,'')")}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required"
command -v corepack >/dev/null 2>&1 || die "corepack is required (ships with Node >= 16)"

# ---------------------------------------------------------------- database

SUITE_SERVER="${SUITE_SERVER:-postgres://${PGUSER:-postgres}:${PGPASSWORD:-postgres}@${PGHOST:-127.0.0.1}:${PGPORT:-5432}}"
SUITE_SERVER="${SUITE_SERVER%/}"
say "Server: ${SUITE_SERVER#*@}"

# The functional suite substitutes PRISMA_DB_NAME per test suite and creates
# that database itself. `tests` is the name the rest of the repo's tooling
# assumes exists, so it is created here rather than assumed.
node -e '
const url = new URL(process.argv[2] + "/postgres")
const pg = require(process.argv[1] + "/node_modules/pg")
const c = new pg.Client(url.toString())
c.connect()
  .then(() => c.query(`create database "tests"`))
  .then(() => console.log("  created tests"), e => {
    if (e.code !== "42P04") throw e
    console.log("  tests already there")
  })
  .finally(() => c.end())
' "$REPO_DIR" "$SUITE_SERVER"

# ---------------------------------------------------------------- checkout

if [ -z "${SKIP_INSTALL:-}" ]; then
  say "Checking out prisma/prisma $PRISMA_VERSION"
  rm -rf "$CHECKOUT"
  mkdir -p "$WORK_DIR"
  git clone --depth 1 --branch "$PRISMA_VERSION" \
    https://github.com/prisma/prisma.git "$CHECKOUT" 2>&1 | tail -1

  say "Adding js_postgrejs to the adapter matrix"
  git -C "$CHECKOUT" apply --verbose "$REPO_DIR/scripts/prisma-suite.patch" 2>&1 | tail -3

  say "Installing (this is a monorepo; expect several minutes and a few GB)"
  (cd "$CHECKOUT" && corepack pnpm install --frozen-lockfile >/dev/null)

  say "Building"
  (cd "$CHECKOUT" && corepack pnpm build >/dev/null)
fi

# The suite's package scripts run under `dotenv -e ../../.db.env`, which wins
# over the environment, so the server goes in the file rather than in an
# export. Rewritten on every run: the checkout is throwaway, and a stale URL
# here is the failure mode that costs the most time to recognise.
say "Pointing the checkout at the server"
node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const [file, server] = process.argv.slice(1)
const set = (text, key, value) =>
  text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}="${value}"`)
let text = readFileSync(file, "utf8")
text = set(text, "TEST_POSTGRES_URI", `${server}/tests`)
text = set(text, "TEST_FUNCTIONAL_POSTGRES_URI", `${server}/PRISMA_DB_NAME`)
writeFileSync(file, text)
for (const line of text.split("\n")) {
  if (/^TEST_(FUNCTIONAL_)?POSTGRES_URI=/.test(line)) console.log("  " + line)
}
' "$CHECKOUT/.db.env" "$SUITE_SERVER"

# ------------------------------------------------------- link this adapter
#
# The suite does `require('prisma-postgrejs')`, so the built package and the
# driver it needs are dropped into the monorepo's root node_modules, where
# both resolve from anywhere inside it. A symlink would make `postgrejs`
# resolve from this repository instead of the checkout, which is the one
# thing that must not differ between the two runs.
#
# The checkout is a pnpm workspace and this repository is not, so postgrejs's
# own dependencies are flat here and would not resolve there. They are walked
# and copied alongside it - but only where the checkout has no package of that
# name already, since replacing one (tslib, say) would change the control run
# as well and make the comparison measure the wrong thing.

say "Building and linking prisma-postgrejs"
(cd "$REPO_DIR" && npm run build >/dev/null)
rm -rf "$CHECKOUT/node_modules/prisma-postgrejs" "$CHECKOUT/node_modules/postgrejs"
cp -R "$REPO_DIR/build" "$CHECKOUT/node_modules/prisma-postgrejs"
node -e '
const { cpSync, existsSync, readFileSync } = require("node:fs")
const [repo, checkout] = process.argv.slice(1)
const target = checkout + "/node_modules"
const seen = new Set()
const copied = []
const skipped = []

// Read straight off disk rather than through require.resolve: a package whose
// "exports" does not list ./package.json (ts-gems, for one) cannot be resolved
// that way, and npm installs this repository flat anyway.
const walk = name => {
  if (seen.has(name)) return
  seen.add(name)
  const dir = `${repo}/node_modules/${name}`
  const manifest = `${dir}/package.json`
  if (!existsSync(manifest)) {
    skipped.push(`${name} (not installed here)`)
    return
  }
  const dest = `${target}/${name}`
  if (name === "postgrejs" || !existsSync(dest)) {
    cpSync(dir, dest, { recursive: true, dereference: true })
    copied.push(`${name}@${JSON.parse(readFileSync(manifest, "utf8")).version}`)
  } else {
    skipped.push(name)
  }
  for (const dep of Object.keys(JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {})) {
    walk(dep)
  }
}
walk("postgrejs")
console.log("  copied:  " + copied.join(", "))
if (skipped.length) console.log("  already in the checkout: " + skipped.join(", "))
' "$REPO_DIR" "$CHECKOUT"
node -p "'  prisma-postgrejs ' + require('$CHECKOUT/node_modules/prisma-postgrejs/package.json').version"

# -------------------------------------------------------------------- run
#
# `--no-types` runs the code tests only. The type tests compare generated
# .d.ts against expectations and never reach a driver adapter, so they would
# cost ten minutes a run to report the same answer twice.
#
# `--logHeapUsage` is on for both runs. The suite runs ~190 test files in one
# process under --runInBand, holding every one's module graph, so the heap
# climbs into the gigabytes whichever adapter is in use - and a run that dies
# partway is easy to mistake for an adapter fault. Having the curve for both
# runs is what tells the two apart.

run_suite() { # $1 = adapter label, $2 = output file
  local adapter="$1" out="$2"
  local extra=()
  [ -n "${ONLY:-}" ] && extra+=(-t "$ONLY")
  (cd "$CHECKOUT/packages/client" &&
    corepack pnpm run test:functional --adapter "$adapter" --no-types \
      --verbose --logHeapUsage ${extra[@]+"${extra[@]}"} 2>&1) | tee "$out" || true
}

mkdir -p "$WORK_DIR/out"

# Stored snapshots are keyed by the full test name, and the suite's describe
# name carries the adapter label - so a previous run of this adapter has left
# `js_postgrejs` entries behind, written from its own output. They are dropped
# before the control run and re-derived from the reference's after it.
# Listed rather than named with a pathspec: `**` is not glob magic to git
# unless the pathspec says so, and a `*` pattern would sweep up the patched
# files in the same directory tree.
git -C "$CHECKOUT" ls-files 'packages/client/tests/functional' |
  grep '/__snapshots__/' |
  xargs -r git -C "$CHECKOUT" checkout --

say "Control run: @prisma/adapter-pg"
run_suite js_pg "$WORK_DIR/out/js_pg.log" >/dev/null

say "Copying the reference's snapshots onto this adapter's keys"
node "$REPO_DIR/scripts/seed-suite-snapshots.mjs" "$CHECKOUT"

say "This adapter: prisma-postgrejs"
run_suite js_postgrejs "$WORK_DIR/out/js_postgrejs.log" >/dev/null

# ---------------------------------------------------------------- compare

say "Result"
node "$REPO_DIR/scripts/compare-suite-runs.mjs" \
  "$WORK_DIR/out/js_pg.log" "$WORK_DIR/out/js_postgrejs.log"
