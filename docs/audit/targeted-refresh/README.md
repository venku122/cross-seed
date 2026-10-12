# Scoped qBittorrent source refresh

Before linking, the previous forced one-hash refresh downloaded the complete qB
catalog and queried every cached torrent. The compiled Node 26 reproduction at
8,194 cached rows recorded 8,195 SELECTs (8,194 point reads plus
reconciliation). The new optional client `refreshOne` operation filters qB info
by hash, reads only target file/tracker metadata, and performs a scoped UPSERT.
Other adapters retain the existing complete refresh behavior through the shared
compatibility helper.

The scoped operation never calls snapshot reconciliation or deletes missing
cache entries. Confirmed absence returns `undefined`; subsequent complete sync
retains responsibility for deletion. API, authentication, timeout and detail
failures reject without committing partial metadata. Concurrent same-hash calls
share one refresh; concurrent alias misses share one in-flight catalog fallback.
Primary/v1/v2 hashes are matched without case sensitivity and cache identity
retains the existing v1-first convention. Direct injection exemption and
`onlyCompleted` checks remain in the linking flow.

## Validation

Twenty added tests cover mutable path/category/tags/files/trackers, other-client
preservation, hybrid aliases, absence, concurrent same-hash requests, embedded
metadata, transport timeouts, transient retries, exhausted authentication,
details disappearance, direct injection, completion checks, other-adapter
fallback, and a real isolated hardlink from the refreshed moved path/renamed
file. The complete source acceptance suite passed: format, build, lint, types
and 84 tests across workspaces. No production database, client or filesystem was
used.

## Compiled benchmark reproduction

Use Node 26.11.1 and separately built pristine baseline
`8a0c428edb9f8439e5138261047d2d0e3b3a4b78` and this source tree. The worker
imports each tree's actual compiled qB adapter, Knex/node SQLite DB and Fastify
`baseApiPlugin`. All networking is loopback fake qB plus the actual compiled
`/api/ping` route.

```
node scripts/benchmarks/qb-targeted-aba.mjs BASELINE HEAD EXTERNAL_RESULTS
```

The matrix launches five independent A/B/A process rounds for 32 fixtures:
0/1/100/8,194/20,000/30,000 cached torrents, 0/1/10 unrelated name modifications
where possible, and 100/1,000/10,000 files on the requested target in the 8k/30k
catalogs. Other torrents retain one file. Each worker stores source and compiled
SHA-256 hashes, HTTP counts/response bytes, SQLite statement counts, wall/CPU,
RSS/heap, event-loop delay/utilization, and ping sample counts/distributions.
Targeted runs assert the entire unrelated cache digest remains identical.

Workers use fresh process/database fixtures; OS filesystem cache is
uncontrolled. The fake qB server runs in the same process, so its
serialization/HTTP CPU is included. Fast targeted runs may produce sparse ping
samples. These synthetic results cannot establish real qB, TrueNAS, ZFS or NFS
latency. Sequential alias misses and confirmed absence can each still require a
full catalog fallback; there is no universal constant-work claim. Raw
measurements remain external.

Additional compiled correctness cases can be run with `QB_MODE=targeted` and
`QB_SCENARIO=alias`, `absent`, `api-error`, or `deleted-during-details` using
`scripts/benchmarks/qb-targeted.mjs HEAD`. These preserve the cache on errors or
absence and exercise the bounded fallback. Authentication and timeout retry
cases are in the regression suite.

## Five-round results

480 successful worker records cover 32 fixtures × five A/B/A rounds. Baselines
combine both A phases. These are medians of per-worker values, not pooled tails.

| Cached torrents (one target file) | Baseline wall ms | Scoped wall ms | Cache SELECTs | HTTP response bytes |
| --------------------------------- | ---------------: | -------------: | ------------- | ------------------- |
| 0                                 |             3.34 |           5.21 | 0 → 0         | 2 → 4               |
| 1                                 |             8.18 |           7.01 | 2 → 0         | 401 → 401           |
| 100                               |            13.65 |           7.67 | 101 → 0       | 24,944 → 401        |
| 8,194                             |           302.14 |          10.20 | 8,195 → 0     | 2,047,544 → 401     |
| 20,000                            |           703.25 |           9.45 | 20,001 → 0    | 5,009,044 → 401     |
| 30,000                            |         1,032.01 |          11.48 | 30,001 → 0    | 7,519,044 → 401     |

The 8,194 fixture CPU median falls 360.13 → 26.79 ms, sampled RSS 231.46 →
174.50 MiB, event-loop p99 284.95 → 2.89 ms, and sampled ping p99 4.10 → 1.92
ms. The empty-catalog wall median regresses 56% (+1.87 ms), exceeding the 5%
gate. Other measured wall medians improve. No actual production invocation mix
was collected, so these are scoped benchmark results, not an aggregate daemon
CPU forecast. File-count, modification and all CPU/memory/tail distributions are
in the external summary/raw archive.

The first controller disappeared after 194 samples with no recoverable exit code
or error. Its raw output is preserved separately. Resume reused 64 complete
A/B/A triplets, reran the incomplete triplet and completed all 480 scheduled
workers. The resumed driver checks fixture/round/phase order; source and
compiled identities remain in each worker. Later changes add test coverage and
controller recovery, with production source unchanged. Dependency lock SHA-256:
`88da27532b3b03440bbae2726942de02d7cff581b83be9374410e2426a5b285d`.
