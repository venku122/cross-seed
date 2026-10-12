# Exact membership lookup: final native results

**Status: draft; performance acceptance remains open.** All 225 native workers
completed, but the duplicate-free stress cases exceeded the 5% regression gate.
Actual invocation weighting has not been measured. No production workload or
storage-growth improvement is claimed.

Five fresh-process A/head/A rounds per case produced 150 baseline and 75
candidate samples across 15 cases. All cases used 1M stored rows. The public
compiled checkNewCandidateMatch pipeline, actual migrated SQLite, and compiled
Fastify baseApiPlugin /api/ping route ran on Node 26.11.1 / SQLite 3.53.4, Apple
M1 Pro, 32 GiB RAM, macOS/Darwin arm64. Setup and post-timing validation were
excluded.

## Wall medians and negative cases

| Aliases | Repeats | Matching rows | FS / delay     | Base ms | SQL ms | Change | CPU change |
| ------- | ------- | ------------- | -------------- | ------: | -----: | -----: | ---------: |
| 1       | 1       | 1M            | constant / 0ms |  2021.4 | 3515.6 | +73.9% |     +54.0% |
| 1       | 10      | 1M            | constant / 0ms |  2016.5 | 1439.5 | -28.6% |     -42.5% |
| 1       | 10      | 20            | real / 0ms     |     7.0 |    6.4 |  -7.9% |      -8.1% |
| 1       | 10      | 20            | real / 5ms     |   247.3 |   34.6 | -86.0% |     -63.1% |
| 1       | 10      | 20            | real / 50ms    |  2115.8 |  261.0 | -87.7% |     -88.2% |
| 2       | 1       | 1M            | constant / 0ms |  2478.3 | 3526.5 | +42.3% |     +37.5% |
| 2       | 10      | 1M            | constant / 0ms |  2381.4 | 1290.4 | -45.8% |     -51.7% |
| 2       | 10      | 20            | real / 0ms     |     7.2 |    6.7 |  -7.3% |      -6.5% |
| 2       | 10      | 20            | real / 5ms     |   245.1 |   34.1 | -86.1% |     -63.6% |
| 2       | 10      | 20            | real / 50ms    |  2123.0 |  261.8 | -87.7% |     -88.6% |
| 5       | 1       | 1M            | constant / 0ms |  2619.4 | 3820.7 | +45.9% |     +38.4% |
| 5       | 10      | 1M            | constant / 0ms |  2468.6 | 1517.4 | -38.5% |     -45.4% |
| 5       | 10      | 20            | real / 0ms     |     8.0 |    7.4 |  -7.3% |      -8.0% |
| 5       | 10      | 20            | real / 5ms     |   248.8 |   36.8 | -85.2% |     -60.4% |
| 5       | 10      | 20            | real / 50ms    |  2131.6 |  263.0 | -87.7% |     -87.6% |

Constant-results full-match fixtures measure query/pipeline CPU and probe
counts, not filesystem latency. The real-filesystem cases select twenty rows
from 1M and add synthetic per-access/stat delays; these are not NFS/ZFS
measurements.

Duplicate-heavy full-match cases reduce probes from 1M access / 1,000,001 stat
calls to 100k / 100,001. Twenty-match cases reduce 20 / 21 to 2 / 3.
No-duplicate cases retain 1M / 1,000,001 probes and pay the grouping cost. All
original 1M rows and their complete stored-row digests remain intact; output and
distinct ordered tuple digests agree within every case. No final worker failed
or timed out.

## Responsiveness and memory

In duplicate-heavy full-match cases, compiled API ping p99 ranges changed from
2714–2919ms to 1316–1923ms. In duplicate-free cases they regressed from
2167–3188ms to 3808–5661ms. CPU-bound cases have only ten baseline/five head
ping observations; p99 is the observed maximum and should not be treated as a
stable tail estimate. Short real0ms cases also have sparse observations. Full
per-case counts and p50/p95/p99 distributions are retained externally.

Post-lookup JS heap medians in duplicate-heavy cases fall from about 580 MiB to
90 MiB. Peak-through-lookup RSS includes setup and GC-sensitive allocations:
duplicate-heavy baseline medians 1184–1323MiB versus SQL 775–777MiB. This is not
a guaranteed production RSS reduction. No-duplicate heap remains about 580 MiB.

## Source identity and verification

Baseline is PR1 commit 17a779988c496d2bc0729467856ea7dfcaf37833. Benchmark
candidate records were taken from a frozen working tree based on that commit;
publication commit identity is supplied in the PR body. These exact application
hashes must match the published source; docs-only publication does not change
the measured code.

- Candidate pipeline
  source:5024c4437ce041ceaee2cacb4d8ed8b68a71786f355fc560b9d18661e111c66f.
- Candidate compiled
  pipeline:fb413c7f50544eb6226b1868ae4524083f94e65fd075645ef171e91aebb9e7f7.
- Baseline compiled
  pipeline:01ce194e763379ee08db34b361423f5055d5c171faac674307850db034b88664.
- Final
  controller:55e66381737217e77f0d31ddbf26c5c3f4ba52269828fb5abb4f1d691dcb9491.

Final SQL full workspace rerun passed 72 tests and format/build/lint/typecheck.
The first full run hit the existing injection async-unlink test race at
full-app.test.ts:329; focused 4/4 and complete 72/72 reruns passed. No unrelated
injection change is included. Independent review found no correctness blocker.

## External evidence

[Immutable raw evidence ZIP](https://github.com/venku122/cross-seed/releases/download/benchmark-next-audit-2026-10-12/exact-dedup-node26-evidence.zip)
is published on the
[benchmark release](https://github.com/venku122/cross-seed/releases/tag/benchmark-next-audit-2026-10-12).
ZIP SHA256: `3f7d30b060720e539d5c7450eee5dd7a3160c5f347a050b4904ecd28deef7f74`.
All 352 external metadata/log files are included. Raw samples, 234 seed/worker
stdout/stderr logs, immutable fixture metadata, environment details, complete
distributions and all earlier partial/failed pilot evidence remain outside the
repository. Fixture DBs are regenerable and should not be committed.

SHA256:

- native-final/raw.json:
  947b6bed501bb6f190198027315e2a840f683f036f48a730053ba05c03597fad
- native-final/summary.json:
  657dd25f0585704ee99359ca9076a2b2947b7aed491017e5a63e7ec83c50eec4
- native-final/environment.json:
  b89c7daf7aa97b9cc732b8f47caa31e94e4bb6bccfcb89f06707903408fa0fdc

The earlier real-FS pilot stall came from a mutable mock-export function
reference. Its ten completed samples and terminated worker log were retained.
Native function references captured before mocking resolved the issue, proven
with bounded real50ms validation; a fresh complete 15-worker pilot then passed.
Controller deadlines are 120s per lookup and 180s per seed, with raw logs saved
before result interpretation.
