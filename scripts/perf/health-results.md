# Health snapshots: local Node 26 validation

Pinned baseline: `8a0c428edb9f8439e5138261047d2d0e3b3a4b78`.

The original authenticated health router ran every problem provider and SQLite
`dbstat` on every query. Concurrent requests could also race on the providers'
shared temporary probe filenames. The compiled baseline reproduction (ten tabs,
three query batches, disposable SQLite, loopback qB fixture) executes 30 dbstat
aggregates; the candidate executes one, exposes `measuredAt`, and creates no qB
tags during recurring health collection.

A 60-second successful-snapshot TTL matches the existing sidebar polling
cadence; it does not guarantee a cache hit for a single tab polling every 60
seconds. Failures retry after five seconds; config/client replacement and client
metadata writes invalidate immediately. A manual authenticated mutation bypasses
TTL while sharing an already-running collection. Samples are timestamped at
collection start; collection older than one minute is rejected. Each requester
has a 15-second waiting deadline, including configuration retries, checked once
the event loop regains control. Synchronous SQLite can delay the response or
error beyond that deadline; the deadline cannot preempt synchronous work. A
timed-out/disconnected requester cannot cancel or duplicate work shared by other
tabs. Underlying adapter requests retain their existing timeouts and may
continue after the requester times out; manual refresh cannot bypass an
operation that is still running.

qB health validation retains version and torrentDir checks, uses its existing
session, only reauthenticates when needed, and skips tag creation. Deluge status
reuses its session and can refresh expired authentication, but never deletes the
session or reconnects a disconnected daemon. Explicit default validation retains
its existing side effects; startup currently instantiates clients without
calling full validation. Deluge authentication still reads its Label plugin
capability so health does not disable later injection labeling. qB uses a
dedicated lightweight save-path catalog read instead of hydrating/reconciling
client metadata; other adapters retain their existing cached/coalesced
enumeration. Actual linking and writable-directory diagnostics still create
temporary probe files. Those validations are coalesced/cached, and tests verify
cleanup and unchanged persistent source/link files. This is not a claim that the
original validation providers are read-only.

## Reproduction

Build both workspaces with the same lockfile and Node 26. Run in an exclusive
CPU slot, with no other tests/builds/benchmarks:

```sh
node scripts/perf/health-bench.mjs /absolute/pristine-baseline /absolute/candidate /absolute/external-results
```

The worker imports actual compiled `healthRouter`, all actual problem providers,
`QBittorrent`, and `baseApiPlugin` (`/api/ping` on a real local Fastify
listener). Health calls use the actual authenticated router caller; they bypass
HTTP session serialization. Every process constructs a migrated disposable
SQLite database, a 150,000-row disk-backed payload table, synthetic torrent
metadata and paths, and a fake loopback qB API. No production config, database,
media, or client URL is accepted. The harness records SQL/fs counts, exact
dbstat durations, provider elapsed times, request bytes/login/tag counts,
CPU/RSS, event-loop delay, ping samples, and separate first/repeated query-batch
durations.

Six scenarios cover one/ten tabs, links off/on, two/ten distinct save paths,
8,194 cached torrents, a slow client, and failed authentication. Each runs five
fresh A/B/A process rounds. Raw logs/JSON stay outside Git; only the harness and
this summary belong in the source diff.

This is a warm local synthetic filesystem/client/cache benchmark, not TrueNAS,
NFS, cold-disk, real qB latency, or live traffic evidence. Cached candidate runs
produce fewer ping samples, so their p95/p99 estimates must be read with sample
counts. RSS is sampled during measurement, not an allocation profile. Provider
elapsed times include waiting behind other providers and main-thread SQLite;
they cannot be summed as independent CPU time. Existing static config errors
also use the conservative five-second failure TTL.

## Measured results

All 90 fresh workers completed successfully in the exclusive timing slot on Node
26.11.1 / SQLite 3.53.4. Each value below is the median across five workers; A1
and A2 are pristine baseline runs surrounding candidate B. Every worker runs
three immediate query batches. These burst results do not establish savings for
requests spaced 60 seconds apart.

| Scenario                          | Three-batch wall ms A1 / B / A2 | First-batch ms A1 / B / A2 |
| --------------------------------- | ------------------------------- | -------------------------- |
| 1 tab, links off                  | 50.65 / 16.85 / 49.51           | 18.72 / 16.76 / 18.35      |
| 10 tabs, links off                | 425.42 / 17.85 / 431.77         | 146.85 / 17.47 / 148.31    |
| 10 tabs, 8,194 torrents, 2 paths  | 9947.31 / 29.96 / 8716.81       | 3122.78 / 29.58 / 2976.66  |
| 10 tabs, 1,000 torrents, 10 paths | 1630.44 / 27.30 / 1829.51       | 595.55 / 26.86 / 583.22    |
| 10 tabs, slow client              | 1110.41 / 72.74 / 1107.86       | 368.62 / 72.29 / 389.84    |
| 10 tabs, failed authentication    | 428.26 / 22.86 / 426.15         | 150.26 / 22.51 / 151.97    |

| Scenario                          | CPU ms A1 / B / A2        | Sampled peak RSS MiB A1 / B / A2 | Ping p99 ms A1 / B / A2  | Event-loop p99 ms A1 / B / A2 |
| --------------------------------- | ------------------------- | -------------------------------- | ------------------------ | ----------------------------- |
| 1 tab, links off                  | 57.35 / 18.57 / 56.29     | 144.78 / 144.14 / 144.95         | 14.02 / 4.23 / 14.32     | 13.46 / 14.71 / 15.20         |
| 10 tabs, links off                | 461.24 / 19.99 / 462.10   | 156.34 / 143.64 / 155.95         | 132.21 / 13.81 / 134.50  | 127.86 / 13.98 / 132.25       |
| 10 tabs, 8,194 torrents, 2 paths  | 9881.14 / 35.86 / 9207.30 | 387.03 / 201.14 / 444.67         | 2982.18 / 9.76 / 2876.82 | 1645.22 / 15.88 / 1626.34     |
| 10 tabs, 1,000 torrents, 10 paths | 2010.55 / 34.22 / 2091.33 | 260.83 / 156.41 / 250.62         | 487.34 / 15.95 / 558.29  | 335.54 / 13.63 / 312.74       |
| 10 tabs, slow client              | 890.62 / 46.66 / 891.36   | 204.45 / 144.20 / 203.64         | 154.51 / 15.77 / 145.53  | 45.94 / 13.20 / 40.99         |
| 10 tabs, failed authentication    | 480.65 / 33.19 / 482.28   | 164.59 / 150.27 / 164.44         | 134.98 / 15.73 / 134.69  | 139.72 / 15.62 / 142.34       |

The 8,194-torrent fixture reduced prepared SQL statements from 246,030 to 6,
`dbstat` aggregates from 30 to 1, catalog requests from 30 to 1, tag creation
from 30 to 0, and instrumented temporary probe mutations from 180 to 6. The
one-tab/no-links fixture reduced aggregates from 3 to 1, prepared statements
from 18 to 6, request bodies from 102 bytes to 0, and response bodies from 27
bytes to 6. These are fixture-specific counts, not production estimates.

The large baseline's wall time and RSS drift between A1 and A2 is visible in the
table. One-tab candidate event-loop p99 was 14.71 ms versus A1 13.46 ms and A2
15.20 ms; no universal tail-latency regression bound is established. Candidate
ping sample counts ranged from two to four in the short scenarios, so tail
estimates are especially sparse. Full per-worker samples and summary
min/max/p50/p95/p99 distributions remain in the external result archive; with
only five workers, the summarized p95 and p99 are the maximum worker.

## Correctness and acceptance

Build, format, lint, typecheck, and the final full suite passed: 79 cross-seed,
3 shared, and 1 web UI tests (83 total). Actual compiled-router smoke passed.
The added tests cover TTL/error recovery, manual refresh, configuration changes
including an old-flight join, cancellation/deadline behavior, stale samples,
version/authentication errors, cold and expired session coalescing, real linking
outcomes, probe cleanup, and Deluge capability/session behavior. Linking tests
preserve file bytes, directory entries, and final inode link counts; temporary
hardlink probes can still change inode metadata. Non-qB enumeration fallback can
still hydrate or reconcile client metadata.

A full-suite run exposed the existing saved-torrent deletion race in
`injects saved torrents into a fake client`. The same test failed in one of five
independent pristine-baseline repetitions and passed in the other four; the
final candidate suite passed. No injection behavior or unrelated test was
changed. UI builds/types and server refresh behavior were checked; a browser
click-through was not performed.

All 90 workers used identical instrumentation; compiled hashes were identical
within each A1/B/A2 phase. Production source hashes remained unchanged after
timing. The frozen pre-documentation source-tree digest was
`4464b79fbac08212cecc798d1a81cedbfe250007a5ea80eb099f75c2f61b18ca`. External
evidence lives under `next-audit/results/health`: `matrix/samples.json`, 90
worker logs, `summary.json`, `frozen-manifest.json`, RED/green logs, and gate
logs. Raw measurements and machine-specific paths are excluded from Git. No
production or private client requests were made.
