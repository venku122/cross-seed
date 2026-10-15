# Ensemble title lookup index

The reverse season lookup selects a few episode memberships from `ensemble`.
Migration 18 indexes its `ensemble` key. The pipeline explicitly orders matching
rows by `rowid`: the previous table scan returned insertion order, and duplicate
suppression keeps the first file for a host, episode and length. An index alone
can group alternate title keys and select a different physical episode source.

Migration rollback drops only this index. Existing rows, nullable hosts, client
sources and multiple alternate-title memberships remain intact. This does not
repair the separate nullable-host UPSERT growth issue.

## Reproduce

Build two clean checkouts with Node 26+, using the same lockfile and machine.
The baseline is `8a0c428edb9f8439e5138261047d2d0e3b3a4b78`; the modified
checkout contains this migration and pipeline ordering. Run from the modified
checkout:

```sh
npm ci
npm run build
# Run npm ci and npm run build in ../baseline as well.
node perf/ensemble/benchmark.mjs ../baseline . /external/path/results.json
```

The runner imports each checkout's actual compiled database adapter, migrations
and pipeline. It runs `checkNewCandidateMatch` on an empty migrated database to
capture the SELECT and bindings that the production pipeline emits. It then
replays that statement through the compiled database adapter against a synthetic
population. It does not reconstruct the lookup SQL from a snippet. Every worker
records source and compiled module SHA256 values, lockfile SHA256, SQLite
version, emitted query, query plan, returned paths and counts.

The fixtures contain 100,000 and 1,000,000 memberships, including paired paths
under alternate title keys, with 24 selected rows. Each cardinality has five
A/B/A replicates (15 independent workers), each with 25 warm reads, 25 reads
after `PRAGMA shrink_memory`, 25 batches of 100 inserted rows and 25 repeated
non-null-host UPSERT batches. Raw operation wall/CPU times, allocated index
pages, populated-database migration time, heap/external/array-buffer snapshots
and worker peak RSS are included.

Databases are in memory to bound local disk use. The first operation is recorded
separately in each fresh process; `shrink_memory` samples are cache-release
attempts, not cold disk measurements. Neither scenario measures filesystem cache
misses. Peak RSS includes fixture construction, database pages, module startup
and the index. These figures are synthetic SQLite measurements, not
whole-daemon, NFS, filesystem or private torrent-client performance.

## Correctness and acceptance

`cross-seed/tests/ensembleLookup.test.ts` covers fresh indexed query plans,
upgrading populated databases, down/up rollback without row changes, alternate
memberships, and selected physical paths through the real candidate pipeline.
Only the external assessment/download boundary is replaced in the source-choice
test; SQLite, filesystem existence/stat, season keys and deduplication remain
real. Before implementation, all three regressions failed for the expected
missing-index or changed-source reasons. They pass with the final change.

Validation commands are `npm run format:check`, `npm run build`, `npm run lint`,
`npm run typecheck`, and `CI=1 npm run test`. A precreated isolated `CONFIG_DIR`
is used for full tests because an existing notifier test imports the logger
before its own temporary environment is established.

## Captured results

Node 26.11.1, SQLite 3.53.4, macOS arm64, Apple M1 Pro. The linked original
archive contains `results.json` with all 30 workers and raw samples. Each phase
below aggregates 125 warm queries across five fresh workers. Query results were
identical in membership and insertion order in all workers. Baseline plans use
`SCAN ensemble`; modified plans use
`SEARCH ensemble USING INDEX ensemble_key_index` plus a temporary B-tree to
restore row order.

| Rows      | A1 warm p50/p95 (ms) | Indexed warm p50/p95 (ms) | A2 warm p50/p95 (ms) | Added index pages | Index migration p50 (ms) |
| --------- | -------------------- | ------------------------- | -------------------- | ----------------- | ------------------------ |
| 100,000   | 6.362 / 6.626        | 0.0458 / 0.0551           | 6.394 / 6.606        | 2.074 MiB         | 36.875                   |
| 1,000,000 | 62.085 / 64.156      | 0.0471 / 0.0598           | 62.352 / 63.866      | 20.945 MiB        | 404.865                  |

CPU median per warm query at 1M rows is 61.961 ms (A1), 0.046 ms (indexed), and
62.214 ms (A2). Baseline A1/A2 agreement supports the lookup effect despite
normal process variation. Peak worker RSS median at 1M rows is 283.28 MiB (A1),
313.38 MiB (indexed), and 282.39 MiB (A2); this includes in-memory fixture and
index-build memory and must not be extrapolated to resident daemon usage.

Writes pay for maintaining the new index. These synthetic batches insert 100
non-null-host memberships, then repeat the same UPSERT. Median insertion time at
1M rows increased from 0.451 to 0.560 ms (+24%); repeated UPSERT increased from
0.577 to 0.711 ms (+23%). Their p95 values increased from 0.852 to 1.359 ms and
0.821 to 1.308 ms respectively. At 100k rows, insert/UPSERT medians rose from
0.474/0.580 ms to 0.572/0.693 ms. This overhead is an explicit tradeoff for
selective reverse lookups; the change does not improve indexing throughput.

This run used a single full `npm ci` dependency installation shared by unchanged
lockfile checkouts, because initial independent installs ran out of disk space.
All full acceptance commands subsequently passed: 63 backend tests, 3 shared
tests, and 1 web UI test (67 total). The fixture source-choice test covers the
real pipeline up to the assessment boundary. Live NFS/torrent clients and cold
disk reads were not measured. Linux container and Windows package execution
remain outside this macOS local validation.

The local macOS Node 26 package smoke also passed: an isolated staging copy of
the built backend/shared modules was packed with `npm pack --workspaces=false`,
installed independently with `npm install --omit=dev`, and its actual packaged
`dist/cmd.js --version` printed `7.0.0-22`. Package preparation did not mutate
shared dependencies in the benchmark checkouts.

## Review follow-up: selectivity at 1M rows

The follow-up uses the same actual compiled pipeline query capture and compiled
`NodeSqliteClient` adapter, with 24, 1,000 and 10,000 matching memberships in
1,000,000 rows (0.0024%, 0.1% and 1%). Reproduce with:

```sh
node perf/ensemble/benchmark.mjs ../baseline . /external/path/selectivity-sweep.json --selectivity-sweep
```

The original command still runs its 100k/1M, 24-result matrix. The sweep runs
five A/B/A replicates per selectivity, with 25 samples per operation kind per
worker: 45 workers total and 125 measured reads per phase/selectivity. Every
first read checks the expected paired paths and insertion order; full returned
row hashes agree across all A/B/A workers at each selectivity, and every
measured warm/cache-release read checks that hash outside its timed region. No
application source or test semantics changed for this follow-up.

The captured baseline SQL is
`select * from ensemble where ensemble in (?, ?, ?)`; the indexed query adds
`order by rowid asc`. Both bind `zulushowakaalphashow.S1`, `zulushow.S1`, and
`alphashow.S1`. All indexed plans use
`SEARCH ensemble USING INDEX ensemble_key_index (ensemble=?)` and
`USE TEMP B-TREE FOR ORDER BY`; all baseline plans use `SCAN ensemble`.

| Matching rows | A1 warm p50/p95 (ms) | Indexed warm p50/p95 (ms) | A2 warm p50/p95 (ms) | Indexed warm CPU p50 (ms) | Indexed cache-release p50/p95 (ms) |
| ------------- | -------------------- | ------------------------- | -------------------- | ------------------------- | ---------------------------------- |
| 24            | 62.177 / 64.475      | 0.0501 / 0.4112           | 62.752 / 70.313      | 0.048                     | 0.0460 / 0.0810                    |
| 1,000         | 62.718 / 64.814      | 0.7530 / 0.9680           | 62.499 / 65.609      | 0.754                     | 0.7129 / 0.8373                    |
| 10,000        | 66.827 / 84.202      | 7.252 / 11.511            | 66.535 / 68.860      | 7.187                     | 6.885 / 8.379                      |

The complete indexed query grows to roughly 7.3 ms median at 1% selectivity,
while the scan remains about 66.5–66.8 ms. These timings include index search,
temporary sorting, row materialization and adapter overhead; they do not isolate
the sort's contribution or establish a crossover beyond 1%. Matching memberships
are a contiguous prefix with alternating title keys, rather than a randomized
physical distribution. Tail variation is visible, especially at 24 results; no
whole-daemon latency guarantee follows from these samples.

| Matching rows | A1 insert/UPSERT p50 (ms) | Indexed insert/UPSERT p50 (ms) | A2 insert/UPSERT p50 (ms) | Added pages (MiB) | Index migration p50 (ms) | A1/indexed/A2 peak RSS p50 (MiB) |
| ------------- | ------------------------- | ------------------------------ | ------------------------- | ----------------- | ------------------------ | -------------------------------- |
| 24            | 0.470 / 0.581             | 0.658 / 0.791                  | 0.467 / 0.598             | 20.945            | 302.624                  | 278.52 / 313.81 / 278.97         |
| 1,000         | 0.468 / 0.591             | 0.573 / 0.724                  | 0.459 / 0.586             | 20.941            | 293.499                  | 280.86 / 310.72 / 282.23         |
| 10,000        | 0.459 / 0.579             | 0.553 / 0.709                  | 0.456 / 0.572             | 20.926            | 302.591                  | 355.53 / 392.53 / 357.36         |

Indexed insertion/UPSERT p95 values were 4.836/4.669 ms at 24 results,
1.798/1.193 ms at 1,000, and 2.009/0.980 ms at 10,000. Writes remain an explicit
cost; these are batches of 100 non-null-host memberships, followed by repeated
UPSERTs. Peak RSS includes fixture building, startup, index migration, returned
rows and untimed full-row hash verification allocations. It does not measure
resident daemon memory. Databases remain in memory; cache-release attempts do
not measure cold disk reads. NFS, real clients, filesystem caches, Linux and
Windows execution remain outside this run.

Raw follow-up evidence is kept outside Git at
`../results/review-followup/index/selectivity-sweep.json`, with its progress log
beside it. SHA256 is
`ced8d60fa50da2b0f34ceadf6fbf252b7fba54dd1c1224384f7d566375d8f0c0`. The measured
baseline is `8a0c428edb9f8439e5138261047d2d0e3b3a4b78`; modified source is
`b3601a1d97bf5d59ed221edad0b9216311bd2934` plus the runner change. Runner SHA256
is `e860aef90bd07487eab222444c89cf8e2163f9afc297c580da61ad4e9cb23de8`. The JSON
retains source/compiled migration, pipeline and adapter hashes for every worker.
Adapter source/compiled hashes are identical across checkouts; compiled indexed
pipeline SHA256 is
`01ce194e763379ee08db34b361423f5055d5c171faac674307850db034b88664`. Runtime is
Node 26.11.1, npm 11.20.0, SQLite 3.53.4, macOS arm64, Apple M1 Pro. No new
dependency install was performed; the unchanged-lockfile shared dependency
installation was reused.

## External evidence and CI

Raw results and the former duplicated Docker follow-up are preserved in the
[checksummed benchmark archive](https://github.com/venku122/cross-seed/releases/tag/benchmark-evidence-2026-10-11),
linked from the PR description. They are excluded from source history. Fresh
Linux Node26 and Windows tarball CI runs on the fork without a precreated
`CONFIG_DIR`; local macOS tests above used that isolated workaround. Docker
publication jobs are guarded to upstream.
