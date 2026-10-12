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
session or reconnects a disconnected daemon. Health login handshakes reject a
forbidden version response without recursively joining their own shared
authentication promise; later refreshes can recover. Explicit default validation
retains its existing side effects; startup currently instantiates clients
without calling full validation. Deluge authentication still reads its Label
plugin capability so health does not disable later injection labeling. qB uses a
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

These final 90 workers measured compiled production revision
`5fb33f95436904060267316e0bb9b3d88b21bb08`, including the login-handshake
recovery fix. The earlier pre-fix matrix remains archived separately. All
registered provider source/dist hashes stayed unchanged before and after timing.

All 90 fresh workers completed successfully in the exclusive timing slot on Node
26.11.1 / SQLite 3.53.4. Each value below is the median across five workers; A1
and A2 are pristine baseline runs surrounding candidate B. Every worker runs
three immediate query batches. These burst results do not establish savings for
requests spaced 60 seconds apart.

| Scenario                          | Three-batch wall ms A1 / B / A2 | First-batch ms A1 / B / A2 |
| --------------------------------- | ------------------------------- | -------------------------- |
| 1 tab, links off                  | 48.96 / 16.79 / 51.10           | 17.98 / 16.67 / 18.43      |
| 10 tabs, links off                | 436.28 / 17.85 / 443.21         | 149.97 / 17.02 / 148.79    |
| 10 tabs, 8,194 torrents, 2 paths  | 8484.86 / 27.92 / 8619.97       | 2865.97 / 27.57 / 2878.95  |
| 10 tabs, 1,000 torrents, 10 paths | 1582.16 / 25.45 / 1584.71       | 567.68 / 25.08 / 577.10    |
| 10 tabs, slow client              | 999.49 / 69.74 / 995.73         | 338.73 / 69.34 / 337.57    |
| 10 tabs, failed authentication    | 401.96 / 21.95 / 408.52         | 144.20 / 21.56 / 146.04    |

| Scenario                          | CPU ms A1 / B / A2        | Sampled peak RSS MiB A1 / B / A2 | Ping p99 ms A1 / B / A2   | Event-loop p99 ms A1 / B / A2 |
| --------------------------------- | ------------------------- | -------------------------------- | ------------------------- | ----------------------------- |
| 1 tab, links off                  | 55.98 / 18.47 / 56.54     | 144.59 / 143.36 / 144.73         | 14.62 / 14.04 / 14.29     | 13.11 / 13.89 / 14.92         |
| 10 tabs, links off                | 462.61 / 19.61 / 464.76   | 156.23 / 143.73 / 156.17         | 136.95 / 14.26 / 140.15   | 133.17 / 15.59 / 136.31       |
| 10 tabs, 8,194 torrents, 2 paths  | 9019.13 / 34.69 / 9140.65 | 453.31 / 201.52 / 454.36         | 2797.23 / 17.06 / 2860.18 | 1579.16 / 14.08 / 1608.52     |
| 10 tabs, 1,000 torrents, 10 paths | 1955.77 / 30.85 / 1978.58 | 261.72 / 156.06 / 261.91         | 469.77 / 15.34 / 472.49   | 327.42 / 15.59 / 327.16       |
| 10 tabs, slow client              | 788.68 / 37.91 / 774.31   | 203.97 / 144.38 / 204.06         | 129.63 / 13.28 / 126.49   | 42.47 / 4.16 / 40.04          |
| 10 tabs, failed authentication    | 454.53 / 50.16 / 458.92   | 165.17 / 149.55 / 165.20         | 125.85 / 15.36 / 127.64   | 132.91 / 15.36 / 135.92       |

The 8,194-torrent fixture reduced prepared SQL statements from 246,030 to 6,
`dbstat` aggregates from 30 to 1, catalog requests from 30 to 1, tag creation
from 30 to 0, and instrumented temporary probe mutations from 180 to 6. The
one-tab/no-links fixture reduced aggregates from 3 to 1, prepared statements
from 18 to 6, request bodies from 102 bytes to 0, and response bodies from 27
bytes to 6. These are fixture-specific counts, not production estimates.

The large baseline's median wall time varied from 8,484.86 to 8,619.97 ms
between A1 and A2. One-tab candidate event-loop p99 was 13.89 ms versus A1 13.11
ms and A2 14.92 ms; no universal tail-latency regression bound is established.
Candidate ping sample counts ranged from two to four in the short scenarios, so
tail estimates are especially sparse. Full per-worker samples and summary
min/max/p50/p95/p99 distributions remain in the external result archive; with
only five workers, the summarized p95 and p99 are the maximum worker.

## Correctness and acceptance

Build, format, lint, typecheck, and the post-handshake-fix full suite passed: 81
cross-seed, 3 shared, and 1 web UI tests (85 total). The final compiled
full-router matrix passed all 90 workers, including coalescing and outcome
assertions. The added tests cover TTL/error recovery, manual refresh,
configuration changes including an old-flight join, cancellation/deadline
behavior, stale samples, version/authentication errors, cold and expired session
coalescing, real linking outcomes, probe cleanup, and Deluge capability/session
behavior. Linking tests preserve file bytes, directory entries, and final inode
link counts; temporary hardlink probes can still change inode metadata. Non-qB
enumeration fallback can still hydrate or reconcile client metadata.

A full-suite run exposed the existing saved-torrent deletion race in
`injects saved torrents into a fake client`. The same test failed in one of five
independent pristine-baseline repetitions and passed in the other four; the
final candidate suite passed. No injection behavior or unrelated test was
changed. UI builds/types and server refresh behavior were checked; a browser
click-through was not performed.

All 90 workers used identical instrumentation; compiled hashes were identical
within each A1/B/A2 phase. Production and registered-provider source/dist hashes
matched the frozen manifest after timing. Final evidence lives under
`next-audit/results/health/final-v2`: `matrix/samples.json`, 90 worker logs,
`controller.log`, `summary.json`, `complete.json`, and `frozen-manifest.json`.
The preceding matrix and RED/green/gate logs remain under
`next-audit/results/health`, including `handshake-red.txt`,
`handshake-green.txt`, and `handshake-gates`. Raw measurements and
machine-specific paths are excluded from Git. No production or private client
requests were made.
