/**
 * One adapter, one scenario, one level, one process - and nothing else in it.
 *
 * Memory cannot be measured with both adapters alive in the same process, the
 * way the timings are: the baseline would be taken with both already up, so
 * their pools, buffers, decoders and prepared-statement caches sit *under* the
 * window rather than in it. What a client allocates once and keeps is exactly
 * the thing that would go missing, and on the payload scenarios that is most
 * of the difference. A child per adapter is also how PostgreJS's own suite
 * measures.
 *
 *   node --expose-gc benchmark/heap-worker.mjs <adapter> <scenario> <level> [idle]
 *
 * With `idle` it measures only what the client keeps: once with the calls
 * still coming, and once after long enough that a client which caches a buffer
 * between calls has had time to hand it back. That second reading costs a
 * wall-clock wait, so it is a pass of its own rather than part of every one.
 *
 * It prints one JSON line and exits.
 *
 * ## There is no per-call peak column, on purpose
 *
 * The obvious measurement - one call above a forced-GC baseline - was tried in
 * the Drizzle round and given up on, and the reasons carry over unchanged
 * because they are properties of the runtime rather than of that driver.
 * Sampled, a timer cannot fire faster than once a millisecond, so a call that
 * returns in 0.2 ms takes zero samples; sampled over a longer call it
 * understates unevenly between the two clients, which moves the comparison and
 * not merely the figure; and read exactly at the end of one call, the first
 * call after a collection is not like the ones after it. Settling that fixes
 * the short rows and ruins the large ones. The two failures are mutually
 * exclusive, so the quantity is not measurable that way.
 *
 * What is measured instead is below: everything the calls asked for, whether
 * or not any of it survived, which does not depend on where a collection lands.
 */
import net from 'node:net';

// Bytes that actually crossed the socket, counted at the socket rather than
// taken from either client's own accounting. The binary format's wire cost is
// otherwise argued from the encoding, and that argument has come out backwards
// before - for an array of small integers, binary is the longer of the two.
let received = 0;
let sent = 0;
const push = net.Socket.prototype.push;
net.Socket.prototype.push = function (chunk, ...rest) {
  if (chunk) received += chunk.length;
  return push.call(this, chunk, ...rest);
};
const write = net.Socket.prototype.write;
net.Socket.prototype.write = function (chunk, ...rest) {
  if (chunk) sent += chunk.length ?? Buffer.byteLength(chunk);
  return write.call(this, chunk, ...rest);
};

const { CONTROL, DRIVER, LEVELS, openClients, scenariosMatching } =
  await import('./scenarios.mjs');

/**
 * `heapUsed` alone cannot see a `Buffer`, and a `bytea` *is* a `Buffer` - so a
 * heap figure on its own reads a 4 MB column as a rounding error. A large
 * string built out of one is external too, at two bytes a character, which is
 * how the reference adapter holds that same column. Both are counted.
 */
const usedBytes = () => {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
};

// Taken before a client exists, so what it grows by can be told apart from
// what Node and the generated Prisma client were already holding.
globalThis.gc();
globalThis.gc();
const cold = usedBytes();

const [which, name, level, mode] = process.argv.slice(2);
const scenario = scenariosMatching().find(s => s.name === name);
if (!scenario) throw new Error(`no scenario named ${name}`);
if (which !== CONTROL && which !== DRIVER)
  throw new Error(`no adapter named ${which}`);
if (!LEVELS.includes(level)) throw new Error(`no level named ${level}`);

const clients = openClients(level, scenario.pooled);
const db = (await clients.ready())[which];

// Warm up first, through the same path the scenario uses: the JIT, the pool's
// connections, and on PostgreJS the prepared statement each distinct SQL
// earns. What is measured is a scenario in its steady state, not its first
// call - a cold client is a different and much less useful question.
if (scenario.setup) await scenario.setup(db, level);
const warmup = Math.min(scenario.iters * 4, 60);
for (let i = 0; i < warmup; i++) await scenario[level](db, i);
if (scenario.setup) await scenario.setup(db, level);

globalThis.gc();
globalThis.gc();
// What the adapter holds at rest, warm: its pool, its buffers, its prepared
// statements. Separate from what a call costs and from what a run peaks at -
// three different questions with three different answers.
const atRest = usedBytes();

/**
 * The same question asked again after a pause, because one of these clients
 * answers it differently depending on when you ask.
 *
 * PostgreJS writes each message into one growing buffer per connection and
 * reclaims it after `houseKeepMs` (5s) of quiet, so a client that has just
 * sent a 4 MB parameter is still holding the 4 MB it grew to. That is true
 * while the calls keep coming and gone shortly after they stop, and a single
 * figure cannot say both. `pg` builds a fresh buffer per message and drops it,
 * so it has nothing to hand back and reads the same either way - which is what
 * makes the gap look like a leak until you wait.
 */
if (mode === 'idle') {
  await new Promise(resolve => setTimeout(resolve, 6000));
  globalThis.gc();
  globalThis.gc();
  console.log(
    JSON.stringify({
      adapter: which,
      scenario: name,
      level,
      heldKb: (atRest - cold) / 1024,
      idleHeldKb: (usedBytes() - cold) / 1024,
    }),
  );
  await clients.close();
  process.exit(0);
}

/**
 * One batch, sampled at 1 ms, answering two questions that are not the same
 * and are easily confused for each other.
 *
 * **What a call allocates.** Every fall in `heapUsed + external` is a
 * collection handing memory back; summed over the batch and added to what the
 * heap still holds at the end, that is everything the calls asked for. Nothing
 * in it depends on where a collection lands, which is what made a per-call
 * peak unmeasurable. The parent cross-checks it against `--trace-gc`, which
 * arrives at the same quantity a completely different way and cannot see a
 * `Buffer` at all.
 *
 * **What the process peaks at.** The high-water of the same samples, with
 * nothing collected on purpose, which is what the process has to be able to
 * hold. It is deliberately not the same ranking: it is where the runtime chose
 * to collect, so a client that allocates a third as much can sit higher for
 * reaching the threshold a third as often. Take the allocation column as the
 * comparison and the high-water as the sizing.
 *
 * Long enough for the per-call figure to converge with the batch, and longer
 * where the calls are cheap.
 */
const iterations = Math.max(scenario.iters * 20, 100);
let highest = 0;
let highestRss = 0;
let collected = 0;

if (scenario.setup) await scenario.setup(db, level);
globalThis.gc();
globalThis.gc();
const batchBase = usedBytes();
let previous = batchBase;

const watch = setInterval(() => {
  const usage = process.memoryUsage();
  const used = usage.heapUsed + usage.external;
  if (used > highest) highest = used;
  if (used < previous) collected += previous - used;
  previous = used;
  if (usage.rss > highestRss) highestRss = usage.rss;
}, 1);

// The parent runs this child under `--trace-gc` and adds up what each
// collection gave back between these two marks.
console.log(`MARK ${performance.now().toFixed(0)}`);
const receivedBefore = received;
const sentBefore = sent;
for (let i = 0; i < iterations; i++) await scenario[level](db, i);
console.log(`END ${performance.now().toFixed(0)}`);

clearInterval(watch);
const batchEnd = usedBytes();
if (batchEnd < previous) collected += previous - batchEnd;

console.log(
  JSON.stringify({
    adapter: which,
    scenario: name,
    level,
    iterations,
    // what it holds warm, what a call costs, what the run peaks at, and what
    // crossed the socket in each direction
    heldKb: (atRest - cold) / 1024,
    allocPerCallKb: (batchEnd - batchBase + collected) / iterations / 1024,
    sustainedKb: (highest - cold) / 1024,
    sustainedRssKb: highestRss / 1024,
    wireKb: (received - receivedBefore) / 1024 / iterations,
    wireOutKb: (sent - sentBefore) / 1024 / iterations,
  }),
);

await clients.close();
process.exit(0);
