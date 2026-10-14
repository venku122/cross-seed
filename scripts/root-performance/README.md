# External-process root performance harness

This harness runs the existing pinned `combined-cleanup.mjs` fixture/setup and
actual compiled cleanup module in a fresh worker. A checked harness
transformation replaces only transport and ping scaffolding, changes its
disposable SQLite DB from memory to file-backed, and ends HTTP measurement
before untimed diagnostic queries. It leaves the original benchmark scripts
untouched and records original and executed worker identities. A changed
transformation anchor fails closed. The qB catalog and JSON serialization are in
a separate process; HTTP decode and storage work remain attributable to the
daemon. The load generator is another separate process, using a rate-controlled
open-loop schedule. Every offered slot records generator lag, latency including
full response body, outcome, and total latency including lag. Slow responses do
not reduce offered rate. `/stop` ends the active admission window then drains
requests admitted during that window. Idle samples are excluded. Errors and
timeouts remain in the denominator; percentile analysis must report their rate
beside successful latency distributions.

## Smoke checks (no product timing benchmark)

```sh
NODE=/Users/tjt/src/agents/mayor/projects/cross-seed-handoff/runtime/node-v26.11.1-darwin-arm64/bin/node
"$NODE" --test scripts/root-performance/harness.test.mjs
```

## Reproducible serialized A/B/A execution

Build the approved baseline and candidate ahead of time with the same lockfile
and Node runtime. Do not rebuild while the matrix runs. Both must have compiled
`cross-seed/dist` and available dependencies. Set absolute paths below; the
baseline must be the PR #2 cleanup common base. The candidate is the repaired
source-publication tree. This runner executes A1/B/A2 in sequence, five rounds
per fixture, with each worker freshly started. It never installs dependencies.
Run timing only after correctness gates finish and while no other benchmarks
run.

```sh
export BASELINE=/absolute/path/to/compiled-pr2-base
export CANDIDATE=/absolute/path/to/compiled-candidate
export OUTPUT=/absolute/path/to/fresh/results
BENCH_COUNT=8194 BENCH_SHAPES=1,12,72,10001,observed BENCH_ROUNDS=5 \
  "$NODE" scripts/root-performance/run-aba.mjs "$BASELINE" "$CANDIDATE" "$OUTPUT"
```

`observed` cycles the aggregate 8,194-source histogram: 4,971 with one file,
2,869 with 2–24, 292 with 25–100, 50 with 101–1,000, 10 with 1,001–10,000, and
two above 10,000. Counts within each bucket are deterministic synthetic values;
actual JSON byte histograms and invocation weights are not yet known. Uniform 1,
12, 72 and 10,001 fixtures isolate the file buckets without pretending they are
the live workload. `SEASON_SHAPE=1-24` groups synthetic episode titles into
season sets cycling cardinalities 1–24; `SEASON_SHAPE=25-72` cycles 25–72. The
final group can be truncated. Run each separately using a fresh output. `same`
preserves the original worker's title shape. Multiple combined keys and 1M/1.4M
capacity fixtures still need separate storage/golden cases: these end-to-end
fixtures alone do not establish repaired-store lookup performance.

For ablation, run the **same commands and settings** separately against these
prebuilt trees, always keeping PR #2 as A: PR2+#6 cache strategy, PR2+#9 rebuild
strategy, PR2+#6+#9 combined, and repaired store. Do not credit combined medians
to an individual PR. Run health zero/one/multi-browser tests separately; this
runner tests ping during full cleanup and does not simulate browser health TTLs.
`PING_RATE` defaults to 200 requests/sec, `PING_TIMEOUT` to 2,000ms. Set
`BENCH_OPERATIONS` to repeat cleanup jobs consecutively if refresh windows
cannot admit thousands of pings (keep the same repetitions across all A/B/A
workers); never include idle observations to increase the count. The unmodified
generator instrumentation and integrity/digest checks remain; a repaired schema
or legitimate corrected ownership difference may require a reviewed golden
fixture update. Failure is retained, never ignored as a timing sample.

## 2 GiB capped Linux run

Use a local disposable Linux/Docker environment; no production deployment or
TrueNAS change is part of these commands. `--docker` starts **only** the
measured worker in a container with
`--memory=2147483648 --memory-swap=2147483648` (zero swap), and all daemon
descendants/workers belong to its cgroup. The fake qB, fixture generation,
control plane and load generator remain host processes. Linux host networking is
required. The macOS runner is uncapped and cannot meet the cgroup acceptance
gate. Do not interpret uncapped smoke checks as evidence for the 2 GiB target.

```sh
# On Linux, using Node 26.11.1 and disposable prebuilt checkouts:
BENCH_COUNT=8194 BENCH_ROUNDS=5 BENCH_NODE_IMAGE=node:26.11.1-bookworm-slim \
  node scripts/root-performance/run-aba.mjs "$BASELINE" "$CANDIDATE" "$OUTPUT" --docker
```

The runner records Docker inspect identity (including image ID), memory.peak,
memory.events and cpu.stat after the node worker exits, including cap failures.
It preserves nonzero exit/OOM and stops the matrix. Do not raise the cap on
failure. Source/compiled/lock/runtime/controller identities and raw failures are
private captures. Additional CPU/heap/GC profiling must be explicitly added to
the worker invocation; it is not implemented or claimed here. `compose.yaml` is
an equivalent cap manifest for manually prepared worker invocations, not a
production stack. A Linux-compatible dependency tree is required; do not reuse
native Darwin addons in a Linux image.

## Privacy and output interfaces

`OUTPUT/private` uses mode 0700; manifest, raw logs and container inspect
use 0600. These can contain paths, digests and errors and **must not be
published**. `OUTPUT/samples.jsonl` contains fixed phase/fixture enums, numeric
telemetry via an explicit whitelist, HTTP timing samples/outcomes, and cgroup
counters only. It excludes names, filesystem paths, torrent hashes, source
identities, SQL, bindings, tracker/endpoint labels and arbitrary error text.
Aggregate publishing never recursively copies unknown fields.
Runtime/source/compiled cryptographic identity evidence remains private for
reproducibility.

Standalone interfaces: `fake-qb.mjs COUNT FILE_SHAPE ALIASES` sends an IPC
`ready` with its localhost origin (or writes ready JSON when directly executed);
`control.mjs` exposes `/arm` with `{url}`, `/begin`, `/stop` and owns a separate
`loadgen.mjs URL RATE TIMEOUT_MS` child. `loadgen.mjs` receives IPC
`{type:'begin'}` then `{type:'stop'}`, and emits ready, begun, result.
`FIXTURE_PORT`/`CONTROL_PORT` and `FIXTURE_BIND`/`CONTROL_BIND` control local
binding. Avoid binding publicly.

The repaired-store bridge detects the compiled `sourceStore.js`, imports newly
written legacy fixture rows through migration 19 **before timing**, measures the
owned `ensemble_membership` table, and projects ownership rows to legacy
semantic tuples for comparison. It separately records ordered and deduplicated
semantic digests in private correctness captures and asserts that the preserved
legacy backup remains unchanged during cleanup. A/B/A requires equal semantic
output and known-source selection order for this one-alias synthetic fixture.
Named-host alias restoration and other intentional fixes need separate reviewed
golden fixtures; no broad digest-equality claim applies to those cases. Baseline
and candidate both complete fixture preparation and warm client preload outside
the measurement window. The repaired store does not have to call the obsolete
legacy membership generator; its authoritative membership count is checked
instead.

For repaired storage, the data digest and `remainingData` gate now use visible
rows: paths owned only by unavailable, removed, superseded or disabled origins
are excluded. An enabled visible owner keeps a shared path visible, and null
legacy paths remain preserved. These diagnostic queries run after measurement.
`rawDataRows`, `rawLegacyMembershipRows` and `rawOwnedMembershipRows` record
retained recovery storage separately as numeric aggregate telemetry; retained
rows do not cause the visible-output equality gate to fail. The preserved legacy
table still has its independent unchanged-digest check.

## Opt-in profiling (diagnostic runs)

Use a **fresh separate output directory** with `BENCH_PROFILE=1`, the same A/B/A
process schedule, pinned compiled trees and fixture settings. Profiling is
serialized through the same comparative slot; it does not start concurrent
benchmarks. Every sample is labeled `profiled-diagnostic` versus
`unprofiled-timing`, and the private manifest records profiler settings and
harness/runtime identities. Do not combine profiled timings with unprofiled
medians.

```sh
BENCH_PROFILE=1 BENCH_COUNT=8194 BENCH_SHAPES=observed BENCH_ROUNDS=1 \
  "$NODE" scripts/root-performance/run-aba.mjs "$BASELINE" "$CANDIDATE" "$PROFILE_OUTPUT"
```

The worker enables Node CPU profiles (1,000us sampling) and sampled heap
profiles (32,768-byte sampling). Raw `.cpuprofile`/`.heapprofile` files and
their private identity map remain under mode-0700 `OUTPUT/private/*-profiles`,
with raw files mode 0600. Missing or malformed profiles fail the diagnostic
capture gate. Their sanitized summaries contain only numeric totals and the
fixed stages `cachehydrate/publication`, `dbapply`, `generation`, `other`.
Classification uses module/function metadata privately; call frames, URLs, names
and source hashes never enter published summaries. These profiles cover the
**whole worker**, including preparation/validation, and sampled heap bytes
describe the V8 sampling profile at exit; they are not exact active-job
cumulative allocation counts.

The active profiler starts just before the measured cleanup loop and stops just
after it. GC pauses are intersected with that interval, including
boundary-crossing pauses. It captures main-thread GC counts/durations and
periodic 10ms process RSS and main-thread heap observations, their peaks, sample
count and maximum gap. `positiveHeapGrowthBytes` is the sum of positive sampled
main-heap changes: an allocation proxy that misses allocations collected between
samples, not a total allocation measurement. RSS includes the entire process and
its workers; `heapUsed`/`heapTotal` describe the main isolate. Worker-isolate
heaps are explicitly marked unsampled. Synchronous stalls delay periodic
observations, so retain cgroup `memory.peak` as the independent whole-container
peak evidence.

Object heap snapshots are disabled by this harness. Any separately approved
object-snapshot investigation must use synthetic fixtures only; never publish
real-data object snapshots. Raw profile files also stay private even for
synthetic fixtures. `legacyReferenceMergePlan` is explicitly the old-table
reference plan; `actualPathPlan` is reconstructed from the actual captured query
and bindings outside timing, and must be interpreted with the pinned compiled
implementation.

The profiled and unprofiled controllers share an exclusive comparative-slot lock
(`BENCH_SLOT_PATH`, default `scripts/root-performance/.comparative-slot`). A
second controller fails before starting measured workers. Normal completion
releases it; a killed controller leaves private `owner.json` evidence. Inspect
that PID before manually clearing an interrupted lock. Different harness
directories must set the same `BENCH_SLOT_PATH` to share the slot.
