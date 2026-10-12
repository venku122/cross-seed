# Cooperative ensemble rebuilding

Baseline is the completed cleanup paging PR2, commit
`d330de4986c562406c71613e1f3a8953e8d5ccb6`. Pruning pagination, root guards and
housekeeping retain that implementation. This change replaces the all-source
membership flatMap in cleanup and torrent indexing.

Generation runs in ordered groups of at most 64 sources. All reads in a group
settle before an error propagates. A 500-row buffer writes to a temporary SQLite
staging table, with real setImmediate yields after a flush or 256 sources. The
ordered atomic INSERT SELECT then applies the original client_host/path conflict
behavior. NULL-host aliases and exact repeats remain stored; named-host aliases
retain the original last-winner behavior. This performance patch does not repair
ensemble identity.

The initial transaction-across-generation prototype let timers run but reserved
SQLite's sole connection. It was replaced before comparative acceptance: staging
releases the connection during generation, and tests prove another DB reader can
progress. The final atomic apply is still synchronous main-thread SQLite and can
block SQL-backed endpoints and timers. TEMP staging depends on the existing
single-entry SQLite pool and requires temporary storage. Memory is bounded for
intermediate production rows, not the whole job: client/file arrays remain, plus
up to 64 complete generated source-entry arrays and the 500-row buffer. A single
source can still generate a large array or synchronously scan many files.

## Correctness

Node 26.11.1 full source gates and 100 workspace tests pass. Ten new regressions
exercise early staging, timers and concurrent DB reads, ordered NULL aliases and
repeats, existing named-host row order, bounded out-of-order generation, actual
startup indexing, empty catalogs, generation failure and late SQL trigger
rollback. Failed staging/apply leaves live memberships intact and drops TEMP
state. Client-cache refresh before the membership writer remains outside this
atomic apply. A known saved-torrent assertion race was also observed and
retained; it reproduced on pristine upstream in one of five runs. The final
suite passed.

## Reproduction

Build pristine PR2 and this tree with the same lockfile and Node 26. Run alone:

```sh
node scripts/benchmarks/ensemble-streaming-aba.mjs BASELINE HEAD EXTERNAL_RESULTS
```

The matrix uses 0/1/100/8,194/20,000/30,000 sources and 1/2/5 parsed title
aliases, plus 100 sources with 1,000 files, one with 10,000 files, delayed
filesystem checks and delayed download-directory lookups. It invokes compiled
cleanupDB and the public startup indexing wrapper, the actual membership
generator, migrated SQLite and production serve()/api/ping. Each fixture runs
five fresh A/B/A process rounds. Ordered membership digests must match and
source/compiled identities remain pinned throughout. A concurrent SQLite count
probe measures DB-reader latency; its SQL/CPU is included and disclosed rather
than presented as an actual application endpoint. Final apply and maximum
statement durations are recorded separately.

These rebuild fixtures supply already-materialized searchees through fake
clients; they do not measure real-adapter catalog decoding/cache serialization.
The separate four-adapter cache matrix and combined actual-qB cleanup benchmark
address those boundaries. Access delays are timer mocks, not NFS/ZFS
measurements. Ping p99 is read with sparse sample counts. Sampled RSS/heap can
miss short bursts; process maximum RSS includes fixture setup but excludes
post-measurement digest checking.

Raw, negative and intermediate failure evidence remains external. The bounded
concurrency case caught a callback argument leak into the generator's optional
save-path-map parameter; a source-only callback and regression fixed it before
publication. No production client or filesystem was accessed.

## Measured acceptance

**Draft: the 5% performance regression gate is not clean.** All 420 workers (28
fixtures × five fresh A/B/A rounds) pass generated-row, ordered membership,
SQLite integrity and compiled identity checks. Candidate production was frozen
at `baf8944aabb259f82bb54c8e1ad35ddc7a5baf89`, with Node 26.11.1 / SQLite 3.53.4
on macOS arm64, Apple M1 Pro. The publication head may add only summaries and
the reproducible summary script; application source remains pinned.

The table reports median wall, sampled peak RSS, and median per-worker HTTP p99.
Five head workers make across-worker p95/p99 observed maxima, not stable
population tails. Pooled HTTP observations and their counts, A1/A2
distributions, CPU, loop p95/p99/max, SQL-reader latency and final statement
costs are external.

| Mode    | Sources | Aliases |  Files | Access/source delay ms | Base/head wall ms | Base/head sampled RSS MiB | Base/head ping p99 ms |
| ------- | ------: | ------: | -----: | ---------------------- | ----------------- | ------------------------- | --------------------- |
| refresh |       0 |       1 |      1 | 0/0                    | 2.24 / 2.36       | 131.78 / 132.05           | 0.95 / 2.22           |
| refresh |       0 |       2 |      1 | 0/0                    | 2.22 / 2.62       | 131.85 / 131.95           | 1.05 / 2.40           |
| refresh |       0 |       5 |      1 | 0/0                    | 2.57 / 2.77       | 131.88 / 131.72           | 1.42 / 2.67           |
| refresh |       1 |       1 |      1 | 0/0                    | 2.94 / 3.55       | 131.85 / 132.14           | 1.04 / 3.50           |
| refresh |       1 |       2 |      1 | 0/0                    | 2.97 / 3.12       | 131.83 / 132.23           | 1.05 / 1.10           |
| refresh |       1 |       5 |      1 | 0/0                    | 2.90 / 3.15       | 131.94 / 132.00           | 1.12 / 0.86           |
| refresh |     100 |       1 |      1 | 0/0                    | 4.68 / 5.12       | 132.16 / 132.28           | 2.19 / 2.16           |
| refresh |     100 |       2 |      1 | 0/0                    | 5.42 / 5.95       | 132.24 / 132.59           | 1.91 / 2.03           |
| refresh |     100 |       5 |      1 | 0/0                    | 7.81 / 8.63       | 132.95 / 133.77           | 2.99 / 5.75           |
| refresh |   8,194 |       1 |      1 | 0/0                    | 79.59 / 77.77     | 192.38 / 158.41           | 68.22 / 10.56         |
| refresh |   8,194 |       2 |      1 | 0/0                    | 132.15 / 131.99   | 200.55 / 170.17           | 121.11 / 9.78         |
| refresh |   8,194 |       5 |      1 | 0/0                    | 274.27 / 284.29   | 215.67 / 188.27           | 258.65 / 23.98        |
| refresh |  20,000 |       1 |      1 | 0/0                    | 166.19 / 172.72   | 219.35 / 200.17           | 149.64 / 8.62         |
| refresh |  20,000 |       2 |      1 | 0/0                    | 286.98 / 293.01   | 230.59 / 203.38           | 268.54 / 20.46        |
| refresh |  20,000 |       5 |      1 | 0/0                    | 636.29 / 675.00   | 261.41 / 203.30           | 610.78 / 63.86        |
| refresh |  30,000 |       1 |      1 | 0/0                    | 239.89 / 253.60   | 235.11 / 211.91           | 212.66 / 18.00        |
| refresh |  30,000 |       2 |      1 | 0/0                    | 462.79 / 467.02   | 253.34 / 213.03           | 426.36 / 39.30        |
| refresh |  30,000 |       5 |      1 | 0/0                    | 965.68 / 1022.44  | 303.48 / 215.83           | 936.40 / 7.47         |
| refresh |     100 |       2 |  1,000 | 0/0                    | 7.23 / 7.57       | 150.73 / 150.62           | 7.15 / 7.58           |
| refresh |       1 |       5 | 10,000 | 0/0                    | 3.64 / 4.10       | 134.38 / 134.08           | 2.16 / 3.95           |
| refresh |     100 |       2 |      1 | 5/0                    | 17.31 / 18.20     | 132.12 / 132.41           | 5.54 / 1.21           |
| refresh |     100 |       2 |      1 | 0/5                    | 10.43 / 16.39     | 132.22 / 132.53           | 3.36 / 1.14           |
| index   |       0 |       2 |      1 | 0/0                    | 1.52 / 1.67       | 131.75 / 131.98           | 1.01 / 1.05           |
| index   |       1 |       2 |      1 | 0/0                    | 2.15 / 2.43       | 131.89 / 131.92           | 1.21 / 1.02           |
| index   |     100 |       2 |      1 | 0/0                    | 4.41 / 4.89       | 132.33 / 132.19           | 4.42 / 2.10           |
| index   |   8,194 |       2 |      1 | 0/0                    | 133.37 / 127.26   | 200.86 / 180.47           | 131.71 / 16.04        |
| index   |  20,000 |       2 |      1 | 0/0                    | 288.52 / 300.21   | 233.31 / 208.22           | 288.87 / 28.63        |
| index   |  30,000 |       2 |      1 | 0/0                    | 414.86 / 436.20   | 255.17 / 216.58           | 414.98 / 39.06        |

At 30k sources/five aliases, wall increases 5.9% (965.68→1022.44 ms), while CPU
falls 16.7%, sampled peak RSS falls 303.48→215.83 MiB, and median HTTP p99 falls
936.40→7.47 ms. **HTTP maximum remains 105.50 ms**, and maximum event-loop delay
remains 112.92 ms: final atomic apply takes 103.98 ms median. A p99 gain does
not imply an absence of synchronous stalls.

At 8,194 sources, wall changes -2.3/-0.1/+3.7% for one/two/five aliases. At
20k/five aliases it regresses 6.1%; at 30k/one alias 5.7%; startup indexing
30k/two aliases 5.1%. Small empty/single/100-source cases show relative wall
increases up to 20.9% (usually less than 1 ms absolute). The one-source/10k-file
case increases 12.6%, and delayed access increases 5.2%. Delayed
source-directory lookups expose the concurrency cap: 10.43→16.39 ms (+57.1%) and
CPU +12.9%. All increases above 5% and sparse observation counts remain in the
external summary; no actual invocation weighting was collected. Bounded
generation improves responsiveness with these throughput tradeoffs rather than
delivering universal speedups.

Recompute the summary outside any timing window:

```sh
python3 scripts/benchmarks/summarize-ensemble-streaming.py EXTERNAL_RESULTS
```

[Immutable raw evidence, smoke/failure logs and checksums](https://github.com/venku122/cross-seed/releases/tag/benchmark-next-audit-2026-10-12):
`cooperative-ensemble-node26-evidence.zip`. Raw samples stay outside Git. An
initial pooled-percentile summary used maximum for p99; the corrected runnable
summarizer uses observation quantiles. Raw captures and per-worker headline
medians were unchanged; the provisional summary is retained and labeled.
